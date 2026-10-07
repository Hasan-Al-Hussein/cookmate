import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { AccountReplicationError, type AccountPersonalData } from '@cookmate/account-sync';
import {
  applyReviewedAccountContentPersonal,
  type AccountContentPersonalApplyOptions,
} from '../../../apps/mobile/src/data/accountContentPersonalApply';
import { applyReviewedAccountPersonal } from '../../../apps/mobile/src/data/accountPersonalApply';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import type { ContentReferenceInspectionView } from '../../../apps/mobile/src/data/contentReleaseStore';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  readAccountContentPersonalRows,
  readPortablePersonalRestoreState,
} from '../../../apps/mobile/src/data/portablePersonalRestore';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection } from './helpers/sqlite';

// Actual disposable schema8 persistence. The controlled reservation supplies already-authenticated
// identities; these tests do not establish signature trust or a human's merge-review approval.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  authoredId = '9000000000000000001',
  withdrawnId = '9000000000000000002',
  futureId = '9000000000000000003',
  at = '2026-10-01T12:00:00.000Z',
  later = '2026-10-01T13:00:00.000Z';
const empty = (): AccountPersonalData => ({
  notes: [],
  collections: [],
  memberships: [],
  manualItems: [],
});
function sample(): AccountPersonalData {
  const collectionId = randomUUID();
  return {
    notes: [authoredId, withdrawnId].map((recipeId) => ({
      noteId: randomUUID(),
      recipeId,
      text: '  Raw\nعربي\u0000\ud800  ',
      deleted: false,
      createdAt: at,
      updatedAt: later,
    })),
    collections: [
      {
        collectionId,
        name: '  Dinner\u0000\udfff  ',
        deleted: false,
        createdAt: at,
        updatedAt: later,
      },
    ],
    memberships: [{ collectionId, recipeId: authoredId, present: true, updatedAt: later }],
    manualItems: [
      {
        kind: 'manual',
        itemId: randomUUID(),
        name: ' ليمون ',
        amountText: ' ½–2\u0000 ',
        unitText: ' packs\udfff ',
        category: 'produce',
        purchased: true,
        deleted: false,
        createdAt: at,
        updatedAt: later,
      },
    ],
  };
}
function removed(candidate: AccountPersonalData): AccountPersonalData {
  return {
    notes: candidate.notes.map((row) => ({ ...row, text: null, deleted: true })),
    collections: candidate.collections.map((row) => ({ ...row, name: null, deleted: true })),
    memberships: candidate.memberships.map((row) => ({ ...row, present: false })),
    manualItems: candidate.manualItems.map((row) => ({
      ...row,
      name: null,
      amountText: null,
      unitText: null,
      category: null,
      purchased: false,
      deleted: true,
    })),
  };
}
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;

async function fixture(t: TestContext) {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  t.after(() => writer.close());
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
  const db = storage.database;
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId }),
  );
  await migrateCookingContentDatabase(writer, { sha256 });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const cancelledId = randomUUID();
  db.prepare('INSERT INTO personal_operation VALUES (?,?,?)').run(
    cancelledId,
    null,
    JSON.stringify({
      operationId: cancelledId,
      outcome: 'cancelled',
      commandKind: null,
      entityId: null,
      revision: 0,
      epoch: 0,
      committedAt: at,
      affectedMemberships: 0,
    }),
  );
  let active = true,
    access = true;
  const inventory = [...catalogue.recipes.map((row) => row.recipeId), authoredId, withdrawnId];
  const view: ContentReferenceInspectionView = {
    head: { releaseId: 'personal-adopted', sequence: 2, fingerprint: 'a'.repeat(64) },
    latestHead: { releaseId: 'personal-adopted', sequence: 2, fingerprint: 'a'.repeat(64) },
    adoptedRecipeIds: inventory,
    get entries(): never {
      throw new Error('Personal identity apply must not read recipe bodies');
    },
    assertActive() {
      if (!active) throw new Error('reservation expired');
      return undefined;
    },
  };
  const options: AccountContentPersonalApplyOptions = {
    ownerId,
    view,
    assertAccess() {
      if (!access) throw new Error('owner expired');
      return undefined;
    },
  };
  const tableNames = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  const own = new Set([
    'personal_state',
    'recipe_note',
    'personal_collection',
    'personal_collection_member',
    'manual_shopping_item',
    'recipe_identity',
  ]);
  const dump = (all = true) =>
    JSON.stringify(
      tableNames
        .filter((name) => all || !own.has(name))
        .map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
    );
  const read = () =>
    writer.transaction(async (session) => {
      const { personal } = await readAccountContentPersonalRows(session);
      const wire = <Row extends { revision: number }>(row: Row) => {
        const { revision: _revision, ...rest } = row;
        return rest;
      };
      return {
        notes: personal.notes.map(wire),
        collections: personal.collections.map(wire),
        memberships: personal.memberships.map(wire),
        manualItems: personal.manualItems.map(wire),
      };
    });
  return {
    ...storage,
    writer,
    options,
    inventory,
    dump,
    read,
    expire: () => {
      active = false;
    },
    revoke: () => {
      access = false;
    },
    apply: (candidate: AccountPersonalData) =>
      writer.transaction(
        (session) => applyReviewedAccountContentPersonal(session, candidate, options),
        { kind: 'none' },
        options.assertAccess,
      ),
  };
}

test('private8 applies authored/withdrawn adopted identities without source rows or bodies and preserves raw values/receipts', async (t) => {
  const f = await fixture(t),
    candidate = sample(),
    unrelated = f.dump(false);
  assert.deepEqual(await f.apply(candidate), { changed: true, revision: 1, epoch: 1 });
  assert.deepEqual(await f.read(), candidate);
  assert.equal(f.dump(false), unrelated);
  for (const id of [authoredId, withdrawnId]) {
    assert.equal(
      f.database.prepare('SELECT COUNT(*) count FROM recipe_identity WHERE recipe_id=?').get(id)!
        .count,
      1,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) count FROM recipe WHERE recipe_id=?').get(id)!.count,
      0,
    );
  }
});

test('private8 no-op keeps exhausted clocks; changed data allocates above all row clocks and increments epoch once', async (t) => {
  const f = await fixture(t),
    candidate = sample();
  await f.apply(candidate);
  f.database.exec(
    'UPDATE recipe_note SET revision=41;UPDATE personal_state SET revision=5,epoch=7',
  );
  candidate.manualItems[0]!.purchased = false;
  assert.deepEqual(await f.apply(candidate), { changed: true, revision: 42, epoch: 8 });
  f.database
    .prepare('UPDATE personal_state SET revision=?,epoch=?')
    .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const before = f.dump();
  assert.deepEqual(await f.apply(candidate), {
    changed: false,
    revision: Number.MAX_SAFE_INTEGER,
    epoch: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(f.dump(), before);
  candidate.notes[0]!.text = 'different';
  await assert.rejects(f.apply(candidate));
  assert.equal(f.dump(), before);
});

test('private8 retains every removal key; explicit reviewed live counterparts are data-level permitted', async (t) => {
  const f = await fixture(t),
    candidate = sample(),
    tombstones = removed(candidate);
  await f.apply(tombstones);
  const before = f.dump();
  for (const key of ['notes', 'collections', 'memberships', 'manualItems'] as const) {
    const missing = structuredClone(tombstones);
    missing[key] = [];
    if (key === 'collections') missing.memberships = [];
    await assert.rejects(f.apply(missing));
    assert.equal(f.dump(), before);
  }
  assert.deepEqual(await f.apply(candidate), { changed: true, revision: 2, epoch: 2 });
  assert.deepEqual(await f.read(), candidate);
});

test('private8 rejects foreign/unbound owners before personal payload and does not activate old entrypoints', async (t) => {
  const f = await fixture(t),
    statements: string[] = [];
  for (const binding of [null, otherOwnerId]) {
    f.database.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
    if (binding)
      f.database
        .prepare('INSERT INTO app_metadata VALUES (?,?)')
        .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId: binding }));
    await assert.rejects(
      f.writer.transaction((session) =>
        applyReviewedAccountContentPersonal(
          {
            ...session,
            all: async (sql, values) => {
              statements.push(sql);
              return session.all(sql, values);
            },
          },
          sample(),
          f.options,
        ),
      ),
      failure('different_data_owner'),
    );
  }
  assert.equal(
    statements.some((sql) => /recipe_note|personal_collection|manual_shopping_item/.test(sql)),
    false,
  );
  await assert.rejects(
    f.writer.transaction((session) => applyReviewedAccountPersonal(session, empty())),
  );
  await assert.rejects(
    f.writer.transaction((session) =>
      readPortablePersonalRestoreState(session, { contentSchema: true }),
    ),
  );
  f.database.exec('PRAGMA user_version=7');
  await assert.rejects(f.apply(empty()), failure('stored_data_invalid'));
});

test('private8 owns candidate, owner/guard references and inventory before SQL awaits; future IDs remain unknown', async (t) => {
  const f = await fixture(t),
    candidate = sample(),
    expected = structuredClone(candidate);
  await f.writer.transaction((session) =>
    applyReviewedAccountContentPersonal(
      {
        ...session,
        all: async (sql, values) => {
          candidate.notes[0]!.text = 'unreviewed';
          f.options.ownerId = otherOwnerId;
          f.options.assertAccess = () => {
            throw new Error('mutated option');
          };
          f.options.view = {
            head: null,
            latestHead: null,
            entries: [],
            adoptedRecipeIds: [],
            assertActive: () => undefined,
          };
          f.inventory.length = 0;
          return session.all(sql, values);
        },
      },
      candidate,
      f.options,
    ),
  );
  assert.deepEqual(await f.read(), expected);
  const next = await fixture(t),
    bad = sample();
  bad.notes[0]!.recipeId = futureId;
  // A neutral row alone does not authenticate adoption, including a requested tombstone.
  next.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(futureId);
  const before = next.dump();
  for (const deleted of [false, true]) {
    bad.notes[0]!.deleted = deleted;
    bad.notes[0]!.text = deleted ? null : 'future';
    await assert.rejects(next.apply(bad), failure('invalid_input'));
    assert.equal(next.dump(), before);
  }
});

test('private8 rejects hostile descriptors and oversized encoded candidate before any SQL call', async (t) => {
  const f = await fixture(t);
  let sqlCalls = 0,
    getterCalls = 0;
  const hostile = {
    ...empty(),
    get notes() {
      getterCalls++;
      return [];
    },
  };
  const oversized = empty();
  oversized.manualItems = Array.from({ length: 2500 }, () => ({
    ...sample().manualItems[0]!,
    name: '🧑'.repeat(160),
    amountText: '🧑'.repeat(80),
    unitText: '🧑'.repeat(80),
  }));
  for (const input of [hostile, oversized])
    await assert.rejects(
      f.writer.transaction((session) =>
        applyReviewedAccountContentPersonal(
          {
            ...session,
            all: async (sql, values) => {
              sqlCalls++;
              return session.all(sql, values);
            },
          },
          input,
          f.options,
        ),
      ),
    );
  assert.equal(sqlCalls, 0);
  assert.equal(getterCalls, 0);
});

test('private8 preflights stored ID/text bytes before selecting personal payload', async (t) => {
  const f = await fixture(t),
    candidate = sample();
  await f.apply(candidate);
  f.database.exec('PRAGMA ignore_check_constraints=ON');
  const originalAll = f.connection.all,
    payloads: string[] = [];
  f.connection.all = async (sql, values) => {
    if (/SELECT note_id AS|SELECT item_id AS/.test(sql)) payloads.push(sql);
    return originalAll(sql, values);
  };
  for (const [column, value] of [
    ['text', '"' + 'x'.repeat(100_000) + '"'],
    ['note_id', candidate.notes[0]!.noteId + '\u0000' + 'x'.repeat(100_000)],
  ] as const) {
    f.database
      .prepare(`UPDATE recipe_note SET ${column}=? WHERE recipe_id=?`)
      .run(value, authoredId);
    await assert.rejects(f.apply(candidate));
    assert.equal(payloads.length, 0);
    f.database
      .prepare(`UPDATE recipe_note SET ${column}=? WHERE recipe_id=?`)
      .run(
        column === 'text' ? JSON.stringify(candidate.notes[0]!.text) : candidate.notes[0]!.noteId,
        authoredId,
      );
  }
});

test('private8 aggregate personal byte bound rejects before payload and foreign-key-disabled orphan is not repaired', async (t) => {
  const f = await fixture(t),
    candidate = sample();
  await f.apply(candidate);
  // Each encoded note respects its scalar bound; their aggregate exceeds the shared8MiB admission.
  f.database.exec('PRAGMA ignore_check_constraints=ON');
  const insert = f.database.prepare('INSERT INTO recipe_note VALUES (?,?,?,?,?,?,?)');
  const encoded = '"' + 'x'.repeat(23_000) + '"';
  for (let n = 0; n < 370; n++) {
    const id = String(800000 + n);
    f.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(id);
    insert.run(randomUUID(), id, encoded, 0, 1, at, later);
  }
  const original = f.connection.all;
  let rawReads = 0;
  f.connection.all = async (sql, values) => {
    if (sql.startsWith('SELECT note_id AS')) rawReads++;
    return original(sql, values);
  };
  await assert.rejects(f.apply(candidate));
  assert.equal(rawReads, 0);
  const clean = await fixture(t);
  await clean.apply(sample());
  clean.database.exec('PRAGMA foreign_keys=OFF');
  clean.database.prepare('DELETE FROM recipe_identity WHERE recipe_id=?').run(authoredId);
  clean.database.exec('PRAGMA foreign_keys=ON');
  await assert.rejects(clean.apply(sample()), failure('stored_data_invalid'));
  assert.equal(
    clean.database
      .prepare('SELECT COUNT(*) count FROM recipe_identity WHERE recipe_id=?')
      .get(authoredId)!.count,
    0,
  );
});

test('private8 reservation/owner expiry across awaits rolls back neutral and personal writes and finalizes statements', async (t) => {
  for (const revoke of ['view', 'owner'] as const) {
    const f = await fixture(t),
      before = f.dump(),
      original = f.connection.prepare;
    f.connection.prepare = async (sql) => {
      const statement = await original(sql);
      if (sql.startsWith('INSERT INTO recipe_note'))
        return {
          ...statement,
          run: async (values) => {
            await statement.run(values);
            if (revoke === 'view') f.expire();
            else f.revoke();
          },
        };
      return statement;
    };
    await assert.rejects(f.apply(sample()), /expired/);
    assert.equal(f.dump(), before);
    assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
  }
});

test('private8 midwrite and final commit failure preserve every row and receipt', async (t) => {
  const f = await fixture(t),
    candidate = sample();
  await f.apply(candidate);
  const before = f.dump();
  candidate.notes[0]!.text = 'replacement';
  const prepare = f.connection.prepare;
  f.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return sql.startsWith('INSERT INTO manual_shopping_item')
      ? {
          ...statement,
          run: async () => {
            throw new Error('injected insertion');
          },
        }
      : statement;
  };
  await assert.rejects(f.apply(candidate), /injected insertion/);
  assert.equal(f.dump(), before);
  f.connection.prepare = prepare;
  await assert.rejects(
    f.writer.transaction(
      (session) => applyReviewedAccountContentPersonal(session, candidate, f.options),
      { kind: 'none' },
      () => {
        throw new Error('final owner guard');
      },
    ),
    /final owner guard/,
  );
  assert.equal(f.dump(), before);
  assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
});

test('private8 rejects false lifetime/access assertions instead of treating them as successful proof', async (t) => {
  const f = await fixture(t);
  for (const port of ['view', 'access'] as const) {
    const options = { ...f.options };
    // Deliberately malformed host boundary; production accepts only an undefined success value.
    const falseProof = (() => false) as unknown as () => undefined;
    if (port === 'view')
      options.view = {
        head: null,
        latestHead: null,
        entries: [],
        adoptedRecipeIds: f.inventory,
        assertActive: falseProof,
      };
    else options.assertAccess = falseProof;
    await assert.rejects(
      f.writer.transaction((session) =>
        applyReviewedAccountContentPersonal(session, empty(), options),
      ),
      failure('account_changed'),
    );
  }
});
