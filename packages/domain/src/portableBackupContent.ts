import {
  isActualLocalDate,
  isUtcInstant,
  validateRecipeContentRef,
  type CatalogueIdentity,
  type RecipeContentRef,
} from '@cookmate/contracts';
import { COOKING_NOTE_MAX_CHARACTERS, type CookingHistoryEntry } from './cooking';
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_MAX_BYTES,
  PortableBackupError,
  portableBackupByteLength,
  portableBackupCounts,
  validatePortableBackupCounts,
  validatePortableBackupData,
  type PortableBackupCounts,
  type PortableBackupData,
  type PortableBackupFailure,
  type PortableBackupHash,
} from './portableBackup';
import {
  portablePersonalLimits,
  validatePortableHistoryEntry,
  type PortablePersonalData,
} from './portableBackupExpanded';
import type { Immutable } from './search';

export const PORTABLE_CONTENT_BACKUP_VERSION = 3;
export interface PortableExactHistoryEntry {
  readerVersion: 2;
  recipeId: string;
  contentRef: RecipeContentRef;
  eventId: string;
  recipeTitle: string;
  photoAssetId: string | null;
  cookedOn: string;
  timeZone: string;
  recordedAt: string;
  note: string | null;
  historyEpoch: number;
  revision: number;
}
export type PortableLegacyPinReason =
  | 'catalogue_mismatch'
  | 'content_mismatch'
  | 'recipe_unavailable';
export type PortableContentHistoryRecord =
  | {
      kind: 'legacy';
      entry: CookingHistoryEntry;
      pin:
        | { kind: 'exact'; ref: RecipeContentRef }
        | { kind: 'unresolved'; reason: PortableLegacyPinReason };
    }
  | { kind: 'exact'; entry: PortableExactHistoryEntry };
export interface PortableContentBackupData extends Omit<
  PortableBackupData,
  'personal' | 'cookingHistory'
> {
  personal: PortablePersonalData;
  planReferences: { occurrenceId: string; contentRef: RecipeContentRef }[];
  cookingHistory?: { entries: PortableContentHistoryRecord[] };
}
export interface PortableContentBackupInput {
  schemaVersion: 3;
  /** Physical source version, preserved in canonical bytes; not a target migration request. */
  databaseSchemaVersion: 7 | 8;
  createdAt: string;
  catalogue: CatalogueIdentity;
  sourceRevision: number;
  data: PortableContentBackupData;
}
export interface PortableContentBackupEnvelope extends PortableContentBackupInput {
  format: typeof PORTABLE_BACKUP_FORMAT;
  counts: PortableBackupCounts;
  integrity: { algorithm: 'sha256'; digest: string };
}
export interface PortableContentBackupInspection {
  counts: PortableBackupCounts;
  /** Exact identity claims in the file, not authenticated or resolved recipe bodies. */
  exactReferences: RecipeContentRef[];
  unresolvedLegacy: { eventId: string; recipeId: string; reason: PortableLegacyPinReason }[];
  archiveVerification: 'not_performed';
  restoreAvailable: false;
  warnings: readonly [
    'personal_data_plaintext',
    'checksum_is_not_authentication',
    'exact_references_require_trusted_archive',
    'restore_not_implemented',
  ];
}
export type PortableContentBackupValidation =
  | {
      kind: 'ready';
      value: Immutable<PortableContentBackupEnvelope>;
      preview: Immutable<PortableContentBackupInspection>;
    }
  | { kind: 'invalid'; reason: PortableBackupFailure };

const MAX_NODES = 500_000,
  MAX_DEPTH = 32;
const inputKeys = [
  'schemaVersion',
  'databaseSchemaVersion',
  'createdAt',
  'catalogue',
  'sourceRevision',
  'data',
] as const;
function invalid(reason: PortableBackupFailure = 'invalid_structure'): never {
  throw new PortableBackupError(reason);
}
function requireData(condition: unknown): asserts condition {
  if (!condition) invalid();
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Bounded data-only ownership; no caller getter/toJSON executes and no async hash sees mutable input. */
export function canonicalPortableContentJson(
  value: unknown,
  maximumBytes = PORTABLE_BACKUP_MAX_BYTES,
): string {
  requireData(
    Number.isSafeInteger(maximumBytes) &&
      maximumBytes > 0 &&
      maximumBytes <= PORTABLE_BACKUP_MAX_BYTES,
  );
  const chunks: string[] = [],
    ancestors = new Set<object>();
  let bytes = 0,
    nodes = 0;
  function ascii(value: string) {
    if (bytes + value.length > maximumBytes) invalid('too_large');
    bytes += value.length;
    chunks.push(value);
  }
  function stringBytes(value: string, available: number) {
    if (value.length + 2 > available) invalid('too_large');
    let size = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size += 2;
      else if (code < 32) size += 6;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const following = value.charCodeAt(index + 1);
        if (following >= 0xdc00 && following <= 0xdfff) {
          size += 4;
          index++;
        } else size += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) size += 6;
      else size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      if (size > available) invalid('too_large');
    }
    return size;
  }
  function quoted(value: string) {
    const size = stringBytes(value, maximumBytes - bytes);
    chunks.push(JSON.stringify(value));
    bytes += size;
  }
  function encode(item: unknown, depth: number) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid('too_large');
    if (typeof item === 'string') {
      quoted(item);
      return;
    }
    if (item === null || typeof item === 'boolean') {
      ascii(String(item));
      return;
    }
    if (typeof item === 'number') {
      requireData(Number.isFinite(item) && !Object.is(item, -0));
      ascii(JSON.stringify(item));
      return;
    }
    requireData(typeof item === 'object' && item !== null && !ancestors.has(item));
    const array = Array.isArray(item),
      prototype: unknown = Object.getPrototypeOf(item);
    requireData(
      array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
    );
    ancestors.add(item);
    if (array) {
      if (
        item.length > MAX_NODES - nodes ||
        (item.length && item.length * 2 + 1 > maximumBytes - bytes)
      )
        invalid('too_large');
      requireData(
        Object.getOwnPropertySymbols(item).length === 0 &&
          Object.keys(item).length === item.length &&
          Object.getOwnPropertyNames(item).length === item.length + 1,
      );
      ascii('[');
      for (let index = 0; index < item.length; index++) {
        if (index) ascii(',');
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        requireData(descriptor?.enumerable && 'value' in descriptor);
        encode(descriptor.value, depth + 1);
      }
      ascii(']');
    } else {
      const keys: string[] = [];
      let minimumBytes = 2;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (keys.length >= MAX_NODES - nodes) invalid('too_large');
        minimumBytes +=
          stringBytes(key, maximumBytes - bytes - minimumBytes) + 2 + (keys.length ? 1 : 0);
        if (minimumBytes > maximumBytes - bytes) invalid('too_large');
        keys.push(key);
      }
      requireData(
        Object.getOwnPropertySymbols(item).length === 0 &&
          Object.getOwnPropertyNames(item).length === keys.length,
      );
      keys.sort();
      ascii('{');
      for (const [index, key] of keys.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        requireData(descriptor.enumerable && 'value' in descriptor);
        if (index) ascii(',');
        quoted(key);
        ascii(':');
        encode(descriptor.value, depth + 1);
      }
      ascii('}');
    }
    ancestors.delete(item);
  }
  encode(value, 0);
  return chunks.join('');
}
const canonical = canonicalPortableContentJson;
function freeze<Value>(value: Value): Immutable<Value> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}
function validExactHistory(value: unknown): value is PortableExactHistoryEntry {
  if (
    !exact(value, [
      'readerVersion',
      'recipeId',
      'contentRef',
      'eventId',
      'recipeTitle',
      'photoAssetId',
      'cookedOn',
      'timeZone',
      'recordedAt',
      'note',
      'historyEpoch',
      'revision',
    ]) ||
    value.readerVersion !== 2 ||
    !validateRecipeContentRef(value.contentRef) ||
    value.recipeId !== value.contentRef.recipeId ||
    !uuid(value.eventId) ||
    !text(value.recipeTitle, 1000) ||
    !(
      value.photoAssetId === null ||
      (typeof value.photoAssetId === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.photoAssetId))
    ) ||
    typeof value.cookedOn !== 'string' ||
    !isActualLocalDate(value.cookedOn) ||
    !text(value.timeZone, 100) ||
    typeof value.recordedAt !== 'string' ||
    !isUtcInstant(value.recordedAt) ||
    !(
      value.note === null ||
      (typeof value.note === 'string' && [...value.note].length <= COOKING_NOTE_MAX_CHARACTERS)
    ) ||
    !revision(value.historyEpoch) ||
    !revision(value.revision) ||
    value.revision === 0
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
    return true;
  } catch {
    return false;
  }
}
function validHistory(value: unknown): value is PortableContentHistoryRecord {
  if (exact(value, ['kind', 'entry']) && value.kind === 'exact')
    return validExactHistory(value.entry);
  if (
    !exact(value, ['kind', 'entry', 'pin']) ||
    value.kind !== 'legacy' ||
    !validatePortableHistoryEntry(value.entry)
  )
    return false;
  return (
    (exact(value.pin, ['kind', 'ref']) &&
      value.pin.kind === 'exact' &&
      validateRecipeContentRef(value.pin.ref) &&
      value.pin.ref.recipeId === value.entry.recipeId) ||
    (exact(value.pin, ['kind', 'reason']) &&
      value.pin.kind === 'unresolved' &&
      ['catalogue_mismatch', 'content_mismatch', 'recipe_unavailable'].includes(
        value.pin.reason as string,
      ))
  );
}
function coreData(data: PortableContentBackupData): PortableBackupData {
  const { planReferences: _references, cookingHistory: _history, ...core } = data;
  return core;
}
function validData(value: unknown): value is PortableContentBackupData {
  if (
    !value ||
    typeof value !== 'object' ||
    !exact(value, [
      'favourites',
      'occurrences',
      'shopping',
      'preferences',
      'personal',
      'planReferences',
      ...(Object.hasOwn(value, 'cookingHistory') ? ['cookingHistory'] : []),
    ])
  )
    return false;
  const { planReferences, cookingHistory, ...core } = value;
  if (
    !validatePortableBackupData(core, true) ||
    !Array.isArray(planReferences) ||
    planReferences.length !== core.occurrences.length
  )
    return false;
  const occurrences = new Map(core.occurrences.map((row) => [row.occurrenceId, row.recipeId])),
    seen = new Set<string>();
  for (const row of planReferences) {
    if (
      !exact(row, ['occurrenceId', 'contentRef']) ||
      !uuid(row.occurrenceId) ||
      seen.has(row.occurrenceId) ||
      !validateRecipeContentRef(row.contentRef) ||
      occurrences.get(row.occurrenceId) !== row.contentRef.recipeId
    )
      return false;
    seen.add(row.occurrenceId);
  }
  if (Object.hasOwn(value, 'cookingHistory')) {
    if (
      !exact(cookingHistory, ['entries']) ||
      !Array.isArray(cookingHistory.entries) ||
      cookingHistory.entries.length > portablePersonalLimits.history ||
      !cookingHistory.entries.every(validHistory)
    )
      return false;
    if (
      new Set(cookingHistory.entries.map((row) => row.entry.eventId)).size !==
      cookingHistory.entries.length
    )
      return false;
  }
  return true;
}
function validInput(value: unknown): value is PortableContentBackupInput {
  return (
    exact(value, inputKeys) &&
    value.schemaVersion === 3 &&
    (value.databaseSchemaVersion === 7 || value.databaseSchemaVersion === 8) &&
    typeof value.createdAt === 'string' &&
    isUtcInstant(value.createdAt) &&
    revision(value.sourceRevision) &&
    exact(value.catalogue, ['version', 'fingerprint']) &&
    text(value.catalogue.version, 80) &&
    hash(value.catalogue.fingerprint) &&
    validData(value.data)
  );
}
function counts(data: PortableContentBackupData): PortableBackupCounts {
  return {
    ...portableBackupCounts(coreData(data)),
    ...(data.cookingHistory ? { cookingHistory: data.cookingHistory.entries.length } : {}),
  };
}
function validEnvelope(value: unknown): value is PortableContentBackupEnvelope {
  if (!exact(value, [...inputKeys, 'format', 'counts', 'integrity'])) return false;
  const { format, counts: declared, integrity, ...input } = value;
  return (
    format === PORTABLE_BACKUP_FORMAT &&
    validInput(input) &&
    validatePortableBackupCounts(declared) &&
    canonical(declared) === canonical(counts(input.data)) &&
    exact(integrity, ['algorithm', 'digest']) &&
    integrity.algorithm === 'sha256' &&
    hash(integrity.digest)
  );
}
function checksumInput(value: PortableContentBackupEnvelope) {
  const { integrity: _integrity, ...content } = value;
  return canonical(content);
}
async function digest(content: string, sha256: PortableBackupHash) {
  let value: unknown;
  try {
    value = await sha256(content);
  } catch {
    invalid('integrity_unavailable');
  }
  if (!hash(value)) invalid('integrity_unavailable');
  return value;
}

/** Plain data only. A checksum proves neither authenticity nor availability of referenced archives. */
export async function createPortableContentBackup(
  input: Immutable<PortableContentBackupInput>,
  sha256: PortableBackupHash,
): Promise<Immutable<PortableContentBackupEnvelope>> {
  const owned: unknown = JSON.parse(canonical(input));
  if (!validInput(owned)) invalid();
  const envelope: PortableContentBackupEnvelope = {
    ...owned,
    format: PORTABLE_BACKUP_FORMAT,
    counts: counts(owned.data),
    integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
  };
  canonical(envelope); // Include checksum/count overhead in the whole-file bound before hashing.
  envelope.integrity.digest = await digest(checksumInput(envelope), sha256);
  return freeze(envelope);
}
function inspection(value: PortableContentBackupEnvelope): PortableContentBackupInspection {
  const references = new Map<string, RecipeContentRef>(),
    unresolvedLegacy: PortableContentBackupInspection['unresolvedLegacy'] = [];
  function add(ref: RecipeContentRef) {
    references.set(canonical(ref), { ...ref });
  }
  for (const row of value.data.planReferences) add(row.contentRef);
  for (const row of value.data.cookingHistory?.entries ?? []) {
    if (row.kind === 'exact') add(row.entry.contentRef);
    else if (row.pin.kind === 'exact') add(row.pin.ref);
    else
      unresolvedLegacy.push({
        eventId: row.entry.eventId,
        recipeId: row.entry.recipeId,
        reason: row.pin.reason,
      });
  }
  return {
    counts: value.counts,
    exactReferences: [...references.values()],
    unresolvedLegacy,
    archiveVerification: 'not_performed',
    restoreAvailable: false,
    warnings: [
      'personal_data_plaintext',
      'checksum_is_not_authentication',
      'exact_references_require_trusted_archive',
      'restore_not_implemented',
    ],
  };
}
export async function validatePortableContentBackup(
  serialized: string,
  options: { sha256: PortableBackupHash },
): Promise<PortableContentBackupValidation> {
  try {
    if (typeof serialized !== 'string') invalid('invalid_json');
    if (
      serialized.length > PORTABLE_BACKUP_MAX_BYTES ||
      portableBackupByteLength(serialized) > PORTABLE_BACKUP_MAX_BYTES
    )
      invalid('too_large');
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      invalid('invalid_json');
    }
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (('schemaVersion' in value && value.schemaVersion !== 3) ||
        ('databaseSchemaVersion' in value &&
          value.databaseSchemaVersion !== 7 &&
          value.databaseSchemaVersion !== 8))
    )
      invalid('unsupported_version');
    canonical(value); // Depth/node/escaped-byte admission precedes recursive validators and hashing.
    if (!validEnvelope(value)) invalid();
    if ((await digest(checksumInput(value), options.sha256)) !== value.integrity.digest)
      invalid('checksum_mismatch');
    return { kind: 'ready', value: freeze(value), preview: freeze(inspection(value)) };
  } catch (error) {
    return {
      kind: 'invalid',
      reason: error instanceof PortableBackupError ? error.reason : 'invalid_structure',
    };
  }
}
