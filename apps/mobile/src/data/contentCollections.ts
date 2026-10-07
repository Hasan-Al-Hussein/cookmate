import { catalogueBoundary } from '@cookmate/catalogue';
import { canonicalContentJson, OVERLAY_LIMITS } from '@cookmate/catalogue/content';
import { personalLimits, portablePersonalLimits } from '@cookmate/domain';
import type {
  CollectionMembership,
  DeleteCollectionReview,
  Immutable,
  PersonalCommand,
  PersonalMutationResult,
  PersonalService,
  RepositoryResult,
} from '@cookmate/domain';
import {
  createContentPersonalAdmission,
  samePersonalFence,
  type ContentPersonalOptions,
  type PreparePersonalRows,
} from './contentPersonalAdmission';
import type { openContentReleaseStore } from './contentReleaseStore';
import { isAppId, isRevision } from './conversationRecords';
import {
  collectionColumns,
  membershipColumns,
  parseCollection,
  parseMembership,
  personalExact,
  personalObject,
  personalPositive,
  personalText,
  readPersonalReceipt,
  type CollectionRow,
  type MembershipRow,
} from './personalRecords';
import { runBound, type SqlSession } from './sql';

export type ContentCollectionCommand = Extract<
  PersonalCommand,
  { kind: 'createCollection' | 'renameCollection' | 'setCollectionMembership' }
>;
export interface ContentRecipeMembershipsSnapshot {
  epoch: number;
  /** Removed rows retain their revision guards; deleted collections are excluded. */
  memberships: CollectionMembership[];
}
export interface ContentCollections extends Pick<
  PersonalService,
  | 'readCollections'
  | 'readCollection'
  | 'reviewDeleteCollection'
  | 'deleteCollection'
  | 'readReceipt'
  | 'resolveOperation'
  | 'subscribe'
> {
  readRecipeMemberships(
    recipeId: string,
  ): Promise<RepositoryResult<Immutable<ContentRecipeMembershipsSnapshot>>>;
  execute(command: Immutable<ContentCollectionCommand>): Promise<PersonalMutationResult>;
  close(): void;
}
interface Options extends ContentPersonalOptions {
  contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReferenceInspection'
  >;
}
interface RecipeTarget {
  recipeId: string;
  collectionId?: string;
  adding?: boolean;
}
const maximumBytes = 8 * 1024 * 1024;
const maximumReviewBytes = 2 * 1024 * 1024;
const recipeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value);

/** Identity-owned memberships use the personal engine; no recipe body or revision pin is created. */
export function createContentCollections(options: Options): ContentCollections {
  const inspect = options.contentStore.withVerifiedReferenceInspection.bind(options.contentStore);
  const knownIds = new Set<string>();
  const reviews = new WeakMap<object, string>();
  const admission = createContentPersonalAdmission(options, {
    family: 'collections',
    commandKinds: ['createCollection', 'renameCollection', 'setCollectionMembership'],
    receiptKinds: [
      'createCollection',
      'renameCollection',
      'setCollectionMembership',
      'deleteCollection',
    ],
    recipeIds: knownIds,
    async beforeSetCollectionMembership(session, id) {
      admission.check();
      if (!knownIds.has(id)) admission.reject('unknown_recipe', 'invalid_input');
      await runBound(
        session,
        'INSERT INTO recipe_identity(recipe_id) VALUES (?) ON CONFLICT(recipe_id) DO NOTHING',
        [id],
      );
    },
    beforeDeleteCollection(review) {
      if (reviews.get(review) !== admission.currentFence())
        admission.reject('delete_review_changed', 'stale_context');
    },
    onClose: () => knownIds.clear(),
  });

  async function admitCollections(session: SqlSession) {
    const [collections] = await session.all<{
      count: number;
      active: number;
      bytes: number;
      invalid: number;
    }>(`SELECT COUNT(*) count,
      COALESCE(SUM(CASE WHEN deleted=0 THEN 1 ELSE 0 END),0) active,
      COALESCE(SUM(length(CAST(collection_id AS BLOB))+COALESCE(length(CAST(name AS BLOB)),0)+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB))),0) bytes,
      COALESCE(SUM(CASE WHEN typeof(collection_id)<>'text' OR length(CAST(collection_id AS BLOB))<>36
      OR (name IS NOT NULL AND (typeof(name)<>'text' OR length(CAST(name AS BLOB))>${personalLimits.collectionNameCharacters * 6 + 2}))
      OR typeof(deleted)<>'integer' OR deleted NOT IN(0,1) OR (deleted=0 AND name IS NULL) OR (deleted=1 AND name IS NOT NULL)
      OR typeof(revision)<>'integer' OR revision<1 OR revision>9007199254740991 OR revision>(SELECT revision FROM personal_state WHERE singleton=1)
      OR typeof(created_at)<>'text' OR length(CAST(created_at AS BLOB))>40 OR typeof(updated_at)<>'text' OR length(CAST(updated_at AS BLOB))>40 THEN 1 ELSE 0 END),0) invalid FROM personal_collection`);
    admission.stored(
      collections &&
        isRevision(collections.count) &&
        collections.count <= portablePersonalLimits.collections &&
        isRevision(collections.active) &&
        collections.active <= personalLimits.collections &&
        isRevision(collections.bytes) &&
        collections.bytes <= maximumBytes &&
        collections.invalid === 0,
    );
    const [members] = await session.all<{
      count: number;
      bytes: number;
      invalid: number;
    }>(`SELECT COUNT(*) count,
      COALESCE(SUM(length(CAST(m.collection_id AS BLOB))+length(CAST(m.recipe_id AS BLOB))+length(CAST(m.updated_at AS BLOB))),0) bytes,
      COALESCE(SUM(CASE WHEN typeof(m.collection_id)<>'text' OR length(CAST(m.collection_id AS BLOB))<>36
      OR typeof(m.recipe_id)<>'text' OR length(CAST(m.recipe_id AS BLOB)) NOT BETWEEN 1 AND 20 OR instr(m.recipe_id,char(0))>0 OR m.recipe_id GLOB '*[^0-9]*'
      OR typeof(m.present)<>'integer' OR m.present NOT IN(0,1)
      OR typeof(m.revision)<>'integer' OR m.revision<1 OR m.revision>9007199254740991 OR m.revision>(SELECT revision FROM personal_state WHERE singleton=1) OR m.revision>c.revision
      OR typeof(m.updated_at)<>'text' OR length(CAST(m.updated_at AS BLOB))>40
      OR c.collection_id IS NULL OR (c.deleted=1 AND m.present=1)
      OR NOT EXISTS(SELECT 1 FROM recipe_identity r WHERE r.recipe_id=m.recipe_id) THEN 1 ELSE 0 END),0) invalid
      FROM personal_collection_member m LEFT JOIN personal_collection c ON c.collection_id=m.collection_id`);
    admission.stored(
      members &&
        isRevision(members.count) &&
        members.count <= portablePersonalLimits.memberships &&
        isRevision(members.bytes) &&
        members.bytes + collections!.bytes <= maximumBytes &&
        members.invalid === 0,
    );
    // Only bounded rows cross the bridge; validate encoded text, IDs and timestamps even off-page.
    const parents = await session.all<CollectionRow>(
      `SELECT ${collectionColumns} FROM personal_collection`,
    );
    parents.forEach(parseCollection);
    return (
      await session.all<MembershipRow>(
        `SELECT ${membershipColumns} FROM personal_collection_member`,
      )
    ).map(parseMembership);
  }
  function prepare(target?: RecipeTarget, operationId?: string): PreparePersonalRows {
    return async (session) => {
      const members = await admitCollections(session);
      // Operation admission already bounded and checked this family's receipt before preparation.
      const replay = operationId ? await readPersonalReceipt(session, operationId) : null;
      const retained =
        target &&
        members.some(
          (member) =>
            member.recipeId === target.recipeId &&
            (target.collectionId === undefined || member.collectionId === target.collectionId),
        );
      return {
        async admit(current) {
          await admitCollections(current);
          if (replay && operationId)
            admission.stored(
              samePersonalFence(await readPersonalReceipt(current, operationId), replay),
            );
        },
        async reserve(head, work) {
          knownIds.clear();
          for (const member of members) knownIds.add(member.recipeId);
          if (replay && target) {
            // Exact replay/cancellation may outlive delivery. The existing fingerprint fences new writes.
            knownIds.add(target.recipeId);
            return work(admission.check);
          }
          // Retained private membership can be read/removed without granting access to a recipe body.
          if (!target || (retained && !target.adding)) return work(admission.check);
          return inspect(head, [], async (view) => {
            const guard = (): undefined => {
              admission.check();
              admission.stored(view.assertActive() === undefined);
              return undefined;
            };
            guard();
            admission.stored(samePersonalFence(view.head, head));
            const ids = view.adoptedRecipeIds;
            admission.stored(
              Array.isArray(ids) &&
                ids.length <= OVERLAY_LIMITS.overrides + catalogueBoundary.recipeIds.size &&
                ids.every(recipeId) &&
                new Set(ids).size === ids.length,
            );
            if (!ids.includes(target.recipeId)) admission.reject('unknown_recipe', 'invalid_input');
            knownIds.add(target.recipeId);
            return work(guard);
          });
        },
        release: () => knownIds.clear(),
      };
    };
  }
  function ownReview(input: Immutable<DeleteCollectionReview>): Immutable<DeleteCollectionReview> {
    const value: unknown = JSON.parse(canonicalContentJson(input, maximumReviewBytes));
    if (
      !personalObject(value) ||
      !personalExact(value, [
        'reviewId',
        'collectionId',
        'name',
        'expectedRevision',
        'epoch',
        'affectedRecipeIds',
      ]) ||
      !isAppId(value.reviewId) ||
      !isAppId(value.collectionId) ||
      !personalText(value.name, personalLimits.collectionNameCharacters) ||
      !personalPositive(value.expectedRevision) ||
      !isRevision(value.epoch) ||
      !Array.isArray(value.affectedRecipeIds) ||
      value.affectedRecipeIds.length > portablePersonalLimits.memberships ||
      !value.affectedRecipeIds.every((id: unknown, index: number, ids: unknown[]) => {
        const previous = ids[index - 1];
        return recipeId(id) && (index === 0 || (typeof previous === 'string' && previous < id));
      })
    )
      admission.reject('invalid_delete_review', 'invalid_input');
    // Preserve the engine's issued-object authority. An owned foreign review may only replay a receipt.
    return reviews.has(input) ? input : (value as unknown as DeleteCollectionReview);
  }
  return Object.freeze({
    readReceipt: admission.service.readReceipt,
    resolveOperation: admission.service.resolveOperation,
    subscribe: admission.service.subscribe,
    close: admission.service.close,
    readCollections: () => admission.read(admission.engine.readCollections, prepare()),
    readCollection(id: string, input?: { cursor?: string; limit?: number }) {
      try {
        if (!isAppId(id)) admission.reject('invalid_collection', 'invalid_input');
        const page: unknown =
          input === undefined ? undefined : JSON.parse(canonicalContentJson(input, 1024));
        if (
          page !== undefined &&
          (!personalObject(page) ||
            Object.keys(page).some((key) => !['cursor', 'limit'].includes(key)))
        )
          admission.reject('invalid_page', 'invalid_input');
        return admission.read(
          () => admission.engine.readCollection(id, page as typeof input),
          prepare(),
        );
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
    readRecipeMemberships(id: string) {
      try {
        if (!recipeId(id)) admission.reject('invalid_recipe', 'invalid_input');
        return admission.read(
          () => admission.engine.readRecipeMemberships(id),
          prepare({ recipeId: id }),
        );
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
    execute(input: Immutable<ContentCollectionCommand>) {
      try {
        const command = admission.ownCommand(input);
        return admission.mutate(
          command.operationId,
          () => admission.engine.execute(command),
          prepare(
            command.kind === 'setCollectionMembership'
              ? {
                  recipeId: command.recipeId,
                  collectionId: command.collectionId,
                  adding: command.present,
                }
              : undefined,
            command.operationId,
          ),
        );
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
    reviewDeleteCollection(id: string) {
      return admission.read(async () => {
        const result = await admission.engine.reviewDeleteCollection(id);
        if (result.kind === 'ready') reviews.set(result.value, admission.currentFence());
        return result;
      }, prepare());
    },
    deleteCollection(input: Immutable<DeleteCollectionReview>, operationId: string) {
      try {
        const review = ownReview(input);
        return admission.mutate(
          operationId,
          () => admission.engine.deleteCollection(review, operationId),
          prepare(),
        );
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
  });
}
