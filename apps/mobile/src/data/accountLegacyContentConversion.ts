import { catalogue } from '@cookmate/catalogue';
import { createBundledRecipeRevision } from '@cookmate/catalogue/content';
import { catalogueMatches, type RecipeContentRef } from '@cookmate/contracts';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  AccountReplicationError,
  AccountSnapshotError,
  canonicalAccountSnapshot,
  normalizeAccountSnapshot,
  type AccountSnapshotV2,
} from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import {
  canonicalAccountContentSnapshot,
  normalizeAccountContentSnapshot,
  type AccountContentCookingHistory,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import { assertAccountSnapshot } from '../../../../packages/account-sync/src/validation';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import { createLegacyCookingPinProof } from './cookingContentRepository';
import { freezeResult } from './query';

export interface BundledLegacyAccountConversion {
  /** Prior data coverage; empty v1 personal arrays do not establish prior personal sync. */
  sourceVersion: 1 | 2;
  /** Canonical original wire snapshot digest, not a raw journal digest. */
  sourceDigest: string;
  snapshot: AccountContentSnapshot;
  /** Derived local format3 digest; never substitute this for a legacy remote observation. */
  convertedDigest: string;
  unresolvedHistoryEventIds: string[];
}

function ownSource(input: unknown) {
  let value: unknown;
  try {
    value = JSON.parse(canonicalPortableContentJson(input, ACCOUNT_SNAPSHOT_MAX_BYTES));
  } catch (error) {
    throw new AccountSnapshotError(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_structure',
    );
  }
  assertAccountSnapshot(value);
  return normalizeAccountSnapshot(value);
}

/**
 * Private data conversion using the installed original catalogue, never a caller-nominated
 * current revision. This grants no publication, restore, account scope or mutation authority.
 * A host needing lifetime/owner admission must provide its guarded hash port.
 */
export async function convertBundledLegacyAccountSnapshot(
  input: unknown,
  sha256: (text: string) => Promise<string>,
): Promise<Immutable<BundledLegacyAccountConversion>> {
  const hash = sha256;
  if (typeof hash !== 'function') throw new AccountReplicationError('invalid_input');
  // Own all source data and canonical evidence before the first asynchronous port call.
  const source = ownSource(input);
  const sourceVersion = source.schemaVersion;
  const sourceJson = canonicalAccountSnapshot(source);
  if (!catalogueMatches(source.catalogue, catalogue.identity))
    throw new AccountReplicationError('catalogue_mismatch');
  for (const occurrence of source.plan) {
    if (!catalogue.getRecipe(occurrence.recipeId))
      throw new AccountReplicationError('unknown_recipe');
  }
  const digest = async (serialized: string) => {
    const result = await hash(serialized);
    if (typeof result !== 'string' || !/^[0-9a-f]{64}$/.test(result))
      throw new AccountReplicationError('invalid_input');
    return result;
  };
  const sourceDigest = await digest(sourceJson);
  const refs = new Map<string, Immutable<RecipeContentRef>>();
  const planReferences: AccountContentSnapshot['planReferences'] = [];
  for (const occurrence of source.plan) {
    let contentRef = refs.get(occurrence.recipeId);
    if (!contentRef) {
      contentRef = (await createBundledRecipeRevision(occurrence.recipeId, digest)).ref;
      refs.set(occurrence.recipeId, contentRef);
    }
    planReferences.push({ occurrenceId: occurrence.occurrenceId, contentRef: { ...contentRef } });
  }
  const expanded: AccountSnapshotV2 =
    source.schemaVersion === 2
      ? source
      : {
          ...source,
          schemaVersion: 2,
          personal: { notes: [], collections: [], memberships: [], manualItems: [] },
        };
  const { schemaVersion: _sourceVersion, cookingHistory: legacyHistory, ...core } = expanded;
  const unresolvedHistoryEventIds: string[] = [];
  let cookingHistory: AccountContentCookingHistory | undefined;
  if (legacyHistory !== undefined) {
    const prove = createLegacyCookingPinProof(digest);
    const entries: AccountContentCookingHistory['entries'] = [];
    for (const entry of legacyHistory.entries) {
      const pin = await prove(entry);
      if (pin.kind === 'unresolved') unresolvedHistoryEventIds.push(entry.eventId);
      entries.push({ kind: 'legacy', entry, pin });
    }
    cookingHistory = { entries, removedEventIds: legacyHistory.removedEventIds };
  }
  const snapshot = normalizeAccountContentSnapshot({
    ...core,
    schemaVersion: 3,
    planReferences,
    ...(cookingHistory === undefined ? {} : { cookingHistory }),
  });
  const convertedDigest = await digest(canonicalAccountContentSnapshot(snapshot));
  return freezeResult({
    sourceVersion,
    sourceDigest,
    snapshot,
    convertedDigest,
    unresolvedHistoryEventIds,
  });
}
