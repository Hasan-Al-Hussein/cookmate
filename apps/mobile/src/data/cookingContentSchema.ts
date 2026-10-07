import { CONTENT_LIMITS } from '@cookmate/catalogue/content';
import { SCHEMA_V6 } from './schema';
import { StorageFault, type SqlSession } from './sql';

export const COOKING_CONTENT_SCHEMA_VERSION = 7;
export const COOKING_CONTENT_LIMITS = Object.freeze({
  revisions: 10_000,
  revisionBytes: CONTENT_LIMITS.documentBytes + 4096,
  archiveBytes: 64 * 1024 * 1024,
  historyBytes: 64 * 1024 * 1024,
  page: 100,
  historyOperations: 20_000,
});
export const CONTENT_PIN_REASONS = [
  'catalogue_mismatch',
  'content_mismatch',
  'recipe_unavailable',
] as const;
export type ContentPinReason = (typeof CONTENT_PIN_REASONS)[number];
const fingerprint = (column: string) =>
  `typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const pinColumns = `recipe_id TEXT NOT NULL REFERENCES recipe_identity(recipe_id) ON DELETE RESTRICT,
  revision_id TEXT, content_fingerprint TEXT, unresolved_reason TEXT,
  CHECK (COALESCE((unresolved_reason IS NULL AND revision_id IS NOT NULL AND content_fingerprint IS NOT NULL) OR
    (unresolved_reason IN ('catalogue_mismatch','content_mismatch','recipe_unavailable') AND revision_id IS NULL AND content_fingerprint IS NULL),0)),
  FOREIGN KEY(recipe_id,revision_id,content_fingerprint) REFERENCES recipe_content_revision(recipe_id,revision_id,content_fingerprint) ON DELETE RESTRICT`;

export const COOKING_CONTENT_RECORDS_DDL = `
CREATE TABLE recipe_identity (
  recipe_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(recipe_id)='text' AND length(CAST(recipe_id AS BLOB)) BETWEEN 1 AND 20 AND recipe_id NOT GLOB '*[^0-9]*')
);
CREATE TABLE recipe_content_revision (
  recipe_id TEXT NOT NULL REFERENCES recipe_identity(recipe_id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL CHECK (typeof(revision_id)='text' AND length(CAST(revision_id AS BLOB)) BETWEEN 1 AND 120),
  content_fingerprint TEXT NOT NULL CHECK (${fingerprint('content_fingerprint')}),
  kind TEXT NOT NULL CHECK (kind IN ('imported','authored')),
  revision_json TEXT NOT NULL CHECK (typeof(revision_json)='text' AND json_valid(revision_json) AND length(CAST(revision_json AS BLOB))<=${COOKING_CONTENT_LIMITS.revisionBytes}),
  PRIMARY KEY(recipe_id,revision_id,content_fingerprint), UNIQUE(recipe_id,revision_id),
  CHECK (COALESCE(json_extract(revision_json,'$.ref.recipeId')=recipe_id AND json_extract(revision_json,'$.ref.revisionId')=revision_id AND json_extract(revision_json,'$.ref.contentFingerprint')=content_fingerprint AND json_extract(revision_json,'$.document.kind')=kind,0))
);
CREATE TABLE recipe_content_source (
  recipe_id TEXT NOT NULL, revision_id TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ingredient','instruction','annotation')),
  source_key TEXT NOT NULL CHECK (typeof(source_key)='text' AND length(CAST(source_key AS BLOB)) BETWEEN 1 AND 200),
  PRIMARY KEY(recipe_id,revision_id,content_fingerprint,source_kind,source_key),
  FOREIGN KEY(recipe_id,revision_id,content_fingerprint) REFERENCES recipe_content_revision(recipe_id,revision_id,content_fingerprint) ON DELETE RESTRICT
);
`;
export const COOKING_CONTENT_PINS_DDL = `
CREATE TABLE plan_content_pin (
  occurrence_id TEXT PRIMARY KEY NOT NULL,
  recipe_id TEXT NOT NULL, revision_id TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
  UNIQUE(occurrence_id,recipe_id,revision_id,content_fingerprint),
  FOREIGN KEY(occurrence_id,recipe_id) REFERENCES plan_occurrence(occurrence_id,recipe_id) ON DELETE CASCADE,
  FOREIGN KEY(recipe_id,revision_id,content_fingerprint) REFERENCES recipe_content_revision(recipe_id,revision_id,content_fingerprint) ON DELETE RESTRICT
);
CREATE TABLE cooking_session_content_pin (
  session_id TEXT NOT NULL,
  ${pinColumns},
  PRIMARY KEY(recipe_id),
  FOREIGN KEY(recipe_id,session_id) REFERENCES cooking_session(recipe_id,session_id) ON DELETE CASCADE
);
CREATE TABLE local_history_content_pin (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES cooking_event(event_id) ON DELETE CASCADE,
  ${pinColumns}
);
CREATE TABLE imported_history_content_pin (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES imported_cooking_history(event_id) ON DELETE CASCADE,
  ${pinColumns}
);
CREATE TABLE account_history_content_pin (
  owner_id TEXT NOT NULL, event_id TEXT NOT NULL,
  ${pinColumns},
  PRIMARY KEY(owner_id,event_id),
  FOREIGN KEY(owner_id,event_id) REFERENCES account_cooking_history(owner_id,event_id) ON DELETE CASCADE
);
CREATE TABLE app_content_adoption (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  revision INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision>=0),
  head_json TEXT CHECK (head_json IS NULL OR (typeof(head_json)='text' AND json_valid(head_json) AND length(CAST(head_json AS BLOB))<=1024))
);
CREATE TABLE content_adoption_operation (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(operation_id)='text' AND length(CAST(operation_id AS BLOB))=36),
  request_fingerprint TEXT NOT NULL CHECK (${fingerprint('request_fingerprint')}),
  receipt_json TEXT NOT NULL CHECK (typeof(receipt_json)='text' AND json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=16384)
);
CREATE TABLE content_command_authority (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES command_slot(operation_id) ON DELETE CASCADE,
  payload_fingerprint TEXT NOT NULL CHECK (${fingerprint('payload_fingerprint')}),
  authority_json TEXT NOT NULL CHECK (typeof(authority_json)='text' AND json_valid(authority_json) AND length(CAST(authority_json AS BLOB))<=4096)
);
CREATE TABLE content_cooking_session_operation (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(operation_id)='text' AND length(CAST(operation_id AS BLOB))=36),
  request_fingerprint TEXT NOT NULL CHECK (${fingerprint('request_fingerprint')}),
  authority_json TEXT NOT NULL CHECK (typeof(authority_json)='text' AND json_valid(authority_json) AND length(CAST(authority_json AS BLOB))<=4096),
  receipt_json TEXT NOT NULL CHECK (typeof(receipt_json)='text' AND json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=8192)
);
CREATE TABLE content_cooking_event_authority (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES cooking_event(event_id) ON DELETE CASCADE,
  request_fingerprint TEXT NOT NULL CHECK (${fingerprint('request_fingerprint')}),
  authority_json TEXT NOT NULL CHECK (typeof(authority_json)='text' AND json_valid(authority_json) AND length(CAST(authority_json AS BLOB))<=4096)
);
`;

/** Only these application relations change; imported source DDL remains byte-for-byte unchanged. */
export const CONTENT_REBUILT_TABLES = [
  'favourite',
  'plan_occurrence',
  'cooking_session',
  'recipe_note',
  'personal_collection_member',
  'reference_item',
  'shopping_selection',
  'shopping_contribution',
] as const;
export function legacyContentTableDdl(name: (typeof CONTENT_REBUILT_TABLES)[number]): string {
  const value = SCHEMA_V6.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\n\\);`))?.[0];
  if (!value) throw new Error('Missing known cooking table');
  return value;
}
export function contentTableDdl(name: (typeof CONTENT_REBUILT_TABLES)[number]): string {
  let sql = legacyContentTableDdl(name);
  if (name === 'shopping_contribution') {
    sql = sql
      .replace(
        'recipe_id TEXT NOT NULL,',
        'recipe_id TEXT NOT NULL, revision_id TEXT NOT NULL, content_fingerprint TEXT NOT NULL,',
      )
      .replace(
        'FOREIGN KEY (occurrence_id, recipe_id) REFERENCES plan_occurrence(occurrence_id, recipe_id) ON DELETE RESTRICT,',
        'FOREIGN KEY (occurrence_id, recipe_id, revision_id, content_fingerprint) REFERENCES plan_content_pin(occurrence_id, recipe_id, revision_id, content_fingerprint) ON DELETE RESTRICT,',
      )
      .replace(
        'FOREIGN KEY (recipe_id, ingredient_position) REFERENCES ingredient_entry(recipe_id, position) ON DELETE RESTRICT,',
        "CHECK ((source_kind='ingredient' AND source_key=CAST(ingredient_position AS TEXT)) OR (source_kind='annotation' AND source_key=annotation_id)),",
      )
      .replace(
        'FOREIGN KEY (recipe_id, annotation_id) REFERENCES quality_annotation(recipe_id, annotation_id) ON DELETE RESTRICT,',
        'FOREIGN KEY (recipe_id, revision_id, content_fingerprint, source_kind, source_key) REFERENCES recipe_content_source(recipe_id, revision_id, content_fingerprint, source_kind, source_key) ON DELETE RESTRICT,',
      );
  } else {
    sql = sql.replace('REFERENCES recipe(recipe_id)', 'REFERENCES recipe_identity(recipe_id)');
    if (name === 'cooking_session')
      sql = sql.replace('\n);', ',\n  UNIQUE(recipe_id,session_id)\n);');
  }
  return sql;
}
export const CONTENT_REBUILT_INDEXES =
  SCHEMA_V6.split(';')
    .map((sql) => sql.trim())
    .filter((sql) =>
      /^CREATE INDEX (shopping_selection_occurrence|contribution_group|cooking_session_resume|personal_member_recipe) /.test(
        sql,
      ),
    )
    .join(';\n') + ';';
export const SCHEMA_V7 =
  CONTENT_REBUILT_TABLES.reduce(
    (schema, table) => schema.replace(legacyContentTableDdl(table), contentTableDdl(table)),
    SCHEMA_V6,
  ) +
  COOKING_CONTENT_RECORDS_DDL +
  COOKING_CONTENT_PINS_DDL;
const normalized = (sql: string) => sql.trim().replace(/\s+/g, ' ');
export async function verifyCookingContentSchema(session: SqlSession): Promise<void> {
  const expected = SCHEMA_V7.split(';')
    .map(normalized)
    .filter(Boolean)
    .map((sql) => {
      const match = /^CREATE (TABLE|INDEX) ([a-z_]+)/.exec(sql);
      if (!match) throw new Error('Invalid cooking content schema');
      return { type: match[1]!.toLowerCase(), name: match[2]!, sql };
    });
  const rows = await session.all<{ type: string; name: string; sql: string }>(
    "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  if (
    rows.length !== expected.length ||
    expected.some(
      (item) =>
        !rows.some(
          (row) =>
            row.name === item.name && row.type === item.type && normalized(row.sql) === item.sql,
        ),
    )
  )
    throw new StorageFault('incompatible_version', 'Cooking content schema is incompatible');
}
