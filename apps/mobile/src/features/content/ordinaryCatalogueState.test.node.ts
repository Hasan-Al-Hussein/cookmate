import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import type { ContentWorkspaceState } from './contentWorkspaceHost';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';
import type { ContentPhotoRequest, ContentPhotoBatchItem } from '../../data/adoptedContentReader';
import {
  createBundledOrdinaryCatalogue,
  createContentOrdinaryCatalogue,
  OrdinaryCatalogueError,
  type OrdinaryCatalogueController,
  type OrdinaryCatalogueState,
} from './ordinaryCatalogueState';

// Real bundled reader/search plus controlled host responses to exercise UI lifetime contracts.
// These host fixtures do not establish publication, signature, media decoding or database proof.
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const packaged = createBundledContentReader(sha256);
const rejected = (reason: OrdinaryCatalogueError['reason']) => (error: unknown) =>
  error instanceof OrdinaryCatalogueError && error.reason === reason;
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settled(controller: OrdinaryCatalogueController): Promise<OrdinaryCatalogueState> {
  if (controller.getSnapshot().kind !== 'loading') return controller.getSnapshot();
  return new Promise((resolve) => {
    const release = controller.subscribe(() => {
      if (controller.getSnapshot().kind !== 'loading') {
        release();
        resolve(controller.getSnapshot());
      }
    });
  });
}
async function ready(controller: OrdinaryCatalogueController) {
  const state = await settled(controller);
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') throw new Error('Expected ready catalogue');
  return state;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture() {
  const base = (await packaged).recipes[0]!;
  const ref = Object.freeze({
    recipeId: base.recipeId,
    revisionId: 'control-revision',
    contentFingerprint: 'a'.repeat(64),
  });
  const recipe: Immutable<ReadingRecipe> = Object.freeze({
    ...base,
    title: 'Reviewed oyster stew',
    contentRef: ref,
    contentKind: 'authored',
    description: 'Exact controlled reading',
    ingredients: Object.freeze(
      base.ingredients.map((ingredient) => Object.freeze({ ...ingredient, source: null })),
    ),
    instructions: Object.freeze(
      base.instructions.map((passage) => Object.freeze({ ...passage, source: null })),
    ),
    annotations: Object.freeze([]),
    provenance: Object.freeze({
      kind: 'authored',
      authorId: 'controlled-reviewer',
      createdAt: '2026-10-01T12:00:00.000Z',
      changeSummary: 'Controller fixture',
      basedOn: base.contentRef,
      credits: Object.freeze([]),
    }),
  });
  const identity = Object.freeze({ version: 'controlled-content', fingerprint: 'b'.repeat(64) });
  const head = Object.freeze({
    releaseId: 'control-release',
    sequence: 1,
    fingerprint: 'c'.repeat(64),
  });
  const envelope = <Value>(value: Value) =>
    Object.freeze({
      installationId: '10000000-0000-4000-8000-000000000001',
      ownerId: null,
      head,
      adoptionRevision: 1,
      identity,
      value,
    });
  const photo = Object.freeze({
    contentRef: ref,
    assetId: `sha256:${'d'.repeat(64)}`,
    sha256: 'd'.repeat(64),
    mimeType: 'image/png' as const,
    width: 1,
    height: 1,
    bytes: new Uint8Array([1, 2, 3]),
  });
  let state: Readonly<ContentWorkspaceState> = Object.freeze({
    status: 'ready',
    scopeKey: 'owner:1',
    pending: null,
    cleanupPending: 0,
  });
  const listeners = new Set<() => void>();
  const calls = {
    discover: 0,
    current: [] as string[],
    exact: [] as RecipeContentRef[],
    photo: [] as { ref: RecipeContentRef; asset: string }[],
    cleanup: [] as ContentPhotoResource[],
    closed: 0,
  };
  const host = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onPhotoCleanupFailure(resource: ContentPhotoResource) {
      calls.cleanup.push(resource);
    },
    content: {
      async discover() {
        calls.discover++;
        return envelope(Object.freeze([recipe]));
      },
      async readCurrent(id: string) {
        calls.current.push(id);
        return envelope<ReadingLookup>({ kind: 'readable', state: 'current', recipe });
      },
      async readExact(value: RecipeContentRef) {
        calls.exact.push(value);
        return envelope<ReadingLookup>({ kind: 'readable', state: 'historical', recipe });
      },
      async readPhoto(value: RecipeContentRef, asset: string) {
        calls.photo.push({ ref: value, asset });
        return envelope(photo);
      },
      async readPhotos(requests: readonly ContentPhotoRequest[]) {
        const values: ContentPhotoBatchItem[] = [];
        for (const request of requests) {
          const result = await host.content.readPhoto(request.ref, request.assetId);
          values.push({ kind: 'ready', photo: result.value });
        }
        return envelope(values);
      },
    },
    close() {
      calls.closed++;
    },
  };
  function publish(status: ContentWorkspaceState['status'], scopeKey = state.scopeKey) {
    state = Object.freeze({ ...state, status, scopeKey });
    for (const listener of listeners) listener();
  }
  return { host, recipe, ref, base, photo, identity, envelope, calls, publish, listeners };
}

test('default bundled reader exposes original source and existing search/facets without content configuration', async () => {
  const controller = createBundledOrdinaryCatalogue({ scopeKey: 'guest:1', sha256 });
  const state = await ready(controller);
  assert.equal(state.mode, 'bundled');
  assert.equal(state.photoMode, 'bundled');
  assert.deepEqual(state.identity, catalogue.identity);
  assert.equal(state.recipes.length, 100);
  const recipe = state.recipes[0]!;
  assert.equal(recipe.contentKind, 'imported');
  assert.deepEqual(recipe.ingredients[0]!.source, catalogue.recipes[0]!.ingredients[0]!.source);
  assert.equal(state.current(recipe.recipeId), recipe);
  assert.ok(
    state
      .search({ query: recipe.title })
      .matches.some((match) => match.recipeId === recipe.recipeId),
  );
  assert.ok(state.facets.cuisines.includes(recipe.cuisine));
  assert.equal((await controller.readExact(recipe.contentRef)).kind, 'readable');
  assert.deepEqual(
    await controller.readExact({ ...recipe.contentRef, contentFingerprint: 'f'.repeat(64) }),
    { kind: 'missing' },
  );
  await assert.rejects(
    controller.readPhoto(recipe.contentRef, recipe.media[0]!.assetId),
    rejected('bundled_photo'),
  );
  assert.equal(controller.onPhotoCleanupFailure, undefined);
  controller.close();
});

test('content reader indexes genuine host identity and keeps authored structure, exact lookup and verified photo port distinct', async () => {
  const f = await fixture();
  const controller = createContentOrdinaryCatalogue(f.host);
  const state = await ready(controller);
  assert.equal(state.mode, 'content');
  assert.equal(state.photoMode, 'verified');
  assert.equal(state.identity, f.identity);
  assert.equal(state.recipes[0], f.recipe);
  assert.equal(state.recipes[0]!.contentKind, 'authored');
  assert.equal(state.recipes[0]!.ingredients[0]!.source, null);
  assert.deepEqual(state.search({ query: 'oyster stew' }).catalogue, f.identity);
  const historical = await controller.readExact(f.ref);
  assert.equal(historical.kind, 'readable');
  if (historical.kind === 'readable') assert.equal(historical.state, 'historical');
  assert.equal(f.calls.current.length, 0);
  assert.deepEqual(f.calls.exact, [f.ref]);
  const photo = await controller.readPhoto(f.ref, f.photo.assetId);
  assert.equal(photo.value, f.photo);
  controller.close();
});

test('missing or withdrawn host results never fall back to the bundled recipe with the same ID', async () => {
  const f = await fixture();
  f.host.content.readCurrent = async () => f.envelope({ kind: 'missing' });
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  assert.deepEqual(await controller.readCurrent(f.base.recipeId), { kind: 'missing' });
  const withdrawn: ReadingLookup = {
    kind: 'withdrawn',
    recipeId: f.ref.recipeId,
    reason: 'rights',
  };
  controller.close();
  f.host.content.readExact = async () => f.envelope(withdrawn);
  const next = createContentOrdinaryCatalogue(f.host);
  await ready(next);
  assert.deepEqual(await next.readExact(f.ref), withdrawn);
  next.close();
});

test('host revocation immediately invalidates retained recipes/search/facets and refuses more reads', async () => {
  const f = await fixture();
  const controller = createContentOrdinaryCatalogue(f.host);
  const state = await ready(controller);
  const facets = state.facets;
  f.publish('revoked', 'owner:2');
  assert.equal(controller.getSnapshot().kind, 'unavailable');
  assert.throws(() => state.recipes, rejected('scope_changed'));
  assert.throws(() => state.facets, rejected('scope_changed'));
  assert.throws(() => facets.cuisines, rejected('scope_changed'));
  assert.throws(() => state.search({}), rejected('scope_changed'));
  assert.throws(() => state.current(f.ref.recipeId), rejected('scope_changed'));
  await assert.rejects(controller.readCurrent(f.ref.recipeId), rejected('not_ready'));
  assert.equal(f.calls.current.length, 0);
  controller.close();
});

test('late discovery and exact/photo responses cannot escape a changed owner or content epoch', async () => {
  const f = await fixture();
  const discovery = deferred<Awaited<ReturnType<typeof f.host.content.discover>>>();
  f.host.content.discover = () => discovery.promise;
  const loading = createContentOrdinaryCatalogue(f.host);
  f.publish('revoked', 'owner:2');
  discovery.resolve(f.envelope(Object.freeze([f.recipe])));
  await flush();
  assert.equal(loading.getSnapshot().kind, 'unavailable');
  loading.close();

  f.publish('ready', 'owner:3');
  f.host.content.discover = async () => f.envelope(Object.freeze([f.recipe]));
  const exact = deferred<Awaited<ReturnType<typeof f.host.content.readExact>>>();
  const photo = deferred<Awaited<ReturnType<typeof f.host.content.readPhoto>>>();
  f.host.content.readExact = () => exact.promise;
  f.host.content.readPhoto = () => photo.promise;
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  const lateExact = controller.readExact(f.ref);
  const latePhoto = controller.readPhoto(f.ref, f.photo.assetId);
  f.publish('updating', 'owner:4');
  exact.resolve(f.envelope({ kind: 'readable', state: 'historical', recipe: f.recipe }));
  photo.resolve(f.envelope(f.photo));
  await assert.rejects(lateExact, rejected('scope_changed'));
  await assert.rejects(latePhoto, rejected('scope_changed'));
  controller.close();
});

test('failed discovery supports explicit retry; cleanup-only host notifications do not re-index', async () => {
  const f = await fixture();
  let fail = true;
  f.host.content.discover = async () => {
    f.calls.discover++;
    if (fail) throw new Error('unavailable release');
    return f.envelope(Object.freeze([f.recipe]));
  };
  const controller = createContentOrdinaryCatalogue(f.host);
  assert.equal((await settled(controller)).kind, 'failed');
  assert.equal(f.calls.discover, 1);
  fail = false;
  controller.retry();
  const state = await ready(controller);
  assert.equal(f.calls.discover, 2);
  f.publish('ready');
  assert.equal(controller.getSnapshot(), state);
  assert.equal(f.calls.discover, 2);
  f.publish('result_ready', 'owner:next');
  controller.retry();
  assert.equal(f.calls.discover, 2);
  assert.equal(controller.getSnapshot().kind, 'unavailable');
  f.publish('ready', 'owner:next');
  assert.notEqual(await ready(controller), state);
  controller.close();
});

test('strict owned refs reject getters/extras before calls and resist caller mutation across await', async () => {
  const f = await fixture();
  const pending = deferred<Awaited<ReturnType<typeof f.host.content.readExact>>>();
  f.host.content.readExact = async (ref) => {
    f.calls.exact.push(ref);
    return pending.promise;
  };
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  let getterRead = false;
  const hostile = {
    ...f.ref,
    get contentFingerprint(): string {
      getterRead = true;
      throw new Error('do not invoke');
    },
  };
  await assert.rejects(controller.readExact(hostile), rejected('invalid_input'));
  await assert.rejects(
    controller.readExact({ ...f.ref, extra: true } as RecipeContentRef),
    rejected('invalid_input'),
  );
  await assert.rejects(controller.readCurrent('x'.repeat(100_000)), rejected('invalid_input'));
  assert.equal(getterRead, false);
  assert.equal(f.calls.exact.length, 0);
  const mutable = { ...f.ref };
  const read = controller.readExact(mutable);
  mutable.contentFingerprint = 'f'.repeat(64);
  pending.resolve(f.envelope({ kind: 'readable', state: 'historical', recipe: f.recipe }));
  assert.equal((await read).kind, 'readable');
  assert.deepEqual(f.calls.exact, [f.ref]);
  assert.equal(Object.isFrozen(f.calls.exact[0]), true);
  controller.close();
});

test('unexpected revision, photo identity and adoption result fence fail closed', async () => {
  const f = await fixture();
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  await assert.rejects(
    controller.readExact({ ...f.ref, revisionId: 'other-revision' }),
    rejected('invalid_result'),
  );
  await assert.rejects(
    controller.readPhoto(f.ref, `sha256:${'e'.repeat(64)}`),
    rejected('invalid_result'),
  );
  controller.close();
  f.host.content.readCurrent = async () => ({
    ...f.envelope<ReadingLookup>({ kind: 'readable', state: 'current', recipe: f.recipe }),
    adoptionRevision: 2,
  });
  const changed = createContentOrdinaryCatalogue(f.host);
  await ready(changed);
  await assert.rejects(changed.readCurrent(f.ref.recipeId), rejected('scope_changed'));
  changed.close();
});

test('adapter close revokes late results, detaches subscriptions and still forwards photo cleanup to its owner', async () => {
  const f = await fixture();
  const pending = deferred<Awaited<ReturnType<typeof f.host.content.readCurrent>>>();
  f.host.content.readCurrent = () => pending.promise;
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  const read = controller.readCurrent(f.ref.recipeId);
  controller.close();
  controller.close();
  pending.resolve(f.envelope({ kind: 'readable', state: 'current', recipe: f.recipe }));
  await assert.rejects(read, rejected('closed'));
  assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.closed, 0);
  const resource = { uri: 'owned:test-only', release: () => false };
  controller.onPhotoCleanupFailure!(resource);
  assert.deepEqual(f.calls.cleanup, [resource]);
  assert.equal(controller.getSnapshot().kind, 'closed');
  assert.throws(() => controller.retry(), rejected('closed'));
});

test('captured host methods cannot be replaced and throwing subscribers cannot stop revocation', async () => {
  const f = await fixture();
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  f.host.content.readCurrent = async () => {
    throw new Error('replaced read');
  };
  f.host.onPhotoCleanupFailure = () => {
    throw new Error('replaced cleanup');
  };
  assert.equal((await controller.readCurrent(f.ref.recipeId)).kind, 'readable');
  const resource = { uri: 'owned:test', release: () => true };
  controller.onPhotoCleanupFailure!(resource);
  assert.deepEqual(f.calls.cleanup, [resource]);
  controller.subscribe(() => {
    throw new Error('view failure');
  });
  f.publish('revoked');
  assert.equal(controller.getSnapshot().kind, 'unavailable');
  controller.close();
});

test('failed subscription cannot admit discovery on retry until observation is actually established', async () => {
  const f = await fixture();
  const subscribe = f.host.subscribe;
  let fail = true;
  f.host.subscribe = (listener) => {
    if (fail) throw new Error('subscription unavailable');
    return subscribe(listener);
  };
  const controller = createContentOrdinaryCatalogue(f.host);
  assert.equal(controller.getSnapshot().kind, 'failed');
  controller.retry();
  assert.equal(f.calls.discover, 0);
  fail = false;
  controller.retry();
  await ready(controller);
  assert.equal(f.listeners.size, 1);
  controller.close();
});

test('bad bundled hash fails without a partial reader and closing pending initialization prevents resurrection', async () => {
  const invalid = createBundledOrdinaryCatalogue({ scopeKey: 'legacy', sha256: async () => 'bad' });
  assert.equal((await settled(invalid)).kind, 'failed');
  invalid.close();
  const gate = deferred<void>();
  const controller = createBundledOrdinaryCatalogue({
    scopeKey: 'legacy:pending',
    sha256: async (text) => {
      await gate.promise;
      return sha256(text);
    },
  });
  controller.close();
  gate.resolve();
  await flush();
  assert.equal(controller.getSnapshot().kind, 'closed');
});

test('saved identity admits an archived member without widening current discovery reads', async () => {
  const f = await fixture();
  let value: ReadingLookup = { kind: 'readable', state: 'archived', recipe: f.recipe };
  let adoptionRevision = 1;
  f.host.content.readCurrent = async () => ({ ...f.envelope(value), adoptionRevision });
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  assert.equal((await controller.readSavedIdentity(f.recipe.recipeId)).kind, 'readable');
  await assert.rejects(controller.readCurrent(f.recipe.recipeId), rejected('invalid_result'));
  value = { kind: 'readable', state: 'historical', recipe: f.recipe };
  await assert.rejects(controller.readSavedIdentity(f.recipe.recipeId), rejected('invalid_result'));
  value = { kind: 'readable', state: 'archived', recipe: { ...f.recipe, recipeId: '99999' } };
  await assert.rejects(controller.readSavedIdentity(f.recipe.recipeId), rejected('invalid_result'));
  value = { kind: 'missing' };
  assert.deepEqual(await controller.readSavedIdentity(f.recipe.recipeId), { kind: 'missing' });
  value = { kind: 'readable', state: 'archived', recipe: f.recipe };
  adoptionRevision = 2;
  await assert.rejects(controller.readSavedIdentity(f.recipe.recipeId), rejected('scope_changed'));
  controller.close();
});

test('saved identity cannot return an archived body after owner retirement', async () => {
  const f = await fixture();
  const pending = deferred<Awaited<ReturnType<typeof f.host.content.readCurrent>>>();
  f.host.content.readCurrent = () => pending.promise;
  const controller = createContentOrdinaryCatalogue(f.host);
  await ready(controller);
  const read = controller.readSavedIdentity(f.recipe.recipeId);
  f.publish('revoked', 'owner:retired');
  pending.resolve(f.envelope({ kind: 'readable', state: 'archived', recipe: f.recipe }));
  await assert.rejects(read, rejected('scope_changed'));
  controller.close();
});
