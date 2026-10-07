import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalContentJson, createBundledRecipeRevision } from '@cookmate/catalogue/content';
import { cookingContentIdentity, type RepositoryResult } from '../src';
import { createContentCookingHistoryClear } from '../../../apps/mobile/src/data/contentCookingHistoryClear';
import { createContentCookingHistory } from '../../../apps/mobile/src/data/contentCookingHistory';
import { createContentCookingSessions } from '../../../apps/mobile/src/data/contentCookingSessions';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import type { openContentReleaseStore } from '../../../apps/mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string; error?: { messageKey: string } }, message?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (message) assert.equal(result.error?.messageKey, message);
}
async function fixture(t: TestContext, bound = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-history-clear-')),
    path = join(directory, 'cooking.db');
  const write = desktopConnection(path),
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
  const ownerId = bound ? randomUUID() : null;
  let access: ContentAdoptionAccess | null = { ownerId, authGeneration: 0 };
  const bind = (owner: string | null, generation: number) => {
    access = { ownerId: owner, authGeneration: generation };
    if (owner === null)
      write.database.exec("DELETE FROM app_metadata WHERE key='account-replication:owner'");
    else
      write.database
        .prepare("INSERT OR REPLACE INTO app_metadata VALUES ('account-replication:owner',?)")
        .run(JSON.stringify({ schemaVersion: 1, ownerId: owner }));
  };
  bind(ownerId, 0);
  const recipe = catalogue.recipes[0]!,
    identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const wire = (eventId: string, note: string) => ({
    ...identity,
    eventId,
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note,
  });
  const oldId = randomUUID(),
    localId = randomUUID(),
    importedId = randomUUID(),
    sourceId = randomUUID(),
    accountId = randomUUID(),
    restoreId = randomUUID();
  for (const [eventId, epoch, revision] of [
    [oldId, 0, 1],
    [localId, 1, 2],
  ] as const) {
    const receipt = {
      kind: 'saved',
      event: { ...wire(eventId, `private-local-${epoch}`), historyEpoch: epoch, revision },
      closedSession: null,
    };
    write.database
      .prepare("INSERT INTO cooking_event VALUES (?,?,'saved',?,?,?,?)")
      .run(eventId, epoch, '2026-10-01', at, 'a'.repeat(64), JSON.stringify(receipt));
  }
  const imported = {
    ...wire(importedId, 'private-imported'),
    origin: 'backup',
    historyEpoch: 1,
    revision: 2,
  };
  write.database
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(restoreId, 'a'.repeat(64), '{}', '{}', '{}');
  write.database
    .prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,1,?,?,?)')
    .run(importedId, sourceId, restoreId, '2026-10-01', at, JSON.stringify(imported));
  if (ownerId)
    write.database
      .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
      .run(ownerId, accountId, JSON.stringify(wire(accountId, 'private-account')));
  write.database.exec(
    "UPDATE cooking_state SET history_epoch=1,history_revision=2; UPDATE state_revision SET revision=2 WHERE collection='store'",
  );
  const occurrenceId = randomUUID();
  write.database
    .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
    .run(occurrenceId, recipe.recipeId, '2026-10-01', 'dinner', at, at);
  write.database.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(recipe.recipeId, at, at);
  write.database
    .prepare('INSERT INTO shopping_selection VALUES (?,?)')
    .run(ids.shoppingScopeId, occurrenceId);
  write.database
    .prepare("INSERT INTO shopping_group VALUES (?, 'retained-group','v1',?,0,'Flour','1 cup')")
    .run(ids.shoppingScopeId, 'a'.repeat(64));
  write.database
    .prepare("INSERT INTO purchase_state VALUES (?,'retained-group',?,1,0,1)")
    .run(ids.shoppingScopeId, 'a'.repeat(64));
  write.database
    .prepare("INSERT INTO manual_shopping_item VALUES (?,?,NULL,NULL,'pantry',0,0,1,?,?)")
    .run(randomUUID(), JSON.stringify('Keep this personal item'), at, at);
  await migrateCookingContentDatabase(writer, { sha256 });
  const faults = {
    statement: '',
    ackLost: false,
    onCommitted: undefined as (() => void) | undefined,
    beforeCommit: undefined as (() => void) | undefined,
    afterCommit: undefined as (() => void) | undefined,
  };
  writer.setObserver({
    async begin() {},
    async committed() {},
    failed() {},
    async beforeCommit() {
      const hook = faults.beforeCommit;
      faults.beforeCommit = undefined;
      hook?.();
    },
  });
  const exec = write.connection.exec,
    prepare = write.connection.prepare;
  write.connection.exec = async (sql) => {
    await exec(sql);
    if (sql === 'COMMIT') {
      const hook = faults.afterCommit;
      faults.afterCommit = undefined;
      hook?.();
      if (faults.ackLost) {
        faults.ackLost = false;
        throw new Error('Fixture lost acknowledgement');
      }
    }
  };
  write.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return {
      ...statement,
      async run(values) {
        if (faults.statement && sql.startsWith(faults.statement))
          throw new Error('Fixture write failure');
        await statement.run(values);
      },
    };
  };
  const changes: unknown[] = [];
  const common = {
    reader,
    writer,
    installationId: ids.installationId,
    sha256,
    now: () => at,
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(access, scope);
      return undefined;
    },
    onCommitted(change: unknown) {
      changes.push(change);
      faults.onCommitted?.();
    },
  };
  // Only setup uses a controlled bundled body port; the clear host has no content service port.
  const contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReading'
  > = {
    async withVerifiedReading(head, _refs, work) {
      assert.equal(head, null);
      let active = true;
      try {
        return await work({
          head: null,
          latestHead: null,
          snapshot: null,
          hasWithdrawal: false,
          assertActive() {
            assert.ok(active);
            return undefined;
          },
          async readPhoto() {
            throw new Error('Unused');
          },
        });
      } finally {
        active = false;
      }
    },
  };
  const history = createContentCookingHistory({
    ...common,
    contentStore,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  });
  const sessions = createContentCookingSessions({ ...common, contentStore });
  const bundled = await createBundledRecipeRevision(recipe.recipeId, sha256);
  const activeSession = ready(
    await sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: { ...bundled.ref },
      expectedRevision: null,
      passageSequence: bundled.document.recipe.instructions[0]!.sequence,
    }),
  );
  const cookedInput = {
    eventId: randomUUID(),
    contentRef: { ...bundled.ref },
    expectedHistoryEpoch: 1,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    note: 'private-v2-note',
  };
  ready(await history.saveCooked(cookedInput));
  changes.length = 0;
  const create = () => createContentCookingHistoryClear({ ...common, newId: randomUUID }),
    host = create();
  const tables = [
    'cooking_event',
    'local_history_content_pin',
    'imported_cooking_history',
    'imported_history_content_pin',
    'account_cooking_history',
    'account_history_content_pin',
    'account_cooking_history_removed',
    'cooking_history_withdrawal',
    'cooking_state',
    'cooking_history_clear',
    'content_cooking_event_authority',
    'state_revision',
  ] as const;
  const rows = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        write.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  const unrelated = () =>
    Object.fromEntries(
      [
        'cooking_session',
        'cooking_session_content_pin',
        'content_cooking_session_operation',
        'plan_occurrence',
        'plan_content_pin',
        'shopping_scope',
        'shopping_selection',
        'shopping_group',
        'shopping_contribution',
        'purchase_state',
        'favourite',
        'manual_shopping_item',
        'portable_restore_operation',
      ].map((table) => [
        table,
        write.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  const count = (table: string) =>
    write.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
  return {
    host,
    create,
    history,
    sessions,
    cookedInput,
    activeSession,
    changes,
    rows,
    unrelated,
    count,
    writer,
    write,
    read,
    faults,
    bind,
    ownerId,
    ids,
    oldId,
    localId,
    importedId,
    sourceId,
    accountId,
    bundled,
    wire,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
  };
}

test('clear observers closing the host cannot expose ready clear or cancellation results', async (t) => {
  for (const action of ['clear', 'cancel'] as const) {
    const f = await fixture(t);
    await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
    const review = ready(await f.host.reviewClearHistory()),
      operationId = randomUUID();
    f.faults.onCommitted = () => f.host.close();
    const result =
      action === 'clear'
        ? await f.host.clearHistory(review, operationId)
        : await f.host.resolveClearHistoryOperation(operationId);
    assert.equal(result.kind, 'uncertain');
    assert.equal(f.count('cooking_history_clear'), 1);
    assert.equal(f.changes.length, 1);
    const before = f.rows();
    assert.equal(
      ready(await f.create().readClearHistoryReceipt(operationId))?.outcome,
      action === 'clear' ? 'cleared' : 'cancelled',
    );
    assert.deepEqual(f.rows(), before);
  }
});

test('clear lost-ACK recovery remains uncertain when its notification signs out instead of throwing or claiming failure', async (t) => {
  for (const action of ['clear', 'cancel'] as const) {
    const f = await fixture(t);
    await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
    const review = ready(await f.host.reviewClearHistory()),
      operationId = randomUUID();
    f.faults.ackLost = true;
    f.faults.onCommitted = () => f.setAccess(null);
    const result =
      action === 'clear'
        ? await f.host.clearHistory(review, operationId)
        : await f.host.resolveClearHistoryOperation(operationId);
    assert.equal(result.kind, 'uncertain');
    if (result.kind !== 'uncertain') assert.fail();
    assert.equal(result.operationId, operationId);
    assert.equal(f.writer.requiresRecovery(), true);
    assert.equal(f.count('cooking_history_clear'), 1);
    assert.equal(f.changes.length, 1);
    f.bind(f.ownerId, 1);
    assert.equal(
      ready(await f.create().readClearHistoryReceipt(operationId))?.outcome,
      action === 'clear' ? 'cleared' : 'cancelled',
    );
  }
});

test('actual8 reviewed mixed clear withdraws exact account data and recovers lost acknowledgements without new local cooked receipts', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.ok(f.ownerId);
  const account = {
    readerVersion: 2,
    eventId: randomUUID(),
    recipeId: f.bundled.ref.recipeId,
    contentRef: { ...f.bundled.ref },
    recipeTitle: f.bundled.document.recipe.title,
    photoAssetId: f.bundled.document.media[0]!.assetId,
    cookedOn: '2026-10-03',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Private exact account data only',
  };
  const db = f.write.database;
  db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
    f.ownerId,
    account.eventId,
    JSON.stringify(account),
  );
  db.prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)').run(
    f.ownerId,
    account.eventId,
    account.recipeId,
    account.contentRef.revisionId,
    account.contentRef.contentFingerprint,
  );
  assert.equal(
    db.prepare('SELECT 1 FROM cooking_event WHERE event_id=?').get(account.eventId),
    undefined,
  );
  const cancellationId = randomUUID();
  const cancellation = ready(await f.host.resolveClearHistoryOperation(cancellationId));
  assert.equal(cancellation.outcome, 'cancelled');
  assert.equal(f.count('cooking_history_withdrawal'), 0);
  const unrelated = f.unrelated(),
    review = ready(await f.host.reviewClearHistory());
  assert.equal(review.count, 5);
  const operationId = randomUUID();
  f.faults.ackLost = true;
  const receipt = ready(await f.host.clearHistory(review, operationId));
  assert.equal(receipt.clearedCount, 5);
  assert.equal(f.count('account_cooking_history'), 0);
  assert.equal(f.count('account_history_content_pin'), 0);
  assert.ok(
    db.prepare('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?').get(account.eventId),
  );
  assert.ok(
    db
      .prepare('SELECT 1 FROM account_cooking_history_removed WHERE event_id=? AND owner_id=?')
      .get(account.eventId, f.ownerId),
  );
  assert.equal(
    db.prepare('SELECT 1 FROM cooking_event WHERE event_id=?').get(account.eventId),
    undefined,
  );
  assert.deepEqual(f.unrelated(), unrelated);
  const after = f.rows();
  assert.deepEqual(ready(await f.create().readClearHistoryReceipt(operationId)), receipt);
  assert.deepEqual(ready(await f.create().clearHistory({ ...review }, operationId)), receipt);
  assert.deepEqual(ready(await f.create().readClearHistoryReceipt(cancellationId)), cancellation);
  assert.deepEqual(f.rows(), after);
  assert.equal(f.changes.length, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('mixed reviewed clear redacts all local epochs, withdraws backup lineage/account IDs, and preserves unrelated data', async (t) => {
  const f = await fixture(t),
    before = f.rows(),
    unrelated = f.unrelated();
  const review = ready(await f.host.reviewClearHistory());
  assert.equal(review.count, 4);
  assert.deepEqual(f.rows(), before);
  const operationId = randomUUID(),
    receipt = ready(await f.host.clearHistory(review, operationId));
  assert.equal(receipt.outcome, 'cleared');
  assert.equal(receipt.clearedCount, 4);
  assert.equal(receipt.previousHistoryEpoch, 1);
  assert.equal(receipt.historyEpoch, 2);
  assert.equal(f.count('local_history_content_pin'), 0);
  assert.equal(f.count('imported_history_content_pin'), 0);
  assert.equal(f.count('account_history_content_pin'), 0);
  assert.equal(f.count('imported_cooking_history'), 0);
  assert.equal(f.count('account_cooking_history'), 0);
  const local = f.write.database.prepare('SELECT * FROM cooking_event').all();
  assert.equal(local.length, 3);
  for (const row of local) {
    assert.equal(row.state, 'cleared');
    for (const key of ['cooked_on', 'recorded_at', 'request_fingerprint', 'receipt_json'])
      assert.equal(row[key], null);
  }
  const ids = [
    f.oldId,
    f.localId,
    f.importedId,
    f.sourceId,
    f.accountId,
    f.cookedInput.eventId,
  ].sort();
  assert.deepEqual(
    f.write.database
      .prepare('SELECT event_id FROM cooking_history_withdrawal ORDER BY event_id')
      .all()
      .map((row) => row.event_id),
    ids,
  );
  assert.deepEqual(
    f.write.database
      .prepare('SELECT event_id FROM account_cooking_history_removed ORDER BY event_id')
      .all()
      .map((row) => row.event_id),
    ids,
  );
  assert.deepEqual(f.unrelated(), unrelated);
  const cleared = { kind: 'cleared', eventId: f.cookedInput.eventId, historyEpoch: 1 };
  assert.deepEqual(ready(await f.history.recover(f.cookedInput)), cleared);
  assert.deepEqual(ready(await f.history.saveCooked(f.cookedInput)), cleared);
  const after = f.rows();
  assert.deepEqual(ready(await f.create().readClearHistoryReceipt(operationId)), receipt);
  assert.deepEqual(ready(await f.create().clearHistory({ ...review }, operationId)), receipt);
  assert.deepEqual(ready(await f.host.resolveClearHistoryOperation(operationId)), receipt);
  assert.deepEqual(f.rows(), after);
  assert.equal(f.changes.length, 1);
  const journals = JSON.stringify([
    f.write.database.prepare('SELECT * FROM cooking_history_clear').all(),
    f.write.database.prepare('SELECT * FROM content_cooking_event_authority').all(),
  ]);
  for (const note of ['private-local-', 'private-imported', 'private-account', 'private-v2-note'])
    assert.equal(journals.includes(note), false);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
  await migrateCookingContentDatabase(f.writer, { sha256 });
});

test('new clears require the exact issued review and reject changed store/history identities despite equal visible counts', async (t) => {
  const f = await fixture(t),
    review = ready(await f.host.reviewClearHistory()),
    before = f.rows();
  failed(await f.host.clearHistory({ ...review }, randomUUID()), 'content.clear_review_required');
  failed(await f.create().clearHistory(review, randomUUID()), 'content.clear_review_required');
  assert.deepEqual(f.rows(), before);
  const nextId = randomUUID();
  f.write.database.prepare('DELETE FROM account_cooking_history WHERE event_id=?').run(f.accountId);
  f.write.database
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(f.ownerId, nextId, JSON.stringify(f.wire(nextId, 'replacement account note')));
  f.write.database
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      f.ownerId,
      nextId,
      f.bundled.ref.recipeId,
      f.bundled.ref.revisionId,
      f.bundled.ref.contentFingerprint,
    );
  assert.equal(ready(await f.host.reviewClearHistory()).count, review.count);
  failed(await f.host.clearHistory(review, randomUUID()), 'content.clear_history_changed');
  const fresh = ready(await f.host.reviewClearHistory());
  f.write.database.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='store'");
  failed(await f.host.clearHistory(fresh, randomUUID()), 'content.clear_history_changed');
  assert.equal(f.count('cooking_history_clear'), 0);
});

test('restore, adoption and auth generation fence new clears while historical receipts remain owner-bound', async (t) => {
  const f = await fixture(t),
    review = ready(await f.host.reviewClearHistory());
  f.write.database
    .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','2')")
    .run();
  failed(await f.host.clearHistory(review, randomUUID()), 'content.clear_workspace_changed');
  const afterRestore = ready(await f.host.reviewClearHistory());
  f.write.database
    .prepare('UPDATE app_content_adoption SET revision=1,head_json=?')
    .run(JSON.stringify({ releaseId: 'fixture-head', sequence: 1, fingerprint: 'a'.repeat(64) }));
  failed(await f.host.clearHistory(afterRestore, randomUUID()), 'content.clear_workspace_changed');
  const current = ready(await f.host.reviewClearHistory()),
    operationId = randomUUID();
  const receipt = ready(await f.host.clearHistory(current, operationId));
  f.bind(f.ownerId, 1);
  failed(await f.host.readClearHistoryReceipt(operationId), 'content.clear_access_changed');
  assert.deepEqual(ready(await f.create().readClearHistoryReceipt(operationId)), receipt);
  f.bind(randomUUID(), 2);
  failed(await f.create().readClearHistoryReceipt(operationId), 'content.clear_access_changed');
});

test('durable cancellation survives recreation and prevents a retained review from clearing that operation', async (t) => {
  const f = await fixture(t),
    review = ready(await f.host.reviewClearHistory()),
    operationId = randomUUID();
  const history = f.write.database.prepare('SELECT * FROM cooking_event').all(),
    state = f.write.database.prepare('SELECT * FROM cooking_state').all();
  const receipt = ready(await f.host.resolveClearHistoryOperation(operationId));
  assert.equal(receipt.outcome, 'cancelled');
  assert.equal(receipt.clearedCount, 0);
  assert.deepEqual(ready(await f.host.clearHistory(review, operationId)), receipt);
  assert.deepEqual(ready(await f.create().resolveClearHistoryOperation(operationId)), receipt);
  assert.deepEqual(f.write.database.prepare('SELECT * FROM cooking_event').all(), history);
  assert.deepEqual(f.write.database.prepare('SELECT * FROM cooking_state').all(), state);
  assert.equal(f.count('cooking_history_withdrawal'), 0);
});

test('mid-write failure rolls back withdrawal, pin removal, privacy redaction, revisions and receipt together', async (t) => {
  const f = await fixture(t),
    review = ready(await f.host.reviewClearHistory()),
    before = f.rows(),
    unrelated = f.unrelated(),
    operationId = randomUUID();
  f.faults.statement = 'INSERT INTO cooking_history_clear';
  failed(await f.host.clearHistory(review, operationId));
  assert.deepEqual(f.rows(), before);
  assert.deepEqual(f.unrelated(), unrelated);
  assert.equal(ready(await f.host.readClearHistoryReceipt(operationId)), null);
  assert.equal(f.changes.length, 0);
  f.faults.statement = '';
  ready(await f.host.clearHistory(review, operationId));
});

test('lost clear/cancel acknowledgements recover independently without replay or duplicate notifications', async (t) => {
  const f = await fixture(t),
    review = ready(await f.host.reviewClearHistory()),
    operationId = randomUUID();
  f.faults.ackLost = true;
  const receipt = ready(await f.host.clearHistory(review, operationId));
  assert.equal(receipt.outcome, 'cleared');
  assert.deepEqual(ready(await f.create().readClearHistoryReceipt(operationId)), receipt);
  assert.equal(f.changes.length, 1);
  const g = await fixture(t, false),
    cancelId = randomUUID();
  g.faults.ackLost = true;
  assert.equal(ready(await g.host.resolveClearHistoryOperation(cancelId)).outcome, 'cancelled');
  assert.equal(g.count('cooking_history_withdrawal'), 0);
  assert.equal(g.changes.length, 1);
});

test('late owner change prevents commit or receipt exposure; committed clear remains recoverable by its owner', async (t) => {
  const f = await fixture(t),
    review = ready(await f.host.reviewClearHistory()),
    before = f.rows();
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.clearHistory(review, randomUUID())).kind, 'uncertain');
  assert.deepEqual(f.rows(), before);
  f.bind(f.ownerId, 0);
  const operationId = randomUUID();
  f.faults.afterCommit = () => f.setAccess(null);
  assert.equal((await f.host.clearHistory(review, operationId)).kind, 'uncertain');
  assert.equal(f.count('cooking_history_clear'), 1);
  assert.equal(f.changes.length, 0);
  f.bind(f.ownerId, 1);
  assert.equal(ready(await f.create().readClearHistoryReceipt(operationId))?.outcome, 'cleared');
});

test('receipt recovery survives unrelated malformed history but rejects legacy IDs and impossible future receipt revisions', async (t) => {
  const f = await fixture(t),
    operationId = randomUUID(),
    receipt = ready(await f.host.resolveClearHistoryOperation(operationId));
  f.write.database
    .prepare("UPDATE cooking_event SET receipt_json='{}' WHERE event_id=?")
    .run(f.localId);
  assert.deepEqual(ready(await f.create().readClearHistoryReceipt(operationId)), receipt);
  failed(await f.host.reviewClearHistory());
  const legacyId = randomUUID();
  f.write.database
    .prepare('INSERT INTO cooking_history_clear VALUES (?,?)')
    .run(legacyId, JSON.stringify({ ...receipt, operationId: legacyId }));
  failed(await f.host.readClearHistoryReceipt(legacyId), 'content.clear_operation_conflict');
  failed(await f.host.resolveClearHistoryOperation(legacyId), 'content.clear_operation_conflict');
  const row = f.write.database
    .prepare('SELECT receipt_json FROM cooking_history_clear WHERE operation_id=?')
    .get(operationId)!.receipt_json as string;
  const corrupt = JSON.parse(row) as { receipt: { historyRevision: number } };
  corrupt.receipt.historyRevision++;
  f.write.database
    .prepare('UPDATE cooking_history_clear SET receipt_json=? WHERE operation_id=?')
    .run(canonicalContentJson(corrupt, 4096), operationId);
  failed(
    await f.host.readClearHistoryReceipt(operationId),
    'content.clear_stored_evidence_invalid',
  );
});

test('guest clear retains lineage before first binding and does not authorize account-contaminated reviews', async (t) => {
  const f = await fixture(t, false),
    review = ready(await f.host.reviewClearHistory());
  assert.equal(review.count, 3);
  ready(await f.host.clearHistory(review, randomUUID()));
  assert.equal(f.count('account_cooking_history_removed'), 0);
  assert.ok(
    f.write.database
      .prepare('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?')
      .get(f.sourceId),
  );
  const foreign = randomUUID();
  f.write.database
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(foreign, f.accountId, JSON.stringify(f.wire(f.accountId, 'foreign account note')));
  failed(await f.host.reviewClearHistory());
});

test('NUL-suffixed operation IDs fail before raw materialization; ledger capacity never prunes receipts', async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  f.write.database
    .prepare('INSERT INTO cooking_history_clear VALUES (?,?)')
    .run(operationId + '\0' + 'x'.repeat(2 * 1024 * 1024), '{}');
  let materialized = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, values);
    if (
      rows.some((row) =>
        Object.values(row).some(
          (value: unknown) => typeof value === 'string' && value.length > 4096,
        ),
      )
    )
      materialized = true;
    return rows;
  };
  failed(
    await f.host.readClearHistoryReceipt(operationId),
    'content.clear_stored_evidence_invalid',
  );
  assert.equal(materialized, false);
  f.write.database.exec('DELETE FROM cooking_history_clear');
  f.write.database.exec(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000) INSERT INTO cooking_history_clear SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),'{}' FROM n",
  );
  const review = ready(await f.host.reviewClearHistory()),
    before = f.rows();
  failed(await f.host.clearHistory(review, randomUUID()), 'content.clear_operation_limit');
  assert.deepEqual(f.rows(), before);
  assert.equal(f.count('cooking_history_clear'), 20000);
});
