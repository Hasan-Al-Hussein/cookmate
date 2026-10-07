/** Additive admin schema 2. Original draft documents and operation receipts are never rewritten. */
export const TRANSLATION_SCHEMA = [
  `CREATE TABLE admin_translation (
    translation_id TEXT PRIMARY KEY NOT NULL,
    source_draft_id TEXT NOT NULL REFERENCES admin_draft(draft_id),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0)
  )`,
  `CREATE TABLE admin_translation_revision (
    translation_id TEXT NOT NULL REFERENCES admin_translation(translation_id),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
    source_draft_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    document TEXT NOT NULL CHECK(typeof(document)='text' AND length(CAST(document AS BLOB))<=1064960 AND json_valid(document)),
    PRIMARY KEY(translation_id,revision),
    FOREIGN KEY(source_draft_id,source_revision) REFERENCES admin_draft_revision(draft_id,revision)
  )`,
  'CREATE INDEX admin_translation_source ON admin_translation(source_draft_id,translation_id)',
] as const;
