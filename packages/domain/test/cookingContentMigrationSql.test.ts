import type {} from '@fastify/multipart';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
} from '@cookmate/account-sync';
import {
  createBundledContentSnapshot,
  createRecipeContentRevision,
  verifySignedContentOverlay,
  type OverlayEntry,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { cookingContentIdentity, type CookingHistoryEntry, type CookingSession } from '../src';
import { createContentOverlaySigner } from '../../../apps/admin/src/publishing/signer';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  readAdoptionInSnapshot,
  readHistoryContentPins,
  readPlanContentPins,
  readSessionContentPin,
  retainVerifiedRevisionsInSnapshot,
  retainCookingRevisionInSnapshot,
} from '../../../apps/mobile/src/data/cookingContentRepository';
import {
  CONTENT_REBUILT_TABLES,
  verifyCookingContentSchema,
} from '../../../apps/mobile/src/data/cookingContentSchema';
import {
  ACCOUNT_BINDING_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { authoredFixture } from '../../catalogue/test/content-fixtures';
import { member, published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const at = '2026-10-01T12:00:00.000Z',
  fingerprint = 'a'.repeat(64);
const recipe = catalogue.recipes[0]!;
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t: TestContext, personalOnly = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-migration-'));
  const path = join(directory, 'cooking.db');
  const handles: SerializedWriter[] = [];
  async function open() {
    const handle = desktopConnection(path);
    await configureConnection(handle.connection);
    const writer = new SerializedWriter(handle.connection);
    handles.push(writer);
    return { ...handle, writer };
  }
  const store = await open();
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    store.writer,
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
      ...(!personalOnly ? { enableAccountHistory: true } : {}),
    },
  );
  t.after(async () => {
    for (const handle of handles) await handle.close();
    await removeFixtureDirectory(directory);
  });
  return { ...store, ids, open };
}
async function entry(overrides: Partial<CookingHistoryEntry> = {}): Promise<CookingHistoryEntry> {
  return {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Original private note\nwith unicode 🍲',
    historyEpoch: 0,
    revision: 1,
    ...overrides,
  };
}
function addLocal(
  db: ReturnType<typeof desktopConnection>['database'],
  value: CookingHistoryEntry,
) {
  const receipt = JSON.stringify({ kind: 'saved', event: value, closedSession: null }, null, 2);
  db.prepare("INSERT INTO cooking_event VALUES (?,?,'saved',?,?,?,?)").run(
    value.eventId,
    value.historyEpoch,
    value.cookedOn,
    value.recordedAt,
    fingerprint,
    receipt,
  );
  return receipt;
}
function legacySnapshot(db: ReturnType<typeof desktopConnection>['database']) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return tables.map(({ name }) => ({
    name,
    columns: (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
      (row) => row.name,
    ),
    rows: db.prepare(`SELECT * FROM ${name}`).all(),
  }));
}
function assertLegacyUnchanged(
  db: ReturnType<typeof desktopConnection>['database'],
  before: ReturnType<typeof legacySnapshot>,
) {
  for (const { name, columns, rows } of before)
    assert.deepEqual(db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all(), rows, name);
}
async function populated(t: TestContext) {
  const f = await fixture(t),
    db = f.database,
    id = recipe.recipeId;
  const occurrence = randomUUID(),
    collection = randomUUID(),
    reference = randomUUID(),
    message = randomUUID();
  db.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(id, at, at);
  db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
    occurrence,
    id,
    '2026-10-01',
    'dinner',
    at,
    at,
  );
  db.prepare('INSERT INTO shopping_selection VALUES (?,?)').run(f.ids.shoppingScopeId, occurrence);
  db.prepare('INSERT INTO shopping_group VALUES (?,?,?,?,1,?,?)').run(
    f.ids.shoppingScopeId,
    'fixture-group',
    'fixture-version',
    fingerprint,
    'Original demand',
    'Original quantity',
  );
  const ingredient = recipe.ingredients[0]!;
  db.prepare(
    "INSERT INTO shopping_contribution VALUES (?,?,?,'ingredient','1',1,NULL,?,?,?,?)",
  ).run(
    f.ids.shoppingScopeId,
    occurrence,
    id,
    'fixture-group',
    ingredient.rawName,
    ingredient.rawMeasure,
    '{ "kind": "unknown" }',
  );
  db.prepare('INSERT INTO purchase_state VALUES (?,?,?,1,0,1)').run(
    f.ids.shoppingScopeId,
    'fixture-group',
    fingerprint,
  );
  db.prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)').run(
    randomUUID(),
    id,
    JSON.stringify('Personal note\u0000🍲'),
    at,
    at,
  );
  db.prepare('INSERT INTO personal_collection VALUES (?,?,0,1,?,?)').run(
    collection,
    JSON.stringify('Saved set'),
    at,
    at,
  );
  db.prepare('INSERT INTO personal_collection_member VALUES (?,?,1,1,?)').run(collection, id, at);
  db.prepare("INSERT INTO message VALUES (?,?,0,0,'assistant',?,'complete',?)").run(
    message,
    f.ids.conversationId,
    JSON.stringify('Visible saved message'),
    at,
  );
  db.prepare('INSERT INTO reference_set VALUES (?,?,0)').run(reference, message);
  db.prepare('INSERT INTO reference_item VALUES (?,0,?)').run(reference, id);
  const session: CookingSession = {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
    sessionId: randomUUID(),
    revision: 1,
    passageSequence: 1,
    state: 'active',
    updatedAt: at,
    lastOperationId: randomUUID(),
  };
  db.prepare('INSERT INTO cooking_session VALUES (?,?,1,?,?,?,?,?)').run(
    id,
    session.sessionId,
    session.state,
    at,
    session.lastOperationId,
    fingerprint,
    JSON.stringify(session, null, 2),
  );
  const local = await entry();
  const receipt = addLocal(db, local);
  const imported = await entry({ origin: 'backup' }),
    restore = randomUUID();
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    restore,
    fingerprint,
    '{ "fixture": "original import" }',
    '{}',
    '{ "fixture": "original receipt" }',
  );
  db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
    imported.eventId,
    randomUUID(),
    restore,
    imported.cookedOn,
    imported.recordedAt,
    JSON.stringify(imported, null, 2),
  );
  const account = await entry();
  const { historyEpoch: _epoch, revision: _revision, ...wire } = account;
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId: owner }),
  );
  db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
    owner,
    wire.eventId,
    JSON.stringify(wire),
  );
  db.prepare('INSERT INTO cooking_history_clear VALUES (?,?)').run(
    randomUUID(),
    '{ "fixture": "unchanged clear receipt" }',
  );
  return { ...f, occurrence, collection, reference, session, local, imported, account, receipt };
}

test('schema six migration preserves every legacy row, source locator, selection, demand and receipt byte', async (t) => {
  const f = await populated(t),
    before = legacySnapshot(f.database);
  assert.equal(await migrateCookingContentDatabase(f.writer, { sha256 }), 'migrated');
  assertLegacyUnchanged(f.database, before);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    (f.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
    1,
  );
  await f.writer.transaction(async (session) => {
    await verifyCookingContentSchema(session);
    const plans = await readPlanContentPins(session);
    assert.equal(plans.items.length, 1);
    assert.equal(plans.items[0]!.occurrenceId, f.occurrence);
    assert.equal(
      (await readSessionContentPin(session, recipe.recipeId, { sha256 }))!.pin.kind,
      'exact',
    );
    for (const source of ['local', 'backup', 'account'] as const) {
      const result = await readHistoryContentPins(session, {
        sha256,
        source,
        ...(source === 'account' ? { ownerId: owner } : {}),
      });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.pin.kind, 'exact');
    }
    assert.deepEqual(await readAdoptionInSnapshot(session), { revision: 0, head: null });
    assert.ok(Object.isFrozen(plans.items[0]!.ref));
  });
  assert.equal(
    (
      f.database
        .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
        .get(f.local.eventId) as { receipt_json: string }
    ).receipt_json,
    f.receipt,
  );
  await f.writer.close();
  const reopened = await f.open();
  assert.equal(await migrateCookingContentDatabase(reopened.writer, { sha256 }), 'existing');
  assertLegacyUnchanged(reopened.database, before);
});

test('schema six migration waits for original pending account work and preserves acknowledged bytes', async (t) => {
  for (const version of [1, 2] as const) {
    const f = await populated(t);
    const core = emptyAccountSnapshot(catalogue.identity, {
      appPreferences: { theme: 'system', motion: 'system', locale: 'en' },
      profile: { displayName: null },
    });
    const snapshot =
      version === 1
        ? core
        : {
            ...core,
            schemaVersion: 2 as const,
            personal: { notes: [], collections: [], memberships: [], manualItems: [] },
          };
    const scope = { version: 2 as const, approvalDigest: fingerprint, historyIncluded: false };
    const operationId = randomUUID();
    const journal = {
      schemaVersion: version,
      ...(version === 2 ? { scope } : {}),
      ownerId: owner,
      revision: 1,
      base: null,
      observed: { revision: 0, snapshotDigest: null, updatedAt: null },
      lastApply: null,
      pending: {
        operationId,
        mode: 'push',
        capturedLocal: { storeRevision: 0, snapshot, ...(version === 2 ? { scope } : {}) },
        remote: {
          ownerId: owner,
          revision: 0,
          snapshot: null,
          updatedAt: null,
          deletionOperationId: null,
        },
        proposed: snapshot,
        proposedDigest: await sha256(canonicalAccountSnapshot(snapshot)),
        acknowledgement:
          version === 2 ? { ownerId: owner, operationId, revision: 1, committedAt: at } : null,
      },
    };
    const bytes = JSON.stringify(journal, null, 2);
    f.database.prepare('INSERT INTO app_metadata VALUES (?,?)').run(journalKey(owner), bytes);
    const before = legacySnapshot(f.database);
    await assert.rejects(
      migrateCookingContentDatabase(f.writer, { sha256 }),
      (error) => error instanceof AccountReplicationError && error.reason === 'operation_pending',
    );
    assertLegacyUnchanged(f.database, before);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name='recipe_content_revision'")
        .get()!.count,
      0,
    );
    assert.equal(
      f.database.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(owner))!
        .value,
      bytes,
    );
    // Fixture simulates settlement by the original repository; migration never settles it.
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(JSON.stringify({ ...journal, pending: null }, null, 2), journalKey(owner));
    const settled = legacySnapshot(f.database);
    assert.equal(await migrateCookingContentDatabase(f.writer, { sha256 }), 'migrated');
    assertLegacyUnchanged(f.database, settled);
  }
});

test('historical catalogue/content/unknown identities stay explicitly unresolved, including old epochs', async (t) => {
  const f = await fixture(t);
  const values = [
    await entry({ catalogue: { ...catalogue.identity, fingerprint: 'f'.repeat(64) } }),
    await entry({ contentFingerprint: 'e'.repeat(64), historyEpoch: 7 }),
    await entry({ recipeId: '987654321' }),
  ];
  for (const value of values) addLocal(f.database, value);
  await migrateCookingContentDatabase(f.writer, { sha256 });
  const result = await f.writer.transaction((session) =>
    readHistoryContentPins(session, { sha256, source: 'local' }),
  );
  const reasons = new Map(result.items.map((item) => [item.eventId, item.pin]));
  assert.deepEqual(
    values.map((value) => reasons.get(value.eventId)),
    [
      { kind: 'unresolved', reason: 'catalogue_mismatch' },
      { kind: 'unresolved', reason: 'content_mismatch' },
      { kind: 'unresolved', reason: 'recipe_unavailable' },
    ],
  );
  assert.equal(
    (
      f.database
        .prepare('SELECT COUNT(*) count FROM recipe_content_revision WHERE recipe_id=?')
        .get('987654321') as { count: number }
    ).count,
    0,
  );
});

test('actual source text and locator corruption block migration despite unchanged catalogue manifest', async (t) => {
  for (const sql of [
    "UPDATE instruction_passage SET raw_text=raw_text||' changed' WHERE rowid=(SELECT MIN(rowid) FROM instruction_passage)",
    'UPDATE ingredient_entry SET source_row=source_row+1 WHERE rowid=(SELECT MIN(rowid) FROM ingredient_entry)',
  ]) {
    const f = await fixture(t);
    f.database.exec(sql);
    const before = legacySnapshot(f.database);
    await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256 }));
    assertLegacyUnchanged(f.database, before);
    assert.equal(
      (f.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      6,
    );
    assert.equal(
      f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='recipe_identity'").get(),
      undefined,
    );
  }
});

test('DDL failure rolls back all rebuilt children and leaves schema six usable with foreign keys enabled', async (t) => {
  const f = await populated(t),
    before = legacySnapshot(f.database),
    original = f.connection.exec;
  let injected = false;
  f.connection.exec = async (sql) => {
    if (sql.startsWith('CREATE TABLE shopping_contribution')) {
      injected = true;
      throw new Error('fixture DDL interruption');
    }
    await original(sql);
  };
  await assert.rejects(
    migrateCookingContentDatabase(f.writer, { sha256 }),
    /fixture DDL interruption/,
  );
  assert.equal(injected, true);
  assertLegacyUnchanged(f.database, before);
  assert.equal(
    (f.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    6,
  );
  assert.deepEqual(f.database.prepare('SELECT name FROM sqlite_temp_master').all(), []);
  f.connection.exec = original;
  assert.equal(await migrateCookingContentDatabase(f.writer, { sha256 }), 'migrated');
});

test('malformed or oversized persisted history and foreign account rows fail the whole migration', async (t) => {
  for (const mode of ['malformed', 'oversized', 'foreign'] as const) {
    const f = await fixture(t),
      value = await entry();
    if (mode === 'foreign') {
      const { historyEpoch: _epoch, revision: _revision, ...wire } = value;
      f.database
        .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
        .run(owner, value.eventId, JSON.stringify(wire));
    } else {
      addLocal(f.database, value);
      f.database.exec('PRAGMA ignore_check_constraints=ON');
      f.database
        .prepare('UPDATE cooking_event SET receipt_json=?')
        .run(mode === 'malformed' ? '{}' : JSON.stringify({ text: 'x'.repeat(33000) }));
      f.database.exec('PRAGMA ignore_check_constraints=OFF');
    }
    const before = legacySnapshot(f.database);
    await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256 }));
    assertLegacyUnchanged(f.database, before);
    assert.equal(
      (f.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      6,
    );
  }
});

async function signedSnapshot(document = authoredFixture(), entries?: OverlayEntry[]) {
  const baseline = await createBundledContentSnapshot(sha256),
    publication = await published(document);
  const pair = generateKeyPairSync('ed25519');
  const signer = createContentOverlaySigner({ keyId: 'fixture-pins', privateKey: pair.privateKey });
  const envelope = await signer.signManifest({
    formatVersion: 2,
    releaseId: 'fixture-pins-release',
    sequence: 1,
    previous: null,
    createdAt: at,
    minimumReaderVersion: 1,
    baseline: { ...catalogue.identity },
    entries: entries ?? [member(publication)],
  });
  const snapshot = await verifySignedContentOverlay(envelope, {
    sha256,
    baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
    publications: entries ? [] : [publication],
    expectedCurrent: null,
    minimumSequence: 0,
    readerVersion: 1,
    trustVerifier: createContentTrustVerifier([
      {
        keyId: 'fixture-pins',
        publicKeyHex: Buffer.from(
          pair.publicKey.export({ format: 'jwk' }).x!,
          'base64url',
        ).toString('hex'),
      },
    ]),
    // The migration consumes host-verified media facts. Actual media bytes are covered by contentReleaseStoreSql.
    mediaVerifier: {
      async verify() {
        return true;
      },
    },
    archive: {
      async readRelease() {
        return null;
      },
      async readPublication() {
        return null;
      },
    },
  });
  return { snapshot, ref: publication.revision.ref };
}

test('host-verified authored identities need no workbook rows and Shopping binds an exact listed revision source', async (t) => {
  const f = await populated(t);
  await migrateCookingContentDatabase(f.writer, { sha256 });
  const { snapshot, ref } = await signedSnapshot();
  await f.writer.transaction((session) =>
    retainVerifiedRevisionsInSnapshot(session, snapshot, [ref], sha256),
  );
  assert.equal(
    f.database.prepare('SELECT 1 FROM recipe WHERE recipe_id=?').get(ref.recipeId),
    undefined,
  );
  assert.equal(
    f.database.prepare('SELECT 1 FROM ingredient_entry WHERE recipe_id=?').get(ref.recipeId),
    undefined,
  );
  assert.equal(
    f.database.prepare('SELECT 1 FROM instruction_passage WHERE recipe_id=?').get(ref.recipeId),
    undefined,
  );
  f.database.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(ref.recipeId, at, at);
  f.database
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)')
    .run(randomUUID(), ref.recipeId, JSON.stringify('Authored personal note'), at, at);
  f.database
    .prepare('INSERT INTO personal_collection_member VALUES (?,?,1,1,?)')
    .run(f.collection, ref.recipeId, at);
  f.database.prepare('INSERT INTO reference_item VALUES (?,1,?)').run(f.reference, ref.recipeId);
  const occurrence = randomUUID();
  f.database
    .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
    .run(occurrence, ref.recipeId, '2026-10-02', 'dinner', at, at);
  f.database
    .prepare('INSERT INTO shopping_selection VALUES (?,?)')
    .run(f.ids.shoppingScopeId, occurrence);
  const insert = (sourceKey: string, position: number, revision: RecipeContentRef = ref) =>
    f.database
      .prepare(
        "INSERT INTO shopping_contribution VALUES (?,?,?,?,?,'ingredient',?,?,NULL,'fixture-group','Salt',NULL,'{}')",
      )
      .run(
        f.ids.shoppingScopeId,
        occurrence,
        ref.recipeId,
        revision.revisionId,
        revision.contentFingerprint,
        sourceKey,
        position,
      );
  assert.throws(() => insert('1', 1), /FOREIGN KEY/);
  f.database
    .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
    .run(occurrence, ref.recipeId, ref.revisionId, ref.contentFingerprint);
  assert.throws(() => insert('99', 99), /FOREIGN KEY/);
  assert.throws(() => insert('1', 2), /CHECK/);
  assert.throws(
    () => insert('1', 1, { ...ref, contentFingerprint: 'f'.repeat(64) }),
    /FOREIGN KEY/,
  );
  insert('1', 1);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await f.writer.transaction(readAdoptionInSnapshot)).head, null);
  assert.equal(
    (
      f.database.prepare('SELECT COUNT(*) count FROM content_adoption_operation').get() as {
        count: number;
      }
    ).count,
    0,
  );
});

test('retention rejects missing, withdrawn and rebound immutable identities without changing any pointer', async (t) => {
  const f = await fixture(t);
  await migrateCookingContentDatabase(f.writer, { sha256 });
  const first = await signedSnapshot();
  await f.writer.transaction((session) =>
    retainVerifiedRevisionsInSnapshot(session, first.snapshot, [first.ref], sha256),
  );
  const changed = authoredFixture();
  changed.recipe.title = 'A different immutable document';
  const rebound = await signedSnapshot(changed);
  await assert.rejects(
    f.writer.transaction((session) =>
      retainVerifiedRevisionsInSnapshot(session, rebound.snapshot, [rebound.ref], sha256),
    ),
  );
  await assert.rejects(
    f.writer.transaction((session) =>
      retainVerifiedRevisionsInSnapshot(
        session,
        first.snapshot,
        [{ ...first.ref, revisionId: 'missing' }],
        sha256,
      ),
    ),
  );
  const withdrawn = await signedSnapshot(authoredFixture(), [
    { state: 'withdrawn', recipeId: recipe.recipeId, reason: 'Synthetic withdrawal' },
  ]);
  const baseline = (await createBundledContentSnapshot(sha256)).revisions.find(
    (value) => value.ref.recipeId === recipe.recipeId,
  )!;
  await assert.rejects(
    f.writer.transaction((session) =>
      retainVerifiedRevisionsInSnapshot(session, withdrawn.snapshot, [baseline.ref], sha256),
    ),
  );
  assert.deepEqual(await f.writer.transaction(readAdoptionInSnapshot), { revision: 0, head: null });
});

test('startup rejects unsupported schema, missing pins and exact DDL corruption; finite pages guard account ownership', async (t) => {
  const old = await fixture(t, true);
  await assert.rejects(migrateCookingContentDatabase(old.writer, { sha256 }), /schema six/);
  const f = await populated(t);
  await migrateCookingContentDatabase(f.writer, { sha256 });
  await assert.rejects(
    f.writer.transaction((session) => readPlanContentPins(session, { limit: 101 })),
  );
  await assert.rejects(
    f.writer.transaction((session) =>
      readHistoryContentPins(session, { sha256, source: 'account', ownerId: randomUUID() }),
    ),
  );
  const first = await f.writer.transaction((session) => readPlanContentPins(session, { limit: 1 }));
  assert.equal(first.items.length, 1);
  assert.equal(first.nextAfter, null);
  f.database.prepare('DELETE FROM local_history_content_pin WHERE event_id=?').run(f.local.eventId);
  await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256 }));
  const clean = await fixture(t);
  await migrateCookingContentDatabase(clean.writer, { sha256 });
  clean.database.exec('CREATE TABLE unexpected (value TEXT)');
  await assert.rejects(migrateCookingContentDatabase(clean.writer, { sha256 }), /incompatible/);
  assert.equal(CONTENT_REBUILT_TABLES.includes('shopping_selection'), true);
});

test('history and session reads plus reopen reject valid retained recipe/revision substitutions without upgrading parents', async (t) => {
  const f = await populated(t);
  await migrateCookingContentDatabase(f.writer, { sha256 });
  const baseline = await createBundledContentSnapshot(sha256),
    original = baseline.revisions.find((item) => item.ref.recipeId === recipe.recipeId)!,
    other = baseline.revisions.find((item) => item.ref.recipeId !== recipe.recipeId)!;
  // A valid retained second revision with identical recipe bytes still was never recorded by the legacy parent.
  const next = await createRecipeContentRevision(
    original.document,
    'fixture-retained-other-revision',
    sha256,
  );
  await f.writer.transaction((session) => retainCookingRevisionInSnapshot(session, next, sha256));
  const before = legacySnapshot(f.database).filter(({ name }) => !name.endsWith('_content_pin'));
  for (const source of ['local', 'backup', 'account'] as const) {
    const table = {
      local: 'local_history_content_pin',
      backup: 'imported_history_content_pin',
      account: 'account_history_content_pin',
    }[source];
    const eventId = {
      local: f.local.eventId,
      backup: f.imported.eventId,
      account: f.account.eventId,
    }[source];
    const update = (ref: RecipeContentRef) =>
      f.database
        .prepare(
          `UPDATE ${table} SET recipe_id=?,revision_id=?,content_fingerprint=? WHERE event_id=?`,
        )
        .run(ref.recipeId, ref.revisionId, ref.contentFingerprint, eventId);
    for (const replacement of [other.ref, next.ref]) {
      update(replacement);
      assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
      await assert.rejects(
        f.writer.transaction((session) =>
          readHistoryContentPins(session, {
            source,
            sha256,
            ...(source === 'account' ? { ownerId: owner } : {}),
          }),
        ),
      );
      await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256 }));
      update(original.ref);
    }
  }
  f.database
    .prepare('UPDATE cooking_session_content_pin SET revision_id=?,content_fingerprint=?')
    .run(next.ref.revisionId, next.ref.contentFingerprint);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
  await assert.rejects(
    f.writer.transaction((session) => readSessionContentPin(session, recipe.recipeId, { sha256 })),
  );
  await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256 }));
  f.database
    .prepare('UPDATE cooking_session_content_pin SET revision_id=?,content_fingerprint=?')
    .run(original.ref.revisionId, original.ref.contentFingerprint);
  assert.equal(await migrateCookingContentDatabase(f.writer, { sha256 }), 'existing');
  assertLegacyUnchanged(f.database, before);
});

test('scalar admission rejects oversized legacy lineage IDs before reading parent payload rows', async (t) => {
  for (const source of ['local', 'backup'] as const) {
    const f = await populated(t),
      large = 'x'.repeat(2 * 1024 * 1024);
    if (source === 'local') f.database.prepare('UPDATE cooking_event SET event_id=?').run(large);
    else f.database.prepare('UPDATE imported_cooking_history SET source_event_id=?').run(large);
    let largestReturned = 0,
      rawParents = 0;
    const original = f.connection.all;
    f.connection.all = async <Row extends object>(
      sql: string,
      values?: Parameters<typeof original>[1],
    ) => {
      const result = await original<Row>(sql, values);
      if (
        sql.startsWith(
          'SELECT * FROM ' + (source === 'local' ? 'cooking_event' : 'imported_cooking_history'),
        )
      )
        rawParents += result.length;
      for (const row of result)
        for (const value of Object.values(row))
          if (typeof value === 'string')
            largestReturned = Math.max(largestReturned, Buffer.byteLength(value));
      return result;
    };
    await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256 }));
    assert.equal(rawParents, 0);
    assert.ok(largestReturned < 32768);
    assert.equal(
      (f.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      6,
    );
  }
});

test('pin and retained-source admission rejects corrupt row counts and large identifiers before raw reads', async (t) => {
  const f = await populated(t);
  await migrateCookingContentDatabase(f.writer, { sha256 });
  const baseline = (await createBundledContentSnapshot(sha256)).revisions.find(
    (item) => item.ref.recipeId === recipe.recipeId,
  )!;
  f.database.exec('BEGIN');
  const insert = f.database.prepare(
    "INSERT INTO recipe_content_source VALUES (?,?,?,'instruction',?)",
  );
  for (let index = 0; index < 1001; index++)
    insert.run(
      baseline.ref.recipeId,
      baseline.ref.revisionId,
      baseline.ref.contentFingerprint,
      `fixture-extra-${index}`,
    );
  f.database.exec('COMMIT');
  let sourceRows = 0,
    oversizedValues = 0;
  const original = f.connection.all;
  f.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof original>[1],
  ) => {
    const result = await original<Row>(sql, values);
    if (sql.startsWith('SELECT source_kind kind,source_key key')) sourceRows += result.length;
    for (const row of result)
      for (const value of Object.values(row))
        if (typeof value === 'string' && Buffer.byteLength(value) > 32768) oversizedValues++;
    return result;
  };
  await assert.rejects(
    f.writer.transaction((session) => retainCookingRevisionInSnapshot(session, baseline, sha256)),
  );
  assert.equal(sourceRows, 0);
  f.database.exec("DELETE FROM recipe_content_source WHERE source_key LIKE 'fixture-extra-%'");
  // Simulate disk corruption outside normal foreign-key-enforced application writes.
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database
    .prepare('UPDATE plan_content_pin SET occurrence_id=?')
    .run('x'.repeat(2 * 1024 * 1024));
  f.database.exec('PRAGMA foreign_keys=ON');
  await assert.rejects(f.writer.transaction((session) => readPlanContentPins(session)));
  assert.equal(oversizedValues, 0);
});
