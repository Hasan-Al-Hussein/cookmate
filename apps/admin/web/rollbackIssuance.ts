import {
  canonicalContentJson,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  fingerprintContentOverlay,
  validateContentOverlayManifest,
  validateOverlayHead,
  type ContentHash,
  type OverlayEntry,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import { CONTENT_SIGNATURE_SCHEME } from '@cookmate/catalogue/content-trust';
import type {
  AdminLibraryItem,
  AdminLibraryPublicationStatus,
  AdminPublicationReleaseState,
} from '../src/contracts';
import { ownArchiveSelection, type ArchiveSelection } from './archiveSelection';
import {
  issuanceHash,
  sameIssuanceValue,
  validateIssuanceRequest,
  verifiedReleaseState,
} from './issuanceProposal';

/** An observed published identity; this is never a preparation or current draft approval. */
export type RollbackSelection = ArchiveSelection;
type PublishedEntry = Exclude<OverlayEntry, { state: 'withdrawn' }>;
export interface IssuedRollbackChoice {
  readonly selection: RollbackSelection;
  readonly sourceHead: Readonly<OverlayHead>;
  readonly entry: Readonly<PublishedEntry>;
}
export interface IssuedRollbackPage {
  readonly head: Readonly<OverlayHead>;
  readonly previous: Readonly<OverlayHead> | null;
  readonly choice: IssuedRollbackChoice | null;
}
const choices = new WeakSet<object>();
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function rollbackSelection(
  item: AdminLibraryItem,
  status: AdminLibraryPublicationStatus,
): RollbackSelection | null {
  if (
    status.status !== 'ready' ||
    !status.head ||
    !item.publication?.ref ||
    !['current', 'archived'].includes(item.publication.state) ||
    item.publication.releaseId !== status.head.releaseId ||
    item.publication.ref.recipeId !== item.recipeId
  )
    return null;
  return ownArchiveSelection({
    title: item.title,
    ref: item.publication.ref,
    head: status.head,
    matchingDraftRevision: item.publication.matchingDraftRevision,
    latestDraftRevision: item.revision,
  });
}

export async function rollbackReleaseState(
  raw: AdminPublicationReleaseState,
  input: RollbackSelection,
  hash: ContentHash = issuanceHash,
) {
  const selection = ownArchiveSelection(input);
  const state = await verifiedReleaseState(raw, hash);
  const member = state.manifest?.entries.find(
    (entry) =>
      (entry.state === 'withdrawn' ? entry.recipeId : entry.ref.recipeId) ===
      selection.ref.recipeId,
  );
  if (
    !sameIssuanceValue(state.head, selection.head) ||
    !member ||
    member.state === 'withdrawn' ||
    !sameIssuanceValue(member.ref, selection.ref)
  )
    throw new Error(
      'The signed recipe or release changed. Refresh the library before reviewing a rollback.',
    );
  return state;
}

/** The authenticated server verifies signatures and retained membership. Bind its response to
 * the exact requested ancestor before exposing only one recipe's immutable public identity.
 * No recipe bodies or media are retained in this selector, and no preparation proves eligibility. */
export async function readIssuedRollbackPage(
  raw: unknown,
  expected: OverlayHead,
  input: RollbackSelection,
  hash: ContentHash = issuanceHash,
): Promise<IssuedRollbackPage> {
  const selection = ownArchiveSelection(input);
  const head: OverlayHead = JSON.parse(canonicalContentJson(expected, 1024));
  if (!validateOverlayHead(head) || head.sequence >= selection.head.sequence)
    throw new Error('Choose an earlier release from this signed history.');
  // The existing endpoint bounds the complete delivery package. Only its bounded envelope
  // enters this selector; publication bodies and media descriptors are neither copied nor kept.
  if (
    !exact(raw, ['formatVersion', 'status', 'envelope', 'publications', 'media']) ||
    raw.formatVersion !== 1 ||
    raw.status !== 'issued_export_not_adopted' ||
    !Array.isArray(raw.publications) ||
    raw.publications.length > OVERLAY_LIMITS.publications ||
    !Array.isArray(raw.media) ||
    raw.media.length > OVERLAY_LIMITS.publications * CONTENT_LIMITS.mediaPerRecipe
  )
    throw new Error('The earlier issued package could not be verified.');
  const envelope: unknown = JSON.parse(
    canonicalContentJson(raw.envelope, CONTENT_LIMITS.releaseBytes),
  );
  if (
    !exact(envelope, ['manifest', 'fingerprint', 'signature']) ||
    !validateContentOverlayManifest(envelope.manifest) ||
    envelope.manifest.releaseId !== head.releaseId ||
    envelope.manifest.sequence !== head.sequence ||
    envelope.fingerprint !== head.fingerprint ||
    !exact(envelope.signature, ['keyId', 'scheme', 'value']) ||
    typeof envelope.signature.keyId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(envelope.signature.keyId) ||
    envelope.signature.scheme !== CONTENT_SIGNATURE_SCHEME ||
    typeof envelope.signature.value !== 'string' ||
    !/^[a-f0-9]{128}$/.test(envelope.signature.value) ||
    (await fingerprintContentOverlay(envelope.manifest, hash)) !== head.fingerprint
  )
    throw new Error('The earlier issued package does not match the requested signed release.');
  const member = envelope.manifest.entries.find(
    (entry) => entry.state !== 'withdrawn' && entry.ref.recipeId === selection.ref.recipeId,
  );
  let choice: IssuedRollbackChoice | null = null;
  if (member && member.state !== 'withdrawn') {
    const entry = Object.freeze({ ...member, ref: Object.freeze({ ...member.ref }) });
    choice = Object.freeze({ selection, sourceHead: Object.freeze(head), entry });
    choices.add(choice);
  }
  return Object.freeze({
    head: Object.freeze(head),
    previous: envelope.manifest.previous ? Object.freeze({ ...envelope.manifest.previous }) : null,
    choice,
  });
}

export async function prepareRollbackIssuanceProposal(
  raw: AdminPublicationReleaseState,
  choice: IssuedRollbackChoice,
  operationId: string,
  hash: ContentHash = issuanceHash,
) {
  if (!choices.has(choice)) throw new Error('Select a verified earlier issued version first.');
  const state = await rollbackReleaseState(raw, choice.selection, hash);
  const current = {
    state: 'current' as const,
    ref: { ...choice.entry.ref },
    publicationFingerprint: choice.entry.publicationFingerprint,
  };
  const entries = state.manifest!.entries.map((entry) => {
    if (entry.state === 'withdrawn' || entry.ref.recipeId !== current.ref.recipeId) return entry;
    if (sameIssuanceValue(entry, current))
      throw new Error(
        'That exact issued version is already current. Choose an earlier different version.',
      );
    return current;
  });
  const request = { operationId, expectedHead: state.head, entries };
  if (!validateIssuanceRequest(request))
    throw new Error('This rollback exceeds the supported release format. Nothing was sent.');
  return request;
}
