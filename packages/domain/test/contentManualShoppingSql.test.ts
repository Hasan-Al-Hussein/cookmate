import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { ManualShoppingFields, PersonalCommand, RepositoryResult } from '../src';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  createContentManualShopping,
  type ContentManualCommand,
} from '../../../apps/mobile/src/data/contentManualShopping';
import { createContentPersonalNotes } from '../../../apps/mobile/src/data/contentPersonalNotes';
import { readPersonalState } from '../../../apps/mobile/src/data/personalRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T14:00:00.000Z';
const fields: ManualShoppingFields = {
  name: 'Coffee filters',
  amountText: null,
  unitText: null,
  category: 'other',
};
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function add(
  overrides: Partial<Extract<ContentManualCommand, { kind: 'addManualItem' }>> = {},
): Extract<ContentManualCommand, { kind: 'addManualItem' }> {
  return {
    kind: 'addManualItem',
    operationId: randomUUID(),
    expectedEpoch: 0,
    itemId: randomUUID(),
    fields: { ...fields },
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
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-manual-'));
  const path = join(directory, 'cooking.db');
  const installationId = randomUUID(),
    seed = desktopConnection(path);
  await configureConnection(seed.connection);
  const initialWriter = new SerializedWriter(seed.connection);
  await initializeDatabase(
    initialWriter,
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
    await migrateCookingContentDatabase(initialWriter, { sha256 });
    await migrateAccountContentHistoryDatabase(initialWriter, { sha256 });
  }
  await initialWriter.close();
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  let readDb!: ReturnType<typeof desktopConnection>, writeDb!: ReturnType<typeof desktopConnection>;
  let reader!: SerializedReader, writer!: SerializedWriter;
  let manual!: ReturnType<typeof createContentManualShopping>,
    notes!: ReturnType<typeof createContentPersonalNotes>;
  let closed = true,
    loseCommit = false,
    failReads = false,
    failReceiptWrite = false;
  let pauseHash:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let pauseRead:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  const changes: unknown[] = [],
    oversizedTransfers: string[] = [],
    recipeReads: string[] = [];
  function inspectRows<Row extends object>(sql: string, rows: Row[]): Row[] {
    if (/\brecipe_(identity|content_revision|content_source)\b/.test(sql)) recipeReads.push(sql);
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
        throw new Error('Lost acknowledgement');
      }
    };
    const prepare = writeDb.connection.prepare;
    writeDb.connection.prepare = async (sql) => {
      if (failReceiptWrite && sql.startsWith('INSERT INTO personal_operation')) {
        failReceiptWrite = false;
        throw new Error('Receipt write failed');
      }
      return prepare(sql);
    };
    const readAll = readDb.connection.all;
    readDb.connection.all = async <Row extends object>(
      sql: string,
      values?: readonly SqlValue[],
    ) => {
      if (failReads && sql.includes('personal_operation'))
        throw new Error('Receipt read unavailable');
      const rows = inspectRows(sql, await readAll<Row>(sql, values));
      if (pauseRead && sql.includes('FROM manual_shopping_item WHERE deleted=0 AND')) {
        const pause = pauseRead;
        pauseRead = undefined;
        pause.entered.resolve();
        await pause.release.promise;
      }
      return rows;
    };
    const writeAll = writeDb.connection.all;
    writeDb.connection.all = async <Row extends object>(
      sql: string,
      values?: readonly SqlValue[],
    ) => inspectRows(sql, await writeAll<Row>(sql, values));
    const options = {
      reader,
      writer,
      installationId,
      now: () => at,
      getAccess: () => access,
      assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
        assert.deepEqual(access, scope);
        return undefined;
      },
      onCommitted: (change: unknown) => changes.push(change),
      platform: {
        newId: randomUUID,
        async sha256(text: string) {
          if (pauseHash) {
            const pause = pauseHash;
            pauseHash = undefined;
            pause.entered.resolve();
            await pause.release.promise;
          }
          return sha256(text);
        },
      },
    };
    manual = createContentManualShopping(options);
    notes = createContentPersonalNotes({
      ...options,
      contentStore: {
        async withVerifiedReferenceInspection(head, refs, work) {
          assert.equal(head, null);
          assert.deepEqual(refs, []);
          return work({
            head: null,
            latestHead: null,
            entries: [],
            adoptedRecipeIds: catalogue.recipes.map((recipe) => recipe.recipeId),
            assertActive: () => undefined,
          });
        },
      },
    });
    closed = false;
  }
  async function close() {
    if (closed) return;
    closed = true;
    manual.close();
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
    get manual() {
      return manual;
    },
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
    recipeReads,
    async reopen() {
      await close();
      await open();
    },
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    loseCommit() {
      loseCommit = true;
    },
    failReads(value = true) {
      failReads = value;
    },
    failReceiptWrite() {
      failReceiptWrite = true;
    },
    pauseHash() {
      const pause = { entered: deferred(), release: deferred() };
      pauseHash = pause;
      return pause;
    },
    pauseRead() {
      const pause = { entered: deferred(), release: deferred() };
      pauseRead = pause;
      return pause;
    },
  };
}

test('manual CRUD, Unicode and purchase semantics survive real reopen without recipe reads or pins', async (t) => {
  const f = await fixture(t),
    command = add({
      fields: { ...fields, name: 'قهوة\u0000☕\ud800', amountText: '2', unitText: 'packs' },
    });
  const identityCount = f.database.prepare('SELECT COUNT(*) n FROM recipe_identity').get()!.n;
  f.manual.subscribe(() => {
    throw new Error('View failed');
  });
  const notifications: unknown[] = [];
  f.manual.subscribe((change) => notifications.push(change));
  const receipt = ready(await f.manual.execute(command));
  assert.equal(receipt.revision, 1);
  assert.equal(notifications.length, 1);
  await f.reopen();
  const item = ready(await f.manual.readManualShopping()).items[0]!;
  assert.equal(item.itemId, command.itemId);
  assert.equal(item.name, command.fields.name);
  assert.equal(item.amountText, '2');
  ready(
    await f.manual.execute({
      kind: 'setManualPurchased',
      operationId: randomUUID(),
      expectedEpoch: 0,
      itemId: item.itemId,
      expectedRevision: 1,
      purchased: true,
    }),
  );
  ready(
    await f.manual.execute({
      kind: 'editManualItem',
      operationId: randomUUID(),
      expectedEpoch: 0,
      itemId: item.itemId,
      expectedRevision: 2,
      fields: { ...command.fields, category: 'pantry' },
    }),
  );
  assert.equal(ready(await f.manual.readManualShopping()).items[0]!.purchased, true);
  ready(
    await f.manual.execute({
      kind: 'editManualItem',
      operationId: randomUUID(),
      expectedEpoch: 0,
      itemId: item.itemId,
      expectedRevision: 3,
      fields: { ...command.fields, amountText: '3' },
    }),
  );
  assert.equal(ready(await f.manual.readManualShopping()).items[0]!.purchased, false);
  ready(
    await f.manual.execute({
      kind: 'deleteManualItem',
      operationId: randomUUID(),
      expectedEpoch: 0,
      itemId: item.itemId,
      expectedRevision: 4,
    }),
  );
  assert.equal(ready(await f.manual.readManualShopping()).total, 0);
  const tombstone = f.database
    .prepare(
      'SELECT name,amount_text,unit_text,category,purchased,deleted,revision FROM manual_shopping_item',
    )
    .get()!;
  assert.deepEqual(
    { ...tombstone },
    {
      name: null,
      amount_text: null,
      unit_text: null,
      category: null,
      purchased: 0,
      deleted: 1,
      revision: 5,
    },
  );
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity').get()!.n,
    identityCount,
  );
  assert.deepEqual(f.recipeReads, []);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM plan_content_pin').get()!.n, 0);
  assert.equal(ready(await f.manual.readState()).revision, 5);
});

test('stable bounded pages reject stale cursors, stale entity/epoch changes and resurrection', async (t) => {
  const f = await fixture(t),
    commands = [add(), add(), add()];
  for (const command of commands) ready(await f.manual.execute(command));
  const first = ready(await f.manual.readManualShopping({ limit: 2 }));
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.equal(first.total, 3);
  const next = ready(await f.manual.readManualShopping({ cursor: first.nextCursor, limit: 2 }));
  assert.equal(next.items.length, 1);
  const item = first.items[0]!;
  ready(
    await f.manual.execute({
      kind: 'setManualPurchased',
      operationId: randomUUID(),
      expectedEpoch: 0,
      itemId: item.itemId,
      expectedRevision: item.revision,
      purchased: true,
    }),
  );
  assert.equal(
    (await f.manual.readManualShopping({ cursor: first.nextCursor, limit: 2 })).kind,
    'failed',
  );
  assert.deepEqual(
    ready(await f.manual.readManualShopping()).items.map((row) => row.itemId),
    [...commands.map((row) => row.itemId)].sort(),
  );
  const stale = {
    kind: 'deleteManualItem' as const,
    operationId: randomUUID(),
    expectedEpoch: 0,
    itemId: item.itemId,
    expectedRevision: item.revision,
  };
  assert.equal((await f.manual.execute(stale)).kind, 'failed');
  f.database.exec('UPDATE personal_state SET epoch=1');
  assert.equal((await f.manual.execute(add())).kind, 'failed');
  ready(
    await f.manual.execute({
      ...stale,
      operationId: randomUUID(),
      expectedEpoch: 1,
      expectedRevision: 4,
    }),
  );
  assert.equal(
    (
      await f.manual.execute({
        kind: 'editManualItem',
        operationId: randomUUID(),
        expectedEpoch: 1,
        itemId: item.itemId,
        expectedRevision: 5,
        fields,
      })
    ).kind,
    'failed',
  );
  assert.equal((await f.manual.readManualShopping({ limit: 51 })).kind, 'failed');
});

test('receipt acknowledgement loss, exact replay, conflicting replay and neutral cancellation preserve identity', async (t) => {
  const f = await fixture(t),
    command = add();
  f.loseCommit();
  const receipt = ready(await f.manual.execute(command));
  await f.reopen();
  assert.deepEqual(ready(await f.manual.execute(command)), receipt);
  assert.equal(
    (await f.manual.execute({ ...command, fields: { ...fields, name: 'Different request' } })).kind,
    'failed',
  );
  assert.deepEqual(ready(await f.manual.readReceipt(command.operationId)), receipt);
  const cancelled = add(),
    fence = ready(await f.manual.resolveOperation(cancelled.operationId));
  assert.equal(fence.outcome, 'cancelled');
  assert.equal(fence.commandKind, null);
  assert.equal(fence.entityId, null);
  assert.deepEqual(ready(await f.manual.execute(cancelled)), fence);
  assert.equal(ready(await f.manual.readManualShopping()).total, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 2);
});

test('failed receipt insert rolls back item and uncertain acknowledgement recovers after reopen', async (t) => {
  const f = await fixture(t),
    command = add();
  f.failReceiptWrite();
  assert.equal((await f.manual.execute(command)).kind, 'failed');
  assert.equal(ready(await f.manual.readManualShopping()).total, 0);
  f.writer.setObserver({
    async begin() {},
    async beforeCommit() {
      f.failReads();
    },
    async committed() {},
    failed() {},
  });
  f.loseCommit();
  const result = await f.manual.execute(command);
  assert.equal(result.kind, 'uncertain');
  if (result.kind === 'uncertain') assert.equal(result.operationId, command.operationId);
  f.failReads(false);
  await f.reopen();
  assert.equal(ready(await f.manual.resolveOperation(command.operationId)).outcome, 'committed');
  assert.equal(ready(await f.manual.readManualShopping()).total, 1);
});

test("manual and note facades share the queue but reject each other's commands and durable receipts", async (t) => {
  const f = await fixture(t),
    manual = add();
  const note: Extract<PersonalCommand, { kind: 'saveNote' }> = {
    kind: 'saveNote',
    operationId: randomUUID(),
    expectedEpoch: 0,
    noteId: randomUUID(),
    recipeId: catalogue.recipes[0]!.recipeId,
    expectedRevision: null,
    text: 'Private note',
  };
  const results = await Promise.all([f.manual.execute(manual), f.notes.execute(note)]);
  results.forEach(ready);
  for (const result of [
    await f.manual.readReceipt(note.operationId),
    await f.manual.resolveOperation(note.operationId),
    await f.manual.execute({ ...manual, operationId: note.operationId }),
    await f.notes.readReceipt(manual.operationId),
    await f.notes.resolveOperation(manual.operationId),
    await f.notes.execute({ ...note, operationId: manual.operationId }),
    await f.manual.execute(note as unknown as ContentManualCommand),
  ]) {
    assert.equal(result.kind, 'failed');
    assert.equal('value' in result, false);
  }
  assert.equal(ready(await f.manual.readManualShopping()).items[0]!.name, fields.name);
  assert.equal(ready(await f.notes.readRecipeNote(note.recipeId)).note!.text, note.text);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 2);
});

test('close during read and owner retirement during hashing suppress late private results', async (t) => {
  const f = await fixture(t);
  ready(await f.manual.execute(add()));
  const readPause = f.pauseRead(),
    reading = f.manual.readManualShopping();
  await readPause.entered.promise;
  f.manual.close();
  readPause.release.resolve();
  assert.equal((await reading).kind, 'failed');
  await f.reopen();
  const pause = f.pauseHash(),
    saving = f.manual.execute(add());
  await pause.entered.promise;
  f.setAccess({ ownerId: null, authGeneration: 2 });
  pause.release.resolve();
  assert.equal((await saving).kind, 'failed');
  assert.equal((await f.manual.readState()).kind, 'failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM manual_shopping_item').get()!.n, 1);
});

test('final commit admission rolls back on close and postcommit subscriber revocation preserves recoverable receipt', async (t) => {
  const f = await fixture(t);
  f.writer.setObserver({
    async begin() {},
    async beforeCommit() {
      f.manual.close();
    },
    async committed() {},
    failed() {},
  });
  assert.equal((await f.manual.execute(add())).kind, 'uncertain');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM manual_shopping_item').get()!.n, 0);
  await f.reopen();
  const command = add();
  let later = 0;
  f.manual.subscribe(() => f.setAccess({ ownerId: null, authGeneration: 2 }));
  f.manual.subscribe(() => {
    later++;
  });
  const result = await f.manual.execute(command);
  assert.equal(result.kind, 'uncertain');
  assert.equal(later, 0);
  await f.reopen();
  assert.equal(ready(await f.manual.readReceipt(command.operationId))!.outcome, 'committed');
});

test('owner, installation, restore and adoption changes cannot cross admission', async (t) => {
  for (const boundary of ['owner', 'installation', 'restore', 'adoption'] as const)
    await t.test(boundary, async (t) => {
      const f = await fixture(t),
        pause = f.pauseHash(),
        saving = f.manual.execute(add());
      await pause.entered.promise;
      if (boundary === 'owner')
        f.database
          .prepare('INSERT INTO app_metadata VALUES (?,?)')
          .run(
            'account-replication:owner',
            JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }),
          );
      if (boundary === 'installation')
        f.database
          .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
          .run(randomUUID());
      if (boundary === 'restore')
        f.database
          .prepare('INSERT INTO app_metadata VALUES (?,?)')
          .run('account-replication:apply-epoch', '1');
      if (boundary === 'adoption')
        f.database.exec('UPDATE app_content_adoption SET revision=revision+1');
      pause.release.resolve();
      assert.notEqual((await saving).kind, 'ready');
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM manual_shopping_item').get()!.n, 0);
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 0);
    });
});

test('untrusted input is owned without invoking getters and unknown fields or families never write', async (t) => {
  const f = await fixture(t),
    pause = f.pauseHash(),
    command = add(),
    saving = f.manual.execute(command);
  await pause.entered.promise;
  command.fields.name = 'Caller mutation';
  pause.release.resolve();
  ready(await saving);
  assert.equal(ready(await f.manual.readManualShopping()).items[0]!.name, fields.name);
  let getterCalls = 0;
  const input = Object.defineProperty({}, 'cursor', {
    get() {
      getterCalls++;
      return '';
    },
    enumerable: true,
  });
  assert.equal((await f.manual.readManualShopping(input)).kind, 'failed');
  assert.equal(getterCalls, 0);
  assert.equal(
    (await f.manual.execute({ ...add(), extra: true } as unknown as ContentManualCommand)).kind,
    'failed',
  );
  assert.equal(
    (await f.manual.execute({ ...add(), fields: { ...fields, name: 'x'.repeat(161) } })).kind,
    'failed',
  );
  assert.equal(
    (
      await f.manual.execute({
        kind: 'createCollection',
        operationId: randomUUID(),
        expectedEpoch: 0,
        collectionId: randomUUID(),
        name: 'List',
      } as unknown as ContentManualCommand)
    ).kind,
    'failed',
  );
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
});

test('manual schema8 admission remains explicit while default schema6 parser stays usable', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.reader.transaction((session) => readPersonalState(session)),
    { code: 'incompatible_version' },
  );
  const six = await fixture(t, 6);
  assert.equal((await six.manual.readState()).kind, 'failed');
  assert.equal((await six.manual.execute(add())).kind, 'failed');
  assert.equal((await six.reader.transaction((session) => readPersonalState(session))).epoch, 0);
  assert.equal(six.database.prepare('PRAGMA user_version').get()!.user_version, 6);
});

test('collection receipts, forged cancellation and future receipt clocks are never disclosed or resolved', async (t) => {
  const f = await fixture(t),
    command = add();
  ready(await f.manual.execute(command));
  const receipt = ready(await f.manual.readReceipt(command.operationId))!;
  for (const replacement of [
    { ...receipt, commandKind: 'createCollection' },
    { ...receipt, outcome: 'cancelled' },
    { ...receipt, revision: receipt.revision + 1 },
    { ...receipt, epoch: receipt.epoch + 1 },
    { ...receipt, affectedMemberships: 1 },
  ]) {
    f.database
      .prepare('UPDATE personal_operation SET receipt_json=?')
      .run(JSON.stringify(replacement));
    for (const result of [
      await f.manual.readReceipt(command.operationId),
      await f.manual.resolveOperation(command.operationId),
    ]) {
      assert.equal(result.kind, 'failed');
      assert.equal('value' in result, false);
    }
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM manual_shopping_item').get()!.n, 1);
});

test('oversized receipt scalars are rejected before the SQL bridge can materialize them', async (t) => {
  for (const field of ['operation_id', 'request_fingerprint', 'receipt_json'] as const)
    for (const kind of ['text', 'blob'] as const)
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t),
          command = add();
        ready(await f.manual.execute(command));
        const oversized = kind === 'text' ? 'x'.repeat(1_048_576) : Buffer.alloc(1_048_576, 120);
        f.database.exec('PRAGMA ignore_check_constraints=ON');
        f.database.prepare(`UPDATE personal_operation SET ${field}=?`).run(oversized);
        f.database.exec('PRAGMA ignore_check_constraints=OFF');
        assert.equal((await f.manual.readReceipt(command.operationId)).kind, 'failed');
        assert.equal((await f.manual.resolveOperation(command.operationId)).kind, 'failed');
        assert.equal((await f.manual.execute(add())).kind, 'failed');
        assert.deepEqual(f.oversizedTransfers, []);
      });
});

test('oversized manual TEXT/BLOB fields cannot cross either SQL bridge', async (t) => {
  for (const field of [
    'item_id',
    'name',
    'amount_text',
    'unit_text',
    'category',
    'purchased',
    'deleted',
    'revision',
    'created_at',
    'updated_at',
  ] as const) {
    for (const kind of ['text', 'blob'] as const)
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t),
          command = add();
        ready(await f.manual.execute(command));
        const oversized = kind === 'text' ? 'x'.repeat(1_048_576) : Buffer.alloc(1_048_576, 120);
        f.database.exec('PRAGMA ignore_check_constraints=ON');
        f.database.prepare(`UPDATE manual_shopping_item SET ${field}=?`).run(oversized);
        f.database.exec('PRAGMA ignore_check_constraints=OFF');
        assert.equal((await f.manual.readManualShopping()).kind, 'failed');
        assert.equal((await f.manual.execute(add())).kind, 'failed');
        assert.deepEqual(f.oversizedTransfers, []);
        assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
      });
  }
});

test('future entity revisions, malformed text and invalid tombstones cannot escape reads', async (t) => {
  for (const corruption of ['revision=2', "name='123'", 'deleted=1'] as const)
    await t.test(corruption, async (t) => {
      const f = await fixture(t);
      ready(await f.manual.execute(add()));
      f.database.exec('PRAGMA ignore_check_constraints=ON');
      f.database.exec(`UPDATE manual_shopping_item SET ${corruption}`);
      f.database.exec('PRAGMA ignore_check_constraints=OFF');
      assert.equal((await f.manual.readManualShopping()).kind, 'failed');
    });
});

test('active count, retained tombstone count and aggregate bytes are bounded before row transfer', async (t) => {
  for (const limit of ['active', 'retained', 'bytes'] as const)
    await t.test(limit, async (t) => {
      const f = await fixture(t),
        count = limit === 'active' ? 5001 : limit === 'retained' ? 20001 : 4500;
      const deleted = limit === 'retained';
      f.database.exec('UPDATE personal_state SET revision=1');
      const name = deleted
        ? null
        : JSON.stringify(limit === 'bytes' ? '\u0001'.repeat(160) : 'Item');
      const amount = limit === 'bytes' ? JSON.stringify('\u0001'.repeat(80)) : null;
      f.database
        .prepare(
          `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<?) INSERT INTO manual_shopping_item SELECT printf('00000000-0000-4000-8000-%012d',n),?,?,?, ?,0,?,1,?,? FROM rows`,
        )
        .run(count, name, amount, amount, deleted ? null : 'other', deleted ? 1 : 0, at, at);
      assert.equal((await f.manual.readManualShopping()).kind, 'failed');
      assert.equal((await f.manual.execute(add())).kind, 'failed');
      assert.deepEqual(f.oversizedTransfers, []);
    });
});
