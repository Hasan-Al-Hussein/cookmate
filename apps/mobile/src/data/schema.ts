/** Fixed application DDL only. User/source values are always bound separately. */
export const SCHEMA_V2 = `
CREATE TABLE catalogue_manifest (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  catalogue_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  recipe_count INTEGER NOT NULL,
  ingredient_count INTEGER NOT NULL,
  instruction_count INTEGER NOT NULL,
  annotation_count INTEGER NOT NULL
);
CREATE TABLE recipe (
  recipe_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL, category TEXT NOT NULL, cuisine TEXT NOT NULL,
  raw_tags TEXT, photo_key TEXT NOT NULL, recipe_page TEXT NOT NULL,
  original_source_url TEXT, video_url TEXT,
  source_row INTEGER NOT NULL CHECK (source_row >= 6), original_image_url TEXT NOT NULL, fetched_utc TEXT NOT NULL
);
CREATE TABLE ingredient_entry (
  recipe_id TEXT NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0), raw_name TEXT NOT NULL, raw_measure TEXT,
  source_row INTEGER NOT NULL CHECK (source_row >= 6), source_column TEXT NOT NULL,
  PRIMARY KEY (recipe_id, position)
);
CREATE TABLE instruction_passage (
  recipe_id TEXT NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0), raw_text TEXT NOT NULL,
  presentation TEXT NOT NULL CHECK (presentation IN ('heading', 'passage')),
  source_row INTEGER NOT NULL CHECK (source_row >= 6), source_column TEXT NOT NULL,
  PRIMARY KEY (recipe_id, sequence)
);
CREATE TABLE quality_annotation (
  recipe_id TEXT NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  annotation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('limited_instructions', 'instruction_only_ingredient', 'missing_measure', 'source_gap')),
  note TEXT NOT NULL, rule_version TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (recipe_id, annotation_id)
);
CREATE TABLE annotation_evidence (
  recipe_id TEXT NOT NULL, annotation_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  sheet TEXT NOT NULL CHECK (sheet IN ('Recipes', 'Ingredients', 'Instructions')),
  source_row INTEGER NOT NULL CHECK (source_row >= 6), source_column TEXT,
  PRIMARY KEY (recipe_id, annotation_id, ordinal),
  FOREIGN KEY (recipe_id, annotation_id) REFERENCES quality_annotation(recipe_id, annotation_id) ON DELETE RESTRICT
);
CREATE TABLE state_revision (
  collection TEXT PRIMARY KEY CHECK (collection IN ('store', 'favourites', 'plan', 'shopping', 'preferences', 'conversation')),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TABLE favourite (
  recipe_id TEXT PRIMARY KEY NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  saved INTEGER NOT NULL CHECK (saved IN (0, 1)), revision INTEGER NOT NULL CHECK (revision >= 0),
  saved_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE plan_occurrence (
  occurrence_id TEXT PRIMARY KEY NOT NULL,
  recipe_id TEXT NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  local_date TEXT NOT NULL CHECK (length(local_date) = 10 AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND local_date BETWEEN '1900-01-01' AND '2100-12-31' AND date(local_date, '+0 days') IS local_date),
  meal_key TEXT NOT NULL CHECK (meal_key IN ('breakfast', 'lunch', 'dinner')),
  revision INTEGER NOT NULL CHECK (revision >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (local_date, meal_key), UNIQUE (occurrence_id, recipe_id)
);
CREATE TABLE shopping_scope (
  scope_id TEXT PRIMARY KEY NOT NULL, singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0), projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  projection_status TEXT NOT NULL CHECK (projection_status IN ('current', 'pending'))
);
CREATE TABLE shopping_selection (
  scope_id TEXT NOT NULL REFERENCES shopping_scope(scope_id) ON DELETE RESTRICT,
  occurrence_id TEXT NOT NULL REFERENCES plan_occurrence(occurrence_id) ON DELETE CASCADE,
  PRIMARY KEY (scope_id, occurrence_id)
);
CREATE INDEX shopping_selection_occurrence ON shopping_selection(occurrence_id);
CREATE TABLE shopping_group (
  scope_id TEXT NOT NULL REFERENCES shopping_scope(scope_id) ON DELETE RESTRICT,
  group_key TEXT NOT NULL, grouping_version TEXT NOT NULL,
  demand_fingerprint TEXT NOT NULL CHECK (length(demand_fingerprint) = 64),
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0), display_name TEXT NOT NULL, quantity_label TEXT NOT NULL,
  PRIMARY KEY (scope_id, group_key)
);
CREATE TABLE shopping_contribution (
  scope_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, recipe_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ingredient', 'annotation')), source_key TEXT NOT NULL,
  ingredient_position INTEGER, annotation_id TEXT, group_key TEXT NOT NULL,
  raw_name TEXT NOT NULL, raw_measure TEXT, quantity_json TEXT NOT NULL CHECK (json_valid(quantity_json)),
  PRIMARY KEY (scope_id, occurrence_id, source_kind, source_key),
  CHECK ((source_kind = 'ingredient' AND ingredient_position IS NOT NULL AND annotation_id IS NULL) OR (source_kind = 'annotation' AND ingredient_position IS NULL AND annotation_id IS NOT NULL)),
  FOREIGN KEY (scope_id, occurrence_id) REFERENCES shopping_selection(scope_id, occurrence_id) ON DELETE CASCADE,
  FOREIGN KEY (occurrence_id, recipe_id) REFERENCES plan_occurrence(occurrence_id, recipe_id) ON DELETE RESTRICT,
  FOREIGN KEY (recipe_id, ingredient_position) REFERENCES ingredient_entry(recipe_id, position) ON DELETE RESTRICT,
  FOREIGN KEY (recipe_id, annotation_id) REFERENCES quality_annotation(recipe_id, annotation_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, group_key) REFERENCES shopping_group(scope_id, group_key) ON DELETE CASCADE
);
CREATE INDEX contribution_group ON shopping_contribution(scope_id, group_key);
CREATE TABLE purchase_state (
  scope_id TEXT NOT NULL, group_key TEXT NOT NULL,
  demand_fingerprint TEXT NOT NULL CHECK (length(demand_fingerprint) = 64),
  purchased INTEGER NOT NULL CHECK (purchased IN (0, 1)), changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (scope_id, group_key),
  FOREIGN KEY (scope_id, group_key) REFERENCES shopping_group(scope_id, group_key) ON DELETE CASCADE
);
CREATE TABLE saved_preference (
  preference_id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cuisine', 'ingredient_like', 'ingredient_avoid', 'dietary_style')),
  value TEXT NOT NULL CHECK (json_valid(value) AND json_type(value) = 'text' AND length(CAST(value AS BLOB)) BETWEEN 3 AND 1538), revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TABLE conversation (
  conversation_id TEXT PRIMARY KEY NOT NULL, singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0), composer_draft TEXT NOT NULL CHECK (json_valid(composer_draft) AND json_type(composer_draft) = 'text' AND length(CAST(composer_draft AS BLOB)) BETWEEN 2 AND 24002),
  next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0)
);
CREATE TABLE conversation_memory_state (
  conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation(conversation_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  working_after_sequence INTEGER CHECK (working_after_sequence IS NULL OR working_after_sequence >= 0),
  carry_memory_ids_json TEXT NOT NULL CHECK (json_valid(carry_memory_ids_json) AND json_type(carry_memory_ids_json) = 'array' AND json_array_length(carry_memory_ids_json) <= 32 AND length(CAST(carry_memory_ids_json AS BLOB)) <= 4096)
);
CREATE TABLE message (
  message_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversation(conversation_id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation >= 0), sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text TEXT NOT NULL CHECK (json_valid(text) AND json_type(text) = 'text' AND length(CAST(text AS BLOB)) BETWEEN 2 AND 48002),
  status TEXT NOT NULL CHECK (status IN ('sending', 'complete', 'failed', 'cancelled', 'interrupted')),
  created_at TEXT NOT NULL, UNIQUE(conversation_id, generation, sequence)
);
CREATE TABLE message_context (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES message(message_id) ON DELETE CASCADE,
  source_date_context_json TEXT NOT NULL CHECK (json_valid(source_date_context_json) AND length(CAST(source_date_context_json AS BLOB)) <= 4096),
  preference_revision_at_source INTEGER NOT NULL CHECK (preference_revision_at_source >= 0)
);
CREATE TABLE memory_source_review (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES message(message_id) ON DELETE CASCADE,
  disposition TEXT NOT NULL CHECK (disposition IN ('pending', 'retain', 'non_memory', 'unresolved')),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TABLE memory_entry (
  memory_id TEXT PRIMARY KEY NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE REFERENCES message(message_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('constraint', 'correction', 'unresolved_intent', 'context')),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json) AND length(CAST(scope_json AS BLOB)) <= 4096)
);
CREATE TABLE memory_relation (
  source_memory_id TEXT NOT NULL REFERENCES memory_entry(memory_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_memory_id TEXT NOT NULL REFERENCES memory_entry(memory_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('supersedes', 'conflicts_with')),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  PRIMARY KEY (source_memory_id, ordinal), UNIQUE (source_memory_id, target_memory_id, kind)
);
CREATE INDEX memory_relation_target ON memory_relation(target_memory_id);
CREATE TABLE preference_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_removal_revision INTEGER CHECK (last_removal_revision IS NULL OR last_removal_revision >= 0)
);
CREATE TABLE source_preference_link (
  source_message_id TEXT NOT NULL REFERENCES message(message_id) ON DELETE CASCADE,
  preference_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cuisine', 'ingredient_like', 'ingredient_avoid', 'dietary_style')),
  value TEXT NOT NULL CHECK (json_valid(value) AND json_type(value) = 'text' AND length(CAST(value AS BLOB)) BETWEEN 3 AND 1538),
  saved_revision INTEGER NOT NULL CHECK (saved_revision >= 0),
  removed_revision INTEGER CHECK (removed_revision IS NULL OR removed_revision >= 0),
  save_operation_id TEXT NOT NULL REFERENCES operation_receipt(operation_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (source_message_id, preference_id, saved_revision)
);
CREATE INDEX source_preference_link_preference ON source_preference_link(preference_id, saved_revision);
CREATE TABLE reference_set (
  reference_set_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES message(message_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), UNIQUE(message_id, ordinal)
);
CREATE INDEX reference_set_message ON reference_set(message_id);
CREATE TABLE reference_item (
  reference_set_id TEXT NOT NULL REFERENCES reference_set(reference_set_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0), recipe_id TEXT NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  PRIMARY KEY(reference_set_id, position)
);
CREATE TABLE pending_intent (
  user_intent_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('draft', 'awaiting_response', 'clarification', 'confirmation', 'ready', 'dispatched', 'reconciling', 'settled', 'cancelled')),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json))
);
CREATE TABLE assistant_intent_context (
  user_intent_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_intent(user_intent_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('awaiting_response', 'accepted', 'failed', 'cancelled')),
  context_revision INTEGER NOT NULL CHECK (context_revision >= 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 131072),
  response_json TEXT CHECK (response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB)) <= 131072)),
  guards_json TEXT CHECK (guards_json IS NULL OR (json_valid(guards_json) AND length(CAST(guards_json AS BLOB)) <= 4096)),
  slot_results_json TEXT NOT NULL CHECK (json_valid(slot_results_json) AND length(CAST(slot_results_json AS BLOB)) <= 131072),
  CHECK ((lifecycle = 'awaiting_response' AND response_json IS NULL AND guards_json IS NULL)
      OR (lifecycle = 'accepted' AND response_json IS NOT NULL AND guards_json IS NOT NULL)
      OR lifecycle IN ('failed', 'cancelled'))
);
CREATE TABLE assistant_acceptance_envelope (
  user_intent_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_intent(user_intent_id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL UNIQUE,
  expected_intent_revision INTEGER NOT NULL CHECK (expected_intent_revision >= 0)
);
CREATE TABLE assistant_action_plan (
  user_intent_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_intent(user_intent_id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND length(CAST(plan_json AS BLOB)) <= 131072),
  guards_json TEXT NOT NULL CHECK (json_valid(guards_json) AND length(CAST(guards_json AS BLOB)) <= 4096),
  cursor INTEGER NOT NULL CHECK (cursor BETWEEN 0 AND 8)
);
CREATE TABLE assistant_acceptance (
  user_intent_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_intent(user_intent_id) ON DELETE CASCADE,
  normalization_version TEXT NOT NULL CHECK (normalization_version = 'memory-acceptance-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  acknowledgement_json TEXT NOT NULL CHECK (json_valid(acknowledgement_json) AND length(CAST(acknowledgement_json AS BLOB)) <= 524288)
);
CREATE TABLE command_slot (
  slot_id TEXT PRIMARY KEY NOT NULL, user_intent_id TEXT NOT NULL REFERENCES pending_intent(user_intent_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0), operation_id TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)), UNIQUE(user_intent_id, position)
);
CREATE TABLE command_review_guard (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES command_slot(operation_id) ON DELETE CASCADE,
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
  shopping_scope_revision INTEGER NOT NULL CHECK (shopping_scope_revision >= 0)
);
CREATE TABLE direct_command_recovery (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence > 0),
  operation_id TEXT NOT NULL UNIQUE REFERENCES command_slot(operation_id) ON DELETE CASCADE
);
CREATE TABLE operation_receipt (
  operation_id TEXT PRIMARY KEY NOT NULL, user_intent_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'no_op')), committed_at TEXT NOT NULL,
  shopping_projection TEXT NOT NULL CHECK (shopping_projection IN ('unchanged', 'current', 'pending')),
  effects_json TEXT NOT NULL CHECK (json_valid(effects_json))
);
CREATE TABLE app_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

/** Deliberate opt-in rollout; the default application still opens schema 2. */
export const PORTABLE_RESTORE_SCHEMA_VERSION = 3;
export const PORTABLE_RESTORE_MIGRATION = `
CREATE TABLE portable_restore_operation (
  operation_id TEXT PRIMARY KEY NOT NULL,
  import_fingerprint TEXT NOT NULL CHECK (length(import_fingerprint) = 64),
  reviewed_revision INTEGER NOT NULL CHECK (reviewed_revision >= 0),
  committed_revision INTEGER NOT NULL CHECK (committed_revision > reviewed_revision),
  imported_json TEXT NOT NULL CHECK (json_valid(imported_json) AND length(CAST(imported_json AS BLOB)) <= 8388608),
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND length(CAST(before_json AS BLOB)) <= 8388608),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 16384)
);
`;
export const SCHEMA_V3 = SCHEMA_V2 + PORTABLE_RESTORE_MIGRATION;

/** Local cooking only; no change to the provider or command wire versions. */
export const COOKING_SCHEMA_VERSION = 4;
export const COOKING_MIGRATION = `
CREATE TABLE cooking_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_revision INTEGER NOT NULL CHECK (session_revision >= 0),
  history_revision INTEGER NOT NULL CHECK (history_revision >= 0),
  history_epoch INTEGER NOT NULL CHECK (history_epoch >= 0)
);
CREATE TABLE cooking_session (
  recipe_id TEXT PRIMARY KEY REFERENCES recipe(recipe_id),
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'dismissed', 'completed')),
  updated_at TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  session_json TEXT NOT NULL CHECK (json_valid(session_json) AND length(CAST(session_json AS BLOB)) <= 8192)
);
CREATE INDEX cooking_session_resume ON cooking_session(state, updated_at DESC, revision DESC, recipe_id);
CREATE TABLE cooking_event (
  event_id TEXT PRIMARY KEY,
  history_epoch INTEGER NOT NULL CHECK (history_epoch >= 0),
  state TEXT NOT NULL CHECK (state IN ('saved', 'cleared', 'cancelled')),
  cooked_on TEXT,
  recorded_at TEXT,
  request_fingerprint TEXT,
  receipt_json TEXT,
  CHECK ((state IN ('cleared', 'cancelled') AND cooked_on IS NULL AND recorded_at IS NULL AND request_fingerprint IS NULL AND receipt_json IS NULL) OR
    (state = 'saved' AND cooked_on IS NOT NULL AND recorded_at IS NOT NULL AND request_fingerprint IS NOT NULL AND length(request_fingerprint) = 64 AND
      receipt_json IS NOT NULL AND json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 32768))
);
CREATE INDEX cooking_event_page ON cooking_event(state, cooked_on DESC, recorded_at DESC, event_id DESC);
CREATE TABLE cooking_history_clear (
  operation_id TEXT PRIMARY KEY,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 4096)
);
`;
export const SCHEMA_V4 = SCHEMA_V3 + COOKING_MIGRATION;

/** Private app-only organization; never recipe ingredients, published content or AI context. */
export const PERSONAL_SCHEMA_VERSION = 5;
export const PERSONAL_MIGRATION = `
CREATE TABLE personal_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0)
);
CREATE TABLE recipe_note (
  note_id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL UNIQUE REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  text TEXT,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((deleted = 1 AND text IS NULL) OR (deleted = 0 AND text IS NOT NULL AND json_valid(text) AND length(CAST(text AS BLOB)) <= 32768))
);
CREATE TABLE personal_collection (
  collection_id TEXT PRIMARY KEY,
  name TEXT,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((deleted = 1 AND name IS NULL) OR (deleted = 0 AND name IS NOT NULL AND json_valid(name) AND length(CAST(name AS BLOB)) <= 2048))
);
CREATE TABLE personal_collection_member (
  collection_id TEXT NOT NULL REFERENCES personal_collection(collection_id) ON DELETE RESTRICT,
  recipe_id TEXT NOT NULL REFERENCES recipe(recipe_id) ON DELETE RESTRICT,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0), updated_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, recipe_id)
);
CREATE INDEX personal_member_recipe ON personal_collection_member(recipe_id, collection_id);
CREATE TABLE manual_shopping_item (
  item_id TEXT PRIMARY KEY,
  name TEXT, amount_text TEXT, unit_text TEXT,
  category TEXT CHECK (category IS NULL OR category IN ('produce', 'dairy', 'meat_fish', 'pantry', 'other')),
  purchased INTEGER NOT NULL CHECK (purchased IN (0, 1)),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((deleted = 1 AND name IS NULL AND amount_text IS NULL AND unit_text IS NULL AND category IS NULL AND purchased = 0) OR
    (deleted = 0 AND name IS NOT NULL AND json_valid(name) AND length(CAST(name AS BLOB)) <= 2048 AND category IS NOT NULL)),
  CHECK (amount_text IS NULL OR (json_valid(amount_text) AND length(CAST(amount_text AS BLOB)) <= 1024)),
  CHECK (unit_text IS NULL OR (json_valid(unit_text) AND length(CAST(unit_text AS BLOB)) <= 1024))
);
CREATE INDEX manual_item_page ON manual_shopping_item(deleted, item_id);
CREATE TABLE personal_operation (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT CHECK (request_fingerprint IS NULL OR length(request_fingerprint) = 64),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 4096)
);
CREATE TABLE imported_cooking_history (
  event_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  restore_operation_id TEXT NOT NULL REFERENCES portable_restore_operation(operation_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  history_epoch INTEGER NOT NULL CHECK (history_epoch >= 0),
  cooked_on TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json) AND length(CAST(entry_json AS BLOB)) <= 32768)
);
CREATE INDEX imported_history_page ON imported_cooking_history(history_epoch, cooked_on DESC, recorded_at DESC, event_id DESC);
`;
export const SCHEMA_V5 = SCHEMA_V4 + PERSONAL_MIGRATION;

export const ACCOUNT_HISTORY_SCHEMA_VERSION = 6;
export const ACCOUNT_HISTORY_ENTRY_MAX_BYTES = 32768;

// Fixed expressions only. Runtime approval/owner/content checks still authorize every write.
const accountHistoryUuid = (column: string) =>
  `typeof(${column})='text' AND instr(${column},char(0))=0 AND length(${column})=36 AND substr(${column},9,1)='-' AND substr(${column},14,1)='-' AND substr(${column},19,1)='-' AND substr(${column},24,1)='-' AND substr(${column},15,1)='4' AND substr(${column},20,1) IN ('8','9','a','b') AND length(replace(${column},'-',''))=32 AND replace(${column},'-','') NOT GLOB '*[^0-9a-f]*'`;
// SQLite length stops at NUL. Protect literal backslashes, replace JSON-escaped NUL with
// one space, then decode before counting; other Unicode characters keep their exact count.
const accountHistoryCharacters = (path: string) =>
  `length(json_extract(replace(replace(json_quote(json_extract(entry_json,'$.${path}')),'\\\\','\\u005c'),'\\u0000',' '),'$'))`;
const accountHistoryText = (path: string, maximum: number) =>
  `json_type(entry_json,'$.${path}')='text' AND ${accountHistoryCharacters(path)} BETWEEN 1 AND ${maximum} AND (length(trim(json_extract(entry_json,'$.${path}')))>0 OR instr(json_extract(entry_json,'$.${path}'),char(0))>0)`;
const accountHistoryHash = (path: string) =>
  `json_type(entry_json,'$.${path}')='text' AND instr(json_extract(entry_json,'$.${path}'),char(0))=0 AND length(json_extract(entry_json,'$.${path}'))=64 AND json_extract(entry_json,'$.${path}') NOT GLOB '*[^0-9a-f]*'`;

/** Data-only projection; this DDL never creates completion receipts or changes existing history. */
export const ACCOUNT_HISTORY_MIGRATION = `
CREATE TABLE account_cooking_history (
  owner_id TEXT NOT NULL CHECK (${accountHistoryUuid('owner_id')}),
  event_id TEXT NOT NULL CHECK (${accountHistoryUuid('event_id')}),
  entry_json TEXT NOT NULL CHECK (typeof(entry_json)='text' AND json_valid(entry_json) AND length(CAST(entry_json AS BLOB))<=${ACCOUNT_HISTORY_ENTRY_MAX_BYTES}),
  PRIMARY KEY (owner_id,event_id),
  CHECK (COALESCE(
    json_type(entry_json)='object' AND
    json_remove(entry_json,'$.eventId','$.recipeId','$.catalogue','$.contentFingerprint','$.readerVersion','$.recipeTitle','$.photoKey','$.cookedOn','$.timeZone','$.recordedAt','$.note','$.origin')='{}' AND
    json_type(entry_json,'$.eventId')='text' AND json_extract(entry_json,'$.eventId')=event_id AND
    json_type(entry_json,'$.recipeId')='text' AND instr(json_extract(entry_json,'$.recipeId'),char(0))=0 AND length(json_extract(entry_json,'$.recipeId')) BETWEEN 1 AND 20 AND json_extract(entry_json,'$.recipeId') NOT GLOB '*[^0-9]*' AND
    json_type(entry_json,'$.catalogue')='object' AND json_remove(json_extract(entry_json,'$.catalogue'),'$.version','$.fingerprint')='{}' AND
    ${accountHistoryText('catalogue.version', 200)} AND
    ${accountHistoryHash('catalogue.fingerprint')} AND
    ${accountHistoryHash('contentFingerprint')} AND
    json_type(entry_json,'$.readerVersion')='integer' AND json_extract(entry_json,'$.readerVersion')=1 AND
    ${accountHistoryText('recipeTitle', 1000)} AND
    ${accountHistoryText('photoKey', 300)} AND
    json_type(entry_json,'$.cookedOn')='text' AND length(json_extract(entry_json,'$.cookedOn'))=10 AND json_extract(entry_json,'$.cookedOn') BETWEEN '0001-01-01' AND '9999-12-31' AND date(json_extract(entry_json,'$.cookedOn'),'+0 days') IS json_extract(entry_json,'$.cookedOn') AND
    ${accountHistoryText('timeZone', 100)} AND
    json_type(entry_json,'$.recordedAt')='text' AND length(json_extract(entry_json,'$.recordedAt'))=24 AND substr(json_extract(entry_json,'$.recordedAt'),1,10) BETWEEN '0001-01-01' AND '9999-12-31' AND date(substr(json_extract(entry_json,'$.recordedAt'),1,10),'+0 days') IS substr(json_extract(entry_json,'$.recordedAt'),1,10) AND substr(json_extract(entry_json,'$.recordedAt'),12,2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(entry_json,'$.recordedAt')) IS json_extract(entry_json,'$.recordedAt') AND
    (json_type(entry_json,'$.note')='null' OR (json_type(entry_json,'$.note')='text' AND ${accountHistoryCharacters('note')}<=2000)) AND
    (json_type(entry_json,'$.origin') IS NULL OR (json_type(entry_json,'$.origin')='text' AND json_extract(entry_json,'$.origin')='backup'))
  ,0))
);
CREATE TABLE account_cooking_history_removed (
  owner_id TEXT NOT NULL CHECK (${accountHistoryUuid('owner_id')}),
  event_id TEXT NOT NULL CHECK (${accountHistoryUuid('event_id')}),
  PRIMARY KEY (owner_id,event_id)
);
CREATE TABLE cooking_history_withdrawal (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (${accountHistoryUuid('event_id')})
);
`;
export const SCHEMA_V6 = SCHEMA_V5 + ACCOUNT_HISTORY_MIGRATION;
