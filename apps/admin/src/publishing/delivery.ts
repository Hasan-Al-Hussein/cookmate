import type { DatabaseSync } from 'node:sqlite';
import type { Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  PUBLICATION_MAX_BYTES,
  TRANSLATED_PUBLICATION_READER_VERSION,
  contentOverlaySignaturePayload,
  fingerprintContentOverlay,
  readPublishedRecipeRevision,
  validateContentOverlayManifest,
  validateMediaReference,
  type MediaReference,
  type PublishedRecipeRevision,
  type ReleaseTrustVerifier,
  type SignedContentOverlay,
} from '@cookmate/catalogue/content';
import { requireAdmin } from '../auth/errors';
import { sha256 } from '../drafts/repository';

export const ISSUED_DELIVERY_LIMITS = Object.freeze({
  jsonBytes: 18 * 1024 * 1024,
  mediaBytes: 32 * 1024 * 1024,
  mediaCount: OVERLAY_LIMITS.publications * CONTENT_LIMITS.mediaPerRecipe,
  retainedReleases: 256,
  retainedEnvelopeBytes: 64 * 1024 * 1024,
});
export interface IssuedReleaseMedia {
  sha256: string;
  bytes: number;
  mimeType: MediaReference['mimeType'];
}
/** Private historical administrator export. Consumers still need sequential verification and withdrawal policy. */
export interface IssuedReleasePackage {
  formatVersion: 1;
  status: 'issued_export_not_adopted';
  envelope: SignedContentOverlay;
  publications: PublishedRecipeRevision[];
  media: IssuedReleaseMedia[];
}
interface PublicationRow {
  recipe: string;
  revision: string;
  document: string;
}
interface DeliverySnapshot {
  releaseId: string;
  sequence: number;
  document: string;
  publications: PublicationRow[];
  bindings: { recipe: string; revision: string; release_id: string; sequence: number }[];
  priorReleases: { id: string; sequence: number; document: string }[];
  media: IssuedReleaseMedia[];
  requestedMedia: { descriptor: IssuedReleaseMedia; bytes: Buffer } | null;
}
const hash = async (text: string) => sha256(text);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left) === canonicalContentJson(right);
function integrity(condition: unknown): asserts condition {
  requireAdmin(condition, 500, 'issued_integrity', 'Retained release data failed verification.');
}
function bounded(condition: unknown): asserts condition {
  requireAdmin(
    condition,
    413,
    'release_delivery_limit',
    'This issued release exceeds the private export limits. No partial package was exported.',
  );
}
function parse(text: unknown, maximum: number): unknown {
  integrity(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= maximum);
  try {
    return JSON.parse(text);
  } catch {
    integrity(false);
  }
}
function immutable<Value>(value: Value): Immutable<Value> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}
export function validateDeliveryIdentity(
  releaseId: unknown,
  mediaHash?: unknown,
): asserts releaseId is string {
  requireAdmin(
    typeof releaseId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(releaseId) &&
      (mediaHash === undefined ||
        (typeof mediaHash === 'string' && /^[a-f0-9]{64}$/.test(mediaHash))),
    400,
    'invalid_delivery_request',
    'Use an exact issued release identifier and listed media hash.',
  );
}

/** Capture synchronously: no await can interleave another operation on the journal connection. */
export function captureIssuedDelivery(
  sql: DatabaseSync,
  releaseId: string,
  mediaHash?: string,
): DeliverySnapshot {
  validateDeliveryIdentity(releaseId, mediaHash);
  sql.exec('BEGIN');
  try {
    const envelope = sql
      .prepare(
        `SELECT sequence,typeof(document) type,length(CAST(document AS BLOB)) size,
      CASE WHEN typeof(document)='text' AND length(CAST(document AS BLOB))<=? THEN document ELSE NULL END document
      FROM issued_release WHERE id=?`,
      )
      .get(CONTENT_LIMITS.releaseBytes, releaseId);
    requireAdmin(
      envelope,
      404,
      'issued_release_unknown',
      'The exact issued release was not found.',
    );
    integrity(envelope.type === 'text');
    bounded(typeof envelope.size === 'number' && envelope.size <= CONTENT_LIMITS.releaseBytes);
    integrity(typeof envelope.document === 'string' && typeof envelope.sequence === 'number');
    const admission = sql
      .prepare(
        `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(document AS BLOB))),0) bytes,
      COALESCE(MAX(length(CAST(document AS BLOB))),0) largest,
      COALESCE(SUM(CASE WHEN typeof(document)<>'text' OR typeof(recipe)<>'text' OR length(CAST(recipe AS BLOB))>120
        OR typeof(revision)<>'text' OR length(CAST(revision AS BLOB))>120 THEN 1 ELSE 0 END),0) invalid
      FROM issued_publication WHERE release_id=?`,
      )
      .get(releaseId)!;
    integrity(admission.invalid === 0);
    bounded(
      typeof admission.count === 'number' &&
        admission.count <= OVERLAY_LIMITS.publications &&
        typeof admission.bytes === 'number' &&
        admission.bytes + (admission.count ? admission.count + 1 : 2) <=
          OVERLAY_LIMITS.aggregateContentBytes &&
        typeof admission.largest === 'number' &&
        admission.largest <= PUBLICATION_MAX_BYTES,
    );
    parseIssuedEnvelope(envelope.document, releaseId, envelope.sequence);
    // Resolve all signed member identities together, without reading prior publication bodies.
    const bindings = sql
      .prepare(
        `SELECT json_extract(member.value,'$.ref.recipeId') recipe,
      json_extract(member.value,'$.ref.revisionId') revision,
      CASE WHEN typeof(publication.release_id)='text' AND length(CAST(publication.release_id AS BLOB))<=120
        THEN publication.release_id ELSE NULL END release_id, retained.sequence
      FROM json_each(?,'$.manifest.entries') member
      LEFT JOIN issued_publication publication ON publication.recipe=json_extract(member.value,'$.ref.recipeId')
        AND publication.revision=json_extract(member.value,'$.ref.revisionId')
      LEFT JOIN issued_release retained ON retained.id=publication.release_id
      WHERE json_extract(member.value,'$.state')<>'withdrawn'
        AND json_extract(member.value,'$.publicationFingerprint') IS NOT NULL`,
      )
      .all(envelope.document) as unknown as DeliverySnapshot['bindings'];
    const earlier = new Set<string>();
    const newlyRetained = new Set<string>();
    for (const binding of bindings) {
      integrity(
        typeof binding.release_id === 'string' &&
          Number.isSafeInteger(binding.sequence) &&
          binding.sequence > 0 &&
          binding.sequence <= envelope.sequence,
      );
      if (binding.sequence === envelope.sequence) {
        integrity(binding.release_id === releaseId);
        newlyRetained.add(canonicalContentJson([binding.recipe, binding.revision]));
      } else earlier.add(binding.release_id);
    }
    bounded(earlier.size <= ISSUED_DELIVERY_LIMITS.retainedReleases);
    const priorIds = JSON.stringify([...earlier]);
    const priorAdmission = sql
      .prepare(
        `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(document AS BLOB))),0) bytes,
      COALESCE(MAX(length(CAST(document AS BLOB))),0) largest,
      COALESCE(SUM(CASE WHEN typeof(document)<>'text' THEN 1 ELSE 0 END),0) invalid
      FROM issued_release WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .get(priorIds)!;
    integrity(priorAdmission.count === earlier.size && priorAdmission.invalid === 0);
    bounded(
      typeof priorAdmission.bytes === 'number' &&
        priorAdmission.bytes <= ISSUED_DELIVERY_LIMITS.retainedEnvelopeBytes &&
        typeof priorAdmission.largest === 'number' &&
        priorAdmission.largest <= CONTENT_LIMITS.releaseBytes,
    );
    const priorReleases = sql
      .prepare(
        'SELECT id,sequence,document FROM issued_release WHERE id IN (SELECT value FROM json_each(?)) ORDER BY sequence',
      )
      .all(priorIds) as unknown as DeliverySnapshot['priorReleases'];
    const publications = sql
      .prepare(
        'SELECT recipe,revision,document FROM issued_publication WHERE release_id=? ORDER BY recipe,revision',
      )
      .all(releaseId) as unknown as PublicationRow[];
    integrity(
      publications.length === newlyRetained.size &&
        publications.every((row) =>
          newlyRetained.has(canonicalContentJson([row.recipe, row.revision])),
        ),
    );
    const descriptors = new Map<string, IssuedReleaseMedia>();
    let mediaBytes = 0;
    for (const row of publications) {
      const publication = parse(row.document, PUBLICATION_MAX_BYTES) as PublishedRecipeRevision;
      const references = publication?.revision?.document?.media;
      integrity(Array.isArray(references) && references.length <= CONTENT_LIMITS.mediaPerRecipe);
      for (const reference of references) {
        integrity(validateMediaReference(reference));
        const descriptor = {
          sha256: reference.sha256,
          bytes: reference.bytes,
          mimeType: reference.mimeType,
        };
        const prior = descriptors.get(reference.sha256);
        integrity(!prior || same(prior, descriptor));
        if (!prior) {
          mediaBytes += reference.bytes;
          bounded(
            mediaBytes <= ISSUED_DELIVERY_LIMITS.mediaBytes &&
              descriptors.size < ISSUED_DELIVERY_LIMITS.mediaCount,
          );
          descriptors.set(reference.sha256, descriptor);
        }
      }
    }
    const media = [...descriptors.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
    // Admission inspects BLOB lengths only. No media bytes are copied until the whole package fits.
    for (const descriptor of media) {
      const retained = sql
        .prepare(
          'SELECT typeof(bytes) type,length(CAST(bytes AS BLOB)) size FROM issued_media WHERE hash=?',
        )
        .get(descriptor.sha256);
      integrity(retained?.type === 'blob' && retained.size === descriptor.bytes);
    }
    let requestedMedia: DeliverySnapshot['requestedMedia'] = null;
    if (mediaHash !== undefined) {
      const descriptor = descriptors.get(mediaHash);
      requireAdmin(
        descriptor,
        404,
        'issued_media_unknown',
        'This media hash is not a member of the exact release package.',
      );
      const retained = sql
        .prepare(
          `SELECT CASE WHEN typeof(bytes)='blob' AND length(CAST(bytes AS BLOB))<=? THEN bytes ELSE NULL END bytes
        FROM issued_media WHERE hash=?`,
        )
        .get(CONTENT_LIMITS.mediaBytes, mediaHash);
      integrity(
        retained?.bytes instanceof Uint8Array && retained.bytes.length === descriptor.bytes,
      );
      requestedMedia = { descriptor, bytes: Buffer.from(retained.bytes) };
    }
    const result = {
      releaseId,
      sequence: envelope.sequence,
      document: envelope.document,
      publications,
      bindings,
      priorReleases,
      media,
      requestedMedia,
    };
    sql.exec('COMMIT');
    return result;
  } catch (error) {
    sql.exec('ROLLBACK');
    throw error;
  }
}

/** Shared by journal reads and transport; trust keys are supplied only by the configured host. */
function parseIssuedEnvelope(
  document: unknown,
  id: string,
  sequence: unknown,
): SignedContentOverlay {
  const envelope = parse(document, CONTENT_LIMITS.releaseBytes);
  integrity(
    exact(envelope, ['manifest', 'fingerprint', 'signature']) &&
      validateContentOverlayManifest(envelope.manifest) &&
      envelope.manifest.releaseId === id &&
      envelope.manifest.sequence === sequence &&
      typeof envelope.fingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(envelope.fingerprint) &&
      exact(envelope.signature, ['keyId', 'scheme', 'value']) &&
      typeof envelope.signature.keyId === 'string' &&
      typeof envelope.signature.scheme === 'string' &&
      typeof envelope.signature.value === 'string',
  );
  return envelope as unknown as SignedContentOverlay;
}
export async function verifyIssuedEnvelope(
  document: unknown,
  id: string,
  sequence: unknown,
  verifier: ReleaseTrustVerifier,
): Promise<SignedContentOverlay> {
  const value = parseIssuedEnvelope(document, id, sequence);
  integrity((await fingerprintContentOverlay(value.manifest, hash)) === value.fingerprint);
  integrity(
    await verifier.verify({
      keyId: value.signature.keyId,
      scheme: value.signature.scheme,
      signature: value.signature.value,
      canonicalPayload: contentOverlaySignaturePayload(value.manifest, value.fingerprint),
    }),
  );
  return value;
}

export async function verifyIssuedDelivery(
  snapshot: DeliverySnapshot,
  verifier: ReleaseTrustVerifier,
) {
  const envelope = await verifyIssuedEnvelope(
    snapshot.document,
    snapshot.releaseId,
    snapshot.sequence,
    verifier,
  );
  const entries = new Map(
    envelope.manifest.entries
      .filter((entry) => entry.state !== 'withdrawn')
      .map((entry) => [entry.ref.recipeId, entry]),
  );
  const dependencies = new Map<string, typeof snapshot.bindings>();
  for (const binding of snapshot.bindings) {
    if (binding.release_id === snapshot.releaseId) continue;
    const references = dependencies.get(binding.release_id) ?? [];
    references.push(binding);
    dependencies.set(binding.release_id, references);
  }
  for (const retained of snapshot.priorReleases) {
    const prior = await verifyIssuedEnvelope(
      retained.document,
      retained.id,
      retained.sequence,
      verifier,
    );
    integrity(prior.manifest.minimumReaderVersion <= envelope.manifest.minimumReaderVersion);
    const previousEntries = new Map(
      prior.manifest.entries
        .filter((entry) => entry.state !== 'withdrawn')
        .map((entry) => [entry.ref.recipeId, entry]),
    );
    for (const binding of dependencies.get(retained.id) ?? []) {
      const entry = entries.get(binding.recipe),
        original = previousEntries.get(binding.recipe);
      integrity(
        entry &&
          original &&
          binding.revision === entry.ref.revisionId &&
          same(original.ref, entry.ref) &&
          original.publicationFingerprint === entry.publicationFingerprint,
      );
    }
  }
  const publications: PublishedRecipeRevision[] = [];
  for (const row of snapshot.publications) {
    const publication = await readPublishedRecipeRevision(
      parse(row.document, PUBLICATION_MAX_BYTES),
      hash,
    );
    integrity(
      publication.formatVersion !== 3 ||
        envelope.manifest.minimumReaderVersion >= TRANSLATED_PUBLICATION_READER_VERSION,
    );
    const entry = entries.get(row.recipe);
    integrity(
      publication.revision.ref.recipeId === row.recipe &&
        publication.revision.ref.revisionId === row.revision &&
        entry &&
        same(entry.ref, publication.revision.ref) &&
        entry.publicationFingerprint === publication.publicationFingerprint,
    );
    publications.push(
      JSON.parse(
        canonicalContentJson(publication, PUBLICATION_MAX_BYTES),
      ) as PublishedRecipeRevision,
    );
  }
  canonicalContentJson(publications, OVERLAY_LIMITS.aggregateContentBytes);
  const value: IssuedReleasePackage = {
    formatVersion: 1,
    status: 'issued_export_not_adopted',
    envelope,
    publications,
    media: snapshot.media,
  };
  bounded(Buffer.byteLength(JSON.stringify(value), 'utf8') <= ISSUED_DELIVERY_LIMITS.jsonBytes);
  if (snapshot.requestedMedia)
    integrity(sha256(snapshot.requestedMedia.bytes) === snapshot.requestedMedia.descriptor.sha256);
  return { package: immutable(value), media: snapshot.requestedMedia };
}
