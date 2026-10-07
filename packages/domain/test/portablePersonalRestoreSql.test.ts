import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createPortableBackup } from '../src/portableBackup';
import type { ManualShoppingItem, PersonalCollection, RecipeNote } from '../src/personal';
import type { PortablePersonalData } from '../src/portableBackupExpanded';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { readBackupData } from '../../../apps/mobile/src/data/portableBackup';
import {
  checkPortablePersonalRestore,
  replaceExpandedBackupData,
} from '../../../apps/mobile/src/data/portableRestoreExpanded';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  StorageFault,
} from '../../../apps/mobile/src/data/sql';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const at = '2026-10-01T08:00:00.000Z';
const restoredAt = '2026-10-01T10:00:00.000Z';
const recipeIds = catalogue.recipes.slice(0, 4).map((recipe) => recipe.recipeId);
const [recipeA, recipeB, recipeC, recipeD] = recipeIds as [string, string, string, string];
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const empty = (): PortablePersonalData => ({
  notes: [],
  collections: [],
  memberships: [],
  manualItems: [],
});
const note = (recipeId: string, deleted = false): RecipeNote => ({
  noteId: randomUUID(),
  recipeId,
  deleted,
  text: deleted ? null : 'PRIVATE NOTE',
  revision: 3,
  createdAt: at,
  updatedAt: at,
});
const collection = (deleted = false): PersonalCollection => ({
  collectionId: randomUUID(),
  deleted,
  name: deleted ? null : 'PRIVATE COLLECTION',
  revision: 3,
  createdAt: at,
  updatedAt: at,
});
const manual = (deleted = false): ManualShoppingItem => ({
  kind: 'manual',
  itemId: randomUUID(),
  deleted,
  name: deleted ? null : 'PRIVATE ITEM',
  amountText: deleted ? null : 'two',
  unitText: deleted ? null : 'packs',
  category: deleted ? null : 'pantry',
  purchased: !deleted,
  revision: 3,
  createdAt: at,
  updatedAt: at,
});
const member = (parent: PersonalCollection, recipeId: string, present = true) => ({
  collectionId: parent.collectionId,
  recipeId,
  present,
  revision: 3,
  updatedAt: at,
});
async function source(personal?: PortablePersonalData) {
  return createPortableBackup(
    {
      schemaVersion: personal ? 2 : 1,
      databaseSchemaVersion: 5,
      catalogue: catalogue.identity,
      createdAt: at,
      sourceRevision: 3,
      data: {
        favourites: [],
        occurrences: [],
        shopping: {
          scope: { scopeId: randomUUID(), revision: 0, occurrenceIds: [] },
          projectionRevision: 0,
          projectionStatus: 'current',
          purchaseMarks: [],
        },
        preferences: {
          snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
          removals: [],
        },
        ...(personal ? { personal } : {}),
      },
    },
    sha256,
  );
}
async function fixture(current: PortablePersonalData) {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
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
    },
  );
  // The disposable in-memory connection is accessed strictly serially in this fixture.
  const reader = new SerializedReader(storage.connection);
  const db = storage.database;
  db.exec('BEGIN');
  for (const row of current.notes)
    db.prepare('INSERT INTO recipe_note VALUES (?,?,?,?,?,?,?)').run(
      row.noteId,
      row.recipeId,
      row.text === null ? null : JSON.stringify(row.text),
      Number(row.deleted),
      row.revision,
      row.createdAt,
      row.updatedAt,
    );
  for (const row of current.collections)
    db.prepare('INSERT INTO personal_collection VALUES (?,?,?,?,?,?)').run(
      row.collectionId,
      row.name === null ? null : JSON.stringify(row.name),
      Number(row.deleted),
      row.revision,
      row.createdAt,
      row.updatedAt,
    );
  for (const row of current.memberships)
    db.prepare('INSERT INTO personal_collection_member VALUES (?,?,?,?,?)').run(
      row.collectionId,
      row.recipeId,
      Number(row.present),
      row.revision,
      row.updatedAt,
    );
  for (const row of current.manualItems)
    db.prepare('INSERT INTO manual_shopping_item VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      row.itemId,
      row.name === null ? null : JSON.stringify(row.name),
      row.amountText === null ? null : JSON.stringify(row.amountText),
      row.unitText === null ? null : JSON.stringify(row.unitText),
      row.category,
      Number(row.purchased),
      Number(row.deleted),
      row.revision,
      row.createdAt,
      row.updatedAt,
    );
  db.exec('UPDATE personal_state SET revision=3,epoch=2');
  const operationId = randomUUID();
  db.prepare('INSERT INTO personal_operation VALUES (?,NULL,?)').run(
    operationId,
    JSON.stringify({
      operationId,
      outcome: 'cancelled',
      commandKind: null,
      entityId: null,
      revision: 3,
      epoch: 2,
      committedAt: at,
      affectedMemberships: 0,
    }),
  );
  db.exec('UPDATE cooking_state SET session_revision=3,history_revision=3,history_epoch=2');
  db.prepare("INSERT INTO cooking_event VALUES (?,2,'cleared',NULL,NULL,NULL,NULL)").run(
    randomUUID(),
  );
  db.exec('COMMIT');
  const tables = [
    'recipe_note',
    'personal_collection',
    'personal_collection_member',
    'manual_shopping_item',
    'personal_state',
    'personal_operation',
    'cooking_state',
    'cooking_event',
  ];
  return {
    db,
    writer,
    reader,
    rows: () =>
      JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])),
    personal: () =>
      reader.transaction(async (session) => (await readBackupData(session, true)).personal!),
    async close() {
      await storage.connection.close();
    },
  };
}

test('actual replacement retains removals, redacts omitted live rows and replaces reviewed same-identity content', async () => {
  const keptNote = note(recipeA),
    removedNote = note(recipeB, true),
    omittedNote = note(recipeC);
  const keptCollection = collection(),
    removedCollection = collection(true),
    omittedCollection = collection();
  const keptItem = manual(),
    removedItem = manual(true),
    omittedItem = manual();
  const current: PortablePersonalData = {
    notes: [keptNote, removedNote, omittedNote],
    collections: [keptCollection, removedCollection, omittedCollection],
    memberships: [
      member(keptCollection, recipeA),
      member(keptCollection, recipeB, false),
      member(removedCollection, recipeD, false),
      member(omittedCollection, recipeC),
    ],
    manualItems: [keptItem, removedItem, omittedItem],
  };
  const imported: PortablePersonalData = {
    notes: [{ ...keptNote, text: '  Reviewed replacement 👩🏽‍🍳\nExact text  ' }],
    collections: [{ ...keptCollection, name: 'Reviewed collection name' }],
    memberships: [member(keptCollection, recipeA)],
    manualItems: [{ ...keptItem, name: 'Reviewed item', amountText: 'three', purchased: false }],
  };
  const f = await fixture(current);
  try {
    const file = await source(imported),
      original = JSON.stringify(file);
    const receipts = f.db.prepare('SELECT * FROM personal_operation').all();
    const history = f.db.prepare('SELECT * FROM cooking_event').all();
    assert.equal(
      (await f.reader.transaction((session) => checkPortablePersonalRestore(session, file)))
        .allowed,
      true,
    );
    await f.writer.transaction((session) =>
      replaceExpandedBackupData(session, file, randomUUID(), 4, sha256, restoredAt),
    );
    const result = await f.personal();
    assert.equal(
      result.notes.find((row) => row.recipeId === recipeA)!.text,
      imported.notes[0]!.text,
    );
    assert.deepEqual(
      result.notes.find((row) => row.recipeId === recipeB),
      { ...removedNote, revision: 4 },
    );
    assert.deepEqual(
      result.notes.find((row) => row.recipeId === recipeC),
      { ...omittedNote, deleted: true, text: null, revision: 4, updatedAt: restoredAt },
    );
    assert.deepEqual(
      result.collections.find((row) => row.collectionId === removedCollection.collectionId),
      { ...removedCollection, revision: 4 },
    );
    assert.equal(
      result.collections.find((row) => row.collectionId === omittedCollection.collectionId)!.name,
      null,
    );
    assert.deepEqual(
      result.manualItems.find((row) => row.itemId === omittedItem.itemId),
      {
        ...omittedItem,
        name: null,
        amountText: null,
        unitText: null,
        category: null,
        purchased: false,
        deleted: true,
        revision: 4,
        updatedAt: restoredAt,
      },
    );
    assert.equal(result.memberships.filter((row) => !row.present).length, 3);
    assert.equal(
      result.memberships.find((row) => row.collectionId === omittedCollection.collectionId)!
        .updatedAt,
      restoredAt,
    );
    assert.deepEqual(
      { ...f.db.prepare('SELECT revision,epoch FROM personal_state').get() },
      { revision: 4, epoch: 3 },
    );
    assert.deepEqual(f.db.prepare('SELECT * FROM personal_operation').all(), receipts);
    assert.deepEqual(f.db.prepare('SELECT * FROM cooking_event').all(), history);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(JSON.stringify(file), original);
    const stale = await source(current);
    const later = await f.reader.transaction((session) =>
      checkPortablePersonalRestore(session, stale),
    );
    assert.equal(later.allowed, false);
    assert.ok(
      later.conflicts.some((row) => row.kind === 'note_removed' && row.recipeId === recipeC),
    );
  } finally {
    await f.close();
  }
});

test('read-only checker blocks live resurrection by recipe, UUID, removed membership and deleted parent without private values', async () => {
  const oldNote = note(recipeA, true),
    oldCollection = collection(true),
    liveCollection = collection(),
    oldItem = manual(true);
  const current: PortablePersonalData = {
    notes: [oldNote],
    collections: [oldCollection, liveCollection],
    memberships: [member(liveCollection, recipeA, false)],
    manualItems: [oldItem],
  };
  const imported: PortablePersonalData = {
    notes: [{ ...oldNote, noteId: randomUUID(), deleted: false, text: 'PRIVATE RESURRECTION' }],
    collections: [{ ...oldCollection, deleted: false, name: 'PRIVATE REVIVAL' }, liveCollection],
    memberships: [member(liveCollection, recipeA), member(oldCollection, recipeB)],
    manualItems: [
      {
        ...oldItem,
        deleted: false,
        name: 'PRIVATE ITEM REVIVAL',
        category: 'pantry',
        purchased: true,
      },
    ],
  };
  const f = await fixture(current);
  try {
    const file = await source(imported),
      before = f.rows();
    const first = await f.reader.transaction((session) =>
      checkPortablePersonalRestore(session, file),
    );
    const second = await f.reader.transaction((session) =>
      checkPortablePersonalRestore(session, file),
    );
    assert.deepEqual(first, second);
    assert.deepEqual(
      new Set(first.conflicts.map((row) => row.kind)),
      new Set([
        'note_removed',
        'collection_removed',
        'manual_item_removed',
        'membership_removed',
        'parent_collection_removed',
      ]),
    );
    assert.ok(
      first.conflicts.some(
        (row) =>
          row.kind === 'note_removed' &&
          row.entityId === oldNote.noteId &&
          row.recipeId === recipeA,
      ),
    );
    assert.ok(!JSON.stringify(first).includes('PRIVATE'));
    assert.ok(Object.isFrozen(first.conflicts));
    assert.equal(f.rows(), before);
    await assert.rejects(
      f.writer.transaction((session) =>
        replaceExpandedBackupData(session, file, randomUUID(), 4, sha256, restoredAt),
      ),
      (error: unknown) =>
        error instanceof StorageFault &&
        error.message === 'Personal restore conflicts with retained removals or note identity',
    );
    assert.equal(f.rows(), before);
  } finally {
    await f.close();
  }
});

test('note identity collisions fail while an imported deleted alias retains the local recipe-note identity', async () => {
  const original = note(recipeA);
  const f = await fixture({ ...empty(), notes: [original] });
  try {
    for (const incoming of [
      { ...original, noteId: randomUUID() },
      { ...original, recipeId: recipeB },
    ]) {
      const file = await source({ ...empty(), notes: [incoming] });
      const check = await f.reader.transaction((session) =>
        checkPortablePersonalRestore(session, file),
      );
      assert.equal(check.allowed, false);
      assert.equal(check.conflicts[0]!.kind, 'note_identity_conflict');
    }
    const file = await source({
      ...empty(),
      notes: [{ ...original, noteId: randomUUID(), deleted: true, text: null }],
    });
    assert.equal(
      (await f.reader.transaction((session) => checkPortablePersonalRestore(session, file)))
        .allowed,
      true,
    );
    await f.writer.transaction((session) =>
      replaceExpandedBackupData(session, file, randomUUID(), 4, sha256, restoredAt),
    );
    assert.deepEqual((await f.personal()).notes, [
      { ...original, deleted: true, text: null, revision: 4, updatedAt: restoredAt },
    ]);
  } finally {
    await f.close();
  }
});

test('omitted personal scope neither reads personal state nor withdraws rows or advances epochs', async () => {
  const f = await fixture({ ...empty(), notes: [note(recipeA)], manualItems: [manual(true)] });
  try {
    const file = await source(),
      before = f.rows();
    const observed: string[] = [];
    const check = await f.reader.transaction((session) =>
      checkPortablePersonalRestore(
        {
          ...session,
          all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
            observed.push(sql);
            return session.all<Row>(sql, values);
          },
        },
        file,
      ),
    );
    assert.equal(check.allowed, true);
    assert.deepEqual(observed, []);
    await f.writer.transaction((session) =>
      replaceExpandedBackupData(session, file, randomUUID(), 4, sha256, restoredAt),
    );
    assert.equal(f.rows(), before);
  } finally {
    await f.close();
  }
});

test('a SQL failure rolls back retained removals and all synthesized withdrawals together', async () => {
  const f = await fixture({
    ...empty(),
    notes: [note(recipeA), note(recipeB, true)],
    manualItems: [manual(), manual(true)],
  });
  try {
    const file = await source(empty()),
      before = f.rows();
    await assert.rejects(
      f.writer.transaction((session) =>
        replaceExpandedBackupData(
          {
            ...session,
            prepare: async (sql) => {
              if (sql.startsWith('INSERT INTO manual_shopping_item'))
                throw new Error('Injected personal write failure');
              return session.prepare(sql);
            },
          },
          file,
          randomUUID(),
          4,
          sha256,
          restoredAt,
        ),
      ),
      /Injected personal write failure/,
    );
    assert.equal(f.rows(), before);
  } finally {
    await f.close();
  }
});

test('retained tombstones that exceed portable limits fail without pruning or replacing any existing record', async () => {
  const current = {
    ...empty(),
    collections: Array.from({ length: 10000 }, () => collection(true)),
  };
  const f = await fixture(current);
  try {
    const file = await source({ ...empty(), collections: [collection(true)] });
    const before = f.rows();
    await assert.rejects(
      f.writer.transaction((session) =>
        replaceExpandedBackupData(session, file, randomUUID(), 4, sha256, restoredAt),
      ),
      (error: unknown) =>
        error instanceof StorageFault &&
        error.message ===
          'Personal restore retained records exceed supported bounds or relationships',
    );
    assert.equal(f.rows(), before);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM personal_collection').get()!.count,
      10000,
    );
  } finally {
    await f.close();
  }
});
