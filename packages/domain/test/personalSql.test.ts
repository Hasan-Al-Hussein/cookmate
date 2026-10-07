import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  CookMateServices,
  DirectActionInput,
  PersonalCommand,
  RepositoryResult,
} from '../src/index';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const timestamp = '2026-09-30T12:00:00.000Z';
function ready<T>(result: RepositoryResult<T> | { kind: 'uncertain' }): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
const recipeId = '52835';
const otherId = '52839';
const id = () => randomUUID();
const base = () => ({ operationId: id(), expectedEpoch: 0 });
async function fixture(initial = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-personal-'));
  const filename = join(directory, 'store.db');
  const opened: CookMateServices[] = [];
  const connections: { mode: string; handle: ReturnType<typeof desktopConnection> }[] = [];
  let loseCommit = false,
    failReceipt = false,
    failRead = false,
    failMigration = false;
  let pause: { reached(): void; wait: Promise<void> } | null = null;
  const open = async (enablePersonal: boolean) =>
    createLocalStore({
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal,
      platform: {
        newId: id,
        sha256: async (value: string) => {
          if (pause && value.includes('"saveNote"')) {
            const hold = pause;
            pause = null;
            hold.reached();
            await hold.wait;
          }
          return createHash('sha256').update(value).digest('hex');
        },
      },
      now: () => timestamp,
      dateContext: () => ({
        localDate: '2026-09-30',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      openConnection: async (mode) => {
        const handle = desktopConnection(filename);
        connections.push({ mode, handle });
        const originalExec = handle.connection.exec;
        handle.connection.exec = async (sql) => {
          await originalExec(sql);
          if (mode === 'write' && failMigration && sql.includes('CREATE TABLE personal_state')) {
            failMigration = false;
            throw new Error('synthetic migration failure');
          }
          if (mode === 'write' && loseCommit && sql === 'COMMIT') {
            loseCommit = false;
            throw new Error('synthetic lost acknowledgement');
          }
        };
        const originalPrepare = handle.connection.prepare;
        handle.connection.prepare = async (sql) => {
          if (mode === 'write' && failReceipt && sql.startsWith('INSERT INTO personal_operation')) {
            failReceipt = false;
            throw new Error('synthetic receipt failure');
          }
          return originalPrepare(sql);
        };
        const originalAll = handle.connection.all;
        handle.connection.all = async <Row extends object>(
          sql: string,
          values?: readonly SqlValue[],
        ) => {
          if (mode === 'read' && failRead && sql.includes('personal_operation'))
            throw new Error('synthetic receipt read failure');
          return originalAll<Row>(sql, values);
        };
        return handle.connection;
      },
    });
  const initialResult = await open(initial);
  assert.equal(initialResult.kind, 'ready', JSON.stringify(initialResult));
  if (initialResult.kind !== 'ready') assert.fail();
  let services = initialResult.services;
  opened.push(services);
  return {
    get services() {
      return services;
    },
    get personal() {
      assert.ok(services.personal);
      return services.personal;
    },
    get database() {
      return connections.filter((item) => item.mode === 'write').at(-1)!.handle.database;
    },
    async open(enabled = true) {
      const result = await open(enabled);
      if (result.kind === 'ready') opened.push(result.services);
      return result;
    },
    async reopen(enabled = true) {
      await services.close();
      const result = await this.open(enabled);
      assert.equal(result.kind, 'ready', JSON.stringify(result));
      if (result.kind !== 'ready') assert.fail();
      services = result.services;
    },
    loseCommit() {
      loseCommit = true;
    },
    failReceipt() {
      failReceipt = true;
    },
    failReads(value = true) {
      failRead = value;
    },
    failMigration() {
      failMigration = true;
    },
    pauseHash() {
      let release!: () => void;
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = { reached, wait };
      return { entered, release };
    },
    async action(input: DirectActionInput) {
      const review = ready(await services.commands.reviewDirect(input));
      const command = ready(await services.commands.prepareDirect(review));
      const result = await services.commands.execute(command);
      assert.equal(result.kind, 'receipt', JSON.stringify(result));
    },
    async close() {
      await Promise.all(opened.map((service) => service.close()));
      await removeFixtureDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function addCollection(f: Fixture, name = 'Weeknight meals') {
  const collectionId = id();
  ready(await f.personal.execute({ ...base(), kind: 'createCollection', collectionId, name }));
  return ready(await f.personal.readCollections()).items.find(
    (item) => item.collectionId === collectionId,
  )!;
}
async function member(f: Fixture, collectionId: string, recipe = recipeId, present = true) {
  const item = ready(await f.personal.readCollection(collectionId)).collection;
  const current = ready(await f.personal.readRecipePersonal(recipe)).memberships.find(
    (entry) => entry.collectionId === collectionId,
  );
  return ready(
    await f.personal.execute({
      ...base(),
      kind: 'setCollectionMembership',
      collectionId,
      recipeId: recipe,
      expectedCollectionRevision: item.revision,
      expectedRevision: current?.revision ?? null,
      present,
    }),
  );
}
async function addManual(f: Fixture, name = 'Paper towels') {
  const itemId = id();
  ready(
    await f.personal.execute({
      ...base(),
      kind: 'addManualItem',
      itemId,
      fields: { name, amountText: null, unitText: null, category: 'other' },
    }),
  );
  return itemId;
}
function nonPersonalRows(f: Fixture) {
  return Object.fromEntries(
    [
      'favourite',
      'plan_occurrence',
      'shopping_scope',
      'shopping_selection',
      'shopping_group',
      'shopping_contribution',
      'purchase_state',
      'saved_preference',
      'source_preference_link',
      'message',
      'conversation',
      'operation_receipt',
      'app_metadata',
      'cooking_event',
      'cooking_session',
      'cooking_state',
    ].map((table) => [table, f.database.prepare(`SELECT * FROM ${table}`).all()]),
  );
}

test('personal activation is additive and default-off; failed migration preserves schema4', async () => {
  const f = await fixture(false);
  try {
    assert.equal(f.services.personal, undefined);
    await f.action({ kind: 'setFavourite', recipeId, saved: true });
    const cooking = f.services.cooking!;
    const reader = ready(await cooking.readSession(recipeId));
    ready(
      await cooking.saveSession({
        operationId: id(),
        sessionId: id(),
        recipeId,
        expectedRevision: null,
        contentFingerprint: reader.currentContent.contentFingerprint,
        readerVersion: 1,
        passageSequence: reader.passageSequences[0]!,
      }),
    );
    ready(
      await cooking.saveCooked({
        eventId: id(),
        recipeId,
        contentFingerprint: reader.currentContent.contentFingerprint,
        readerVersion: 1,
        expectedHistoryEpoch: 0,
        cookedOn: '2026-09-30',
        timeZone: 'Asia/Dubai',
        note: 'Preserve this existing history.',
      }),
    );
    const before = nonPersonalRows(f),
      database = f.database;
    f.failMigration();
    assert.equal((await f.open()).kind, 'failed');
    assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'personal_%'")
        .get()!.n,
      0,
    );
    await f.reopen();
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 5);
    assert.deepEqual(nonPersonalRows(f), before);
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((await f.open(false)).kind, 'failed');
  } finally {
    await f.close();
  }
});

test('note uses one stable recipe identity; exact Unicode/private text survives restart without receipts copying it', async () => {
  const f = await fixture();
  try {
    const before = nonPersonalRows(f),
      noteId = id();
    const command: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId,
      recipeId,
      expectedRevision: null,
      text: 'PRIVATE_TEXT\u0000 مطبخ 🍲\ud800',
    };
    const receipt = ready(await f.personal.execute(command));
    assert.equal(receipt.outcome, 'committed');
    assert.deepEqual(ready(await f.personal.execute(command)), receipt);
    await f.reopen();
    const saved = ready(await f.personal.readRecipePersonal(recipeId)).note!;
    assert.equal(saved.text, command.text);
    assert.equal(saved.noteId, noteId);
    assert.equal(
      JSON.stringify(f.database.prepare('SELECT * FROM personal_operation').all()).includes(
        'PRIVATE_TEXT',
      ),
      false,
    );
    assert.deepEqual(nonPersonalRows(f), before);
    assert.equal(
      (
        await f.personal.execute({
          ...command,
          operationId: id(),
          noteId: id(),
          expectedRevision: saved.revision,
        })
      ).kind,
      'failed',
    );
    assert.equal((await f.personal.execute({ ...command, text: 'changed' })).kind, 'failed');
  } finally {
    await f.close();
  }
});

test('note deletion redacts text and blocks stale resurrection while allowing an explicit same-note edit', async () => {
  const f = await fixture();
  try {
    const command: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId: id(),
      recipeId,
      expectedRevision: null,
      text: 'Use more lemon.',
    };
    ready(await f.personal.execute(command));
    const first = ready(await f.personal.readRecipePersonal(recipeId)).note!;
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'deleteNote',
        noteId: first.noteId,
        expectedRevision: first.revision,
      }),
    );
    const removed = ready(await f.personal.readRecipePersonal(recipeId)).note!;
    assert.equal(removed.deleted, true);
    assert.equal(removed.text, null);
    assert.equal(ready(await f.personal.execute(command)).outcome, 'committed');
    assert.equal(ready(await f.personal.readRecipePersonal(recipeId)).note!.deleted, true);
    assert.equal(
      (
        await f.personal.execute({
          ...command,
          operationId: id(),
          expectedRevision: first.revision,
        })
      ).kind,
      'failed',
    );
    ready(
      await f.personal.execute({
        ...command,
        operationId: id(),
        expectedRevision: removed.revision,
        text: 'Fresh private note.',
      }),
    );
    assert.equal(
      ready(await f.personal.readRecipePersonal(recipeId)).note!.text,
      'Fresh private note.',
    );
  } finally {
    await f.close();
  }
});

test('recipe can belong to multiple collections and removing membership never unsaves favourites', async () => {
  const f = await fixture();
  try {
    await f.action({ kind: 'setFavourite', recipeId, saved: true });
    const favourites = ready(await f.services.queries.readFavourites());
    const first = await addCollection(f),
      second = await addCollection(f, 'Family');
    await member(f, first.collectionId);
    await member(f, second.collectionId);
    assert.equal(
      ready(await f.personal.readRecipePersonal(recipeId)).memberships.filter(
        (item) => item.present,
      ).length,
      2,
    );
    await member(f, first.collectionId, recipeId, false);
    const snapshot = ready(await f.personal.readRecipePersonal(recipeId));
    assert.equal(
      snapshot.memberships.find((item) => item.collectionId === first.collectionId)!.present,
      false,
    );
    assert.equal(
      snapshot.memberships.find((item) => item.collectionId === second.collectionId)!.present,
      true,
    );
    assert.deepEqual(ready(await f.services.queries.readFavourites()), favourites);
    await f.reopen();
    assert.equal(ready(await f.personal.readCollection(second.collectionId)).items.length, 1);
  } finally {
    await f.close();
  }
});

test('bulk collection deletion requires the exact current member review and preserves favourites/notes', async () => {
  const f = await fixture();
  try {
    await f.action({ kind: 'setFavourite', recipeId, saved: true });
    const item = await addCollection(f);
    await member(f, item.collectionId);
    const stale = ready(await f.personal.reviewDeleteCollection(item.collectionId));
    await member(f, item.collectionId, otherId);
    assert.equal((await f.personal.deleteCollection(stale, id())).kind, 'failed');
    const review = ready(await f.personal.reviewDeleteCollection(item.collectionId));
    assert.deepEqual(review.affectedRecipeIds, [recipeId, otherId]);
    assert.equal((await f.personal.deleteCollection({ ...review }, id())).kind, 'failed');
    const operationId = id(),
      receipt = ready(await f.personal.deleteCollection(review, operationId));
    assert.equal(receipt.affectedMemberships, 2);
    assert.equal(ready(await f.personal.readCollections()).items.length, 0);
    assert.equal(ready(await f.services.queries.readFavourites()).length, 1);
    assert.equal(
      (
        await f.personal.execute({
          ...base(),
          kind: 'createCollection',
          collectionId: item.collectionId,
          name: 'Recreated',
        })
      ).kind,
      'failed',
    );
    await f.reopen();
    assert.deepEqual(ready(await f.personal.deleteCollection(review, operationId)), receipt);
    assert.equal(
      f.database
        .prepare('SELECT name FROM personal_collection WHERE collection_id=?')
        .get(item.collectionId)!.name,
      null,
    );
  } finally {
    await f.close();
  }
});

test('manual items remain distinct, preserve unknown quantities and survive recipe demand rebuilding', async () => {
  const f = await fixture();
  try {
    const itemId = await addManual(f);
    const item = ready(await f.personal.readManualShopping()).items[0]!;
    assert.equal(item.kind, 'manual');
    assert.equal(item.amountText, null);
    assert.equal(item.unitText, null);
    await f.action({
      kind: 'placeRecipe',
      recipeId,
      placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
    });
    const plan = ready(await f.services.queries.readPlan('2026-09-30', '2026-09-30'));
    await f.action({
      kind: 'setShoppingSelection',
      occurrenceIds: plan.occurrences.map((entry) => entry.occurrenceId),
    });
    const generated = ready(await f.services.queries.readShopping());
    assert.ok(generated.groups.length);
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'setManualPurchased',
        itemId,
        expectedRevision: item.revision,
        purchased: true,
      }),
    );
    assert.deepEqual(ready(await f.services.queries.readShopping()), generated);
    await f.action({ kind: 'setShoppingSelection', occurrenceIds: [] });
    assert.equal(ready(await f.services.queries.readShopping()).groups.length, 0);
    const current = ready(await f.personal.readManualShopping()).items[0]!;
    assert.equal(current.itemId, itemId);
    assert.equal(current.purchased, true);
    await f.reopen();
    assert.equal(ready(await f.personal.readManualShopping()).items[0]!.purchased, true);
  } finally {
    await f.close();
  }
});

test('manual edits protect stale checkboxes, preserve category-only purchases and reset changed requested amounts', async () => {
  const f = await fixture();
  try {
    const itemId = await addManual(f),
      first = ready(await f.personal.readManualShopping()).items[0]!;
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'setManualPurchased',
        itemId,
        expectedRevision: first.revision,
        purchased: true,
      }),
    );
    let item = ready(await f.personal.readManualShopping()).items[0]!;
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'editManualItem',
        itemId,
        expectedRevision: item.revision,
        fields: { name: item.name!, amountText: null, unitText: null, category: 'pantry' },
      }),
    );
    item = ready(await f.personal.readManualShopping()).items[0]!;
    assert.equal(item.purchased, true);
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'editManualItem',
        itemId,
        expectedRevision: item.revision,
        fields: { name: item.name!, amountText: 'some', unitText: 'rolls', category: 'pantry' },
      }),
    );
    item = ready(await f.personal.readManualShopping()).items[0]!;
    assert.equal(item.purchased, false);
    assert.equal(item.amountText, 'some');
    assert.equal(
      (
        await f.personal.execute({
          ...base(),
          kind: 'setManualPurchased',
          itemId,
          expectedRevision: first.revision,
          purchased: true,
        })
      ).kind,
      'failed',
    );
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'deleteManualItem',
        itemId,
        expectedRevision: item.revision,
      }),
    );
    assert.equal(ready(await f.personal.readManualShopping()).items.length, 0);
    assert.equal(
      (
        await f.personal.execute({
          ...base(),
          kind: 'addManualItem',
          itemId,
          fields: { name: 'Recreated', amountText: null, unitText: null, category: 'other' },
        })
      ).kind,
      'failed',
    );
  } finally {
    await f.close();
  }
});

test('bounded pages stay stable across checkbox updates and reject stale cursors or oversize pages', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) await addManual(f, `Item ${i}`);
    const first = ready(await f.personal.readManualShopping({ limit: 2 })),
      last = ready(await f.personal.readManualShopping({ limit: 2, cursor: first.nextCursor! }));
    assert.equal(new Set([...first.items, ...last.items].map((item) => item.itemId)).size, 3);
    assert.equal(last.nextCursor, null);
    const previousOrder = ready(await f.personal.readManualShopping()).items.map(
      (item) => item.itemId,
    );
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'setManualPurchased',
        itemId: first.items[0]!.itemId,
        expectedRevision: first.items[0]!.revision,
        purchased: true,
      }),
    );
    assert.deepEqual(
      ready(await f.personal.readManualShopping()).items.map((item) => item.itemId),
      previousOrder,
    );
    assert.equal(
      (await f.personal.readManualShopping({ cursor: first.nextCursor! })).kind,
      'failed',
    );
    assert.equal((await f.personal.readManualShopping({ limit: 51 })).kind, 'failed');
    const collection = await addCollection(f);
    await member(f, collection.collectionId);
    await member(f, collection.collectionId, otherId);
    const page = ready(await f.personal.readCollection(collection.collectionId, { limit: 1 }));
    await member(f, collection.collectionId, recipeId, false);
    assert.equal(
      (await f.personal.readCollection(collection.collectionId, { cursor: page.nextCursor! })).kind,
      'failed',
    );
  } finally {
    await f.close();
  }
});

test('validation rejects unknown recipes, oversized text, invalid amounts, stale epoch and extra executable fields', async () => {
  const f = await fixture();
  try {
    const command: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId: id(),
      recipeId,
      expectedRevision: null,
      text: 'Valid note',
    };
    for (const changes of [
      { recipeId: '999999' },
      { text: 'x'.repeat(4001) },
      { expectedEpoch: 1 },
      { execute: 'external' },
    ])
      assert.equal(
        (await f.personal.execute({ ...command, ...changes } as PersonalCommand)).kind,
        'failed',
      );
    ready(await f.personal.execute({ ...command, text: '🍲'.repeat(4000) }));
    for (const fields of [
      { name: ' ', amountText: null, unitText: null, category: 'other' },
      { name: 'Item', amountText: 0, unitText: null, category: 'other' },
      { name: 'Item', amountText: null, unitText: null, category: 'invented' },
    ])
      assert.equal(
        (
          await f.personal.execute({
            ...base(),
            kind: 'addManualItem',
            itemId: id(),
            fields,
          } as PersonalCommand)
        ).kind,
        'failed',
      );
    assert.equal(ready(await f.personal.readManualShopping()).items.length, 0);
  } finally {
    await f.close();
  }
});

test('receipt failure rolls back notes/collections atomically and permits a safe same-ID retry', async () => {
  const f = await fixture();
  try {
    const command: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId: id(),
      recipeId,
      expectedRevision: null,
      text: 'Not committed',
    };
    f.failReceipt();
    assert.equal((await f.personal.execute(command)).kind, 'failed');
    assert.equal(ready(await f.personal.readRecipePersonal(recipeId)).note, null);
    ready(await f.personal.execute(command));
    const collection = await addCollection(f);
    await member(f, collection.collectionId);
    const review = ready(await f.personal.reviewDeleteCollection(collection.collectionId)),
      operationId = id();
    f.failReceipt();
    assert.equal((await f.personal.deleteCollection(review, operationId)).kind, 'failed');
    assert.equal(ready(await f.personal.readCollection(collection.collectionId)).items.length, 1);
    ready(await f.personal.deleteCollection(review, operationId));
    assert.equal(ready(await f.personal.readCollections()).items.length, 0);
  } finally {
    await f.close();
  }
});

test('lost acknowledgement returns the actual receipt; noncommit uncertainty can resolve to durable cancellation', async () => {
  const f = await fixture();
  try {
    const command: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId: id(),
      recipeId,
      expectedRevision: null,
      text: 'Persisted',
    };
    f.loseCommit();
    const receipt = ready(await f.personal.execute(command));
    await f.reopen();
    assert.deepEqual(ready(await f.personal.resolveOperation(command.operationId)), receipt);
    const another: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId: id(),
      recipeId: otherId,
      expectedRevision: null,
      text: 'Not persisted',
    };
    f.failReceipt();
    f.failReads();
    assert.equal((await f.personal.execute(another)).kind, 'uncertain');
    f.failReads(false);
    assert.equal(ready(await f.personal.readReceipt(another.operationId)), null);
    const cancelled = ready(await f.personal.resolveOperation(another.operationId));
    assert.equal(cancelled.outcome, 'cancelled');
    await f.reopen();
    assert.deepEqual(ready(await f.personal.execute(another)), cancelled);
    assert.equal(ready(await f.personal.readRecipePersonal(otherId)).note, null);
  } finally {
    await f.close();
  }
});

test('terminal cancellation fences a hash-delayed mutation and pre-dispatch collection deletion', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    const command: PersonalCommand = {
      ...base(),
      kind: 'saveNote',
      noteId: id(),
      recipeId,
      expectedRevision: null,
      text: 'Delayed',
    };
    const hold = f.pauseHash();
    release = hold.release;
    const pending = f.personal.execute(command);
    await hold.entered;
    const cancelled = ready(await f.personal.resolveOperation(command.operationId));
    hold.release();
    assert.deepEqual(ready(await pending), cancelled);
    assert.equal(ready(await f.personal.readRecipePersonal(recipeId)).note, null);
    const collection = await addCollection(f),
      review = ready(await f.personal.reviewDeleteCollection(collection.collectionId)),
      operationId = id();
    assert.equal(ready(await f.personal.resolveOperation(operationId)).outcome, 'cancelled');
    assert.equal(
      ready(await f.personal.deleteCollection(review, operationId)).outcome,
      'cancelled',
    );
    assert.equal(ready(await f.personal.readCollections()).items.length, 1);
  } finally {
    release?.();
    await f.close();
  }
});

test('format1 restore leaves private entities and operation fences untouched after expanded exports are enabled', async () => {
  const f = await fixture(false);
  try {
    const original = ready(await f.services.queries.readPortableBackup());
    assert.equal(original.schemaVersion, 1);
    await f.reopen();
    ready(
      await f.personal.execute({
        ...base(),
        kind: 'saveNote',
        noteId: id(),
        recipeId,
        expectedRevision: null,
        text: 'PRIVATE NOT EXPORTED',
      }),
    );
    await addCollection(f);
    await addManual(f);
    const before = Object.fromEntries(
      [
        'recipe_note',
        'personal_collection',
        'personal_collection_member',
        'manual_shopping_item',
        'personal_operation',
        'personal_state',
      ].map((table) => [table, f.database.prepare(`SELECT * FROM ${table}`).all()]),
    );
    const backup = ready(await f.services.queries.readPortableBackup());
    assert.equal(backup.schemaVersion, 2);
    assert.equal(backup.databaseSchemaVersion, 5);
    assert.deepEqual(backup.data.favourites, original.data.favourites);
    assert.equal(JSON.stringify(backup).includes('PRIVATE'), true);
    assert.equal(backup.data.cookingHistory, undefined);
    const restore = f.services.portableRestore!,
      review = ready(await restore.review(JSON.stringify(original)));
    assert.deepEqual(review.blockers, []);
    assert.equal((await restore.execute(ready(await restore.prepare(review)))).kind, 'receipt');
    for (const [table, rows] of Object.entries(before))
      assert.deepEqual(f.database.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.ok(f.services.cooking);
    assert.equal(ready(await f.services.cooking.readHistory()).items.length, 0);
  } finally {
    await f.close();
  }
});

test('pre-migration schema4 facade is fenced on its first post-schema5 mutation', async () => {
  const f = await fixture(false);
  try {
    const legacy = f.services,
      review = ready(
        await legacy.commands.reviewDirect({ kind: 'setFavourite', recipeId, saved: true }),
      );
    const upgraded = await f.open();
    assert.equal(upgraded.kind, 'ready');
    if (upgraded.kind !== 'ready') assert.fail();
    assert.equal((await legacy.commands.prepareDirect(review)).kind, 'failed');
    assert.equal(ready(await upgraded.services.queries.readFavourites()).length, 0);
  } finally {
    await f.close();
  }
});
