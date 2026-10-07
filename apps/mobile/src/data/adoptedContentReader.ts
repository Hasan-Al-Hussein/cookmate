import {
  canonicalContentJson,
  createBundledContentReader,
  createContentReader,
  ContentValidationError,
  validateRecipeContentRef,
  type ContentHash,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import { readAdoptionInSnapshot } from './cookingContentRepository';
import { isAppId } from './conversationRecords';
import {
  ContentStoreFault,
  type openContentReleaseStore,
  type ContentReadingView,
} from './contentReleaseStore';
import { readRestoreEpoch } from './restoreEpoch';
import type { SerializedReader } from './sql';
import type { VerifiedContentPhoto } from './contentReadingMedia';

export const CONTENT_PHOTO_BATCH_LIMIT = 6;
export const CONTENT_PHOTO_BATCH_BYTES = 32 * 1024 * 1024;
export interface ContentPhotoRequest {
  readonly ref: RecipeContentRef;
  readonly assetId: string;
}
export type ContentPhotoBatchItem =
  | { readonly kind: 'ready'; readonly photo: VerifiedContentPhoto }
  | { readonly kind: 'unavailable' };

export class AdoptedContentReadError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'access_changed'
      | 'adoption_changed'
      | 'policy_changed'
      | 'exact_unavailable'
      | 'invalid_input'
      | 'photo_batch_too_large'
      | 'stored_data_invalid',
  ) {
    super(`Adopted recipe content: ${code}`);
    this.name = 'AdoptedContentReadError';
  }
}
interface Options {
  reader: SerializedReader;
  contentStore: Pick<Awaited<ReturnType<typeof openContentReleaseStore>>, 'withVerifiedReading'>;
  installationId: string;
  sha256: ContentHash;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}
function valid(value: unknown, code: AdoptedContentReadError['code']): asserts value {
  if (!value) throw new AdoptedContentReadError(code);
}
const same = (a: unknown, b: unknown) =>
  canonicalContentJson(a, 4096) === canonicalContentJson(b, 4096);
type Reading = ReturnType<typeof createContentReader>;

function ownPhotoRequests(input: readonly ContentPhotoRequest[]): readonly ContentPhotoRequest[] {
  valid(
    Array.isArray(input) && input.length > 0 && input.length <= CONTENT_PHOTO_BATCH_LIMIT,
    'invalid_input',
  );
  try {
    const owned: unknown = JSON.parse(
      canonicalContentJson(input, CONTENT_PHOTO_BATCH_LIMIT * 1536),
    );
    valid(Array.isArray(owned), 'invalid_input');
    return Object.freeze(
      owned.map((request: unknown) => {
        valid(!!request && typeof request === 'object' && !Array.isArray(request), 'invalid_input');
        const value = request as Record<string, unknown>;
        valid(
          Object.keys(value).sort().join(',') === 'assetId,ref' &&
            validateRecipeContentRef(value.ref) &&
            typeof value.assetId === 'string' &&
            value.assetId.length > 0 &&
            value.assetId.length <= 200,
          'invalid_input',
        );
        return Object.freeze({ ref: Object.freeze(value.ref), assetId: value.assetId });
      }),
    );
  } catch {
    throw new AdoptedContentReadError('invalid_input');
  }
}

/**
 * Opt-in schema-7 host service. It owns no database handles and never migrates or adopts.
 * Every read reopens the persisted cooking head and rechecks owner/restore/adoption after
 * verification. Callers must discard rendered results when their workspace unmounts.
 */
export function createAdoptedContentReader(options: Options) {
  valid(isAppId(options.installationId), 'invalid_input');
  const access = options.getAccess();
  valid(
    access &&
      (access.ownerId === null || isAppId(access.ownerId)) &&
      Number.isSafeInteger(access.authGeneration) &&
      access.authGeneration >= 0,
    'access_changed',
  );
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false;
  let packaged: Promise<Awaited<ReturnType<typeof createBundledContentReader>>> | undefined;
  function check() {
    valid(!closed, 'closed');
    const live = options.getAccess();
    valid(
      live && live.ownerId === scope.ownerId && live.authGeneration === scope.authGeneration,
      'access_changed',
    );
    valid(options.assertAccess(scope) === undefined, 'access_changed');
  }
  async function capture() {
    check();
    const result = await options.reader.transaction(
      async (session) => {
        check();
        const rows = await session.all<{ id: string | null }>(
          "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value ELSE NULL END id FROM app_metadata WHERE key='installation_id'",
        );
        valid(rows.length === 1 && rows[0]!.id === options.installationId, 'access_changed');
        valid((await readBinding(session)) === scope.ownerId, 'access_changed');
        const adoption = await readAdoptionInSnapshot(session);
        const restoreEpoch = await readRestoreEpoch(session);
        check();
        return { ...adoption, restoreEpoch };
      },
      { kind: 'read_only' },
    );
    check();
    return result;
  }
  async function read<Value>(
    select: (reader: Reading, view: Immutable<ContentReadingView>) => Value | Promise<Value>,
    exact: readonly RecipeContentRef[] = [],
  ) {
    const before = await capture();
    try {
      const result = await options.contentStore.withVerifiedReading(
        before.head,
        exact,
        async (view) => {
          check();
          valid(same(view.head, before.head), 'stored_data_invalid');
          let reading: Reading;
          if (before.head) {
            valid(view.snapshot, 'stored_data_invalid');
            reading = createContentReader(view.snapshot);
          } else {
            // A signed withdrawal cannot be bypassed through an older packaged pointer.
            valid(!view.hasWithdrawal, 'policy_changed');
            packaged ??= createBundledContentReader(options.sha256).catch((error: unknown) => {
              packaged = undefined;
              throw error;
            });
            reading = await packaged;
            check();
          }
          const value = await select(reading, view);
          // The content reservation still excludes competing activation/withdrawal here.
          valid(same(before, await capture()), 'adoption_changed');
          check();
          return Object.freeze({
            installationId: options.installationId,
            ownerId: scope.ownerId,
            head: before.head,
            adoptionRevision: before.revision,
            identity: reading.identity,
            value,
          });
        },
      );
      check();
      return result;
    } catch (error) {
      check();
      if (
        exact.length > 0 &&
        error instanceof ContentValidationError &&
        error.code === 'overlay_dependency_missing'
      )
        throw new AdoptedContentReadError('exact_unavailable');
      if (error instanceof ContentStoreFault) {
        if (error.code === 'content_store_adoption_policy_changed')
          throw new AdoptedContentReadError('policy_changed');
        if (error.code === 'content_store_retained_ref_unavailable')
          throw new AdoptedContentReadError('exact_unavailable');
      }
      throw error;
    }
  }
  return Object.freeze({
    discover: () => read((reader) => reader.recipes),
    readCurrent(recipeId: string) {
      valid(typeof recipeId === 'string' && /^[0-9]{1,20}$/.test(recipeId), 'invalid_input');
      return read((reader) => reader.lookupCurrent(recipeId));
    },
    readExact(ref: RecipeContentRef) {
      valid(validateRecipeContentRef(ref), 'invalid_input');
      const owned = JSON.parse(canonicalContentJson(ref, 1024)) as RecipeContentRef;
      return read((reader) => reader.lookupExact(owned), [owned]);
    },
    readPhoto(ref: RecipeContentRef, assetId: string) {
      valid(
        validateRecipeContentRef(ref) &&
          typeof assetId === 'string' &&
          assetId.length > 0 &&
          assetId.length <= 200,
        'invalid_input',
      );
      const owned = JSON.parse(canonicalContentJson(ref, 1024)) as RecipeContentRef;
      return read((_reader, view) => view.readPhoto(owned, assetId), [owned]);
    },
    readPhotos(requests: readonly ContentPhotoRequest[]) {
      const owned = ownPhotoRequests(requests);
      const refs = [...new Map(owned.map(({ ref }) => [canonicalContentJson(ref), ref])).values()];
      return read(async (reader, view): Promise<readonly ContentPhotoBatchItem[]> => {
        let bytes = 0;
        for (const request of owned) {
          const lookup = reader.lookupExact(request.ref);
          valid(lookup.kind === 'readable', 'exact_unavailable');
          bytes +=
            lookup.recipe.media.find((media) => media.assetId === request.assetId)?.bytes ?? 0;
          valid(bytes <= CONTENT_PHOTO_BATCH_BYTES, 'photo_batch_too_large');
        }
        const results: ContentPhotoBatchItem[] = [];
        for (const request of owned) {
          check();
          view.assertActive();
          try {
            const photo = await view.readPhoto(request.ref, request.assetId);
            results.push(Object.freeze({ kind: 'ready', photo }));
          } catch (error) {
            // Only a failure of this photo can be partial. Reservation and access failures
            // remain fatal, including a close reported with the generic store-invalid code.
            check();
            view.assertActive();
            if (
              !(error instanceof ContentStoreFault) ||
              (error.code !== 'content_store_retained_ref_unavailable' &&
                error.code !== 'content_store_invalid')
            )
              throw error;
            results.push(Object.freeze({ kind: 'unavailable' }));
          }
          check();
          view.assertActive();
        }
        return Object.freeze(results);
      }, refs);
    },
    close() {
      closed = true;
      packaged = undefined;
    },
  });
}
