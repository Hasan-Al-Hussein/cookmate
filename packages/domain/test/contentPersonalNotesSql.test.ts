import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { OverlayHead } from '@cookmate/catalogue/content';
import type { PersonalCommand, RepositoryResult } from '../src';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  createContentPersonalNotes,
  type ContentNoteCommand,
} from '../../../apps/mobile/src/data/contentPersonalNotes';
import { createPersonalRepository } from '../../../apps/mobile/src/data/personalRepository';
import { readPersonalState } from '../../../apps/mobile/src/data/personalRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
const authoredId = '910000001';
const unknownId = '999999999';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function save(
  overrides: Partial<Extract<ContentNoteCommand, { kind: 'saveNote' }>> = {},
): Extract<ContentNoteCommand, { kind: 'saveNote' }> {
  return {
    kind: 'saveNote',
    operationId: randomUUID(),
    expectedEpoch: 0,
    noteId: randomUUID(),
    recipeId: authoredId,
    expectedRevision: null,
    text: 'My private change',
    ...overrides,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, version: 6 | 8 = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-notes-'));
  const path = join(directory, 'cooking.db');
  const seed = desktopConnection(path);
  await configureConnection(seed.connection);
  const seedWriter = new SerializedWriter(seed.connection);
  const installationId = randomUUID();
  await initializeDatabase(
    seedWriter,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId, shoppingScopeId: randomUUID(), conversationId: randomUUID() },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  if (version === 8) {
    await migrateCookingContentDatabase(seedWriter, { sha256 });
    await migrateAccountContentHistoryDatabase(seedWriter, { sha256 });
  }
  await seedWriter.close();
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  let head: OverlayHead = { releaseId: 'notes-fixture', sequence: 1, fingerprint: 'a'.repeat(64) };
  let inspectionHead: OverlayHead | undefined;
  let inventory: readonly string[] = [
    ...catalogue.recipes.map((recipe) => recipe.recipeId),
    authoredId,
  ];
  let unavailable = false,
    loseCommit = false,
    failReceiptReads = false;
  let hashPause:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let inspectPause:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let readDb!: ReturnType<typeof desktopConnection>, writeDb!: ReturnType<typeof desktopConnection>;
  let reader!: SerializedReader, writer!: SerializedWriter;
  let notes!: ReturnType<typeof createContentPersonalNotes>;
  let isClosed = true;
  const changes: unknown[] = [];
  const oversizedTransfers: string[] = [];
  function inspectRows<Row extends object>(sql: string, rows: Row[]): Row[] {
    if (
      rows.some((row) =>
        Object.values(row).some((value: unknown) =>
          typeof value === 'string'
            ? value.length > 65_536
            : value instanceof Uint8Array && value.byteLength > 65_536,
        ),
      )
    )
      oversizedTransfers.push(sql);
    return rows;
  }
  async function open() {
    readDb = desktopConnection(path);
    writeDb = desktopConnection(path);
    await configureConnection(readDb.connection);
    await configureConnection(writeDb.connection);
    const queue = new SqlTransactionQueue();
    reader = new SerializedReader(readDb.connection, queue);
    writer = new SerializedWriter(writeDb.connection, queue);
    const exec = writeDb.connection.exec;
    writeDb.connection.exec = async (sql) => {
      await exec(sql);
      if (loseCommit && sql === 'COMMIT') {
        loseCommit = false;
        throw new Error('Lost commit acknowledgement');
      }
    };
    const all = readDb.connection.all;
    readDb.connection.all = async (sql, values) => {
      if (failReceiptReads && sql.includes('personal_operation'))
        throw new Error('Receipt unavailable');
      return inspectRows(sql, await all(sql, values));
    };
    const writeAll = writeDb.connection.all;
    writeDb.connection.all = async (sql, values) => inspectRows(sql, await writeAll(sql, values));
    if (
      version === 8 &&
      writeDb.database.prepare('SELECT revision FROM app_content_adoption').get()!.revision === 0
    ) {
      writeDb.database
        .prepare('UPDATE app_content_adoption SET revision=1,head_json=?')
        .run(JSON.stringify(head));
    }
    notes = createContentPersonalNotes({
      reader,
      writer,
      installationId,
      getAccess: () => access,
      assertAccess(scope) {
        assert.deepEqual(access, scope);
        return undefined;
      },
      now: () => at,
      onCommitted: (change) => changes.push(change),
      platform: {
        newId: randomUUID,
        async sha256(text) {
          if (hashPause) {
            const pause = hashPause;
            hashPause = undefined;
            pause.entered.resolve();
            await pause.release.promise;
          }
          return sha256(text);
        },
      },
      // Body-free authenticated inventory seam. Signature verification is covered by the signed bridge.
      contentStore: {
        async withVerifiedReferenceInspection(expectedHead, refs, work) {
          if (unavailable) throw new Error('Content delivery unavailable');
          assert.deepEqual(expectedHead, head);
          assert.deepEqual(refs, []);
          if (inspectPause) {
            const pause = inspectPause;
            inspectPause = undefined;
            pause.entered.resolve();
            await pause.release.promise;
          }
          let active = true;
          try {
            return await work({
              head: inspectionHead ?? head,
              latestHead: head,
              adoptedRecipeIds: inventory,
              entries: [],
              assertActive() {
                assert.ok(active);
                return undefined;
              },
            });
          } finally {
            active = false;
          }
        },
      },
    });
    isClosed = false;
    return notes;
  }
  async function close() {
    if (isClosed) return;
    isClosed = true;
    notes.close();
    await reader.close();
    await writer.close();
  }
  t.after(async () => {
    await close();
    await removeFixtureDirectory(directory);
  });
  await open();
  return {
    get notes() {
      return notes;
    },
    get database() {
      return writeDb.database;
    },
    get reader() {
      return reader;
    },
    get writer() {
      return writer;
    },
    changes,
    oversizedTransfers,
    async reopen() {
      await close();
      return open();
    },
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    unavailable(value = true) {
      unavailable = value;
    },
    loseCommit() {
      loseCommit = true;
    },
    failReads(value = true) {
      failReceiptReads = value;
    },
    wrongHead() {
      inspectionHead = { ...head, fingerprint: 'b'.repeat(64) };
    },
    setInventory(value: readonly string[]) {
      inventory = value;
    },
    advanceAdoption() {
      head = {
        releaseId: 'notes-next-fixture',
        sequence: head.sequence + 1,
        fingerprint: 'b'.repeat(64),
      };
      writeDb.database
        .prepare('UPDATE app_content_adoption SET revision=revision+1,head_json=?')
        .run(JSON.stringify(head));
    },
    pauseHash() {
      const pause = { entered: deferred(), release: deferred() };
      hashPause = pause;
      return pause;
    },
    pauseInspection() {
      const pause = { entered: deferred(), release: deferred() };
      inspectPause = pause;
      return pause;
    },
  };
}

test('authored note admits only identity, survives physical reopen, edits and deletes with observer isolation', async (t) => {
  const f = await fixture(t),
    command = save();
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(authoredId)!
      .n,
    0,
  );
  f.notes.subscribe(() => {
    throw new Error('View callback failed');
  });
  const notices: unknown[] = [];
  f.notes.subscribe((change) => notices.push(change));
  const receipt = ready(await f.notes.execute(command));
  assert.equal(receipt.outcome, 'committed');
  assert.equal(receipt.revision, 1);
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(authoredId)!
      .n,
    1,
  );
  for (const table of [
    'plan_content_pin',
    'cooking_session_content_pin',
    'local_history_content_pin',
    'imported_history_content_pin',
    'account_history_content_pin',
    'favourite',
  ])
    assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
  assert.equal(notices.length, 1);
  assert.equal(f.changes.length, 1);
  await f.reopen();
  assert.deepEqual(ready(await f.notes.readReceipt(command.operationId)), receipt);
  const note = ready(await f.notes.readRecipeNote(authoredId)).note!;
  assert.equal(note.text, command.text);
  assert.equal(note.noteId, command.noteId);
  const edited = ready(
    await f.notes.execute(
      save({
        noteId: command.noteId,
        expectedRevision: note.revision,
        text: 'Less salt next time',
      }),
    ),
  );
  assert.equal(edited.revision, 2);
  ready(
    await f.notes.execute({
      kind: 'deleteNote',
      operationId: randomUUID(),
      expectedEpoch: 0,
      noteId: note.noteId,
      expectedRevision: 2,
    }),
  );
  const deleted = ready(await f.notes.readRecipeNote(authoredId)).note!;
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.text, null);
  assert.equal(ready(await f.notes.readState()).revision, 3);
});

test('archived and withdrawn authenticated identities retain editable notes without content bodies', async (t) => {
  const f = await fixture(t),
    command = save();
  ready(await f.notes.execute(command));
  // Both status transitions retain the identity in the verified inspection inventory; no body port exists.
  for (const text of ['Archived private edit', 'Withdrawn private edit']) {
    f.advanceAdoption();
    const note = ready(await f.notes.readRecipeNote(authoredId)).note!;
    ready(
      await f.notes.execute(save({ noteId: note.noteId, expectedRevision: note.revision, text })),
    );
    assert.equal(ready(await f.notes.readRecipeNote(authoredId)).note!.text, text);
  }
  const note = ready(await f.notes.readRecipeNote(authoredId)).note!;
  ready(
    await f.notes.execute({
      kind: 'deleteNote',
      operationId: randomUUID(),
      expectedEpoch: 0,
      noteId: note.noteId,
      expectedRevision: note.revision,
    }),
  );
});

test('retained notes remain private and editable after rollback removes authored identity and delivery is unavailable', async (t) => {
  const f = await fixture(t),
    command = save();
  ready(await f.notes.execute(command));
  f.advanceAdoption();
  f.setInventory(catalogue.recipes.map((recipe) => recipe.recipeId));
  f.unavailable();
  await f.reopen();
  const note = ready(await f.notes.readRecipeNote(authoredId)).note!;
  assert.equal(note.text, command.text);
  ready(
    await f.notes.execute(
      save({
        noteId: note.noteId,
        expectedRevision: note.revision,
        text: 'Keep this private adjustment',
      }),
    ),
  );
  assert.equal(
    (await f.notes.execute(save({ recipeId: catalogue.recipes[0]!.recipeId }))).kind,
    'failed',
  );
  f.database.prepare('INSERT INTO recipe_identity(recipe_id) VALUES (?)').run(unknownId);
  assert.equal((await f.notes.execute(save({ recipeId: unknownId }))).kind, 'failed');
  assert.equal((await f.notes.readRecipeNote(unknownId)).kind, 'failed');
  ready(
    await f.notes.execute({
      kind: 'deleteNote',
      operationId: randomUUID(),
      expectedEpoch: 0,
      noteId: note.noteId,
      expectedRevision: 2,
    }),
  );
  assert.equal(ready(await f.notes.readRecipeNote(authoredId)).note!.deleted, true);
});

test('stale entity revision and personal epoch never overwrite the note', async (t) => {
  const f = await fixture(t),
    command = save();
  ready(await f.notes.execute(command));
  assert.equal(
    (await f.notes.execute(save({ noteId: command.noteId, expectedRevision: null, text: 'Stale' })))
      .kind,
    'failed',
  );
  f.database.exec('UPDATE personal_state SET epoch=1');
  assert.equal(
    (
      await f.notes.execute(
        save({ noteId: command.noteId, expectedRevision: 1, text: 'Old epoch' }),
      )
    ).kind,
    'failed',
  );
  assert.equal(ready(await f.notes.readRecipeNote(authoredId)).note!.text, command.text);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
});

test('owner retirement during hashing rejects work and suppresses all later access', async (t) => {
  const f = await fixture(t),
    pause = f.pauseHash(),
    command = save();
  const pending = f.notes.execute(command);
  await pause.entered.promise;
  f.setAccess({ ownerId: null, authGeneration: 2 });
  pause.release.resolve();
  assert.equal((await pending).kind, 'failed');
  assert.equal((await f.notes.readState()).kind, 'failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 0);
  assert.equal(f.changes.length, 0);
});

test('close during a reserved read revokes the result and close before COMMIT rolls back identity and note', async (t) => {
  const f = await fixture(t),
    pause = f.pauseInspection();
  const pending = f.notes.readRecipeNote(authoredId);
  await pause.entered.promise;
  f.notes.close();
  pause.release.resolve();
  assert.equal((await pending).kind, 'failed');
  await f.reopen();
  f.writer.setObserver({
    async begin() {},
    async committed() {},
    failed() {},
    async beforeCommit() {
      f.notes.close();
    },
  });
  assert.equal((await f.notes.execute(save())).kind, 'uncertain');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 0);
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(authoredId)!
      .n,
    0,
  );
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 0);
});

test('adoption and restore fences reject a command paused before SQL', async (t) => {
  for (const change of ['adoption', 'restore'] as const) {
    const f = await fixture(t),
      pause = f.pauseHash(),
      command = save();
    const pending = f.notes.execute(command);
    await pause.entered.promise;
    if (change === 'adoption') f.advanceAdoption();
    else
      f.database
        .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
        .run('account-replication:apply-epoch', '1');
    pause.release.resolve();
    assert.notEqual((await pending).kind, 'ready');
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 0);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 0);
  }
});

test('installation and bound-owner mismatches fail before private reads or writes', async (t) => {
  for (const change of ['installation', 'owner'] as const) {
    const f = await fixture(t);
    if (change === 'installation')
      f.database
        .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
        .run(randomUUID());
    else
      f.database
        .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
        .run(
          'account-replication:owner',
          JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }),
        );
    assert.equal((await f.notes.readState()).kind, 'failed');
    assert.equal((await f.notes.execute(save())).kind, 'failed');
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 0);
  }
});

test('unknown IDs, wrong inspection heads and malformed retained notes fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.notes.execute(save({ recipeId: unknownId }))).kind, 'failed');
  assert.equal((await f.notes.readRecipeNote(unknownId)).kind, 'failed');
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(unknownId)!
      .n,
    0,
  );
  ready(await f.notes.execute(save()));
  f.wrongHead();
  assert.equal(
    (await f.notes.execute(save({ recipeId: catalogue.recipes[0]!.recipeId }))).kind,
    'failed',
  );
  f.database.exec("UPDATE recipe_note SET text='123'");
  assert.equal((await f.notes.readRecipeNote(authoredId)).kind, 'failed');
  assert.equal(
    (await f.notes.execute(save({ noteId: randomUUID(), expectedRevision: 1 }))).kind,
    'failed',
  );
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 1);
});

test('lost acknowledgement recovers exact receipt; replay is idempotent and changed payload conflicts', async (t) => {
  const f = await fixture(t),
    command = save();
  f.loseCommit();
  const receipt = ready(await f.notes.execute(command));
  assert.equal(receipt.outcome, 'committed');
  await f.reopen();
  assert.deepEqual(ready(await f.notes.execute(command)), receipt);
  assert.equal((await f.notes.execute({ ...command, text: 'Different request' })).kind, 'failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 1);
  f.unavailable();
  assert.deepEqual(ready(await f.notes.readReceipt(command.operationId)), receipt);
  assert.deepEqual(ready(await f.notes.resolveOperation(command.operationId)), receipt);
});

test('unreadable receipt after committed write returns uncertainty and original ID resolves on reopen', async (t) => {
  const f = await fixture(t),
    command = save();
  f.writer.setObserver({
    async begin() {},
    async beforeCommit() {
      f.failReads();
    },
    async committed() {},
    failed() {},
  });
  f.loseCommit();
  const result = await f.notes.execute(command);
  assert.equal(result.kind, 'uncertain');
  if (result.kind === 'uncertain') assert.equal(result.operationId, command.operationId);
  f.failReads(false);
  await f.reopen();
  assert.equal(ready(await f.notes.resolveOperation(command.operationId)).outcome, 'committed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 1);
});

test('unknown operation creates neutral cancellation fence and cannot later save a note', async (t) => {
  const f = await fixture(t),
    command = save();
  f.unavailable();
  const receipt = ready(await f.notes.resolveOperation(command.operationId));
  assert.equal(receipt.outcome, 'cancelled');
  assert.equal(receipt.commandKind, null);
  assert.equal(receipt.entityId, null);
  f.unavailable(false);
  assert.deepEqual(ready(await f.notes.execute(command)), receipt);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 0);
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(authoredId)!
      .n,
    0,
  );
});

test('unrelated receipt/command kinds and forged cancellation are rejected without mutation', async (t) => {
  const f = await fixture(t),
    operationId = randomUUID(),
    entityId = randomUUID();
  f.database.exec('UPDATE personal_state SET revision=1');
  const receipt = {
    operationId,
    outcome: 'committed',
    commandKind: 'addManualItem',
    entityId,
    revision: 1,
    epoch: 0,
    committedAt: at,
    affectedMemberships: 0,
  };
  f.database
    .prepare('INSERT INTO personal_operation VALUES (?,?,?)')
    .run(operationId, 'a'.repeat(64), JSON.stringify(receipt));
  for (const result of [
    await f.notes.readReceipt(operationId),
    await f.notes.resolveOperation(operationId),
    await f.notes.execute(save({ operationId })),
  ]) {
    assert.equal(result.kind, 'failed');
    assert.equal('value' in result, false);
  }
  const unrelated: PersonalCommand = {
    kind: 'createCollection',
    operationId: randomUUID(),
    expectedEpoch: 0,
    collectionId: randomUUID(),
    name: 'Private list',
  };
  assert.equal((await f.notes.execute(unrelated as unknown as ContentNoteCommand)).kind, 'failed');
  f.database
    .prepare('UPDATE personal_operation SET request_fingerprint=NULL,receipt_json=?')
    .run(JSON.stringify({ ...receipt, outcome: 'cancelled' }));
  assert.equal((await f.notes.resolveOperation(operationId)).kind, 'failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_collection').get()!.n, 0);
});

test('schema8 admission is explicit and leaves legacy5/6 defaults unchanged', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.reader.transaction((session) => readPersonalState(session)),
    { code: 'incompatible_version' },
  );
  const legacy = createPersonalRepository({
    reader: f.reader,
    writer: f.writer,
    platform: { newId: randomUUID, sha256 },
    recipeIds: new Set(catalogue.recipes.map((recipe) => recipe.recipeId)),
    now: () => at,
    onCommitted() {},
  });
  assert.equal((await legacy.readState()).kind, 'failed');
  const six = await fixture(t, 6);
  assert.equal((await six.notes.readState()).kind, 'failed');
  assert.equal((await six.notes.execute(save())).kind, 'failed');
  assert.equal((await six.reader.transaction((session) => readPersonalState(session))).epoch, 0);
  assert.equal(six.database.prepare('PRAGMA user_version').get()!.user_version, 6);
});

test('oversized TEXT and BLOB private clocks are rejected in SQL before any transfer', async (t) => {
  for (const field of [
    'personalRevision',
    'personalEpoch',
    'storeRevision',
    'adoptionRevision',
    'restoreRevision',
  ] as const) {
    for (const kind of ['text', 'blob'] as const) {
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t);
        const oversized = kind === 'text' ? 'x'.repeat(1_048_576) : Buffer.alloc(1_048_576, 120);
        f.database.exec('PRAGMA ignore_check_constraints=ON');
        if (field === 'personalRevision')
          f.database.prepare('UPDATE personal_state SET revision=?').run(oversized);
        else if (field === 'personalEpoch')
          f.database.prepare('UPDATE personal_state SET epoch=?').run(oversized);
        else if (field === 'storeRevision')
          f.database
            .prepare("UPDATE state_revision SET revision=? WHERE collection='store'")
            .run(oversized);
        else if (field === 'adoptionRevision')
          f.database.prepare('UPDATE app_content_adoption SET revision=?').run(oversized);
        else
          f.database
            .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,?,?,?,?)')
            .run(randomUUID(), 'a'.repeat(64), oversized, '{}', '{}', '{}');
        f.database.exec('PRAGMA ignore_check_constraints=OFF');
        const id = randomUUID();
        for (const result of [
          await f.notes.readState(),
          await f.notes.readRecipeNote(authoredId),
          await f.notes.readReceipt(id),
          await f.notes.resolveOperation(id),
          await f.notes.execute(save()),
        ])
          assert.equal(result.kind, 'failed');
        assert.deepEqual(f.oversizedTransfers, []);
        assert.equal(f.database.prepare('SELECT COUNT(*) n FROM recipe_note').get()!.n, 0);
        assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 0);
      });
    }
  }
});

test('a future note revision cannot escape a private read or update', async (t) => {
  const f = await fixture(t),
    command = save();
  ready(await f.notes.execute(command));
  f.database.exec('UPDATE recipe_note SET revision=2');
  assert.equal((await f.notes.readRecipeNote(authoredId)).kind, 'failed');
  assert.equal(
    (
      await f.notes.execute(
        save({ noteId: command.noteId, expectedRevision: 2, text: 'Invalid future edit' }),
      )
    ).kind,
    'failed',
  );
  assert.equal(f.database.prepare('SELECT revision FROM personal_state').get()!.revision, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
});
