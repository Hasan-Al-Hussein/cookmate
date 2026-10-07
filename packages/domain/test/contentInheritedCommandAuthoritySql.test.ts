import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  commandFingerprintInput,
  type CommandPayload,
  type LocalCommand,
  type ConversationOrigin,
} from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { favouriteCommandHandlers } from '../../../apps/mobile/src/data/favouriteCommands';
import { preferenceCommandHandlers } from '../../../apps/mobile/src/data/preferenceCommands';
import { createPlanCommandHandlers } from '../../../apps/mobile/src/data/planCommands';
import { createClearConversationCommandHandler } from '../../../apps/mobile/src/data/clearConversationCommand';
import { readConversationClearScope } from '../../../apps/mobile/src/data/conversationClearScope';
import { readReceiptInSnapshot } from '../../../apps/mobile/src/data/stateRepositories';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  CONTENT_INHERITED_COMMAND_PREFIX,
  CONTENT_INHERITED_RECEIPT_PREFIX,
  readInheritedCommandAuthorityInSnapshot,
  readInheritedReceiptAuthorityInSnapshot,
  recordInheritedCommandAuthoritiesForMigration,
} from '../../../apps/mobile/src/data/contentInheritedCommandAuthority';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import {
  configureConnection,
  SerializedWriter,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const platform = { sha256, newId: randomUUID };
const prepare = createCommandPreparer(platform, catalogueBoundary);
const recipe = catalogue.recipes[0]!;

/** Actual legacy registration/execution and disposable migration; no runtime or service claim. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-inherited-command-'));
  const path = join(directory, 'state.db');
  const db = desktopConnection(path);
  await configureConnection(db.connection);
  const writer = new SerializedWriter(db.connection);
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
  t.after(async () => {
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: {
      ...favouriteCommandHandlers,
      ...preferenceCommandHandlers,
      ...createClearConversationCommandHandler({ catalogue: catalogueBoundary, sha256 }),
      ...createPlanCommandHandlers({
        sha256,
        readRecipe: (id) => catalogue.recipes.find((r) => r.recipeId === id),
      }),
    },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    readReceipt: async () => ({ kind: 'ready', value: null, revision: 0 }),
    onCommitted: () => {},
  });
  async function register(payload: CommandPayload, origin?: ConversationOrigin) {
    const command = await prepare(payload, origin ? { origin } : {});
    await registerReadyIntent(
      writer,
      {
        userIntentId: command.userIntentId,
        revision: command.intentRevision,
        phase: 'ready',
        ...(origin ? { origin } : {}),
        slots: [{ slotId: randomUUID(), command }],
      },
      catalogueBoundary,
      platform,
      undefined,
      { trackDirectRecovery: !origin },
    );
    return command;
  }
  async function committed(command: LocalCommand) {
    const result = await executor.execute(command);
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
  }
  const favourite = () =>
    register({ kind: 'setFavourite', recipeId: recipe.recipeId, saved: true });
  const migrate = () => migrateCookingContentDatabase(writer, { sha256 });
  const read = (id: string) =>
    writer.transaction((session) => readInheritedCommandAuthorityInSnapshot(session, id), {
      kind: 'read_only',
    });
  const markers = () =>
    db.database
      .prepare('SELECT key,value FROM app_metadata WHERE key GLOB ? ORDER BY key')
      .all(CONTENT_INHERITED_COMMAND_PREFIX + '*');
  const readResultMarker = (id: string) =>
    writer.transaction((session) => readInheritedReceiptAuthorityInSnapshot(session, id), {
      kind: 'read_only',
    });
  const receiptMarkers = () =>
    db.database
      .prepare('SELECT key,value FROM app_metadata WHERE key GLOB ? ORDER BY key')
      .all(CONTENT_INHERITED_RECEIPT_PREFIX + '*');
  async function clearedAssistantReceipt() {
    const origin = { conversationId: ids.conversationId, generation: 0, messageId: randomUUID() };
    db.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
      .run(
        origin.messageId,
        origin.conversationId,
        'user',
        JSON.stringify('Save this recipe'),
        'complete',
        at,
      );
    db.database.exec('UPDATE conversation SET next_sequence=1');
    db.database
      .prepare('INSERT INTO message_context VALUES (?,?,0)')
      .run(
        origin.messageId,
        JSON.stringify({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
      );
    const assistant = await register(
      { kind: 'setFavourite', recipeId: recipe.recipeId, saved: true },
      origin,
    );
    await committed(assistant);
    const original = await writer.transaction(
      (s) => readReceiptInSnapshot(s, assistant.operationId, catalogueBoundary),
      { kind: 'read_only' },
    );
    assert.ok(original);
    const raw = db.database
      .prepare('SELECT * FROM operation_receipt WHERE operation_id=?')
      .get(assistant.operationId);
    const scope = await writer.transaction(
      (s) => readConversationClearScope(s, { catalogue: catalogueBoundary, sha256 }),
      { kind: 'read_only' },
    );
    const clear = await register({
      kind: 'clearConversation',
      conversationId: ids.conversationId,
      expectedGeneration: 0,
      expectedScopeFingerprint: scope.fingerprint,
    });
    await committed(clear);
    assert.equal(
      db.database
        .prepare('SELECT COUNT(*) count FROM command_slot WHERE operation_id=?')
        .get(assistant.operationId)?.count,
      0,
    );
    assert.equal(db.database.prepare('SELECT COUNT(*) count FROM message').get()?.count, 0);
    assert.deepEqual(
      db.database
        .prepare('SELECT * FROM operation_receipt WHERE operation_id=?')
        .get(assistant.operationId),
      raw,
    );
    return { assistant, clear, original, raw };
  }
  const originals = () =>
    [
      'command_slot',
      'pending_intent',
      'operation_receipt',
      'direct_command_recovery',
      'favourite',
      'saved_preference',
      'plan_occurrence',
      'message',
    ].map((table) => ({
      table,
      rows: db.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    }));
  return {
    ...db,
    writer,
    ids,
    register,
    committed,
    favourite,
    migrate,
    read,
    markers,
    originals,
    readResultMarker,
    receiptMarkers,
    clearedAssistantReceipt,
  };
}

test('actual6→7→8 preserves direct favourite, Plan, preference and assistant receipts plus unexecuted slots', async (t) => {
  const f = await fixture(t);
  const fav = await f.favourite();
  await f.committed(fav);
  const plan = await f.register({
    kind: 'addPlan',
    occurrenceId: randomUUID(),
    recipeId: recipe.recipeId,
    placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
    expectedTarget: { kind: 'empty' },
  });
  await f.committed(plan);
  const preference = await f.register({
    kind: 'savePreference',
    preferenceId: randomUUID(),
    type: 'ingredient_like',
    explicitValue: 'Exact original basil',
    expectedPreferenceRevision: 0,
  });
  await f.committed(preference);
  const origin = { conversationId: f.ids.conversationId, generation: 0, messageId: randomUUID() };
  f.database
    .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
    .run(
      origin.messageId,
      origin.conversationId,
      'user',
      JSON.stringify('Save this recipe'),
      'complete',
      at,
    );
  const assistant = await f.register(
    { kind: 'setFavourite', recipeId: recipe.recipeId, saved: true },
    origin,
  );
  await f.committed(assistant);
  const pending = await f.favourite();
  const before = f.originals();
  assert.equal(await f.migrate(), 'migrated');
  for (const command of [fav, plan, preference, assistant, pending]) {
    const marker = await f.read(command.operationId);
    assert.deepEqual(marker, {
      formatVersion: 1,
      installationId: f.ids.installationId,
      ownerId: null,
      catalogue: catalogue.identity,
      operationId: command.operationId,
      userIntentId: command.userIntentId,
      payloadFingerprint: command.payloadFingerprint,
    });
    assert.ok(Object.isFrozen(marker) && Object.isFrozen(marker?.catalogue));
  }
  assert.deepEqual(f.originals(), before);
  const markers = f.markers();
  assert.equal(await f.migrate(), 'existing');
  assert.equal(await migrateAccountContentHistoryDatabase(f.writer, { sha256 }), 'migrated');
  assert.deepEqual(f.markers(), markers);
  assert.deepEqual(f.originals(), before);
  assert.equal((await f.read(plan.operationId))?.payloadFingerprint, plan.payloadFingerprint);
  assert.equal(await f.read(randomUUID()), null);
});

test('migration pins actual account binding without guest or later-owner substitution', async (t) => {
  const f = await fixture(t),
    ownerId = randomUUID();
  f.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
  const command = await f.favourite();
  await f.committed(command);
  await f.migrate();
  assert.equal((await f.read(command.operationId))?.ownerId, ownerId);
  f.database
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }), ACCOUNT_BINDING_KEY);
  assert.equal(
    (await f.read(command.operationId))?.ownerId,
    ownerId,
    'reader preserves captured identity; host must compare live owner',
  );
});

test('original commands page at32 and hash each exact command before recording provenance', async (t) => {
  const f = await fixture(t),
    commands: LocalCommand[] = [];
  for (let i = 0; i < 35; i++) commands.push(await f.favourite());
  const commandInputs = new Set(commands.map(commandFingerprintInput));
  let hashes = 0;
  const pages: number[] = [];
  const all = f.connection.all;
  f.connection.all = async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
    const rows = await all<Row>(sql, values);
    if (sql.includes('s.command_json commandJson')) pages.push(rows.length);
    return rows;
  };
  await migrateCookingContentDatabase(f.writer, {
    sha256: async (text) => {
      if (commandInputs.has(text)) hashes++;
      return sha256(text);
    },
  });
  assert.deepEqual(pages, [32, 3, 0]);
  assert.equal(hashes, 35);
  assert.equal(f.markers().length, 35);
});

test('existing7/8 stores never synthesize absent markers and migration writer denies later schemas', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  await f.migrate();
  f.database
    .prepare('DELETE FROM app_metadata WHERE key=?')
    .run(CONTENT_INHERITED_COMMAND_PREFIX + command.operationId);
  assert.equal(await f.migrate(), 'existing');
  assert.equal(await f.read(command.operationId), null);
  await assert.rejects(
    f.writer.transaction((s) => recordInheritedCommandAuthoritiesForMigration(s, sha256)),
  );
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.equal(await f.read(command.operationId), null);
  await assert.rejects(
    f.writer.transaction((s) => recordInheritedCommandAuthoritiesForMigration(s, sha256)),
  );
});

test('changed frozen command fingerprint fails migration without changing original rows', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  const changed = { ...command, payloadFingerprint: 'f'.repeat(64) };
  f.database
    .prepare('UPDATE command_slot SET command_json=? WHERE operation_id=?')
    .run(JSON.stringify(changed), command.operationId);
  const row = f.database
    .prepare('SELECT intent_json FROM pending_intent WHERE user_intent_id=?')
    .get(command.userIntentId)!;
  const intent = JSON.parse(String(row.intent_json));
  intent.slots[0].command = changed;
  f.database
    .prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?')
    .run(JSON.stringify(intent), command.userIntentId);
  const before = f.originals();
  await assert.rejects(f.migrate());
  assert.deepEqual(f.originals(), before);
  assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 6);
  assert.deepEqual(f.markers(), []);
});

test('orphan with a direct recovery notice is rejected before its private effects are materialized', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  await f.committed(command);
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database.prepare('DELETE FROM command_slot WHERE operation_id=?').run(command.operationId);
  f.database.exec('PRAGMA foreign_keys=ON');
  let pages = 0;
  const all = f.connection.all;
  f.connection.all = async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
    if (sql.includes('effects_json effectsJson')) pages++;
    return all<Row>(sql, values);
  };
  const before = f.originals();
  await assert.rejects(f.migrate());
  assert.equal(pages, 0);
  assert.deepEqual(f.originals(), before);
  assert.deepEqual(f.markers(), []);
});

test('receipt fingerprint mismatch and malformed receipt semantics cannot receive a marker', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  await f.committed(command);
  const original = f.database.prepare('SELECT * FROM operation_receipt').get()!;
  assert.equal(typeof original.payload_fingerprint, 'string');
  const originalFingerprint = original.payload_fingerprint;
  assert.ok(typeof originalFingerprint === 'string');
  f.database.prepare('UPDATE operation_receipt SET payload_fingerprint=?').run('e'.repeat(64));
  await assert.rejects(f.migrate());
  f.database
    .prepare('UPDATE operation_receipt SET payload_fingerprint=?,effects_json=?')
    .run(
      originalFingerprint,
      JSON.stringify([{ kind: 'favourite', entityId: '999999999', revision: 1, saved: true }]),
    );
  await assert.rejects(f.migrate());
  assert.deepEqual(f.markers(), []);
  assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 6);
});

for (const field of ['command', 'intent', 'receipt'] as const) {
  test(`oversized ${field} is denied by SQL before original private body transfer`, async (t) => {
    const f = await fixture(t),
      command = await f.favourite();
    await f.committed(command);
    const huge = JSON.stringify('x'.repeat(140000));
    if (field === 'command') f.database.prepare('UPDATE command_slot SET command_json=?').run(huge);
    else if (field === 'intent')
      f.database.prepare('UPDATE pending_intent SET intent_json=?').run(huge);
    else f.database.prepare('UPDATE operation_receipt SET effects_json=?').run(huge);
    let transferred = false;
    const all = f.connection.all;
    f.connection.all = async <Row extends object>(
      sql: string,
      values: readonly SqlValue[] = [],
    ) => {
      const rows = await all<Row>(sql, values);
      transferred ||= rows.some((row) =>
        Object.values(row).some((value) => typeof value === 'string' && value.length >= 140000),
      );
      return rows;
    };
    await assert.rejects(f.migrate());
    assert.equal(transferred, false);
    assert.deepEqual(f.markers(), []);
    assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 6);
  });
}

test('strict bounded marker read rejects corruption and never reads command payload', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  await f.migrate();
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const marker = await f.read(command.operationId);
  assert.ok(marker);
  const key = CONTENT_INHERITED_COMMAND_PREFIX + command.operationId;
  const cases = [
    JSON.stringify('x'.repeat(2000)),
    'null',
    canonicalContentJson({
      ...marker,
      catalogue: { ...marker.catalogue, fingerprint: 'a'.repeat(64) },
    }),
    canonicalContentJson({ ...marker, operationId: randomUUID() }),
    canonicalContentJson({ ...marker, extra: true }),
    canonicalContentJson(marker).replace('{', '{"formatVersion":9,'),
  ];
  const all = f.connection.all;
  f.connection.all = async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
    assert.ok(!sql.includes('command_slot') && !sql.includes('operation_receipt'));
    const rows = await all<Row>(sql, values);
    assert.ok(
      rows.every((row) =>
        Object.values(row).every((value) => typeof value !== 'string' || value.length <= 1024),
      ),
    );
    return rows;
  };
  for (const value of cases) {
    f.database.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(value, key);
    await assert.rejects(f.read(command.operationId));
    assert.equal(
      f.database.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value,
      value,
    );
  }
});

test('late migration failure rolls marker creation back with the entire original command store', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  await f.committed(command);
  const before = f.originals();
  const exec = f.connection.exec;
  let sawMarker = false;
  f.connection.exec = async (sql) => {
    if (sql === 'DROP TABLE shopping_contribution') {
      sawMarker = f.markers().length === 1;
      throw new Error('Controlled migration failure');
    }
    await exec(sql);
  };
  await assert.rejects(f.migrate());
  assert.equal(sawMarker, true);
  assert.deepEqual(f.markers(), []);
  assert.deepEqual(f.originals(), before);
  assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 6);
});

test('a preseeded migration marker is rejected and cannot be overwritten to fabricate provenance', async (t) => {
  const f = await fixture(t),
    command = await f.favourite();
  f.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(CONTENT_INHERITED_COMMAND_PREFIX + command.operationId, '{}');
  await assert.rejects(f.migrate());
  assert.equal(f.markers()[0]?.value, '{}');
  assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 6);
});

test('actual conversation clearing retains result-only evidence through6→7→8 without reviving deleted command authority', async (t) => {
  const f = await fixture(t),
    { assistant, clear, original, raw } = await f.clearedAssistantReceipt();
  const before = f.originals();
  await f.migrate();
  const resultMarker = await f.readResultMarker(assistant.operationId);
  assert.deepEqual(resultMarker, {
    formatVersion: 1,
    installationId: f.ids.installationId,
    ownerId: null,
    catalogue: catalogue.identity,
    operationId: assistant.operationId,
    userIntentId: assistant.userIntentId,
    payloadFingerprint: assistant.payloadFingerprint,
    receiptDigest: await sha256(canonicalContentJson(original)),
  });
  assert.ok(Object.isFrozen(resultMarker));
  assert.equal(await f.read(assistant.operationId), null);
  assert.ok(await f.read(clear.operationId));
  assert.equal(await f.readResultMarker(clear.operationId), null);
  assert.deepEqual(f.originals(), before);
  const markerRows = f.receiptMarkers();
  await f.migrate();
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.deepEqual(f.receiptMarkers(), markerRows);
  assert.deepEqual(
    f.database
      .prepare('SELECT * FROM operation_receipt WHERE operation_id=?')
      .get(assistant.operationId),
    raw,
  );
  assert.deepEqual(
    await f.writer.transaction(
      (s) => readReceiptInSnapshot(s, assistant.operationId, catalogueBoundary),
      { kind: 'read_only' },
    ),
    original,
  );
  assert.equal(await f.read(assistant.operationId), null);
  assert.equal(
    (await f.readResultMarker(assistant.operationId))?.receiptDigest,
    resultMarker?.receiptDigest,
  );
});

test('result-only markers are never synthesized on existing7/8 stores', async (t) => {
  const f = await fixture(t),
    { assistant } = await f.clearedAssistantReceipt();
  await f.migrate();
  f.database
    .prepare('DELETE FROM app_metadata WHERE key=?')
    .run(CONTENT_INHERITED_RECEIPT_PREFIX + assistant.operationId);
  await f.migrate();
  assert.equal(await f.readResultMarker(assistant.operationId), null);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.equal(await f.readResultMarker(assistant.operationId), null);
  assert.equal(await f.read(assistant.operationId), null);
});

for (const invalid of ['malformed', 'oversized'] as const) {
  test(`${invalid} retained orphan receipt fails migration unchanged`, async (t) => {
    const f = await fixture(t),
      { assistant } = await f.clearedAssistantReceipt();
    const effects =
      invalid === 'oversized'
        ? JSON.stringify('x'.repeat(17000))
        : JSON.stringify([{ kind: 'favourite', entityId: '999999999', revision: 1, saved: true }]);
    f.database
      .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
      .run(effects, assistant.operationId);
    const before = f.originals();
    let transferred = false;
    const all = f.connection.all;
    f.connection.all = async <Row extends object>(
      sql: string,
      values: readonly SqlValue[] = [],
    ) => {
      const rows = await all<Row>(sql, values);
      transferred ||= rows.some((row) =>
        Object.values(row).some((value) => typeof value === 'string' && value.length > 16384),
      );
      return rows;
    };
    await assert.rejects(f.migrate());
    if (invalid === 'oversized') assert.equal(transferred, false);
    assert.deepEqual(f.originals(), before);
    assert.deepEqual(f.markers(), []);
    assert.deepEqual(f.receiptMarkers(), []);
    assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 6);
  });
}

test('late failure atomically rolls back both command and retained-result markers', async (t) => {
  const f = await fixture(t);
  await f.clearedAssistantReceipt();
  const before = f.originals();
  const exec = f.connection.exec;
  let sawBoth = false;
  f.connection.exec = async (sql) => {
    if (sql === 'DROP TABLE shopping_contribution') {
      sawBoth = f.markers().length === 1 && f.receiptMarkers().length === 1;
      throw new Error('Controlled migration failure after provenance capture');
    }
    await exec(sql);
  };
  await assert.rejects(f.migrate());
  assert.equal(sawBoth, true);
  assert.deepEqual(f.markers(), []);
  assert.deepEqual(f.receiptMarkers(), []);
  assert.deepEqual(f.originals(), before);
});

test('retained-result reader bounds digest evidence and rejects corrupted or command-shaped markers', async (t) => {
  const f = await fixture(t),
    { assistant } = await f.clearedAssistantReceipt();
  await f.migrate();
  const marker = await f.readResultMarker(assistant.operationId);
  assert.ok(marker);
  const key = CONTENT_INHERITED_RECEIPT_PREFIX + assistant.operationId;
  const { receiptDigest, ...commandShaped } = marker;
  assert.equal(receiptDigest.length, 64);
  for (const value of [
    canonicalContentJson(commandShaped),
    canonicalContentJson({ ...marker, receiptDigest: 'bad' }),
    JSON.stringify('x'.repeat(2000)),
  ]) {
    f.database.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(value, key);
    await assert.rejects(f.readResultMarker(assistant.operationId));
    assert.equal(await f.read(assistant.operationId), null);
  }
});
