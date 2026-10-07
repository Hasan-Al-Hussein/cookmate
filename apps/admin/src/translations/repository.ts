import { randomUUID } from 'node:crypto';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { AdminDraftInput, AdminRole } from '../contracts';
import { requireAdmin } from '../auth/errors';
import type { Actor, AdminDatabase } from '../storage/database';
import { operationResult, recordOperation, sha256 } from '../drafts/repository';
import { requireRecentReviewIdentity } from '../drafts/rights';
import {
  draftInput,
  identifier,
  object,
  publicOperationIdentifier,
  revision,
  text,
} from '../drafts/validation';
import type {
  AdminTranslation,
  AdminTranslationMutation,
  AdminTranslationOriginal,
  AdminTranslationRecord,
  AdminTranslationResolution,
  AdminTranslationSource,
  AdminTranslationSummary,
} from './contracts';
import {
  fingerprint,
  language,
  ownTranslationData,
  requireCompleteTranslation,
  TRANSLATION_INPUT_BYTES,
  TRANSLATION_RECORD_BYTES,
  TRANSLATION_SOURCE_BYTES,
  translationInput,
} from './validation';

interface Pointer {
  operationId: string;
  translationId: string;
  revision: number;
}
type Action =
  | { kind: 'save'; input: unknown }
  | { kind: 'rebase'; sourceRevision: number; input: unknown }
  | {
      kind: 'review';
      decision: 'approved' | 'changes_requested';
      note: string;
      acknowledgeHumanReview: boolean;
    };
const kinds = new Set([
  'translation_create',
  'translation_save',
  'translation_rebase',
  'translation_review',
]);
const editors: readonly AdminRole[] = ['editor', 'reviewer', 'administrator'];
const reviewers: readonly AdminRole[] = ['reviewer', 'administrator'];
const digest = (value: unknown, bound = TRANSLATION_RECORD_BYTES) =>
  sha256(canonicalContentJson(value, bound));

function reviewBinding(record: AdminTranslationRecord, inputRevision: number): string {
  return digest({
    translationId: record.translationId,
    inputRevision,
    source: record.source,
    originalLanguage: record.originalLanguage,
    targetLanguage: record.targetLanguage,
    translatedFingerprint: record.translatedFingerprint,
  });
}

/** Synchronous transactions retain exact source/review/CAS authority through the final write. */
export class TranslationRepository {
  constructor(
    private readonly db: AdminDatabase,
    private readonly now: () => Date,
  ) {}

  private source(
    draftId: string,
    sourceRevision: number,
  ): { source: AdminTranslationSource; input: AdminDraftInput; currentRevision: number } {
    identifier(draftId);
    revision(sourceRevision);
    const size = this.db.get<{ bytes: number; type: string }>(
      'SELECT length(CAST(document AS BLOB)) bytes,typeof(document) type FROM admin_draft_revision WHERE draft_id=? AND revision=?',
      draftId,
      sourceRevision,
    );
    requireAdmin(size, 404, 'draft_not_found', 'This original draft revision was not found.');
    requireAdmin(
      size.type === 'text' && size.bytes <= TRANSLATION_SOURCE_BYTES,
      500,
      'translation_storage',
      'The saved original exceeds supported bounds.',
    );
    requireAdmin(
      !this.db.get(
        "SELECT 1 FROM admin_draft WHERE draft_id=? AND (typeof(recipe_id)!='text' OR length(CAST(recipe_id AS BLOB))>120 OR typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991)",
        draftId,
      ),
      500,
      'translation_storage',
      'The saved source identity is invalid.',
    );
    const row = this.db.get<{ document: string; recipe_id: string; revision: number }>(
      'SELECT r.document,d.recipe_id,d.revision FROM admin_draft_revision r JOIN admin_draft d ON d.draft_id=r.draft_id WHERE r.draft_id=? AND r.revision=?',
      draftId,
      sourceRevision,
    )!;
    const document: unknown = JSON.parse(row.document);
    requireAdmin(
      document &&
        typeof document === 'object' &&
        'input' in document &&
        'draftId' in document &&
        document.draftId === draftId &&
        'revision' in document &&
        document.revision === sourceRevision &&
        'recipeId' in document &&
        document.recipeId === row.recipe_id,
      500,
      'translation_storage',
      'The original revision identity is inconsistent.',
    );
    identifier(row.recipe_id);
    revision(row.revision);
    const input = draftInput(ownTranslationData(document.input));
    return {
      source: {
        draftId,
        revision: sourceRevision,
        recipeId: row.recipe_id,
        inputFingerprint: digest(input),
      },
      input,
      currentRevision: row.revision,
    };
  }

  private stored(id: string, version?: number): AdminTranslationRecord {
    identifier(id);
    if (version !== undefined) revision(version);
    requireAdmin(
      !this.db.get(
        "SELECT 1 FROM admin_translation WHERE translation_id=? AND (typeof(source_draft_id)!='text' OR length(CAST(source_draft_id AS BLOB))>120 OR typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991)",
        id,
      ),
      500,
      'translation_storage',
      'The translation identity is invalid.',
    );
    const current = this.db.get<{ revision: number; source_draft_id: string }>(
      'SELECT revision,source_draft_id FROM admin_translation WHERE translation_id=?',
      id,
    );
    requireAdmin(current, 404, 'translation_not_found', 'This translation was not found.');
    const selected = version ?? current.revision;
    revision(selected);
    requireAdmin(
      !this.db.get(
        "SELECT 1 FROM admin_translation_revision WHERE translation_id=? AND revision=? AND (typeof(source_draft_id)!='text' OR length(CAST(source_draft_id AS BLOB))>120 OR typeof(source_revision)!='integer' OR source_revision<1 OR source_revision>9007199254740991)",
        id,
        selected,
      ),
      500,
      'translation_storage',
      'The saved source identity is invalid.',
    );
    const meta = this.db.get<{
      bytes: number;
      type: string;
      source_draft_id: string;
      source_revision: number;
    }>(
      'SELECT length(CAST(document AS BLOB)) bytes,typeof(document) type,source_draft_id,source_revision FROM admin_translation_revision WHERE translation_id=? AND revision=?',
      id,
      selected,
    );
    requireAdmin(meta, 404, 'translation_not_found', 'This translation revision was not found.');
    requireAdmin(
      meta.type === 'text' &&
        meta.bytes <= TRANSLATION_RECORD_BYTES &&
        meta.source_draft_id === current.source_draft_id,
      500,
      'translation_storage',
      'The translation record is inconsistent or exceeds supported bounds.',
    );
    const row = this.db.get<{ document: string }>(
      'SELECT document FROM admin_translation_revision WHERE translation_id=? AND revision=?',
      id,
      selected,
    )!;
    const value: unknown = JSON.parse(row.document);
    object(value, [
      'translationId',
      'revision',
      'source',
      'originalLanguage',
      'targetLanguage',
      'input',
      'translatedFingerprint',
      'machineAssisted',
      'status',
      'review',
      'updatedAt',
      'updatedBy',
    ]);
    object(value.source, ['draftId', 'revision', 'recipeId', 'inputFingerprint']);
    requireAdmin(
      value.translationId === id &&
        value.revision === selected &&
        value.source.draftId === meta.source_draft_id &&
        value.source.revision === meta.source_revision,
      500,
      'translation_storage',
      'The translation revision identity is inconsistent.',
    );
    const original = this.source(meta.source_draft_id, meta.source_revision);
    requireAdmin(
      canonicalContentJson(value.source) === canonicalContentJson(original.source),
      500,
      'translation_storage',
      'The exact original source binding changed.',
    );
    language(value.originalLanguage);
    language(value.targetLanguage);
    requireAdmin(
      value.originalLanguage !== value.targetLanguage &&
        typeof value.machineAssisted === 'boolean' &&
        ['draft', 'reviewed', 'changes_requested'].includes(value.status as string),
      500,
      'translation_storage',
      'The translation state is invalid.',
    );
    const input = translationInput(value.input, original.input);
    requireAdmin(
      value.translatedFingerprint === digest(input) &&
        (input.attribution === 'human' || value.machineAssisted),
      500,
      'translation_storage',
      'The translated content binding is inconsistent.',
    );
    object(value.updatedBy, ['userId', 'username', 'role']);
    identifier(value.updatedBy.userId);
    text(value.updatedBy.username, 100);
    requireAdmin(
      editors.includes(value.updatedBy.role as AdminRole) &&
        typeof value.updatedAt === 'string' &&
        value.updatedAt.length === 24 &&
        new Date(value.updatedAt).toISOString() === value.updatedAt,
      500,
      'translation_storage',
      'The translation author is invalid.',
    );
    const record = value as unknown as AdminTranslationRecord;
    if (record.review === null)
      requireAdmin(
        record.status === 'draft',
        500,
        'translation_storage',
        'Reviewed status requires retained operator evidence.',
      );
    else {
      object(record.review, [
        'decision',
        'note',
        'reviewerId',
        'reviewedAt',
        'inputRevision',
        'binding',
        'evidence',
      ]);
      text(record.review.note, 2000);
      identifier(record.review.reviewerId);
      requireAdmin(
        record.review.inputRevision === selected - 1 &&
          record.review.evidence === 'operator_acknowledgement' &&
          record.review.reviewedAt === record.updatedAt &&
          record.review.reviewerId === record.updatedBy.userId &&
          reviewers.includes(record.updatedBy.role) &&
          record.review.binding === reviewBinding(record, record.review.inputRevision) &&
          ((record.review.decision === 'approved' && record.status === 'reviewed') ||
            (record.review.decision === 'changes_requested' &&
              record.status === 'changes_requested')),
        500,
        'translation_storage',
        'The operator review binding is inconsistent.',
      );
    }
    return record;
  }

  read(id: string, version?: number): AdminTranslation {
    const record = this.stored(id, version);
    const head = this.db.get<{ revision: number }>(
      'SELECT revision FROM admin_draft WHERE draft_id=?',
      record.source.draftId,
    )!;
    const stale = head.revision !== record.source.revision;
    return {
      ...record,
      sourceStatus: stale ? { kind: 'stale', currentRevision: head.revision } : { kind: 'current' },
      effectiveStatus: stale ? 'stale' : record.status,
    };
  }
  original(id: string, version?: number): AdminTranslationOriginal {
    const record = this.stored(id, version);
    return {
      source: record.source,
      originalLanguage: record.originalLanguage,
      input: this.source(record.source.draftId, record.source.revision).input,
    };
  }
  list(draftId: string): AdminTranslationSummary[] {
    identifier(draftId);
    requireAdmin(
      this.db.get('SELECT 1 FROM admin_draft WHERE draft_id=?', draftId),
      404,
      'draft_not_found',
      'This draft was not found.',
    );
    return this.db
      .all<{
        translation_id: string;
      }>(
        'SELECT translation_id FROM admin_translation WHERE source_draft_id=? ORDER BY translation_id LIMIT 100',
        draftId,
      )
      .map(({ translation_id }) => {
        const { input: _input, ...summary } = this.read(translation_id);
        return summary;
      });
  }
  history(id: string): AdminTranslationSummary[] {
    identifier(id);
    this.stored(id);
    return this.db
      .all<{
        revision: number;
      }>(
        'SELECT revision FROM admin_translation_revision WHERE translation_id=? ORDER BY revision DESC LIMIT 100',
        id,
      )
      .map(({ revision: version }) => {
        const { input: _input, ...summary } = this.read(id, version);
        return summary;
      });
  }
  private write(record: AdminTranslationRecord): void {
    const serialized = canonicalContentJson(record, TRANSLATION_RECORD_BYTES);
    this.db.run(
      'INSERT INTO admin_translation_revision VALUES(?,?,?,?,?)',
      record.translationId,
      record.revision,
      record.source.draftId,
      record.source.revision,
      serialized,
    );
    this.db.run(
      'UPDATE admin_translation SET revision=? WHERE translation_id=?',
      record.revision,
      record.translationId,
    );
  }
  private operation(id: string) {
    const invalid = this.db.get(
      `SELECT 1 FROM admin_operation WHERE operation_id=? AND (typeof(result)!='text' OR length(CAST(result AS BLOB))>4096 OR length(CAST(actor_id AS BLOB))>120 OR length(CAST(kind AS BLOB))>120 OR length(CAST(fingerprint AS BLOB))>64)`,
      id,
    );
    requireAdmin(
      !invalid,
      409,
      'operation_type',
      'This operation is not a bounded translation operation.',
    );
    return this.db.get<{ actor_id: string; kind: string; fingerprint: string; result: string }>(
      'SELECT actor_id,kind,fingerprint,result FROM admin_operation WHERE operation_id=?',
      id,
    );
  }
  private mutation(
    pointer: Pointer,
    expectedOperationId: string,
    requestFingerprint: string,
  ): AdminTranslationMutation {
    object(pointer, ['operationId', 'translationId', 'revision']);
    publicOperationIdentifier(pointer.operationId);
    requireAdmin(
      pointer.operationId === expectedOperationId,
      500,
      'translation_storage',
      'The saved translation operation identity is inconsistent.',
    );
    identifier(pointer.translationId);
    revision(pointer.revision);
    return {
      operationId: pointer.operationId,
      requestFingerprint,
      translation: this.read(pointer.translationId, pointer.revision),
    };
  }
  private retry(
    actor: Actor,
    id: string,
    kind: string,
    requestFingerprint: string,
  ): AdminTranslationMutation | null {
    this.operation(id);
    const prior = operationResult<Pointer>(this.db, actor, id, kind, requestFingerprint);
    return prior ? this.mutation(prior, id, requestFingerprint) : null;
  }
  private commit(
    actor: Actor,
    operationId: string,
    kind: string,
    requestFingerprint: string,
    record: AdminTranslationRecord,
  ): AdminTranslationMutation {
    this.write(record);
    const pointer = { operationId, translationId: record.translationId, revision: record.revision };
    recordOperation(this.db, actor, operationId, kind, requestFingerprint, pointer);
    return this.mutation(pointer, operationId, requestFingerprint);
  }

  create(actor: Actor, draftId: string, value: unknown): AdminTranslationMutation {
    identifier(draftId);
    const request = ownTranslationData(value, TRANSLATION_INPUT_BYTES + 4096);
    object(request, [
      'operationId',
      'sourceRevision',
      'originalLanguage',
      'targetLanguage',
      'input',
    ]);
    publicOperationIdentifier(request.operationId);
    revision(request.sourceRevision);
    language(request.originalLanguage);
    language(request.targetLanguage);
    requireAdmin(
      request.originalLanguage !== request.targetLanguage,
      400,
      'invalid_language',
      'Original and target languages must differ.',
    );
    const { operationId, sourceRevision, originalLanguage, targetLanguage } = request;
    const requestFingerprint = digest({ draftId, request });
    return this.db.transaction(() => {
      this.db.assertActor(actor, this.now().getTime());
      const prior = this.retry(actor, operationId, 'translation_create', requestFingerprint);
      if (prior) return prior;
      const original = this.source(draftId, sourceRevision);
      requireAdmin(
        original.currentRevision === sourceRevision,
        409,
        'translation_source_stale',
        'Choose the current saved source revision before creating a translation.',
      );
      const input = translationInput(request.input, original.input);
      const count = this.db.get<{ count: number }>(
        'SELECT COUNT(*) count FROM admin_translation WHERE source_draft_id=?',
        draftId,
      )!.count;
      requireAdmin(
        count < 100,
        409,
        'translation_limit',
        'This source already has the maximum number of translation records.',
      );
      const record: AdminTranslationRecord = {
        translationId: randomUUID(),
        revision: 1,
        source: original.source,
        originalLanguage,
        targetLanguage,
        input,
        translatedFingerprint: digest(input),
        machineAssisted: input.attribution !== 'human',
        status: 'draft',
        review: null,
        updatedAt: this.now().toISOString(),
        updatedBy: actor.user,
      };
      this.db.run('INSERT INTO admin_translation VALUES(?,?,?)', record.translationId, draftId, 1);
      return this.commit(actor, operationId, 'translation_create', requestFingerprint, record);
    });
  }

  mutate(
    actor: Actor,
    id: string,
    operationId: string,
    expectedRevision: number,
    actionValue: Action,
  ): AdminTranslationMutation {
    identifier(id);
    publicOperationIdentifier(operationId);
    revision(expectedRevision);
    const owned = ownTranslationData(actionValue, TRANSLATION_INPUT_BYTES + 4096);
    object(
      owned,
      ['kind'],
      ['input', 'sourceRevision', 'decision', 'note', 'acknowledgeHumanReview'],
    );
    const action = owned as unknown as Action;
    if (action.kind === 'save') object(action, ['kind', 'input']);
    else if (action.kind === 'rebase') {
      object(action, ['kind', 'sourceRevision', 'input']);
      revision(action.sourceRevision);
    } else {
      object(action, ['kind', 'decision', 'note', 'acknowledgeHumanReview']);
      text(action.note, 2000);
      requireAdmin(
        action.kind === 'review' &&
          ['approved', 'changes_requested'].includes(action.decision) &&
          typeof action.acknowledgeHumanReview === 'boolean' &&
          (action.decision !== 'approved' || action.acknowledgeHumanReview === true),
        400,
        'invalid_translation_review',
        'Approval requires an explicit human review acknowledgement.',
      );
    }
    const kind = `translation_${action.kind}`;
    const requestFingerprint = digest({ id, operationId, expectedRevision, action });
    return this.db.transaction(() => {
      this.db.assertActor(
        actor,
        this.now().getTime(),
        action.kind === 'review' ? reviewers : editors,
      );
      const prior = this.retry(actor, operationId, kind, requestFingerprint);
      if (prior) return prior;
      const current = this.read(id);
      requireAdmin(
        current.revision === expectedRevision,
        409,
        'revision_conflict',
        'The translation changed. Load its current revision before saving.',
      );
      requireAdmin(
        Number.isSafeInteger(current.revision + 1),
        409,
        'revision_limit',
        'The translation revision limit was reached.',
      );
      const original = this.source(
        current.source.draftId,
        action.kind === 'rebase' ? action.sourceRevision : current.source.revision,
      );
      if (action.kind === 'rebase')
        requireAdmin(
          original.currentRevision === action.sourceRevision &&
            current.source.revision !== action.sourceRevision,
          409,
          'translation_source_stale',
          'Rebase explicitly onto the newer current saved source revision.',
        );
      if (action.kind === 'review') {
        requireAdmin(
          current.sourceStatus.kind === 'current',
          409,
          'translation_source_stale',
          'The original changed. Rebase and review the translation again.',
        );
        if (action.decision === 'approved') {
          requireRecentReviewIdentity(this.db, actor, this.now().getTime());
          requireCompleteTranslation(current.input);
        }
      }
      const input =
        action.kind === 'review' ? current.input : translationInput(action.input, original.input);
      const { sourceStatus: _sourceStatus, effectiveStatus: _effectiveStatus, ...stored } = current;
      const next: AdminTranslationRecord = {
        ...stored,
        revision: current.revision + 1,
        source: original.source,
        input,
        translatedFingerprint: digest(input),
        machineAssisted: current.machineAssisted || input.attribution !== 'human',
        status: 'draft',
        review: null,
        updatedAt: this.now().toISOString(),
        updatedBy: actor.user,
      };
      if (action.kind === 'review') {
        next.status = action.decision === 'approved' ? 'reviewed' : 'changes_requested';
        next.review = {
          decision: action.decision,
          note: action.note,
          reviewerId: actor.user.userId,
          reviewedAt: next.updatedAt,
          inputRevision: current.revision,
          binding: reviewBinding(next, current.revision),
          evidence: 'operator_acknowledgement',
        };
      }
      return this.commit(actor, operationId, kind, requestFingerprint, next);
    });
  }

  receipt(
    actor: Actor,
    operationId: string,
    requestFingerprint?: string,
  ): AdminTranslationMutation {
    publicOperationIdentifier(operationId);
    if (requestFingerprint !== undefined) fingerprint(requestFingerprint);
    this.db.assertActor(actor, this.now().getTime());
    const row = this.operation(operationId);
    requireAdmin(
      row && row.actor_id === actor.user.userId && kinds.has(row.kind),
      404,
      'operation_unknown',
      'No translation receipt is available. This does not establish cancellation.',
    );
    requireAdmin(
      requestFingerprint === undefined || requestFingerprint === row.fingerprint,
      409,
      'operation_conflict',
      'The exact operation fingerprint differs.',
    );
    this.db.assertActor(
      actor,
      this.now().getTime(),
      row.kind === 'translation_review' ? reviewers : editors,
    );
    return this.mutation(JSON.parse(row.result) as Pointer, operationId, row.fingerprint);
  }
  resolve(
    actor: Actor,
    operationId: string,
    requestFingerprint: string,
  ): AdminTranslationResolution {
    publicOperationIdentifier(operationId);
    fingerprint(requestFingerprint);
    return this.db.transaction(() => {
      this.db.assertActor(actor, this.now().getTime());
      const row = this.operation(operationId);
      if (row) {
        requireAdmin(
          row.actor_id === actor.user.userId && row.fingerprint === requestFingerprint,
          409,
          'operation_conflict',
          'The operation belongs to a different request.',
        );
        if (row.kind !== 'cancelled')
          return {
            status: 'committed',
            mutation: this.receipt(actor, operationId, requestFingerprint),
          };
      } else
        recordOperation(this.db, actor, operationId, 'cancelled', requestFingerprint, {
          operationId,
        });
      return { status: 'cancelled', operationId, requestFingerprint };
    });
  }
}
