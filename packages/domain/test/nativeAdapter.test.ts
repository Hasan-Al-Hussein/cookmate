import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createNativeSqlConnection } from '../../../apps/mobile/src/data/nativeAdapter';
import {
  configureConnection,
  SerializedReader,
  SqlCleanupFault,
} from '../../../apps/mobile/src/data/sql';

function nativeShapeFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = OFF');
  let failedCleanupSql: string | null = null;
  let prepared = 0;
  let finalized = 0;
  const connection = createNativeSqlConnection({
    execAsync: async (sql) => {
      database.exec(sql);
    },
    prepareAsync: async (sql) => {
      const statement = database.prepare(sql);
      prepared++;
      return {
        executeAsync: async <Row>(values: (string | number | null)[]) => {
          const rows = statement.all(...values) as Row[];
          return { getAllAsync: async () => rows };
        },
        finalizeAsync: async () => {
          finalized++;
          if (sql === failedCleanupSql) throw new Error('native-shaped finalizer fault');
        },
      };
    },
    closeAsync: async () => {
      database.close();
    },
  });
  return {
    connection,
    failCleanup: (sql: string | null) => {
      failedCleanupSql = sql;
    },
    counts: () => ({ prepared, finalized }),
  };
}

for (const sql of ['SELECT 1 AS value', 'PRAGMA foreign_keys']) {
  test(`native-shaped read cleanup failure invalidates the queue at ${sql}`, async () => {
    const fixture = nativeShapeFixture();
    await configureConnection(fixture.connection);
    const reader = new SerializedReader(fixture.connection);
    let entered = 0;
    try {
      fixture.failCleanup(sql);
      await assert.rejects(
        reader.transaction(async (session) => {
          entered++;
          await session.all('SELECT 1 AS value');
        }),
        SqlCleanupFault,
      );
      if (sql === 'PRAGMA foreign_keys') assert.equal(entered, 0);
      fixture.failCleanup(null);
      await assert.rejects(
        reader.transaction(async () => {
          entered++;
        }),
        /requires recovery/,
      );
      assert.equal(entered, sql === 'PRAGMA foreign_keys' ? 0 : 1);
      assert.equal(fixture.counts().prepared, fixture.counts().finalized);
    } finally {
      await reader.close();
    }
  });
}

test('ordinary native-shaped SQL read errors with successful cleanup permit later queued reads', async () => {
  const fixture = nativeShapeFixture();
  await configureConnection(fixture.connection);
  const reader = new SerializedReader(fixture.connection);
  try {
    await assert.rejects(
      reader.transaction((session) => session.all('SELECT missing FROM nonexistent')),
      /no such table/,
    );
    const rows = await reader.transaction((session) =>
      session.all<{ value: number }>('SELECT 1 AS value'),
    );
    assert.equal(rows[0]?.value, 1);
    assert.equal(fixture.counts().prepared, fixture.counts().finalized);
  } finally {
    await reader.close();
  }
});
