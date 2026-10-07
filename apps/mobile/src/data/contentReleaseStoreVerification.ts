import {
  canonicalContentJson,
  CONTENT_LIMITS,
  readRecipeContentRevision,
  validateOverlayHead,
  verifySignedContentOverlay,
  type ContentHash,
  type ContentLookup,
  type ContentMediaVerifier,
  type ContentOverlayManifest,
  type EffectiveContentSnapshot,
  type MediaReference,
  type OverlayHead,
  type OverlayTrustArchive,
  type PackagedContentBaseline,
  type PublishedRecipeRevision,
  type RecipeContentRef,
  type ReleaseTrustVerifier,
  type SignedContentOverlay,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import { isUtcInstant } from '@cookmate/contracts';
import type { SqlSession } from './sql';
import {
  CONTENT_STORE_LIMITS,
  identifier,
  insist,
  own,
  parse,
  readMediaBytes,
  readMeta,
  readPackage,
  same,
  storageBounds,
  type StoredPackage,
  type StoreMeta,
} from './contentReleaseStoreSchema';

export interface ContentVerificationPorts {
  baseline: PackagedContentBaseline;
  readerVersion: number;
  trustVerifier: ReleaseTrustVerifier;
  sha256: ContentHash;
  sha256Bytes(bytes: Uint8Array): Promise<string>;
  inspectImage(
    bytes: Uint8Array,
  ): Promise<{ mimeType: MediaReference['mimeType']; width: number; height: number } | null>;
  readBundledMedia(reference: Immutable<MediaReference>): Promise<Uint8Array | null>;
}
export interface HydratedContent {
  meta: StoreMeta;
  snapshot: EffectiveContentSnapshot | null;
  retainedSnapshot: EffectiveContentSnapshot | null;
  archive: OverlayTrustArchive;
  packages: Map<string, { fingerprint: string; head: OverlayHead }>;
  firstVerifiedSequence: Map<string, number>;
  mediaVerifier: ContentMediaVerifier;
  verifyPackageMedia(value: StoredPackage, staged: boolean): Promise<void>;
}

/** Every cache below belongs to one settled SQL snapshot/transaction, never a durable trust flag. */
export async function hydrateContent(
  session: SqlSession,
  ports: ContentVerificationPorts,
  retainedRefs: readonly RecipeContentRef[] = [],
  retainedHead?: OverlayHead,
  latestRetainedRefs: readonly RecipeContentRef[] = [],
  inspectionRefs?: readonly RecipeContentRef[],
): Promise<HydratedContent> {
  await storageBounds(session);
  const meta = await readMeta(session);
  const rows = await session.all<{ release_id: string; sequence: number }>(
    "SELECT CASE WHEN typeof(release_id)='text' AND length(CAST(release_id AS BLOB))<=120 THEN release_id ELSE NULL END release_id,sequence FROM content_store_release ORDER BY sequence",
  );
  insist(rows.length === meta.highWater && rows.length <= CONTENT_STORE_LIMITS.releases);
  const [operations] = await session.all<{ count: number }>(
    'SELECT COUNT(*) count FROM content_store_operation',
  );
  insist(operations?.count === rows.length);
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>();
  const publications = new Map<string, PublishedRecipeRevision>();
  const packages = new Map<string, { fingerprint: string; head: OverlayHead }>();
  const firstVerifiedSequence = new Map(
    ports.baseline.revisions.map((revision) => [canonicalContentJson(revision.ref), 0]),
  );
  const baselineMedia = new Set(
    ports.baseline.revisions.flatMap((revision) =>
      revision.document.media.map((reference) => canonicalContentJson(reference)),
    ),
  );
  const checkedAssociations = new Set<string>();
  const checkedHashes = new Map<string, number>();
  let stagedMedia = new Set<string>();
  const archive: OverlayTrustArchive = {
    async readRelease(id) {
      return releases.get(id) ?? null;
    },
    async readPublication(recipeId, revisionId) {
      return publications.get(canonicalContentJson([recipeId, revisionId])) ?? null;
    },
  };
  const mediaVerifier: ContentMediaVerifier = {
    async verify(reference) {
      const association = canonicalContentJson(reference);
      if (checkedAssociations.has(association)) return true;
      let bytes = stagedMedia.has(reference.sha256)
        ? await readMediaBytes(session, 'content_store_stage_media', reference.sha256)
        : await readMediaBytes(session, 'content_store_media', reference.sha256);
      if (bytes === null && baselineMedia.has(association)) {
        const incoming = await ports.readBundledMedia(reference);
        if (!(incoming instanceof Uint8Array) || incoming.byteLength > CONTENT_LIMITS.mediaBytes)
          return false;
        bytes = incoming.slice();
      }
      if (
        !bytes ||
        bytes.length !== reference.bytes ||
        (await ports.sha256Bytes(bytes)) !== reference.sha256
      )
        return false;
      const facts = await ports.inspectImage(bytes);
      if (
        !facts ||
        facts.mimeType !== reference.mimeType ||
        !Number.isSafeInteger(facts.width) ||
        !Number.isSafeInteger(facts.height) ||
        facts.width <= 0 ||
        facts.height <= 0 ||
        facts.width > CONTENT_LIMITS.imageDimension ||
        facts.height > CONTENT_LIMITS.imageDimension ||
        (reference.dimensions &&
          (facts.width !== reference.dimensions.width ||
            facts.height !== reference.dimensions.height))
      )
        return false;
      checkedAssociations.add(association);
      return true;
    },
  };
  async function verifyPackageMedia(value: StoredPackage, staged: boolean) {
    const table = staged ? 'content_store_stage_media' : 'content_store_media';
    if (staged) {
      const rows = await session.all<{ hash: string; bytes: number }>(
        `SELECT CASE WHEN typeof(hash)='text' AND length(CAST(hash AS BLOB))=64 THEN hash ELSE NULL END hash,bytes FROM ${table} ORDER BY hash`,
      );
      insist(
        same(
          rows.map((row) => ({ sha256: row.hash, bytes: row.bytes })),
          value.media,
        ),
      );
      stagedMedia = new Set(value.media.map((item) => item.sha256));
    }
    for (const item of value.media) {
      const key = `${table}:${item.sha256}`;
      const verifiedLength = checkedHashes.get(key);
      if (verifiedLength !== undefined) {
        insist(item.bytes === verifiedLength);
        continue;
      }
      const bytes = await readMediaBytes(session, table, item.sha256);
      insist(
        bytes && bytes.length === item.bytes && (await ports.sha256Bytes(bytes)) === item.sha256,
      );
      checkedHashes.set(key, bytes.length);
    }
  }
  let current: OverlayHead | null = null;
  let snapshot: EffectiveContentSnapshot | null = null;
  let retainedSnapshot: EffectiveContentSnapshot | null = null;
  for (const [index, row] of rows.entries()) {
    insist(identifier(row.release_id) && row.sequence === index + 1);
    const value = await readPackage(session, 'content_store_release', row.release_id, ports.sha256);
    insist(value);
    await verifyPackageMedia(value, false);
    const selecting =
      retainedHead?.releaseId === row.release_id && retainedHead.sequence === row.sequence;
    // Only already verified predecessors are visible to the verifier. The current stored
    // release is deliberately absent, so replay remains distinct from trusting a raw archive.
    const verification = {
      ...ports,
      archive,
      mediaVerifier,
      expectedCurrent: current,
      minimumSequence: index,
      publications: value.publications,
      // Resolve old-head pins before later publications enter the authenticated archive.
      retainedRefs: [
        ...new Map(
          [
            ...(selecting || (!retainedHead && index === rows.length - 1) ? retainedRefs : []),
            ...(index === rows.length - 1 ? latestRetainedRefs : []),
          ].map((ref) => [canonicalContentJson(ref), ref]),
        ).values(),
      ],
    };
    snapshot = await verifySignedContentOverlay(value.envelope, verification);
    if (selecting && inspectionRefs) {
      // The first pass authenticates this release's new publications. Never use raw stored
      // publication metadata to decide whether an inspection ref predates the adopted head.
      const admitted = new Set([
        ...firstVerifiedSequence.keys(),
        ...(value.publications as PublishedRecipeRevision[]).map((publication) =>
          canonicalContentJson(publication.revision.ref),
        ),
      ]);
      const known = inspectionRefs.filter((ref) => admitted.has(canonicalContentJson(ref)));
      if (known.some((ref) => snapshot!.lookupExact(ref).kind === 'missing')) {
        // Resolve historic refs while the selected release remains absent from the archive.
        // Reuse this hydration's media facts; do not replay the chain once per requested ref.
        snapshot = await verifySignedContentOverlay(value.envelope, {
          ...verification,
          retainedRefs: known,
        });
      }
    }
    const envelope = value.envelope as SignedContentOverlay;
    insist(
      envelope.manifest.releaseId === row.release_id && envelope.manifest.sequence === row.sequence,
    );
    current = {
      releaseId: row.release_id,
      sequence: row.sequence,
      fingerprint: envelope.fingerprint,
    };
    const receipts = await session.all<{
      operation_id: string;
      fingerprint: string;
      receipt_json: string | null;
    }>(
      `SELECT CASE WHEN typeof(operation_id)='text' AND length(CAST(operation_id AS BLOB))<=120 THEN operation_id ELSE NULL END operation_id,CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint,CASE WHEN typeof(receipt_json)='text' AND length(CAST(receipt_json AS BLOB))<=4096 THEN receipt_json ELSE NULL END receipt_json FROM content_store_operation WHERE release_id=?`,
      [row.release_id],
    );
    insist(receipts.length === 1);
    const receipt = receipts[0]!;
    insist(identifier(receipt.operation_id) && receipt.fingerprint === value.fingerprint);
    const decision = parse(receipt.receipt_json, 4096) as Record<string, unknown>;
    insist(
      decision &&
        typeof decision === 'object' &&
        !Array.isArray(decision) &&
        Object.keys(decision).length === 6 &&
        decision.formatVersion === 1 &&
        decision.status === 'activated_in_content_store' &&
        decision.operationId === receipt.operation_id &&
        decision.packageFingerprint === value.fingerprint &&
        validateOverlayHead(decision.head) &&
        same(decision.head, current) &&
        typeof decision.activatedAt === 'string' &&
        isUtcInstant(decision.activatedAt),
    );
    if (selecting && same(current, retainedHead)) retainedSnapshot = snapshot;
    for (const publication of value.publications as PublishedRecipeRevision[]) {
      const key = canonicalContentJson([
        publication.revision.ref.recipeId,
        publication.revision.ref.revisionId,
      ]);
      const existing = publications.get(key);
      insist(!existing || same(existing, publication));
      publications.set(key, publication);
      const refKey = canonicalContentJson(publication.revision.ref);
      if (!firstVerifiedSequence.has(refKey)) firstVerifiedSequence.set(refKey, current.sequence);
    }
    releases.set(row.release_id, {
      manifest: envelope.manifest,
      fingerprint: envelope.fingerprint,
    });
    packages.set(row.release_id, { fingerprint: value.fingerprint, head: current });
  }
  insist(same(current, meta.head));
  return {
    meta,
    snapshot,
    retainedSnapshot,
    archive,
    packages,
    firstVerifiedSequence,
    mediaVerifier,
    verifyPackageMedia,
  };
}

/** One authenticated chain replay, with at most one additional selected-release verification. */
export async function inspectContentReferences(
  session: SqlSession,
  ports: ContentVerificationPorts,
  selectedHead: OverlayHead | null,
  refs: readonly RecipeContentRef[],
): Promise<{
  head: OverlayHead | null;
  latestHead: OverlayHead | null;
  adoptedRecipeIds: string[];
  entries: { ref: RecipeContentRef; lookup: ContentLookup }[];
}> {
  const hydrated = await hydrateContent(
    session,
    ports,
    [],
    selectedHead ?? undefined,
    [],
    selectedHead ? refs : undefined,
  );
  insist(!selectedHead || hydrated.retainedSnapshot, 'content_store_retained_head_unavailable');
  const baseline = new Map<string, ContentLookup>();
  if (selectedHead === null) {
    // A database without releases still has to authenticate packaged revision hashes/media.
    // Host-owned baseline input is not itself a verified body or a persisted trust flag.
    const ids = new Set<string>();
    insist(
      ports.baseline.revisions.length > 0 &&
        ports.baseline.revisions.length <= CONTENT_LIMITS.recipesPerRelease,
    );
    for (const input of ports.baseline.revisions) {
      const revision = await readRecipeContentRevision(input, ports.sha256);
      insist(
        revision.document.kind === 'imported' &&
          same(revision.document.provenance.catalogue, ports.baseline.identity) &&
          !ids.has(revision.ref.recipeId),
      );
      ids.add(revision.ref.recipeId);
      for (const media of revision.document.media)
        insist((await hydrated.mediaVerifier.verify(media)) === true);
      baseline.set(
        canonicalContentJson(revision.ref),
        own({
          kind: 'readable',
          state: 'current',
          value: {
            origin: 'packaged_baseline',
            revision,
            publication: null,
            retainedSources: [
              { ref: revision.ref, document: revision.document, disposition: 'original' },
            ],
          },
        }),
      );
    }
  }
  const withdrawals = new Map<string, ContentLookup>();
  for (const entry of hydrated.snapshot?.entries ?? []) {
    if (entry.state === 'withdrawn')
      withdrawals.set(
        entry.recipeId,
        own({ kind: 'withdrawn', recipeId: entry.recipeId, reason: entry.reason }),
      );
  }
  // Cumulative entries authenticate identity even when a body is archived or withdrawn.
  // Use only the selected head: cached later releases do not expand the adopted identity set.
  const adoptedRecipeIds = new Set(
    ports.baseline.revisions.map((revision) => revision.ref.recipeId),
  );
  for (const entry of hydrated.retainedSnapshot?.entries ?? [])
    adoptedRecipeIds.add(entry.state === 'withdrawn' ? entry.recipeId : entry.ref.recipeId);
  return {
    head: selectedHead,
    latestHead: hydrated.meta.head,
    adoptedRecipeIds: [...adoptedRecipeIds].sort(),
    entries: refs.map((ref) => ({
      ref,
      lookup: withdrawals.get(ref.recipeId) ??
        (selectedHead
          ? hydrated.retainedSnapshot!.lookupExact(ref)
          : baseline.get(canonicalContentJson(ref))) ?? { kind: 'missing' },
    })),
  };
}

export async function verifyStagedContent(
  ports: ContentVerificationPorts,
  value: StoredPackage,
  hydrated: HydratedContent,
  retainedRefs: readonly RecipeContentRef[],
): Promise<EffectiveContentSnapshot> {
  await hydrated.verifyPackageMedia(value, true);
  return verifySignedContentOverlay(value.envelope, {
    ...ports,
    archive: hydrated.archive,
    mediaVerifier: hydrated.mediaVerifier,
    expectedCurrent: hydrated.meta.head,
    minimumSequence: hydrated.meta.highWater,
    publications: value.publications,
    retainedRefs,
  });
}
export function publicHydration(value: HydratedContent) {
  return value.snapshot
    ? own({
        kind: 'active' as const,
        head: value.meta.head!,
        highWater: value.meta.highWater,
        snapshot: value.snapshot,
      })
    : own({ kind: 'baseline' as const, head: null, highWater: 0 });
}
