import { isUtcInstant } from '@cookmate/contracts';
import { manualShoppingCategories, personalLimits } from '@cookmate/domain';
import type {
  CollectionMembership,
  ManualShoppingItem,
  PersonalCollection,
  PersonalReceipt,
  RecipeNote,
} from '@cookmate/domain';
import { isAppId, isRevision } from './conversationRecords';
import { StorageFault } from './sql';
import type { SqlSession } from './sql';
import { decodeStoredText } from './storedText';

export function requirePersonalRecord(condition: unknown): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', 'Stored personal data is invalid');
}
export const personalText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
export const personalPositive = (value: unknown): value is number => isRevision(value) && value > 0;
export const personalHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const personalObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const personalExact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validRecipeId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,20}$/.test(value);
const validDates = (value: { createdAt: string; updatedAt: string }) =>
  isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt);
const decode = (value: string | null) => (value === null ? null : decodeStoredText(value));
export interface PersonalState {
  revision: number;
  epoch: number;
}
export async function readPersonalState(
  session: SqlSession,
  privateSchema?: 8,
): Promise<PersonalState> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (privateSchema === 8 ? version !== 8 : version !== 5 && version !== 6)
    throw new StorageFault('incompatible_version', 'Personal storage is not activated');
  const rows = await session.all<PersonalState>(
    'SELECT revision, epoch FROM personal_state WHERE singleton=1',
  );
  requirePersonalRecord(
    rows.length === 1 && isRevision(rows[0]!.revision) && isRevision(rows[0]!.epoch),
  );
  return rows[0]!;
}
export type NoteRow = Omit<RecipeNote, 'deleted'> & { deleted: number };
export const noteColumns =
  'note_id AS noteId,recipe_id AS recipeId,text,deleted,revision,created_at AS createdAt,updated_at AS updatedAt';
export function parseNote(row: NoteRow): RecipeNote {
  const value = { ...row, text: decode(row.text), deleted: row.deleted === 1 };
  requirePersonalRecord(
    isAppId(value.noteId) &&
      validRecipeId(value.recipeId) &&
      [0, 1].includes(row.deleted) &&
      personalPositive(value.revision) &&
      validDates(value) &&
      (value.deleted
        ? value.text === null
        : personalText(value.text, personalLimits.noteCharacters)),
  );
  return value;
}
export type CollectionRow = Omit<PersonalCollection, 'deleted'> & { deleted: number };
export const collectionColumns =
  'collection_id AS collectionId,name,deleted,revision,created_at AS createdAt,updated_at AS updatedAt';
export function parseCollection(row: CollectionRow): PersonalCollection {
  const value = { ...row, name: decode(row.name), deleted: row.deleted === 1 };
  requirePersonalRecord(
    isAppId(value.collectionId) &&
      [0, 1].includes(row.deleted) &&
      personalPositive(value.revision) &&
      validDates(value) &&
      (value.deleted
        ? value.name === null
        : personalText(value.name, personalLimits.collectionNameCharacters)),
  );
  return value;
}
export type MembershipRow = Omit<CollectionMembership, 'present'> & { present: number };
export const membershipColumns =
  'collection_id AS collectionId,recipe_id AS recipeId,present,revision,updated_at AS updatedAt';
export function parseMembership(row: MembershipRow): CollectionMembership {
  requirePersonalRecord(
    isAppId(row.collectionId) &&
      validRecipeId(row.recipeId) &&
      [0, 1].includes(row.present) &&
      personalPositive(row.revision) &&
      isUtcInstant(row.updatedAt),
  );
  return { ...row, present: row.present === 1 };
}
export type ManualRow = Omit<ManualShoppingItem, 'kind' | 'purchased' | 'deleted'> & {
  purchased: number;
  deleted: number;
};
export const manualColumns =
  'item_id AS itemId,name,amount_text AS amountText,unit_text AS unitText,category,purchased,deleted,revision,created_at AS createdAt,updated_at AS updatedAt';
export function parseManual(row: ManualRow): ManualShoppingItem {
  const value: ManualShoppingItem = {
    ...row,
    kind: 'manual',
    name: decode(row.name),
    amountText: decode(row.amountText),
    unitText: decode(row.unitText),
    purchased: row.purchased === 1,
    deleted: row.deleted === 1,
  };
  requirePersonalRecord(
    isAppId(value.itemId) &&
      [0, 1].includes(row.purchased) &&
      [0, 1].includes(row.deleted) &&
      personalPositive(value.revision) &&
      validDates(value) &&
      (value.deleted
        ? value.name === null &&
          value.amountText === null &&
          value.unitText === null &&
          value.category === null &&
          !value.purchased
        : personalText(value.name, personalLimits.itemNameCharacters) &&
          (value.amountText === null ||
            personalText(value.amountText, personalLimits.amountCharacters)) &&
          (value.unitText === null ||
            personalText(value.unitText, personalLimits.unitCharacters)) &&
          manualShoppingCategories.includes(value.category!)),
  );
  return value;
}
export interface PersonalReceiptRow {
  requestFingerprint: string | null;
  receipt: PersonalReceipt;
}
export async function readPersonalReceipt(
  session: SqlSession,
  id: string,
): Promise<PersonalReceiptRow | null> {
  const row = (
    await session.all<{ requestFingerprint: string | null; receiptJson: string }>(
      'SELECT request_fingerprint AS requestFingerprint,receipt_json AS receiptJson FROM personal_operation WHERE operation_id=?',
      [id],
    )
  )[0];
  if (!row) return null;
  requirePersonalRecord(typeof row.receiptJson === 'string' && row.receiptJson.length <= 4096);
  const value: unknown = JSON.parse(row.receiptJson);
  requirePersonalRecord(
    personalObject(value) &&
      personalExact(value, [
        'operationId',
        'outcome',
        'commandKind',
        'entityId',
        'revision',
        'epoch',
        'committedAt',
        'affectedMemberships',
      ]) &&
      value.operationId === id &&
      isRevision(value.revision) &&
      isRevision(value.epoch) &&
      typeof value.committedAt === 'string' &&
      isUtcInstant(value.committedAt) &&
      isRevision(value.affectedMemberships),
  );
  requirePersonalRecord(
    value.outcome === 'cancelled'
      ? value.commandKind === null &&
          value.entityId === null &&
          value.affectedMemberships === 0 &&
          row.requestFingerprint === null
      : ['committed', 'no_op'].includes(value.outcome as string) &&
          [
            'saveNote',
            'deleteNote',
            'createCollection',
            'renameCollection',
            'setCollectionMembership',
            'addManualItem',
            'editManualItem',
            'setManualPurchased',
            'deleteManualItem',
            'deleteCollection',
          ].includes(value.commandKind as string) &&
          isAppId(value.entityId) &&
          personalHash(row.requestFingerprint),
  );
  return {
    requestFingerprint: row.requestFingerprint,
    receipt: value as unknown as PersonalReceipt,
  };
}
