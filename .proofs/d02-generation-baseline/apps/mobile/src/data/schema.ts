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
