import { catalogueMatches } from '@cookmate/contracts';
import type { CatalogueIdentity } from '@cookmate/contracts';
import type { PortableBackupEnvelope } from './portableBackup';
import type { Immutable } from './search';

export type PortableBackupReferenceReason =
  | 'recipe_unavailable'
  | 'catalogue_mismatch'
  | 'history_content_unverified'
  | 'history_content_mismatch';
export type PortableHistoryContentVerification = 'verified' | 'mismatch';
export interface PortableBackupReferenceSummary {
  schemaVersion: 1;
  /** Categories count unique IDs; an ID is exact only when all of its references are verified. */
  totalRecipeIds: number;
  knownExactRecipeIds: string[];
  /** No trusted historical-content resolver is connected to portable inspection yet. */
  trustedArchivedRecipeIds: [];
  archiveResolution: 'unavailable';
  unresolved: { recipeId: string; reasons: PortableBackupReferenceReason[] }[];
  historyEntries: number;
  historyContentVerification: 'not_checked' | PortableHistoryContentVerification;
  restoreAuthorized: false;
}

/** Read-only classification of an already structurally/integrity-validated backup.
 * A history attestation may be supplied only by the restore service's actual content check.
 * It describes that whole check: a mismatch does not identify which particular entry failed.
 * Matching an ID or title alone never supplies historical-content or archive evidence.
 */
export function summarizePortableBackupReferences(
  source: Immutable<PortableBackupEnvelope>,
  options: {
    currentCatalogue: Readonly<CatalogueIdentity>;
    knownRecipeIds: ReadonlySet<string>;
    historyContentVerification?: PortableHistoryContentVerification;
  },
): Immutable<PortableBackupReferenceSummary> {
  const references = new Map<string, Set<PortableBackupReferenceReason>>();
  const sameCatalogue = catalogueMatches(source.catalogue, options.currentCatalogue);
  const add = (recipeId: string) => {
    let reasons = references.get(recipeId);
    if (!reasons) {
      reasons = new Set();
      references.set(recipeId, reasons);
    }
    if (!options.knownRecipeIds.has(recipeId)) reasons.add('recipe_unavailable');
    if (!sameCatalogue) reasons.add('catalogue_mismatch');
    return reasons;
  };
  for (const row of source.data.favourites) add(row.recipeId);
  for (const row of source.data.occurrences) add(row.recipeId);
  for (const row of source.data.personal?.notes ?? []) add(row.recipeId);
  for (const row of source.data.personal?.memberships ?? []) add(row.recipeId);
  for (const row of source.data.cookingHistory?.entries ?? []) {
    const reasons = add(row.recipeId);
    if (!catalogueMatches(row.catalogue, options.currentCatalogue))
      reasons.add('catalogue_mismatch');
    if (options.historyContentVerification !== 'verified')
      reasons.add(
        options.historyContentVerification === 'mismatch'
          ? 'history_content_mismatch'
          : 'history_content_unverified',
      );
  }
  const knownExactRecipeIds: string[] = [];
  const unresolved: Immutable<PortableBackupReferenceSummary['unresolved'][number]>[] = [];
  for (const recipeId of [...references.keys()].sort()) {
    const reasons = references.get(recipeId)!;
    if (reasons.size === 0) knownExactRecipeIds.push(recipeId);
    else unresolved.push(Object.freeze({ recipeId, reasons: Object.freeze([...reasons].sort()) }));
  }
  return Object.freeze({
    schemaVersion: 1,
    totalRecipeIds: references.size,
    knownExactRecipeIds: Object.freeze(knownExactRecipeIds),
    trustedArchivedRecipeIds: Object.freeze([] as []),
    archiveResolution: 'unavailable',
    unresolved: Object.freeze(unresolved),
    historyEntries: source.data.cookingHistory?.entries.length ?? 0,
    historyContentVerification: options.historyContentVerification ?? 'not_checked',
    restoreAuthorized: false,
  });
}
