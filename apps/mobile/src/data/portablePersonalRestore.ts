import { isUtcInstant } from '@cookmate/contracts';
import {
  PORTABLE_BACKUP_MAX_BYTES,
  personalLimits,
  portablePersonalLimits,
  validatePortablePersonal,
} from '@cookmate/domain';
import type {
  CollectionMembership,
  Immutable,
  ManualShoppingItem,
  PersonalCollection,
  PortablePersonalData,
  RecipeNote,
} from '@cookmate/domain';
import {
  collectionColumns,
  manualColumns,
  membershipColumns,
  noteColumns,
  parseCollection,
  parseManual,
  parseMembership,
  parseNote,
  readPersonalState,
  requirePersonalRecord,
} from './personalRecords';
import type {
  CollectionRow,
  ManualRow,
  MembershipRow,
  NoteRow,
  PersonalState,
} from './personalRecords';
import { isRevision } from './conversationRecords';
import { freezeResult } from './query';
import { StorageFault } from './sql';
import type { SqlSession } from './sql';

export interface PortablePersonalRestoreConflict {
  kind:
    | 'note_removed'
    | 'note_identity_conflict'
    | 'collection_removed'
    | 'membership_removed'
    | 'parent_collection_removed'
    | 'manual_item_removed';
  entityId: string;
  recipeId?: string;
}
export interface PortablePersonalRestoreCheck {
  allowed: boolean;
  conflicts: readonly Immutable<PortablePersonalRestoreConflict>[];
}

export interface PortablePersonalRestoreSource {
  data: { personal?: PortablePersonalData };
}
export interface PortablePersonalRestoreOptions {
  contentSchema: true;
  /** Explicit private8 caller; omitted preserves the existing private7 path. */
  cookingSchemaVersion?: 8;
}

/** Private restore explicitly selects seven/eight; ordinary personal APIs stay on five/six. */
export async function readPortablePersonalRestoreState(
  session: SqlSession,
  options?: PortablePersonalRestoreOptions,
): Promise<PersonalState> {
  if (options?.contentSchema !== true) return readPersonalState(session);
  requirePersonalRecord(
    options.cookingSchemaVersion === undefined || options.cookingSchemaVersion === 8,
  );
  return readContentPersonalState(session, options.cookingSchemaVersion ?? 7);
}

async function readContentPersonalState(
  session: SqlSession,
  expectedVersion: 7 | 8,
): Promise<PersonalState> {
  requirePersonalRecord(
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version ===
      expectedVersion,
  );
  const rows = await session.all<PersonalState>(
    `SELECT CASE WHEN typeof(revision)='integer' THEN revision END revision,CASE WHEN typeof(epoch)='integer' THEN epoch END epoch FROM personal_state WHERE singleton=1`,
  );
  requirePersonalRecord(
    rows.length === 1 && isRevision(rows[0]!.revision) && isRevision(rows[0]!.epoch),
  );
  return rows[0]!;
}

type PersonalColumn = readonly [name: string, maximum: number | 'integer', nullable?: boolean];
const encoded = (characters: number) => characters * 6 + 2;
const personalDates: readonly PersonalColumn[] = [
  ['created_at', 24],
  ['updated_at', 24],
];
const personalBounds: readonly {
  table: string;
  maximum: number;
  columns: readonly PersonalColumn[];
}[] = [
  {
    table: 'recipe_note',
    maximum: portablePersonalLimits.notes,
    columns: [
      ['note_id', 36],
      ['recipe_id', 20],
      ['text', encoded(personalLimits.noteCharacters), true],
      ['deleted', 'integer'],
      ['revision', 'integer'],
      ...personalDates,
    ],
  },
  {
    table: 'personal_collection',
    maximum: portablePersonalLimits.collections,
    columns: [
      ['collection_id', 36],
      ['name', encoded(personalLimits.collectionNameCharacters), true],
      ['deleted', 'integer'],
      ['revision', 'integer'],
      ...personalDates,
    ],
  },
  {
    table: 'personal_collection_member',
    maximum: portablePersonalLimits.memberships,
    columns: [
      ['collection_id', 36],
      ['recipe_id', 20],
      ['present', 'integer'],
      ['revision', 'integer'],
      ['updated_at', 24],
    ],
  },
  {
    table: 'manual_shopping_item',
    maximum: portablePersonalLimits.manualItems,
    columns: [
      ['item_id', 36],
      ['name', encoded(personalLimits.itemNameCharacters), true],
      ['amount_text', encoded(personalLimits.amountCharacters), true],
      ['unit_text', encoded(personalLimits.unitCharacters), true],
      ['category', 16, true],
      ['purchased', 'integer'],
      ['deleted', 'integer'],
      ['revision', 'integer'],
      ...personalDates,
    ],
  },
];
/** Admit private content payloads before any unbounded text or identity is materialized. */
async function admitContentPersonalRows(session: SqlSession) {
  let bytes = 0;
  for (const { table, maximum, columns } of personalBounds) {
    const invalid = columns
      .map(([name, limit, nullable]) => {
        const valid =
          limit === 'integer'
            ? `typeof(${name})='integer' AND ${name} BETWEEN 0 AND 9007199254740991`
            : `typeof(${name})='text' AND length(CAST(${name} AS BLOB))<=${limit}`;
        return `(CASE WHEN ${nullable ? `${name} IS NULL OR ` : ''}(${valid}) THEN 0 ELSE 1 END)`;
      })
      .join('+');
    const size = columns.map(([name]) => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join('+');
    const [row] = await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(${size}),0) bytes,COALESCE(MAX(${invalid}),0) invalid FROM ${table}`,
    );
    requirePersonalRecord(
      row &&
        isRevision(row.count) &&
        row.count <= maximum &&
        isRevision(row.bytes) &&
        row.invalid === 0,
    );
    bytes += row.bytes;
    requirePersonalRecord(bytes <= PORTABLE_BACKUP_MAX_BYTES);
  }
}

async function readCurrentPersonal(
  session: SqlSession,
  options?: PortablePersonalRestoreOptions,
): Promise<PortablePersonalData> {
  await readPortablePersonalRestoreState(session, options);
  if (options?.contentSchema === true) await admitContentPersonalRows(session);
  return readPersonalRows(session);
}

/** Private schema8 admission only; callers must establish owner authority before reading payloads.
 * This reader supplies local integrity and bounds, not recipe-publication or merge authority.
 */
export async function readAccountContentPersonalRows(session: SqlSession): Promise<{
  state: PersonalState;
  personal: PortablePersonalData;
}> {
  const state = await readContentPersonalState(session, 8);
  await admitContentPersonalRows(session);
  return { state, personal: await readPersonalRows(session) };
}

async function readPersonalRows(session: SqlSession): Promise<PortablePersonalData> {
  const current: PortablePersonalData = {
    notes: (
      await session.all<NoteRow>(
        `SELECT ${noteColumns} FROM recipe_note ORDER BY recipe_id LIMIT ${portablePersonalLimits.notes + 1}`,
      )
    ).map(parseNote),
    collections: (
      await session.all<CollectionRow>(
        `SELECT ${collectionColumns} FROM personal_collection ORDER BY collection_id LIMIT ${portablePersonalLimits.collections + 1}`,
      )
    ).map(parseCollection),
    memberships: (
      await session.all<MembershipRow>(
        `SELECT ${membershipColumns} FROM personal_collection_member ORDER BY collection_id,recipe_id LIMIT ${portablePersonalLimits.memberships + 1}`,
      )
    ).map(parseMembership),
    manualItems: (
      await session.all<ManualRow>(
        `SELECT ${manualColumns} FROM manual_shopping_item ORDER BY item_id LIMIT ${portablePersonalLimits.manualItems + 1}`,
      )
    ).map(parseManual),
  };
  requirePersonalRecord(validatePortablePersonal(current));
  return current;
}
const membershipKey = (row: Pick<CollectionMembership, 'collectionId' | 'recipeId'>) =>
  `${row.collectionId}/${row.recipeId}`;

function inspect(
  current: PortablePersonalData,
  imported: Immutable<PortablePersonalData>,
): Immutable<PortablePersonalRestoreCheck> {
  requirePersonalRecord(validatePortablePersonal(imported));
  const notes = new Map(current.notes.map((row) => [row.recipeId, row]));
  const noteIds = new Map(current.notes.map((row) => [row.noteId, row]));
  const collections = new Map(current.collections.map((row) => [row.collectionId, row]));
  const memberships = new Map(current.memberships.map((row) => [membershipKey(row), row]));
  const manual = new Map(current.manualItems.map((row) => [row.itemId, row]));
  const conflicts: PortablePersonalRestoreConflict[] = [];
  for (const row of imported.notes) {
    const before = notes.get(row.recipeId);
    if (!row.deleted && before?.deleted)
      conflicts.push({ kind: 'note_removed', entityId: before.noteId, recipeId: row.recipeId });
    else if (!row.deleted && before && before.noteId !== row.noteId)
      conflicts.push({
        kind: 'note_identity_conflict',
        entityId: row.noteId,
        recipeId: row.recipeId,
      });
    const sameId = noteIds.get(row.noteId);
    if (sameId && sameId.recipeId !== row.recipeId)
      conflicts.push({
        kind: 'note_identity_conflict',
        entityId: row.noteId,
        recipeId: row.recipeId,
      });
  }
  for (const row of imported.collections)
    if (!row.deleted && collections.get(row.collectionId)?.deleted)
      conflicts.push({ kind: 'collection_removed', entityId: row.collectionId });
  for (const row of imported.manualItems)
    if (!row.deleted && manual.get(row.itemId)?.deleted)
      conflicts.push({ kind: 'manual_item_removed', entityId: row.itemId });
  for (const row of imported.memberships) {
    if (!row.present) continue;
    if (memberships.get(membershipKey(row))?.present === false)
      conflicts.push({
        kind: 'membership_removed',
        entityId: row.collectionId,
        recipeId: row.recipeId,
      });
    if (collections.get(row.collectionId)?.deleted)
      conflicts.push({
        kind: 'parent_collection_removed',
        entityId: row.collectionId,
        recipeId: row.recipeId,
      });
  }
  const unique = [...new Map(conflicts.map((row) => [JSON.stringify(row), row])).entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, row]) => row);
  return freezeResult({ allowed: unique.length === 0, conflicts: unique });
}

/** Read-only and owner-workspace scoped by the supplied transaction. Never includes private values. */
export async function checkPortablePersonalRestore(
  session: SqlSession,
  source: Immutable<PortablePersonalRestoreSource>,
  options?: PortablePersonalRestoreOptions,
): Promise<Immutable<PortablePersonalRestoreCheck>> {
  if (!source.data.personal) return freezeResult({ allowed: true, conflicts: [] });
  return inspect(await readCurrentPersonal(session, options), source.data.personal);
}

/** The caller writes this replacement in its existing restore transaction. No deletion fact is pruned. */
export async function preparePortablePersonalRestoreData(
  session: SqlSession,
  source: Immutable<PortablePersonalRestoreSource>,
  restoredAt: string,
  options?: PortablePersonalRestoreOptions,
): Promise<PortablePersonalData | null> {
  const imported = source.data.personal;
  if (!imported) return null;
  requirePersonalRecord(isUtcInstant(restoredAt));
  const current = await readCurrentPersonal(session, options);
  if (!inspect(current, imported).allowed)
    throw new StorageFault(
      'storage_failure',
      'Personal restore conflicts with retained removals or note identity',
    );

  const importedNotes = new Map(imported.notes.map((row) => [row.recipeId, row]));
  const notes = new Map<string, RecipeNote>(
    imported.notes.map((row) => [row.recipeId, { ...row }]),
  );
  for (const row of current.notes) {
    const next = importedNotes.get(row.recipeId);
    if (row.deleted) notes.set(row.recipeId, { ...row });
    else if (!next || next.deleted)
      notes.set(row.recipeId, { ...row, deleted: true, text: null, updatedAt: restoredAt });
  }
  const importedCollections = new Map(imported.collections.map((row) => [row.collectionId, row]));
  const collections = new Map<string, PersonalCollection>(
    imported.collections.map((row) => [row.collectionId, { ...row }]),
  );
  for (const row of current.collections) {
    const next = importedCollections.get(row.collectionId);
    if (row.deleted) collections.set(row.collectionId, { ...row });
    else if (!next || next.deleted)
      collections.set(row.collectionId, {
        ...row,
        deleted: true,
        name: null,
        updatedAt: restoredAt,
      });
  }
  const importedManual = new Map(imported.manualItems.map((row) => [row.itemId, row]));
  const manualItems = new Map<string, ManualShoppingItem>(
    imported.manualItems.map((row) => [row.itemId, { ...row }]),
  );
  for (const row of current.manualItems) {
    const next = importedManual.get(row.itemId);
    if (row.deleted) manualItems.set(row.itemId, { ...row });
    else if (!next || next.deleted)
      manualItems.set(row.itemId, {
        ...row,
        deleted: true,
        name: null,
        amountText: null,
        unitText: null,
        category: null,
        purchased: false,
        updatedAt: restoredAt,
      });
  }
  const importedMemberships = new Map(imported.memberships.map((row) => [membershipKey(row), row]));
  const memberships = new Map<string, CollectionMembership>(
    imported.memberships.map((row) => [membershipKey(row), { ...row }]),
  );
  for (const row of current.memberships) {
    const key = membershipKey(row);
    if (!row.present) memberships.set(key, { ...row });
    else if (!importedMemberships.get(key)?.present || collections.get(row.collectionId)?.deleted)
      memberships.set(key, { ...row, present: false, updatedAt: restoredAt });
  }
  const result: PortablePersonalData = {
    notes: [...notes.values()],
    collections: [...collections.values()],
    memberships: [...memberships.values()],
    manualItems: [...manualItems.values()],
  };
  if (!validatePortablePersonal(result))
    throw new StorageFault(
      'storage_failure',
      'Personal restore retained records exceed supported bounds or relationships',
    );
  return result;
}
