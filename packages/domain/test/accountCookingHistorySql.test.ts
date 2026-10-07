import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { ACCOUNT_SNAPSHOT_MAX_BYTES } from '@cookmate/account-sync';
import type { AccountCookingHistoryEntry } from '@cookmate/account-sync';
import { cookingContentIdentity } from '../src/cooking';
import type { CookingHistoryEntry, RepositoryResult, SaveCookedInput } from '../src';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import {
  createCookingRepository,
  readCookingHistoryForBackup,
} from '../../../apps/mobile/src/data/cookingRepository';
import {
  captureHistoryWithdrawalIds,
  historyCount,
  readHistoryWithdrawalIds,
} from '../../../apps/mobile/src/data/cookingHistoryRows';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const recipe = catalogue.recipes[0]!;
const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
function ready<T>(value: RepositoryResult<T> | { kind: 'uncertain' }): T {
  assert.equal(value.kind, 'ready', JSON.stringify(value));
  if (value.kind !== 'ready') assert.fail();
  return value.value;
}
const wire = (value: CookingHistoryEntry): AccountCookingHistoryEntry => {
  const { revision: _revision, historyEpoch: _epoch, ...entry } = value;
  return entry;
};
async function fixture(bound = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-account-cooking-'));
  const filename = join(directory, 'store.db');
  const write = desktopConnection(filename);
  await configureConnection(write.connection);
  const queue = new SqlTransactionQueue();
  const writer = new SerializedWriter(write.connection, queue);
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId: randomUUID() },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  const read = desktopConnection(filename);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const reader = new SerializedReader(read.connection, queue);
  const metrics = {
    queries: 0,
    payloadRows: 0,
    payloadBytes: 0,
    maximumPayloadRows: 0,
    duplicateKeyQueries: 0,
  };
  for (const handle of [read, write]) {
    const originalAll = handle.connection.all;
    handle.connection.all = async <Row extends object>(
      sql: string,
      values?: readonly SqlValue[],
    ): Promise<Row[]> => {
      const rows = await originalAll<Row>(sql, values);
      metrics.queries++;
      if (sql.includes('duplicates AS')) metrics.duplicateKeyQueries++;
      let payloadRows = 0;
      for (const row of rows) {
        const fields = row as Record<string, unknown>;
        for (const field of ['entryJson', 'receiptJson']) {
          if (typeof fields[field] === 'string') {
            payloadRows++;
            metrics.payloadBytes += Buffer.byteLength(fields[field]);
          }
        }
      }
      metrics.payloadRows += payloadRows;
      metrics.maximumPayloadRows = Math.max(metrics.maximumPayloadRows, payloadRows);
      return rows;
    };
  }
  const db = write.database;
  const bind = (id: string | null) => {
    if (id === null) db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
    else
      db.prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId: id }));
  };
  if (bound) bind(owner);
  let failClear = false;
  let loseCommit = false;
  const originalPrepare = write.connection.prepare;
  write.connection.prepare = async (sql) => {
    if (failClear && sql.startsWith('INSERT INTO cooking_history_clear')) {
      failClear = false;
      throw new Error('injected clear receipt failure');
    }
    return originalPrepare(sql);
  };
  const originalExec = write.connection.exec;
  write.connection.exec = async (sql) => {
    await originalExec(sql);
    if (loseCommit && sql === 'COMMIT') {
      loseCommit = false;
      throw new Error('injected lost commit response');
    }
  };
  const notifications: unknown[] = [];
  const options = {
    reader,
    writer,
    platform,
    catalogue: catalogue.identity,
    readRecipe: (id: string) => catalogue.recipes.find((row) => row.recipeId === id),
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    onCommitted: (change: unknown) => {
      notifications.push(change);
    },
  };
  const cooking = createCookingRepository(options);
  const identity = await cookingContentIdentity(recipe, catalogue.identity, platform.sha256);
  const input = (eventId: string = randomUUID()): SaveCookedInput => ({
    eventId,
    recipeId: recipe.recipeId,
    contentFingerprint: identity.contentFingerprint,
    readerVersion: 1,
    expectedHistoryEpoch: Number(
      db.prepare('SELECT history_epoch FROM cooking_state').get()!.history_epoch,
    ),
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    note: 'private local note',
  });
  const entry = (eventId: string = randomUUID()): AccountCookingHistoryEntry => ({
    ...identity,
    eventId,
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'private account note',
  });
  const project = (value: AccountCookingHistoryEntry, id = owner) => {
    db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
      id,
      value.eventId,
      JSON.stringify(value),
    );
    db.exec('UPDATE cooking_state SET history_revision=MAX(history_revision,1)');
  };
  const imported = (value = entry()) => {
    const restoreId = randomUUID();
    db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
      restoreId,
      'a'.repeat(64),
      '{}',
      '{}',
      '{}',
    );
    const result: CookingHistoryEntry = {
      ...value,
      origin: 'backup',
      revision: 1,
      historyEpoch: 0,
    };
    db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
      result.eventId,
      randomUUID(),
      restoreId,
      result.cookedOn,
      result.recordedAt,
      JSON.stringify(result),
    );
    db.exec('UPDATE cooking_state SET history_revision=MAX(history_revision,1)');
    return result;
  };
  return {
    db,
    reader,
    writer,
    cooking,
    notifications,
    bind,
    input,
    entry,
    project,
    imported,
    metrics,
    resetMetrics: () => {
      for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] = 0;
    },
    recreate: () => createCookingRepository(options),
    remove: (eventId: string, id = owner) =>
      db.prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)').run(id, eventId),
    failClear: () => {
      failClear = true;
    },
    loseCommit: () => {
      loseCommit = true;
    },
    count: () =>
      reader.transaction(async (session) =>
        historyCount(
          session,
          Number(db.prepare('SELECT history_epoch FROM cooking_state').get()!.history_epoch),
        ),
      ),
    async save(inputValue = input()) {
      const receipt = ready(await cooking.saveCooked(inputValue));
      assert.equal(receipt.kind, 'saved');
      if (receipt.kind !== 'saved') assert.fail();
      return { input: inputValue, event: receipt.event, receipt };
    },
    async close() {
      cooking.close();
      await reader.close();
      await writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test('guest schema six keeps local save/history/clear behavior with empty account tables', async () => {
  const f = await fixture(false);
  try {
    assert.equal(await f.count(), 0);
    const saved = await f.save();
    assert.deepEqual(ready(await f.cooking.readHistory()).items, [saved.event]);
    const cleared = ready(
      await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()),
    );
    assert.equal(cleared.clearedCount, 1);
    assert.equal(ready(await f.cooking.readCookedReceipt(saved.event.eventId))!.kind, 'cleared');
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!.count,
      0,
    );
    assert.deepEqual(await f.reader.transaction(readHistoryWithdrawalIds), [saved.event.eventId]);
  } finally {
    await f.close();
  }
});

test('history union preserves IDs and source facts, deduplicates exact wire entries, and pages stably', async () => {
  const f = await fixture();
  try {
    const local = await f.save();
    const portable = f.imported();
    const account = f.entry();
    const accountBackup = { ...f.entry(), origin: 'backup' as const };
    f.project(wire(local.event));
    f.project(wire(portable));
    f.project(account);
    f.project(accountBackup);
    f.db.exec('UPDATE cooking_state SET history_revision=9');
    assert.equal(await f.count(), 4);
    const first = ready(await f.cooking.readHistory({ limit: 2 }));
    const second = ready(await f.cooking.readHistory({ limit: 2, cursor: first.nextCursor! }));
    const items = [...first.items, ...second.items];
    assert.equal(new Set(items.map((row) => row.eventId)).size, 4);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      items.find((row) => row.eventId === local.event.eventId),
      local.event,
    );
    assert.deepEqual(
      items.find((row) => row.eventId === portable.eventId),
      portable,
    );
    assert.deepEqual(
      items.find((row) => row.eventId === account.eventId),
      { ...account, historyEpoch: 0, revision: 9 },
    );
    assert.equal(items.find((row) => row.eventId === accountBackup.eventId)!.origin, 'backup');
    assert.equal(ready(await f.cooking.readCookedReceipt(account.eventId)), null);
    assert.deepEqual(ready(await f.cooking.readCookedReceipt(local.event.eventId)), local.receipt);
    const exported = await f.reader.transaction(readCookingHistoryForBackup);
    assert.deepEqual(
      exported.map((row) => row.eventId),
      items.map((row) => row.eventId),
    );
  } finally {
    await f.close();
  }
});

test('same event ID with different immutable content blocks page, count and clear review', async () => {
  for (const source of ['local', 'portable'] as const) {
    const f = await fixture();
    try {
      const original = source === 'local' ? (await f.save()).event : f.imported();
      f.project({ ...wire(original), note: 'different content under identical ID' });
      assert.equal((await f.cooking.readHistory()).kind, 'failed');
      await assert.rejects(f.count(), /Stored cooking history identity is invalid/);
      assert.equal((await f.cooking.reviewClearHistory()).kind, 'failed');
      if (source === 'local')
        assert.equal(ready(await f.cooking.readCookedReceipt(original.eventId))!.kind, 'saved');
    } finally {
      await f.close();
    }
  }
});

test('withdrawals suppress visible local and portable entries without destroying genuine local receipt authority', async () => {
  const f = await fixture();
  try {
    const local = await f.save();
    const portable = f.imported();
    f.remove(local.event.eventId);
    f.remove(portable.eventId);
    assert.equal(await f.count(), 0);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    assert.deepEqual(ready(await f.cooking.readCookedReceipt(local.event.eventId)), local.receipt);
    assert.deepEqual(ready(await f.cooking.saveCooked(local.input)), local.receipt);
    assert.deepEqual(
      ready(await f.cooking.resolveCookedOperation(local.event.eventId)),
      local.receipt,
    );
    assert.equal(ready(await f.cooking.readCookedReceipt(portable.eventId)), null);
  } finally {
    await f.close();
  }
});

test('new commands cannot turn account or withdrawn IDs into saved or cancelled local receipts', async () => {
  const f = await fixture();
  try {
    const account = f.entry();
    const withdrawnId = randomUUID();
    f.project(account);
    f.remove(withdrawnId);
    for (const eventId of [account.eventId, withdrawnId]) {
      assert.equal(ready(await f.cooking.readCookedReceipt(eventId)), null);
      assert.equal((await f.cooking.saveCooked(f.input(eventId))).kind, 'failed');
      assert.equal((await f.cooking.resolveCookedOperation(eventId)).kind, 'failed');
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM cooking_event').get()!.count, 0);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM cooking_history_clear').get()!.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('clear withdraws exact known IDs before projection deletion, redacts local history, and recovers only real clear receipt', async () => {
  const f = await fixture();
  try {
    const local = await f.save();
    const portable = f.imported();
    const lineage = f.db
      .prepare('SELECT source_event_id FROM imported_cooking_history WHERE event_id=?')
      .get(portable.eventId)!.source_event_id as string;
    const account = f.entry();
    f.project(account);
    const oldRemoval = randomUUID();
    f.remove(oldRemoval);
    const review = ready(await f.cooking.reviewClearHistory());
    assert.equal(review.count, 3);
    const operationId = randomUUID();
    const receipt = ready(await f.cooking.clearHistory(review, operationId));
    assert.equal(receipt.clearedCount, 3);
    assert.deepEqual(
      f.db
        .prepare('SELECT event_id FROM account_cooking_history_removed ORDER BY event_id')
        .all()
        .map((row) => row.event_id),
      [local.event.eventId, portable.eventId, lineage, account.eventId, oldRemoval].sort(),
    );
    assert.deepEqual(
      await f.reader.transaction(readHistoryWithdrawalIds),
      [local.event.eventId, portable.eventId, lineage, account.eventId, oldRemoval].sort(),
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history').get()!.count,
      0,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM imported_cooking_history').get()!.count,
      0,
    );
    assert.equal(f.db.prepare('SELECT receipt_json FROM cooking_event').get()!.receipt_json, null);
    assert.equal(await f.count(), 0);
    assert.deepEqual(ready(await f.recreate().clearHistory(review, operationId)), receipt);
    assert.equal((await f.cooking.saveCooked(f.input(account.eventId))).kind, 'failed');
    assert.equal(ready(await f.cooking.readCookedReceipt(account.eventId)), null);
    assert.equal(ready(await f.cooking.readCookedReceipt(local.event.eventId))!.kind, 'cleared');
  } finally {
    await f.close();
  }
});

test('clear rejects changed exact IDs or owner even when count/revision are unchanged', async () => {
  const f = await fixture();
  try {
    const original = f.entry();
    f.project(original);
    const review = ready(await f.cooking.reviewClearHistory());
    f.db.prepare('DELETE FROM account_cooking_history WHERE event_id=?').run(original.eventId);
    f.project(f.entry());
    assert.equal((await f.cooking.clearHistory(review, randomUUID())).kind, 'failed');
    const second = ready(await f.cooking.reviewClearHistory());
    f.db.exec('DELETE FROM account_cooking_history');
    f.bind(otherOwner);
    f.project(original, otherOwner);
    assert.equal((await f.cooking.clearHistory(second, randomUUID())).kind, 'failed');
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!.count,
      0,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM cooking_history_clear').get()!.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('a failed clear receipt rolls back withdrawals, account deletion and genuine local receipt redaction', async () => {
  const f = await fixture();
  try {
    const local = await f.save();
    const account = f.entry();
    f.project(account);
    const review = ready(await f.cooking.reviewClearHistory());
    f.failClear();
    assert.equal((await f.cooking.clearHistory(review, randomUUID())).kind, 'failed');
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!.count,
      0,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history').get()!.count,
      1,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM cooking_history_withdrawal').get()!.count,
      0,
    );
    assert.deepEqual(ready(await f.cooking.readCookedReceipt(local.event.eventId)), local.receipt);
    assert.equal(await f.count(), 2);
  } finally {
    await f.close();
  }
});

test('lost clear COMMIT acknowledgement recovers the durable receipt without recreating history', async () => {
  const f = await fixture();
  try {
    f.project(f.entry());
    const review = ready(await f.cooking.reviewClearHistory());
    const operationId = randomUUID();
    f.loseCommit();
    const receipt = ready(await f.cooking.clearHistory(review, operationId));
    assert.equal(receipt.clearedCount, 1);
    assert.deepEqual(ready(await f.cooking.readClearHistoryReceipt(operationId)), receipt);
    assert.equal(await f.count(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM cooking_event').get()!.count, 0);
  } finally {
    await f.close();
  }
});

test('guest contamination and foreign-owner rows fail closed before history becomes visible', async () => {
  for (const bound of [false, true]) {
    const f = await fixture(bound);
    try {
      f.project(f.entry(), otherOwner);
      assert.equal((await f.cooking.readHistory()).kind, 'failed');
      assert.equal((await f.cooking.reviewClearHistory()).kind, 'failed');
      await assert.rejects(f.count());
      assert.equal((await f.cooking.saveCooked(f.input())).kind, 'failed');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM cooking_event').get()!.count, 0);
    } finally {
      await f.close();
    }
  }
});

test('local cancellation, clear and prior epochs suppress account projection but retain local recovery fences', async () => {
  const f = await fixture();
  try {
    const cancelledId = randomUUID();
    ready(await f.cooking.resolveCookedOperation(cancelledId));
    const old = await f.save();
    const cleared = await f.save();
    f.db
      .prepare(
        "UPDATE cooking_event SET state='cleared',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL WHERE event_id=?",
      )
      .run(cleared.event.eventId);
    f.db.exec('UPDATE cooking_state SET history_epoch=1');
    f.project(f.entry(cancelledId));
    f.project(wire(old.event));
    f.project(wire(cleared.event));
    assert.equal(await f.count(), 0);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    assert.equal(ready(await f.cooking.readCookedReceipt(cancelledId))!.kind, 'cancelled');
    assert.equal(ready(await f.cooking.readCookedReceipt(cleared.event.eventId))!.kind, 'cleared');
    const receipt = ready(
      await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()),
    );
    assert.equal(receipt.clearedCount, 0);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!.count,
      3,
    );
  } finally {
    await f.close();
  }
});

test('duplicate validation crosses bounded batches without losing exact identity or page entries', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 17; index++) {
      const local = await f.save();
      f.project(wire(local.event));
    }
    f.resetMetrics();
    assert.equal(await f.count(), 17);
    assert.equal(f.metrics.duplicateKeyQueries, 1);
    assert.equal(f.metrics.payloadRows, 34);
    assert.ok(f.metrics.maximumPayloadRows <= 32);
    assert.equal(ready(await f.cooking.readHistory({ limit: 50 })).items.length, 17);
  } finally {
    await f.close();
  }
});

test('guest clear retains portable source lineage and suppresses stale history after later owner binding', async () => {
  const f = await fixture(false);
  try {
    const portable = f.imported();
    const sourceId = f.db.prepare('SELECT source_event_id FROM imported_cooking_history').get()!
      .source_event_id as string;
    const captured = await f.reader.transaction((session) =>
      captureHistoryWithdrawalIds(session, [portable.eventId]),
    );
    assert.deepEqual(captured, [portable.eventId, sourceId].sort());
    ready(await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()));
    assert.deepEqual(await f.reader.transaction(readHistoryWithdrawalIds), captured);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!.count,
      0,
    );
    f.bind(owner);
    f.project(f.entry(sourceId));
    assert.equal(await f.count(), 0);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    assert.equal((await f.cooking.saveCooked(f.input(sourceId))).kind, 'failed');
    assert.equal((await f.cooking.resolveCookedOperation(sourceId)).kind, 'failed');
    assert.equal(ready(await f.cooking.readCookedReceipt(sourceId)), null);
  } finally {
    await f.close();
  }
});

test('withdrawal union bounds fail before any clear writes instead of dropping known IDs', async () => {
  const f = await fixture(false);
  try {
    const insert = f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)');
    f.db.exec('BEGIN');
    for (let index = 0; index < 10000; index++) insert.run(randomUUID());
    f.db.exec('COMMIT');
    const local = await f.save();
    assert.equal((await f.cooking.reviewClearHistory()).kind, 'failed');
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM cooking_history_withdrawal').get()!.count,
      10000,
    );
    assert.deepEqual(ready(await f.cooking.readCookedReceipt(local.event.eventId)), local.receipt);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM cooking_history_clear').get()!.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('near-limit account history materializes only selected page payloads and no payloads for count or ID rejection', async (context) => {
  const f = await fixture();
  try {
    const template = { ...f.entry(), note: '🍲'.repeat(2000) };
    const rowBytes = Buffer.byteLength(JSON.stringify(template));
    const count = Math.floor((ACCOUNT_SNAPSHOT_MAX_BYTES - 16384) / rowBytes);
    assert.ok(count * rowBytes > 1900000);
    f.db.exec('BEGIN');
    for (let index = 0; index < count; index++) f.project({ ...template, eventId: randomUUID() });
    f.db.exec('COMMIT');
    const eventId = f.db.prepare('SELECT event_id FROM account_cooking_history LIMIT 1').get()!
      .event_id as string;
    const observations: Record<string, unknown> = {
      storedRows: count,
      storedBytes: count * rowBytes,
    };
    f.resetMetrics();
    assert.equal(ready(await f.cooking.readHistory({ limit: 5 })).items.length, 5);
    observations.page = { ...f.metrics };
    f.resetMetrics();
    assert.equal(await f.count(), count);
    observations.count = { ...f.metrics };
    f.resetMetrics();
    assert.equal((await f.cooking.saveCooked(f.input(eventId))).kind, 'failed');
    observations.idRejection = { ...f.metrics };
    context.diagnostic(JSON.stringify(observations));
    const page = observations.page as typeof f.metrics;
    const counted = observations.count as typeof f.metrics;
    const rejected = observations.idRejection as typeof f.metrics;
    assert.equal(page.payloadRows, 6);
    assert.equal(counted.payloadRows, 0);
    assert.equal(rejected.payloadRows, 0);
    assert.ok(page.payloadBytes <= rowBytes * 6);
  } finally {
    await f.close();
  }
});

test('clearing a guest prior epoch retains its local event ID before a later owner binding', async () => {
  const f = await fixture(false);
  try {
    const local = await f.save();
    f.db.exec('UPDATE cooking_state SET history_epoch=1');
    assert.equal(await f.count(), 0);
    const cleared = ready(
      await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()),
    );
    assert.equal(cleared.clearedCount, 0);
    assert.deepEqual(await f.reader.transaction(readHistoryWithdrawalIds), [local.event.eventId]);
    f.bind(owner);
    f.project(wire(local.event));
    assert.equal(await f.count(), 0);
    assert.equal(ready(await f.cooking.readCookedReceipt(local.event.eventId))!.kind, 'cleared');
  } finally {
    await f.close();
  }
});

test('selected account rows and full history export retain strict semantic validation after metadata admission', async () => {
  const f = await fixture();
  try {
    const invalid = { ...f.entry(), timeZone: 'Definitely/Not_A_Time_Zone' };
    f.project(invalid);
    assert.equal((await f.cooking.readHistory({ limit: 1 })).kind, 'failed');
    assert.equal((await f.cooking.reviewClearHistory()).kind, 'failed');
    await assert.rejects(f.reader.transaction(readCookingHistoryForBackup));
    // A denial needs only indexed identity existence; it does not authorize malformed data as a receipt.
    assert.equal((await f.cooking.saveCooked(f.input(invalid.eventId))).kind, 'failed');
    assert.equal(ready(await f.cooking.readCookedReceipt(invalid.eventId)), null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM cooking_event').get()!.count, 0);
  } finally {
    await f.close();
  }
});
