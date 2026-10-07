import { catalogueMatches, type SavedPreference } from '@cookmate/contracts';
import type { AccountFavourite, AccountPreference } from '@cookmate/account-sync';
import {
  validatePortableBackupData,
  type Immutable,
  type PortableFavourite,
  type PortablePreferenceRemoval,
} from '@cookmate/domain';
import {
  canonicalAccountContentSnapshot,
  normalizeAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import {
  canonicalPortableContentJson,
  type PortableContentBackupEnvelope,
} from '../../../../packages/domain/src/portableBackupContent';
import { exact, fail, revision } from './accountReplicationRecords';
import { freezeResult } from './query';

export type AccountContentRemovalReason =
  | 'exactFavouriteRemoval'
  | 'exactPreferenceRemoval'
  | 'unidentifiedPreferenceRemoval'
  | 'retainedRestoreArchive';
export type AccountContentRemovalDecision = 'keep_local' | 'save_account_version';
export type AccountContentRemovalChoices = Readonly<Record<string, AccountContentRemovalDecision>>;
export type AccountContentRemovalConflict =
  | {
      id: string;
      kind: 'favourite';
      incoming: AccountFavourite;
      current: { kind: 'removed'; row: PortableFavourite };
      reasons: ['exactFavouriteRemoval'];
    }
  | {
      id: string;
      kind: 'preference';
      incoming: AccountPreference;
      current: { kind: 'live'; row: SavedPreference } | { kind: 'absent' };
      /** Exact matching known facts only; missing identity/text is never inferred from an archive. */
      removals: PortablePreferenceRemoval[];
      lastRemovalRevision: number | null;
      reasons: Exclude<AccountContentRemovalReason, 'exactFavouriteRemoval'>[];
    };
export interface AccountContentRemovalReview {
  conflicts: AccountContentRemovalConflict[];
}
export interface AccountContentRemovalResolution {
  snapshot: AccountContentSnapshot;
  choices: AccountContentRemovalChoices;
}
interface Evidence {
  candidate: Immutable<AccountContentSnapshot>;
  favourites: PortableFavourite[];
  preferences: PortableContentBackupEnvelope['data']['preferences'];
  text: string;
}
interface ReviewAuthority {
  evidence: Evidence;
  review: Immutable<AccountContentRemovalReview>;
}
interface ResolutionAuthority extends ReviewAuthority {
  choices: AccountContentRemovalChoices;
}
const reviews = new WeakMap<object, ReviewAuthority>();
const resolutions = new WeakMap<object, ResolutionAuthority>();
const decisionsBytes = 1024 * 1024;

function ownData<Value>(value: unknown, maximum?: number): Value {
  try {
    return JSON.parse(canonicalPortableContentJson(value, maximum)) as Value;
  } catch (error) {
    fail(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
}
function ownCandidate(value: unknown) {
  try {
    return normalizeAccountContentSnapshot(value);
  } catch (error) {
    fail(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
}
function evidence(
  candidateInput: unknown,
  beforeInput: Immutable<PortableContentBackupEnvelope>,
  archivePresent: boolean,
): Evidence {
  if (typeof archivePresent !== 'boolean') fail('invalid_input');
  const candidate = ownCandidate(candidateInput);
  // The host already validated this envelope/checksum. Own it without executing input code;
  // reuse core validators for relevant local facts, without claiming synchronous hash proof.
  const before = ownData<PortableContentBackupEnvelope>(beforeInput);
  if (
    !before ||
    before.schemaVersion !== 3 ||
    (before.databaseSchemaVersion !== 7 && before.databaseSchemaVersion !== 8) ||
    !revision(before.sourceRevision) ||
    !before.data ||
    !exact(before.catalogue, ['version', 'fingerprint']) ||
    !catalogueMatches(candidate.catalogue, before.catalogue)
  )
    fail('invalid_input');
  const { planReferences: _refs, cookingHistory: _history, ...core } = before.data;
  if (!validatePortableBackupData(core, true)) fail('invalid_input');
  const favourites = [...core.favourites].sort((a, b) =>
    a.recipeId < b.recipeId ? -1 : a.recipeId > b.recipeId ? 1 : 0,
  );
  const preferences = {
    snapshot: {
      ...core.preferences.snapshot,
      items: [...core.preferences.snapshot.items].sort((a, b) =>
        a.preferenceId < b.preferenceId ? -1 : a.preferenceId > b.preferenceId ? 1 : 0,
      ),
    },
    removals: [...core.preferences.removals].sort((a, b) =>
      a.preferenceId < b.preferenceId
        ? -1
        : a.preferenceId > b.preferenceId
          ? 1
          : a.savedRevision - b.savedRevision,
    ),
  };
  return {
    candidate,
    favourites,
    preferences,
    text: canonicalPortableContentJson({
      catalogue: before.catalogue,
      databaseSchemaVersion: before.databaseSchemaVersion,
      sourceRevision: before.sourceRevision,
      favourites,
      preferences,
      archivePresent,
    }),
  };
}
function conflicts(value: Evidence, archivePresent: boolean): AccountContentRemovalConflict[] {
  const result: AccountContentRemovalConflict[] = [];
  const favouriteRows = new Map(value.favourites.map((row) => [row.recipeId, row]));
  for (const incoming of value.candidate.favourites) {
    const current = favouriteRows.get(incoming.recipeId);
    if (current && !current.saved)
      result.push({
        id: `favourite:${incoming.recipeId}`,
        kind: 'favourite',
        incoming: { ...incoming },
        current: { kind: 'removed', row: { ...current } },
        reasons: ['exactFavouriteRemoval'],
      });
  }
  const currentRows = new Map(
    value.preferences.snapshot.items.map((row) => [row.preferenceId, row]),
  );
  const lastRemovalRevision = value.preferences.snapshot.lastRemovalRevision;
  for (const incoming of value.candidate.preferences) {
    const current = currentRows.get(incoming.preferenceId);
    if (current && current.type === incoming.type && current.value === incoming.value) continue;
    const removals = value.preferences.removals.filter(
      (row) =>
        row.preferenceId === incoming.preferenceId ||
        (row.type === incoming.type && row.value === incoming.value),
    );
    const reasons: Exclude<AccountContentRemovalReason, 'exactFavouriteRemoval'>[] = [];
    if (removals.length) reasons.push('exactPreferenceRemoval');
    if (lastRemovalRevision !== null && !removals.length)
      reasons.push('unidentifiedPreferenceRemoval');
    if (archivePresent) reasons.push('retainedRestoreArchive');
    if (reasons.length)
      result.push({
        id: `preference:${incoming.preferenceId}`,
        kind: 'preference',
        incoming: { ...incoming },
        current: current ? { kind: 'live', row: { ...current } } : { kind: 'absent' },
        removals: removals.map((row) => ({ ...row })),
        lastRemovalRevision,
        reasons,
      });
  }
  return result;
}

/** Synchronous issued local review only. The calling host supplies current validated evidence. */
export function createAccountContentRemovalReview(
  candidate: Immutable<AccountContentSnapshot>,
  before: Immutable<PortableContentBackupEnvelope>,
  hasRestoreArchive: boolean,
): Immutable<AccountContentRemovalReview> {
  const owned = evidence(candidate, before, hasRestoreArchive);
  const review = freezeResult({ conflicts: conflicts(owned, hasRestoreArchive) });
  reviews.set(review, { evidence: owned, review });
  return review;
}
function ownChoices(
  input: AccountContentRemovalChoices,
  review: Immutable<AccountContentRemovalReview>,
): AccountContentRemovalChoices {
  const value: unknown = ownData(input, decisionsBytes);
  if (
    !exact(
      value,
      review.conflicts.map((row) => row.id),
    ) ||
    Object.values(value).some(
      (choice) => choice !== 'keep_local' && choice !== 'save_account_version',
    )
  )
    fail('invalid_input');
  return freezeResult(value as AccountContentRemovalChoices);
}
function adjusted(authority: ReviewAuthority, decisions: AccountContentRemovalChoices) {
  const value = ownData<AccountContentSnapshot>(authority.evidence.candidate);
  const omitFavourites = new Set<string>();
  const replacePreferences = new Map<string, AccountPreference | null>();
  for (const conflict of authority.review.conflicts) {
    if (decisions[conflict.id] !== 'keep_local') continue;
    if (conflict.kind === 'favourite') {
      omitFavourites.add(conflict.incoming.recipeId);
    } else {
      if (conflict.current.kind === 'live') {
        const { preferenceId, type, value: text } = conflict.current.row;
        replacePreferences.set(preferenceId, { preferenceId, type, value: text });
      } else replacePreferences.set(conflict.incoming.preferenceId, null);
    }
  }
  value.favourites = value.favourites.filter((row) => !omitFavourites.has(row.recipeId));
  value.preferences = value.preferences.flatMap((row) => {
    if (!replacePreferences.has(row.preferenceId)) return [row];
    const previous = replacePreferences.get(row.preferenceId);
    return previous ? [previous] : [];
  });
  // A kept local version may collide with another incoming preference value. Reject the
  // combination so it can be reviewed; never silently remove or merge somebody else's row.
  return ownCandidate(value);
}
export function resolveAccountContentRemovalReview(
  review: Immutable<AccountContentRemovalReview>,
  decisions: AccountContentRemovalChoices,
): Immutable<AccountContentRemovalResolution> {
  const authority = review && typeof review === 'object' ? reviews.get(review) : undefined;
  if (!authority) fail('invalid_input');
  const choices = ownChoices(decisions, review),
    snapshot = adjusted(authority, choices);
  const result = freezeResult({ snapshot, choices });
  resolutions.set(result, { ...authority, choices });
  return result;
}

/** actualCandidate is the adjusted output about to be used, never a new caller proposal. */
export function assertAccountContentRemovalResolution(
  resolution: Immutable<AccountContentRemovalResolution>,
  actualCandidate: Immutable<AccountContentSnapshot>,
  before: Immutable<PortableContentBackupEnvelope>,
  hasRestoreArchive: boolean,
): void {
  const authority =
    resolution && typeof resolution === 'object' ? resolutions.get(resolution) : undefined;
  if (!authority) fail('invalid_input');
  const current = evidence(authority.evidence.candidate, before, hasRestoreArchive);
  if (current.text !== authority.evidence.text) fail('local_changed');
  // The complete ordered evidence and owned candidate determine these conflicts. Reuse the
  // issued immutable review: expanding repeated removal rows again could exceed the envelope
  // limit even though the original valid evidence fits within it.
  const output = adjusted(authority, authority.choices);
  if (
    canonicalAccountContentSnapshot(ownCandidate(actualCandidate)) !==
      canonicalAccountContentSnapshot(output) ||
    canonicalAccountContentSnapshot(resolution.snapshot) !== canonicalAccountContentSnapshot(output)
  )
    fail('operation_changed');
}
