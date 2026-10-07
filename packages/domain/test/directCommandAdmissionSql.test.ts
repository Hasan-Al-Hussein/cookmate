import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { CommandResult, LocalCommand, PendingIntent } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import type { StoreChange } from '../src/services';
import {
  createCommandExecutor,
  registerReadyIntent,
  rejectCommand,
  type DirectCommandHooks,
  type DirectRegistrationHooks,
} from '../../../apps/mobile/src/data/commandExecutor';
import { favouriteCommandHandlers } from '../../../apps/mobile/src/data/favouriteCommands';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import { readReceiptInSnapshot } from '../../../apps/mobile/src/data/stateRepositories';
import {
  configureConnection,
  runBound,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function failed(result: CommandResult) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (result.kind !== 'failed') assert.fail();
  assert.equal(result.error.code, 'stale_context');
}

/** Real transactions and independent receipt reads; owner policy is deliberately controlled. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-direct-admission-'));
  const path = join(directory, 'state.sqlite');
  const write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  const writer = new SerializedWriter(write.connection),
    reader = new SerializedReader(read.connection);
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
    {
      installationId: randomUUID(),
      shoppingScopeId: randomUUID(),
      conversationId: randomUUID(),
    },
  );
  // Test-only authority record proves hook writes share the existing intent transaction.
  write.database.exec(
    'CREATE TABLE fixture_direct_authority(operation_id TEXT PRIMARY KEY,owner INTEGER NOT NULL)',
  );
  await read.connection.exec('PRAGMA query_only=ON');
  const controls = {
    owner: 0,
    loseCommitAck: false,
    failRollback: false,
    switchOwnerAfterCommit: false,
    beforeExecuteDenied: false,
    afterReceiptRead: async () => {},
  };
  const counts = {
    enter: 0,
    beforeExecute: 0,
    beforeRegister: 0,
    afterRegister: 0,
    receiptReads: 0,
    commits: 0,
  };
  const events: StoreChange[] = [];
  const assertOwner = (): undefined => {
    if (controls.owner !== 0) rejectCommand('stale_context', 'fixture.direct_owner_changed');
    return undefined;
  };
  const originalExec = write.connection.exec;
  write.connection.exec = async (sql) => {
    if (sql === 'ROLLBACK' && controls.failRollback) throw new Error('Controlled rollback failure');
    if (sql === 'COMMIT') counts.commits++;
    await originalExec(sql);
    if (sql === 'COMMIT') {
      if (controls.switchOwnerAfterCommit) controls.owner = 1;
      if (controls.loseCommitAck) {
        controls.loseCommitAck = false;
        throw new Error('Controlled lost COMMIT acknowledgement');
      }
    }
  };
  const directHooks: DirectCommandHooks = {
    async enter() {
      counts.enter++;
      assertOwner();
      return assertOwner;
    },
    async beforeExecute() {
      counts.beforeExecute++;
      assertOwner();
      if (controls.beforeExecuteDenied)
        rejectCommand('stale_context', 'fixture.direct_admission_changed');
    },
  };
  const registrationHooks: DirectRegistrationHooks = {
    async beforeRegister() {
      counts.beforeRegister++;
      assertOwner();
    },
    async afterRegister(session, intent) {
      counts.afterRegister++;
      for (const slot of intent.slots) {
        const [existing] = await session.all<{ owner: number }>(
          'SELECT owner FROM fixture_direct_authority WHERE operation_id=?',
          [slot.command.operationId],
        );
        if (existing && existing.owner !== controls.owner)
          rejectCommand('stale_context', 'fixture.stored_owner_changed');
        await runBound(
          session,
          'INSERT INTO fixture_direct_authority VALUES (?,?) ON CONFLICT(operation_id) DO NOTHING',
          [slot.command.operationId, controls.owner],
        );
      }
    },
    assertCommitAdmission: assertOwner,
  };
  const scopedReadReceipt = async (operationId: string) => {
    counts.receiptReads++;
    assertOwner();
    const result = await readSnapshot(reader, (session) =>
      readReceiptInSnapshot(session, operationId, catalogueBoundary),
    );
    await controls.afterReceiptRead();
    assertOwner();
    return result;
  };
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: favouriteCommandHandlers,
    directHooks,
    now: () => '2026-10-01T12:00:00.000Z',
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    readReceipt: scopedReadReceipt,
    onCommitted: (change) => events.push(change),
  });
  const intentFor = (command: LocalCommand): PendingIntent => ({
    userIntentId: command.userIntentId,
    revision: command.intentRevision,
    phase: 'ready',
    slots: [{ slotId: randomUUID(), command }],
  });
  const register = (intent: PendingIntent) =>
    registerReadyIntent(writer, intent, catalogueBoundary, platform, undefined, {
      trackDirectRecovery: true,
      hooks: registrationHooks,
    });
  const snapshot = () =>
    [
      'favourite',
      'operation_receipt',
      'pending_intent',
      'command_slot',
      'direct_command_recovery',
      'fixture_direct_authority',
      'state_revision',
    ].map((table) => ({
      table,
      rows: write.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    }));
  return {
    ...executor,
    controls,
    counts,
    events,
    writer,
    write,
    read,
    register,
    intentFor,
    snapshot,
    scopedReadReceipt,
  };
}

test('final synchronous direct admission follows an awaited writer observer and rolls back every command effect', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    proceed = gate();
  const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  const before = f.snapshot(),
    commits = f.counts.commits;
  f.writer.setObserver({
    begin: async () => {},
    beforeCommit: async () => {
      entered.release();
      await proceed.wait;
    },
    committed: async () => {},
    failed: () => {},
  });
  const pending = f.execute(command);
  await entered.wait;
  assert.equal(
    f.write.database.prepare('SELECT COUNT(*) n FROM favourite').get()!.n,
    1,
    'Handler ran inside the uncommitted transaction',
  );
  f.controls.owner = 1;
  proceed.release();
  failed(await pending);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.counts.commits, commits, 'No COMMIT submitted after final admission rejects');
  assert.equal(f.counts.receiptReads, 0);
  assert.deepEqual(f.events, []);
});

test('direct owner admission precedes existing receipt lookup, while admitted receipt retries skip execution checks', async (t) => {
  const f = await fixture(t),
    command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  const original = await f.execute(command);
  assert.equal(original.kind, 'receipt');
  const before = f.snapshot();
  f.controls.beforeExecuteDenied = true;
  assert.deepEqual(await f.execute(command), original);
  assert.equal(f.counts.enter, 2);
  assert.equal(f.counts.beforeExecute, 1, 'Proven receipts do not rerun current mutation checks');
  f.controls.owner = 1;
  failed(await f.execute(command));
  assert.equal(f.counts.enter, 3);
  assert.equal(
    f.counts.receiptReads,
    0,
    'A denied entry must not bypass through historical receipt recovery',
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.events.length, 1);
});

test('beforeExecute refusal after entry cannot create a receipt or invoke the handler', async (t) => {
  const f = await fixture(t),
    command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  const before = f.snapshot();
  f.controls.beforeExecuteDenied = true;
  failed(await f.execute(command));
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.events, []);
});

test('lost COMMIT acknowledgement stays private after owner drift; direct historical recovery requires a separate scoped reader', async (t) => {
  const f = await fixture(t),
    command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  f.controls.loseCommitAck = true;
  f.controls.switchOwnerAfterCommit = true;
  const result = await f.execute(command);
  assert.equal(result.kind, 'uncertain', JSON.stringify(result));
  assert.equal(f.writer.requiresRecovery(), true);
  assert.equal(f.read.database.prepare('SELECT COUNT(*) n FROM favourite').get()!.n, 1);
  assert.equal(f.read.database.prepare('SELECT COUNT(*) n FROM operation_receipt').get()!.n, 1);
  assert.deepEqual(f.events, []);
  const reads = f.counts.receiptReads;
  assert.equal((await f.execute(command)).kind, 'failed');
  assert.equal(
    f.counts.receiptReads,
    reads,
    'Unhealthy writer admission must not reveal historical receipts by fallback',
  );
  await assert.rejects(
    f.readHistoricalReceipt(command),
    /command.direct_receipt_recovery_required/,
  );
  await assert.rejects(f.scopedReadReceipt(command.operationId), /fixture.direct_owner_changed/);
  f.controls.owner = 0;
  f.controls.switchOwnerAfterCommit = false;
  await assert.rejects(
    f.readHistoricalReceipt(command),
    /command.direct_receipt_recovery_required/,
  );
  const resultRead = await f.scopedReadReceipt(command.operationId);
  assert.equal(resultRead.kind, 'ready');
  if (resultRead.kind !== 'ready') assert.fail();
  assert.equal(resultRead.value?.operationId, command.operationId);
  assert.deepEqual(await f.scopedReadReceipt(command.operationId), resultRead);
  assert.deepEqual(f.events, [], 'The assistant-only helper must not announce a direct receipt');
});

test('owner drift during independent lost-ack receipt read suppresses the old-owner result and notification', async (t) => {
  const f = await fixture(t),
    command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  f.controls.loseCommitAck = true;
  f.controls.afterReceiptRead = async () => {
    f.controls.owner = 1;
  };
  const result = await f.execute(command);
  assert.equal(result.kind, 'uncertain', JSON.stringify(result));
  assert.equal(f.counts.receiptReads, 1);
  assert.equal(f.read.database.prepare('SELECT COUNT(*) n FROM operation_receipt').get()!.n, 1);
  assert.deepEqual(f.events, []);
});

test('owner drift during an acknowledged COMMIT reports uncertainty without presenting another owner a success', async (t) => {
  const f = await fixture(t),
    command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  f.controls.switchOwnerAfterCommit = true;
  const result = await f.execute(command);
  assert.equal(result.kind, 'uncertain', JSON.stringify(result));
  assert.equal(f.writer.requiresRecovery(), false, 'The COMMIT itself was acknowledged');
  assert.equal(f.read.database.prepare('SELECT COUNT(*) n FROM operation_receipt').get()!.n, 1);
  assert.deepEqual(f.events, []);
});

test('rejected final admission with failed rollback remains uncertain and does not announce uncommitted effects', async (t) => {
  const f = await fixture(t),
    command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  await f.register(f.intentFor(command));
  const before = f.snapshot(),
    commits = f.counts.commits;
  f.writer.setObserver({
    begin: async () => {},
    beforeCommit: async () => {
      await Promise.resolve();
      f.controls.owner = 1;
    },
    committed: async () => {},
    failed: () => {},
  });
  f.controls.failRollback = true;
  const result = await f.execute(command);
  assert.equal(result.kind, 'uncertain', JSON.stringify(result));
  assert.equal(f.writer.requiresRecovery(), true);
  assert.equal(f.counts.commits, commits);
  assert.equal(f.read.database.prepare('SELECT COUNT(*) n FROM operation_receipt').get()!.n, 0);
  assert.deepEqual(f.events, []);
  // Test cleanup only: production must reopen/reconcile its poisoned writer.
  f.controls.failRollback = false;
  f.write.database.exec('ROLLBACK');
  assert.deepEqual(f.snapshot(), before);
});

test('registration authority, intent, slots and recovery tracking roll back together after awaited observer denial', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    proceed = gate();
  const intent = f.intentFor(
    await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true }),
  );
  const before = f.snapshot(),
    commits = f.counts.commits;
  f.writer.setObserver({
    begin: async () => {},
    beforeCommit: async () => {
      entered.release();
      await proceed.wait;
    },
    committed: async () => {},
    failed: () => {},
  });
  const pending = assert.rejects(f.register(intent), /fixture.direct_owner_changed/);
  await entered.wait;
  assert.equal(
    f.write.database.prepare('SELECT COUNT(*) n FROM fixture_direct_authority').get()!.n,
    1,
  );
  assert.equal(f.write.database.prepare('SELECT COUNT(*) n FROM command_slot').get()!.n, 1);
  f.controls.owner = 1;
  proceed.release();
  await pending;
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.counts.commits, commits);
});

test('registration owner drift during acknowledged COMMIT rejects delivery while preserving only the durable registered intent', async (t) => {
  const f = await fixture(t),
    intent = f.intentFor(await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true }));
  f.controls.switchOwnerAfterCommit = true;
  await assert.rejects(f.register(intent), /fixture.direct_owner_changed/);
  assert.equal(f.writer.requiresRecovery(), false);
  for (const table of [
    'pending_intent',
    'command_slot',
    'direct_command_recovery',
    'fixture_direct_authority',
  ])
    assert.equal(f.read.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 1, table);
  for (const table of ['favourite', 'operation_receipt'])
    assert.equal(f.read.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table);
  assert.deepEqual(f.events, []);
  const before = f.snapshot();
  f.controls.owner = 0;
  f.controls.switchOwnerAfterCommit = false;
  await f.register(intent);
  assert.deepEqual(
    f.snapshot(),
    before,
    'Original authority can retry the exact registration without duplication',
  );
});

test('identical registered-intent retry rechecks both hooks without duplicating authority, and owner drift is refused', async (t) => {
  const f = await fixture(t),
    intent = f.intentFor(await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true }));
  await f.register(intent);
  const before = f.snapshot();
  await f.register(intent);
  assert.equal(f.counts.beforeRegister, 2);
  assert.equal(f.counts.afterRegister, 2);
  assert.deepEqual(f.snapshot(), before);
  f.write.database.exec('UPDATE fixture_direct_authority SET owner=1');
  const changedAuthority = f.snapshot();
  await assert.rejects(f.register(intent), /fixture.stored_owner_changed/);
  assert.equal(f.counts.beforeRegister, 3);
  assert.equal(f.counts.afterRegister, 3);
  assert.deepEqual(
    f.snapshot(),
    changedAuthority,
    'Identical intent is not permission to repair changed authority',
  );
  f.controls.owner = 1;
  await assert.rejects(f.register(intent), /fixture.direct_owner_changed/);
  assert.equal(f.counts.beforeRegister, 4);
  assert.equal(f.counts.afterRegister, 3);
  assert.deepEqual(f.snapshot(), changedAuthority);
});
