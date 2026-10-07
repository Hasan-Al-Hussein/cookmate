import assert from 'node:assert/strict';
import { realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlConnection, SqlValue } from '../../../../apps/mobile/src/data/sql';

export async function removeFixtureDirectory(directory: string): Promise<void> {
  const actual = await realpath(directory);
  assert.equal(dirname(actual), await realpath(tmpdir()));
  assert.match(basename(actual), /^cookmate-(sqlite|repository|commands)-/);
  await rm(actual, { recursive: true, force: true });
}

export function desktopConnection(path = ':memory:', failIngredientInsert = false) {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = OFF');
  let prepared = 0;
  let finalized = 0;
  const connection: SqlConnection = {
    exec: async (sql) => {
      database.exec(sql);
    },
    all: async <Row extends object>(sql: string, values: readonly SqlValue[] = []) =>
      database.prepare(sql).all(...values) as Row[],
    prepare: async (sql) => {
      const statement = database.prepare(sql);
      prepared++;
      let done = false;
      return {
        run: async (values) => {
          if (done) throw new Error('statement finalized');
          if (failIngredientInsert && sql.startsWith('INSERT INTO ingredient_entry'))
            throw new Error('injected seed fault');
          statement.run(...values);
        },
        finalize: async () => {
          if (!done) finalized++;
          done = true;
        },
      };
    },
    close: async () => database.close(),
  };
  return { database, connection, statementCounts: () => ({ prepared, finalized }) };
}
