import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createPortableBackup, validatePortableBackup } from '../src/portableBackup';
import type {
  CookMateServices,
  Immutable,
  PersonalCommand,
  PortableBackupEnvelope,
  PortableRestoreResult,
  RepositoryResult,
  SaveCookedInput,
} from '../src/index';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-09-30T12:00:00.000Z';
const recipeId = '52835',
  otherId = '52839';
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
function ready<T>(result: RepositoryResult<T> | { kind: 'uncertain' }): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function receipt(result: PortableRestoreResult) {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
}
async function fixture(expanded = true, accountHistory = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-backup2-')),
    file = join(directory, 'data.db');
  const opened: CookMateServices[] = [];
  const handles: ReturnType<typeof desktopConnection>[] = [];
  let failJournal = false,
    loseCommit = false,
    changeContentHash = false,
    pauseRead: { reached(): void; wait: Promise<void> } | null = null;
  const open = async () => {
    const result = await createLocalStore({
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: expanded,
      enableAccountHistory: accountHistory,
      platform: {
        newId: randomUUID,
        sha256: async (value) =>
          changeContentHash && value.includes('"cookmate-cooking-content-v1"')
            ? 'c'.repeat(64)
            : sha256(value),
      },
      now: () => at,
      dateContext: () => ({
        localDate: '2026-09-30',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      openConnection: async (mode) => {
        const handle = desktopConnection(file);
        handles.push(handle);
        const exec = handle.connection.exec,
          prepare = handle.connection.prepare,
          all = handle.connection.all;
        handle.connection.exec = async (sql) => {
          await exec(sql);
          if (mode === 'write' && loseCommit && sql === 'COMMIT') {
            loseCommit = false;
            throw new Error('synthetic lost commit acknowledgement');
          }
        };
        handle.connection.prepare = async (sql) => {
          if (
            mode === 'write' &&
            failJournal &&
            sql.startsWith('INSERT INTO portable_restore_operation')
          ) {
            failJournal = false;
            throw new Error('synthetic journal fault');
          }
          return prepare(sql);
        };
        handle.connection.all = async <Row extends object>(
          sql: string,
          values?: readonly SqlValue[],
        ) => {
          if (mode === 'read' && pauseRead && sql.includes('FROM recipe_note ORDER BY')) {
            const hold = pauseRead;
            pauseRead = null;
            hold.reached();
            await hold.wait;
          }
          return all<Row>(sql, values);
        };
        return handle.connection;
      },
    });
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    opened.push(result.services);
    return result.services;
  };
  let services = await open();
  return {
    get services() {
      return services;
    },
    get personal() {
      assert.ok(services.personal);
      return services.personal;
    },
    get cooking() {
      assert.ok(services.cooking);
      return services.cooking;
    },
    get restore() {
      assert.ok(services.portableRestore);
      return services.portableRestore;
    },
    get database() {
      return handles.at(-1)!.database;
    },
    async reopen() {
      await services.close();
      services = await open();
    },
    async prepare(value: Immutable<PortableBackupEnvelope>) {
      const review = ready(await this.restore.review(JSON.stringify(value)));
      assert.deepEqual(review.blockers, []);
      return ready(await this.restore.prepare(review));
    },
    async replace(value: Immutable<PortableBackupEnvelope>) {
      return receipt(await this.restore.execute(await this.prepare(value)));
    },
    failJournal() {
      failJournal = true;
    },
    loseCommit() {
      loseCommit = true;
    },
    changeContentHash() {
      changeContentHash = true;
    },
    pauseRead(reached: () => void, wait: Promise<void>) {
      pauseRead = { reached, wait };
    },
    async close() {
      for (const value of opened) await value.close();
      await removeFixtureDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const tables = [
  'recipe_note',
  'personal_collection',
  'personal_collection_member',
  'manual_shopping_item',
  'personal_state',
  'personal_operation',
  'cooking_state',
  'cooking_session',
  'cooking_event',
  'cooking_history_clear',
  'imported_cooking_history',
  'favourite',
  'plan_occurrence',
  'shopping_scope',
  'shopping_selection',
  'shopping_group',
  'shopping_contribution',
  'purchase_state',
  'saved_preference',
  'source_preference_link',
  'state_revision',
  'portable_restore_operation',
];
const rows = (f: Fixture, names = tables) =>
  Object.fromEntries(
    names.map((name) => [name, f.database.prepare(`SELECT * FROM ${name}`).all()]),
  );
async function backup(f: Fixture, history = false) {
  return ready(await f.services.queries.readPortableBackup({ includeCookingHistory: history }));
}
async function personal(
  f: Fixture,
  command: Omit<Extract<PersonalCommand, { kind: 'saveNote' }>, 'operationId' | 'expectedEpoch'>,
) {
  const epoch = ready(await f.personal.readCollections()).epoch;
  return ready(
    await f.personal.execute({ ...command, operationId: randomUUID(), expectedEpoch: epoch }),
  );
}
async function populate(f: Fixture) {
  const noteId = randomUUID(),
    collectionId = randomUUID(),
    itemId = randomUUID();
  await personal(f, {
    kind: 'saveNote',
    noteId,
    recipeId,
    expectedRevision: null,
    text: 'Private 👩‍🍳 note\u0000 with exact whitespace  ',
  });
  ready(
    await f.personal.execute({
      kind: 'createCollection',
      collectionId,
      name: 'Weekend meals',
      operationId: randomUUID(),
      expectedEpoch: 0,
    }),
  );
  const collection = ready(await f.personal.readCollections()).items[0]!;
  ready(
    await f.personal.execute({
      kind: 'setCollectionMembership',
      collectionId,
      recipeId,
      present: true,
      expectedCollectionRevision: collection.revision,
      expectedRevision: null,
      operationId: randomUUID(),
      expectedEpoch: 0,
    }),
  );
  ready(
    await f.personal.execute({
      kind: 'addManualItem',
      itemId,
      fields: { name: 'Bread', amountText: 'a little', unitText: null, category: 'pantry' },
      operationId: randomUUID(),
      expectedEpoch: 0,
    }),
  );
  const item = ready(await f.personal.readManualShopping()).items[0]!;
  ready(
    await f.personal.execute({
      kind: 'setManualPurchased',
      itemId,
      expectedRevision: item.revision,
      purchased: true,
      operationId: randomUUID(),
      expectedEpoch: 0,
    }),
  );
  return { noteId, collectionId, itemId };
}
async function cooked(
  f: Fixture,
  note = 'Private history note',
  id = recipeId,
): Promise<SaveCookedInput> {
  const identity = ready(await f.cooking.readSession(id)).currentContent,
    history = ready(await f.cooking.readHistory());
  return {
    eventId: randomUUID(),
    recipeId: id,
    contentFingerprint: identity.contentFingerprint,
    readerVersion: 1,
    expectedHistoryEpoch: history.historyEpoch,
    cookedOn: '2026-09-29',
    timeZone: 'Asia/Dubai',
    note,
  };
}
async function changed(
  source: Immutable<PortableBackupEnvelope>,
  change: (value: PortableBackupEnvelope) => void,
) {
  const copy = JSON.parse(JSON.stringify(source)) as PortableBackupEnvelope;
  change(copy);
  return createPortableBackup(copy, sha256);
}

test('default schema5 backup covers personal data in one snapshot and never implicitly exports history or capabilities', async () => {
  const f = await fixture();
  try {
    await populate(f);
    const event = await cooked(f);
    ready(await f.cooking.saveCooked(event));
    const session = ready(await f.cooking.readSession(recipeId));
    ready(
      await f.cooking.saveSession({
        operationId: randomUUID(),
        sessionId: randomUUID(),
        recipeId,
        expectedRevision: null,
        contentFingerprint: session.currentContent.contentFingerprint,
        readerVersion: 1,
        passageSequence: session.passageSequences[0]!,
      }),
    );
    const value = await backup(f);
    assert.equal(value.schemaVersion, 2);
    assert.equal(value.databaseSchemaVersion, 5);
    assert.equal(value.counts.personal!.notes, 1);
    assert.equal(value.counts.personal!.manualItems, 1);
    assert.equal(value.counts.personal!.purchasedManualItems, 1);
    assert.equal(value.data.cookingHistory, undefined);
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(event.note!), false);
    for (const key of [
      'operationId',
      'lastOperationId',
      'requestFingerprint',
      'closedSession',
      'composerDraft',
      'pairing',
      'receiptJson',
    ])
      assert.equal(serialized.includes(`"${key}"`), false, key);
    const invalid = await f.services.queries.readPortableBackup({
      includeCookingHistory: 'yes',
    } as never);
    assert.equal(invalid.kind, 'failed');
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
    f.pauseRead(reached, held);
    const reading = backup(f);
    await waiting;
    const changing = personal(f, {
      kind: 'saveNote',
      noteId: randomUUID(),
      recipeId: otherId,
      expectedRevision: null,
      text: 'Concurrent note',
    });
    release();
    assert.equal((await reading).counts.personal!.notes, 1);
    await changing;
    assert.equal((await backup(f)).counts.personal!.notes, 2);
  } finally {
    await f.close();
  }
});

test('schema6 backup records actual schema and old cleared history cannot return through original or re-exported files', async () => {
  const f = await fixture(true, true);
  try {
    const event = await cooked(f);
    ready(await f.cooking.saveCooked(event));
    const original = await backup(f, true);
    assert.equal(original.databaseSchemaVersion, 6);
    assert.equal(original.schemaVersion, 2);
    await f.replace(original);
    const reexported = await backup(f, true);
    const importedId = reexported.data.cookingHistory!.entries[0]!.eventId;
    assert.notEqual(importedId, event.eventId);
    ready(await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()));
    const before = rows(f, [
      ...tables,
      'cooking_history_withdrawal',
      'account_cooking_history',
      'account_cooking_history_removed',
    ]);
    for (const source of [original, reexported]) {
      const review = ready(await f.restore.review(JSON.stringify(source)));
      assert.ok(review.blockers.includes('history_removal_conflict'));
      assert.equal((await f.restore.prepare(review)).kind, 'failed');
    }
    assert.deepEqual(rows(f, Object.keys(before)), before);
    await f.reopen();
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
    assert.ok(
      ready(await f.restore.review(JSON.stringify(original))).blockers.includes(
        'history_removal_conflict',
      ),
    );
  } finally {
    await f.close();
  }
});

test('schema6 restore records replacement withdrawals atomically and a later failure rolls them back', async () => {
  const f = await fixture(true, true);
  try {
    const event = await cooked(f);
    ready(await f.cooking.saveCooked(event));
    const source = await backup(f, true);
    const empty = await changed(source, (value) => {
      value.data.cookingHistory!.entries = [];
    });
    const before = rows(f, [
      ...tables,
      'cooking_history_withdrawal',
      'account_cooking_history',
      'account_cooking_history_removed',
    ]);
    const command = await f.prepare(empty);
    f.failJournal();
    assert.equal((await f.restore.execute(command)).kind, 'failed');
    assert.deepEqual(rows(f, Object.keys(before)), before);
    await f.replace(empty);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
    assert.ok(
      f.database
        .prepare('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?')
        .get(event.eventId),
    );
    assert.ok(
      ready(await f.restore.review(JSON.stringify(source))).blockers.includes(
        'history_removal_conflict',
      ),
    );
  } finally {
    await f.close();
  }
});
test('schema6 prepared restore cannot revive history cleared after its review', async () => {
  const f = await fixture(true, true);
  try {
    const event = await cooked(f);
    ready(await f.cooking.saveCooked(event));
    const source = await backup(f, true);
    const command = await f.prepare(source);
    ready(await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()));
    const before = rows(f, [
      ...tables,
      'cooking_history_withdrawal',
      'account_cooking_history',
      'account_cooking_history_removed',
    ]);
    const result = await f.restore.execute(command);
    assert.equal(result.kind, 'failed');
    assert.deepEqual(rows(f, Object.keys(before)), before);
    await f.reopen();
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
    assert.ok(
      ready(await f.restore.review(JSON.stringify(source))).blockers.includes(
        'history_removal_conflict',
      ),
    );
  } finally {
    await f.close();
  }
});
test('expanded replace preserves stable personal IDs, exact text, manual checks and receipts while advancing epochs', async () => {
  const f = await fixture();
  try {
    const ids = await populate(f),
      source = await backup(f);
    const note = ready(await f.personal.readRecipePersonal(recipeId)).note!;
    const delayed = {
      kind: 'saveNote' as const,
      noteId: ids.noteId,
      recipeId,
      expectedRevision: note.revision,
      expectedEpoch: 0,
      operationId: randomUUID(),
      text: 'Delayed stale edit',
    };
    await personal(f, {
      kind: 'saveNote',
      noteId: ids.noteId,
      recipeId,
      expectedRevision: note.revision,
      text: 'Edited after backup',
    });
    const journalBefore = rows(f, ['personal_operation', 'operation_receipt', 'cooking_event']);
    const before = await backup(f);
    let notifications = 0;
    const unsubscribe = f.personal.subscribe(() => {
      notifications++;
    });
    const result = await f.replace(source);
    unsubscribe();
    assert.equal(notifications, 1);
    assert.deepEqual(result.replacedScopes, ['core', 'personal']);
    assert.equal(result.restoredCounts.personal!.notes, 1);
    const restored = ready(await f.personal.readRecipePersonal(recipeId));
    assert.equal(restored.note!.noteId, ids.noteId);
    assert.equal(restored.note!.text, source.data.personal!.notes[0]!.text);
    assert.ok(restored.note!.revision > note.revision);
    assert.equal(restored.epoch, 1);
    const manual = ready(await f.personal.readManualShopping()).items[0]!;
    assert.equal(manual.itemId, ids.itemId);
    assert.equal(manual.amountText, 'a little');
    assert.equal(manual.purchased, true);
    assert.deepEqual(
      rows(f, ['personal_operation', 'operation_receipt', 'cooking_event']),
      journalBefore,
    );
    assert.equal((await f.personal.execute(delayed)).kind, 'failed');
    const archived = JSON.parse(ready(await f.restore.readArchive(result.operationId, 'before'))!);
    assert.deepEqual(archived.data, before.data);
    assert.equal(archived.schemaVersion, 2);
    assert.equal(
      ready(await f.restore.readArchive(result.operationId, 'imported')),
      JSON.stringify(source),
    );
  } finally {
    await f.close();
  }
});
test('omitted history is unchanged by format2 restore and its before archive contains only replaced scopes', async () => {
  const f = await fixture();
  try {
    await populate(f);
    const source = await backup(f),
      event = await cooked(f);
    ready(await f.cooking.saveCooked(event));
    const prior = rows(f, [
      'cooking_state',
      'cooking_session',
      'cooking_event',
      'cooking_history_clear',
      'imported_cooking_history',
    ]);
    const result = await f.replace(source);
    assert.deepEqual(rows(f, Object.keys(prior)), prior);
    assert.equal(result.restoredCounts.cookingHistory, undefined);
    assert.equal(
      JSON.parse(ready(await f.restore.readArchive(result.operationId, 'before'))!).data
        .cookingHistory,
      undefined,
    );
    assert.equal(ready(await f.cooking.readHistory()).items[0]!.note, event.note);
  } finally {
    await f.close();
  }
});
test('explicit history replacement remaps identities, retains old authority and hides replaced note text in recovery', async () => {
  const f = await fixture();
  try {
    await populate(f);
    const old = await cooked(f, 'Old private note');
    ready(await f.cooking.saveCooked(old));
    const source = await backup(f, true);
    const clear = ready(
      await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()),
    );
    assert.equal(clear.clearedCount, 1);
    const cancelled = await cooked(f, 'Never committed');
    ready(await f.cooking.resolveCookedOperation(cancelled.eventId));
    const current = await cooked(f, 'Replaced private note', otherId);
    ready(await f.cooking.saveCooked(current));
    const delayed = await cooked(f, 'Delayed uncommitted note');
    const localBefore = rows(f, ['cooking_event', 'cooking_history_clear']);
    let notified = 0;
    const unsubscribe = f.cooking.subscribe(() => {
      notified++;
    });
    const result = await f.replace(source);
    unsubscribe();
    assert.equal(notified, 1);
    assert.equal(result.restoredCounts.cookingHistory, 1);
    assert.deepEqual(result.replacedScopes, ['core', 'personal', 'cookingHistory']);
    assert.deepEqual(rows(f, Object.keys(localBefore)), localBefore);
    const page = ready(await f.cooking.readHistory());
    assert.equal(page.items.length, 1);
    const imported = page.items[0]!;
    assert.notEqual(imported.eventId, old.eventId);
    assert.equal(imported.origin, 'backup');
    assert.equal(imported.note, 'Old private note');
    assert.equal(page.historyEpoch, 2);
    assert.equal(ready(await f.cooking.readCookedReceipt(old.eventId))!.kind, 'cleared');
    assert.equal(ready(await f.cooking.readCookedReceipt(cancelled.eventId))!.kind, 'cancelled');
    assert.equal(ready(await f.cooking.readCookedReceipt(imported.eventId)), null);
    assert.equal((await f.cooking.resolveCookedOperation(imported.eventId)).kind, 'failed');
    const recovered = ready(await f.cooking.resolveCookedOperation(current.eventId));
    assert.equal(recovered.kind, 'cleared');
    assert.equal(JSON.stringify(recovered).includes('Replaced'), false);
    assert.equal(ready(await f.cooking.saveCooked(current)).kind, 'cleared');
    assert.equal(
      (await f.cooking.saveCooked({ ...current, note: 'different request' })).kind,
      'failed',
    );
    assert.equal((await f.cooking.saveCooked(delayed)).kind, 'failed');
    const archived = JSON.parse(ready(await f.restore.readArchive(result.operationId, 'before'))!);
    assert.equal(archived.data.cookingHistory.entries[0].note, 'Replaced private note');
    const exported = await backup(f, true);
    assert.equal(exported.data.cookingHistory!.entries[0]!.origin, 'backup');
    assert.equal(exported.data.cookingHistory!.entries[0]!.eventId, imported.eventId);
    await f.reopen();
    assert.equal(ready(await f.cooking.readHistory()).items[0]!.eventId, imported.eventId);
    assert.equal(ready(await f.cooking.readCookedReceipt(current.eventId))!.kind, 'cleared');
  } finally {
    await f.close();
  }
});
test('mixed imported/local history ties page exactly once and clear counts both without deleting backup archives', async () => {
  const f = await fixture();
  try {
    const a = await cooked(f, 'First');
    ready(await f.cooking.saveCooked(a));
    const source = await backup(f, true);
    const restored = await f.replace(source);
    ready(await f.cooking.saveCooked(await cooked(f, 'Second')));
    ready(await f.cooking.saveCooked(await cooked(f, 'Third', otherId)));
    const first = ready(await f.cooking.readHistory({ limit: 1 })),
      second = ready(await f.cooking.readHistory({ limit: 1, cursor: first.nextCursor! })),
      third = ready(await f.cooking.readHistory({ limit: 1, cursor: second.nextCursor! }));
    const entries = [...first.items, ...second.items, ...third.items];
    assert.equal(new Set(entries.map((e) => e.eventId)).size, 3);
    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      entries.map((e) => e.eventId),
      entries
        .map((e) => e.eventId)
        .sort()
        .reverse(),
    );
    const review = ready(await f.cooking.reviewClearHistory());
    assert.equal(review.count, 3);
    const cleared = ready(await f.cooking.clearHistory(review, randomUUID()));
    assert.equal(cleared.clearedCount, 3);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    assert.equal((await f.cooking.readHistory({ cursor: first.nextCursor! })).kind, 'failed');
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM imported_cooking_history').get()!.count,
      0,
    );
    assert.ok(ready(await f.restore.readArchive(restored.operationId, 'imported')));
    assert.equal((await backup(f, true)).counts.cookingHistory, 0);
  } finally {
    await f.close();
  }
});
test('journal failure rolls back core, personal, imported history, epochs and archives together', async () => {
  const f = await fixture();
  try {
    await populate(f);
    ready(await f.cooking.saveCooked(await cooked(f)));
    const source = await backup(f, true);
    const command = await f.prepare(source),
      before = rows(f);
    f.failJournal();
    assert.equal((await f.restore.execute(command)).kind, 'failed');
    assert.deepEqual(rows(f), before);
    const result = receipt(await f.restore.execute(command));
    assert.equal(result.restoredCounts.cookingHistory, 1);
  } finally {
    await f.close();
  }
});
test('lost COMMIT acknowledgement and repeated execute retain exactly one imported mapping and recover after reopen', async () => {
  const f = await fixture();
  try {
    ready(await f.cooking.saveCooked(await cooked(f)));
    const command = await f.prepare(await backup(f, true));
    f.loseCommit();
    const result = receipt(await f.restore.execute(command));
    const entries = ready(await f.cooking.readHistory()).items;
    assert.equal(entries.length, 1);
    assert.deepEqual(receipt(await f.restore.execute(command)), result);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, entries);
    await f.reopen();
    assert.deepEqual(ready(await f.restore.readReceipt(command.operationId)), result);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, entries);
  } finally {
    await f.close();
  }
});
test('unknown personal/history recipes or catalogue mismatch block whole import; older schema does not activate itself', async () => {
  const f = await fixture(),
    legacy = await fixture(false);
  try {
    await populate(f);
    ready(await f.cooking.saveCooked(await cooked(f)));
    const source = await backup(f, true),
      before = rows(f);
    for (const alter of [
      (v: PortableBackupEnvelope) => {
        v.data.personal!.notes[0]!.recipeId = '999';
      },
      (v: PortableBackupEnvelope) => {
        v.data.cookingHistory!.entries[0]!.recipeId = '999';
      },
      (v: PortableBackupEnvelope) => {
        v.catalogue.fingerprint = 'b'.repeat(64);
      },
    ]) {
      const value = await changed(source, alter),
        review = ready(await f.restore.review(JSON.stringify(value)));
      assert.ok(review.blockers.length);
      assert.equal((await f.restore.prepare(review)).kind, 'failed');
      assert.deepEqual(rows(f), before);
    }
    const blocked = ready(await legacy.restore.review(JSON.stringify(source)));
    assert.ok(blocked.blockers.includes('expanded_storage_unavailable'));
    assert.equal((await legacy.restore.prepare(blocked)).kind, 'failed');
    assert.equal(legacy.database.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.equal(
      (await legacy.services.queries.readPortableBackup({ includeCookingHistory: true })).kind,
      'failed',
    );
  } finally {
    await f.close();
    await legacy.close();
  }
});
test('restore review is stale after personal changes and imported backup validates with exact counts', async () => {
  const f = await fixture();
  try {
    const source = await backup(f),
      command = await f.prepare(source);
    await populate(f);
    const before = rows(f);
    assert.equal((await f.restore.execute(command)).kind, 'failed');
    assert.deepEqual(rows(f), before);
    const result = await validatePortableBackup(JSON.stringify(await backup(f)), {
      sha256,
      currentCatalogue: catalogue.identity,
      knownRecipeIds: new Set(catalogue.recipes.map((r) => r.recipeId)),
    });
    assert.equal(result.kind, 'ready');
  } finally {
    await f.close();
  }
});
test('redacted personal tombstones and explicitly empty history replace faithfully without restoring deleted text', async () => {
  const f = await fixture();
  try {
    const ids = await populate(f);
    ready(await f.cooking.saveCooked(await cooked(f)));
    const source = await changed(await backup(f), (value) => {
      const personal = value.data.personal!;
      personal.notes[0] = { ...personal.notes[0]!, deleted: true, text: null };
      personal.collections[0] = { ...personal.collections[0]!, deleted: true, name: null };
      personal.memberships[0]!.present = false;
      personal.manualItems[0] = {
        ...personal.manualItems[0]!,
        deleted: true,
        name: null,
        amountText: null,
        unitText: null,
        category: null,
        purchased: false,
      };
      value.data.cookingHistory = { entries: [] };
    });
    const result = await f.replace(source);
    assert.equal(result.restoredCounts.personal!.noteTombstones, 1);
    assert.equal(result.restoredCounts.personal!.collectionTombstones, 1);
    assert.equal(result.restoredCounts.personal!.removedMemberships, 1);
    assert.equal(result.restoredCounts.personal!.manualTombstones, 1);
    assert.equal(result.restoredCounts.cookingHistory, 0);
    const note = ready(await f.personal.readRecipePersonal(recipeId)).note!;
    assert.equal(note.noteId, ids.noteId);
    assert.equal(note.deleted, true);
    assert.equal(note.text, null);
    assert.deepEqual(ready(await f.personal.readCollections()).items, []);
    assert.deepEqual(ready(await f.personal.readManualShopping()).items, []);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    const oldEvents = f.database
      .prepare("SELECT receipt_json FROM cooking_event WHERE state='saved'")
      .all();
    assert.equal(oldEvents.length, 1);
    ready(await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()));
    assert.equal(
      f.database
        .prepare('SELECT COUNT(*) AS count FROM cooking_event WHERE receipt_json IS NOT NULL')
        .get()!.count,
      0,
    );
    assert.ok(ready(await f.restore.readArchive(result.operationId, 'before')));
  } finally {
    await f.close();
  }
});
test('history source metadata must match the exact known recipe and is checked again at execution', async () => {
  const f = await fixture();
  try {
    ready(await f.cooking.saveCooked(await cooked(f)));
    const source = await backup(f, true),
      before = rows(f);
    for (const alter of [
      (entry: PortableBackupEnvelope['data']['cookingHistory']) => {
        entry!.entries[0]!.recipeTitle = 'Unrelated recipe';
      },
      (entry: PortableBackupEnvelope['data']['cookingHistory']) => {
        entry!.entries[0]!.photoKey = 'unrelated-photo';
      },
      (entry: PortableBackupEnvelope['data']['cookingHistory']) => {
        entry!.entries[0]!.contentFingerprint = 'b'.repeat(64);
      },
      (entry: PortableBackupEnvelope['data']['cookingHistory']) => {
        entry!.entries[0]!.catalogue.version = 'unsupported-historical-version';
      },
      (entry: PortableBackupEnvelope['data']['cookingHistory']) => {
        entry!.entries[0]!.catalogue.fingerprint = 'b'.repeat(64);
      },
    ]) {
      const tampered = await changed(source, (value) => alter(value.data.cookingHistory));
      const review = ready(await f.restore.review(JSON.stringify(tampered)));
      assert.ok(review.blockers.includes('history_content_mismatch'));
      assert.equal(review.referenceSummary?.historyContentVerification, 'mismatch');
      assert.ok(
        review.referenceSummary?.unresolved.some((item) =>
          item.reasons.includes('history_content_mismatch'),
        ),
      );
      assert.equal(review.referenceSummary?.restoreAuthorized, false);
      assert.equal((await f.restore.prepare(review)).kind, 'failed');
      assert.deepEqual(rows(f), before);
    }
    const userData = await changed(source, (value) => {
      const entry = value.data.cookingHistory!.entries[0]!;
      entry.note = 'My different personal note';
      entry.cookedOn = '2026-09-28';
      entry.timeZone = 'UTC';
    });
    const verifiedReview = ready(await f.restore.review(JSON.stringify(userData)));
    assert.deepEqual(verifiedReview.blockers, []);
    assert.equal(verifiedReview.referenceSummary?.historyContentVerification, 'verified');
    assert.deepEqual(verifiedReview.referenceSummary?.unresolved, []);
    const command = await f.prepare(source);
    f.changeContentHash();
    assert.equal((await f.restore.execute(command)).kind, 'failed');
    assert.deepEqual(rows(f), before);
  } finally {
    await f.close();
  }
});
