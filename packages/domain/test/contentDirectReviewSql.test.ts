import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import {
  createBundledContentSnapshot,
  createBundledRecipeRevision,
  verifySignedContentOverlay,
  type ContentOverlayManifest,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import type { DirectActionInput, DirectActionReview, Immutable, RepositoryResult } from '../src';
import { createDirectActionReviewer } from '../../../apps/mobile/src/data/directActionReview';
import {
  createContentCommandContext,
  type ContentCommandContext,
} from '../../../apps/mobile/src/data/contentCommandContext';
import { retainVerifiedRevisionsInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import {
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from '../../../apps/mobile/src/data/shoppingRepository';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { member, published, signed } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z',
  recipeId = '900000009';
const placement = (day: number) => ({ actualDate: `2026-10-0${day}`, mealKey: 'dinner' as const });
function ready(result: RepositoryResult<Immutable<DirectActionReview>>) {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: RepositoryResult<Immutable<DirectActionReview>>, message?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (result.kind !== 'failed') assert.fail();
  if (message) assert.equal(result.error.messageKey, message);
}
// Controlled core-verifier ports; these review tests make no signature/native claims.
async function contentFixture() {
  const baseline = await createBundledContentSnapshot(sha256),
    document = authoredFixture(recipeId);
  if (document.kind !== 'authored') throw new Error('fixture');
  document.recipe.ingredients = [{ position: 1, rawName: 'Salt', rawMeasure: '100g' }];
  const first = await published(document, 'review-first');
  document.provenance.basedOn = clone(first.revision.ref);
  document.recipe.ingredients[0]!.rawMeasure = '200g';
  const second = await published(document, 'review-second');
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>(),
    publications = new Map<string, PublishedRecipeRevision>();
  let snapshot: EffectiveContentSnapshot,
    head: OverlayHead | null = null;
  async function issue(mode: 'first' | 'second' | 'archive' | 'withdraw') {
    const publication = mode === 'first' ? first : second,
      sequence = (head?.sequence ?? 0) + 1;
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `review-release-${sequence}`,
      sequence,
      previous: head,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries: [
        mode === 'withdraw'
          ? { state: 'withdrawn', recipeId, reason: 'Fixture withdrawn' }
          : mode === 'archive'
            ? {
                state: 'archived',
                ref: clone(second.revision.ref),
                publicationFingerprint: second.publicationFingerprint,
                reason: 'Fixture archived',
              }
            : member(publication),
      ],
    };
    const envelope = await signed(manifest);
    snapshot = await verifySignedContentOverlay(envelope, {
      sha256,
      baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
      expectedCurrent: head,
      minimumSequence: head?.sequence ?? 0,
      readerVersion: 1,
      publications: mode === 'first' || mode === 'second' ? [publication] : [],
      retainedRefs: [...publications.values()].map((item) => item.revision.ref),
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
        async readPublication(id, revisionId) {
          return publications.get(`${id}|${revisionId}`) ?? null;
        },
      },
    });
    head = { releaseId: manifest.releaseId, sequence, fingerprint: envelope.fingerprint };
    releases.set(manifest.releaseId, { manifest, fingerprint: envelope.fingerprint });
    if (mode === 'first' || mode === 'second')
      publications.set(`${recipeId}|${publication.revision.ref.revisionId}`, publication);
  }
  await issue('first');
  await issue('second');
  return {
    first,
    second,
    issue,
    get snapshot() {
      return snapshot;
    },
    get head() {
      return head!;
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-review-')),
    path = join(directory, 'cooking.db'),
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
    },
    firstId = randomUUID(),
    secondId = randomUUID(),
    bundledId = randomUUID();
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
  const content = await contentFixture(),
    bundled = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  let active: boolean = true,
    returnFalse = false,
    afterHash: (() => void) | undefined,
    context: ContentCommandContext;
  async function refresh() {
    const head = content.head;
    write.database
      .prepare('UPDATE app_content_adoption SET revision=?,head_json=?')
      .run(head.sequence, JSON.stringify(head));
    context = await createContentCommandContext({
      view: {
        head,
        latestHead: head,
        snapshot: content.snapshot,
        hasWithdrawal: content.snapshot.entries.some((item) => item.state === 'withdrawn'),
        assertActive() {
          if (returnFalse) return false as unknown as undefined;
          assert.ok(active, 'Fixture expired reservation');
          return undefined;
        },
        async readPhoto() {
          throw new Error('unused');
        },
      },
      expectedAdoptionRevision: head.sequence,
      sha256: async (text) => {
        const result = await sha256(text);
        const hook = afterHash;
        afterHash = undefined;
        hook?.();
        return result;
      },
    });
  }
  await refresh();
  await writer.transaction(async (session) => {
    await retainVerifiedRevisionsInSnapshot(
      session,
      content.snapshot,
      [content.first.revision.ref, content.second.revision.ref],
      sha256,
    );
    for (const [id, day, ref] of [
      [firstId, 1, content.first.revision.ref],
      [secondId, 2, content.second.revision.ref],
    ] as const) {
      write.database
        .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
        .run(id, recipeId, placement(day).actualDate, 'dinner', at, at);
      write.database
        .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
        .run(id, recipeId, ref.revisionId, ref.contentFingerprint);
    }
    write.database
      .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
      .run(bundledId, bundled.ref.recipeId, placement(5).actualDate, 'dinner', at, at);
    write.database
      .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
      .run(bundledId, bundled.ref.recipeId, bundled.ref.revisionId, bundled.ref.contentFingerprint);
    const entered = await context.enter(session),
      before = await readShoppingLedgerInSnapshot(entered, await context.projection(entered));
    write.database
      .prepare('INSERT INTO shopping_selection VALUES (?,?)')
      .run(ids.shoppingScopeId, firstId);
    await rebuildShoppingInSnapshot(entered, before, await context.projection(entered));
    write.database.exec('UPDATE purchase_state SET purchased=1,changed=0');
  });
  const options = {
    catalogue: catalogueBoundary,
    readRecipe: catalogue.getRecipe,
    sha256,
    platform: { newId: randomUUID },
  };
  const reviewer = (selected = context) => createDirectActionReviewer(reader, options, selected);
  const review = (input: DirectActionInput) => reviewer()(input);
  const shopping = () =>
    reader.transaction(
      async (raw) => {
        const session = await context.enter(raw);
        return (await readShoppingLedgerInSnapshot(session, await context.projection(session)))
          .snapshot;
      },
      { kind: 'read_only' },
    );
  const changes = () => [
    write.database.prepare('SELECT total_changes() n').get()!.n,
    read.database.prepare('SELECT total_changes() n').get()!.n,
  ];
  return {
    db: write.database,
    reader,
    writer,
    firstId,
    secondId,
    bundledId,
    content,
    review,
    reviewer,
    shopping,
    changes,
    get context() {
      return context;
    },
    setActive(value: boolean) {
      active = value;
    },
    falseGuard() {
      returnFalse = true;
    },
    expireDuringHash() {
      afterHash = () => {
        active = false;
      };
    },
    async next(mode: 'archive' | 'withdraw') {
      await content.issue(mode);
      await refresh();
    },
  };
}

test('selection review resolves newly selected saved pins separately from current selection and predicts actual mixed demand', async (t) => {
  const f = await fixture(t),
    before = f.changes();
  const same = ready(await f.review({ kind: 'setShoppingSelection', occurrenceIds: [f.firstId] }));
  if (same.consequences.kind !== 'shopping_selection') assert.fail();
  assert.equal(same.consequences.shoppingEffects.unchanged[0]!.after!.quantityLabel, '100 g');
  assert.equal(same.consequences.shoppingEffects.unchanged[0]!.after!.purchased, true);
  const mixed = ready(
    await f.review({ kind: 'setShoppingSelection', occurrenceIds: [f.firstId, f.secondId] }),
  );
  if (mixed.consequences.kind !== 'shopping_selection') assert.fail();
  const changed = mixed.consequences.shoppingEffects.demandChanged[0]!;
  assert.equal(changed.before!.quantityLabel, '100 g');
  assert.equal(changed.after!.quantityLabel, '300 g');
  assert.equal(changed.after!.purchased, false);
  assert.equal(mixed.consequences.shoppingEffects.checkedMarksRequiringReview, 1);
  assert.deepEqual(
    f.changes(),
    before,
    'review never writes source retention, selection, marks or receipts',
  );
  await f.writer.transaction(async (raw) => {
    const session = await f.context.enter(raw),
      ledger = await readShoppingLedgerInSnapshot(session, await f.context.projection(session));
    f.db
      .prepare('INSERT INTO shopping_selection SELECT scope_id,? FROM shopping_scope')
      .run(f.secondId);
    await rebuildShoppingInSnapshot(session, ledger, await f.context.projection(session));
  });
  const actual = (await f.shopping()).groups[0]!;
  assert.deepEqual(changed.after, {
    quantityLabel: actual.quantityLabel,
    purchased: actual.purchased,
    changed: actual.changed,
  });
});

test('purchase reviews retain the exact demand fingerprint and never preview the newest recipe for an older pin', async (t) => {
  const f = await fixture(t),
    group = (await f.shopping()).groups[0]!,
    before = f.changes();
  const review = ready(
    await f.review({ kind: 'setPurchased', groupKey: group.groupKey, purchased: false }),
  );
  if (review.payload.kind !== 'setPurchased' || review.consequences.kind !== 'purchase')
    assert.fail();
  assert.equal(review.payload.expectedDemandFingerprint, group.demandFingerprint);
  assert.equal(review.consequences.quantityLabel, '100 g');
  assert.deepEqual(f.changes(), before);
});

test('archived saved Plan and mixed Shopping reviews remain exact while new or different archived targets are denied', async (t) => {
  const f = await fixture(t);
  await f.next('archive');
  const before = f.changes();
  for (const input of [
    { kind: 'placeRecipe', occurrenceId: f.firstId, recipeId, placement: placement(3) },
    { kind: 'placeRecipe', recipeId, placement: placement(1) },
    { kind: 'removePlan', occurrenceId: f.firstId },
    { kind: 'setShoppingSelection', occurrenceIds: [f.firstId, f.secondId] },
  ] as const)
    ready(await f.review(input));
  failed(
    await f.review({ kind: 'placeRecipe', recipeId, placement: placement(4) }),
    'content.current_recipe_unavailable',
  );
  failed(
    await f.review({
      kind: 'placeRecipe',
      occurrenceId: f.bundledId,
      recipeId,
      placement: placement(5),
    }),
    'content.current_recipe_unavailable',
  );
  // A known bundled target is current, and review must not retain a replacement or rewrite pins.
  ready(
    await f.review({
      kind: 'placeRecipe',
      occurrenceId: f.firstId,
      recipeId: catalogue.recipes[0]!.recipeId,
      placement: placement(1),
    }),
  );
  assert.equal(
    f.db.prepare('SELECT recipe_id FROM plan_occurrence WHERE occurrence_id=?').get(f.firstId)!
      .recipe_id,
    recipeId,
  );
  assert.deepEqual(f.changes(), before);
});

test('missing exact pins and withdrawn demand fail closed without fallback or review writes', async (t) => {
  for (const mode of ['missing', 'withdrawn'] as const) {
    const f = await fixture(t);
    if (mode === 'withdrawn') await f.next('withdraw');
    else {
      f.db.exec('PRAGMA foreign_keys=OFF');
      f.db
        .prepare('UPDATE plan_content_pin SET revision_id=? WHERE occurrence_id=?')
        .run('missing-exact', f.secondId);
      f.db.exec('PRAGMA foreign_keys=ON');
    }
    const before = f.changes();
    failed(
      await f.review({ kind: 'setShoppingSelection', occurrenceIds: [f.firstId, f.secondId] }),
    );
    failed(
      await f.review({
        kind: 'placeRecipe',
        occurrenceId: f.secondId,
        recipeId,
        placement: placement(3),
      }),
    );
    assert.deepEqual(f.changes(), before);
  }
});

test('unselected withdrawn meals can be reviewed for removal or movement without exposing demand or permitting new selection', async (t) => {
  const f = await fixture(t);
  await f.writer.transaction(async (raw) => {
    const session = await f.context.enter(raw),
      ledger = await readShoppingLedgerInSnapshot(session, await f.context.projection(session));
    f.db.exec('DELETE FROM shopping_selection; UPDATE shopping_scope SET revision=revision+1');
    await rebuildShoppingInSnapshot(session, ledger, await f.context.projection(session));
  });
  await f.next('withdraw');
  const before = f.changes();
  for (const input of [
    { kind: 'removePlan', occurrenceId: f.firstId },
    { kind: 'placeRecipe', occurrenceId: f.firstId, recipeId, placement: placement(3) },
    { kind: 'placeRecipe', occurrenceId: f.firstId, recipeId, placement: placement(2) },
  ] as const) {
    const review = ready(await f.review(input));
    assert.equal(JSON.stringify(review).includes('100g'), false);
    assert.equal(JSON.stringify(review).includes('Stir gently'), false);
  }
  failed(
    await f.review({ kind: 'placeRecipe', recipeId, placement: placement(4) }),
    'content.current_recipe_unavailable',
  );
  failed(await f.review({ kind: 'setShoppingSelection', occurrenceIds: [f.firstId] }));
  assert.deepEqual(f.changes(), before);
});

test('stale adoption, expired or falsely acknowledged reservation and expiry during hashing revoke review', async (t) => {
  for (const mode of ['stale', 'expired', 'false', 'hash'] as const) {
    const f = await fixture(t),
      review = f.reviewer();
    if (mode === 'stale') await f.next('archive');
    if (mode === 'expired') f.setActive(false);
    if (mode === 'false') f.falseGuard();
    if (mode === 'hash') f.expireDuringHash();
    const before = f.changes();
    failed(await review({ kind: 'setShoppingSelection', occurrenceIds: [f.firstId, f.secondId] }));
    assert.deepEqual(f.changes(), before);
  }
});

test('selection limits reject before reading or serializing an oversized proposed occurrence list', async (t) => {
  const f = await fixture(t),
    before = f.changes();
  const ids = new Array<string>(1001).fill(f.firstId);
  Object.defineProperty(ids, 'toJSON', {
    value() {
      throw new Error('must not serialize oversized proposal');
    },
  });
  failed(
    await f.review({ kind: 'setShoppingSelection', occurrenceIds: ids }),
    'shopping.invalid_selection',
  );
  await assert.rejects(
    f.reader.transaction(
      (session) => f.context.projectionForOccurrences(session, new Array(1001)),
      { kind: 'read_only' },
    ),
    /Command content evidence/,
  );
  assert.deepEqual(f.changes(), before);
});

test('short selection lists reject oversized or duplicate IDs before cloning or entering SQL', async (t) => {
  const f = await fixture(t),
    before = f.changes();
  let sqlAttempts = 0;
  f.reader.transaction = async () => {
    sqlAttempts++;
    throw new Error('invalid input must not enter SQL');
  };
  for (const ids of [['x'.repeat(2 * 1024 * 1024)], [f.firstId, f.firstId]]) {
    Object.defineProperty(ids, 'toJSON', {
      value() {
        throw new Error('invalid IDs must not be cloned');
      },
    });
    failed(
      await f.review({ kind: 'setShoppingSelection', occurrenceIds: ids }),
      'shopping.invalid_selection',
    );
  }
  assert.equal(sqlAttempts, 0);
  assert.deepEqual(f.changes(), before);
});
