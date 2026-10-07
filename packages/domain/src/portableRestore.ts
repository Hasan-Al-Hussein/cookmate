import type { ContractError } from '@cookmate/contracts';
import type { Immutable } from './search';
import type { RepositoryResult } from './services';
import type { PortableBackupCounts, PortableBackupEnvelope } from './portableBackup';
import type { PortableBackupReferenceSummary } from './portableBackupReferences';
import type { ProjectedShoppingGroup } from './shoppingProjection';

/** Archives are never silently evicted. A full journal blocks another replacement. */
export const PORTABLE_RESTORE_ARCHIVE_LIMIT = 20;
export type PortableRestoreBlocker =
  | 'catalogue_mismatch'
  | 'unknown_recipes'
  | 'active_actions'
  | 'expanded_storage_unavailable'
  | 'history_content_mismatch'
  | 'personal_removal_conflict'
  | 'history_removal_conflict'
  | 'archive_full';
export interface PortableRestorePurchaseSummary {
  restoredChecks: number;
  uncheckedImportedChecks: number;
}
export interface PortableRestoreReview {
  reviewId: string;
  importFingerprint: string;
  expectedRevision: number;
  before: PortableBackupCounts;
  after: PortableBackupCounts;
  blockers: PortableRestoreBlocker[];
  unknownRecipeIds: string[];
  /** Informational evidence only; exact issued review and blockers still control restore. */
  referenceSummary?: Immutable<PortableBackupReferenceSummary>;
  shopping: PortableRestorePurchaseSummary | null;
  warnings: readonly string[];
  /** Absent on older reviews: only the core format-1 scope is replaced. */
  replacedScopes?: readonly ('core' | 'personal' | 'cookingHistory')[];
}
export interface PreparedPortableRestore {
  operationId: string;
  importFingerprint: string;
  expectedRevision: number;
}
export interface PortableRestoreReceipt extends PreparedPortableRestore {
  kind: 'portable_restore';
  committedAt: string;
  revision: number;
  beforeFingerprint: string;
  shopping: PortableRestorePurchaseSummary;
  importedPreferenceRemovals: number;
  /** Actual committed records; retained local provenance and dormant shopping marks may differ from input. */
  restoredCounts: PortableBackupCounts;
  /** Only format-2 restores; imported history gets fresh local IDs, never receipt authority. */
  replacedScopes?: readonly ('core' | 'personal' | 'cookingHistory')[];
}
export type PortableRestoreResult =
  | { kind: 'receipt'; receipt: Immutable<PortableRestoreReceipt> }
  | { kind: 'failed'; error: ContractError }
  | { kind: 'uncertain'; operationId: string; error: ContractError };

/** Local, explicit user approval only. No provider proposal can call this service. */
export interface PortableRestoreService {
  review(serialized: string): Promise<RepositoryResult<Immutable<PortableRestoreReview>>>;
  /** Retain the exact issued review; editing/cloning a capability does not authorize a restore. */
  prepare(
    review: Immutable<PortableRestoreReview>,
  ): Promise<RepositoryResult<Immutable<PreparedPortableRestore>>>;
  execute(prepared: Immutable<PreparedPortableRestore>): Promise<PortableRestoreResult>;
  readReceipt(
    operationId: string,
  ): Promise<RepositoryResult<Immutable<PortableRestoreReceipt> | null>>;
  /** Exact retained input/before-state, including detached withdrawal facts. No execution authority. */
  readArchive(
    operationId: string,
    archive: 'before' | 'imported',
  ): Promise<RepositoryResult<string | null>>;
}

export const portableRestoreWarnings = Object.freeze([
  'replaces_backed_up_cooking_data',
  'automatic_before_snapshot_is_cooking_data_only',
  'messages_drafts_settings_credentials_and_receipts_stay_local',
  'imported_preference_removals_retained_in_original_archive_only',
  'portable_exports_exclude_restore_archives_download_archives_separately',
  'archives_retained_locally_without_automatic_deletion',
  'personal_data_plaintext',
]);

/** Normalize the two physical DB versions to the unchanged, validated format-1 data grammar. */
export function normalizePortableRestoreSource(source: Immutable<PortableBackupEnvelope>) {
  return Object.freeze({
    sourceDatabaseVersion: source.databaseSchemaVersion,
    fingerprint: source.integrity.digest,
    data: source.data,
  });
}

/** A checksum proves byte integrity, not that a remembered purchase still matches current demand. */
export function reconcilePortableRestorePurchases(
  source: {
    readonly data: { readonly shopping: Immutable<PortableBackupEnvelope['data']['shopping']> };
  },
  projection: readonly Immutable<ProjectedShoppingGroup>[],
) {
  const imported = new Map(source.data.shopping.purchaseMarks.map((mark) => [mark.groupKey, mark]));
  let restoredChecks = 0;
  const states = projection.map((group) => {
    const mark = imported.get(group.groupKey);
    const matches =
      mark !== undefined &&
      source.data.shopping.projectionStatus === 'current' &&
      mark.projectionRevision === source.data.shopping.projectionRevision &&
      mark.groupingVersion === group.groupingVersion &&
      mark.demandFingerprint === group.demandFingerprint;
    const purchased = matches && mark!.purchased;
    if (purchased) restoredChecks++;
    return {
      groupKey: group.groupKey,
      purchased,
      changed: mark ? !matches || mark.changed : false,
    };
  });
  return {
    states,
    summary: {
      restoredChecks,
      uncheckedImportedChecks:
        source.data.shopping.purchaseMarks.filter((mark) => mark.purchased).length - restoredChecks,
    },
  };
}
