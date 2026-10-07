import type { Immutable } from '../catalogue';
import {
  canonicalContentJson,
  copyContent,
  freezeContent,
  jsonUtf8Bytes,
  requireContent,
} from './canonical';
import { OVERLAY_LIMITS, TRANSLATED_PUBLICATION_READER_VERSION } from './overlay-types';
import type {
  ContentLookup,
  ContentOverlayManifest,
  EffectiveContentSnapshot,
  PublishedRecipeRevision,
  ReadableRecipeView,
  SignedContentOverlay,
  VerifyOverlayOptions,
} from './overlay-types';
import { createOverlayResolver, referenceKey } from './overlay-resolver';
import {
  contentOverlaySignaturePayload,
  fingerprintContentOverlay,
  overlayEntryId,
  validateBaselineIdentity,
  validateContentOverlayManifest,
  validateOverlayHead,
} from './overlay-validation';
import { PUBLICATION_MAX_BYTES } from './publication';
import { readRecipeContentRevision } from './revision';
import { CONTENT_LIMITS } from './types';
import type { RecipeContentRef, RecipeContentRevision } from './types';
import {
  exact,
  fingerprint,
  identity,
  integer,
  text,
  validateRecipeContentRef,
} from './validation';

const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left) === canonicalContentJson(right);
/** Validates a staged overlay. It does not write an activation head or implement platform cryptography. */
export async function verifySignedContentOverlay(
  input: unknown,
  options: VerifyOverlayOptions,
): Promise<EffectiveContentSnapshot> {
  const raw = copyContent(input, CONTENT_LIMITS.releaseBytes);
  requireContent(
    exact(raw, ['manifest', 'fingerprint', 'signature']) &&
      validateContentOverlayManifest(raw.manifest) &&
      fingerprint(raw.fingerprint),
    'overlay_envelope',
  );
  const signature = raw.signature;
  requireContent(
    exact(signature, ['keyId', 'scheme', 'value']) &&
      identity(signature.keyId) &&
      identity(signature.scheme) &&
      text(signature.value, 4096, 16) &&
      /^[A-Za-z0-9_-]+$/.test(signature.value),
    'overlay_signature',
  );
  const envelope = freezeContent(raw as unknown as SignedContentOverlay);
  const { sha256, trustVerifier, archive, mediaVerifier, readerVersion, minimumSequence } = options;
  const expectedCurrent = copyContent(options.expectedCurrent, 1024);
  requireContent(
    expectedCurrent === null || validateOverlayHead(expectedCurrent),
    'overlay_current_head',
  );
  requireContent(
    integer(readerVersion, 1, Number.MAX_SAFE_INTEGER) &&
      envelope.manifest.minimumReaderVersion <= readerVersion,
    'reader_incompatible',
  );
  requireContent(
    integer(minimumSequence, 0, Number.MAX_SAFE_INTEGER) &&
      envelope.manifest.sequence > minimumSequence &&
      same(envelope.manifest.previous, expectedCurrent),
    'overlay_stale_head',
  );
  requireContent(
    envelope.manifest.sequence === (expectedCurrent === null ? 1 : expectedCurrent.sequence + 1),
    'overlay_sequence',
  );
  const baselineInput = copyContent(options.baseline, CONTENT_LIMITS.releaseBytes);
  requireContent(
    exact(baselineInput, ['identity', 'revisions']) &&
      validateBaselineIdentity(baselineInput.identity) &&
      same(baselineInput.identity, envelope.manifest.baseline) &&
      Array.isArray(baselineInput.revisions) &&
      baselineInput.revisions.length > 0 &&
      baselineInput.revisions.length <= CONTENT_LIMITS.recipesPerRelease,
    'overlay_baseline',
  );
  requireContent(
    Array.isArray(options.publications) &&
      options.publications.length <= OVERLAY_LIMITS.publications,
    'overlay_publication_count',
  );
  function requireCompatiblePublication(value: unknown) {
    if (value && typeof value === 'object' && 'formatVersion' in value && value.formatVersion === 3)
      requireContent(
        readerVersion >= TRANSLATED_PUBLICATION_READER_VERSION &&
          envelope.manifest.minimumReaderVersion >= TRANSLATED_PUBLICATION_READER_VERSION,
        'reader_incompatible',
      );
  }
  let bytes = 0;
  const candidates = options.publications.map((candidate) => {
    const value = copyContent(candidate, PUBLICATION_MAX_BYTES);
    requireCompatiblePublication(value);
    bytes += jsonUtf8Bytes(canonicalContentJson(value));
    requireContent(bytes <= OVERLAY_LIMITS.aggregateContentBytes, 'overlay_content_size');
    return value;
  });
  const pins = copyContent(options.retainedRefs ?? [], 512 * 1024);
  requireContent(
    Array.isArray(pins) &&
      pins.length <= OVERLAY_LIMITS.retainedRefs &&
      pins.every(validateRecipeContentRef) &&
      new Set(pins.map(referenceKey)).size === pins.length,
    'overlay_retained_refs',
  );
  // Every caller-owned data input is now an owned snapshot before the first asynchronous port.
  requireContent(
    (await fingerprintContentOverlay(envelope.manifest, sha256)) === envelope.fingerprint,
    'overlay_integrity',
  );
  requireContent(
    (await trustVerifier.verify({
      keyId: signature.keyId,
      scheme: signature.scheme,
      canonicalPayload: contentOverlaySignaturePayload(envelope.manifest, envelope.fingerprint),
      signature: signature.value,
    })) === true,
    'overlay_untrusted',
  );
  requireContent(
    (await archive.readRelease(envelope.manifest.releaseId)) === null,
    'overlay_release_rebound',
  );
  const baseline: Immutable<RecipeContentRevision>[] = [];
  for (const candidate of baselineInput.revisions) {
    const revision = await readRecipeContentRevision(candidate, sha256);
    requireContent(
      revision.document.kind === 'imported' &&
        same(revision.document.provenance.catalogue, baselineInput.identity),
      'overlay_baseline_source',
    );
    baseline.push(revision);
  }
  const baselineIds = new Set(baseline.map((revision) => revision.ref.recipeId));
  requireContent(baselineIds.size === baseline.length, 'overlay_baseline_duplicate');
  let previous: Immutable<ContentOverlayManifest> | null = null;
  if (expectedCurrent !== null) {
    const incoming = await archive.readRelease(expectedCurrent.releaseId);
    const stored = copyContent(incoming, CONTENT_LIMITS.releaseBytes);
    requireContent(
      exact(stored, ['manifest', 'fingerprint']) &&
        validateContentOverlayManifest(stored.manifest) &&
        stored.fingerprint === expectedCurrent.fingerprint &&
        stored.manifest.releaseId === expectedCurrent.releaseId &&
        stored.manifest.sequence === expectedCurrent.sequence &&
        same(stored.manifest.baseline, envelope.manifest.baseline),
      'overlay_previous_untrusted',
    );
    requireContent(
      (await fingerprintContentOverlay(stored.manifest, sha256)) === stored.fingerprint,
      'overlay_previous_integrity',
    );
    previous = freezeContent(stored.manifest);
  }
  const entries = new Map(envelope.manifest.entries.map((entry) => [overlayEntryId(entry), entry]));
  const previousIds = new Set(previous?.entries.map(overlayEntryId) ?? []);
  for (const entry of previous?.entries ?? []) {
    const next = entries.get(overlayEntryId(entry));
    requireContent(
      next && (entry.state !== 'withdrawn' || next.state === 'withdrawn'),
      'overlay_not_cumulative',
    );
  }
  for (const entry of entries.values()) {
    requireContent(
      entry.state !== 'withdrawn' ||
        baselineIds.has(entry.recipeId) ||
        previousIds.has(entry.recipeId),
      'overlay_unknown_withdrawal',
    );
  }
  const resolver = createOverlayResolver({
    sha256,
    archive: {
      readRelease: archive.readRelease.bind(archive),
      async readPublication(recipeId, revisionId) {
        const incoming = await archive.readPublication(recipeId, revisionId);
        if (incoming === null) return null;
        // Inspect an owned value so a mutable archive response cannot evade the version gate.
        // The resolver still performs all publication integrity/authority validation.
        const owned = copyContent(incoming, PUBLICATION_MAX_BYTES);
        requireCompatiblePublication(owned);
        return owned as PublishedRecipeRevision;
      },
    },
    mediaVerifier,
    baseline,
    candidates,
    previousRecipeIds: previousIds,
  });
  await resolver.initialize();
  const current = new Map<string, Immutable<ReadableRecipeView>>(
    baseline.map((revision) => [
      revision.ref.recipeId,
      resolver.resolved.get(referenceKey(revision.ref))!,
    ]),
  );
  for (const entry of entries.values()) {
    if (entry.state === 'withdrawn') {
      current.delete(entry.recipeId);
      continue;
    }
    current.set(
      entry.ref.recipeId,
      await resolver.resolve(entry.ref, entry.publicationFingerprint),
    );
  }
  for (const ref of pins) {
    // Withdrawal is deliberately stronger than a historic pin: do not expose or fetch its body.
    if (
      entries.get(ref.recipeId)?.state === 'withdrawn' ||
      resolver.resolved.has(referenceKey(ref))
    )
      continue;
    await resolver.resolve(ref, undefined, true);
  }
  resolver.assertAllCandidatesUsed();
  const discoverable = [...current.values()].filter(
    (view) => entries.get(view.revision.ref.recipeId)?.state !== 'archived',
  );
  const missing: ContentLookup = Object.freeze({ kind: 'missing' });
  function withdrawal(id: string): ContentLookup | null {
    const entry = entries.get(id);
    return entry?.state === 'withdrawn'
      ? freezeContent({ kind: 'withdrawn', recipeId: id, reason: entry.reason })
      : null;
  }
  function readable(
    value: Immutable<ReadableRecipeView>,
    state: 'current' | 'archived' | 'historical',
  ): ContentLookup {
    return freezeContent({ kind: 'readable', value, state });
  }
  function lookupExact(ref: RecipeContentRef): ContentLookup {
    if (!validateRecipeContentRef(ref)) return missing;
    const withdrawn = withdrawal(ref.recipeId);
    if (withdrawn) return withdrawn;
    const value = resolver.resolved.get(referenceKey(ref));
    if (!value) return missing;
    const active = current.get(ref.recipeId);
    return readable(
      value,
      active && same(active.revision.ref, ref)
        ? entries.get(ref.recipeId)?.state === 'archived'
          ? 'archived'
          : 'current'
        : 'historical',
    );
  }
  function lookupCurrent(id: string): ContentLookup {
    const withdrawn = withdrawal(id);
    if (withdrawn) return withdrawn;
    const value = current.get(id);
    return value
      ? readable(value, entries.get(id)?.state === 'archived' ? 'archived' : 'current')
      : missing;
  }
  return freezeContent({
    envelope,
    identity: {
      version: `overlay-v2:${envelope.manifest.sequence}`,
      fingerprint: envelope.fingerprint,
    },
    trust: 'signature_verified',
    mediaBytes: 'verified_by_host',
    ancestry: 'resolved_by_host',
    entries: envelope.manifest.entries,
    discoverable,
    lookupExact,
    lookupCurrent,
    lookupDiscoverable(id: string): ContentLookup {
      return entries.get(id)?.state === 'archived' ? missing : lookupCurrent(id);
    },
  }) as EffectiveContentSnapshot;
}
