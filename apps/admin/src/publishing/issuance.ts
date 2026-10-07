import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  canonicalContentJson,
  createBundledContentSnapshot,
  verifySignedContentOverlay,
  validateContentOverlayManifest,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  TRANSLATED_PUBLICATION_READER_VERSION,
  type ContentOverlayManifest,
  type OverlayEntry,
  type OverlayHead,
  type PublishedRecipeRevision,
  type ReleaseTrustVerifier,
} from '@cookmate/catalogue/content';
import { PreparedPublicationArchive, type PreparedPublicationReceipt } from './archive';
import {
  IssuedOverlayStore,
  fingerprintIssuanceRequest,
  type RetainedMediaBytes,
  type IssuedOverlayReceipt,
  type IssuedOverlayResolution,
} from './issuedStore';
import { createContentOverlaySigner } from './signer';
import type { Actor, AdminDatabase } from '../storage/database';
import type { AdminMedia } from '../media/service';
import { DraftRepository, sha256 } from '../drafts/repository';
import { requireRecentReviewIdentity } from '../drafts/rights';
import { requireAdmin } from '../auth/errors';
import { identifier } from '../drafts/validation';
import { validateDeliveryIdentity } from './delivery';
import { assertTranslationAuthority } from './translationSelection';

export interface IssueOverlayRequest {
  expectedHead: OverlayHead | null;
  /** Complete cumulative membership, including any prior archives/withdrawals. */
  entries: OverlayEntry[];
}
const hash = async (value: string) => sha256(value);
const same = (a: unknown, b: unknown) => canonicalContentJson(a) === canonicalContentJson(b);
const maximumStagedMediaBytes = 64 * 1024 * 1024;
function operationIdentity(operationId: string, fingerprint?: string) {
  identifier(operationId);
  requireAdmin(
    !/[^A-Za-z0-9_-]/.test(operationId),
    400,
    'invalid_release_request',
    'Use the exact release operation identifier.',
  );
  if (fingerprint !== undefined)
    requireAdmin(
      typeof fingerprint === 'string' &&
        fingerprint.length === 64 &&
        /^[a-f0-9]{64}$/.test(fingerprint),
      400,
      'invalid_release_request',
      'Use the exact release request fingerprint to recover its result.',
    );
}

/** Private server issuance only; does not activate a release in any client. */
export class ContentOverlayIssuer {
  constructor(
    private readonly options: {
      db: AdminDatabase;
      prepared: PreparedPublicationArchive;
      issued: IssuedOverlayStore;
      media: Pick<AdminMedia, 'asset' | 'baseline'>;
      signer: ReturnType<typeof createContentOverlaySigner>;
      trustVerifier: ReleaseTrustVerifier;
      now(): Date;
    },
  ) {}

  private exportAuthority(inputActor: Actor, releaseId: string, mediaHash?: string) {
    validateDeliveryIdentity(releaseId, mediaHash);
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    const authorize = () =>
      this.options.db.assertActor(actor, this.options.now().getTime(), ['administrator']);
    return authorize;
  }

  /** Administrator export only; this does not attest any consumer's current adoption policy. */
  async exportPackage(inputActor: Actor, releaseId: string) {
    const authorize = this.exportAuthority(inputActor, releaseId);
    authorize();
    const result = await this.options.issued.delivery(releaseId);
    authorize();
    return result.package;
  }

  async exportMedia(inputActor: Actor, releaseId: string, mediaHash: string) {
    const authorize = this.exportAuthority(inputActor, releaseId, mediaHash);
    authorize();
    const result = (await this.options.issued.delivery(releaseId, mediaHash)).media;
    authorize();
    requireAdmin(result, 500, 'issued_integrity', 'Retained release data failed verification.');
    return result;
  }

  /** Read-only, signature-checked head for review; not evidence of client adoption. */
  async current(
    inputActor: Actor,
  ): Promise<{ head: OverlayHead | null; manifest: ContentOverlayManifest | null }> {
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    const authorize = () =>
      this.options.db.assertActor(actor, this.options.now().getTime(), ['administrator']);
    return this.readCurrent(authorize);
  }

  /** Library-only read capability. Issuance, full recovery and export remain administrator-only. */
  async libraryCurrent(inputActor: Actor) {
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    return this.readCurrent(() => this.options.db.assertActor(actor, this.options.now().getTime()));
  }

  assertLibraryHead(inputActor: Actor, expected: OverlayHead | null) {
    this.options.db.assertActor(inputActor, this.options.now().getTime());
    requireAdmin(
      same(this.options.issued.head(), expected),
      409,
      'library_changed',
      'The signed release changed while reading the library. Refresh the list.',
    );
  }

  private async readCurrent(
    authorize: () => unknown,
  ): Promise<{ head: OverlayHead | null; manifest: ContentOverlayManifest | null }> {
    authorize();
    const head = this.options.issued.head();
    if (head === null) return { head: null, manifest: null };
    const release = await this.options.issued.readRelease(head.releaseId);
    authorize();
    requireAdmin(
      release &&
        release.manifest.sequence === head.sequence &&
        release.fingerprint === head.fingerprint,
      500,
      'issued_integrity',
      'Retained release data failed verification.',
    );
    return { head, manifest: release.manifest };
  }

  /** Exact actor/request recovery accepts expired recent authentication, never a revoked session. */
  async recover(
    inputActor: Actor,
    operationId: string,
    requestFingerprint: string,
  ): Promise<IssuedOverlayReceipt> {
    operationIdentity(operationId, requestFingerprint);
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    const authorize = () =>
      this.options.db.assertActor(actor, this.options.now().getTime(), ['administrator']);
    authorize();
    const receipt = await this.options.issued.receipt(
      actor.user.userId,
      operationId,
      requestFingerprint,
    );
    authorize();
    requireAdmin(
      receipt,
      404,
      'issuance_unknown',
      'No confirmed release result was found for this operator and request.',
    );
    return receipt;
  }

  async resolve(
    inputActor: Actor,
    operationId: string,
    requestFingerprint: string,
  ): Promise<IssuedOverlayResolution> {
    operationIdentity(operationId, requestFingerprint);
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    const authorize = () =>
      this.options.db.assertActor(actor, this.options.now().getTime(), ['administrator']);
    authorize();
    // Match issuance lock order: hold current administrator authority until the journal decision commits.
    const result = this.options.db.transaction(() =>
      this.options.issued.resolve(actor.user.userId, operationId, requestFingerprint, authorize),
    );
    if (result.status === 'committed') {
      const receipt = await this.options.issued.receipt(
        actor.user.userId,
        operationId,
        requestFingerprint,
      );
      authorize();
      requireAdmin(receipt, 500, 'issued_integrity', 'Retained release data failed verification.');
      return { status: 'committed', receipt };
    }
    authorize();
    return result;
  }

  async issue(
    inputActor: Actor,
    operationId: string,
    input: IssueOverlayRequest,
  ): Promise<IssuedOverlayReceipt> {
    operationIdentity(operationId);
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    const request: IssueOverlayRequest = JSON.parse(
      canonicalContentJson(input, CONTENT_LIMITS.releaseBytes),
    );
    requireAdmin(
      request &&
        Object.keys(request).length === 2 &&
        Object.hasOwn(request, 'expectedHead') &&
        Object.hasOwn(request, 'entries'),
      400,
      'invalid_release_request',
      'Supply the expected release and cumulative content entries.',
    );
    const { db, prepared, issued, media, signer, trustVerifier, now } = this.options;
    const authorize = () => {
      db.assertActor(actor, now().getTime(), ['administrator']);
    };
    authorize();
    const digest = fingerprintIssuanceRequest(request.expectedHead, request.entries);
    const replay = await issued.receipt(actor.user.userId, operationId, digest);
    if (replay) {
      authorize();
      return replay;
    }
    requireRecentReviewIdentity(db, actor, now().getTime());
    requireAdmin(
      same(issued.head(), request.expectedHead),
      409,
      'release_head_changed',
      'Review the current release before issuing this update.',
    );
    const priorRelease = request.expectedHead
      ? await issued.readRelease(request.expectedHead.releaseId)
      : null;
    authorize();
    requireAdmin(
      !request.expectedHead ||
        (priorRelease &&
          priorRelease.fingerprint === request.expectedHead.fingerprint &&
          priorRelease.manifest.sequence === request.expectedHead.sequence),
      500,
      'issued_integrity',
      'The preceding signed release could not be verified.',
    );
    const baseline = await createBundledContentSnapshot(hash);
    const packagedMedia = new Set(
      baseline.revisions.flatMap((revision) =>
        revision.document.media.map((ref) => canonicalContentJson(ref)),
      ),
    );
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `release-${randomUUID()}`,
      sequence: (request.expectedHead?.sequence ?? 0) + 1,
      previous: request.expectedHead,
      createdAt: now().toISOString(),
      minimumReaderVersion: priorRelease?.manifest.minimumReaderVersion ?? 1,
      baseline: { ...baseline.catalogue },
      entries: request.entries,
    };
    const publications: PublishedRecipeRevision[] = [];
    const preparations: Pick<
      PreparedPublicationReceipt,
      'draftId' | 'draftRevision' | 'approval' | 'request' | 'translationEvidence'
    >[] = [];
    let publicationBytes = 0;
    for (const entry of request.entries) {
      if (entry.state === 'withdrawn' || entry.publicationFingerprint === null) continue;
      const existing = await issued.readPublication(entry.ref.recipeId, entry.ref.revisionId);
      if (existing) {
        if (existing.formatVersion === 3)
          manifest.minimumReaderVersion = Math.max(
            manifest.minimumReaderVersion,
            TRANSLATED_PUBLICATION_READER_VERSION,
          );
        continue;
      }
      requireAdmin(
        publications.length < OVERLAY_LIMITS.publications,
        413,
        'release_content_limit',
        'Issue a smaller update; reviewed publications exceed this operation’s content budget.',
      );
      const receipt = await prepared.readRevision(actor, entry.ref.recipeId, entry.ref.revisionId);
      requireAdmin(
        receipt &&
          same(receipt.publication.revision.ref, entry.ref) &&
          receipt.publication.publicationFingerprint === entry.publicationFingerprint,
        409,
        'preparation_required',
        'Every new revision must match its retained reviewed preparation.',
      );
      const publicationJson = canonicalContentJson(receipt.publication);
      publicationBytes += Buffer.byteLength(publicationJson, 'utf8');
      requireAdmin(
        publicationBytes <= OVERLAY_LIMITS.aggregateContentBytes,
        413,
        'release_content_limit',
        'Issue a smaller update; reviewed publications exceed this operation’s content budget.',
      );
      preparations.push({
        draftId: receipt.draftId,
        draftRevision: receipt.draftRevision,
        approval: { ...receipt.approval },
        request: receipt.request,
        ...(receipt.translationEvidence
          ? { translationEvidence: receipt.translationEvidence }
          : {}),
      });
      if (receipt.publication.formatVersion === 3)
        manifest.minimumReaderVersion = Math.max(
          manifest.minimumReaderVersion,
          TRANSLATED_PUBLICATION_READER_VERSION,
        );
      publications.push(JSON.parse(publicationJson) as PublishedRecipeRevision);
    }
    requireAdmin(
      validateContentOverlayManifest(manifest),
      400,
      'invalid_release_request',
      'The proposed content release is invalid.',
    );
    const staged = new Map<string, RetainedMediaBytes>();
    let stagedBytes = 0;
    const envelope = await signer.signManifest(manifest);
    const snapshot = await verifySignedContentOverlay(envelope, {
      sha256: hash,
      trustVerifier,
      archive: issued,
      baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
      expectedCurrent: request.expectedHead,
      minimumSequence: request.expectedHead?.sequence ?? 0,
      readerVersion: TRANSLATED_PUBLICATION_READER_VERSION,
      publications,
      mediaVerifier: {
        async verify(ref) {
          // Original source files have no recorded dimensions. Only exact independently
          // packaged references retain that exception; published media needs review evidence.
          if (!ref.dimensions && !packagedMedia.has(canonicalContentJson(ref))) return false;
          let bytes = staged.get(ref.sha256)?.bytes ?? issued.media(ref.sha256);
          if (!bytes) {
            const source =
              ref.photoKey === `photos/${ref.sha256}.webp`
                ? await media.asset(ref.sha256)
                : await media.baseline(ref.recipeId);
            if (source.mimeType !== ref.mimeType) return false;
            bytes = source.bytes;
          }
          if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) return false;
          const decoder = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' }).timeout(
            { seconds: 15 },
          );
          try {
            const facts = await decoder.metadata();
            if (
              !facts.width ||
              !facts.height ||
              (ref.dimensions &&
                (facts.width !== ref.dimensions.width || facts.height !== ref.dimensions.height)) ||
              (facts.pages ?? 1) !== 1 ||
              `image/${facts.format}` !== ref.mimeType
            )
              return false;
          } finally {
            decoder.destroy();
          }
          if (!staged.has(ref.sha256)) {
            stagedBytes += bytes.length;
            requireAdmin(
              stagedBytes <= maximumStagedMediaBytes,
              413,
              'release_media_limit',
              'Issue a smaller update; retained media exceeds this operation’s memory budget.',
            );
            staged.set(ref.sha256, { hash: ref.sha256, bytes: Buffer.from(bytes) });
          }
          return true;
        },
      },
    });
    const receipt: IssuedOverlayReceipt = {
      status: 'issued_not_activated',
      operationId,
      actorId: actor.user.userId,
      requestFingerprint: digest,
      envelope: JSON.parse(canonicalContentJson(snapshot.envelope, CONTENT_LIMITS.releaseBytes)),
    };
    // Hold the admin writer lock across the synchronous journal commit so another process
    // cannot revoke the session or change approval between the final check and issuance.
    db.transaction(() =>
      issued.commit({
        receipt,
        expectedHead: request.expectedHead,
        publications,
        media: [...staged.values()],
        assertActor: authorize,
        assertAuthority: () => {
          requireRecentReviewIdentity(db, actor, now().getTime());
          const drafts = new DraftRepository(db, now);
          for (const retained of preparations) {
            const latest = drafts.read(retained.draftId);
            requireAdmin(
              latest.revision === retained.draftRevision &&
                latest.status === 'reviewed' &&
                same(latest.approval, retained.approval),
              409,
              'approval_changed',
              'A prepared draft or its permission review changed before issuance.',
            );
            assertTranslationAuthority(
              db,
              now,
              latest,
              retained.request.translations,
              retained.translationEvidence,
            );
          }
        },
      }),
    );
    const result = await issued.receipt(actor.user.userId, operationId, digest);
    authorize();
    requireAdmin(
      result,
      500,
      'issuance_unconfirmed',
      'The release result is unconfirmed. Recover using the same operation.',
    );
    return result;
  }
}
