import { isUtcInstant } from '@cookmate/contracts';
import type { CatalogueIdentity } from '@cookmate/contracts';
import type { Immutable } from '../catalogue';
import { canonicalContentJson, copyContent, requireContent } from './canonical';
import { OVERLAY_LIMITS } from './overlay-types';
import type { ContentOverlayManifest, OverlayEntry, OverlayHead } from './overlay-types';
import { hashContent } from './revision';
import { CONTENT_LIMITS } from './types';
import type { ContentHash } from './types';
import { exact, fingerprint, identity, integer, recipeId, text, validateRecipeContentRef } from './validation';

export function validateBaselineIdentity(value: unknown): value is CatalogueIdentity {
  return exact(value, ['version', 'fingerprint']) && text(value.version, 80) && fingerprint(value.fingerprint);
}
export function validateOverlayHead(value: unknown): value is OverlayHead {
  return exact(value, ['releaseId', 'sequence', 'fingerprint']) && identity(value.releaseId) && integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) && fingerprint(value.fingerprint);
}
export function overlayEntryId(entry: Immutable<OverlayEntry>): string {
  return entry.state === 'withdrawn' ? entry.recipeId : entry.ref.recipeId;
}
function reason(value: unknown): boolean {
  return text(value, OVERLAY_LIMITS.reasonCharacters) && value.trim().length > 0;
}
function validateEntry(value: unknown): value is OverlayEntry {
  if (exact(value, ['state', 'recipeId', 'reason']) && value.state === 'withdrawn') return recipeId(value.recipeId) && reason(value.reason);
  if (!exact(value, ['state', 'ref', 'publicationFingerprint', ...(typeof value === 'object' && value !== null && 'state' in value && value.state === 'archived' ? ['reason'] : [])])) return false;
  return (value.state === 'current' || (value.state === 'archived' && reason(value.reason))) && validateRecipeContentRef(value.ref) && (value.publicationFingerprint === null || fingerprint(value.publicationFingerprint));
}
export function validateContentOverlayManifest(value: unknown): value is ContentOverlayManifest {
  if (!exact(value, ['formatVersion', 'releaseId', 'sequence', 'previous', 'createdAt', 'minimumReaderVersion', 'baseline', 'entries']) || value.formatVersion !== 2 || !identity(value.releaseId) || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(value.minimumReaderVersion, 1, Number.MAX_SAFE_INTEGER) || !validateBaselineIdentity(value.baseline) || typeof value.createdAt !== 'string' || !isUtcInstant(value.createdAt)) return false;
  if (!(value.previous === null ? value.sequence === 1 : validateOverlayHead(value.previous) && value.previous.releaseId !== value.releaseId && value.previous.sequence + 1 === value.sequence)) return false;
  return Array.isArray(value.entries) && value.entries.length <= OVERLAY_LIMITS.overrides && value.entries.every(validateEntry) && new Set(value.entries.map(overlayEntryId)).size === value.entries.length;
}
export async function fingerprintContentOverlay(input: unknown, sha256: ContentHash): Promise<string> {
  const manifest = copyContent(input, CONTENT_LIMITS.releaseBytes);
  requireContent(validateContentOverlayManifest(manifest), 'overlay_manifest');
  return hashContent('cookmate-content-overlay-v2', manifest, sha256);
}
export function contentOverlaySignaturePayload(manifest: ContentOverlayManifest | Immutable<ContentOverlayManifest>, digest: string): string {
  requireContent(validateContentOverlayManifest(manifest) && fingerprint(digest), 'overlay_signature_payload');
  return canonicalContentJson(['cookmate-signed-overlay-v2', { manifest, fingerprint: digest }]);
}
