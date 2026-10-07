import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { cookingContentIdentity } from '../src';
import {
  canonicalContentJson,
  createBundledContentSnapshot,
  verifySignedContentOverlay,
  type ContentOverlayManifest,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import {
  createContentAdoptionService,
  type ContentAdoptionAccess,
  type ContentAdoptionReview,
} from '../../../apps/mobile/src/data/contentAdoption';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from '../../../apps/mobile/src/data/shoppingRepository';
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
  recipe = catalogue.recipes[0]!;
// Controlled, core-verified content ports; real content reservations/signatures/media are tested separately.
async function contentFixture() {
  const baseline = await createBundledContentSnapshot(sha256),
    base = baseline.revisions.find((item) => item.ref.recipeId === recipe.recipeId)!;
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>(),
    publications = new Map<string, PublishedRecipeRevision>(),
    snapshots = new Map<string, EffectiveContentSnapshot>();
  let latest: OverlayHead | null = null,
    latestSnapshot: EffectiveContentSnapshot | null = null,
    active = false;
  const document = authoredFixture(recipe.recipeId);
  if (document.kind !== 'authored') throw new Error('fixture');
  document.provenance.basedOn = clone(base.ref);
  document.recipe.ingredients = [
    { position: 1, rawName: 'Salt', rawMeasure: '100g' },
    { position: 2, rawName: 'Oil', rawMeasure: '1 tbsp' },
  ];
  let current = await published(document, 'fixture-authored-1');
  async function issue(mode: 'title' | 'quantity' | 'withdraw' | 'archived' | 'first' = 'title') {
    const sequence = (latest?.sequence ?? 0) + 1;
    if (mode !== 'first' && mode !== 'withdraw' && mode !== 'archived') {
      const next = clone(current.revision.document);
      if (next.kind !== 'authored') throw new Error('fixture');
      next.provenance.basedOn = clone(current.revision.ref);
      if (mode === 'quantity') next.recipe.ingredients[0]!.rawMeasure = '200g';
      else next.recipe.title += ` updated ${sequence}`;
      current = await published(next, `fixture-authored-${sequence}`);
    }
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `fixture-adoption-${sequence}`,
      sequence,
      previous: latest,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries:
        mode === 'withdraw'
          ? [{ state: 'withdrawn', recipeId: recipe.recipeId, reason: 'Fixture withdrawal' }]
          : mode === 'archived'
            ? [
                {
                  state: 'archived',
                  ref: clone(current.revision.ref),
                  publicationFingerprint: current.publicationFingerprint,
                  reason: 'Fixture archived',
                },
              ]
            : [member(current)],
    };
    const envelope = await signed(manifest);
    const snapshot = await verifySignedContentOverlay(envelope, {
      sha256,
      baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
      expectedCurrent: latest,
      minimumSequence: latest?.sequence ?? 0,
      readerVersion: 1,
      publications: mode === 'withdraw' || mode === 'archived' ? [] : [current],
      retainedRefs: [base.ref, ...[...publications.values()].map((item) => item.revision.ref)],
      trustVerifier: {
        async verify(value) {
          return (
            value.keyId === 'fixture-key' && value.signature === 'synthetic_signature_no_crypto'
          );
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
    latest = { releaseId: manifest.releaseId, sequence, fingerprint: envelope.fingerprint };
    latestSnapshot = snapshot;
    releases.set(manifest.releaseId, { manifest, fingerprint: envelope.fingerprint });
    snapshots.set(manifest.releaseId, snapshot);
    if (mode !== 'withdraw' && mode !== 'archived')
      publications.set(
        `${current.revision.ref.recipeId}|${current.revision.ref.revisionId}`,
        current,
      );
    return { ...latest };
  }
  await issue('first');
  const port: Parameters<typeof createContentAdoptionService>[0]['contentStore'] = {
    async withVerifiedAdoption(input, work) {
      assert.equal(active, false, 'no content-store reentry');
      assert.equal(
        canonicalContentJson(input.candidateHead),
        canonicalContentJson(latest),
        'candidate head must remain latest',
      );
      assert.ok(latestSnapshot);
      const previous = input.previousHead ? snapshots.get(input.previousHead.releaseId) : null;
      if (input.previousHead) assert.ok(previous);
      const withdrawnRefs = [];
      for (const ref of input.retainedRefs) {
        const result = latestSnapshot.lookupExact(ref);
        if (result.kind === 'readable') continue;
        assert.equal(result.kind, 'withdrawn');
        assert.ok(
          input.preserveWithdrawnRefs?.some(
            (value) => canonicalContentJson(value) === canonicalContentJson(ref),
          ),
          'selected or unreviewed withdrawal denied',
        );
        assert.ok(
          input.previousRefs.some(
            (value) => canonicalContentJson(value) === canonicalContentJson(ref),
          ),
        );
        assert.ok(
          previous?.lookupExact(ref).kind === 'readable' ||
            baseline.revisions.some(
              (value) => canonicalContentJson(value.ref) === canonicalContentJson(ref),
            ),
          'prior exact evidence required',
        );
        withdrawnRefs.push(ref);
      }
      active = true;
      try {
        return await work({
          previous: previous ?? null,
          candidate: latestSnapshot,
          head: { ...latest! },
          withdrawnRefs,
        });
      } finally {
        active = false;
      }
    },
  };
  return {
    base,
    port,
    issue,
    get head() {
      return { ...latest! };
    },
    get ref() {
      return current.revision.ref;
    },
    get active() {
      return active;
    },
  };
}
async function fixture(t: TestContext, history = false, schemaVersion: 7 | 8 = 7) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-adoption-')),
    path = join(directory, 'cooking.db');
  const write = desktopConnection(path),
    read = desktopConnection(path);
  const readQueries: string[] = [];
  for (const { connection } of [read, write]) {
    const readAll = connection.all;
    connection.all = <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      readQueries.push(sql);
      return readAll<Row>(sql, values);
    };
  }
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
  const occurrence = randomUUID();
  await writer.transaction(async (session) => {
    const options = { readRecipe: catalogue.getRecipe, sha256 },
      before = await readShoppingLedgerInSnapshot(session, options);
    write.database
      .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
      .run(occurrence, recipe.recipeId, '2026-10-01', 'dinner', at, at);
    write.database
      .prepare('INSERT INTO shopping_selection VALUES (?,?)')
      .run(ids.shoppingScopeId, occurrence);
    await rebuildShoppingInSnapshot(session, before, options);
  });
  if (history) {
    const event = {
      ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
      eventId: randomUUID(),
      recipeTitle: recipe.title,
      photoKey: recipe.photoKey,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      recordedAt: at,
      note: 'Retained history',
      historyEpoch: 0,
      revision: 1,
    };
    write.database
      .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
      .run(
        event.eventId,
        event.cookedOn,
        at,
        'a'.repeat(64),
        JSON.stringify({ kind: 'saved', event, closedSession: null }, null, 2),
      );
  }
  await migrateCookingContentDatabase(writer, { sha256 });
  if (schemaVersion === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const content = await contentFixture();
  let live: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 },
    failReceipt = false,
    loseAck = false,
    requireReservation = false,
    afterHash: (() => void) | null = null;
  const originalPrepare = write.connection.prepare,
    originalExec = write.connection.exec;
  write.connection.prepare = async (sql) => {
    if (failReceipt && sql.startsWith('INSERT INTO content_adoption_operation')) {
      failReceipt = false;
      throw new Error('fixture receipt write failure');
    }
    return originalPrepare(sql);
  };
  write.connection.exec = async (sql) => {
    if (requireReservation && sql === 'BEGIN IMMEDIATE')
      assert.equal(content.active, true, 'content reservation precedes cooking write');
    await originalExec(sql);
    if (loseAck && sql === 'COMMIT') {
      loseAck = false;
      throw new Error('fixture lost commit acknowledgement');
    }
  };
  const options: Parameters<typeof createContentAdoptionService>[0] = {
    ...(schemaVersion === 8 ? { cookingSchemaVersion: schemaVersion } : {}),
    reader,
    writer,
    contentStore: content.port,
    sha256: async (text) => {
      const result = await sha256(text);
      afterHash?.();
      afterHash = null;
      return result;
    },
    now: () => at,
    newId: randomUUID,
    getAccess: () => live,
    assertAccess: (scope) => {
      assert.deepEqual(live, scope, 'live scope changed');
      return undefined;
    },
  };
  const service = createContentAdoptionService(options);
  return {
    db: write.database,
    writer,
    reader,
    readQueries,
    ids,
    occurrence,
    content,
    service,
    options,
    setAccess(value: ContentAdoptionAccess | null) {
      live = value;
    },
    failReceipt() {
      failReceipt = true;
    },
    loseAck() {
      loseAck = true;
    },
    enforceReservation() {
      requireReservation = true;
    },
    changeDuringHash(callback: () => void) {
      afterHash = callback;
    },
  };
}
function state(db: ReturnType<typeof desktopConnection>['database']) {
  return [
    'app_content_adoption',
    'plan_occurrence',
    'plan_content_pin',
    'shopping_scope',
    'shopping_selection',
    'shopping_group',
    'shopping_contribution',
    'purchase_state',
    'state_revision',
    'content_adoption_operation',
    'cooking_session_content_pin',
    'local_history_content_pin',
    'imported_history_content_pin',
    'account_history_content_pin',
  ].map((table) => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }));
}
async function changeReview(f: Awaited<ReturnType<typeof fixture>>, expected = f.content.base.ref) {
  return f.service.review({
    candidateHead: f.content.head,
    changes: [{ occurrenceId: f.occurrence, expectedRef: expected, targetRef: f.content.ref }],
  });
}

function seedChoiceMeals(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const ref = f.content.base.ref;
  for (let index = 1; index < count; index++) {
    const id = randomUUID();
    f.db
      .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
      .run(
        id,
        recipe.recipeId,
        `2026-11-${String(Math.floor((index - 1) / 3) + 1).padStart(2, '0')}`,
        ['breakfast', 'lunch', 'dinner'][(index - 1) % 3]!,
        at,
        at,
      );
    f.db
      .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
      .run(id, ref.recipeId, ref.revisionId, ref.contentFingerprint);
  }
}

test('schema8 read-only meal choices are paged20 with exact original and proposed titles and one shared context', async (t) => {
  const f = await fixture(t, false, 8);
  seedChoiceMeals(f, 41);
  const before = state(f.db);
  const first = await f.service.readMealChoices({ candidateHead: f.content.head });
  assert.equal(first.total, 41);
  assert.equal(first.items.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.items[0]!.current));
  assert.equal(first.items[0]!.current.title, recipe.title);
  assert.deepEqual(first.items[0]!.current.contentRef, f.content.base.ref);
  assert.deepEqual(first.items[0]!.target?.contentRef, f.content.ref);
  const second = await f.service.readMealChoices({
    candidateHead: f.content.head,
    offset: 20,
    expectedContextFingerprint: first.contextFingerprint,
  });
  const last = await f.service.readMealChoices({
    candidateHead: f.content.head,
    offset: 40,
    expectedContextFingerprint: first.contextFingerprint,
  });
  assert.equal(second.items.length, 20);
  assert.equal(last.items.length, 1);
  assert.equal(last.nextOffset, null);
  assert.equal(
    new Set(
      [...first.items, ...second.items, ...last.items].map((item) => item.occurrence.occurrenceId),
    ).size,
    41,
  );
  assert.deepEqual(state(f.db), before);
  await assert.rejects(f.service.readMealChoices({ candidateHead: f.content.head, offset: 20 }), {
    code: 'invalid_input',
  });
});

test('same-head saved meal selection generates real Shopping consequences and commits only the reviewed exact change', async (t) => {
  const f = await fixture(t, false, 8);
  await f.service.adopt(await changeReview(f));
  const saved = f.content.ref;
  await f.content.issue('quantity');
  await f.service.adopt(await f.service.review({ candidateHead: f.content.head }));
  const page = await f.service.readMealChoices({ candidateHead: f.content.head });
  const item = page.items[0]!;
  assert.deepEqual(item.current.contentRef, saved);
  assert.deepEqual(item.target?.contentRef, f.content.ref);
  const review = await f.service.review(
    {
      candidateHead: page.candidateHead,
      changes: [
        {
          occurrenceId: item.occurrence.occurrenceId,
          expectedRef: item.current.contentRef,
          targetRef: item.target!.contentRef,
        },
      ],
    },
    page.contextFingerprint,
  );
  assert.deepEqual(review.previousHead, review.candidateHead);
  assert.ok(review.shopping.groups.some((group) => group.previousQuantity !== group.quantity));
  const receipt = await f.service.adopt(review);
  assert.equal(receipt.changedOccurrences, 1);
  assert.deepEqual(
    {
      ...f.db
        .prepare(
          'SELECT recipe_id,revision_id,content_fingerprint FROM plan_content_pin WHERE occurrence_id=?',
        )
        .get(f.occurrence),
    },
    {
      recipe_id: f.content.ref.recipeId,
      revision_id: f.content.ref.revisionId,
      content_fingerprint: f.content.ref.contentFingerprint,
    },
  );
  const after = await f.service.readMealChoices({ candidateHead: f.content.head });
  assert.equal(after.items[0]!.target, null);
});

test('meal page and review fences reject date-only changes even without a global clock advance', async (t) => {
  const f = await fixture(t, false, 8);
  seedChoiceMeals(f, 21);
  const page = await f.service.readMealChoices({ candidateHead: f.content.head });
  f.db
    .prepare('UPDATE plan_occurrence SET local_date=? WHERE occurrence_id=?')
    .run('2026-10-02', f.occurrence);
  const before = state(f.db);
  await assert.rejects(
    f.service.readMealChoices({
      candidateHead: page.candidateHead,
      offset: 20,
      expectedContextFingerprint: page.contextFingerprint,
    }),
    { code: 'review_changed' },
  );
  await assert.rejects(
    f.service.review(
      {
        candidateHead: page.candidateHead,
        changes: [
          { occurrenceId: f.occurrence, expectedRef: f.content.base.ref, targetRef: f.content.ref },
        ],
      },
      page.contextFingerprint,
    ),
    { code: 'review_changed' },
  );
  assert.deepEqual(state(f.db), before);
});

test('queued meal choices recapture before returning and never label changed Plan state current', async (t) => {
  const f = await fixture(t, false, 8);
  const service = createContentAdoptionService({
    ...f.options,
    contentStore: {
      withVerifiedAdoption: async (input, work) => {
        f.db
          .prepare('UPDATE plan_occurrence SET local_date=? WHERE occurrence_id=?')
          .run('2026-10-03', f.occurrence);
        return f.content.port.withVerifiedAdoption(input, work);
      },
    },
  });
  await assert.rejects(service.readMealChoices({ candidateHead: f.content.head }), {
    code: 'review_changed',
  });
});

test('withdrawn meal choices hide prior title and archived candidates never become update targets', async (t) => {
  const f = await fixture(t, false, 8);
  await f.service.adopt(await changeReview(f));
  await f.content.issue('archived');
  const archived = await f.service.readMealChoices({ candidateHead: f.content.head });
  assert.equal(archived.items[0]!.current.state, 'readable');
  assert.equal(archived.items[0]!.target, null);
  await f.content.issue('withdraw');
  const before = state(f.db);
  const withdrawn = await f.service.readMealChoices({ candidateHead: f.content.head });
  assert.equal(withdrawn.items[0]!.current.title, null);
  assert.equal(withdrawn.items[0]!.current.state, 'unavailable');
  assert.equal(withdrawn.items[0]!.target, null);
  assert.deepEqual(state(f.db), before);
});

test('meal choices reject owner retirement while hashing and malformed page boundaries', async (t) => {
  const f = await fixture(t, false, 8);
  for (const offset of [-1, 1, 20_020])
    await assert.rejects(f.service.readMealChoices({ candidateHead: f.content.head, offset }), {
      code: 'invalid_input',
    });
  f.changeDuringHash(() => f.setAccess(null));
  await assert.rejects(f.service.readMealChoices({ candidateHead: f.content.head }));
  assert.equal(
    f.db.prepare('SELECT COUNT(*) count FROM content_adoption_operation').get()!.count,
    0,
  );
});

test('default adoption retains exact plan demand, placement, selection and purchase bytes; only cooking receipt proves adoption', async (t) => {
  const f = await fixture(t);
  f.db.exec('UPDATE purchase_state SET purchased=1');
  const before = state(f.db),
    review = await f.service.review({ candidateHead: f.content.head });
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.shopping));
  assert.equal(review.changes.length, 0);
  assert.equal(review.shopping.rebuilt, false);
  f.enforceReservation();
  const receipt = await f.service.adopt(review);
  assert.equal(receipt.status, 'adopted_in_cooking_store');
  assert.equal(receipt.changedOccurrences, 0);
  for (const item of before.filter(
    (item) =>
      !['app_content_adoption', 'content_adoption_operation', 'state_revision'].includes(
        item.table,
      ),
  ))
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${item.table}`).all(), item.rows, item.table);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) count FROM content_adoption_operation').get()!.count,
    1,
  );
  assert.deepEqual(await f.service.adopt(review), receipt);
  assert.deepEqual(
    await f.service.recover({
      operationId: review.operationId,
      requestFingerprint: review.requestFingerprint,
      installationId: review.installationId,
      ownerId: review.ownerId,
    }),
    receipt,
  );
});

test('explicit same-recipe revision adoption retains unchanged purchase demand and clears only changed quantities', async (t) => {
  const f = await fixture(t);
  await f.service.adopt(await changeReview(f));
  const first = f.content.ref;
  f.db.exec(
    'UPDATE purchase_state SET purchased=1,changed=0 WHERE group_key IN (SELECT group_key FROM shopping_group WHERE projection_revision=(SELECT projection_revision FROM shopping_scope))',
  );
  await f.content.issue('title');
  const titleReview = await changeReview(f, first);
  assert.ok(
    titleReview.shopping.groups
      .filter((row) => row.quantity !== null)
      .every((row) => row.purchased),
  );
  const titleReceipt = await f.service.adopt(titleReview);
  assert.equal(titleReceipt.shoppingRebuilt, true);
  const second = f.content.ref;
  await f.content.issue('quantity');
  const quantityReview = await changeReview(f, second),
    salt = quantityReview.shopping.groups.find((row) => row.displayName === 'Salt')!,
    oil = quantityReview.shopping.groups.find((row) => row.displayName === 'Oil')!;
  assert.equal(salt.quantity, '200 g');
  assert.equal(salt.purchased, false);
  assert.equal(oil.purchased, true);
  await f.service.adopt(quantityReview);
  const live = f.db
    .prepare(
      'SELECT g.display_name name,p.purchased FROM shopping_group g JOIN purchase_state p USING(scope_id,group_key) WHERE g.projection_revision=(SELECT projection_revision FROM shopping_scope)',
    )
    .all() as { name: string; purchased: number }[];
  assert.equal(live.find((row) => row.name === 'Salt')!.purchased, 0);
  assert.equal(live.find((row) => row.name === 'Oil')!.purchased, 1);
  const row = f.db
    .prepare('SELECT * FROM plan_occurrence WHERE occurrence_id=?')
    .get(f.occurrence)!;
  assert.equal(row.recipe_id, recipe.recipeId);
  assert.equal(row.local_date, '2026-10-01');
  assert.equal(row.meal_key, 'dinner');
  assert.equal(row.revision, 4);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('cloned reviews and stale store, pins, scope, restore epoch and content head cannot commit', async (t) => {
  for (const mode of ['clone', 'store', 'pin', 'orphan', 'scope', 'restore', 'head'] as const) {
    const f = await fixture(t),
      review = await changeReview(f);
    if (mode === 'store')
      f.db.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='store'");
    if (mode === 'pin') {
      // Simulate a separately changed pin without allowing this corruption through a normal writer.
      f.db.exec('PRAGMA foreign_keys=OFF');
      f.db.prepare('UPDATE plan_content_pin SET content_fingerprint=?').run('e'.repeat(64));
      f.db.exec('PRAGMA foreign_keys=ON');
    }
    if (mode === 'orphan') {
      f.db.exec('PRAGMA foreign_keys=OFF');
      const ref = f.content.base.ref;
      f.db
        .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
        .run(randomUUID(), ref.recipeId, ref.revisionId, ref.contentFingerprint);
      f.db.exec('PRAGMA foreign_keys=ON');
    }
    if (mode === 'scope') f.db.exec('UPDATE shopping_scope SET revision=revision+1');
    if (mode === 'restore')
      f.db
        .prepare('INSERT INTO app_metadata VALUES (?,?)')
        .run('account-replication:apply-epoch', '1');
    if (mode === 'head') await f.content.issue('title');
    const before = state(f.db);
    await assert.rejects(
      f.service.adopt(mode === 'clone' ? (clone(review) as ContentAdoptionReview) : review),
    );
    assert.deepEqual(state(f.db), before);
  }
});

test('orphan session and history pins are rejected before reference capture in review and commit', async (t) => {
  for (const mode of ['session', 'local', 'imported', 'account', 'cleared', 'cancelled'] as const) {
    const f = await fixture(t),
      eventId = randomUUID(),
      ownerId = randomUUID();
    if (mode === 'account') {
      f.db
        .prepare('INSERT INTO app_metadata VALUES (?,?)')
        .run('account-replication:owner', JSON.stringify({ schemaVersion: 1, ownerId }));
      f.setAccess({ ownerId, authGeneration: 1 });
    }
    const review = await changeReview(f),
      ref = f.content.base.ref;
    const table =
      mode === 'session'
        ? 'cooking_session_content_pin'
        : mode === 'imported'
          ? 'imported_history_content_pin'
          : mode === 'account'
            ? 'account_history_content_pin'
            : 'local_history_content_pin';
    // Model damaged on-disk relations; normal application writes retain FK enforcement.
    f.db.exec('PRAGMA foreign_keys=OFF');
    if (mode === 'cleared' || mode === 'cancelled')
      f.db
        .prepare('INSERT INTO cooking_event VALUES (?,0,?,NULL,NULL,NULL,NULL)')
        .run(eventId, mode);
    if (mode === 'account')
      f.db
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,NULL)`)
        .run(ownerId, eventId, ref.recipeId, ref.revisionId, ref.contentFingerprint);
    else
      f.db
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,NULL)`)
        .run(eventId, ref.recipeId, ref.revisionId, ref.contentFingerprint);
    f.db.exec('PRAGMA foreign_keys=ON');
    const before = state(f.db);
    for (const attempt of [
      () => f.service.review({ candidateHead: f.content.head }),
      () => f.service.adopt(review),
    ]) {
      f.readQueries.length = 0;
      await assert.rejects(
        attempt(),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error.code === 'stored_data_invalid' || error.code === 'storage_failure'),
        mode,
      );
      assert.ok(
        f.readQueries.some((sql) => sql.startsWith(`SELECT 1 FROM ${table} s `)),
        `${mode}: parent/pin admission must run before invalid refs are read`,
      );
      assert.equal(
        f.readQueries.some((sql) => sql.startsWith(`SELECT * FROM ${table}`)),
        false,
        `${mode}: invalid refs must not be materialized`,
      );
      assert.deepEqual(state(f.db), before, mode);
    }
  }
});

test('sign-out, owner changes and same-owner generation changes revoke review and recovery access', async (t) => {
  const f = await fixture(t),
    review = await changeReview(f),
    before = state(f.db);
  for (const scope of [
    null,
    { ownerId: randomUUID(), authGeneration: 2 },
    { ownerId: null, authGeneration: 2 },
  ]) {
    f.setAccess(scope);
    await assert.rejects(f.service.adopt(review));
    assert.deepEqual(state(f.db), before);
  }
  f.setAccess({ ownerId: null, authGeneration: 1 });
  const receipt = await f.service.adopt(review);
  const recovery = {
    installationId: receipt.installationId,
    ownerId: receipt.ownerId,
    operationId: receipt.operationId,
    requestFingerprint: receipt.requestFingerprint,
  };
  f.setAccess(null);
  await assert.rejects(f.service.recover(recovery), { code: 'access_changed' });
  f.setAccess({ ownerId: null, authGeneration: 2 });
  assert.deepEqual(await f.service.recover(recovery), receipt);
  await assert.rejects(f.service.adopt(review), { code: 'access_changed' });
});

test('midwrite failure rolls back head, pins, demand, purchases and receipt together', async (t) => {
  const f = await fixture(t),
    review = await changeReview(f),
    before = state(f.db);
  f.failReceipt();
  await assert.rejects(f.service.adopt(review), /receipt write failure/);
  assert.deepEqual(state(f.db), before);
  assert.equal((await f.service.adopt(review)).changedOccurrences, 1);
});

test('lost commit acknowledgement recovers the owner-bound durable receipt once without further writes', async (t) => {
  const f = await fixture(t),
    review = await changeReview(f);
  f.loseAck();
  await assert.rejects(f.service.adopt(review), /lost commit acknowledgement/);
  const committed = state(f.db);
  await f.content.issue('title');
  const receipt = await f.service.recover({
    installationId: review.installationId,
    ownerId: review.ownerId,
    operationId: review.operationId,
    requestFingerprint: review.requestFingerprint,
  });
  assert.ok(receipt);
  assert.equal(receipt.changedOccurrences, 1);
  assert.deepEqual(await f.service.adopt(review), receipt);
  assert.deepEqual(state(f.db), committed);
  await assert.rejects(
    f.service.recover({
      installationId: review.installationId,
      ownerId: review.ownerId,
      operationId: review.operationId,
      requestFingerprint: 'f'.repeat(64),
    }),
  );
});

test('historical or archived revisions cannot masquerade as candidate current content and withdrawal cannot be bypassed', async (t) => {
  for (const mode of ['historical', 'archived', 'withdraw'] as const) {
    const f = await fixture(t),
      first = f.content.ref;
    await f.content.issue(mode === 'historical' ? 'title' : mode);
    const before = state(f.db);
    await assert.rejects(
      f.service.review(
        mode === 'withdraw'
          ? { candidateHead: f.content.head }
          : {
              candidateHead: f.content.head,
              changes: [
                { occurrenceId: f.occurrence, expectedRef: f.content.base.ref, targetRef: first },
              ],
            },
      ),
    );
    assert.deepEqual(state(f.db), before);
  }
});

test('access changes during awaited hashing reject before any adoption receipt is committed', async (t) => {
  const f = await fixture(t),
    review = await changeReview(f),
    before = state(f.db);
  f.changeDuringHash(() => f.setAccess(null));
  await assert.rejects(f.service.adopt(review));
  assert.deepEqual(state(f.db), before);
});

test('withdrawal adoption preserves exact historical and unselected plan identities without exposing a body', async (t) => {
  for (const historyOnly of [false, true]) {
    const f = await fixture(t, true);
    await f.service.adopt(await f.service.review({ candidateHead: f.content.head }));
    f.db.exec(
      'DELETE FROM shopping_contribution; DELETE FROM shopping_selection; UPDATE purchase_state SET purchased=0,changed=1,revision=revision+1; UPDATE shopping_scope SET projection_revision=projection_revision+1,revision=revision+1;',
    );
    if (historyOnly) f.db.exec('DELETE FROM plan_occurrence');
    f.db.exec(
      "UPDATE state_revision SET revision=revision+1 WHERE collection IN ('store','shopping','plan')",
    );
    const history = f.db.prepare('SELECT * FROM cooking_event').all(),
      pins = f.db.prepare('SELECT * FROM local_history_content_pin').all(),
      plans = f.db.prepare('SELECT * FROM plan_content_pin').all();
    await f.content.issue('withdraw');
    const review = await f.service.review({ candidateHead: f.content.head });
    assert.deepEqual(review.withdrawnRefs, [f.content.base.ref]);
    assert.equal(review.shopping.selectedOccurrences, 0);
    assert.equal(JSON.stringify(review).includes(recipe.instructions[0]!.rawText), false);
    await f.service.adopt(review);
    assert.deepEqual(f.db.prepare('SELECT * FROM cooking_event').all(), history);
    assert.deepEqual(f.db.prepare('SELECT * FROM local_history_content_pin').all(), pins);
    assert.deepEqual(f.db.prepare('SELECT * FROM plan_content_pin').all(), plans);
    assert.equal(
      JSON.parse(
        f.db.prepare('SELECT head_json FROM app_content_adoption').get()!.head_json as string,
      ).releaseId,
      f.content.head.releaseId,
    );
  }
});

test('schema8 adoption is explicit and exact: default7 and mismatched8 hosts cannot read or write adoption', async (t) => {
  for (const schemaVersion of [7, 8] as const) {
    const f = await fixture(t, false, schemaVersion),
      before = state(f.db);
    const mismatchOptions = { ...f.options };
    delete mismatchOptions.cookingSchemaVersion;
    if (schemaVersion === 7) mismatchOptions.cookingSchemaVersion = 8;
    const mismatch = createContentAdoptionService(mismatchOptions);
    await assert.rejects(mismatch.review({ candidateHead: f.content.head }), {
      code: 'stored_data_invalid',
    });
    await assert.rejects(
      mismatch.recover({
        installationId: f.ids.installationId,
        ownerId: null,
        operationId: randomUUID(),
        requestFingerprint: 'a'.repeat(64),
      }),
      { code: 'stored_data_invalid' },
    );
    assert.deepEqual(state(f.db), before);
  }
});

test('schema8 reviewed updates preserve exact history and unchanged purchases through archive adoption', async (t) => {
  const f = await fixture(t, true, 8);
  const history = f.db.prepare('SELECT * FROM cooking_event').all();
  const historyPins = f.db.prepare('SELECT * FROM local_history_content_pin').all();
  f.enforceReservation();
  await f.service.adopt(await changeReview(f));
  const first = f.content.ref;
  f.db.exec(
    'UPDATE purchase_state SET purchased=1,changed=0 WHERE group_key IN (SELECT group_key FROM shopping_group WHERE projection_revision=(SELECT projection_revision FROM shopping_scope))',
  );
  await f.content.issue('quantity');
  const review = await changeReview(f, first);
  assert.equal(review.shopping.groups.find((row) => row.displayName === 'Salt')!.purchased, false);
  assert.equal(review.shopping.groups.find((row) => row.displayName === 'Oil')!.purchased, true);
  const receipt = await f.service.adopt(review);
  assert.equal(receipt.changedOccurrences, 1);
  const plans = f.db.prepare('SELECT * FROM plan_content_pin').all();
  const purchases = f.db.prepare('SELECT * FROM purchase_state').all();
  await f.content.issue('archived');
  const archiveReview = await f.service.review({ candidateHead: f.content.head });
  assert.equal(archiveReview.changes.length, 0);
  assert.equal(archiveReview.shopping.rebuilt, false);
  await f.service.adopt(archiveReview);
  assert.deepEqual(f.db.prepare('SELECT * FROM cooking_event').all(), history);
  assert.deepEqual(f.db.prepare('SELECT * FROM local_history_content_pin').all(), historyPins);
  assert.deepEqual(f.db.prepare('SELECT * FROM plan_content_pin').all(), plans);
  assert.deepEqual(f.db.prepare('SELECT * FROM purchase_state').all(), purchases);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('schema8 adoption retains atomic rollback, stale-owner rejection and lost-ack recovery', async (t) => {
  const f = await fixture(t, false, 8),
    review = await changeReview(f),
    before = state(f.db);
  f.setAccess({ ownerId: null, authGeneration: 2 });
  await assert.rejects(f.service.adopt(review), { code: 'access_changed' });
  assert.deepEqual(state(f.db), before);
  f.setAccess({ ownerId: null, authGeneration: 1 });
  f.failReceipt();
  await assert.rejects(f.service.adopt(review), /receipt write failure/);
  assert.deepEqual(state(f.db), before);
  f.loseAck();
  await assert.rejects(f.service.adopt(review), /lost commit acknowledgement/);
  const committed = state(f.db);
  await f.content.issue('title');
  const recovered = await f.service.recover({
    installationId: review.installationId,
    ownerId: review.ownerId,
    operationId: review.operationId,
    requestFingerprint: review.requestFingerprint,
  });
  assert.equal(recovered?.changedOccurrences, 1);
  assert.deepEqual(await f.service.adopt(review), recovered);
  assert.deepEqual(state(f.db), committed);
  f.setAccess(null);
  await assert.rejects(
    f.service.recover({
      installationId: review.installationId,
      ownerId: review.ownerId,
      operationId: review.operationId,
      requestFingerprint: review.requestFingerprint,
    }),
    { code: 'access_changed' },
  );
});

test('a schema7 review cannot survive a real7-to8 migration; explicit8 host can recover earlier receipts', async (t) => {
  const f = await fixture(t),
    firstReview = await changeReview(f);
  const firstReceipt = await f.service.adopt(firstReview);
  await f.content.issue('title');
  const pending = await f.service.review({ candidateHead: f.content.head });
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const before = state(f.db);
  await assert.rejects(f.service.adopt(pending), { code: 'stored_data_invalid' });
  assert.deepEqual(state(f.db), before);
  const current = createContentAdoptionService({ ...f.options, cookingSchemaVersion: 8 });
  assert.deepEqual(
    await current.recover({
      installationId: firstReceipt.installationId,
      ownerId: firstReceipt.ownerId,
      operationId: firstReceipt.operationId,
      requestFingerprint: firstReceipt.requestFingerprint,
    }),
    firstReceipt,
  );
  assert.deepEqual(state(f.db), before);
  assert.equal(
    (await current.adopt(await current.review({ candidateHead: f.content.head }))).status,
    'adopted_in_cooking_store',
  );
});
