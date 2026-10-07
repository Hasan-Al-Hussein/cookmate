import {
  canonicalContentJson,
  createBundledRecipeRevision,
  type OverlayEntry,
} from '@cookmate/catalogue/content';
import type {
  AdminLibraryItem,
  AdminLibraryPublicationStatus,
  AdminLibraryStatus,
} from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import type { PreparedPublicationArchive, LibraryPreparationSummary } from '../publishing/archive';
import type { ContentOverlayIssuer } from '../publishing/issuance';
import { requireAdmin } from '../auth/errors';
import { sha256 } from './repository';

const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left) === canonicalContentJson(right);
export interface LibraryLifecycle {
  revision: number;
  publicationStatus: AdminLibraryPublicationStatus;
  preparationByDraft: Map<string, LibraryPreparationSummary[]>;
  entryByRecipe: Map<string, OverlayEntry>;
  bundledMatches: Set<string>;
  assertCurrent(): void;
}

/** Bounded verified projection only; it cannot issue, activate or recover another actor's operation. */
export async function readLibraryLifecycle(options: {
  db: AdminDatabase;
  actor: Actor;
  now(): Date;
  archive: PreparedPublicationArchive;
  issuer: ContentOverlayIssuer | null;
}): Promise<LibraryLifecycle> {
  const { db, now, archive, issuer } = options;
  const actor: Actor = JSON.parse(canonicalContentJson(options.actor, 4096));
  db.assertActor(actor, now().getTime());
  const revision = db.get<{ library_revision: number }>(
    'SELECT library_revision FROM admin_meta WHERE id=1',
  )!.library_revision;
  const signed = issuer ? await issuer.libraryCurrent(actor) : null;
  db.assertActor(actor, now().getTime());
  const publicationStatus: AdminLibraryPublicationStatus = signed
    ? { status: 'ready', head: signed.head }
    : { status: 'not_configured' };
  const summaries = await archive.librarySummaries(actor);
  db.assertActor(actor, now().getTime());
  const preparationByDraft = new Map<string, LibraryPreparationSummary[]>();
  for (const summary of summaries) {
    const list = preparationByDraft.get(summary.draftId) ?? [];
    list.push(summary);
    preparationByDraft.set(summary.draftId, list);
  }
  const entryByRecipe = new Map<string, OverlayEntry>();
  const bundledMatches = new Set<string>();
  for (const entry of signed?.manifest?.entries ?? []) {
    const recipeId = entry.state === 'withdrawn' ? entry.recipeId : entry.ref.recipeId;
    entryByRecipe.set(recipeId, entry);
    if (entry.state !== 'withdrawn' && entry.publicationFingerprint === null) {
      const baseline = await createBundledRecipeRevision(recipeId, async (text) => sha256(text));
      db.assertActor(actor, now().getTime());
      requireAdmin(
        same(baseline.ref, entry.ref),
        500,
        'issued_integrity',
        'Retained release data failed verification.',
      );
      bundledMatches.add(recipeId);
    }
  }
  const assertCurrent = () => {
    db.assertActor(actor, now().getTime());
    requireAdmin(
      db.get<{ library_revision: number }>('SELECT library_revision FROM admin_meta WHERE id=1')!
        .library_revision === revision,
      409,
      'library_changed',
      'The library changed while reading publication status. Refresh the list.',
    );
    if (signed) issuer!.assertLibraryHead(actor, signed.head);
  };
  assertCurrent();
  return {
    revision,
    publicationStatus,
    preparationByDraft,
    entryByRecipe,
    bundledMatches,
    assertCurrent,
  };
}

export function libraryItemStatus(
  item: Omit<AdminLibraryItem, 'preparation' | 'publication'>,
  lifecycle: LibraryLifecycle,
): AdminLibraryItem {
  const packages = item.draftId ? (lifecycle.preparationByDraft.get(item.draftId) ?? []) : [];
  const currentPackages = packages.filter(
    (summary) => summary.draftRevision === item.revision && summary.ref.recipeId === item.recipeId,
  );
  const result: AdminLibraryItem = {
    ...item,
    preparation:
      currentPackages.length && item.revision !== null
        ? { draftRevision: item.revision, packageCount: currentPackages.length }
        : null,
    publication: null,
  };
  const entry = lifecycle.entryByRecipe.get(item.recipeId);
  const head =
    lifecycle.publicationStatus.status === 'ready' ? lifecycle.publicationStatus.head : null;
  if (!entry || !head) return result;
  if (entry.state === 'withdrawn') {
    result.publication = {
      state: 'withdrawn',
      releaseId: head.releaseId,
      ref: null,
      matchingDraftRevision: null,
    };
    return result;
  }
  const matched = packages.find(
    (summary) =>
      same(summary.ref, entry.ref) &&
      summary.publicationFingerprint === entry.publicationFingerprint,
  );
  if (matched || (item.draftId === null && lifecycle.bundledMatches.has(item.recipeId))) {
    result.publication = {
      state: entry.state,
      releaseId: head.releaseId,
      ref: { ...entry.ref },
      matchingDraftRevision: matched?.draftRevision ?? null,
    };
  }
  return result;
}
export function matchesLibraryStatus(item: AdminLibraryItem, status: AdminLibraryStatus): boolean {
  if (status === 'all') return true;
  if (status === 'prepared') return item.preparation !== null;
  if (status === 'published') return item.publication?.state === 'current';
  if (status === 'archived') return item.publication?.state === 'archived';
  return item.status === status;
}
