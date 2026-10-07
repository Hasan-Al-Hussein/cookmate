import { createHash, randomUUID } from 'node:crypto';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  unknownReviewedMetadata,
} from '@cookmate/catalogue/content';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type {
  AdminDraft,
  AdminDraftInput,
  AdminHistoryEntry,
  AdminLibrary,
  AdminLibraryItem,
  AdminLibraryStatus,
  AdminMutation,
  AdminOperationResolution,
  AdminReviewRecord,
  AdminRightsInput,
  AdminRole,
} from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import { requireAdmin } from '../auth/errors';
import { readiness } from './validation';
import { effectiveRights, requireRecentReviewIdentity, scopedRightsContent } from './rights';
import { applyMetadataReview } from './metadata';
import { recipeMetadataContextChanged } from './metadataContext';
import { libraryItemStatus, matchesLibraryStatus, type LibraryLifecycle } from './libraryStatus';

export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const hashContent = async (value: string) => sha256(value);
const draftMutationKinds = new Set(['create', 'save', 'restore', 'review', 'rights', 'metadata']);
export function operationResult<T>(
  db: AdminDatabase,
  actor: Actor,
  id: string,
  kind: string,
  fingerprint: string,
): T | null {
  const row = db.get<{ actor_id: string; kind: string; fingerprint: string; result: string }>(
    'SELECT * FROM admin_operation WHERE operation_id=?',
    id,
  );
  if (!row) return null;
  requireAdmin(
    row.actor_id !== actor.user.userId || row.kind !== 'cancelled',
    409,
    'operation_cancelled',
    'This operation was cancelled. It cannot change a draft.',
  );
  requireAdmin(
    row.actor_id === actor.user.userId && row.kind === kind && row.fingerprint === fingerprint,
    409,
    'operation_conflict',
    'This operation identifier was already used for a different request.',
  );
  return JSON.parse(row.result) as T;
}
export function recordOperation(
  db: AdminDatabase,
  actor: Actor,
  id: string,
  kind: string,
  fingerprint: string,
  value: unknown,
): void {
  db.run(
    'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
    id,
    actor.user.userId,
    kind,
    fingerprint,
    JSON.stringify(value),
  );
}
export class DraftRepository {
  constructor(
    private readonly db: AdminDatabase,
    private readonly now: () => Date,
  ) {}
  read(id: string, version?: number): AdminDraft {
    const row =
      version === undefined
        ? this.db.get<{ document: string; review_evidence: string | null }>(
            'SELECT r.document,r.review_evidence FROM admin_draft d JOIN admin_draft_revision r ON r.draft_id=d.draft_id AND r.revision=d.revision WHERE d.draft_id=?',
            id,
          )
        : this.db.get<{ document: string; review_evidence: string | null }>(
            'SELECT document,review_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=?',
            id,
            version,
          );
    requireAdmin(row, 404, 'draft_not_found', 'This draft revision was not found.');
    return this.decorate({
      ...(JSON.parse(row.document) as AdminDraft),
      review: row.review_evidence ? (JSON.parse(row.review_evidence) as AdminReviewRecord) : null,
    });
  }
  receipt(actor: Actor, id: string): AdminMutation {
    const row = this.db.get<{ result: string; kind: string }>(
      "SELECT result,kind FROM admin_operation WHERE operation_id=? AND actor_id=? AND kind IN ('create','save','restore','review','rights','metadata')",
      id,
      actor.user.userId,
    );
    requireAdmin(
      row,
      404,
      'operation_unknown',
      'No draft receipt is available for this operation. This does not prove that a request did not commit.',
    );
    this.requireReceiptActor(actor, row.kind);
    return this.withReview(JSON.parse(row.result) as AdminMutation);
  }
  private requireReceiptActor(actor: Actor, kind: string): void {
    this.db.assertActor(
      actor,
      this.now().getTime(),
      kind === 'rights' || kind === 'review' || kind === 'metadata'
        ? ['reviewer', 'administrator']
        : ['editor', 'reviewer', 'administrator'],
    );
  }
  private withReview(result: AdminMutation): AdminMutation {
    return {
      ...result,
      draft: this.read(result.draft.draftId, result.draft.revision),
    };
  }
  cancel(actor: Actor, operationId: string): AdminOperationResolution {
    return this.db.transaction(() => {
      this.db.assertActor(actor, this.now().getTime());
      const row = this.db.get<{ actor_id: string; kind: string; result: string }>(
        'SELECT actor_id,kind,result FROM admin_operation WHERE operation_id=?',
        operationId,
      );
      if (row) {
        requireAdmin(
          row.actor_id === actor.user.userId,
          409,
          'operation_conflict',
          'This operation cannot be resolved by the current account.',
        );
        requireAdmin(
          row.kind !== 'upload',
          409,
          'operation_type',
          'Photo uploads use separate recovery and cannot be cancelled here.',
        );
        if (row.kind === 'cancelled') return { operationId, status: 'cancelled' };
        requireAdmin(
          draftMutationKinds.has(row.kind),
          409,
          'operation_type',
          'This operation is not a supported draft mutation.',
        );
        this.requireReceiptActor(actor, row.kind);
        return {
          operationId,
          status: 'committed',
          mutation: this.withReview(JSON.parse(row.result) as AdminMutation),
        };
      }
      const result: AdminOperationResolution = { operationId, status: 'cancelled' };
      recordOperation(this.db, actor, operationId, 'cancelled', '', result);
      return result;
    });
  }
  history(id: string): AdminHistoryEntry[] {
    this.read(id);
    return this.db
      .all<{
        document: string;
      }>(
        `SELECT json_object('revision',revision,'createdAt',json_extract(document,'$.updatedAt'),'author',json(json_extract(document,'$.updatedBy')),'changeSummary',json_extract(document,'$.input.changeSummary'),'status',json_extract(document,'$.status'),'review',json(review_evidence),'rights',json(COALESCE(json_extract(document,'$.rights'),'[]'))) document FROM admin_draft_revision WHERE draft_id=? ORDER BY revision DESC LIMIT 100`,
        id,
      )
      .map((row) => JSON.parse(row.document) as AdminHistoryEntry);
  }
  private decorate(draft: AdminDraft, originalEvidence?: string | null): AdminDraft {
    const { bindings, photoUrl } = scopedRightsContent(this.db, draft, originalEvidence);
    const rights = effectiveRights(draft.rights, bindings);
    return {
      ...draft,
      rights,
      photoUrl,
      validationIssues: readiness(draft.input, photoUrl !== null, rights),
    };
  }
  private write(
    draft: AdminDraft,
    originalEvidence: string | null,
    reviewEvidence: string | null = null,
  ): void {
    this.db.run(
      'INSERT INTO admin_draft_revision VALUES(?,?,?,?,?)',
      draft.draftId,
      draft.revision,
      JSON.stringify(draft),
      originalEvidence,
      reviewEvidence,
    );
    this.db.run(
      'UPDATE admin_draft SET revision=? WHERE draft_id=?',
      draft.revision,
      draft.draftId,
    );
    this.db.run('UPDATE admin_meta SET library_revision=library_revision+1 WHERE id=1');
  }
  async create(actor: Actor, operationId: string, fromRecipeId?: string): Promise<AdminMutation> {
    const fingerprint = sha256(canonicalContentJson({ fromRecipeId: fromRecipeId ?? null }));
    this.db.assertActor(actor, this.now().getTime());
    const prior = operationResult<AdminMutation>(
      this.db,
      actor,
      operationId,
      'create',
      fingerprint,
    );
    if (prior) return this.withReview(prior);
    const source = fromRecipeId ? catalogue.getRecipe(fromRecipeId) : undefined;
    requireAdmin(
      !fromRecipeId || source,
      404,
      'recipe_not_found',
      'The bundled recipe was not found.',
    );
    const baseline = source
      ? await createBundledRecipeRevision(source.recipeId, hashContent)
      : null;
    const input: AdminDraftInput = source
      ? {
          title: source.title,
          description: null,
          category: source.category,
          cuisine: source.cuisine,
          rawTags: source.rawTags,
          recipePage: source.recipePage,
          originalSourceUrl: source.originalSourceUrl,
          videoUrl: source.videoUrl,
          photoAssetId: null,
          ingredients: source.ingredients.map((row) => ({
            rawName: row.rawName,
            rawMeasure: row.rawMeasure,
          })),
          instructions: source.instructions.map((row) => ({
            rawText: row.rawText,
            presentation: row.presentation,
          })),
          credits: [
            { label: 'TheMealDB', url: source.recipePage },
            ...(source.originalSourceUrl
              ? [{ label: 'Original publisher', url: source.originalSourceUrl }]
              : []),
          ],
          changeSummary: '',
        }
      : {
          title: '',
          description: null,
          category: '',
          cuisine: '',
          rawTags: null,
          recipePage: null,
          originalSourceUrl: null,
          videoUrl: null,
          photoAssetId: null,
          ingredients: [],
          instructions: [],
          credits: [],
          changeSummary: '',
        };
    return this.db.transaction(() => {
      this.db.assertActor(actor, this.now().getTime());
      const existing = operationResult<AdminMutation>(
        this.db,
        actor,
        operationId,
        'create',
        fingerprint,
      );
      if (existing) return this.withReview(existing);
      let recipeId = source?.recipeId;
      if (!recipeId) {
        const sequence = this.db.get<{ next_recipe: number }>(
          'SELECT next_recipe FROM admin_meta WHERE id=1',
        )!.next_recipe;
        requireAdmin(
          Number.isSafeInteger(sequence + 1),
          409,
          'recipe_capacity',
          'Recipe identity capacity was reached.',
        );
        recipeId = String(sequence);
        this.db.run('UPDATE admin_meta SET next_recipe=next_recipe+1 WHERE id=1');
      }
      const draftId = randomUUID();
      const originalEvidence = baseline ? JSON.stringify(baseline) : null;
      const draft = this.decorate(
        {
          draftId,
          recipeId,
          revision: 1,
          status: 'draft',
          input,
          basedOn: (baseline?.ref as RecipeContentRef) ?? null,
          updatedAt: this.now().toISOString(),
          updatedBy: actor.user,
          metadata: unknownReviewedMetadata(),
          approval: null,
          review: null,
          rights: [],
          validationIssues: [],
          photoUrl: null,
        },
        originalEvidence,
      );
      this.db.run('INSERT INTO admin_draft VALUES(?,?,?)', draftId, recipeId, 1);
      this.write(draft, originalEvidence);
      const result = { operationId, draft };
      recordOperation(this.db, actor, operationId, 'create', fingerprint, result);
      return result;
    });
  }
  mutate(
    actor: Actor,
    id: string,
    operationId: string,
    expectedRevision: number,
    action:
      | { kind: 'save'; input: AdminDraftInput }
      | { kind: 'restore'; sourceRevision: number }
      | { kind: 'rights'; input: AdminRightsInput }
      | { kind: 'metadata'; input: unknown }
      | { kind: 'review'; decision: 'approved' | 'changes_requested'; note: string },
  ): AdminMutation {
    const fingerprint = sha256(
      canonicalContentJson({ id, expectedRevision, action }, 1024 * 1024 + 4096),
    );
    const roles: readonly AdminRole[] =
      action.kind === 'review' || action.kind === 'rights' || action.kind === 'metadata'
        ? ['reviewer', 'administrator']
        : ['editor', 'reviewer', 'administrator'];
    return this.db.transaction(() => {
      this.db.assertActor(actor, this.now().getTime(), roles);
      const existing = operationResult<AdminMutation>(
        this.db,
        actor,
        operationId,
        action.kind,
        fingerprint,
      );
      if (existing) return this.withReview(existing);
      if (
        action.kind === 'rights' ||
        action.kind === 'metadata' ||
        (action.kind === 'review' && action.decision === 'approved')
      )
        requireRecentReviewIdentity(this.db, actor, this.now().getTime());
      const current = this.read(id);
      requireAdmin(
        current.revision === expectedRevision,
        409,
        'revision_conflict',
        'This draft changed. Reload its latest revision before saving.',
      );
      requireAdmin(
        Number.isSafeInteger(current.revision + 1),
        409,
        'revision_capacity',
        'Draft revision capacity was reached.',
      );
      const next = this.decorate({
        ...current,
        revision: current.revision + 1,
        status: 'draft',
        approval: null,
        review: null,
        metadata:
          action.kind === 'restore' ||
          (action.kind === 'save' && recipeMetadataContextChanged(current.input, action.input))
            ? unknownReviewedMetadata()
            : current.metadata,
        rights: action.kind === 'restore' ? [] : (current.rights ?? []),
        updatedAt: this.now().toISOString(),
        updatedBy: actor.user,
        input:
          action.kind === 'save'
            ? action.input
            : action.kind === 'restore'
              ? {
                  ...this.read(id, action.sourceRevision).input,
                  changeSummary: `Restored draft revision ${action.sourceRevision}.`,
                }
              : current.input,
      });
      if (action.kind === 'metadata')
        next.metadata = applyMetadataReview(
          current.metadata,
          action.input,
          actor.user.userId,
          next.updatedAt,
        );
      if (action.kind === 'rights') {
        const binding = scopedRightsContent(this.db, next).bindings[action.input.scope];
        requireAdmin(
          binding,
          409,
          'rights_scope_unavailable',
          'This draft has no content for the selected permission scope.',
        );
        next.rights = [
          ...(next.rights ?? []).filter((record) => record.scope !== action.input.scope),
          {
            ...action.input,
            reviewerId: actor.user.userId,
            reviewedAt: next.updatedAt,
            inputRevision: current.revision,
            contentBinding: binding,
          },
        ];
        // Keep deterministic scope ordering and recompute readiness from the new server record.
        Object.assign(next, this.decorate(next));
      }
      if (action.kind === 'review' && action.decision === 'approved') {
        requireAdmin(
          next.validationIssues.length === 0,
          409,
          'review_blocked',
          'The draft has unresolved readiness issues.',
        );
        next.status = 'reviewed';
        next.approval = {
          reviewerId: actor.user.userId,
          reviewedAt: next.updatedAt,
          revision: next.revision,
          note: action.note,
        };
      }
      // Review evidence is retained separately from the recipe's original words and measurements.
      const evidence = this.db.get<{ original_evidence: string | null }>(
        'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
        id,
      )!.original_evidence;
      next.review =
        action.kind === 'review'
          ? {
              decision: action.decision,
              note: action.note,
              reviewerId: actor.user.userId,
              reviewedAt: next.updatedAt,
              inputRevision: current.revision,
            }
          : null;
      this.write(next, evidence, next.review ? JSON.stringify(next.review) : null);
      const result = { operationId, draft: next };
      recordOperation(this.db, actor, operationId, action.kind, fingerprint, result);
      return result;
    });
  }
  library(
    query: string,
    status: AdminLibraryStatus,
    cursor: string | null,
    lifecycle: LibraryLifecycle,
  ): AdminLibrary {
    lifecycle.assertCurrent();
    requireAdmin(
      !['published', 'archived'].includes(status) || lifecycle.publicationStatus.status === 'ready',
      503,
      'publication_not_configured',
      'Signed publication status is not configured. Published and archived results cannot be determined. Draft views remain available.',
    );
    const libraryRevision = lifecycle.revision;
    const criteria = sha256(canonicalContentJson({ query, status }));
    const publication = sha256(canonicalContentJson(lifecycle.publicationStatus));
    let offset = 0;
    if (cursor) {
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        value = null;
      }
      const parsed = value as {
        revision?: unknown;
        criteria?: unknown;
        offset?: unknown;
        publication?: unknown;
      } | null;
      requireAdmin(
        parsed &&
          typeof parsed === 'object' &&
          Object.keys(parsed).sort().join(',') === 'criteria,offset,publication,revision' &&
          Number.isSafeInteger(parsed.offset) &&
          (parsed.offset as number) >= 0 &&
          parsed.criteria === criteria,
        400,
        'invalid_cursor',
        'This library cursor does not match the search.',
      );
      requireAdmin(
        parsed.revision === libraryRevision && parsed.publication === publication,
        409,
        'library_changed',
        'The library changed. Refresh the list.',
      );
      offset = parsed.offset as number;
    }
    const items: Omit<AdminLibraryItem, 'preparation' | 'publication'>[] = [
      'all',
      'bundled',
      'published',
      'archived',
    ].includes(status)
      ? catalogue.recipes.map((recipe) => ({
          recipeId: recipe.recipeId,
          draftId: null,
          title: recipe.title,
          category: recipe.category,
          cuisine: recipe.cuisine,
          status: 'bundled',
          revision: null,
          photoUrl: `/admin/api/baseline/${recipe.recipeId}/photo`,
          updatedAt: null,
        }))
      : [];
    if (status !== 'bundled') {
      const rows = this.db.all<{ document: string }>(
        `SELECT json_object('recipeId',d.recipe_id,'draftId',d.draft_id,'title',json_extract(r.document,'$.input.title'),'category',json_extract(r.document,'$.input.category'),'cuisine',json_extract(r.document,'$.input.cuisine'),'status',json_extract(r.document,'$.status'),'revision',d.revision,'photoUrl',json_extract(r.document,'$.photoUrl'),'updatedAt',json_extract(r.document,'$.updatedAt')) document FROM admin_draft d JOIN admin_draft_revision r ON r.draft_id=d.draft_id AND r.revision=d.revision`,
      );
      items.push(
        ...rows.map(
          (row) =>
            JSON.parse(row.document) as Omit<AdminLibraryItem, 'preparation' | 'publication'>,
        ),
      );
    }
    const filtered = items
      .map((row) => libraryItemStatus(row, lifecycle))
      .filter((row) => matchesLibraryStatus(row, status))
      .filter((row) =>
        `${row.title}\n${row.category}\n${row.cuisine}`
          .toLocaleLowerCase('en')
          .includes(query.toLocaleLowerCase('en')),
      )
      .sort((a, b) => {
        const left = `${a.recipeId}:${a.draftId ?? ''}`;
        const right = `${b.recipeId}:${b.draftId ?? ''}`;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    lifecycle.assertCurrent();
    return {
      items: filtered.slice(offset, offset + 50),
      publicationStatus: lifecycle.publicationStatus,
      nextCursor:
        offset + 50 < filtered.length
          ? Buffer.from(
              JSON.stringify({
                revision: libraryRevision,
                criteria,
                publication,
                offset: offset + 50,
              }),
            ).toString('base64url')
          : null,
    };
  }
}
