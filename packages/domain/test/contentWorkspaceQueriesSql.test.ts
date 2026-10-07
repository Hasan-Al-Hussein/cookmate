import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  createBundledContentSnapshot,
  verifySignedContentOverlay,
  type ContentOverlayManifest,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type PublishedRecipeRevision,
  type ReadableRecipeView,
} from '@cookmate/catalogue/content';
import type { DirectActionInput, Immutable, RepositoryResult } from '../src';
import { createContentWorkspaceQueries } from '../../../apps/mobile/src/data/contentWorkspaceQueries';
import type { ContentShoppingShareRecipe } from '../../../apps/mobile/src/data/contentShoppingShare';
import { createContentDirectCommands } from '../../../apps/mobile/src/data/contentDirectCommands';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import type {
  ContentReadingView,
  openContentReleaseStore,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { member, published, signed } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z',
  authoredId = '900000099';
const placement = (day: number) => ({
  actualDate: `2026-10-${String(day).padStart(2, '0')}`,
  mealKey: 'dinner' as const,
});
function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string; error?: { messageKey: string } }, key?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (key) assert.equal(result.error?.messageKey, key);
}

async function fixture(
  t: TestContext,
  schema: 7 | 8 = 8,
  multiplePhotos = false,
  inheritedSource = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-workspace-'));
  const path = join(directory, 'cooking.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    ids,
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  await migrateCookingContentDatabase(writer, { sha256 });
  if (schema === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 0 };
  let head: OverlayHead | null = null,
    snapshot: EffectiveContentSnapshot | null = null;
  const baseline = await createBundledContentSnapshot(sha256);
  const fixtureRecipeId = inheritedSource ? '53262' : authoredId;
  const document = authoredFixture(fixtureRecipeId);
  if (document.kind !== 'authored') assert.fail();
  document.recipe.recipePage = 'https://example.test/recipes/first';
  document.recipe.originalSourceUrl = 'https://example.test/publisher/first';
  document.provenance.credits = [
    { label: 'First supplied credit', url: 'https://example.test/credit/first' },
    { label: 'Credit without URL', url: null },
  ];
  if (inheritedSource)
    document.provenance.basedOn = clone(
      baseline.revisions.find((value) => value.ref.recipeId === fixtureRecipeId)!.ref,
    );
  if (multiplePhotos) {
    const secondary = clone(document.media[0]!);
    secondary.sha256 = '0'.repeat(64);
    secondary.assetId = `sha256:${secondary.sha256}`;
    secondary.photoKey = `photos/${fixtureRecipeId}-secondary.jpg`;
    document.media.unshift(secondary);
  }
  document.recipe.ingredients[0]!.rawMeasure = '1 tsp';
  const first = await published(document, 'workspace-first');
  document.provenance.basedOn = clone(first.revision.ref);
  document.recipe.title = 'Second exact version';
  document.recipe.ingredients[0]!.rawMeasure = '2 tsp';
  document.recipe.recipePage = 'https://example.test/recipes/second';
  document.provenance.credits = [{ label: 'Second supplied credit', url: null }];
  const second = await published(document, 'workspace-second');
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>(),
    publications = new Map<string, PublishedRecipeRevision>();
  async function adopt(mode: 'first' | 'second' | 'archive' | 'withdraw') {
    const selected = mode === 'first' ? first : second;
    const sequence = (head?.sequence ?? 0) + 1;
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `workspace-release-${sequence}`,
      sequence,
      previous: head,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries: [
        mode === 'withdraw'
          ? { state: 'withdrawn', recipeId: fixtureRecipeId, reason: 'Fixture withdrawal' }
          : mode === 'archive'
            ? {
                state: 'archived',
                ref: clone(second.revision.ref),
                publicationFingerprint: second.publicationFingerprint,
                reason: 'Fixture archive',
              }
            : member(selected),
      ],
    };
    const envelope = await signed(manifest);
    snapshot = await verifySignedContentOverlay(envelope, {
      sha256,
      baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
      expectedCurrent: head,
      minimumSequence: head?.sequence ?? 0,
      readerVersion: 1,
      publications: mode === 'first' || mode === 'second' ? [selected] : [],
      retainedRefs: [...publications.values()].map((value) => value.revision.ref),
      trustVerifier: {
        async verify(value) {
          return value.signature === 'synthetic_signature_no_crypto';
        },
      },
      mediaVerifier: {
        async verify() {
          return true;
        },
      },
      archive: {
        async readRelease(id) {
          return releases.get(id) ?? null;
        },
        async readPublication(id, revision) {
          return publications.get(`${id}|${revision}`) ?? null;
        },
      },
    });
    head = { releaseId: manifest.releaseId, sequence, fingerprint: envelope.fingerprint };
    releases.set(manifest.releaseId, { manifest, fingerprint: envelope.fingerprint });
    if (mode === 'first' || mode === 'second')
      publications.set(`${fixtureRecipeId}|${selected.revision.ref.revisionId}`, selected);
    write.database
      .prepare('UPDATE app_content_adoption SET revision=revision+1,head_json=?')
      .run(JSON.stringify(head));
  }
  const faults = {
    unavailable: false,
    invalidSnapshot: false,
    oversizedShare: false,
    calls: 0,
    beforeContent: undefined as (() => unknown) | undefined,
    afterContent: undefined as (() => unknown) | undefined,
    onHash: undefined as (() => unknown) | undefined,
  };
  // Controlled core-verified overlay/lifetime ports over actual SQLite; no crypto-service or native acceptance claim.
  const contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReading'
  > = {
    async withVerifiedReading(expected, refs, work) {
      faults.calls++;
      if (faults.unavailable) throw new Error('Fixture delivery unavailable');
      assert.deepEqual(expected, head);
      for (const ref of refs)
        if (snapshot && snapshot.lookupExact(ref).kind !== 'readable')
          throw new Error('Fixture exact reference unavailable');
      const before = faults.beforeContent;
      faults.beforeContent = undefined;
      await before?.();
      let active = true;
      let selectedSnapshot = snapshot;
      if (faults.oversizedShare && snapshot) {
        // Synthetic verified-port fault: test the metadata budget without weakening publication validation.
        const oversized = 'x'.repeat(8 * 1024 * 1024);
        const expand = (value: Immutable<ReadableRecipeView>): Immutable<ReadableRecipeView> => {
          const document = value.revision.document;
          return document.kind === 'authored'
            ? {
                ...value,
                revision: {
                  ...value.revision,
                  document: {
                    ...document,
                    provenance: {
                      ...document.provenance,
                      credits: [{ label: oversized, url: null }],
                    },
                  },
                },
              }
            : value;
        };
        const original = snapshot;
        selectedSnapshot = {
          ...original,
          discoverable: original.discoverable.map(expand),
          lookupExact(ref) {
            const found = original.lookupExact(ref);
            return found.kind === 'readable' ? { ...found, value: expand(found.value) } : found;
          },
        };
      }
      const view: ContentReadingView = {
        head,
        latestHead: head,
        snapshot: faults.invalidSnapshot ? null : selectedSnapshot,
        hasWithdrawal: snapshot?.entries.some((entry) => entry.state === 'withdrawn') ?? false,
        assertActive() {
          assert.ok(active);
          return undefined;
        },
        async readPhoto() {
          throw new Error('Unused');
        },
      };
      try {
        const value = await work(view);
        const after = faults.afterContent;
        faults.afterContent = undefined;
        await after?.();
        return value;
      } finally {
        active = false;
      }
    },
  };
  const options = {
    reader,
    contentStore,
    installationId: ids.installationId,
    async sha256(text: string) {
      const hook = faults.onHash;
      faults.onHash = undefined;
      await hook?.();
      return sha256(text);
    },
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(access, scope);
      return undefined;
    },
  };
  const create = () => createContentWorkspaceQueries(options),
    queries = create();
  const commands = createContentDirectCommands({
    ...options,
    writer,
    commandSchemaVersion: schema,
    platform: { sha256, newId: randomUUID },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    onCommitted() {},
  });
  async function act(input: DirectActionInput) {
    const command = ready(await commands.prepareDirect(ready(await commands.reviewDirect(input))));
    const result = await commands.execute(command);
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    return command.command;
  }
  async function plan(day: number, id = fixtureRecipeId) {
    const command = await act({ kind: 'placeRecipe', recipeId: id, placement: placement(day) });
    assert.equal(command.kind, 'addPlan');
    if (command.kind !== 'addPlan') assert.fail();
    return command.occurrenceId;
  }
  function bind(ownerId: string | null, generation: number) {
    access = { ownerId, authGeneration: generation };
    if (ownerId === null)
      write.database.exec("DELETE FROM app_metadata WHERE key='account-replication:owner'");
    else
      write.database
        .prepare("INSERT OR REPLACE INTO app_metadata VALUES ('account-replication:owner',?)")
        .run(JSON.stringify({ schemaVersion: 1, ownerId }));
  }
  return {
    queries,
    commands,
    create,
    options,
    write,
    read,
    writer,
    ids,
    first,
    second,
    adopt,
    act,
    plan,
    bind,
    faults,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
  };
}

test('actual8 Plan and Shopping keep two exact authored revisions, raw quantities and cross-week selection', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  const first = await f.plan(1);
  await f.adopt('second');
  const second = await f.plan(15);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [first, second] });
  const before = f.write.database.prepare('SELECT * FROM state_revision').all();
  const plan = ready(await f.queries.readPlan('2026-10-01', '2026-10-07'));
  assert.equal(plan.occurrences.length, 1);
  assert.deepEqual(plan.occurrences[0]!.contentRef, f.first.revision.ref);
  assert.equal(plan.occurrences[0]!.content.kind, 'readable');
  if (plan.occurrences[0]!.content.kind !== 'readable') assert.fail();
  assert.equal(plan.occurrences[0]!.content.title, f.first.revision.document.recipe.title);
  assert.equal(plan.occurrences[0]!.content.state, 'historical');
  assert.equal(plan.shoppingScope.occurrenceIds.length, 2);
  let shopping = ready(await f.queries.readShopping());
  assert.equal(shopping.kind, 'current');
  if (shopping.kind !== 'current') assert.fail();
  assert.equal(shopping.snapshot.groups.length, 1);
  const group = shopping.snapshot.groups[0]!;
  assert.equal(group.quantityLabel, '3 tsp');
  assert.deepEqual(group.contributions.map((row) => row.rawMeasure).sort(), ['1 tsp', '2 tsp']);
  assert.deepEqual(
    group.contributions.map((row) => row.contentRef.revisionId).sort(),
    [f.first.revision.ref.revisionId, f.second.revision.ref.revisionId].sort(),
  );
  assert.equal(shopping.selected.length, 2);
  assert.equal(shopping.share.kind, 'ready');
  if (shopping.share.kind !== 'ready') assert.fail();
  assert.deepEqual(
    shopping.share.recipes.map((recipe) => recipe.contentRef.revisionId).sort(),
    [f.first.revision.ref.revisionId, f.second.revision.ref.revisionId].sort(),
  );
  for (const publication of [f.first, f.second]) {
    const shared: Immutable<ContentShoppingShareRecipe> = shopping.share.recipes.find(
      (recipe) => recipe.contentRef.revisionId === publication.revision.ref.revisionId,
    )!;
    assert.deepEqual(shared.contentRef, publication.revision.ref);
    assert.equal(shared.title, publication.revision.document.recipe.title);
    assert.equal(shared.recipePage, publication.revision.document.recipe.recipePage);
    assert.equal(shared.originalSourceUrl, publication.revision.document.recipe.originalSourceUrl);
    const provenance = publication.revision.document.provenance;
    assert.deepEqual(shared.credits, provenance.kind === 'authored' ? provenance.credits : []);
    assert.deepEqual(shared.retainedSources, []);
    assert.equal(Object.isFrozen(shared.credits), true);
  }
  assert.equal(Object.isFrozen(shopping.snapshot.groups[0]!.contributions[0]!.contentRef), true);
  assert.deepEqual(f.write.database.prepare('SELECT * FROM state_revision').all(), before);
  await f.act({ kind: 'setPurchased', groupKey: group.groupKey, purchased: true });
  shopping = ready(await f.queries.readShopping());
  if (shopping.kind !== 'current') assert.fail();
  assert.equal(shopping.snapshot.groups[0]!.purchased, true);
});

test('Plan and Shopping select the exact primary photo rather than the first matching recipe asset', async (t) => {
  const f = await fixture(t, 8, true);
  await f.adopt('first');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  const plan = ready(await f.queries.readPlan('2026-10-01', '2026-10-07'));
  const content = plan.occurrences[0]!.content;
  if (content.kind !== 'readable') assert.fail();
  assert.equal(content.photoAssetId, `sha256:${'1'.repeat(64)}`);
  const shopping = ready(await f.queries.readShopping());
  if (shopping.kind !== 'current') assert.fail();
  assert.deepEqual(shopping.selected[0]!.content, content);
});

test('archived exact recipes stay readable; withdrawals retain metadata without current Shopping groups', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.adopt('second');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  await f.adopt('archive');
  const archived = ready(await f.queries.readPlan('2026-10-01', '2026-10-07')).occurrences[0]!;
  assert.equal(archived.content.kind, 'readable');
  if (archived.content.kind !== 'readable') assert.fail();
  assert.equal(archived.content.state, 'archived');
  const archivedShopping = ready(await f.queries.readShopping());
  if (archivedShopping.kind !== 'current' || archivedShopping.share.kind !== 'ready') assert.fail();
  assert.deepEqual(archivedShopping.share.recipes[0]!.contentRef, f.second.revision.ref);
  await f.adopt('withdraw');
  const withdrawn = ready(await f.queries.readPlan('2026-10-01', '2026-10-07')).occurrences[0]!;
  assert.deepEqual(withdrawn.contentRef, f.second.revision.ref);
  assert.deepEqual(withdrawn.content, { kind: 'unavailable', reason: 'withdrawn' });
  const shopping = ready(await f.queries.readShopping());
  assert.equal(shopping.kind, 'unavailable');
  assert.equal(Object.hasOwn(shopping, 'snapshot'), false);
  assert.equal(Object.hasOwn(shopping, 'groups'), false);
  assert.equal(Object.hasOwn(shopping, 'share'), false);
});

test('content delivery failure exposes only stable exact metadata and never rewrites the stored projection', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  const stored = f.write.database.prepare('SELECT * FROM shopping_contribution').all();
  f.faults.unavailable = true;
  const plan = ready(await f.queries.readPlan('2026-10-01', '2026-10-07'));
  assert.deepEqual(plan.occurrences[0]!.content, {
    kind: 'unavailable',
    reason: 'delivery_unavailable',
  });
  const shopping = ready(await f.queries.readShopping());
  assert.equal(shopping.kind, 'unavailable');
  assert.equal(Object.hasOwn(shopping, 'share'), false);
  assert.equal(shopping.selected[0]!.occurrence.occurrenceId, id);
  assert.deepEqual(f.write.database.prepare('SELECT * FROM shopping_contribution').all(), stored);
});

test('original bundled source warnings and exact raw ingredient measures remain visible in Shopping', async (t) => {
  const f = await fixture(t),
    recipe = catalogue.recipes.find((value) => value.annotations.length > 0)!;
  const id = await f.plan(1, recipe.recipeId);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  const shopping = ready(await f.queries.readShopping());
  if (shopping.kind !== 'current') assert.fail();
  assert.deepEqual(shopping.notices[0]!.annotations, recipe.annotations);
  if (shopping.share.kind !== 'ready') assert.fail();
  assert.equal(shopping.share.recipes[0]!.contentKind, 'imported');
  assert.equal(shopping.share.recipes[0]!.recipePage, recipe.recipePage);
  assert.equal(shopping.share.recipes[0]!.originalSourceUrl, recipe.originalSourceUrl);
  assert.deepEqual(shopping.share.recipes[0]!.credits, []);
  assert.equal(shopping.share.recipes[0]!.retainedSources[0]!.disposition, 'original');
  const contributions = shopping.snapshot.groups.flatMap((group) => group.contributions);
  for (const ingredient of recipe.ingredients) {
    const item = contributions.find(
      (value) =>
        value.source.section === 'ingredient' && value.source.position === ingredient.position,
    );
    assert.ok(item);
    assert.equal(item.rawName, ingredient.rawName);
    assert.equal(item.rawMeasure, ingredient.rawMeasure);
  }
});

test('sharing metadata uses one verified read, deduplicates exact references and exposes only public source fields', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  const first = await f.plan(1),
    repeated = await f.plan(2);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [first, repeated] });
  f.write.database
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)')
    .run(randomUUID(), authoredId, JSON.stringify('PRIVATE_NOTE_MUST_NOT_BE_SHARED'), at, at);
  f.write.database.exec('UPDATE personal_state SET revision=1');
  const statements: string[] = [],
    readAll = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    statements.push(sql);
    return readAll<Row>(sql, values);
  };
  const calls = f.faults.calls;
  const shopping = ready(await f.queries.readShopping());
  assert.equal(f.faults.calls - calls, 1);
  if (shopping.kind !== 'current' || shopping.share.kind !== 'ready') assert.fail();
  assert.equal(shopping.selected.length, 2);
  assert.equal(shopping.share.recipes.length, 1);
  assert.deepEqual(
    Object.keys(shopping.share.recipes[0]!).sort(),
    [
      'contentRef',
      'contentKind',
      'title',
      'recipePage',
      'originalSourceUrl',
      'credits',
      'retainedSources',
    ].sort(),
  );
  for (const credit of shopping.share.recipes[0]!.credits)
    assert.deepEqual(Object.keys(credit).sort(), ['label', 'url']);
  const text = JSON.stringify(shopping.share);
  for (const excluded of [
    'PRIVATE_NOTE_MUST_NOT_BE_SHARED',
    'authorId',
    'changeSummary',
    'ingredients',
    'instructions',
    'permissions',
    'media',
    'rights',
    'reviewerId',
  ])
    assert.equal(text.includes(excluded), false, excluded);
  assert.equal(
    statements.some((sql) =>
      /\b(recipe_note|manual_shopping_item|personal_collection|personal_operation)\b/.test(sql),
    ),
    false,
  );
});

test('authored sharing retains exact original source attribution and unresolved warnings', async (t) => {
  const f = await fixture(t, 8, false, true);
  await f.adopt('first');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  const shopping = ready(await f.queries.readShopping());
  if (shopping.kind !== 'current' || shopping.share.kind !== 'ready') assert.fail();
  const source = catalogue.recipes.find((recipe) => recipe.recipeId === '53262')!;
  const shared = shopping.share.recipes[0]!;
  assert.equal(shared.contentKind, 'authored');
  assert.equal(shared.retainedSources.length, 1);
  const retained = shared.retainedSources[0]!;
  assert.equal(retained.disposition, 'inherited_unresolved');
  assert.equal(retained.title, source.title);
  assert.equal(retained.recipePage, source.recipePage);
  assert.equal(retained.originalSourceUrl, source.originalSourceUrl);
  assert.deepEqual(
    Object.keys(retained).sort(),
    ['ref', 'disposition', 'title', 'recipePage', 'originalSourceUrl'].sort(),
  );
  const warning = shopping.notices.find((notice) => notice.disposition === 'inherited_unresolved')!;
  assert.deepEqual(warning.contentRef, retained.ref);
  assert.equal(warning.occurrenceId, id);
  assert.deepEqual(warning.annotations, source.annotations);
});

test('oversized sharing metadata disables only sharing and preserves the confirmed checklist and warnings', async (t) => {
  const f = await fixture(t, 8, false, true);
  await f.adopt('first');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  const initial = ready(await f.queries.readShopping());
  if (initial.kind !== 'current') assert.fail();
  await f.act({
    kind: 'setPurchased',
    groupKey: initial.snapshot.groups[0]!.groupKey,
    purchased: true,
  });
  const before = ready(await f.queries.readShopping());
  if (before.kind !== 'current') assert.fail();
  const state = f.write.database.prepare('SELECT * FROM state_revision').all(),
    calls = f.faults.calls;
  f.faults.oversizedShare = true;
  const after = ready(await f.queries.readShopping());
  if (after.kind !== 'current') assert.fail();
  assert.deepEqual(after.share, { kind: 'unavailable', reason: 'too_large' });
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(after.notices, before.notices);
  assert.deepEqual(after.selected, before.selected);
  assert.equal(f.faults.calls - calls, 1);
  assert.deepEqual(f.write.database.prepare('SELECT * FROM state_revision').all(), state);
});

test('adoption or owner changes cannot return a sharing snapshot from a retired query', async (t) => {
  for (const boundary of ['owner', 'adoption'] as const)
    await t.test(boundary, async (t) => {
      const f = await fixture(t);
      await f.adopt('first');
      const id = await f.plan(1);
      await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
      if (boundary === 'owner') f.faults.onHash = () => f.setAccess(null);
      else
        f.faults.beforeContent = () =>
          f.write.database.exec('UPDATE app_content_adoption SET revision=revision+1');
      const result = await f.queries.readShopping();
      failed(result);
      assert.equal(Object.hasOwn(result, 'value'), false);
    });
});

test('schema7, foreign owner and replaced installation are denied before content reads', async (t) => {
  const old = await fixture(t, 7);
  failed(await old.queries.readShopping());
  failed(await old.queries.readFavourites());
  assert.equal(old.faults.calls, 0);
  const f = await fixture(t);
  f.bind(randomUUID(), 1);
  failed(await f.queries.readShopping(), 'content.workspace_access_changed');
  assert.equal(f.faults.calls, 0);
  const rebound = f.create();
  f.write.database
    .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
    .run(randomUUID());
  failed(await rebound.readShopping(), 'content.workspace_access_changed');
  assert.equal(f.faults.calls, 0);
});

test('owner loss during hash or after reserved callback suppresses private results', async (t) => {
  const f = await fixture(t);
  await f.plan(1, catalogue.recipes[0]!.recipeId);
  f.faults.onHash = () => f.setAccess(null);
  failed(await f.queries.readPlan('2026-10-01', '2026-10-07'), 'content.workspace_access_changed');
  f.bind(null, 0);
  f.faults.afterContent = () => f.queries.close();
  failed(await f.queries.readPlan('2026-10-01', '2026-10-07'), 'content.workspace_access_changed');
});

test('adoption, restore and store changes between captures reject even metadata fallback', async (t) => {
  for (const mutation of ['adoption', 'restore', 'store'] as const) {
    const f = await fixture(t);
    await f.adopt('first');
    await f.plan(1);
    f.faults.beforeContent = () => {
      if (mutation === 'adoption')
        f.write.database.exec('UPDATE app_content_adoption SET revision=revision+1');
      else if (mutation === 'restore')
        f.write.database
          .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
          .run();
      else
        f.write.database.exec(
          "UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
        );
    };
    failed(await f.queries.readPlan('2026-10-01', '2026-10-07'), 'content.workspace_changed');
  }
});

test('projection corruption and mismatched pin metadata fail rather than returning partial or fallback groups', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  f.write.database.prepare('UPDATE shopping_contribution SET raw_measure=?').run('invented');
  failed(await f.queries.readShopping());
  f.write.database.exec('PRAGMA foreign_keys=OFF');
  f.write.database.prepare('UPDATE plan_content_pin SET content_fingerprint=?').run('f'.repeat(64));
  failed(await f.queries.readPlan('2026-10-01', '2026-10-07'));
});

test('oversized SQL values and corrupt store clocks fail before their raw strings materialize', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.plan(1);
  let oversized = false;
  const originalAll = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await originalAll<Row>(sql, values);
    if (
      rows.some((row) =>
        Object.values(row).some((value) => typeof value === 'string' && value.length > 4096),
      )
    )
      oversized = true;
    return rows;
  };
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  f.write.database
    .prepare('UPDATE plan_occurrence SET meal_key=?')
    .run('dinner\0' + 'x'.repeat(1024 * 1024));
  failed(await f.queries.readPlan('2026-10-01', '2026-10-07'));
  assert.equal(oversized, false);
  f.write.database.prepare("UPDATE plan_occurrence SET meal_key='dinner'").run();
  f.write.database
    .prepare("UPDATE state_revision SET revision=? WHERE collection='store'")
    .run('x'.repeat(1024 * 1024));
  failed(await f.queries.readShopping());
  assert.equal(oversized, false);
});

test('oversized Plan ranges reject before occurrence or pin rows are loaded', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.plan(1);
  const occurrence = f.write.database.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)');
  const pin = f.write.database.prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)');
  f.write.database.exec('BEGIN');
  try {
    for (let index = 1; index <= 1000; index++) {
      const id = randomUUID();
      const date = new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10);
      occurrence.run(id, authoredId, date, 'dinner', at, at);
      pin.run(
        id,
        authoredId,
        f.first.revision.ref.revisionId,
        f.first.revision.ref.contentFingerprint,
      );
    }
    f.write.database.exec('COMMIT');
  } catch (error) {
    f.write.database.exec('ROLLBACK');
    throw error;
  }
  let rawPins = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    if (sql.startsWith('SELECT s.occurrence_id') && sql.includes('FROM plan_content_pin'))
      rawPins = true;
    return all<Row>(sql, values);
  };
  const calls = f.faults.calls;
  failed(await f.queries.readPlan('2026-10-01', '2029-12-31'), 'content.workspace_range_too_large');
  assert.equal(rawPins, false);
  assert.equal(f.faults.calls, calls);
});

test('invalid snapshot and invalid range are errors, while a genuinely empty workspace stays empty', async (t) => {
  const f = await fixture(t);
  const empty = ready(await f.queries.readShopping());
  assert.equal(empty.kind, 'current');
  if (empty.kind !== 'current') assert.fail();
  assert.deepEqual(empty.snapshot.groups, []);
  failed(await f.queries.readPlan('2026-02-30', '2026-10-01'), 'plan.invalid_range');
  await f.adopt('first');
  await f.plan(1);
  f.faults.invalidSnapshot = true;
  failed(await f.queries.readPlan('2026-10-01', '2026-10-07'), 'content.workspace_stored_invalid');
});

test('actual8 authored favourites follow identity across revisions without creating Plan/content pins', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  assert.equal(
    f.write.database.prepare('SELECT 1 FROM recipe_identity WHERE recipe_id=?').get(authoredId),
    undefined,
  );
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
  const first = ready(await f.queries.readFavourites());
  assert.equal(first.length, 1);
  const initial = first[0]!;
  assert.equal(initial.favourite.revision, 1);
  assert.equal(initial.content.kind, 'readable');
  if (initial.content.kind !== 'readable') assert.fail();
  assert.deepEqual(initial.content.contentRef, f.first.revision.ref);
  assert.equal(initial.content.title, f.first.revision.document.recipe.title);
  assert.deepEqual(
    initial.content.ingredientNames,
    f.first.revision.document.recipe.ingredients.map((value) => value.rawName),
  );
  assert.equal(initial.content.photoNeedsReview, false);
  assert.ok(Object.isFrozen(initial.content.contentRef));
  const row = f.write.database.prepare('SELECT * FROM favourite').get();
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
  assert.deepEqual(f.write.database.prepare('SELECT * FROM favourite').get(), row);
  await f.adopt('second');
  const updated = ready(await f.create().readFavourites())[0]!;
  assert.deepEqual(updated.favourite, initial.favourite);
  assert.equal(updated.content.kind, 'readable');
  if (updated.content.kind !== 'readable') assert.fail();
  assert.deepEqual(updated.content.contentRef, f.second.revision.ref);
  assert.equal(f.write.database.prepare('SELECT COUNT(*) n FROM plan_content_pin').get()!.n, 0);
  assert.equal(
    f.write.database
      .prepare('SELECT COUNT(*) n FROM recipe_content_revision WHERE recipe_id=?')
      .get(authoredId)!.n,
    0,
  );
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: false });
  assert.deepEqual(ready(await f.queries.readFavourites()), []);
  assert.equal(f.write.database.prepare('SELECT saved FROM favourite').get()!.saved, 0);
});

test('archived favourites remain exactly readable and removable, but cannot be newly saved', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.adopt('second');
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
  await f.adopt('archive');
  const entry = ready(await f.queries.readFavourites())[0]!;
  assert.equal(entry.content.kind, 'readable');
  if (entry.content.kind !== 'readable') assert.fail();
  assert.equal(entry.content.state, 'archived');
  assert.deepEqual(entry.content.contentRef, f.second.revision.ref);
  failed(
    await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: true }),
    'content.current_recipe_unavailable',
  );
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: false });
  assert.deepEqual(ready(await f.queries.readFavourites()), []);
});

test('withdrawn favourite unsave ignores unrelated selected or malformed Plan sidecars while preserving them', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.adopt('second');
  const id = await f.plan(1);
  await f.act({ kind: 'setShoppingSelection', occurrenceIds: [id] });
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
  await f.adopt('withdraw');
  assert.deepEqual(ready(await f.queries.readFavourites())[0]!.content, {
    kind: 'unavailable',
    reason: 'withdrawn',
  });
  f.write.database.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
  f.write.database
    .prepare('UPDATE plan_content_pin SET content_fingerprint=?')
    .run('malformed-unrelated');
  f.write.database.exec('PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF');
  const before = f.write.database.prepare('SELECT * FROM plan_content_pin').all();
  failed(
    await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: true }),
    'content.current_recipe_unavailable',
  );
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: false });
  assert.deepEqual(ready(await f.queries.readFavourites()), []);
  assert.deepEqual(f.write.database.prepare('SELECT * FROM plan_content_pin').all(), before);
  assert.equal(f.write.database.prepare('SELECT COUNT(*) n FROM shopping_selection').get()!.n, 1);
});

test('favourite delivery unavailability exposes identity only and does not mutate saved rows', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
  f.faults.unavailable = true;
  const before = f.write.database.prepare('SELECT * FROM favourite').all();
  const entry = ready(await f.queries.readFavourites())[0]!;
  assert.equal(entry.favourite.recipeId, authoredId);
  assert.deepEqual(entry.content, { kind: 'unavailable', reason: 'delivery_unavailable' });
  assert.deepEqual(f.write.database.prepare('SELECT * FROM favourite').all(), before);
});

test('bundled favourite projection preserves the supplied photo concern and unknown saved identity stays body-free', async (t) => {
  const f = await fixture(t),
    id = '53389';
  await f.act({ kind: 'setFavourite', recipeId: id, saved: true });
  const first = ready(await f.queries.readFavourites())[0]!;
  assert.equal(first.content.kind, 'readable');
  if (first.content.kind !== 'readable') assert.fail();
  assert.equal(first.content.photoNeedsReview, true);
  assert.equal(first.content.title, catalogue.getRecipe(id)!.title);
  f.write.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(authoredId);
  f.write.database.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(authoredId, at, at);
  const unavailable = ready(await f.queries.readFavourites()).find(
    (entry) => entry.favourite.recipeId === authoredId,
  )!;
  assert.deepEqual(unavailable.content, { kind: 'unavailable', reason: 'exact_unavailable' });
});

test('favourite query denies stale owner, adoption and store fences including delivery fallback', async (t) => {
  for (const kind of ['owner', 'adoption', 'store'] as const) {
    const f = await fixture(t);
    await f.adopt('first');
    await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
    f.faults.beforeContent = () => {
      if (kind === 'owner') f.setAccess(null);
      else if (kind === 'adoption')
        f.write.database.exec('UPDATE app_content_adoption SET revision=revision+1');
      else
        f.write.database.exec(
          "UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
        );
    };
    failed(
      await f.queries.readFavourites(),
      kind === 'owner' ? 'content.workspace_access_changed' : 'content.workspace_changed',
    );
  }
});

test('malformed and oversized favourite rows fail before raw values hydrate and cannot be repaired by a save', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  await f.act({ kind: 'setFavourite', recipeId: authoredId, saved: true });
  let oversized = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, values);
    if (
      rows.some((row) =>
        Object.values(row).some((value) => typeof value === 'string' && value.length > 4096),
      )
    )
      oversized = true;
    return rows;
  };
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  f.write.database.prepare('UPDATE favourite SET saved_at=?').run('x'.repeat(1024 * 1024));
  failed(await f.queries.readFavourites());
  failed(
    await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: false }),
  );
  assert.equal(oversized, false);
  f.write.database.prepare('UPDATE favourite SET saved_at=?').run('invalid-date');
  failed(await f.queries.readFavourites());
  failed(
    await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: false }),
  );
  f.write.database.prepare('UPDATE favourite SET saved_at=?,updated_at=?').run(at, 'invalid-date');
  failed(await f.queries.readFavourites());
  failed(
    await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: true }),
  );
  failed(
    await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: false }),
  );
  assert.equal(
    f.write.database.prepare('SELECT updated_at FROM favourite').get()!.updated_at,
    'invalid-date',
  );
  f.write.database.prepare('UPDATE favourite SET updated_at=?').run(at);
  f.write.database.prepare('UPDATE favourite SET saved_at=?,saved=2').run(at);
  failed(await f.queries.readFavourites());
});

test('embedded-NUL favourite identity is rejected before row hydration even with a matching SQL identity', async (t) => {
  const f = await fixture(t),
    id = '52819\0x';
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  f.write.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(id);
  f.write.database.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(id, at, at);
  let copied = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    if (sql.startsWith('SELECT recipe_id recipeId')) copied = true;
    return all<Row>(sql, values);
  };
  failed(await f.queries.readFavourites());
  failed(
    await f.commands.reviewDirect({
      kind: 'setFavourite',
      recipeId: catalogue.recipes[0]!.recipeId,
      saved: true,
    }),
  );
  assert.equal(copied, false);
  assert.equal(f.write.database.prepare('SELECT saved FROM favourite').get()!.saved, 1);
});

test('favourite count admission prevents unbounded reads and rolls back an overflowing new favourite', async (t) => {
  const f = await fixture(t);
  await f.adopt('first');
  f.write.database.exec('BEGIN');
  for (let index = 0; index < 10_000; index++) {
    const id = String(800000000 + index);
    f.write.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(id);
    f.write.database.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(id, at, at);
  }
  f.write.database.exec('COMMIT');
  const command = ready(
    await f.commands.prepareDirect(
      ready(
        await f.commands.reviewDirect({ kind: 'setFavourite', recipeId: authoredId, saved: true }),
      ),
    ),
  );
  failed(await f.commands.execute(command));
  assert.equal(f.write.database.prepare('SELECT COUNT(*) n FROM favourite').get()!.n, 10_000);
  assert.equal(
    f.write.database.prepare('SELECT 1 FROM recipe_identity WHERE recipe_id=?').get(authoredId),
    undefined,
  );
  assert.deepEqual(ready(await f.queries.readFavourites()), []);
  f.write.database
    .prepare('INSERT INTO favourite VALUES (?,1,1,?,?)')
    .run(catalogue.recipes[0]!.recipeId, at, at);
  let payload = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    if (sql.startsWith('SELECT recipe_id recipeId')) payload = true;
    return all<Row>(sql, values);
  };
  failed(await f.queries.readFavourites());
  assert.equal(payload, false);
});
