import {
  catalogueMatches,
  isUtcInstant,
  validatePlanOccurrence,
  validatePreferenceSnapshot,
  validateShoppingScope,
} from '@cookmate/contracts';
import type {
  CatalogueIdentity,
  PlanOccurrence,
  PreferenceSnapshot,
  SavedPreference,
  ShoppingScope,
} from '@cookmate/contracts';
import { isSupportedPlanDate } from './dates';
import type { Immutable } from './search';
import {
  portablePersonalCounts,
  portablePersonalLimits,
  validatePortableHistory,
  validatePortablePersonal,
  validatePortablePersonalCounts,
} from './portableBackupExpanded';
import type {
  PortableCookingHistory,
  PortablePersonalCounts,
  PortablePersonalData,
} from './portableBackupExpanded';
import { summarizePortableBackupReferences } from './portableBackupReferences';
import type { PortableBackupReferenceSummary } from './portableBackupReferences';
export { summarizePortableBackupReferences } from './portableBackupReferences';
export type {
  PortableBackupReferenceSummary,
  PortableBackupReferenceReason,
  PortableHistoryContentVerification,
} from './portableBackupReferences';

export const PORTABLE_BACKUP_FORMAT = 'cookmate-local-backup';
export const PORTABLE_BACKUP_VERSION = 1;
export const PORTABLE_BACKUP_EXPANDED_VERSION = 2;
export const PORTABLE_BACKUP_MAX_BYTES = 8 * 1024 * 1024;
export const portableBackupLimits = {
  favourites: 10000,
  occurrences: 20000,
  selectedOccurrences: 1000,
  purchaseMarks: 40000,
  preferences: 100,
  preferenceRemovals: 10000,
} as const;

export interface PortableFavourite {
  recipeId: string;
  saved: boolean;
  revision: number;
  savedAt: string;
  updatedAt: string;
}

export interface PortablePurchaseMark {
  groupKey: string;
  groupingVersion: string;
  demandFingerprint: string;
  projectionRevision: number;
  purchased: boolean;
  changed: boolean;
  revision: number;
}

/** Withdrawal facts only; no source-message identity, message text or executable receipt. */
export interface PortablePreferenceRemoval {
  preferenceId: string;
  type: SavedPreference['type'];
  value: string;
  savedRevision: number;
  removedRevision: number;
}

export interface PortableBackupData {
  favourites: PortableFavourite[];
  occurrences: PlanOccurrence[];
  shopping: {
    scope: ShoppingScope;
    projectionRevision: number;
    projectionStatus: 'current' | 'pending';
    purchaseMarks: PortablePurchaseMark[];
  };
  preferences: {
    snapshot: PreferenceSnapshot;
    removals: PortablePreferenceRemoval[];
  };
  /** Format 2 only. All four personal collections, including redacted tombstones. */
  personal?: PortablePersonalData;
  /** Format 2 only. Absence means excluded from export and preserved during restore. */
  cookingHistory?: PortableCookingHistory;
}

export interface PortableBackupCounts {
  favourites: number;
  tombstones: number;
  plannedMeals: number;
  selectedMeals: number;
  purchaseMarks: number;
  purchasedItems: number;
  preferences: number;
  preferenceRemovals: number;
  personal?: PortablePersonalCounts;
  cookingHistory?: number;
}

/** Shared by backup inspection and durable restore receipts; all values count stored records. */
export function validatePortableBackupCounts(value: unknown): value is PortableBackupCounts {
  if (
    !exact(value, [
      'favourites',
      'tombstones',
      'plannedMeals',
      'selectedMeals',
      'purchaseMarks',
      'purchasedItems',
      'preferences',
      'preferenceRemovals',
      ...(record(value) && Object.hasOwn(value, 'personal') ? ['personal'] : []),
      ...(record(value) && Object.hasOwn(value, 'cookingHistory') ? ['cookingHistory'] : []),
    ]) ||
    !Object.entries(value).every(([key, item]) =>
      key === 'personal' ? validatePortablePersonalCounts(item) : revision(item),
    ) ||
    (Object.hasOwn(value, 'cookingHistory') &&
      (!Object.hasOwn(value, 'personal') ||
        (value.cookingHistory as number) > portablePersonalLimits.history))
  )
    return false;
  const counts = value as unknown as PortableBackupCounts;
  return (
    counts.favourites + counts.tombstones <= portableBackupLimits.favourites &&
    counts.plannedMeals <= portableBackupLimits.occurrences &&
    counts.selectedMeals <=
      Math.min(counts.plannedMeals, portableBackupLimits.selectedOccurrences) &&
    counts.purchaseMarks <= portableBackupLimits.purchaseMarks &&
    counts.purchasedItems <= counts.purchaseMarks &&
    counts.preferences <= portableBackupLimits.preferences &&
    counts.preferenceRemovals <= portableBackupLimits.preferenceRemovals
  );
}

export interface PortableBackupInput {
  /** Default is format 1 for compatibility; format 2 requires physical schema 5 and personal data. */
  schemaVersion?: 1 | 2;
  /** Omitted by legacy callers: format 1 from the original schema 2. */
  databaseSchemaVersion?: 2 | 3 | 4 | 5 | 6;
  createdAt: string;
  catalogue: CatalogueIdentity;
  sourceRevision: number;
  data: PortableBackupData;
}

export interface PortableBackupEnvelope extends PortableBackupInput {
  format: typeof PORTABLE_BACKUP_FORMAT;
  schemaVersion: 1 | 2;
  databaseSchemaVersion: 2 | 3 | 4 | 5 | 6;
  counts: PortableBackupCounts;
  integrity: { algorithm: 'sha256'; digest: string };
}

export type PortableBackupHash = (text: string) => Promise<string>;
export type PortableBackupFailure =
  | 'too_large'
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_structure'
  | 'checksum_mismatch'
  | 'integrity_unavailable';

export class PortableBackupError extends Error {
  constructor(public readonly reason: PortableBackupFailure) {
    super(`Portable backup: ${reason}`);
    this.name = 'PortableBackupError';
  }
}

export interface PortableBackupPreview {
  counts: PortableBackupCounts;
  catalogueMatches: boolean;
  unknownRecipeIds: string[];
  /** Same-catalogue evidence only; historical content still requires the restore service's check. */
  referenceSummary: Immutable<PortableBackupReferenceSummary>;
  selectedDateRange: { first: string; last: string } | null;
  /** Inspection alone never authorizes replacement; the opt-in restore service requires review. */
  restoreAvailable: false;
  warnings: (
    | 'personal_data_plaintext'
    | 'checksum_is_not_authentication'
    | 'catalogue_mismatch'
    | 'unknown_recipes'
    | 'shopping_requires_reprojection'
    | 'restore_not_implemented'
  )[];
}

export type PortableBackupValidation =
  | {
      kind: 'ready';
      value: Immutable<PortableBackupEnvelope>;
      preview: Immutable<PortableBackupPreview>;
    }
  | { kind: 'invalid'; reason: PortableBackupFailure };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function recipeId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && isUtcInstant(value);
}

function boundedArray(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum;
}

function distinct<Value>(items: readonly Value[], identity: (item: Value) => string) {
  return new Set(items.map(identity)).size === items.length;
}

export function validatePortableBackupData(
  value: unknown,
  expanded: boolean,
): value is PortableBackupData {
  if (
    !exact(value, [
      'favourites',
      'occurrences',
      'shopping',
      'preferences',
      ...(expanded ? ['personal'] : []),
      ...(expanded && record(value) && Object.hasOwn(value, 'cookingHistory')
        ? ['cookingHistory']
        : []),
    ])
  )
    return false;
  if (
    expanded &&
    (!validatePortablePersonal(value.personal) ||
      (Object.hasOwn(value, 'cookingHistory') && !validatePortableHistory(value.cookingHistory)))
  )
    return false;
  if (
    !boundedArray(value.favourites, portableBackupLimits.favourites) ||
    !boundedArray(value.occurrences, portableBackupLimits.occurrences)
  )
    return false;
  if (
    !value.favourites.every(
      (item) =>
        exact(item, ['recipeId', 'saved', 'revision', 'savedAt', 'updatedAt']) &&
        recipeId(item.recipeId) &&
        typeof item.saved === 'boolean' &&
        revision(item.revision) &&
        instant(item.savedAt) &&
        instant(item.updatedAt),
    )
  )
    return false;
  const favourites = value.favourites as PortableFavourite[];
  if (!distinct(favourites, (item) => item.recipeId)) return false;
  if (
    !value.occurrences.every(
      (item) =>
        validatePlanOccurrence(item) &&
        isSupportedPlanDate(item.placement.actualDate) &&
        instant(item.createdAt) &&
        instant(item.updatedAt),
    )
  )
    return false;
  const occurrences = value.occurrences as PlanOccurrence[];
  if (
    !distinct(occurrences, (item) => item.occurrenceId) ||
    !distinct(occurrences, (item) => `${item.placement.actualDate}/${item.placement.mealKey}`)
  )
    return false;
  const shopping = value.shopping;
  if (
    !exact(shopping, ['scope', 'projectionRevision', 'projectionStatus', 'purchaseMarks']) ||
    !validateShoppingScope(shopping.scope) ||
    !revision(shopping.projectionRevision) ||
    !['current', 'pending'].includes(shopping.projectionStatus as string) ||
    !boundedArray(shopping.purchaseMarks, portableBackupLimits.purchaseMarks)
  )
    return false;
  const occurrenceIds = new Set(occurrences.map((item) => item.occurrenceId));
  if (!shopping.scope.occurrenceIds.every((id) => occurrenceIds.has(id))) return false;
  const projectionRevision = shopping.projectionRevision;
  if (
    !shopping.purchaseMarks.every(
      (item) =>
        exact(item, [
          'groupKey',
          'groupingVersion',
          'demandFingerprint',
          'projectionRevision',
          'purchased',
          'changed',
          'revision',
        ]) &&
        fingerprint(item.groupKey) &&
        fingerprint(item.demandFingerprint) &&
        text(item.groupingVersion, 80) &&
        revision(item.projectionRevision) &&
        item.projectionRevision <= projectionRevision &&
        typeof item.purchased === 'boolean' &&
        typeof item.changed === 'boolean' &&
        revision(item.revision) &&
        (item.projectionRevision === projectionRevision || (!item.purchased && item.changed)),
    )
  )
    return false;
  if (!distinct(shopping.purchaseMarks as PortablePurchaseMark[], (item) => item.groupKey))
    return false;
  const preferences = value.preferences;
  if (
    !exact(preferences, ['snapshot', 'removals']) ||
    !validatePreferenceSnapshot(preferences.snapshot) ||
    !boundedArray(preferences.removals, portableBackupLimits.preferenceRemovals)
  )
    return false;
  const snapshot = preferences.snapshot;
  if (
    (snapshot.lastRemovalRevision !== null && snapshot.lastRemovalRevision > snapshot.revision) ||
    snapshot.items.some((item) => item.revision > snapshot.revision) ||
    !distinct(snapshot.items, (item) => item.preferenceId) ||
    !distinct(snapshot.items, (item) => JSON.stringify([item.type, item.value]))
  )
    return false;
  if (
    !preferences.removals.every((item) => {
      if (
        !exact(item, ['preferenceId', 'type', 'value', 'savedRevision', 'removedRevision']) ||
        !revision(item.savedRevision) ||
        !revision(item.removedRevision) ||
        item.savedRevision >= item.removedRevision ||
        snapshot.lastRemovalRevision === null ||
        item.removedRevision > snapshot.lastRemovalRevision
      )
        return false;
      const removedRevision = item.removedRevision;
      // An edit withdraws the previous version and saves its replacement at the same revision.
      return (
        validatePreferenceSnapshot({
          revision: snapshot.revision,
          lastRemovalRevision: snapshot.lastRemovalRevision,
          items: [
            {
              preferenceId: item.preferenceId,
              type: item.type,
              value: item.value,
              revision: item.savedRevision,
            },
          ],
        }) &&
        !snapshot.items.some(
          (active) =>
            active.preferenceId === item.preferenceId && active.revision < removedRevision,
        )
      );
    })
  )
    return false;
  return distinct(preferences.removals as PortablePreferenceRemoval[], (item) =>
    JSON.stringify([item.preferenceId, item.savedRevision]),
  );
}

export function portableBackupCounts(data: Immutable<PortableBackupData>): PortableBackupCounts {
  return {
    favourites: data.favourites.filter((item) => item.saved).length,
    tombstones: data.favourites.filter((item) => !item.saved).length,
    plannedMeals: data.occurrences.length,
    selectedMeals: data.shopping.scope.occurrenceIds.length,
    purchaseMarks: data.shopping.purchaseMarks.length,
    purchasedItems: data.shopping.purchaseMarks.filter((item) => item.purchased).length,
    preferences: data.preferences.snapshot.items.length,
    preferenceRemovals: data.preferences.removals.length,
    ...(data.personal ? { personal: portablePersonalCounts(data.personal) } : {}),
    ...(data.cookingHistory ? { cookingHistory: data.cookingHistory.entries.length } : {}),
  };
}

function validEnvelope(value: unknown): value is PortableBackupEnvelope {
  if (
    !exact(value, [
      'format',
      'schemaVersion',
      'databaseSchemaVersion',
      'createdAt',
      'catalogue',
      'sourceRevision',
      'data',
      'counts',
      'integrity',
    ]) ||
    value.format !== PORTABLE_BACKUP_FORMAT ||
    ![PORTABLE_BACKUP_VERSION, PORTABLE_BACKUP_EXPANDED_VERSION].includes(
      value.schemaVersion as number,
    ) ||
    ![2, 3, 4, 5, 6].includes(value.databaseSchemaVersion as number) ||
    (value.schemaVersion === 2 && ![5, 6].includes(value.databaseSchemaVersion as number)) ||
    !instant(value.createdAt) ||
    !revision(value.sourceRevision) ||
    !exact(value.catalogue, ['version', 'fingerprint']) ||
    !text(value.catalogue.version, 80) ||
    !fingerprint(value.catalogue.fingerprint) ||
    !validatePortableBackupData(value.data, value.schemaVersion === 2) ||
    !exact(value.integrity, ['algorithm', 'digest']) ||
    value.integrity.algorithm !== 'sha256' ||
    !fingerprint(value.integrity.digest)
  )
    return false;
  const expected = portableBackupCounts(value.data);
  const counts = value.counts;
  return validatePortableBackupCounts(counts) && canonicalJson(expected) === canonicalJson(counts);
}

export function portableBackupByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function checksumInput(backup: PortableBackupEnvelope): string {
  const { integrity: _integrity, ...content } = backup;
  return canonicalJson(content);
}

function freeze<Value>(value: Value): Immutable<Value> {
  if (record(value) || Array.isArray(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}

/** Plain personal-data export. The digest detects corruption; it is not a signature or encryption. */
export async function createPortableBackup(
  input: Immutable<PortableBackupInput>,
  sha256: PortableBackupHash,
): Promise<Immutable<PortableBackupEnvelope>> {
  // Own the snapshot before hashing so concurrent UI/caller edits cannot alter checked bytes.
  const candidate: unknown = JSON.parse(
    JSON.stringify({
      ...input,
      format: PORTABLE_BACKUP_FORMAT,
      schemaVersion: input.schemaVersion ?? PORTABLE_BACKUP_VERSION,
      databaseSchemaVersion: input.databaseSchemaVersion ?? 2,
      counts: portableBackupCounts(input.data),
      integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
    }),
  );
  if (!validEnvelope(candidate)) throw new PortableBackupError('invalid_structure');
  const content = checksumInput(candidate);
  if (portableBackupByteLength(JSON.stringify(candidate)) > PORTABLE_BACKUP_MAX_BYTES)
    throw new PortableBackupError('too_large');
  let digest: string;
  try {
    digest = await sha256(content);
  } catch {
    throw new PortableBackupError('integrity_unavailable');
  }
  if (!fingerprint(digest)) throw new PortableBackupError('integrity_unavailable');
  candidate.integrity.digest = digest;
  return freeze(candidate);
}

export async function validatePortableBackup(
  serialized: string,
  options: {
    sha256: PortableBackupHash;
    currentCatalogue: Readonly<CatalogueIdentity>;
    knownRecipeIds: ReadonlySet<string>;
  },
): Promise<PortableBackupValidation> {
  if (
    serialized.length > PORTABLE_BACKUP_MAX_BYTES ||
    portableBackupByteLength(serialized) > PORTABLE_BACKUP_MAX_BYTES
  )
    return { kind: 'invalid', reason: 'too_large' };
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return { kind: 'invalid', reason: 'invalid_json' };
  }
  if (
    record(candidate) &&
    (![PORTABLE_BACKUP_VERSION, PORTABLE_BACKUP_EXPANDED_VERSION].includes(
      candidate.schemaVersion as number,
    ) ||
      ![2, 3, 4, 5, 6].includes(candidate.databaseSchemaVersion as number))
  )
    return { kind: 'invalid', reason: 'unsupported_version' };
  if (!validEnvelope(candidate)) return { kind: 'invalid', reason: 'invalid_structure' };
  let digest: string;
  try {
    digest = await options.sha256(checksumInput(candidate));
  } catch {
    return { kind: 'invalid', reason: 'integrity_unavailable' };
  }
  if (!fingerprint(digest)) return { kind: 'invalid', reason: 'integrity_unavailable' };
  if (digest !== candidate.integrity.digest)
    return { kind: 'invalid', reason: 'checksum_mismatch' };
  const known = options.knownRecipeIds;
  const referenced = new Set([
    ...candidate.data.favourites.map((item) => item.recipeId),
    ...candidate.data.occurrences.map((item) => item.recipeId),
    ...(candidate.data.personal?.notes.map((item) => item.recipeId) ?? []),
    ...(candidate.data.personal?.memberships.map((item) => item.recipeId) ?? []),
    ...(candidate.data.cookingHistory?.entries.map((item) => item.recipeId) ?? []),
  ]);
  const unknownRecipeIds = [...referenced].filter((id) => !known.has(id)).sort();
  const sameCatalogue = catalogueMatches(candidate.catalogue, options.currentCatalogue);
  const selected = new Set(candidate.data.shopping.scope.occurrenceIds);
  const dates = candidate.data.occurrences
    .filter((item) => selected.has(item.occurrenceId))
    .map((item) => item.placement.actualDate)
    .sort();
  const preview: PortableBackupPreview = {
    counts: { ...candidate.counts },
    catalogueMatches: sameCatalogue,
    unknownRecipeIds,
    referenceSummary: summarizePortableBackupReferences(candidate, options),
    selectedDateRange: dates.length ? { first: dates[0]!, last: dates[dates.length - 1]! } : null,
    restoreAvailable: false,
    warnings: [
      'personal_data_plaintext',
      'checksum_is_not_authentication',
      'restore_not_implemented',
    ],
  };
  if (!sameCatalogue) preview.warnings.push('catalogue_mismatch');
  if (unknownRecipeIds.length) preview.warnings.push('unknown_recipes');
  if (candidate.counts.selectedMeals || candidate.counts.purchaseMarks)
    preview.warnings.push('shopping_requires_reprojection');
  return { kind: 'ready', value: freeze(candidate), preview: freeze(preview) };
}
