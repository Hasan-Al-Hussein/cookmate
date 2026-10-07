import {
  canonicalContentJson,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  fingerprintContentOverlay,
  validateContentOverlayManifest,
  validateRecipeContentRef,
  type OverlayEntry,
  type ContentHash,
} from '@cookmate/catalogue/content';
import { CONTENT_SIGNATURE_SCHEME } from '@cookmate/catalogue/content-trust';
import type {
  AdminPublicationPreparation,
  AdminPublicationReleaseState,
  AdminPublicationIssueRequest,
  AdminPublicationIssueReceipt,
} from '../src/contracts';
import { ApiError } from './api';
import { ownArchiveSelection, type ArchiveSelection } from './archiveSelection';

export const issuanceHash: ContentHash = async (value) => {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
export const sameIssuanceValue = (left: unknown, right: unknown) =>
  canonicalContentJson(left, CONTENT_LIMITS.releaseBytes) ===
  canonicalContentJson(right, CONTENT_LIMITS.releaseBytes);
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** Reuse the strict overlay validator for the request's head and complete entry set. */
export function validateIssuanceRequest(value: unknown): value is AdminPublicationIssueRequest {
  if (!object(value, ['operationId', 'expectedHead', 'entries']) || !identifier(value.operationId))
    return false;
  const head = value.expectedHead;
  if (head !== null && !object(head, ['releaseId', 'sequence', 'fingerprint'])) return false;
  return validateContentOverlayManifest({
    formatVersion: 2,
    releaseId: head?.releaseId === 'candidate' ? 'candidate-next' : 'candidate',
    sequence: head === null ? 1 : Number(head.sequence) + 1,
    previous: head,
    createdAt: '2026-10-01T00:00:00.000Z',
    minimumReaderVersion: 1,
    baseline: { version: 'request-validation', fingerprint: '0'.repeat(64) },
    entries: value.entries,
  });
}
export async function issuanceRequestFingerprint(
  request: AdminPublicationIssueRequest,
  hash: ContentHash = issuanceHash,
) {
  if (!validateIssuanceRequest(request)) throw new Error('The release request is invalid.');
  return hash(
    canonicalContentJson([
      'cookmate-issue-overlay-v2',
      { expectedHead: request.expectedHead, entries: request.entries },
    ]),
  );
}

export async function verifiedReleaseState(raw: AdminPublicationReleaseState, hash: ContentHash) {
  const state = JSON.parse(
    canonicalContentJson(raw, CONTENT_LIMITS.releaseBytes),
  ) as AdminPublicationReleaseState;
  if (state.status === 'not_configured')
    throw new ApiError(
      503,
      'issuance_not_configured',
      'Signed-release issuance is not configured.',
    );
  if (
    !object(state, ['status', 'head', 'manifest']) ||
    state.status !== 'ready' ||
    (state.head === null
      ? state.manifest !== null
      : !validateContentOverlayManifest(state.manifest) ||
        state.manifest.releaseId !== state.head.releaseId ||
        state.manifest.sequence !== state.head.sequence ||
        (await fingerprintContentOverlay(state.manifest, hash)) !== state.head.fingerprint)
  )
    throw new Error('The current release could not be verified. No issuance request was prepared.');
  return state;
}

export async function prepareIssuanceProposal(
  raw: AdminPublicationReleaseState,
  input: AdminPublicationPreparation,
  operationId: string,
  hash: ContentHash = issuanceHash,
): Promise<AdminPublicationIssueRequest> {
  const preparation = JSON.parse(canonicalContentJson(input)) as AdminPublicationPreparation;
  const state = await verifiedReleaseState(raw, hash);
  const ref = {
    recipeId: preparation.recipeId,
    revisionId: preparation.revisionId,
    contentFingerprint: preparation.contentFingerprint,
  };
  if (
    preparation.status !== 'prepared_not_published' ||
    !validateRecipeContentRef(ref) ||
    !fingerprint(preparation.publicationFingerprint)
  )
    throw new Error('The retained recipe package is invalid. Prepare the saved revision again.');
  const current: OverlayEntry = {
    state: 'current',
    ref,
    publicationFingerprint: preparation.publicationFingerprint,
  };
  let replaced = false;
  const entries = (state.manifest?.entries ?? []).map((entry) => {
    const recipeId = entry.state === 'withdrawn' ? entry.recipeId : entry.ref.recipeId;
    if (recipeId !== preparation.recipeId) return entry;
    if (entry.state === 'withdrawn')
      throw new Error('This recipe was withdrawn. A prepared package cannot restore it.');
    replaced = true;
    return current;
  });
  if (!replaced) entries.push(current);
  const request = { operationId, expectedHead: state.head, entries };
  if (!validateIssuanceRequest(request))
    throw new Error('This cumulative release exceeds the supported format. Nothing was sent.');
  return request;
}

/** Archive only the exact observed current member; never prepare or substitute a newer draft. */
export async function prepareArchiveIssuanceProposal(
  raw: AdminPublicationReleaseState,
  input: ArchiveSelection,
  reason: string,
  operationId: string,
  hash: ContentHash = issuanceHash,
): Promise<AdminPublicationIssueRequest> {
  const selected = ownArchiveSelection(input);
  if (
    typeof reason !== 'string' ||
    !reason.trim() ||
    [...reason].length > OVERLAY_LIMITS.reasonCharacters
  )
    throw new Error('Enter a reason for archiving, up to 2,000 characters.');
  const state = await verifiedReleaseState(raw, hash);
  if (!sameIssuanceValue(state.head, selected.head))
    throw new Error(
      'The signed release changed. Refresh the library and select the published version again.',
    );
  const member = state.manifest?.entries.find(
    (entry) => entry.state !== 'withdrawn' && entry.ref.recipeId === selected.ref.recipeId,
  );
  if (!member || member.state !== 'current' || !sameIssuanceValue(member.ref, selected.ref))
    throw new Error(
      'That exact published version is no longer current. Refresh the recipe library.',
    );
  const entries = state.manifest!.entries.map((entry) =>
    entry === member
      ? {
          state: 'archived' as const,
          ref: member.ref,
          publicationFingerprint: member.publicationFingerprint,
          reason,
        }
      : entry,
  );
  const request = { operationId, expectedHead: state.head, entries };
  if (!validateIssuanceRequest(request))
    throw new Error('This archive release exceeds the supported format. Nothing was sent.');
  return request;
}

/** Match the full reviewed payload; a receipt confirms issuance, never client activation. */
export async function validateIssuanceReceipt(
  value: unknown,
  actorId: string,
  request: AdminPublicationIssueRequest,
  requestFingerprint: string,
  hash: ContentHash = issuanceHash,
): Promise<AdminPublicationIssueReceipt> {
  const receipt = JSON.parse(canonicalContentJson(value)) as AdminPublicationIssueReceipt;
  const envelope = receipt?.envelope;
  if (
    !object(receipt, ['status', 'operationId', 'actorId', 'requestFingerprint', 'envelope']) ||
    receipt.status !== 'issued_not_activated' ||
    receipt.operationId !== request.operationId ||
    receipt.actorId !== actorId ||
    receipt.requestFingerprint !== requestFingerprint ||
    (await issuanceRequestFingerprint(request, hash)) !== requestFingerprint ||
    !object(envelope, ['manifest', 'fingerprint', 'signature']) ||
    !validateContentOverlayManifest(envelope.manifest) ||
    !sameIssuanceValue(envelope.manifest.previous, request.expectedHead) ||
    !sameIssuanceValue(envelope.manifest.entries, request.entries) ||
    !fingerprint(envelope.fingerprint) ||
    (await fingerprintContentOverlay(envelope.manifest, hash)) !== envelope.fingerprint ||
    !object(envelope.signature, ['keyId', 'scheme', 'value']) ||
    typeof envelope.signature.keyId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(envelope.signature.keyId) ||
    envelope.signature.scheme !== CONTENT_SIGNATURE_SCHEME ||
    typeof envelope.signature.value !== 'string' ||
    !/^[a-f0-9]{128}$/.test(envelope.signature.value)
  )
    throw new ApiError(
      0,
      'issuance_receipt_mismatch',
      'The release receipt does not match this operator and exact request. Keep its recovery record.',
    );
  return receipt;
}
