import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { AccountPersonalData } from '@cookmate/account-sync';
import { validateAccountPersonal } from '@cookmate/account-sync';
import { applyReviewedAccountPersonal } from '../../../apps/mobile/src/data/accountPersonalApply';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  collectionColumns,
  manualColumns,
  membershipColumns,
  noteColumns,
  parseCollection,
  parseManual,
  parseMembership,
  parseNote,
} from '../../../apps/mobile/src/data/personalRecords';
import type {
  CollectionRow,
  ManualRow,
  MembershipRow,
  NoteRow,
} from '../../../apps/mobile/src/data/personalRecords';
import {
  configureConnection,
  SerializedWriter,
  StorageFault,
} from '../../../apps/mobile/src/data/sql';
import type { SqlSession } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const at = '2026-10-01T08:00:00.000Z';
const later = '2026-10-01T10:00:00.000Z';
const recipeA = catalogue.recipes[0]!.recipeId;
const recipeB = catalogue.recipes[1]!.recipeId;
const empty = (): AccountPersonalData => ({
  notes: [],
  collections: [],
  memberships: [],
  manualItems: [],
});
const note = (recipeId = recipeA, deleted = false): AccountPersonalData['notes'][number] => ({
  noteId: randomUUID(),
  recipeId,
  text: deleted ? null : '  Exact note\n\u0000\ud800 عربي  ',
  deleted,
  createdAt: at,
  updatedAt: later,
});
const collection = (deleted = false): AccountPersonalData['collections'][number] => ({
  collectionId: randomUUID(),
  name: deleted ? null : '  Dinners\u0000\udfff  ',
  deleted,
  createdAt: at,
  updatedAt: later,
});
const manual = (deleted = false): AccountPersonalData['manualItems'][number] => ({
  kind: 'manual',
  itemId: randomUUID(),
  name: deleted ? null : '  ليمون\u0000\ud800  ',
  amountText: deleted ? null : '  ½–2\u0000  ',
  unitText: deleted ? null : ' packs\udfff ',
  category: deleted ? null : 'produce',
  purchased: !deleted,
  deleted,
  createdAt: at,
  updatedAt: later,
});
function sample(): AccountPersonalData {
  const live = collection(),
    removed = collection(true);
  return {
    notes: [note(), note(recipeB, true)],
    collections: [live, removed],
    memberships: [
      { collectionId: live.collectionId, recipeId: recipeA, present: true, updatedAt: later },
      { collectionId: live.collectionId, recipeId: recipeB, present: false, updatedAt: later },
    ],
    manualItems: [manual(), manual(true)],
  };
}
const personalTables = new Set([
  'recipe_note',
  'personal_collection',
  'personal_collection_member',
  'manual_shopping_item',
  'personal_state',
]);
const reason = (error: unknown) => error instanceof StorageFault;

async function fixture(schema: 5 | 6 = 5) {
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
    {
      installationId: randomUUID(),
      shoppingScopeId: randomUUID(),
      conversationId: randomUUID(),
    },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: schema === 6,
    },
  );
  const db = storage.database;
  db.exec('UPDATE state_revision SET revision=11');
  db.exec('UPDATE cooking_state SET session_revision=8,history_revision=9,history_epoch=4');
  for (const outcome of ['committed', 'no_op', 'cancelled'] as const) {
    const operationId = randomUUID();
    db.prepare('INSERT INTO personal_operation VALUES (?,?,?)').run(
      operationId,
      outcome === 'cancelled' ? null : 'b'.repeat(64),
      JSON.stringify({
        operationId,
        outcome,
        commandKind: outcome === 'cancelled' ? null : 'saveNote',
        entityId: outcome === 'cancelled' ? null : recipeA,
        revision: 2,
        epoch: 0,
        committedAt: at,
        affectedMemberships: 0,
      }),
    );
  }
  const tableNames = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  const dump = (all = false) =>
    JSON.stringify(
      tableNames
        .filter((name) => all || !personalTables.has(name))
        .map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
    );
  const read = async (session: SqlSession): Promise<AccountPersonalData> => {
    const wire = <Row extends { revision: number }>(row: Row): Omit<Row, 'revision'> => {
      const { revision: _revision, ...value } = row;
      return value;
    };
    return {
      notes: (await session.all<NoteRow>(`SELECT ${noteColumns} FROM recipe_note`))
        .map(parseNote)
        .map(wire),
      collections: (
        await session.all<CollectionRow>(`SELECT ${collectionColumns} FROM personal_collection`)
      )
        .map(parseCollection)
        .map(wire),
      memberships: (
        await session.all<MembershipRow>(
          `SELECT ${membershipColumns} FROM personal_collection_member`,
        )
      )
        .map(parseMembership)
        .map(wire),
      manualItems: (
        await session.all<ManualRow>(`SELECT ${manualColumns} FROM manual_shopping_item`)
      )
        .map(parseManual)
        .map(wire),
    };
  };
  return {
    ...storage,
    writer,
    dump,
    read,
    apply: (personal: AccountPersonalData) =>
      writer.transaction((session) => applyReviewedAccountPersonal(session, personal)),
  };
}

for (const schema of [5, 6] as const)
  test(`schema${schema}: exact reviewed replacement keeps receipts, source and unrelated clocks`, async () => {
    const f = await fixture(schema);
    try {
      const before = f.dump(),
        candidate = sample();
      assert.deepEqual(await f.apply(candidate), { changed: true, revision: 1, epoch: 1 });
      assert.deepEqual(await f.writer.transaction(f.read), candidate);
      assert.equal(f.dump(), before);
      assert.equal(f.database.prepare('PRAGMA foreign_key_check').all().length, 0);
      for (const table of personalTables) {
        if (table === 'personal_state') continue;
        assert.deepEqual(
          f.database
            .prepare(`SELECT DISTINCT revision FROM ${table}`)
            .all()
            .map((row) => row.revision),
          [1],
        );
      }
      assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
    } finally {
      await f.writer.close();
    }
  });

test('order/key-order-only changes are no-ops and do not prepare writes or advance exhausted clocks', async () => {
  const f = await fixture();
  try {
    const candidate = sample();
    await f.apply(candidate);
    f.database
      .prepare('UPDATE personal_state SET revision=?,epoch=?')
      .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const before = f.dump(true),
      prepared = f.statementCounts().prepared;
    const reordered = Object.fromEntries(
      Object.entries(candidate)
        .reverse()
        .map(([key, rows]) => [
          key,
          [...rows].reverse().map((row) => Object.fromEntries(Object.entries(row).reverse())),
        ]),
    ) as unknown as AccountPersonalData;
    assert.deepEqual(await f.apply(reordered), {
      changed: false,
      revision: Number.MAX_SAFE_INTEGER,
      epoch: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(f.dump(true), before);
    assert.equal(f.statementCounts().prepared, prepared);
  } finally {
    await f.writer.close();
  }
});

test('fresh replacement revisions exceed every retained local row clock and advance epoch once', async () => {
  const f = await fixture();
  try {
    const candidate = sample();
    await f.apply(candidate);
    f.database.exec('UPDATE personal_state SET revision=9,epoch=12');
    f.database.exec('UPDATE recipe_note SET revision=17');
    f.database.exec('UPDATE personal_collection SET revision=24');
    f.database.exec('UPDATE personal_collection_member SET revision=37');
    f.database.exec('UPDATE manual_shopping_item SET revision=49');
    candidate.notes[0]!.text = 'Reviewed replacement';
    assert.deepEqual(await f.apply(candidate), { changed: true, revision: 50, epoch: 13 });
    assert.deepEqual(await f.writer.transaction(f.read), candidate);
  } finally {
    await f.writer.close();
  }
});

test('omitted note, collection, membership and manual removals each fail without writes', async () => {
  const f = await fixture();
  try {
    const candidate = sample();
    await f.apply(candidate);
    const before = f.dump(true);
    for (const key of ['notes', 'collections', 'memberships', 'manualItems'] as const) {
      const incoming = structuredClone(candidate);
      incoming[key].splice(1, 1);
      await assert.rejects(f.apply(incoming), reason);
      assert.equal(f.dump(true), before, key);
    }
  } finally {
    await f.writer.close();
  }
});

test('explicit reviewed counterparts can revive exact merge identities and preserve other removals', async () => {
  const f = await fixture();
  try {
    const candidate = sample();
    await f.apply(candidate);
    const before = f.dump();
    const revived = structuredClone(candidate);
    Object.assign(revived.notes[1]!, {
      deleted: false,
      text: 'Reviewed returned note',
      updatedAt: later,
    });
    Object.assign(revived.collections[1]!, {
      deleted: false,
      name: 'Reviewed returned collection',
    });
    revived.memberships[1]!.present = true;
    Object.assign(revived.manualItems[1]!, {
      deleted: false,
      name: 'Reviewed returned item',
      amountText: '2',
      unitText: null,
      category: 'pantry',
      purchased: true,
    });
    assert.deepEqual(await f.apply(revived), { changed: true, revision: 2, epoch: 2 });
    assert.deepEqual(await f.writer.transaction(f.read), revived);
    assert.equal(f.dump(), before);
  } finally {
    await f.writer.close();
  }
});

test('strict wire and relational validation rejects malformed, duplicate and unknown recipes including removals', async () => {
  const f = await fixture();
  try {
    const base = sample();
    await f.apply(base);
    const before = f.dump(true);
    const invalid: unknown[] = [];
    invalid.push({ ...base, revision: 500 });
    const localRow = structuredClone(base);
    Object.assign(localRow.notes[0]!, { revision: 200 });
    invalid.push(localRow);
    const duplicate = structuredClone(base);
    duplicate.notes.push({ ...duplicate.notes[0]! });
    invalid.push(duplicate);
    for (const deleted of [false, true]) {
      const unknown = structuredClone(base);
      unknown.notes.push(note('99999999999999999999', deleted));
      invalid.push(unknown);
      const unknownMember = structuredClone(base);
      unknownMember.memberships.push({
        collectionId: base.collections[0]!.collectionId,
        recipeId: '99999999999999999999',
        present: !deleted,
        updatedAt: at,
      });
      invalid.push(unknownMember);
    }
    const missingParent = structuredClone(base);
    missingParent.memberships[0]!.collectionId = randomUUID();
    invalid.push(missingParent);
    const removedParent = structuredClone(base);
    removedParent.memberships[0]!.collectionId = removedParent.collections[1]!.collectionId;
    invalid.push(removedParent);
    let getterCalls = 0;
    invalid.push({
      ...base,
      get notes() {
        getterCalls++;
        return base.notes;
      },
    });
    for (const value of invalid) {
      await assert.rejects(f.apply(value as AccountPersonalData), reason);
      assert.equal(f.dump(true), before);
    }
    assert.equal(getterCalls, 0);
  } finally {
    await f.writer.close();
  }
});

test('candidate row and encoded byte bounds fail before any personal writes', async () => {
  const f = await fixture();
  try {
    const before = f.dump(true);
    const tooMany = empty();
    tooMany.manualItems = Array.from({ length: 5001 }, () => manual());
    await assert.rejects(f.apply(tooMany), reason);
    const tooLarge = empty();
    tooLarge.manualItems = Array.from({ length: 2500 }, () => ({
      ...manual(),
      name: '🧑'.repeat(160),
      amountText: '🧑'.repeat(80),
      unitText: '🧑'.repeat(80),
    }));
    assert.equal(validateAccountPersonal(tooLarge), true);
    await assert.rejects(f.apply(tooLarge), reason);
    assert.equal(f.dump(true), before);
  } finally {
    await f.writer.close();
  }
});

test('outer cancellation/guard failure rolls back applied personal data and companion writes', async () => {
  const f = await fixture();
  try {
    const before = f.dump(true);
    await assert.rejects(
      f.writer.transaction(
        async (session) => {
          await applyReviewedAccountPersonal(session, sample());
          await session.exec(
            "INSERT INTO app_metadata VALUES ('account-test-marker','never commit')",
          );
        },
        { kind: 'none' },
        () => {
          throw new Error('owner changed before commit');
        },
      ),
      /owner changed/,
    );
    assert.equal(f.dump(true), before);
    assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
  } finally {
    await f.writer.close();
  }
});

test('an insertion failure after deletes rolls back exactly and finalizes the failed statement', async () => {
  const f = await fixture();
  try {
    const candidate = sample();
    await f.apply(candidate);
    const before = f.dump(true);
    candidate.notes[0]!.text = 'Would otherwise replace';
    const originalPrepare = f.connection.prepare;
    f.connection.prepare = async (sql) => {
      const statement = await originalPrepare(sql);
      if (sql.startsWith('INSERT INTO manual_shopping_item'))
        return {
          ...statement,
          run: async () => {
            throw new Error('injected write failure');
          },
        };
      return statement;
    };
    await assert.rejects(f.apply(candidate), /injected write failure/);
    assert.equal(f.dump(true), before);
    assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
  } finally {
    await f.writer.close();
  }
});

test('candidate is snapshotted before the first await so an external mutation cannot change approved bytes', async () => {
  const f = await fixture();
  try {
    const candidate = sample(),
      expected = structuredClone(candidate);
    await f.writer.transaction((session) =>
      applyReviewedAccountPersonal(
        {
          ...session,
          all: async (sql, values) => {
            candidate.notes[0]!.text = 'Unreviewed mutation';
            candidate.manualItems[0]!.purchased = false;
            return session.all(sql, values);
          },
        },
        candidate,
      ),
    );
    assert.deepEqual(await f.writer.transaction(f.read), expected);
  } finally {
    await f.writer.close();
  }
});

test('changed data at exhausted revision or epoch fails atomically, as does unsupported storage', async () => {
  const f = await fixture();
  try {
    for (const column of ['revision', 'epoch']) {
      f.database.exec('UPDATE personal_state SET revision=0,epoch=0');
      f.database.prepare(`UPDATE personal_state SET ${column}=?`).run(Number.MAX_SAFE_INTEGER);
      const before = f.dump(true);
      await assert.rejects(f.apply(sample()), reason);
      assert.equal(f.dump(true), before);
    }
    f.database.exec('PRAGMA user_version=7');
    await assert.rejects(
      f.apply(empty()),
      (error: unknown) => error instanceof StorageFault && error.code === 'incompatible_version',
    );
  } finally {
    await f.writer.close();
  }
});
