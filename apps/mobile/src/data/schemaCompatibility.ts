import { SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6 } from './schema';
import { StorageFault } from './sql';
import type { SqlSession } from './sql';

const normalizeDdl = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const expectedObjects = (schema: string) =>
  schema
    .split(';')
    .map(normalizeDdl)
    .filter(Boolean)
    .map((sql) => {
      const match = /^CREATE (TABLE|INDEX) ([a-z_]+)/.exec(sql);
      if (!match) throw new Error('Unrecognized bundled schema statement');
      return { type: match[1]!.toLowerCase(), name: match[2]!, sql };
    });
const layouts = {
  2: expectedObjects(SCHEMA_V2),
  3: expectedObjects(SCHEMA_V3),
  4: expectedObjects(SCHEMA_V4),
  5: expectedObjects(SCHEMA_V5),
  6: expectedObjects(SCHEMA_V6),
};

/** Validate a complete known layout. Version selection never authorizes migration. */
export async function verifySchemaCompatibility(
  session: SqlSession,
  version?: 2 | 3 | 4 | 5 | 6,
): Promise<void> {
  const selected =
    version ??
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version;
  if (selected !== 2 && selected !== 3 && selected !== 4 && selected !== 5 && selected !== 6)
    throw new StorageFault('incompatible_version', 'Unsupported schema layout');
  const expectedLayout = layouts[selected];
  const actual = await session.all<{ type: string; name: string; sql: string }>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  if (actual.length !== expectedLayout.length)
    throw new StorageFault('incompatible_version', 'Stored schema layout is incompatible');
  for (const expected of expectedLayout) {
    const object = actual.find((item) => item.name === expected.name);
    if (!object || object.type !== expected.type || normalizeDdl(object.sql) !== expected.sql)
      throw new StorageFault('incompatible_version', 'Stored schema layout is incompatible');
  }
}
