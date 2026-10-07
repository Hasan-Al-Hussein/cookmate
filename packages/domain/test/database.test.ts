import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  runBound,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { createCatalogueRepository } from '../../../apps/mobile/src/data/catalogueRepository';
import { createStateRepositories } from '../../../apps/mobile/src/data/stateRepositories';
import type { SqlSession, SqlStatement } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const seed = {
  identity: catalogue.identity,
  recipes: catalogue.recipes,
  recipeSources: catalogueProvenance.recipeSources,
};
const identifiers = () => ({
  installationId: randomUUID(),
  shoppingScopeId: randomUUID(),
  conversationId: randomUUID(),
});

test('desktop SQLite seeds faithful records, FK constraints and schema atomically', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    assert.equal(await initializeDatabase(writer, seed, identifiers()), 'created');
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM recipe').get()?.count,
      100,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM ingredient_entry').get()?.count,
      960,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM instruction_passage').get()?.count,
      706,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM ingredient_entry WHERE raw_measure IS NULL')
        .get()?.count,
      6,
    );
    assert.equal(fixture.database.prepare('PRAGMA user_version').get()?.user_version, 2);
    await assert.rejects(
      writer.transaction((tx) =>
        runBound(tx, 'INSERT INTO favourite VALUES (?, 1, 1, ?, ?)', [
          '99999',
          '2026-09-28T00:00:00.000Z',
          '2026-09-28T00:00:00.000Z',
        ]),
      ),
      /FOREIGN KEY/,
    );
    assert.deepEqual(fixture.statementCounts().prepared, fixture.statementCounts().finalized);
  } finally {
    await writer.close();
  }
});

test('FK must be enabled on actual writer before BEGIN; queue recovers from rejected command', async () => {
  const fixture = desktopConnection();
  const writer = new SerializedWriter(fixture.connection);
  try {
    await assert.rejects(
      initializeDatabase(writer, seed, identifiers()),
      /foreign keys are disabled/,
    );
    await configureConnection(fixture.connection);
    assert.equal(await initializeDatabase(writer, seed, identifiers()), 'created');
    const rows = await writer.transaction((tx) =>
      tx.all<{ foreign_keys: number }>('PRAGMA foreign_keys'),
    );
    assert.equal(rows[0]?.foreign_keys, 1);
  } finally {
    await writer.close();
  }
});

test('interrupted seed rolls back schema and marker, preserving a genuinely fresh database', async () => {
  const fixture = desktopConnection(':memory:', true);
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    await assert.rejects(initializeDatabase(writer, seed, identifiers()), /injected seed fault/);
    assert.equal(fixture.database.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'")
        .get()?.count,
      0,
    );
    assert.deepEqual(fixture.statementCounts().prepared, fixture.statementCounts().finalized);
  } finally {
    await writer.close();
  }
});

test('reopen preserves existing state and rejects catalogue/version mismatch without reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-'));
  const path = join(directory, 'fixture.db');
  const initial = identifiers();
  let fixture = desktopConnection(path);
  await configureConnection(fixture.connection);
  let writer = new SerializedWriter(fixture.connection);
  try {
    await initializeDatabase(writer, seed, initial);
    await writer.transaction((tx) =>
      runBound(tx, 'INSERT INTO favourite VALUES (?, 1, 1, ?, ?)', [
        '53064',
        '2026-09-28T00:00:00.000Z',
        '2026-09-28T00:00:00.000Z',
      ]),
    );
    await writer.close();
    fixture = desktopConnection(path);
    await configureConnection(fixture.connection);
    writer = new SerializedWriter(fixture.connection);
    assert.equal(await initializeDatabase(writer, seed, identifiers()), 'existing');
    assert.equal(
      fixture.database.prepare('SELECT recipe_id FROM favourite').get()?.recipe_id,
      '53064',
    );
    assert.equal(
      fixture.database.prepare("SELECT value FROM app_metadata WHERE key='installation_id'").get()
        ?.value,
      initial.installationId,
    );
    await assert.rejects(
      initializeDatabase(
        writer,
        { ...seed, identity: { ...seed.identity, fingerprint: 'f'.repeat(64) } },
        identifiers(),
      ),
      /catalogues differ/,
    );
    fixture.database.exec('PRAGMA user_version = 999');
    await assert.rejects(
      initializeDatabase(writer, seed, identifiers()),
      /Unsupported database schema/,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
      1,
    );
  } finally {
    await writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('unversioned existing state is not overwritten during initialization', async () => {
  const fixture = desktopConnection();
  fixture.database.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep')");
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    await assert.rejects(
      initializeDatabase(writer, seed, identifiers()),
      /Unversioned database contains/,
    );
    assert.equal(fixture.database.prepare('SELECT value FROM retained').get()?.value, 'keep');
  } finally {
    await writer.close();
  }
});

test('calendar and occupied-slot constraints reject invalid rows while allowing leap day and past dates', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  const insert = (date: string, meal: string = 'dinner') =>
    writer.transaction((tx) =>
      runBound(tx, 'INSERT INTO plan_occurrence VALUES (?, ?, ?, ?, 0, ?, ?)', [
        randomUUID(),
        '53064',
        date,
        meal,
        '2026-09-28T00:00:00.000Z',
        '2026-09-28T00:00:00.000Z',
      ]),
    );
  try {
    await initializeDatabase(writer, seed, identifiers());
    for (const date of [
      '2026-02-30',
      '1900-02-29',
      '2101-01-01',
      '1899-12-31',
      '2026-13-01',
      '2026-00-01',
      '2026-01-00',
    ])
      await assert.rejects(insert(date), /CHECK/);
    await insert('2000-02-29');
    await insert('1900-01-01');
    await assert.rejects(insert('2000-02-29'), /UNIQUE/);
    await assert.rejects(insert('2000-03-01', 'snack'), /CHECK/);
  } finally {
    await writer.close();
  }
});

test('serialized callbacks retain exact handle; escaped handle cannot write after commit', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  let escaped: SqlSession | undefined;
  try {
    await initializeDatabase(writer, seed, identifiers());
    const events: string[] = [];
    await Promise.all([
      writer.transaction(async (tx) => {
        escaped = tx;
        events.push('first');
        await Promise.resolve();
        events.push('first-end');
      }),
      writer.transaction(async () => {
        events.push('second');
      }),
    ]);
    assert.deepEqual(events, ['first', 'first-end', 'second']);
    await assert.rejects(escaped!.exec('DELETE FROM recipe'), /scope has ended/);
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM recipe').get()?.count,
      100,
    );
  } finally {
    await writer.close();
  }
});

test('receipt can outlive conversation clearing and direct UI requires no origin', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    await initializeDatabase(writer, seed, identifiers());
    await writer.transaction(async (tx) => {
      await runBound(tx, 'INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)', [
        randomUUID(),
        randomUUID(),
        'a'.repeat(64),
        'committed',
        '2026-09-28T00:00:00.000Z',
        'unchanged',
        '[]',
      ]);
      await tx.exec('DELETE FROM conversation');
    });
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      1,
    );
  } finally {
    await writer.close();
  }
});

test('catalogue repository hydrates every source record and serializes overlapping read snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const path = join(directory, 'fixture.db');
  const writeFixture = desktopConnection(path);
  await configureConnection(writeFixture.connection);
  const writer = new SerializedWriter(writeFixture.connection);
  let reader: SerializedReader | undefined;
  try {
    await initializeDatabase(writer, seed, identifiers());
    const readFixture = desktopConnection(path);
    await configureConnection(readFixture.connection);
    await readFixture.connection.exec('PRAGMA query_only = ON');
    reader = new SerializedReader(readFixture.connection);
    const repository = createCatalogueRepository(reader);
    const results = await Promise.all(
      catalogue.recipes.map((recipe) => repository.readRecipe(recipe.recipeId)),
    );
    results.forEach((result, index) => {
      assert.equal(result.kind, 'ready');
      if (result.kind === 'ready') assert.deepEqual(result.value, catalogue.recipes[index]);
    });
    const missing = await repository.readRecipe("53064'; DROP TABLE recipe; --");
    assert.deepEqual(missing, { kind: 'ready', value: null, revision: 0 });
    await assert.rejects(
      reader.transaction((tx) => tx.exec('DELETE FROM favourite')),
      /readonly/,
    );
    assert.equal((await repository.readRecipe('53064')).kind, 'ready');
    writeFixture.database.exec("DELETE FROM state_revision WHERE collection='store'");
    assert.equal((await repository.readRecipe('53064')).kind, 'failed');
  } finally {
    await reader?.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('a failed rollback invalidates the connection instead of permitting another transaction', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const originalExec = fixture.connection.exec;
  fixture.connection.exec = async (sql) => {
    if (sql === 'ROLLBACK') throw new Error('rollback failed');
    await originalExec(sql);
  };
  const writer = new SerializedWriter(fixture.connection);
  try {
    await assert.rejects(
      writer.transaction(async () => {
        throw new Error('work failed');
      }),
      /work failed/,
    );
    await assert.rejects(
      writer.transaction(async () => 'must not run'),
      /requires recovery/,
    );
  } finally {
    await writer.close();
  }
});

test('an accidentally unawaited in-scope statement settles before COMMIT and its failure rolls back', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const originalExec = fixture.connection.exec;
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  fixture.connection.exec = async (sql) => {
    if (sql === 'CREATE TABLE delayed(value TEXT)') {
      await delayed;
      events.push('statement');
    }
    if (sql === 'COMMIT') events.push('commit');
    await originalExec(sql);
  };
  const writer = new SerializedWriter(fixture.connection);
  try {
    const transaction = writer.transaction(async (session) => {
      void session.exec('CREATE TABLE delayed(value TEXT)');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, []);
    release!();
    await transaction;
    assert.deepEqual(events, ['statement', 'commit']);
    await assert.rejects(
      writer.transaction(async (session) => {
        void session.exec('INSERT INTO missing_table VALUES (1)');
      }),
      /no such table/,
    );
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM delayed').get()?.count, 0);
  } finally {
    await writer.close();
  }
});

test('state repositories preserve empty states, stable ordering, cross-week selections and receipt data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const path = join(directory, 'fixture.db');
  const fixture = desktopConnection(path);
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  const initial = identifiers();
  let reader: SerializedReader | undefined;
  try {
    await initializeDatabase(writer, seed, initial);
    const readFixture = desktopConnection(path);
    await configureConnection(readFixture.connection);
    await readFixture.connection.exec('PRAGMA query_only = ON');
    reader = new SerializedReader(readFixture.connection);
    const repository = createStateRepositories(reader, catalogueBoundary);
    assert.deepEqual(await repository.readFavourites(), { kind: 'ready', revision: 0, value: [] });
    assert.deepEqual(await repository.readPreferences(), {
      kind: 'ready',
      revision: 0,
      value: { revision: 0, lastRemovalRevision: null, items: [] },
    });
    const outsideId = randomUUID();
    const dinnerId = randomUUID();
    const breakfastId = randomUUID();
    const operationId = randomUUID();
    const intentId = randomUUID();
    const timestamp = '2026-09-28T00:00:00.000Z';
    await writer.transaction(async (tx) => {
      await runBound(tx, 'INSERT INTO favourite VALUES (?, 1, 1, ?, ?)', [
        '53064',
        timestamp,
        timestamp,
      ]);
      await runBound(tx, 'INSERT INTO favourite VALUES (?, 0, 2, ?, ?)', [
        '52835',
        timestamp,
        timestamp,
      ]);
      for (const [id, date, meal] of [
        [dinnerId, '2026-09-28', 'dinner'],
        [outsideId, '2026-10-05', 'lunch'],
        [breakfastId, '2026-09-28', 'breakfast'],
      ]) {
        await runBound(tx, 'INSERT INTO plan_occurrence VALUES (?, ?, ?, ?, 1, ?, ?)', [
          id!,
          '53064',
          date!,
          meal!,
          timestamp,
          timestamp,
        ]);
      }
      await runBound(tx, 'INSERT INTO shopping_selection VALUES (?, ?)', [
        initial.shoppingScopeId,
        outsideId,
      ]);
      await runBound(tx, 'INSERT INTO saved_preference VALUES (?, ?, ?, 1)', [
        randomUUID(),
        'cuisine',
        JSON.stringify("Italian'; DROP TABLE recipe; --"),
      ]);
      await tx.exec("UPDATE state_revision SET revision = 3 WHERE collection = 'store'");
      await tx.exec("UPDATE state_revision SET revision = 1 WHERE collection = 'preferences'");
      await runBound(tx, 'INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)', [
        operationId,
        intentId,
        'a'.repeat(64),
        'committed',
        timestamp,
        'unchanged',
        JSON.stringify([{ kind: 'favourite', entityId: '53064', revision: 1, saved: true }]),
      ]);
    });
    const [favourites, plan, preferences, receipt] = await Promise.all([
      repository.readFavourites(),
      repository.readPlan('2026-09-28', '2026-10-04'),
      repository.readPreferences(),
      repository.readReceipt(operationId),
    ]);
    assert.deepEqual(favourites, {
      kind: 'ready',
      revision: 3,
      value: [{ recipeId: '53064', revision: 1, savedAt: timestamp }],
    });
    assert.equal(plan.kind, 'ready');
    if (plan.kind === 'ready') {
      assert.deepEqual(
        plan.value.occurrences.map((item) => item.occurrenceId),
        [breakfastId, dinnerId],
      );
      assert.deepEqual(plan.value.shoppingScope.occurrenceIds, [outsideId]);
      assert.equal(Object.isFrozen(plan.value.occurrences), true);
    }
    assert.equal(preferences.kind, 'ready');
    if (preferences.kind === 'ready')
      assert.equal(preferences.value.items[0]?.value, "Italian'; DROP TABLE recipe; --");
    assert.deepEqual(receipt, {
      kind: 'ready',
      revision: 3,
      value: {
        schemaVersion: 1,
        operationId,
        userIntentId: intentId,
        payloadFingerprint: 'a'.repeat(64),
        outcome: 'committed',
        committedAt: timestamp,
        shoppingProjection: 'unchanged',
        effects: [{ kind: 'favourite', entityId: '53064', revision: 1, saved: true }],
      },
    });
    assert.deepEqual(await repository.readReceipt("'; DROP TABLE operation_receipt; --"), {
      kind: 'ready',
      value: null,
      revision: 3,
    });
    assert.equal((await repository.readPlan('2026-02-30', '2026-03-01')).kind, 'failed');
    assert.equal((await repository.readPlan('2026-10-04', '2026-09-28')).kind, 'failed');
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM recipe').get()?.count,
      100,
    );
  } finally {
    await reader?.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('a malformed saved collection fails visibly without overwriting it or hiding healthy collections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const path = join(directory, 'fixture.db');
  const fixture = desktopConnection(path);
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  let reader: SerializedReader | undefined;
  try {
    await initializeDatabase(writer, seed, identifiers());
    const readFixture = desktopConnection(path);
    await configureConnection(readFixture.connection);
    await readFixture.connection.exec('PRAGMA query_only = ON');
    reader = new SerializedReader(readFixture.connection);
    const repository = createStateRepositories(reader, catalogueBoundary);
    fixture.database
      .prepare('INSERT INTO saved_preference VALUES (?, ?, ?, 1)')
      .run(randomUUID(), 'cuisine', JSON.stringify('x'.repeat(257)));
    const operationId = randomUUID();
    fixture.database
      .prepare('INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        operationId,
        randomUUID(),
        'a'.repeat(64),
        'committed',
        '2026-09-28T00:00:00.000Z',
        'unchanged',
        '[{"kind":"invented_effect"}]',
      );
    const before = fixture.database.prepare('SELECT total_changes() AS count').get()?.count;
    assert.equal((await repository.readPreferences()).kind, 'failed');
    assert.equal((await repository.readReceipt(operationId)).kind, 'failed');
    assert.deepEqual(await repository.readFavourites(), { kind: 'ready', revision: 0, value: [] });
    assert.equal((await repository.readPlan('2026-09-28', '2026-10-04')).kind, 'ready');
    assert.equal(fixture.database.prepare('SELECT total_changes() AS count').get()?.count, before);
    assert.equal(
      fixture.database.prepare('SELECT value FROM saved_preference').get()?.value,
      JSON.stringify('x'.repeat(257)),
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      1,
    );
  } finally {
    await reader?.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('receipt hydration rejects impossible nested dates and unknown source IDs but preserves valid historical effects', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    await initializeDatabase(writer, seed, identifiers());
    // Sequential same-connection reads suffice here; no writer/read overlap is used by this fixture.
    const repository = createStateRepositories(
      new SerializedReader(fixture.connection),
      catalogueBoundary,
    );
    const insert = fixture.database.prepare(
      'INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const add = (actualDate: string, recipeId = '53064') => {
      const id = randomUUID();
      insert.run(
        id,
        randomUUID(),
        'a'.repeat(64),
        'committed',
        '2026-09-28T00:00:00.000Z',
        'unchanged',
        JSON.stringify([
          {
            kind: 'plan',
            entityId: randomUUID(),
            revision: 1,
            change: 'removed',
            recipeId,
            placement: { actualDate, mealKey: 'dinner' },
          },
        ]),
      );
      return id;
    };
    for (const id of [add('2026-02-30'), add('2101-01-01'), add('2026-09-28', '99999')]) {
      const result = await repository.readReceipt(id);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.error.code, 'storage_failure');
    }
    const historical = await repository.readReceipt(add('2024-02-29'));
    assert.equal(historical.kind, 'ready');
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM plan_occurrence').get()?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      4,
    );
  } finally {
    await writer.close();
  }
});

test('transaction scope finalizes leaked prepared handles exactly once on success and failure', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  let escaped: SqlStatement | undefined;
  try {
    await writer.transaction(async (tx) => {
      await tx.exec('CREATE TABLE lifecycle(value TEXT)');
      escaped = await tx.prepare('INSERT INTO lifecycle VALUES (?)');
      await escaped.run(['kept']);
    });
    assert.deepEqual(fixture.statementCounts(), { prepared: 1, finalized: 1 });
    await assert.rejects(escaped!.run(['too late']), /scope has ended/);
    await escaped!.finalize();
    assert.deepEqual(fixture.statementCounts(), { prepared: 1, finalized: 1 });
    await assert.rejects(
      writer.transaction(async (tx) => {
        const statement = await tx.prepare('INSERT INTO lifecycle VALUES (?)');
        await statement.run(['rolled back']);
        throw new Error('callback failed before cleanup');
      }),
      /callback failed/,
    );
    assert.deepEqual(fixture.statementCounts(), { prepared: 2, finalized: 2 });
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM lifecycle').get()?.count,
      1,
    );
  } finally {
    await writer.close();
  }
});

test('statement cleanup failure rolls back and prevents reuse of a damaged connection', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const prepare = fixture.connection.prepare;
  fixture.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return {
      run: statement.run,
      finalize: async () => {
        await statement.finalize();
        throw new Error('injected finalize failure');
      },
    };
  };
  const writer = new SerializedWriter(fixture.connection);
  try {
    await assert.rejects(
      writer.transaction(async (tx) => {
        await tx.exec('CREATE TABLE not_committed(value TEXT)');
        const statement = await tx.prepare('INSERT INTO not_committed VALUES (?)');
        await statement.run(['not committed']);
      }),
      /injected finalize failure/,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='not_committed'")
        .get()?.count,
      0,
    );
    await assert.rejects(
      writer.transaction(async () => undefined),
      /requires recovery/,
    );
    assert.deepEqual(fixture.statementCounts(), { prepared: 1, finalized: 1 });
  } finally {
    await writer.close();
  }
});
