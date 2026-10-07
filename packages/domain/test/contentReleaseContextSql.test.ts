import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalContentJson, createRecipeContentRevision } from '@cookmate/catalogue/content';
import { cookingContentIdentity, type CookingHistoryEntry, type CookingSession } from '../src';
import {
  createContentAdoptionService,
  type ContentAdoptionAccess,
} from '../../../apps/mobile/src/data/contentAdoption';
import { openContentCookingStore } from '../../../apps/mobile/src/data/contentCookingStore';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import type { ContentCookingSession } from '../../../apps/mobile/src/data/contentCookingRecords';
import type { ContentCookingHistoryEntry } from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Real disposable SQLite with explicitly seeded retained-content evidence. This proves local
// context integrity and lifetime, not publication signatures, media permission or activation.
const at = '2026-10-01T12:00:00.000Z';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fingerprint = 'a'.repeat(64);

async function fixture(t: TestContext, version: 7 | 8 = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-release-context-'));
  const path = join(directory, 'cooking.db');
  const write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const queue = new SqlTransactionQueue();
  const writer = new SerializedWriter(write.connection, queue);
  const reader = new SerializedReader(read.connection, queue);
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
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
  const db = write.database;
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId }),
  );
  async function legacy(index: number): Promise<CookingHistoryEntry> {
    const recipe = catalogue.recipes[index]!;
    return {
      ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
      eventId: randomUUID(),
      recipeTitle: recipe.title,
      photoKey: recipe.photoKey,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      recordedAt: at,
      note: 'Private original note',
      historyEpoch: 0,
      revision: 1,
    };
  }
  const local = await legacy(0),
    imported = { ...(await legacy(2)), origin: 'backup' as const },
    account = await legacy(3);
  const unresolved = { ...local, eventId: randomUUID(), contentFingerprint: 'f'.repeat(64) };
  for (const event of [local, unresolved]) {
    db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
      event.eventId,
      event.cookedOn,
      at,
      fingerprint,
      JSON.stringify({ kind: 'saved', event, closedSession: null }),
    );
  }
  function insertSession(value: CookingSession | ContentCookingSession) {
    db.prepare('INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?)').run(
      value.recipeId,
      value.sessionId,
      value.revision,
      value.state,
      value.updatedAt,
      value.lastOperationId,
      fingerprint,
      JSON.stringify(value),
    );
  }
  for (const index of [0, 1]) {
    const recipe = catalogue.recipes[index]!;
    insertSession({
      ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
      ...(index === 1 ? { contentFingerprint: 'f'.repeat(64) } : {}),
      sessionId: randomUUID(),
      revision: 1,
      passageSequence: 1,
      state: 'active',
      updatedAt: at,
      lastOperationId: randomUUID(),
    });
  }
  const restoreId = randomUUID();
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    restoreId,
    fingerprint,
    '{}',
    '{}',
    '{}',
  );
  db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
    imported.eventId,
    randomUUID(),
    restoreId,
    imported.cookedOn,
    at,
    JSON.stringify(imported),
  );
  for (const entry of [imported, account]) {
    const { revision: _revision, historyEpoch: _epoch, ...wire } = entry;
    db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
      ownerId,
      entry.eventId,
      JSON.stringify(wire),
    );
  }
  db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
    randomUUID(),
    local.recipeId,
    '2026-10-01',
    'dinner',
    at,
    at,
  );
  await migrateCookingContentDatabase(writer, { sha256 });
  const first = await createRecipeContentRevision(
    authoredFixture(),
    'context-authored-first',
    sha256,
  );
  const nextDocument = authoredFixture();
  nextDocument.recipe.title += ' second retained version';
  const second = await createRecipeContentRevision(nextDocument, 'context-authored-second', sha256);
  await writer.transaction(async (session) => {
    await retainCookingRevisionInSnapshot(session, first, sha256);
    await retainCookingRevisionInSnapshot(session, second, sha256);
  });
  const occurrenceId = randomUUID();
  db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
    occurrenceId,
    first.ref.recipeId,
    '2026-10-02',
    'dinner',
    at,
    at,
  );
  db.prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)').run(
    occurrenceId,
    first.ref.recipeId,
    first.ref.revisionId,
    first.ref.contentFingerprint,
  );
  const exactSession: ContentCookingSession = {
    readerVersion: 2,
    recipeId: second.ref.recipeId,
    contentRef: second.ref,
    sessionId: randomUUID(),
    revision: 2,
    passageSequence: 1,
    state: 'active',
    updatedAt: at,
    lastOperationId: randomUUID(),
  };
  insertSession(exactSession);
  db.prepare('INSERT INTO cooking_session_content_pin VALUES (?,?,?,?,NULL)').run(
    exactSession.sessionId,
    second.ref.recipeId,
    second.ref.revisionId,
    second.ref.contentFingerprint,
  );
  const exactEvent: ContentCookingHistoryEntry = {
    readerVersion: 2,
    recipeId: first.ref.recipeId,
    contentRef: first.ref,
    eventId: randomUUID(),
    recipeTitle: first.document.recipe.title,
    photoAssetId: null,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: null,
    historyEpoch: 0,
    revision: 2,
  };
  db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
    exactEvent.eventId,
    exactEvent.cookedOn,
    at,
    fingerprint,
    JSON.stringify({ kind: 'saved', event: exactEvent, closedSession: null }),
  );
  db.prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)').run(
    exactEvent.eventId,
    first.ref.recipeId,
    first.ref.revisionId,
    first.ref.contentFingerprint,
  );
  if (version === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  let access: ContentAdoptionAccess | null = { ownerId, authGeneration: 1 };
  let afterHash: (() => void) | undefined;
  const options: Parameters<typeof createContentAdoptionService>[0] = {
    cookingSchemaVersion: version,
    reader,
    writer,
    contentStore: {
      async withVerifiedAdoption() {
        throw new Error('Context must not request publication/media access');
      },
    },
    async sha256(text) {
      const value = await sha256(text);
      const callback = afterHash;
      afterHash = undefined;
      callback?.();
      return value;
    },
    now: () => at,
    newId: randomUUID,
    getAccess: () => access,
    assertAccess(scope) {
      assert.deepEqual(scope, access);
      return undefined;
    },
  };
  return {
    db,
    reader,
    read,
    writer,
    path,
    ids,
    options,
    first,
    second,
    occurrenceId,
    service: createContentAdoptionService(options),
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    afterHash(callback: () => void) {
      afterHash = callback;
    },
  };
}

function state(f: Awaited<ReturnType<typeof fixture>>) {
  return [
    'app_metadata',
    'app_content_adoption',
    'plan_occurrence',
    'plan_content_pin',
    'cooking_session',
    'cooking_event',
    'imported_cooking_history',
    'account_cooking_history',
    'cooking_session_content_pin',
    'local_history_content_pin',
    'imported_history_content_pin',
    'account_history_content_pin',
    'state_revision',
    'content_adoption_operation',
  ].map((table) => ({ table, rows: f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
}

for (const version of [7, 8] as const) {
  test(`schema${version} release context deduplicates full Plan, session and every history-source ref without private output or writes`, async (t) => {
    const f = await fixture(t, version);
    const before = state(f);
    const value = await f.service.readReleaseContext();
    assert.deepEqual(
      Object.keys(value).sort(),
      [
        'installationId',
        'ownerId',
        'adoptedHead',
        'adoptionRevision',
        'storeRevision',
        'restoreEpoch',
        'retainedRefs',
        'unresolvedHistoryOrSessionCount',
        'contextFingerprint',
      ].sort(),
    );
    assert.equal(value.installationId, f.ids.installationId);
    assert.equal(value.ownerId, ownerId);
    assert.equal(value.adoptedHead, null);
    assert.equal(value.adoptionRevision, 0);
    assert.equal(value.restoreEpoch, 1);
    assert.equal(value.unresolvedHistoryOrSessionCount, 2);
    assert.match(value.contextFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(value.retainedRefs.length, 5);
    assert.equal(new Set(value.retainedRefs.map((ref) => canonicalContentJson(ref))).size, 5);
    assert.deepEqual(
      value.retainedRefs.filter((ref) => ref.recipeId === f.first.ref.recipeId),
      [f.first.ref, f.second.ref].sort((a, b) =>
        canonicalContentJson(a).localeCompare(canonicalContentJson(b)),
      ),
    );
    for (const ref of value.retainedRefs) {
      assert.deepEqual(Object.keys(ref).sort(), ['contentFingerprint', 'recipeId', 'revisionId']);
      assert.ok(Object.isFrozen(ref));
    }
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.retainedRefs));
    assert.equal(JSON.stringify(value).includes('Private original note'), false);
    assert.equal(JSON.stringify(value).includes('second retained version'), false);
    assert.deepEqual(state(f), before);
  });
}

test('release context exposes the actual head and clocks without granting a review or activation', async (t) => {
  const f = await fixture(t);
  const head = { releaseId: 'context-adopted', sequence: 1, fingerprint };
  f.db.prepare('UPDATE app_content_adoption SET revision=1,head_json=?').run(JSON.stringify(head));
  f.db.prepare("UPDATE state_revision SET revision=8 WHERE collection='store'").run();
  const before = state(f);
  const value = await f.service.readReleaseContext();
  assert.deepEqual(value.adoptedHead, head);
  assert.ok(Object.isFrozen(value.adoptedHead));
  assert.equal(value.adoptionRevision, 1);
  assert.equal(value.storeRevision, 8);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM content_adoption_operation').get()!.n, 0);
  assert.deepEqual(state(f), before);
});

test('complete capture fingerprint changes when a duplicate retained history binding changes without changing projected refs or clocks', async (t) => {
  const f = await fixture(t);
  const before = await f.service.readReleaseContext();
  // The same exact imported-history reference remains retained after removing its duplicate
  // account source, so only the complete capture fingerprint exposes the context change.
  const duplicate = f.db
    .prepare(
      'SELECT event_id FROM account_cooking_history WHERE event_id IN (SELECT event_id FROM imported_cooking_history)',
    )
    .get()?.event_id;
  assert.equal(typeof duplicate, 'string');
  if (typeof duplicate !== 'string') assert.fail();
  f.db.prepare('DELETE FROM account_history_content_pin WHERE event_id=?').run(duplicate);
  f.db.prepare('DELETE FROM account_cooking_history WHERE event_id=?').run(duplicate);
  const after = await f.service.readReleaseContext();
  const { contextFingerprint: beforeFingerprint, ...beforeMetadata } = before;
  const { contextFingerprint: afterFingerprint, ...afterMetadata } = after;
  assert.deepEqual(afterMetadata, beforeMetadata);
  assert.notEqual(afterFingerprint, beforeFingerprint);
});

test('revocation during final context fingerprinting suppresses delivery', async (t) => {
  const f = await fixture(t);
  const service = createContentAdoptionService({
    ...f.options,
    async sha256(text) {
      const value = await sha256(text);
      if (text.startsWith('["cookmate-content-adoption-state-v1"')) f.setAccess(null);
      return value;
    },
  });
  await assert.rejects(service.readReleaseContext(), /access_changed/);
});

test('scope revocation during retained-evidence hashing suppresses the context and leaves data unchanged', async (t) => {
  const f = await fixture(t);
  const before = state(f);
  f.afterHash(() => f.setAccess(null));
  await assert.rejects(f.service.readReleaseContext(), /access_changed/);
  assert.deepEqual(state(f), before);
});

test('owner changes after read COMMIT still suppress context delivery', async (t) => {
  const f = await fixture(t);
  const exec = f.read.connection.exec;
  f.read.connection.exec = async (sql) => {
    await exec(sql);
    if (sql === 'COMMIT') f.setAccess({ ownerId: randomUUID(), authGeneration: 2 });
  };
  await assert.rejects(f.service.readReleaseContext(), /access_changed/);
});

test('foreign owner and mismatched configured physical schema cannot read release context', async (t) => {
  const f = await fixture(t);
  f.setAccess({ ownerId: randomUUID(), authGeneration: 1 });
  await assert.rejects(f.service.readReleaseContext());
  f.setAccess({ ownerId, authGeneration: 1 });
  await assert.rejects(
    createContentAdoptionService({ ...f.options, cookingSchemaVersion: 7 }).readReleaseContext(),
  );
});

test('corrupt exact bindings cannot escape as a partial context or be rewritten', async (t) => {
  const f = await fixture(t);
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db
    .prepare('UPDATE cooking_session_content_pin SET content_fingerprint=? WHERE recipe_id=?')
    .run('e'.repeat(64), f.second.ref.recipeId);
  const before = state(f);
  await assert.rejects(f.service.readReleaseContext());
  assert.deepEqual(state(f), before);
});

test('private cooking-store wrapper exposes context and denies it after close', async (t) => {
  const f = await fixture(t);
  const expected = await f.service.readReleaseContext();
  const store = await openContentCookingStore({
    schemaVersion: 8,
    installationId: f.ids.installationId,
    async openConnection() {
      return desktopConnection(f.path).connection;
    },
    contentStore: {
      ...f.options.contentStore,
      async withVerifiedReading() {
        throw new Error('Context does not read recipe bodies through the content store');
      },
      async withVerifiedReferenceInspection() {
        throw new Error('Context does not admit private note identities');
      },
    },
    platform: { newId: randomUUID, sha256 },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    getAccess: f.options.getAccess,
    assertAccess: f.options.assertAccess,
  });
  try {
    assert.deepEqual(await store.adoption.readReleaseContext(), expected);
  } finally {
    await store.close();
  }
  await assert.rejects(store.adoption.readReleaseContext(), /access_changed/);
});
