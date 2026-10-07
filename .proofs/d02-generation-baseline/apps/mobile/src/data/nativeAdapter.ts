import { SqlCleanupFault } from './sql';
import type { SqlConnection, SqlValue } from './sql';

export interface NativeStatement {
  executeAsync<Row>(values: SqlValue[]): Promise<{ getAllAsync(): Promise<Row[]> }>;
  finalizeAsync(): Promise<void>;
}

export interface NativeDatabase {
  execAsync(sql: string): Promise<void>;
  prepareAsync(sql: string): Promise<NativeStatement>;
  closeAsync(): Promise<void>;
}

async function finalize(statement: NativeStatement): Promise<void> {
  try {
    await statement.finalizeAsync();
  } catch {
    throw new SqlCleanupFault();
  }
}

/** Explicit read preparation makes the native cleanup failure observable to the owning queue. */
export function createNativeSqlConnection(database: NativeDatabase): SqlConnection {
  return {
    exec: (sql) => database.execAsync(sql),
    all: async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
      const statement = await database.prepareAsync(sql);
      try {
        const result = await statement.executeAsync<Row>([...values]);
        return await result.getAllAsync();
      } finally {
        await finalize(statement);
      }
    },
    prepare: async (sql) => {
      const statement = await database.prepareAsync(sql);
      return {
        run: async (values) => {
          await statement.executeAsync([...values]);
        },
        finalize: () => finalize(statement),
      };
    },
    close: () => database.closeAsync(),
  };
}
