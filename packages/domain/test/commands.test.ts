import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import { commandFingerprintInput, validateCommandResult } from '@cookmate/contracts';
import type { LocalCommand, PendingIntent } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import type { StoreChange } from '../src/services';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { favouriteCommandHandlers } from '../../../apps/mobile/src/data/favouriteCommands';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import {
  createStateRepositories,
  readReceiptInSnapshot,
} from '../../../apps/mobile/src/data/stateRepositories';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);

async function commandFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-'));
  const path = join(directory, 'fixture.db');
  const write = desktopConnection(path);
  await configureConnection(write.connection);
  const writer = new SerializedWriter(write.connection);
  const identifiers = {
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
    identifiers,
  );
  const read = desktopConnection(path);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only = ON');
  const reader = new SerializedReader(read.connection);
  const events: StoreChange[] = [];
  const faults = { receiptInsert: false, commitAck: false, reader: false };
  const exec = write.connection.exec;
  write.connection.exec = async (sql) => {
    await exec(sql);
    if (sql === 'COMMIT' && faults.commitAck) {
      faults.commitAck = false;
      throw new Error('lost commit acknowledgement');
    }
  };
  const prepareStatement = write.connection.prepare;
  write.connection.prepare = async (sql) => {
    const statement = await prepareStatement(sql);
    return {
      ...statement,
      run: async (values) => {
        if (faults.receiptInsert && sql.startsWith('INSERT INTO operation_receipt'))
          throw new Error('receipt write fault');
        await statement.run(values);
      },
    };
  };
  const readReceipt = async (operationId: string) => {
    if (faults.reader) throw new Error('reader unavailable');
    return readSnapshot(reader, (session) =>
      readReceiptInSnapshot(session, operationId, catalogueBoundary),
    );
  };
  let context = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: favouriteCommandHandlers,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => context,
    readReceipt,
    onCommitted: (change) => {
      assert.ok(
        write.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()!.count,
      );
      events.push(change);
    },
  });
  return {
    ...executor,
    write,
    writer,
    reader,
    faults,
    events,
    identifiers,
    path,
    readReceipt,
    changeContext: (next: typeof context) => {
      context = next;
    },
    register: async (command: LocalCommand) => {
      const intent: PendingIntent = {
        userIntentId: command.userIntentId,
        revision: command.intentRevision,
        ...(command.origin ? { origin: command.origin } : {}),
        phase: 'ready',
        slots: [{ slotId: randomUUID(), command }],
      };
      await registerReadyIntent(writer, intent, catalogueBoundary, platform);
      return intent;
    },
    close: async () => {
      await reader.close();
      await writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test('registered direct favourite command commits once; duplicate delivery returns the durable receipt', async () => {
  const fixture = await commandFixture();
  try {
    const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    const unregistered = await fixture.execute(command);
    assert.equal(unregistered.kind, 'failed');
    if (unregistered.kind === 'failed') assert.equal(unregistered.error.code, 'stale_context');
    await fixture.register(command);
    const results = await Promise.all([
      fixture.execute(command),
      fixture.execute(command),
      fixture.execute(command),
    ]);
    results.forEach((result) => assert.equal(validateCommandResult(result), true));
    assert.equal(results[0]!.kind, 'receipt');
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.equal(
      fixture.write.database.prepare('SELECT revision FROM favourite').get()?.revision,
      1,
    );
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()
        ?.count,
      1,
    );
    assert.deepEqual(fixture.events, [{ revision: 1, collections: ['favourites'] }]);
    const duplicateIntent = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await fixture.register(duplicateIntent);
    const noOp = await fixture.execute(duplicateIntent);
    assert.equal(noOp.kind, 'receipt');
    if (noOp.kind === 'receipt') assert.equal(noOp.receipt.outcome, 'no_op');
    assert.equal(fixture.events.length, 1);
    for (const saved of [false, true]) {
      const next = await prepare({ kind: 'setFavourite', recipeId: '53064', saved });
      await fixture.register(next);
      assert.equal((await fixture.execute(next)).kind, 'receipt');
    }
    assert.equal(
      fixture.write.database.prepare('SELECT revision FROM favourite').get()?.revision,
      3,
    );
    assert.equal(
      fixture.write.database
        .prepare("SELECT revision FROM state_revision WHERE collection='store'")
        .get()?.revision,
      3,
    );
  } finally {
    await fixture.close();
  }
});

test('changed payload, cancellation and changed intent revisions cannot mutate a registered operation', async () => {
  const fixture = await commandFixture();
  try {
    const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await fixture.register(command);
    await fixture.execute(command);
    const altered = {
      ...command,
      command: {
        ...command.command,
        kind: 'setFavourite' as const,
        recipeId: '53064',
        saved: false,
      },
    };
    altered.payloadFingerprint = await platform.sha256(commandFingerprintInput(altered));
    const conflict = await fixture.execute(altered);
    assert.equal(conflict.kind, 'failed');
    if (conflict.kind === 'failed') assert.equal(conflict.error.code, 'operation_conflict');
    for (const mode of ['cancelled', 'changed'] as const) {
      const next = await prepare({ kind: 'setFavourite', recipeId: '52835', saved: true });
      const intent = await fixture.register(next);
      const changed =
        mode === 'cancelled' ? { ...intent, phase: 'cancelled' } : { ...intent, revision: 1 };
      fixture.write.database
        .prepare(
          'UPDATE pending_intent SET phase=?, revision=?, intent_json=? WHERE user_intent_id=?',
        )
        .run(changed.phase, changed.revision, JSON.stringify(changed), intent.userIntentId);
      const result = await fixture.execute(next);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed')
        assert.equal(result.error.code, mode === 'cancelled' ? 'cancelled' : 'stale_context');
    }
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
      1,
    );
    assert.equal(fixture.write.database.prepare('SELECT saved FROM favourite').get()?.saved, 1);
  } finally {
    await fixture.close();
  }
});

test('receipt insertion failure rolls back mutation, revisions and intent phase, then same operation retries safely', async () => {
  const fixture = await commandFixture();
  try {
    const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await fixture.register(command);
    fixture.faults.receiptInsert = true;
    assert.equal((await fixture.execute(command)).kind, 'failed');
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
      0,
    );
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()
        ?.count,
      0,
    );
    assert.equal(
      fixture.write.database.prepare('SELECT phase FROM pending_intent').get()?.phase,
      'ready',
    );
    assert.equal(
      fixture.write.database
        .prepare("SELECT revision FROM state_revision WHERE collection='store'")
        .get()?.revision,
      0,
    );
    assert.equal(fixture.events.length, 0);
    fixture.faults.receiptInsert = false;
    assert.equal((await fixture.execute(command)).kind, 'receipt');
    assert.deepEqual(
      fixture.write.statementCounts().prepared,
      fixture.write.statementCounts().finalized,
    );
  } finally {
    await fixture.close();
  }
});

test('lost COMMIT acknowledgement reconciles the actual receipt through the independent reader', async () => {
  const fixture = await commandFixture();
  try {
    const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await fixture.register(command);
    fixture.faults.commitAck = true;
    const result = await fixture.execute(command);
    assert.equal(result.kind, 'receipt');
    if (result.kind === 'receipt') assert.equal(result.receipt.operationId, command.operationId);
    assert.equal(
      fixture.write.database.prepare('SELECT revision FROM favourite').get()?.revision,
      1,
    );
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()
        ?.count,
      1,
    );
    assert.deepEqual(await fixture.execute(command), result);
    assert.deepEqual(fixture.events, [{ revision: 1, collections: ['favourites'] }]);
  } finally {
    await fixture.close();
  }
});

test('lost acknowledgement with an unavailable reader remains uncertain until actual receipt recovery', async () => {
  const fixture = await commandFixture();
  try {
    const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await fixture.register(command);
    fixture.faults.commitAck = true;
    fixture.faults.reader = true;
    assert.deepEqual(await fixture.execute(command), {
      kind: 'uncertain',
      operationId: command.operationId,
    });
    fixture.faults.reader = false;
    const receipt = await fixture.readReceipt(command.operationId);
    assert.equal(receipt.kind, 'ready');
    if (receipt.kind === 'ready') assert.equal(receipt.value?.operationId, command.operationId);
    assert.deepEqual(fixture.events, []);
    const retries = await Promise.all([fixture.execute(command), fixture.execute(command)]);
    assert.equal(retries[0]!.kind, 'receipt');
    assert.deepEqual(retries[0], retries[1]);
    assert.deepEqual(fixture.events, [{ revision: 1, collections: ['favourites'] }]);
    assert.equal(
      fixture.write.database.prepare('SELECT revision FROM favourite').get()?.revision,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test('chat origin and relative-date guards reject changed context before running a domain handler', async () => {
  const fixture = await commandFixture();
  try {
    const origin = {
      conversationId: fixture.identifiers.conversationId,
      generation: 0,
      messageId: randomUUID(),
    };
    fixture.write.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
      .run(
        origin.messageId,
        origin.conversationId,
        'user',
        JSON.stringify('Save Alfredo'),
        'complete',
        '2026-09-28T00:00:00.000Z',
      );
    const command = await prepare(
      { kind: 'setFavourite', recipeId: '53064', saved: true },
      { origin },
    );
    await fixture.register(command);
    fixture.write.database.exec('UPDATE conversation SET generation=1');
    const stale = await fixture.execute(command);
    assert.equal(stale.kind, 'failed');
    if (stale.kind === 'failed') assert.equal(stale.error.code, 'stale_context');
    const plan = await prepare(
      {
        kind: 'addPlan',
        occurrenceId: randomUUID(),
        recipeId: '53064',
        placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
        expectedTarget: { kind: 'empty' },
      },
      {
        relativeDateGuard: {
          interpretedAt: { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 },
          resolvedDate: '2026-09-29',
          sourceMessageId: randomUUID(),
        },
      },
    );
    await fixture.register(plan);
    fixture.changeContext({
      localDate: '2026-09-29',
      timeZone: 'Asia/Dubai',
      utcOffsetMinutes: 240,
    });
    const changedDay = await fixture.execute(plan);
    assert.equal(changedDay.kind, 'failed');
    if (changedDay.kind === 'failed')
      assert.equal(changedDay.error.messageKey, 'command.relative_date_changed');
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()
        ?.count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test('executed favourite and its receipt survive file close and no-reseed reopen', async () => {
  const fixture = await commandFixture();
  let reopenedWriter: SerializedWriter | undefined;
  try {
    const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await fixture.register(command);
    const result = await fixture.execute(command);
    await fixture.reader.close();
    await fixture.writer.close();
    const reopened = desktopConnection(fixture.path);
    await configureConnection(reopened.connection);
    reopenedWriter = new SerializedWriter(reopened.connection);
    assert.equal(
      await initializeDatabase(
        reopenedWriter,
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
      ),
      'existing',
    );
    const queries = createStateRepositories(
      new SerializedReader(reopened.connection),
      catalogueBoundary,
    );
    const receipt = await queries.readReceipt(command.operationId);
    assert.equal(receipt.kind, 'ready');
    if (receipt.kind === 'ready' && result.kind === 'receipt')
      assert.deepEqual(receipt.value, result.receipt);
    const favourites = await queries.readFavourites();
    assert.equal(favourites.kind, 'ready');
    if (favourites.kind === 'ready')
      assert.deepEqual(
        favourites.value.map((value) => value.recipeId),
        ['53064'],
      );
  } finally {
    await reopenedWriter?.close();
    await fixture.close();
  }
});

test('cancelling a partially dispatched frozen batch keeps its committed receipt and stops remaining slots', async () => {
  const fixture = await commandFixture();
  try {
    const userIntentId = randomUUID();
    const commands = await Promise.all(
      ['53064', '52835'].map((recipeId) =>
        prepare({ kind: 'setFavourite', recipeId, saved: true }, { userIntentId }),
      ),
    );
    const intent: PendingIntent = {
      userIntentId,
      revision: 0,
      phase: 'ready',
      slots: commands.map((command) => ({ slotId: randomUUID(), command })),
    };
    await registerReadyIntent(fixture.writer, intent, catalogueBoundary, platform);
    const first = await fixture.execute(commands[0]!);
    assert.equal(first.kind, 'receipt');
    assert.equal(
      fixture.write.database.prepare('SELECT phase FROM pending_intent').get()?.phase,
      'dispatched',
    );
    const cancelled = { ...intent, phase: 'reconciling' };
    fixture.write.database
      .prepare('UPDATE pending_intent SET phase=?, intent_json=? WHERE user_intent_id=?')
      .run(cancelled.phase, JSON.stringify(cancelled), userIntentId);
    const second = await fixture.execute(commands[1]!);
    assert.equal(second.kind, 'failed');
    if (second.kind === 'failed') assert.equal(second.error.code, 'cancelled');
    assert.deepEqual(await fixture.execute(commands[0]!), first);
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
      1,
    );
    assert.equal(
      fixture.write.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()
        ?.count,
      1,
    );
  } finally {
    await fixture.close();
  }
});
