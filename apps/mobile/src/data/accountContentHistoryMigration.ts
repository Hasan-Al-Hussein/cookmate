import { ACCOUNT_SNAPSHOT_MAX_BYTES } from '@cookmate/account-sync';
import { COOKING_NOTE_MAX_CHARACTERS, portablePersonalLimits } from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import { assertLegacyAccountSettledForContentMigration } from './contentMigrationAdmission';
import { readHistoryContentPins } from './cookingContentRepository';
import { CONTENT_PIN_REASONS, SCHEMA_V7 } from './cookingContentSchema';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES } from './schema';
import { StorageFault, type SerializedWriter, type SqlSession } from './sql';

export const ACCOUNT_CONTENT_HISTORY_SCHEMA_VERSION = 8;
type Hash = (text: string) => Promise<string>;
const parent = 'account_cooking_history',
  child = 'account_history_content_pin';
const historyEnvelopeBytes = new TextEncoder().encode('{"entries":[],"removedEventIds":[]}').length;
const maximumPinBytes =
  36 + 36 + 20 + 120 + 64 + Math.max(...CONTENT_PIN_REASONS.map((reason) => reason.length));
function originalTable(name: string): string {
  const sql = SCHEMA_V7.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\n\\);`))?.[0];
  if (!sql) throw new Error('Missing bundled account history table');
  return sql;
}
const originalParent = originalTable(parent),
  originalChild = originalTable(child);
const legacyCondition = originalParent.match(/CHECK \(COALESCE\(\n([\s\S]*?)\n  ,0\)\)/)?.[1];
if (!legacyCondition) throw new Error('Missing bundled account history validation');
const json = (path: string) => `json_extract(entry_json,'$.${path}')`;
const kind = (path: string, type: string) => `json_type(entry_json,'$.${path}')='${type}'`;
// Match the existing SQLite character-count handling, including escaped NUL and backslashes.
const characters = (path: string) =>
  `length(json_extract(replace(replace(json_quote(${json(path)}),'\\\\','\\u005c'),'\\u0000',' '),'$'))`;
const boundedText = (path: string, maximum: number) =>
  `${kind(path, 'text')} AND ${characters(path)} BETWEEN 1 AND ${maximum}`;
const ascii = (expression: string, maximum: number) =>
  `typeof(${expression})='text' AND instr(${expression},char(0))=0 AND length(CAST(${expression} AS BLOB)) BETWEEN 1 AND ${maximum}`;
const fingerprint = (expression: string) =>
  `typeof(${expression})='text' AND instr(${expression},char(0))=0 AND length(CAST(${expression} AS BLOB))=64 AND ${expression} NOT GLOB '*[^0-9a-f]*'`;
const recipeId = (expression: string) =>
  `${ascii(expression, 20)} AND ${expression} NOT GLOB '*[^0-9]*'`;
const revisionId = (expression: string) =>
  `${ascii(expression, 120)} AND substr(${expression},1,1) GLOB '[A-Za-z0-9]' AND ${expression} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const uuid = (expression: string) =>
  `typeof(${expression})='text' AND length(CAST(${expression} AS BLOB))=36 AND instr(${expression},char(0))=0 AND substr(${expression},9,1)='-' AND substr(${expression},14,1)='-' AND substr(${expression},19,1)='-' AND substr(${expression},24,1)='-' AND substr(${expression},15,1)='4' AND substr(${expression},20,1) IN ('8','9','a','b') AND length(replace(${expression},'-',''))=32 AND replace(${expression},'-','') NOT GLOB '*[^0-9a-f]*'`;
const exactCondition = `
    json_type(entry_json)='object' AND
    json_remove(entry_json,'$.eventId','$.recipeId','$.contentRef','$.readerVersion','$.recipeTitle','$.photoAssetId','$.cookedOn','$.timeZone','$.recordedAt','$.note')='{}' AND
    ${kind('eventId', 'text')} AND ${json('eventId')}=event_id AND
    ${kind('recipeId', 'text')} AND ${recipeId(json('recipeId'))} AND
    ${kind('readerVersion', 'integer')} AND ${json('readerVersion')}=2 AND
    ${kind('contentRef', 'object')} AND json_remove(${json('contentRef')},'$.recipeId','$.revisionId','$.contentFingerprint')='{}' AND
    ${kind('contentRef.recipeId', 'text')} AND ${json('contentRef.recipeId')}=${json('recipeId')} AND
    ${kind('contentRef.revisionId', 'text')} AND ${revisionId(json('contentRef.revisionId'))} AND
    ${kind('contentRef.contentFingerprint', 'text')} AND ${fingerprint(json('contentRef.contentFingerprint'))} AND
    ${boundedText('recipeTitle', 1000)} AND
    (json_type(entry_json,'$.photoAssetId')='null' OR (${kind('photoAssetId', 'text')} AND length(CAST(${json('photoAssetId')} AS BLOB))=71 AND substr(${json('photoAssetId')},1,7)='sha256:' AND ${fingerprint(`substr(${json('photoAssetId')},8)`)})) AND
    ${kind('cookedOn', 'text')} AND length(CAST(${json('cookedOn')} AS BLOB))=10 AND ${json('cookedOn')} BETWEEN '0001-01-01' AND '9999-12-31' AND date(${json('cookedOn')},'+0 days') IS ${json('cookedOn')} AND
    ${boundedText('timeZone', 100)} AND
    ${kind('recordedAt', 'text')} AND length(CAST(${json('recordedAt')} AS BLOB))=24 AND substr(${json('recordedAt')},1,10) BETWEEN '0001-01-01' AND '9999-12-31' AND date(substr(${json('recordedAt')},1,10),'+0 days') IS substr(${json('recordedAt')},1,10) AND substr(${json('recordedAt')},12,2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ',${json('recordedAt')}) IS ${json('recordedAt')} AND
    (json_type(entry_json,'$.note')='null' OR (${kind('note', 'text')} AND ${characters('note')}<=${COOKING_NOTE_MAX_CHARACTERS}))`;

// The v1 branch is retained literally; only a separate flat, data-only v2 branch is added.
const accountContentHistoryDdl = originalParent.replace(
  '\n  ,0))',
  () => `\n  ,0) OR COALESCE(${exactCondition}\n  ,0))`,
);
if (accountContentHistoryDdl === originalParent)
  throw new Error('Account history DDL was not extended');
export const SCHEMA_V8 = SCHEMA_V7.replace(originalParent, () => accountContentHistoryDdl);
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ');
function objects(schema: string) {
  return schema
    .split(';')
    .map((sql) => sql.trim())
    .filter(Boolean)
    .map((sql) => {
      const match = /^CREATE (TABLE|INDEX) ([a-z_]+)/.exec(sql);
      if (!match) throw new Error('Invalid account content schema');
      return { type: match[1]!.toLowerCase(), name: match[2]!, sql, normalized: normalized(sql) };
    });
}
const layouts = { 7: objects(SCHEMA_V7), 8: objects(SCHEMA_V8) };
function stored(condition: unknown): asserts condition {
  if (!condition)
    throw new StorageFault('storage_failure', 'Account content history storage is invalid');
}
async function verifyLayout(session: SqlSession, version: 7 | 8) {
  const expected = layouts[version];
  const maximumSqlBytes =
    Math.max(...expected.map((row) => new TextEncoder().encode(row.sql).length)) + 1024;
  const [count] = await session.all<{ count: number }>(
    "SELECT COUNT(*) count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  if (count?.count !== expected.length)
    throw new StorageFault(
      'incompatible_version',
      'Account content history schema is incompatible',
    );
  const rows = await session.all<{ type: string | null; name: string | null; sql: string | null }>(
    `SELECT CASE WHEN typeof(type)='text' AND length(CAST(type AS BLOB))<=16 THEN type END type,
      CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=128 THEN name END name,
      CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=? THEN sql END sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
    [maximumSqlBytes],
  );
  if (
    expected.some(
      (item) =>
        !rows.some(
          (row) =>
            row.type === item.type &&
            row.name === item.name &&
            typeof row.sql === 'string' &&
            normalized(row.sql) === item.normalized,
        ),
    )
  )
    throw new StorageFault(
      'incompatible_version',
      'Account content history schema is incompatible',
    );
}

/** Bounded SQL metadata validation. This grants neither release trust nor action-receipt authority. */
async function verifyRows(session: SqlSession) {
  const binding = await readBinding(session);
  for (const table of [parent, child, 'account_cooking_history_removed']) {
    stored(
      (
        await session.all(
          `SELECT 1 FROM ${table} ${binding === null ? '' : 'WHERE owner_id IS NOT ?'} LIMIT 1`,
          binding === null ? [] : [binding],
        )
      ).length === 0,
    );
  }
  const [entries] = await session.all<{ count: number; bytes: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(entry_json AS BLOB))),0) bytes,
      COALESCE(MAX(CASE WHEN typeof(entry_json)='text' AND length(CAST(entry_json AS BLOB))<=${ACCOUNT_HISTORY_ENTRY_MAX_BYTES} AND ${uuid('owner_id')} AND ${uuid('event_id')} THEN 0 ELSE 1 END),0) invalid FROM ${parent}`,
  );
  const [removals] = await session.all<{ count: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(MAX(CASE WHEN ${uuid('owner_id')} AND ${uuid('event_id')} THEN 0 ELSE 1 END),0) invalid FROM account_cooking_history_removed`,
  );
  stored(
    entries &&
      removals &&
      [entries.count, entries.bytes, removals.count].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ),
  );
  stored(
    entries.invalid === 0 &&
      removals.invalid === 0 &&
      entries.count <= portablePersonalLimits.history &&
      removals.count <= portablePersonalLimits.history,
  );
  stored(
    entries.bytes +
      Math.max(0, entries.count - 1) +
      removals.count * 38 +
      Math.max(0, removals.count - 1) +
      historyEnvelopeBytes <=
      ACCOUNT_SNAPSHOT_MAX_BYTES,
  );
  const [pins] = await session.all<{ count: number; bytes: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(owner_id AS BLOB))+length(CAST(event_id AS BLOB))+length(CAST(recipe_id AS BLOB))+COALESCE(length(CAST(revision_id AS BLOB)),0)+COALESCE(length(CAST(content_fingerprint AS BLOB)),0)+COALESCE(length(CAST(unresolved_reason AS BLOB)),0)),0) bytes,
      COALESCE(MAX(CASE WHEN ${uuid('owner_id')} AND ${uuid('event_id')} AND ${recipeId('recipe_id')} AND
      ((unresolved_reason IS NULL AND ${revisionId('revision_id')} AND ${fingerprint('content_fingerprint')}) OR
      (unresolved_reason IN ('catalogue_mismatch','content_mismatch','recipe_unavailable') AND revision_id IS NULL AND content_fingerprint IS NULL)) THEN 0 ELSE 1 END),0) invalid FROM ${child}`,
  );
  stored(
    pins &&
      pins.count === entries.count &&
      pins.invalid === 0 &&
      Number.isSafeInteger(pins.bytes) &&
      pins.bytes >= 0 &&
      pins.bytes <= portablePersonalLimits.history * maximumPinBytes,
  );
  stored(
    (await session.all(`SELECT 1 FROM ${parent} WHERE NOT json_valid(entry_json) LIMIT 1`))
      .length === 0,
  );
  stored(
    (
      await session.all(
        `SELECT 1 FROM ${parent} WHERE NOT (COALESCE(${legacyCondition},0) OR COALESCE(${exactCondition},0)) LIMIT 1`,
      )
    ).length === 0,
  );
  stored(
    (
      await session.all(`SELECT 1 FROM ${parent} h LEFT JOIN ${child} p ON p.owner_id=h.owner_id AND p.event_id=h.event_id WHERE p.event_id IS NULL OR p.recipe_id IS NOT json_extract(h.entry_json,'$.recipeId') OR
    (json_extract(h.entry_json,'$.readerVersion')=2 AND (p.unresolved_reason IS NOT NULL OR p.revision_id IS NOT json_extract(h.entry_json,'$.contentRef.revisionId') OR p.content_fingerprint IS NOT json_extract(h.entry_json,'$.contentRef.contentFingerprint'))) LIMIT 1`)
    ).length === 0,
  );
  stored(
    (
      await session.all(
        `SELECT 1 FROM ${child} p LEFT JOIN ${parent} h ON p.owner_id=h.owner_id AND p.event_id=h.event_id WHERE h.event_id IS NULL LIMIT 1`,
      )
    ).length === 0,
  );
  stored(
    (
      await session.all(
        `SELECT 1 FROM ${parent} h JOIN account_cooking_history_removed r ON r.owner_id=h.owner_id AND r.event_id=h.event_id LIMIT 1`,
      )
    ).length === 0,
  );
  stored((await session.all('SELECT 1 FROM pragma_foreign_key_check LIMIT 1')).length === 0);
  return binding;
}

/** Physical schema8 verifier only: bounded rows/pins/FKs, not recipe-body or publication verification. */
export async function verifyAccountContentHistorySchema(session: SqlSession): Promise<void> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== ACCOUNT_CONTENT_HISTORY_SCHEMA_VERSION)
    throw new StorageFault('incompatible_version', 'Account content history requires schema eight');
  await verifyLayout(session, 8);
  await verifyRows(session);
}

async function equalCopiedRows(
  session: SqlSession,
  table: string,
  copy: string,
  columns: string[],
) {
  const projection = columns.map((column) => `CAST(${column} AS BLOB)`).join(',');
  for (const [left, right] of [
    [table, copy],
    [copy, table],
  ])
    stored(
      (
        await session.all(
          `SELECT 1 FROM (SELECT ${projection} FROM ${left} EXCEPT SELECT ${projection} FROM ${right}) LIMIT 1`,
        )
      ).length === 0,
    );
}

/** Explicit inactive7→8 only. The caller must select this migration; no initializer enables it. */
export async function migrateAccountContentHistoryDatabase(
  writer: SerializedWriter,
  options: { sha256: Hash },
): Promise<'migrated' | 'existing'> {
  return writer.transaction(
    async (session) => {
      const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
        ?.user_version;
      if (version === 8) {
        await verifyAccountContentHistorySchema(session);
        return 'existing';
      }
      if (version !== 7)
        throw new StorageFault(
          'incompatible_version',
          'Account content history migration requires schema seven',
        );
      await verifyLayout(session, 7);
      await assertLegacyAccountSettledForContentMigration(session, options.sha256);
      const ownerId = await verifyRows(session);
      if (ownerId !== null) {
        // Existing schema7 evidence can still prove legacy bindings before its reader is retired.
        let after: string | undefined;
        do {
          const page = await readHistoryContentPins(session, {
            source: 'account',
            ownerId,
            sha256: options.sha256,
            ...(after ? { after } : {}),
          });
          after = page.nextAfter ?? undefined;
        } while (after);
      }
      const parentCopy = 'account_content_history_copy',
        childCopy = 'account_content_pin_copy';
      await session.exec(
        `CREATE TEMP TABLE ${parentCopy} AS SELECT owner_id,event_id,entry_json FROM ${parent}`,
      );
      await session.exec(
        `CREATE TEMP TABLE ${childCopy} AS SELECT owner_id,event_id,recipe_id,revision_id,content_fingerprint,unresolved_reason FROM ${child}`,
      );
      await equalCopiedRows(session, parent, parentCopy, ['owner_id', 'event_id', 'entry_json']);
      await equalCopiedRows(session, child, childCopy, [
        'owner_id',
        'event_id',
        'recipe_id',
        'revision_id',
        'content_fingerprint',
        'unresolved_reason',
      ]);
      await session.exec(`DROP TABLE ${child}`);
      await session.exec(`DROP TABLE ${parent}`);
      await session.exec(accountContentHistoryDdl);
      await session.exec(`INSERT INTO ${parent} SELECT * FROM ${parentCopy}`);
      await session.exec(originalChild);
      await session.exec(`INSERT INTO ${child} SELECT * FROM ${childCopy}`);
      await equalCopiedRows(session, parent, parentCopy, ['owner_id', 'event_id', 'entry_json']);
      await equalCopiedRows(session, child, childCopy, [
        'owner_id',
        'event_id',
        'recipe_id',
        'revision_id',
        'content_fingerprint',
        'unresolved_reason',
      ]);
      await session.exec(`DROP TABLE ${childCopy}`);
      await session.exec(`DROP TABLE ${parentCopy}`);
      await session.exec('PRAGMA user_version=8');
      await verifyAccountContentHistorySchema(session);
      return 'migrated';
    },
    { kind: 'none' },
  );
}
