import {
  canonicalContentJson,
  validateOverlayHead,
  validateRecipeContentRef,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { AdminLibraryItem, AdminLibraryPublicationStatus } from '../src/contracts';

/** A library observation only. Issuance rechecks this exact signed head and published ref. */
export interface ArchiveSelection {
  readonly title: string;
  readonly ref: Readonly<RecipeContentRef>;
  readonly head: Readonly<OverlayHead>;
  readonly matchingDraftRevision: number | null;
  readonly latestDraftRevision: number | null;
}
export function ownArchiveSelection(input: ArchiveSelection): ArchiveSelection {
  const value: unknown = JSON.parse(canonicalContentJson(input, 8192));
  const revision = (candidate: unknown): candidate is number | null =>
    candidate === null ||
    (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    value.title.length > 1000 ||
    !('ref' in value) ||
    !validateRecipeContentRef(value.ref) ||
    !('head' in value) ||
    !validateOverlayHead(value.head) ||
    !('matchingDraftRevision' in value) ||
    !revision(value.matchingDraftRevision) ||
    !('latestDraftRevision' in value) ||
    !revision(value.latestDraftRevision)
  )
    throw new Error('The selected published version is invalid. Refresh the recipe library.');
  return Object.freeze({
    title: value.title,
    ref: Object.freeze({ ...value.ref }),
    head: Object.freeze({ ...value.head }),
    matchingDraftRevision: value.matchingDraftRevision,
    latestDraftRevision: value.latestDraftRevision,
  });
}
export function archiveSelection(
  item: AdminLibraryItem,
  publication: AdminLibraryPublicationStatus,
): ArchiveSelection | null {
  if (
    publication.status !== 'ready' ||
    !publication.head ||
    item.publication?.state !== 'current' ||
    !item.publication.ref ||
    item.publication.releaseId !== publication.head.releaseId ||
    item.publication.ref.recipeId !== item.recipeId
  )
    return null;
  return ownArchiveSelection({
    title: item.title,
    ref: item.publication.ref,
    head: publication.head,
    matchingDraftRevision: item.publication.matchingDraftRevision,
    latestDraftRevision: item.revision,
  });
}
