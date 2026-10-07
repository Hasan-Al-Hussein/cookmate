import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  TRANSLATED_PUBLICATION_READER_VERSION,
  ContentValidationError,
  readPublishedRecipeRevision,
  type OverlayHead,
  type OverlayEntry,
  type OverlayTrustArchive,
  type PublishedRecipeRevision,
  type SignedContentOverlay,
  type ReleaseTrustVerifier,
} from '@cookmate/catalogue/content';
import { requireAdmin } from '../auth/errors';
import { sha256 } from '../drafts/repository';
import { captureIssuedDelivery, verifyIssuedDelivery, verifyIssuedEnvelope } from './delivery';

export interface IssuedOverlayReceipt {
  status: 'issued_not_activated';
  operationId: string;
  actorId: string;
  requestFingerprint: string;
  envelope: SignedContentOverlay;
}
export type IssuedOverlayResolution =
  | { status: 'committed'; receipt: IssuedOverlayReceipt }
  | { status: 'cancelled'; operationId: string; actorId: string; requestFingerprint: string };
export interface RetainedMediaBytes {
  hash: string;
  bytes: Buffer;
}
const hash = async (value: string) => sha256(value);
const same = (a: unknown, b: unknown) => canonicalContentJson(a) === canonicalContentJson(b);
function integrity(condition: unknown): asserts condition {
  requireAdmin(condition, 500, 'issued_integrity', 'Retained release data failed verification.');
}
const maxDocumentBytes = CONTENT_LIMITS.releaseBytes;
function parse(text: unknown): unknown {
  integrity(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= maxDocumentBytes);
  try {
    return JSON.parse(text);
  } catch {
    integrity(false);
  }
}
export function fingerprintIssuanceRequest(
  expectedHead: OverlayHead | null,
  entries: readonly OverlayEntry[],
) {
  return sha256(canonicalContentJson(['cookmate-issue-overlay-v2', { expectedHead, entries }]));
}

/** Separate private journal: opening it never migrates the admin or cooking database. */
export class IssuedOverlayStore implements OverlayTrustArchive {
  private readonly sql: DatabaseSync;
  constructor(
    filename: string,
    private readonly verifier: ReleaseTrustVerifier,
  ) {
    if (filename !== ':memory:') {
      try {
        const file = lstatSync(filename);
        integrity(file.isFile() && !file.isSymbolicLink());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.sql = new DatabaseSync(filename);
    try {
      this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
      const tables = this.sql
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      if (!tables.length)
        this.sql.exec(`BEGIN IMMEDIATE;
        CREATE TABLE issued_meta(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, head TEXT);
        INSERT INTO issued_meta VALUES(1,1,NULL);
        CREATE TABLE issued_release(id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, document TEXT NOT NULL);
        CREATE TABLE issued_publication(recipe TEXT NOT NULL, revision TEXT NOT NULL, release_id TEXT NOT NULL REFERENCES issued_release(id), document TEXT NOT NULL, PRIMARY KEY(recipe,revision));
        CREATE TABLE issued_media(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
        CREATE TABLE issued_operation(actor TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, release_id TEXT NOT NULL REFERENCES issued_release(id), PRIMARY KEY(actor,operation));
        COMMIT;`);
      const meta = this.sql.prepare('SELECT version FROM issued_meta WHERE id=1').get();
      integrity(meta?.version === 1 || meta?.version === 2);
      if (meta.version === 1) {
        this.sql.exec('BEGIN IMMEDIATE');
        try {
          this.sql.exec(`CREATE TABLE issued_cancelled(
            actor TEXT NOT NULL, operation TEXT NOT NULL,
            fingerprint TEXT NOT NULL CHECK(typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
            PRIMARY KEY(actor,operation));
            UPDATE issued_meta SET version=2 WHERE id=1; COMMIT;`);
        } catch (error) {
          this.sql.exec('ROLLBACK');
          throw error;
        }
      }
      integrity(
        this.sql
          .prepare(
            "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='issued_cancelled'",
          )
          .get(),
      );
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  close() {
    this.sql.close();
  }
  head(): OverlayHead | null {
    const row = this.sql
      .prepare(
        `SELECT length(CAST(head AS BLOB)) size,
      CASE WHEN typeof(head)='text' AND length(CAST(head AS BLOB))<=1024 THEN head ELSE NULL END head
      FROM issued_meta WHERE id=1`,
      )
      .get();
    integrity(row);
    if (row.size === null) return null;
    const head = parse(row.head) as OverlayHead;
    integrity(
      head &&
        Object.keys(head).length === 3 &&
        typeof head.releaseId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(head.releaseId) &&
        Number.isSafeInteger(head.sequence) &&
        head.sequence > 0 &&
        typeof head.fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(head.fingerprint),
    );
    return head;
  }
  private async envelope(id: string): Promise<SignedContentOverlay | null> {
    const row = this.sql
      .prepare(
        `SELECT sequence,
      CASE WHEN typeof(document)='text' AND length(CAST(document AS BLOB))<=? THEN document ELSE NULL END document
      FROM issued_release WHERE id=?`,
      )
      .get(maxDocumentBytes, id);
    if (!row) return null;
    return verifyIssuedEnvelope(row.document, id, row.sequence, this.verifier);
  }
  async delivery(releaseId: string, mediaHash?: string) {
    try {
      return await verifyIssuedDelivery(
        captureIssuedDelivery(this.sql, releaseId, mediaHash),
        this.verifier,
      );
    } catch (error) {
      if (error instanceof ContentValidationError) integrity(false);
      throw error;
    }
  }
  async readRelease(id: string) {
    const envelope = await this.envelope(id);
    return envelope ? { manifest: envelope.manifest, fingerprint: envelope.fingerprint } : null;
  }
  async readPublication(
    recipeId: string,
    revisionId: string,
  ): Promise<PublishedRecipeRevision | null> {
    const row = this.sql
      .prepare(
        `SELECT CASE WHEN typeof(release_id)='text' AND length(CAST(release_id AS BLOB))<=120 THEN release_id ELSE NULL END release_id,
        CASE WHEN typeof(document)='text' AND length(CAST(document AS BLOB))<=? THEN document ELSE NULL END document
        FROM issued_publication WHERE recipe=? AND revision=?`,
      )
      .get(maxDocumentBytes, recipeId, revisionId);
    if (!row) return null;
    const publication = await readPublishedRecipeRevision(parse(row.document as string), hash);
    integrity(
      publication.revision.ref.recipeId === recipeId &&
        publication.revision.ref.revisionId === revisionId,
    );
    integrity(typeof row.release_id === 'string');
    const envelope = await this.envelope(row.release_id);
    integrity(
      envelope &&
        (publication.formatVersion !== 3 ||
          envelope.manifest.minimumReaderVersion >= TRANSLATED_PUBLICATION_READER_VERSION),
    );
    integrity(
      envelope?.manifest.entries.some(
        (entry) =>
          entry.state !== 'withdrawn' &&
          same(entry.ref, publication.revision.ref) &&
          entry.publicationFingerprint === publication.publicationFingerprint,
      ),
    );
    return JSON.parse(canonicalContentJson(publication)) as PublishedRecipeRevision;
  }
  media(hash: string): Buffer | null {
    const row = this.sql
      .prepare(
        `SELECT CASE WHEN typeof(bytes)='blob' AND length(CAST(bytes AS BLOB))<=? THEN bytes ELSE NULL END bytes
      FROM issued_media WHERE hash=?`,
      )
      .get(CONTENT_LIMITS.mediaBytes, hash);
    if (!row) return null;
    integrity(row.bytes instanceof Uint8Array && row.bytes.length > 0);
    const bytes = Buffer.from(row.bytes as Uint8Array);
    integrity(sha256(bytes) === hash);
    return bytes;
  }
  async receipt(
    actorId: string,
    operationId: string,
    expectedFingerprint: string,
  ): Promise<IssuedOverlayReceipt | null> {
    this.assertNotCancelled(actorId, operationId, expectedFingerprint);
    const row = this.sql
      .prepare(
        `SELECT CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint,
        CASE WHEN typeof(release_id)='text' AND length(CAST(release_id AS BLOB))<=120 THEN release_id ELSE NULL END release_id
        FROM issued_operation WHERE actor=? AND operation=?`,
      )
      .get(actorId, operationId);
    if (!row) return null;
    requireAdmin(
      row.fingerprint === expectedFingerprint,
      409,
      'operation_conflict',
      'This operation was already used for a different release request.',
    );
    integrity(typeof row.release_id === 'string');
    const envelope = await this.envelope(row.release_id);
    integrity(envelope);
    integrity(
      fingerprintIssuanceRequest(envelope.manifest.previous, envelope.manifest.entries) ===
        expectedFingerprint,
    );
    return {
      status: 'issued_not_activated',
      actorId,
      operationId,
      requestFingerprint: expectedFingerprint,
      envelope: envelope!,
    };
  }
  private cancellation(actorId: string, operationId: string, fingerprint: string): boolean {
    const row = this.sql
      .prepare(
        `SELECT CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint
      FROM issued_cancelled WHERE actor=? AND operation=?`,
      )
      .get(actorId, operationId);
    if (!row) return false;
    integrity(typeof row.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint));
    requireAdmin(
      row.fingerprint === fingerprint,
      409,
      'operation_conflict',
      'This operation was already used for a different release request.',
    );
    integrity(
      !this.sql
        .prepare('SELECT 1 present FROM issued_operation WHERE actor=? AND operation=?')
        .get(actorId, operationId),
    );
    return true;
  }
  private assertNotCancelled(actorId: string, operationId: string, fingerprint: string) {
    requireAdmin(
      !this.cancellation(actorId, operationId, fingerprint),
      409,
      'operation_cancelled',
      'This exact release request was cancelled. Review the current release before creating a new operation.',
    );
  }
  /** The writer lock decides receipt-or-cancellation without an asynchronous gap. */
  resolve(
    actorId: string,
    operationId: string,
    requestFingerprint: string,
    assertActor: () => void,
  ): { status: 'committed' } | Extract<IssuedOverlayResolution, { status: 'cancelled' }> {
    let committed = false;
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      assertActor();
      if (!this.cancellation(actorId, operationId, requestFingerprint)) {
        const prior = this.sql
          .prepare(
            `SELECT CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint
          FROM issued_operation WHERE actor=? AND operation=?`,
          )
          .get(actorId, operationId);
        if (prior) {
          requireAdmin(
            prior.fingerprint === requestFingerprint,
            409,
            'operation_conflict',
            'This operation was already used for a different release request.',
          );
          committed = true;
        } else
          this.sql
            .prepare('INSERT INTO issued_cancelled VALUES(?,?,?)')
            .run(actorId, operationId, requestFingerprint);
      }
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
    if (!committed) return { status: 'cancelled', actorId, operationId, requestFingerprint };
    return { status: 'committed' };
  }
  /** Call only after full overlay/media verification. CAS and authority recheck are synchronous. */
  commit(input: {
    receipt: IssuedOverlayReceipt;
    expectedHead: OverlayHead | null;
    publications: readonly PublishedRecipeRevision[];
    media: readonly RetainedMediaBytes[];
    assertActor(): void;
    assertAuthority(): void;
  }): boolean {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      input.assertActor();
      const { receipt } = input;
      this.assertNotCancelled(receipt.actorId, receipt.operationId, receipt.requestFingerprint);
      const prior = this.sql
        .prepare(
          `SELECT CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint
          FROM issued_operation WHERE actor=? AND operation=?`,
        )
        .get(receipt.actorId, receipt.operationId);
      if (prior) {
        requireAdmin(
          prior.fingerprint === receipt.requestFingerprint,
          409,
          'operation_conflict',
          'This operation was already used for a different release request.',
        );
        this.sql.exec('COMMIT');
        return false;
      }
      input.assertAuthority();
      requireAdmin(
        same(this.head(), input.expectedHead),
        409,
        'release_head_changed',
        'A different release was issued. Review the new current release before retrying.',
      );
      const { manifest } = receipt.envelope;
      integrity(
        same(manifest.previous, input.expectedHead) &&
          manifest.sequence === (input.expectedHead?.sequence ?? 0) + 1,
      );
      this.sql
        .prepare('INSERT INTO issued_release VALUES(?,?,?)')
        .run(
          manifest.releaseId,
          manifest.sequence,
          canonicalContentJson(receipt.envelope, maxDocumentBytes),
        );
      for (const publication of input.publications) {
        integrity(
          publication.formatVersion !== 3 ||
            manifest.minimumReaderVersion >= TRANSLATED_PUBLICATION_READER_VERSION,
        );
        const ref = publication.revision.ref;
        const existing = this.sql
          .prepare(
            `SELECT CASE WHEN typeof(document)='text' AND length(CAST(document AS BLOB))<=? THEN document ELSE NULL END document
            FROM issued_publication WHERE recipe=? AND revision=?`,
          )
          .get(maxDocumentBytes, ref.recipeId, ref.revisionId);
        if (existing) integrity(same(parse(existing.document as string), publication));
        else
          this.sql
            .prepare('INSERT INTO issued_publication VALUES(?,?,?,?)')
            .run(
              ref.recipeId,
              ref.revisionId,
              manifest.releaseId,
              canonicalContentJson(publication, maxDocumentBytes),
            );
      }
      for (const media of input.media) {
        integrity(
          media.bytes.length > 0 &&
            media.bytes.length <= CONTENT_LIMITS.mediaBytes &&
            sha256(media.bytes) === media.hash,
        );
        this.sql
          .prepare('INSERT INTO issued_media VALUES(?,?) ON CONFLICT(hash) DO NOTHING')
          .run(media.hash, media.bytes);
        integrity(this.media(media.hash));
      }
      this.sql
        .prepare('INSERT INTO issued_operation VALUES(?,?,?,?)')
        .run(receipt.actorId, receipt.operationId, receipt.requestFingerprint, manifest.releaseId);
      const head: OverlayHead = {
        releaseId: manifest.releaseId,
        sequence: manifest.sequence,
        fingerprint: receipt.envelope.fingerprint,
      };
      this.sql.prepare('UPDATE issued_meta SET head=? WHERE id=1').run(canonicalContentJson(head));
      this.sql.exec('COMMIT');
      return true;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
}
