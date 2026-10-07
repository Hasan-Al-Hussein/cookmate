import { isUtcInstant } from '@cookmate/contracts';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  readPublishedRecipeRevision,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type {
  AdminUser,
  AdminPublicationTranslationSelection,
  AdminRetainedPublicationSummary,
} from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import type { AdminMedia } from '../media/service';
import { requireAdmin } from '../auth/errors';
import { DraftRepository, recordOperation, sha256 } from '../drafts/repository';
import { requireRecentReviewIdentity } from '../drafts/rights';
import { identifier, object, revision } from '../drafts/validation';
import { prepareReviewedPublication } from './prepare';
import {
  assertTranslationAuthority,
  ownTranslationSelections,
  PREPARATION_REQUEST_BYTES,
  validateRetainedTranslationEvidence,
} from './translationSelection';

export interface PreparationRequest {
  draftId: string;
  expectedRevision: number;
  revisionId: string;
  translations?: AdminPublicationTranslationSelection[];
}
type PreparedPackage = Awaited<ReturnType<typeof prepareReviewedPublication>>;
export type PreparedPublicationReceipt = PreparedPackage & {
  archiveVersion: 1 | 2;
  operationId: string;
  request: Readonly<PreparationRequest>;
  preparedAt: string;
  preparedBy: Readonly<AdminUser>;
};
export interface LibraryPreparationSummary {
  draftId: string;
  draftRevision: number;
  ref: RecipeContentRef;
  publicationFingerprint: string;
}
const LIBRARY_PREPARATION_LIMIT = 1000;
const LIBRARY_PREPARATION_BYTES = 64 * 1024 * 1024;
interface OperationRow {
  actor_id: string;
  kind: string;
  fingerprint: string;
  result_bytes: number;
  result: string | null;
}
interface IdentityPointer {
  operationId: string;
  recipeId: string;
  revisionId: string;
  publicationFingerprint: string;
  receiptFingerprint: string;
}

const OPERATION = 'prepare_publication';
const IDENTITY = 'prepare_publication_identity';
const RECEIPT_BYTES = 3 * 1024 * 1024;
const POINTER_BYTES = 4096;
const hash = async (value: string) => sha256(value);
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left) === canonicalContentJson(right);
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const immutableId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
function integrity(valid: unknown): asserts valid {
  requireAdmin(
    valid,
    500,
    'preparation_integrity',
    'The retained preparation could not be verified. No content was published.',
  );
}
const requestFingerprint = (request: Readonly<PreparationRequest>) =>
  sha256(
    canonicalContentJson([
      request.translations ? 'cookmate-private-preparation-v2' : 'cookmate-private-preparation-v1',
      request,
    ]),
  );
const receiptFingerprint = (receipt: unknown) =>
  sha256(canonicalContentJson(['cookmate-private-preparation-receipt-v1', receipt]));
// Public operation IDs cannot contain colons. This reserved primary key avoids scanning the journal.
const identityKey = (recipeId: string, revisionId: string) =>
  `prepare-publication:identity:${sha256(canonicalContentJson([recipeId, revisionId]))}`;

function ownRequest(value: unknown): PreparationRequest {
  const copy: unknown = JSON.parse(canonicalContentJson(value, PREPARATION_REQUEST_BYTES));
  object(copy, ['draftId', 'expectedRevision', 'revisionId'], ['translations']);
  identifier(copy.draftId);
  revision(copy.expectedRevision);
  requireAdmin(
    immutableId(copy.revisionId),
    400,
    'invalid_revision_id',
    'The content revision identifier is invalid.',
  );
  return {
    draftId: copy.draftId,
    expectedRevision: copy.expectedRevision,
    revisionId: copy.revisionId,
    ...(Object.hasOwn(copy, 'translations')
      ? { translations: ownTranslationSelections(copy.translations) }
      : {}),
  };
}
function parseBounded(value: string | null, maximum: number): unknown {
  integrity(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    integrity(false);
  }
  // Validate canonical JSON bounds before retaining caller-owned or stored object graphs.
  canonicalContentJson(parsed, maximum);
  return parsed;
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Private preparations only. A retained package is neither a signed release nor an activated recipe. */
export class PreparedPublicationArchive {
  constructor(
    private readonly db: AdminDatabase,
    private readonly media: Pick<AdminMedia, 'asset' | 'baseline'>,
    private readonly now: () => Date,
  ) {}

  private summaryRows(actorId?: string) {
    const filter = actorId === undefined ? '' : ' AND actor_id=?';
    const parameters =
      actorId === undefined ? [RECEIPT_BYTES, OPERATION] : [RECEIPT_BYTES, OPERATION, actorId];
    const budget = this.db.get<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count, COALESCE(SUM(length(CAST(result AS BLOB))),0) bytes,
       COALESCE(SUM(CASE WHEN typeof(operation_id)!='text' OR length(CAST(operation_id AS BLOB))>120
         OR typeof(actor_id)!='text' OR length(CAST(actor_id AS BLOB))>120
         OR typeof(fingerprint)!='text' OR length(CAST(fingerprint AS BLOB))>64
         OR typeof(result)!='text' OR length(CAST(result AS BLOB))>? THEN 1 ELSE 0 END),0) invalid
       FROM admin_operation WHERE kind=?${filter}`,
      ...parameters,
    )!;
    integrity(
      [budget.count, budget.bytes, budget.invalid].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) && budget.invalid === 0,
    );
    requireAdmin(
      budget.count <= LIBRARY_PREPARATION_LIMIT && budget.bytes <= LIBRARY_PREPARATION_BYTES,
      503,
      'library_preparation_limit',
      'The retained preparation history exceeds the supported library summary limit. No partial status or count was returned. Existing drafts and packages are unchanged.',
    );
    const rows = this.db.all<{ operation_id: string }>(
      `SELECT operation_id FROM admin_operation WHERE kind=?${filter} ORDER BY operation_id LIMIT ?`,
      ...(actorId === undefined
        ? [OPERATION, LIBRARY_PREPARATION_LIMIT + 1]
        : [OPERATION, actorId, LIBRARY_PREPARATION_LIMIT + 1]),
    );
    requireAdmin(
      rows.length === budget.count,
      409,
      'library_changed',
      'The library changed. Refresh the list.',
    );
    return rows;
  }
  /** Limited summaries for operators who already have private draft read access. */
  async librarySummaries(inputActor: Actor): Promise<LibraryPreparationSummary[]> {
    const actor: Actor = JSON.parse(canonicalContentJson(inputActor, 4096));
    const authorize = () => this.db.assertActor(actor, this.now().getTime());
    authorize();
    const rows = this.summaryRows();
    const summaries: LibraryPreparationSummary[] = [];
    for (const row of rows) {
      authorize();
      const retained = this.row(row.operation_id);
      integrity(retained);
      const receipt = await this.readStored(row.operation_id, retained);
      authorize();
      summaries.push({
        draftId: receipt.draftId,
        draftRevision: receipt.draftRevision,
        ref: { ...receipt.publication.revision.ref },
        publicationFingerprint: receipt.publication.publicationFingerprint,
      });
    }
    return summaries;
  }

  /** Finds original caller-owned operations after reload without deriving a request from a draft. */
  async retainedPreparations(
    inputActor: Actor,
    draftId: string,
  ): Promise<AdminRetainedPublicationSummary[]> {
    identifier(draftId);
    const actor = this.actor(inputActor);
    const rows = this.summaryRows(actor.user.userId);
    const items: AdminRetainedPublicationSummary[] = [];
    for (const row of rows) {
      this.db.assertActor(actor, this.now().getTime(), ['reviewer', 'administrator']);
      const stored = this.row(row.operation_id);
      integrity(stored && stored.actor_id === actor.user.userId);
      const receipt = await this.readAuthorized(actor, row.operation_id, stored);
      if (receipt.draftId !== draftId) continue;
      items.push({
        operationId: receipt.operationId,
        draftRevision: receipt.draftRevision,
        revisionId: receipt.request.revisionId,
        translations:
          receipt.publication.formatVersion === 3
            ? receipt.publication.translations.map(
                ({ translationId, translationRevision, targetLanguage }) => ({
                  translationId,
                  translationRevision,
                  targetLanguage,
                }),
              )
            : [],
      });
    }
    this.db.assertActor(actor, this.now().getTime(), ['reviewer', 'administrator']);
    return freeze(items);
  }

  private row(operationId: string, maximum = RECEIPT_BYTES): OperationRow | undefined {
    const row = this.db.get<OperationRow>(
      `SELECT
       CASE WHEN typeof(actor_id)='text' AND length(CAST(actor_id AS BLOB))<=120 THEN actor_id ELSE NULL END AS actor_id,
       CASE WHEN typeof(kind)='text' AND length(CAST(kind AS BLOB))<=80 THEN kind ELSE NULL END AS kind,
       CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))<=64 THEN fingerprint ELSE NULL END AS fingerprint,
       length(CAST(result AS BLOB)) AS result_bytes,
       CASE WHEN typeof(result)='text' AND length(CAST(result AS BLOB))<=? THEN result ELSE NULL END AS result
       FROM admin_operation WHERE operation_id=?`,
      maximum,
      operationId,
    );
    if (row)
      integrity(
        typeof row.actor_id === 'string' &&
          typeof row.kind === 'string' &&
          typeof row.fingerprint === 'string',
      );
    return row;
  }
  private actor(input: Actor): Actor {
    const actor = freeze(JSON.parse(canonicalContentJson(input, 4096)) as Actor);
    const user = this.db.assertActor(actor, this.now().getTime(), ['reviewer', 'administrator']);
    return freeze({
      ...actor,
      user: { userId: user.userId, username: user.username, role: user.role },
    });
  }
  private replay(
    actor: Actor,
    operationId: string,
    expectedFingerprint: string,
  ): OperationRow | null {
    const row = this.row(operationId);
    if (!row) return null;
    requireAdmin(
      row.actor_id !== actor.user.userId || row.kind !== 'cancelled',
      409,
      'operation_cancelled',
      'This operation was cancelled. It cannot prepare content.',
    );
    requireAdmin(
      row.actor_id === actor.user.userId &&
        row.kind === OPERATION &&
        row.fingerprint === expectedFingerprint,
      409,
      'operation_conflict',
      'This operation identifier was already used for a different request.',
    );
    return row;
  }

  private async readStored(
    operationId: string,
    row: OperationRow,
  ): Promise<PreparedPublicationReceipt> {
    const raw = parseBounded(row.result, RECEIPT_BYTES);
    integrity(
      exact(raw, [
        'publication',
        'draftId',
        'draftRevision',
        'approval',
        'originalEvidence',
        'status',
        'archiveVersion',
        'operationId',
        'request',
        'preparedAt',
        'preparedBy',
        ...(raw && typeof raw === 'object' && 'archiveVersion' in raw && raw.archiveVersion === 2
          ? ['translationEvidence']
          : []),
      ]),
    );
    const stored = raw as Record<string, unknown>;
    integrity(
      (stored.archiveVersion === 1 || stored.archiveVersion === 2) &&
        stored.status === 'prepared_not_published' &&
        stored.operationId === operationId &&
        typeof stored.preparedAt === 'string' &&
        isUtcInstant(stored.preparedAt),
    );
    const request = ownRequest(stored.request);
    integrity((stored.archiveVersion === 2) === (request.translations !== undefined));
    integrity(
      row.kind === OPERATION &&
        row.fingerprint === requestFingerprint(request) &&
        stored.draftId === request.draftId &&
        stored.draftRevision === request.expectedRevision,
    );
    integrity(
      exact(stored.preparedBy, ['userId', 'username', 'role']) &&
        stored.preparedBy.userId === row.actor_id &&
        typeof stored.preparedBy.username === 'string' &&
        stored.preparedBy.username.length <= 100 &&
        ['reviewer', 'administrator'].includes(String(stored.preparedBy.role)),
    );
    integrity(
      exact(stored.approval, ['reviewerId', 'reviewedAt', 'revision', 'note']) &&
        typeof stored.approval.reviewerId === 'string' &&
        typeof stored.approval.reviewedAt === 'string' &&
        isUtcInstant(stored.approval.reviewedAt) &&
        stored.approval.revision === request.expectedRevision &&
        typeof stored.approval.note === 'string',
    );
    const publication = await readPublishedRecipeRevision(stored.publication, hash);
    integrity(
      publication.revision.ref.revisionId === request.revisionId &&
        publication.revision.document.kind === 'authored' &&
        (publication.formatVersion === 3) === (stored.archiveVersion === 2),
    );
    if (publication.formatVersion === 3) {
      integrity(
        request.translations &&
          validateRetainedTranslationEvidence(this.db, this.now, {
            draftId: request.draftId,
            draftRevision: request.expectedRevision,
            recipeId: publication.revision.ref.recipeId,
            reviewerId: row.actor_id,
            preparedAt: stored.preparedAt as string,
            selections: request.translations,
            evidence: stored.translationEvidence,
            translations: publication.translations,
          }),
      );
    }
    const document = publication.revision.document;
    if (document.kind !== 'authored') throw new Error('Unreachable imported preparation');
    if (document.provenance.basedOn === null) integrity(stored.originalEvidence === null);
    else {
      const original = await createBundledRecipeRevision(publication.revision.ref.recipeId, hash);
      integrity(
        same(original.ref, document.provenance.basedOn) && same(original, stored.originalEvidence),
      );
    }
    const retainedFingerprint = receiptFingerprint(stored);
    const pointerRow = this.row(
      identityKey(publication.revision.ref.recipeId, request.revisionId),
      POINTER_BYTES,
    );
    integrity(
      pointerRow &&
        pointerRow.kind === IDENTITY &&
        pointerRow.actor_id === row.actor_id &&
        pointerRow.fingerprint === retainedFingerprint,
    );
    const pointer = parseBounded(pointerRow.result, POINTER_BYTES);
    integrity(
      exact(pointer, [
        'operationId',
        'recipeId',
        'revisionId',
        'publicationFingerprint',
        'receiptFingerprint',
      ]) &&
        pointer.operationId === operationId &&
        pointer.recipeId === publication.revision.ref.recipeId &&
        pointer.revisionId === request.revisionId &&
        pointer.publicationFingerprint === publication.publicationFingerprint &&
        pointer.receiptFingerprint === retainedFingerprint,
    );
    return freeze({ ...stored, publication }) as unknown as PreparedPublicationReceipt;
  }

  async prepare(
    inputActor: Actor,
    operationId: string,
    input: PreparationRequest,
  ): Promise<PreparedPublicationReceipt> {
    identifier(operationId);
    const request = freeze(ownRequest(input));
    const actor = this.actor(inputActor);
    const digest = requestFingerprint(request);
    const previous = this.replay(actor, operationId, digest);
    if (previous) return this.readAuthorized(actor, operationId, previous);
    let prepared: PreparedPackage;
    try {
      prepared = await prepareReviewedPublication({
        db: this.db,
        media: this.media,
        actor,
        ...request,
        now: this.now,
      });
    } catch (error) {
      // Another copy of this exact operation may have committed while media was inspected.
      // Recovery reads that immutable receipt; it never authorizes a new stale preparation.
      this.db.assertActor(actor, this.now().getTime(), ['reviewer', 'administrator']);
      const concurrent = this.replay(actor, operationId, digest);
      if (concurrent) return this.readAuthorized(actor, operationId, concurrent);
      throw error;
    }
    const stored = this.db.transaction(() => {
      this.db.assertActor(actor, this.now().getTime(), ['reviewer', 'administrator']);
      const concurrent = this.replay(actor, operationId, digest);
      if (concurrent) return concurrent;
      requireRecentReviewIdentity(this.db, actor, this.now().getTime());
      const draft = new DraftRepository(this.db, this.now).read(request.draftId);
      requireAdmin(
        draft.revision === request.expectedRevision &&
          draft.status === 'reviewed' &&
          draft.review?.decision === 'approved' &&
          same(draft.approval, prepared.approval) &&
          draft.validationIssues.length === 0,
        409,
        'revision_conflict',
        'The approved draft or its permissions changed before preparation was retained.',
      );
      assertTranslationAuthority(
        this.db,
        this.now,
        draft,
        request.translations,
        prepared.translationEvidence,
      );
      const ref = prepared.publication.revision.ref;
      requireAdmin(
        !this.row(identityKey(ref.recipeId, ref.revisionId), 0),
        409,
        'revision_already_prepared',
        'This immutable recipe revision is already retained. Recover its original operation or use a new revision identifier.',
      );
      const receipt: PreparedPublicationReceipt = {
        ...prepared,
        archiveVersion: request.translations ? 2 : 1,
        operationId,
        request,
        preparedAt: this.now().toISOString(),
        preparedBy: { ...actor.user },
      };
      canonicalContentJson(receipt, RECEIPT_BYTES);
      const pointer: IdentityPointer = {
        operationId,
        recipeId: ref.recipeId,
        revisionId: ref.revisionId,
        publicationFingerprint: prepared.publication.publicationFingerprint,
        receiptFingerprint: receiptFingerprint(receipt),
      };
      recordOperation(this.db, actor, operationId, OPERATION, digest, receipt);
      recordOperation(
        this.db,
        actor,
        identityKey(ref.recipeId, ref.revisionId),
        IDENTITY,
        pointer.receiptFingerprint,
        pointer,
      );
      this.db.run('UPDATE admin_meta SET library_revision=library_revision+1 WHERE id=1');
      return this.row(operationId)!;
    });
    return this.readAuthorized(actor, operationId, stored);
  }

  private async readAuthorized(
    actor: Actor,
    operationId: string,
    row: OperationRow,
  ): Promise<PreparedPublicationReceipt> {
    const receipt = await this.readStored(operationId, row);
    // Hashing is asynchronous; a revoked session must not regain read access through recovery.
    this.db.assertActor(actor, this.now().getTime(), ['reviewer', 'administrator']);
    return receipt;
  }

  async receipt(inputActor: Actor, operationId: string): Promise<PreparedPublicationReceipt> {
    identifier(operationId);
    const actor = this.actor(inputActor);
    const row = this.row(operationId);
    requireAdmin(
      row && row.actor_id === actor.user.userId && row.kind === OPERATION,
      404,
      'preparation_unknown',
      'No preparation receipt is available for this operation. This does not prove the request did not commit.',
    );
    return this.readAuthorized(actor, operationId, row);
  }

  async readRevision(
    inputActor: Actor,
    recipeId: string,
    revisionId: string,
  ): Promise<PreparedPublicationReceipt | null> {
    const actor = this.actor(inputActor);
    requireAdmin(
      typeof recipeId === 'string' && /^[0-9]{1,20}$/.test(recipeId) && immutableId(revisionId),
      400,
      'invalid_revision_id',
      'The recipe revision identifier is invalid.',
    );
    const row = this.row(identityKey(recipeId, revisionId), POINTER_BYTES);
    if (!row) return null;
    const pointer = parseBounded(row.result, POINTER_BYTES);
    integrity(
      row.kind === IDENTITY &&
        exact(pointer, [
          'operationId',
          'recipeId',
          'revisionId',
          'publicationFingerprint',
          'receiptFingerprint',
        ]),
    );
    const target = pointer as unknown as IdentityPointer;
    identifier(target.operationId);
    integrity(
      target.recipeId === recipeId &&
        target.revisionId === revisionId &&
        fingerprint(target.publicationFingerprint) &&
        fingerprint(target.receiptFingerprint) &&
        row.fingerprint === target.receiptFingerprint,
    );
    const retained = this.row(target.operationId);
    integrity(retained && retained.actor_id === row.actor_id);
    const receipt = await this.readAuthorized(actor, target.operationId, retained!);
    integrity(
      receipt.publication.publicationFingerprint === target.publicationFingerprint &&
        receipt.publication.revision.ref.recipeId === recipeId &&
        receipt.publication.revision.ref.revisionId === revisionId,
    );
    return receipt;
  }
}
