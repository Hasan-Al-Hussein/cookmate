import {
  canonicalContentJson,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  validateRecipeContentRef,
  type ContentOverlayManifest,
  type ContentLookup,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import { isUtcInstant } from '@cookmate/contracts';
import {
  configureConnection,
  runBound,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlConnection,
  type SqlSession,
} from './sql';
import {
  CONTENT_STORE_LIMITS,
  digest,
  head,
  identifier,
  initializeContentStore,
  insist,
  own,
  packageFingerprint,
  parse,
  readMeta,
  readPackage,
  same,
  storageBounds,
  writeMediaBytes,
  type StoredPackage,
} from './contentReleaseStoreSchema';
import {
  hydrateContent,
  inspectContentReferences,
  publicHydration,
  verifyStagedContent,
  type ContentVerificationPorts,
  type HydratedContent,
} from './contentReleaseStoreVerification';
import { createContentReadingMedia, type VerifiedContentPhoto } from './contentReadingMedia';

export { CONTENT_STORE_LIMITS, ContentStoreFault } from './contentReleaseStoreSchema';
export type { ContentVerificationPorts } from './contentReleaseStoreVerification';
export interface ContentReleaseStageInput {
  stageId: string;
  envelope: unknown;
  publications: readonly unknown[];
  media: readonly { sha256: string; bytes: Uint8Array }[];
}
export interface ContentReleaseStage {
  stageId: string;
  stageEpoch: number;
  packageFingerprint: string;
  publicationCount: number;
  mediaBytes: number;
}
export interface ContentReleaseReview extends ContentReleaseStage {
  expectedHead: OverlayHead | null;
  highWater: number;
  head: OverlayHead;
  manifest: ContentOverlayManifest;
  retainedRefCount: number;
}
export interface ContentActivationReceipt {
  formatVersion: 1;
  status: 'activated_in_content_store';
  operationId: string;
  packageFingerprint: string;
  head: OverlayHead;
  activatedAt: string;
}
/** A previously committed app-adoption view; it does not activate or roll back the content store. */
export interface RetainedContentHead {
  kind: 'retained';
  selectedHead: OverlayHead;
  latestHead: OverlayHead;
  highWater: number;
  snapshot: EffectiveContentSnapshot;
}
/** Host-only adoption transaction input. The old view is for exact-pin comparison, not discovery. */
export interface ContentAdoptionViews {
  previous: EffectiveContentSnapshot | null;
  candidate: EffectiveContentSnapshot;
  head: OverlayHead;
  /** Existing historical identities survive, but no withdrawn body is exposed by the candidate. */
  withdrawnRefs: readonly RecipeContentRef[];
}
export interface ContentReadingView {
  head: OverlayHead | null;
  latestHead: OverlayHead | null;
  snapshot: EffectiveContentSnapshot | null;
  hasWithdrawal: boolean;
  /** Valid only while the withVerifiedReading callback and store remain open. */
  readPhoto(ref: RecipeContentRef, assetId: string): Promise<VerifiedContentPhoto>;
  assertActive(): undefined;
}
export interface ContentReferenceInspectionView {
  head: OverlayHead | null;
  latestHead: OverlayHead | null;
  /** Authenticated identities at the adopted head, including archived/withdrawn IDs; no body authority. */
  adoptedRecipeIds: readonly string[];
  /** Body access belongs to this callback; consumers may retain only body-free inspection facts. */
  entries: readonly { ref: RecipeContentRef; lookup: ContentLookup }[];
  assertActive(): undefined;
}
export interface ContentReleaseStoreOptions extends ContentVerificationPorts {
  readConnection: SqlConnection;
  writeConnection: SqlConnection;
  now(): Date;
}
interface Capability {
  stageId: string;
  fingerprint: string;
  epoch: number;
  expectedHead: OverlayHead | null;
  highWater: number;
  pins: RecipeContentRef[];
}

function pins(input: readonly RecipeContentRef[]): RecipeContentRef[] {
  insist(
    Array.isArray(input) && input.length <= OVERLAY_LIMITS.retainedRefs,
    'content_store_limit',
  );
  const value: unknown = JSON.parse(canonicalContentJson(input, 512 * 1024));
  insist(
    Array.isArray(value) &&
      value.every(validateRecipeContentRef) &&
      new Set(value.map((item) => canonicalContentJson(item))).size === value.length,
  );
  return value;
}
function summary(
  stageId: string,
  value: StoredPackage,
  stageEpoch: number,
): Immutable<ContentReleaseStage> {
  return own({
    stageId,
    stageEpoch,
    packageFingerprint: value.fingerprint,
    publicationCount: value.publications.length,
    mediaBytes: value.media.reduce((sum, item) => sum + item.bytes, 0),
  });
}

/** Inactive foundation: callers must supply a separate content database, never the cooking store. */
export async function openContentReleaseStore(options: ContentReleaseStoreOptions) {
  insist(options.readConnection !== options.writeConnection, 'content_store_incompatible');
  const baseline = own(
    JSON.parse(canonicalContentJson(options.baseline)) as ContentVerificationPorts['baseline'],
  );
  insist(Number.isSafeInteger(options.readerVersion) && options.readerVersion > 0);
  const ports: ContentVerificationPorts = {
    baseline,
    readerVersion: options.readerVersion,
    trustVerifier: options.trustVerifier,
    sha256: options.sha256,
    sha256Bytes: options.sha256Bytes,
    inspectImage: options.inspectImage,
    readBundledMedia: options.readBundledMedia,
  };
  const queue = new SqlTransactionQueue();
  const reader = new SerializedReader(options.readConnection, queue),
    writer = new SerializedWriter(options.writeConnection, queue);
  const capabilities = new WeakMap<object, Capability>();
  let closed = false;
  try {
    await configureConnection(options.writeConnection);
    await configureConnection(options.readConnection);
    await writer.transaction(initializeContentStore, { kind: 'none' });
  } catch (error) {
    await Promise.allSettled([reader.close(), writer.close()]);
    throw error;
  }

  async function receipt(
    session: SqlSession,
    operationId: string,
    fingerprint: string,
    hydrated: HydratedContent,
  ): Promise<Immutable<ContentActivationReceipt> | null> {
    const [row] = await session.all<{
      release_id: string;
      fingerprint: string;
      receipt_json: string | null;
    }>(
      `SELECT CASE WHEN typeof(release_id)='text' AND length(CAST(release_id AS BLOB))<=120 THEN release_id ELSE NULL END release_id,CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint,CASE WHEN typeof(receipt_json)='text' AND length(CAST(receipt_json AS BLOB))<=4096 THEN receipt_json ELSE NULL END receipt_json FROM content_store_operation WHERE operation_id=?`,
      [operationId],
    );
    if (!row) return null;
    insist(row.fingerprint === fingerprint, 'operation_conflict');
    const retained = hydrated.packages.get(row.release_id);
    insist(retained && retained.fingerprint === fingerprint);
    const result = parse(row.receipt_json, 4096) as ContentActivationReceipt;
    insist(
      result &&
        Object.keys(result).length === 6 &&
        result.formatVersion === 1 &&
        result.status === 'activated_in_content_store' &&
        result.operationId === operationId &&
        result.packageFingerprint === fingerprint &&
        same(head(result.head), retained.head) &&
        isUtcInstant(result.activatedAt),
    );
    return own(result);
  }
  async function hydrate(retainedRefs: readonly RecipeContentRef[] = []) {
    const selected = pins(retainedRefs);
    return reader.transaction(
      async (session) => publicHydration(await hydrateContent(session, ports, selected)),
      { kind: 'read_only' },
    );
  }
  async function retainedInSnapshot(
    session: SqlSession,
    selectedHead: OverlayHead,
    selectedPins: readonly RecipeContentRef[],
  ): Promise<Immutable<RetainedContentHead>> {
    const hydrated = await hydrateContent(session, ports, selectedPins, selectedHead);
    const snapshot = hydrated.retainedSnapshot;
    insist(
      snapshot && hydrated.meta.head && hydrated.snapshot,
      'content_store_retained_head_unavailable',
    );
    const readablePins = new Set(
      selectedPins
        .filter((ref) => snapshot.lookupExact(ref).kind === 'readable')
        .map((ref) => ref.recipeId),
    );
    // A later authenticated withdrawal outranks an older app-adoption pointer. Do not
    // return any old body through discovery, archived membership or an exact pin.
    for (const entry of hydrated.snapshot.entries) {
      if (entry.state === 'withdrawn')
        insist(
          snapshot.lookupCurrent(entry.recipeId).kind !== 'readable' &&
            !readablePins.has(entry.recipeId),
          'content_store_adoption_policy_changed',
        );
    }
    insist(
      selectedPins.every((ref) => snapshot.lookupExact(ref).kind === 'readable'),
      'content_store_retained_ref_unavailable',
    );
    return own({
      kind: 'retained' as const,
      selectedHead,
      latestHead: hydrated.meta.head,
      highWater: hydrated.meta.highWater,
      snapshot,
    });
  }
  async function readRetainedHead(
    expectedHead: OverlayHead,
    retainedRefs: readonly RecipeContentRef[] = [],
  ): Promise<Immutable<RetainedContentHead>> {
    const selectedHead = head(JSON.parse(canonicalContentJson(expectedHead, 1024)));
    insist(selectedHead, 'content_store_retained_head_unavailable');
    const selectedPins = pins(retainedRefs);
    return reader.transaction(
      (session) => retainedInSnapshot(session, selectedHead, selectedPins),
      { kind: 'read_only' },
    );
  }
  /** Host-only: content reservation precedes cooking reads; callback must not reenter this store. */
  async function withVerifiedReading<Value>(
    expectedHead: OverlayHead | null,
    retainedRefs: readonly RecipeContentRef[],
    work: (view: Immutable<ContentReadingView>) => Promise<Value>,
  ): Promise<Value> {
    insist(!closed);
    const selectedHead = head(JSON.parse(canonicalContentJson(expectedHead, 1024)));
    const selectedPins = pins(retainedRefs);
    const result = await writer.transaction(
      async (session) => {
        let active = true;
        const assertActive = (): undefined => {
          insist(active && !closed);
          return undefined;
        };
        async function useView(
          view: Omit<ContentReadingView, 'readPhoto' | 'assertActive'>,
        ): Promise<Value> {
          assertActive();
          try {
            const value = await work(
              own({
                ...view,
                assertActive,
                readPhoto: createContentReadingMedia(
                  session,
                  ports,
                  view.snapshot,
                  view.hasWithdrawal,
                  assertActive,
                ),
              }),
            );
            assertActive();
            return value;
          } finally {
            active = false;
          }
        }
        if (selectedHead) {
          const retained = await retainedInSnapshot(session, selectedHead, selectedPins);
          return useView(
            own({
              head: selectedHead,
              latestHead: retained.latestHead,
              snapshot: retained.snapshot,
              hasWithdrawal: retained.snapshot.entries.some((entry) => entry.state === 'withdrawn'),
            }),
          );
        }
        const hydrated = await hydrateContent(session, ports);
        return useView(
          own({
            head: null,
            latestHead: hydrated.meta.head,
            snapshot: null,
            hasWithdrawal:
              hydrated.snapshot?.entries.some((entry) => entry.state === 'withdrawn') ?? false,
          }),
        );
      },
      { kind: 'read_only' },
    );
    // Closing may begin while the adapter awaits COMMIT after the callback has finished.
    insist(!closed);
    return result;
  }
  /** Host-only content-before-cooking reservation; callback must not reenter this store. */
  async function withVerifiedReferenceInspection<Value>(
    expectedHead: OverlayHead | null,
    refs: readonly RecipeContentRef[],
    work: (view: Immutable<ContentReferenceInspectionView>) => Promise<Value>,
  ): Promise<Value> {
    insist(!closed);
    const selectedHead = head(JSON.parse(canonicalContentJson(expectedHead, 1024)));
    insist(
      Array.isArray(refs) && refs.length <= OVERLAY_LIMITS.retainedRefs,
      'content_store_limit',
    );
    const owned: unknown = JSON.parse(canonicalContentJson(refs, 512 * 1024));
    insist(Array.isArray(owned) && owned.every(validateRecipeContentRef));
    const selected = [...new Map(owned.map((ref) => [canonicalContentJson(ref), ref])).values()];
    const result = await writer.transaction(
      async (session) => {
        let active = true;
        const assertActive = (): undefined => {
          insist(active && !closed);
          return undefined;
        };
        try {
          const inspected = own(
            await inspectContentReferences(session, ports, selectedHead, selected),
          );
          assertActive();
          const view: Immutable<ContentReferenceInspectionView> = Object.freeze({
            head: inspected.head,
            latestHead: inspected.latestHead,
            get adoptedRecipeIds() {
              assertActive();
              return inspected.adoptedRecipeIds;
            },
            get entries() {
              assertActive();
              return inspected.entries;
            },
            assertActive,
          });
          const value = await work(view);
          assertActive();
          return value;
        } finally {
          active = false;
        }
      },
      { kind: 'read_only' },
      () => {
        insist(!closed);
        return undefined;
      },
    );
    insist(!closed);
    return result;
  }
  /**
   * Hold a content writer reservation while a cooking transaction compares and commits its head.
   * Always acquire content before cooking; the callback must not re-enter this content store.
   * A successful callback does not itself mean adoption: only the cooking receipt establishes it.
   */
  async function withVerifiedAdoption<Value>(
    input: {
      previousHead: OverlayHead | null;
      candidateHead: OverlayHead;
      previousRefs: readonly RecipeContentRef[];
      retainedRefs: readonly RecipeContentRef[];
      preserveWithdrawnRefs?: readonly RecipeContentRef[];
    },
    work: (views: ContentAdoptionViews) => Promise<Value>,
  ): Promise<Value> {
    const previous = head(JSON.parse(canonicalContentJson(input.previousHead, 1024))),
      candidate = head(JSON.parse(canonicalContentJson(input.candidateHead, 1024))),
      previousPins = pins(input.previousRefs),
      selected = pins(input.retainedRefs),
      permittedWithdrawal = pins(input.preserveWithdrawnRefs ?? []);
    insist(candidate, 'content_store_retained_head_unavailable');
    pins([
      ...new Map(
        [...previousPins, ...selected].map((ref) => [canonicalContentJson(ref), ref]),
      ).values(),
    ]);
    const previousKeys = new Set(previousPins.map((ref) => canonicalContentJson(ref))),
      selectedKeys = new Set(selected.map((ref) => canonicalContentJson(ref))),
      withdrawalKeys = new Set(permittedWithdrawal.map((ref) => canonicalContentJson(ref)));
    insist(
      [...withdrawalKeys].every((key) => previousKeys.has(key) && selectedKeys.has(key)),
      'content_store_retained_ref_unavailable',
    );
    // BEGIN IMMEDIATE also excludes independent connections, including WAL-mode writers.
    return writer.transaction(
      async (session) => {
        const hydrated = await hydrateContent(
          session,
          ports,
          previousPins,
          previous ?? undefined,
          selected,
        );
        insist(same(hydrated.meta.head, candidate), 'head_changed');
        insist(hydrated.snapshot, 'content_store_retained_head_unavailable');
        insist(!previous || hydrated.retainedSnapshot, 'content_store_retained_head_unavailable');
        const withdrawnRefs: RecipeContentRef[] = [];
        // Historical identity is preservable only if the exact ref was authenticated before the
        // app's previous head. The candidate still returns withdrawn, never the old recipe body.
        insist(
          selected.every((ref) => {
            const result = hydrated.snapshot!.lookupExact(ref);
            if (result.kind === 'readable') return true;
            const key = canonicalContentJson(ref),
              first = hydrated.firstVerifiedSequence.get(key);
            if (
              result.kind !== 'withdrawn' ||
              !withdrawalKeys.has(key) ||
              first === undefined ||
              first > (previous?.sequence ?? 0)
            )
              return false;
            withdrawnRefs.push(ref);
            return true;
          }),
          'content_store_retained_ref_unavailable',
        );
        return work(
          Object.freeze({
            previous: previous ? hydrated.retainedSnapshot! : null,
            candidate: hydrated.snapshot,
            head: candidate,
            withdrawnRefs: own(withdrawnRefs),
          }),
        );
      },
      { kind: 'read_only' },
    );
  }
  async function stage(input: ContentReleaseStageInput): Promise<Immutable<ContentReleaseStage>> {
    insist(input && identifier(input.stageId));
    insist(
      Array.isArray(input.publications) &&
        input.publications.length <= OVERLAY_LIMITS.publications &&
        Array.isArray(input.media) &&
        input.media.length <= CONTENT_STORE_LIMITS.mediaCount,
      'content_store_limit',
    );
    // Check aggregate byte lengths before JSON clones, byte copies or hex expansion.
    let total = 0;
    const media = input.media
      .map((item) => {
        insist(
          item &&
            digest(item.sha256) &&
            item.bytes instanceof Uint8Array &&
            item.bytes.byteLength > 0 &&
            item.bytes.byteLength <= CONTENT_LIMITS.mediaBytes,
          'content_store_limit',
        );
        total += item.bytes.byteLength;
        insist(total <= CONTENT_STORE_LIMITS.stageMediaBytes, 'content_store_limit');
        return { sha256: item.sha256, bytes: item.bytes.byteLength, source: item.bytes };
      })
      .sort((a, b) => a.sha256.localeCompare(b.sha256));
    insist(new Set(media.map((item) => item.sha256)).size === media.length);
    const stageId = input.stageId;
    const envelopeJson = canonicalContentJson(input.envelope),
      publicationsJson = canonicalContentJson(input.publications),
      mediaJson = canonicalContentJson(media.map(({ sha256, bytes }) => ({ sha256, bytes })));
    const descriptors = JSON.parse(mediaJson) as StoredPackage['media'];
    const fingerprint = await packageFingerprint(
      ports.sha256,
      envelopeJson,
      publicationsJson,
      descriptors,
    );
    return writer.transaction(
      async (session) => {
        await storageBounds(session);
        const [pending] = await session.all<{ stage_id: string; fingerprint: string }>(
          "SELECT CASE WHEN typeof(stage_id)='text' AND length(CAST(stage_id AS BLOB))<=120 THEN stage_id ELSE NULL END stage_id,CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint FROM content_store_stage WHERE slot=1",
        );
        if (pending) {
          insist(
            pending.stage_id === stageId && pending.fingerprint === fingerprint,
            'stage_pending',
          );
          const existing = await readPackage(session, 'content_store_stage', stageId, ports.sha256);
          insist(existing);
          // A same-request retry still reads actual retained bytes before acknowledging staging.
          const hydrated = await hydrateContent(session, ports);
          await hydrated.verifyPackageMedia(existing, true);
          return summary(stageId, existing, hydrated.meta.stageEpoch);
        }
        await runBound(session, 'INSERT INTO content_store_stage VALUES(1,?,?,?,?,?)', [
          stageId,
          fingerprint,
          envelopeJson,
          publicationsJson,
          mediaJson,
        ]);
        for (const item of media) {
          const bytes = item.source.slice();
          insist(bytes.length === item.bytes && (await ports.sha256Bytes(bytes)) === item.sha256);
          await writeMediaBytes(session, item.sha256, bytes);
        }
        const meta = await readMeta(session);
        insist(meta.stageEpoch < Number.MAX_SAFE_INTEGER, 'content_store_limit');
        await runBound(session, 'UPDATE content_store_meta SET stage_epoch=? WHERE id=1', [
          meta.stageEpoch + 1,
        ]);
        const persisted = await readPackage(session, 'content_store_stage', stageId, ports.sha256);
        insist(persisted);
        return summary(stageId, persisted, meta.stageEpoch + 1);
      },
      { kind: 'none' },
    );
  }
  async function readStage(): Promise<Immutable<ContentReleaseStage> | null> {
    return reader.transaction(
      async (session) => {
        await storageBounds(session);
        const [row] = await session.all<{ stage_id: string }>(
          "SELECT CASE WHEN typeof(stage_id)='text' AND length(CAST(stage_id AS BLOB))<=120 THEN stage_id ELSE NULL END stage_id FROM content_store_stage WHERE slot=1",
        );
        if (!row) return null;
        insist(identifier(row.stage_id));
        const value = await readPackage(session, 'content_store_stage', row.stage_id, ports.sha256);
        insist(value);
        return summary(row.stage_id, value, (await readMeta(session)).stageEpoch);
      },
      { kind: 'read_only' },
    );
  }
  async function discardStage(
    stageId: string,
    fingerprint: string,
    stageEpoch: number,
  ): Promise<void> {
    insist(
      identifier(stageId) &&
        digest(fingerprint) &&
        Number.isSafeInteger(stageEpoch) &&
        stageEpoch > 0,
    );
    await writer.transaction(
      async (session) => {
        const value = await readPackage(session, 'content_store_stage', stageId, ports.sha256);
        insist(value && value.fingerprint === fingerprint, 'stage_changed');
        const meta = await readMeta(session);
        insist(meta.stageEpoch === stageEpoch, 'stage_changed');
        insist(meta.stageEpoch < Number.MAX_SAFE_INTEGER, 'content_store_limit');
        await session.exec('DELETE FROM content_store_stage WHERE slot=1');
        await runBound(session, 'UPDATE content_store_meta SET stage_epoch=? WHERE id=1', [
          meta.stageEpoch + 1,
        ]);
      },
      { kind: 'none' },
    );
  }
  async function reviewStage(
    stageId: string,
    input: { expectedHead: OverlayHead | null; retainedRefs: readonly RecipeContentRef[] },
  ): Promise<Immutable<ContentReleaseReview>> {
    insist(identifier(stageId));
    const expected = head(JSON.parse(canonicalContentJson(input.expectedHead, 1024))),
      selected = pins(input.retainedRefs);
    return reader.transaction(
      async (session) => {
        const hydrated = await hydrateContent(session, ports);
        insist(same(expected, hydrated.meta.head), 'head_changed');
        const value = await readPackage(session, 'content_store_stage', stageId, ports.sha256);
        insist(value, 'stage_changed');
        const snapshot = await verifyStagedContent(ports, value, hydrated, selected);
        const reviewedHead = {
          releaseId: snapshot.envelope.manifest.releaseId,
          sequence: snapshot.envelope.manifest.sequence,
          fingerprint: snapshot.envelope.fingerprint,
        };
        const review = own({
          ...summary(stageId, value, hydrated.meta.stageEpoch),
          expectedHead: expected,
          highWater: hydrated.meta.highWater,
          head: reviewedHead,
          manifest: JSON.parse(
            canonicalContentJson(snapshot.envelope.manifest),
          ) as ContentOverlayManifest,
          retainedRefCount: selected.length,
        });
        capabilities.set(review, {
          stageId,
          fingerprint: value.fingerprint,
          epoch: hydrated.meta.stageEpoch,
          expectedHead: expected,
          highWater: hydrated.meta.highWater,
          pins: selected,
        });
        return review;
      },
      { kind: 'read_only' },
    );
  }
  async function activate(
    review: Immutable<ContentReleaseReview>,
    operationId: string,
  ): Promise<Immutable<ContentActivationReceipt>> {
    const capability = review && capabilities.get(review);
    insist(capability && identifier(operationId), 'review_invalid');
    return writer.transaction(
      async (session) => {
        const hydrated = await hydrateContent(session, ports);
        const recovered = await receipt(session, operationId, capability.fingerprint, hydrated);
        if (recovered) return recovered;
        insist(
          same(hydrated.meta.head, capability.expectedHead) &&
            hydrated.meta.highWater === capability.highWater,
          'head_changed',
        );
        insist(hydrated.meta.stageEpoch === capability.epoch, 'stage_changed');
        const value = await readPackage(
          session,
          'content_store_stage',
          capability.stageId,
          ports.sha256,
        );
        insist(value && value.fingerprint === capability.fingerprint, 'stage_changed');
        const snapshot = await verifyStagedContent(ports, value, hydrated, capability.pins);
        insist(same(snapshot.envelope.manifest, review.manifest));
        const at = options.now().toISOString();
        insist(isUtcInstant(at));
        const result: ContentActivationReceipt = {
          formatVersion: 1,
          status: 'activated_in_content_store',
          operationId,
          packageFingerprint: value.fingerprint,
          head: {
            releaseId: snapshot.envelope.manifest.releaseId,
            sequence: snapshot.envelope.manifest.sequence,
            fingerprint: snapshot.envelope.fingerprint,
          },
          activatedAt: at,
        };
        insist(hydrated.meta.highWater < CONTENT_STORE_LIMITS.releases, 'content_store_limit');
        await runBound(session, 'INSERT INTO content_store_release VALUES(?,?,?,?,?,?)', [
          result.head.releaseId,
          result.head.sequence,
          value.fingerprint,
          value.envelopeJson,
          value.publicationsJson,
          value.mediaJson,
        ]);
        // Equal content hashes are immutable; compare actual persisted bytes before reusing them.
        const conflicts = await session.all<{ count: number }>(
          `SELECT COUNT(*) count FROM content_store_stage_media stage JOIN content_store_media archive ON archive.hash=stage.hash WHERE archive.bytes<>stage.bytes OR archive.hex<>stage.hex`,
        );
        insist(conflicts[0]?.count === 0);
        await session.exec(
          'INSERT INTO content_store_media SELECT hash,bytes,hex FROM content_store_stage_media WHERE hash NOT IN (SELECT hash FROM content_store_media)',
        );
        await storageBounds(session);
        await runBound(
          session,
          'UPDATE content_store_meta SET head_json=?,high_water=? WHERE id=1',
          [canonicalContentJson(result.head), result.head.sequence],
        );
        await runBound(session, 'INSERT INTO content_store_operation VALUES(?,?,?,?)', [
          operationId,
          result.head.releaseId,
          value.fingerprint,
          canonicalContentJson(result, 4096),
        ]);
        await session.exec('DELETE FROM content_store_stage WHERE slot=1');
        return own(result);
      },
      { kind: 'none' },
    );
  }
  async function recoverActivation(
    operationId: string,
    fingerprint: string,
  ): Promise<Immutable<ContentActivationReceipt> | null> {
    insist(identifier(operationId) && digest(fingerprint));
    return reader.transaction(
      async (session) =>
        receipt(session, operationId, fingerprint, await hydrateContent(session, ports)),
      { kind: 'read_only' },
    );
  }
  return Object.freeze({
    stage,
    readStage,
    discardStage,
    reviewStage,
    activate,
    recoverActivation,
    hydrate,
    readRetainedHead,
    withVerifiedReading,
    withVerifiedReferenceInspection,
    withVerifiedAdoption,
    close: async () => {
      closed = true;
      // Close both admission gates synchronously; the shared queue still drains each connection.
      const results = await Promise.allSettled([reader.close(), writer.close()]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Content store close failed',
        );
    },
  });
}
