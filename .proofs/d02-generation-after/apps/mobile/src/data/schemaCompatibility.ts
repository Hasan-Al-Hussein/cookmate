import { SCHEMA_V2 } from './schema';
import { StorageFault } from './sql';
import type { SqlSession } from './sql';

const normalizeDdl = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const expectedObjects = SCHEMA_V2.split(';')
  .map(normalizeDdl)
  .filter(Boolean)
  .map((sql) => {
    const match = /^CREATE (TABLE|INDEX) ([a-z_]+)/.exec(sql);
    if (!match) throw new Error('Unrecognized bundled schema statement');
    return { type: match[1]!.toLowerCase(), name: match[2]!, sql };
  });

/** Pre-release databases must match the complete genesis layout; they are never reset here. */
export async function verifySchemaCompatibility(session: SqlSession): Promise<void> {
  const actual = await session.all<{ type: string; name: string; sql: string }>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  if (actual.length !== expectedObjects.length)
    throw new StorageFault('incompatible_version', 'Stored schema layout is incompatible');
  for (const expected of expectedObjects) {
    const object = actual.find((item) => item.name === expected.name);
    if (!object || object.type !== expected.type || normalizeDdl(object.sql) !== expected.sql)
      throw new StorageFault('incompatible_version', 'Stored schema layout is incompatible');
  }
}
