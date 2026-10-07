import {
  canonicalContentJson,
  createBundledContentReader,
  validateRecipeContentRef,
  type ContentHash,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { createRecipeSearch, type SearchCriteria, type RecipeSearchResult } from '@cookmate/domain';
import type { ContentWorkspaceHost, ContentWorkspaceState } from './contentWorkspaceHost';
import { admitContentPhoto } from './contentPhotoResourceTypes';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';
import { createContentPhotoQueue } from './contentPhotoQueue';

type Host = Pick<
  ContentWorkspaceHost,
  'content' | 'getSnapshot' | 'subscribe' | 'onPhotoCleanupFailure'
>;
type PhotoResult = Awaited<ReturnType<Host['content']['readPhoto']>>;
type Search = ReturnType<typeof createRecipeSearch>;
type Source =
  | { kind: 'bundled'; scopeKey: string; sha256: ContentHash }
  | { kind: 'content'; host: Host };

export type OrdinaryCatalogueState =
  | { readonly kind: 'loading'; readonly scopeKey: string }
  | {
      readonly kind: 'ready';
      readonly scopeKey: string;
      readonly mode: 'bundled' | 'content';
      /** Bundled assets retain their existing renderer; published assets require verified bytes. */
      readonly photoMode: 'bundled' | 'verified';
      readonly identity: Readonly<CatalogueIdentity>;
      readonly recipes: readonly Immutable<ReadingRecipe>[];
      readonly facets: Search['facets'];
      search(criteria: SearchCriteria): RecipeSearchResult;
      /** Current discovery only. Never use this lookup for a saved Plan/history reference. */
      current(recipeId: string): Immutable<ReadingRecipe> | undefined;
    }
  | { readonly kind: 'failed'; readonly scopeKey: string }
  | {
      readonly kind: 'unavailable';
      readonly scopeKey: string;
      readonly reason: Exclude<ContentWorkspaceState['status'], 'ready'>;
    }
  | { readonly kind: 'closed'; readonly scopeKey: string };

export interface OrdinaryCatalogueController {
  getSnapshot(): OrdinaryCatalogueState;
  subscribe(listener: () => void): () => void;
  retry(): void;
  readCurrent(recipeId: string): Promise<ReadingLookup>;
  /** Identity-owned saved metadata may retain archived recipes; never use for new planning. */
  readSavedIdentity(recipeId: string): Promise<ReadingLookup>;
  readExact(ref: RecipeContentRef): Promise<ReadingLookup>;
  /** Content mode only; bundled mode uses the existing packaged asset component. */
  readPhoto(ref: RecipeContentRef, assetId: string, signal?: AbortSignal): Promise<PhotoResult>;
  /** Content mode delegates even late cleanup to the resource owner; never discard this capability. */
  readonly onPhotoCleanupFailure?: (resource: ContentPhotoResource) => void;
  /** Revokes this adapter only. The workspace owner retains host/storage/resource ownership. */
  close(): void;
}

export class OrdinaryCatalogueError extends Error {
  constructor(
    readonly reason:
      | 'not_ready'
      | 'closed'
      | 'scope_changed'
      | 'invalid_input'
      | 'invalid_result'
      | 'bundled_photo',
  ) {
    super(`Recipe catalogue: ${reason}`);
    this.name = 'OrdinaryCatalogueError';
  }
}

function recipeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value))
    throw new OrdinaryCatalogueError('invalid_input');
}
function ownRef(ref: RecipeContentRef): RecipeContentRef {
  try {
    const owned: unknown = JSON.parse(canonicalContentJson(ref, 1024));
    if (!validateRecipeContentRef(owned)) throw new Error();
    return Object.freeze(owned);
  } catch {
    throw new OrdinaryCatalogueError('invalid_input');
  }
}
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left, 4096) === canonicalContentJson(right, 4096);
function resultFence(result: Awaited<ReturnType<Host['content']['discover']>>) {
  return canonicalContentJson(
    {
      installationId: result.installationId,
      ownerId: result.ownerId,
      head: result.head,
      adoptionRevision: result.adoptionRevision,
      identity: result.identity,
    },
    4096,
  );
}

/** Installed source only: no publication/adoption authority or substituted catalogue input. */
export function createBundledOrdinaryCatalogue(options: {
  scopeKey: string;
  sha256: ContentHash;
}): OrdinaryCatalogueController {
  const { scopeKey, sha256 } = options;
  if (
    typeof scopeKey !== 'string' ||
    !scopeKey ||
    scopeKey.length > 512 ||
    typeof sha256 !== 'function'
  )
    throw new OrdinaryCatalogueError('invalid_input');
  return createController({ kind: 'bundled', scopeKey, sha256 });
}

/** Only the live host supplies adopted recipes; errors never fall back to packaged content. */
export function createContentOrdinaryCatalogue(host: Host): OrdinaryCatalogueController {
  // Capture method identities once. Replacing caller properties cannot redirect an issued adapter.
  return createController({
    kind: 'content',
    host: Object.freeze({
      getSnapshot: host.getSnapshot.bind(host),
      subscribe: host.subscribe.bind(host),
      onPhotoCleanupFailure: host.onPhotoCleanupFailure.bind(host),
      content: Object.freeze({
        discover: host.content.discover.bind(host.content),
        readCurrent: host.content.readCurrent.bind(host.content),
        readExact: host.content.readExact.bind(host.content),
        readPhoto: host.content.readPhoto.bind(host.content),
        readPhotos: host.content.readPhotos.bind(host.content),
      }),
    }),
  });
}

function createController(source: Source): OrdinaryCatalogueController {
  const listeners = new Set<() => void>();
  let closed = false,
    generation = 0;
  let state: OrdinaryCatalogueState = Object.freeze({
    kind: 'loading',
    scopeKey: source.kind === 'bundled' ? source.scopeKey : 'content:opening',
  });
  let bundled: Awaited<ReturnType<typeof createBundledContentReader>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let hostSignature: string | undefined;
  let fence: string | undefined;
  const photos =
    source.kind === 'content' ? createContentPhotoQueue(source.host.content.readPhotos) : undefined;

  function publish(next: OrdinaryCatalogueState) {
    state = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A view cannot keep old authority alive. */
      }
    }
  }
  function live(ticket: number, key: string) {
    if (closed) throw new OrdinaryCatalogueError('closed');
    if (ticket !== generation || key !== state.scopeKey)
      throw new OrdinaryCatalogueError('scope_changed');
    if (source.kind === 'content') {
      const current = source.host.getSnapshot();
      if (current.status !== 'ready' || current.scopeKey !== key)
        throw new OrdinaryCatalogueError('scope_changed');
    }
  }
  function ready() {
    if (closed) throw new OrdinaryCatalogueError('closed');
    if (state.kind !== 'ready') throw new OrdinaryCatalogueError('not_ready');
    const captured = { ticket: generation, key: state.scopeKey };
    live(captured.ticket, captured.key);
    return captured;
  }
  function publishReady(
    ticket: number,
    key: string,
    identity: Readonly<CatalogueIdentity>,
    recipes: readonly Immutable<ReadingRecipe>[],
  ) {
    live(ticket, key);
    const search = createRecipeSearch({ identity, recipes });
    const current = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));
    const check = () => live(ticket, key);
    const facets = Object.freeze({
      get categories() {
        check();
        return search.facets.categories;
      },
      get cuisines() {
        check();
        return search.facets.cuisines;
      },
      get ingredients() {
        check();
        return search.facets.ingredients;
      },
    });
    publish({
      kind: 'ready',
      scopeKey: key,
      mode: source.kind,
      photoMode: source.kind === 'bundled' ? 'bundled' : 'verified',
      get identity() {
        check();
        return identity;
      },
      get recipes() {
        check();
        return recipes;
      },
      get facets() {
        check();
        return facets;
      },
      search(criteria) {
        check();
        const result = search.search(criteria);
        check();
        return result;
      },
      current(id) {
        check();
        recipeId(id);
        return current.get(id);
      },
    });
  }
  function load() {
    if (closed) return;
    const ticket = ++generation;
    photos?.cancel(new OrdinaryCatalogueError('scope_changed'));
    fence = undefined;
    let key = source.kind === 'bundled' ? source.scopeKey : state.scopeKey;
    try {
      if (source.kind === 'content') {
        const current = source.host.getSnapshot();
        key = current.scopeKey;
        hostSignature = `${current.status}:${key}`;
        if (current.status !== 'ready') {
          publish({ kind: 'unavailable', scopeKey: key, reason: current.status });
          return;
        }
      }
      publish({ kind: 'loading', scopeKey: key });
      void (async () => {
        live(ticket, key);
        if (source.kind === 'bundled') {
          const reading =
            bundled ??
            (await createBundledContentReader(async (text) => {
              const hash = await source.sha256(text);
              if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
                throw new OrdinaryCatalogueError('invalid_result');
              return hash;
            }));
          live(ticket, key);
          bundled = reading;
          publishReady(ticket, key, bundled.identity, bundled.recipes);
        } else {
          const result = await source.host.content.discover();
          live(ticket, key);
          fence = resultFence(result);
          publishReady(ticket, key, result.identity, result.value);
        }
      })().catch(() => {
        if (!closed && ticket === generation) publish({ kind: 'failed', scopeKey: key });
      });
    } catch {
      if (!closed && ticket === generation) publish({ kind: 'failed', scopeKey: key });
    }
  }
  function changed() {
    if (closed || source.kind !== 'content') return;
    try {
      const current = source.host.getSnapshot();
      if (`${current.status}:${current.scopeKey}` !== hostSignature) load();
    } catch {
      load();
    }
  }
  function subscribeHost() {
    if (source.kind === 'bundled' || unsubscribe) return true;
    try {
      unsubscribe = source.host.subscribe(changed);
      return true;
    } catch {
      publish({ kind: 'failed', scopeKey: state.scopeKey });
      return false;
    }
  }
  // A failed subscription cannot safely admit a content snapshot.
  if (subscribeHost()) load();

  function checkResult(
    result: {
      installationId: string;
      ownerId: string | null;
      head: unknown;
      adoptionRevision: number;
      identity: Readonly<CatalogueIdentity>;
    },
    ticket: number,
    key: string,
  ) {
    live(ticket, key);
    if (canonicalContentJson(result, 4096) !== fence)
      throw new OrdinaryCatalogueError('scope_changed');
  }
  function identityResult(
    result: Awaited<ReturnType<Host['content']['readCurrent']>>,
    ticket: number,
    key: string,
  ) {
    const { value: _value, ...identity } = result;
    checkResult(identity, ticket, key);
  }
  async function readIdentity(id: string, allowArchived: boolean) {
    recipeId(id);
    const { ticket, key } = ready();
    const lookup =
      source.kind === 'bundled'
        ? bundled!.lookupCurrent(id)
        : await source.host.content.readCurrent(id).then((result) => {
            identityResult(result, ticket, key);
            return result.value;
          });
    live(ticket, key);
    if (
      lookup.kind === 'readable' &&
      (lookup.recipe.recipeId !== id ||
        (lookup.state !== 'current' && (!allowArchived || lookup.state !== 'archived')))
    )
      throw new OrdinaryCatalogueError('invalid_result');
    return lookup;
  }
  return Object.freeze({
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (closed) throw new OrdinaryCatalogueError('closed');
      if (subscribeHost()) load();
    },
    readCurrent: (id: string) => readIdentity(id, false),
    readSavedIdentity: (id: string) => readIdentity(id, true),
    async readExact(input: RecipeContentRef) {
      const ref = ownRef(input);
      const { ticket, key } = ready();
      const lookup =
        source.kind === 'bundled'
          ? bundled!.lookupExact(ref)
          : await source.host.content.readExact(ref).then((result) => {
              identityResult(result, ticket, key);
              return result.value;
            });
      live(ticket, key);
      if (lookup.kind === 'readable' && !same(lookup.recipe.contentRef, ref))
        throw new OrdinaryCatalogueError('invalid_result');
      return lookup;
    },
    async readPhoto(input: RecipeContentRef, assetId: string, signal?: AbortSignal) {
      const ref = ownRef(input);
      if (typeof assetId !== 'string' || assetId.length < 1 || assetId.length > 200)
        throw new OrdinaryCatalogueError('invalid_input');
      const { ticket, key } = ready();
      if (source.kind === 'bundled') throw new OrdinaryCatalogueError('bundled_photo');
      const result = await photos!.read({ ref, assetId }, () => live(ticket, key), signal);
      const { value, ...identity } = result;
      checkResult(identity, ticket, key);
      admitContentPhoto(value);
      if (!same(value.contentRef, ref) || value.assetId !== assetId)
        throw new OrdinaryCatalogueError('invalid_result');
      return result;
    },
    ...(source.kind === 'content'
      ? { onPhotoCleanupFailure: source.host.onPhotoCleanupFailure }
      : {}),
    close() {
      if (closed) return;
      closed = true;
      generation++;
      photos?.close();
      bundled = undefined;
      fence = undefined;
      try {
        unsubscribe?.();
      } finally {
        publish({ kind: 'closed', scopeKey: state.scopeKey });
        listeners.clear();
      }
    },
  });
}
