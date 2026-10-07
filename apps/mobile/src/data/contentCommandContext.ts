import {
  canonicalContentJson,
  createBundledContentReader,
  createBundledRecipeRevision,
  createContentReader,
  OVERLAY_LIMITS,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { catalogueBoundary, readonlyIds } from '@cookmate/catalogue';
import type { CatalogueBoundary, PlanOccurrence } from '@cookmate/contracts';
import type { Immutable } from '@cookmate/domain';
import { rejectCommand } from './commandExecutor';
import {
  readAdoptionInSnapshot,
  requireCookingContentReadVersion,
  retainCookingRevisionInSnapshot,
  retainVerifiedRevisionsForSchemaInSnapshot,
} from './cookingContentRepository';
import type { ContentReadingView } from './contentReleaseStore';
import {
  createPinnedShoppingProjectionOptions,
  readPinnedShoppingContextInSnapshot,
} from './pinnedShoppingRepository';
import {
  REVISION_SHOPPING_LIMITS,
  type PinnedShoppingOccurrence,
} from './revisionShoppingProjection';
import type { StoredShoppingProjectionOptions } from './shoppingRepository';
import { runBound, StorageFault, type SqlSession, type SqlValue } from './sql';

const issued = new WeakMap<object, 7 | 8>();
const same = (a: unknown, b: unknown) =>
  canonicalContentJson(a, 4096) === canonicalContentJson(b, 4096);
function stored(value: unknown): asserts value {
  if (!value) throw new StorageFault('storage_failure', 'Command content evidence is invalid');
}
export interface ContentCommandContext {
  /** Identity validation only. Use consistently for prepare/register/execute/readReceipt. */
  readonly commandBoundary: CatalogueBoundary;
  enter(session: SqlSession): Promise<SqlSession>;
  readPin(session: SqlSession, occurrenceId: string, recipeId: string): Promise<RecipeContentRef>;
  /** Read-only admission for new/different targets; does not retain or write content. */
  requireCurrent(recipeId: string): RecipeContentRef;
  retainCurrent(session: SqlSession, recipeId: string): Promise<RecipeContentRef>;
  insertPin(session: SqlSession, occurrenceId: string, ref: RecipeContentRef): Promise<void>;
  requirePlanCapacity(session: SqlSession): Promise<void>;
  projection(session: SqlSession): Promise<StoredShoppingProjectionOptions>;
  projectionForOccurrences(
    session: SqlSession,
    occurrences: readonly Immutable<PlanOccurrence>[],
  ): Promise<StoredShoppingProjectionOptions>;
}

/**
 * Host composition only, inside withVerifiedReading. The host keeps that reservation
 * through command execution and owns owner/restore and final commit admission.
 * This context adds exact content evidence to the existing command/receipt protocol.
 */
export async function createContentCommandContext(options: {
  view: ContentReadingView;
  expectedAdoptionRevision: number;
  commandSchemaVersion?: 7 | 8;
  sha256(text: string): Promise<string>;
}): Promise<ContentCommandContext> {
  const { view, expectedAdoptionRevision, sha256, commandSchemaVersion = 7 } = options;
  const check = () => stored(view.assertActive() === undefined);
  check();
  stored(commandSchemaVersion === 7 || commandSchemaVersion === 8);
  stored(Number.isSafeInteger(expectedAdoptionRevision) && expectedAdoptionRevision >= 0);
  const head = JSON.parse(canonicalContentJson(view.head, 1024)) as ContentReadingView['head'];
  const snapshot = view.snapshot;
  if (head) {
    stored(
      snapshot &&
        same(head, {
          releaseId: snapshot.envelope.manifest.releaseId,
          sequence: snapshot.envelope.manifest.sequence,
          fingerprint: snapshot.envelope.fingerprint,
        }),
    );
  } else stored(snapshot === null && !view.hasWithdrawal);
  const reading = snapshot
    ? createContentReader(snapshot)
    : await createBundledContentReader(sha256);
  check();
  stored(!snapshot || snapshot.entries.length <= OVERLAY_LIMITS.overrides);
  // Cumulative verified entries retain an authored identity after archive/withdrawal,
  // including after its final plan row is deleted. Discovery cannot validate these
  // existing effects or durable receipts; this boundary grants no content access.
  const knownIds = new Set(catalogueBoundary.recipeIds);
  for (const entry of snapshot?.entries ?? [])
    knownIds.add(entry.state === 'withdrawn' ? entry.recipeId : entry.ref.recipeId);
  const recipeIds = readonlyIds(knownIds);
  const commandBoundary: CatalogueBoundary = Object.freeze({
    identity: reading.boundary.identity,
    recipeIds,
    hasSource: reading.boundary.hasSource,
  });
  const checkedHash = async (text: string) => {
    check();
    const result = await sha256(text);
    check();
    return result;
  };
  const context: ContentCommandContext = Object.freeze({
    commandBoundary,
    async enter(raw: SqlSession) {
      check();
      // Guard every awaited handler I/O; cleanup remains possible after reservation expiry.
      const session: SqlSession = {
        async exec(sql) {
          check();
          await raw.exec(sql);
          check();
        },
        async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
          check();
          const rows = await raw.all<Row>(sql, values);
          check();
          return rows;
        },
        async prepare(sql) {
          check();
          const statement = await raw.prepare(sql);
          try {
            check();
          } catch (error) {
            await statement.finalize();
            throw error;
          }
          return {
            async run(values) {
              check();
              await statement.run(values);
              check();
            },
            finalize: () => statement.finalize(),
          };
        },
      };
      stored((await requireCookingContentReadVersion(session)) === commandSchemaVersion);
      const adoption = await readAdoptionInSnapshot(session);
      if (adoption.revision !== expectedAdoptionRevision || !same(adoption.head, head))
        rejectCommand('stale_context', 'content.adoption_changed');
      const counts = (
        await session.all<{ plans: number; pins: number }>(
          'SELECT (SELECT COUNT(*) FROM plan_occurrence) plans,(SELECT COUNT(*) FROM plan_content_pin) pins',
        )
      )[0];
      stored(counts && counts.plans <= 20_000 && counts.pins === counts.plans);
      for (const [table, columns, integers] of [
        [
          'plan_occurrence',
          [
            ['occurrence_id', 36],
            ['recipe_id', 20],
            ['local_date', 10],
            ['meal_key', 16],
            ['created_at', 40],
            ['updated_at', 40],
          ],
          ['revision'],
        ],
        [
          'plan_content_pin',
          [
            ['occurrence_id', 36],
            ['recipe_id', 20],
            ['revision_id', 120],
            ['content_fingerprint', 64],
          ],
          [],
        ],
      ] as const) {
        stored(
          (
            await session.all(
              `SELECT 1 FROM ${table} WHERE ${[
                ...columns.map(
                  ([name, max]) =>
                    `typeof(${name})<>'text' OR length(CAST(${name} AS BLOB))>${max}`,
                ),
                ...integers.map(
                  (name) => `typeof(${name})<>'integer' OR ${name}<0 OR ${name}>9007199254740991`,
                ),
              ].join(' OR ')} LIMIT 1`,
            )
          ).length === 0,
        );
      }
      stored(
        (
          await session.all(`SELECT 1 FROM plan_content_pin s WHERE NOT EXISTS (
        SELECT 1 FROM plan_occurrence p WHERE p.occurrence_id=s.occurrence_id AND p.recipe_id=s.recipe_id
      ) LIMIT 1`)
        ).length === 0,
      );
      return session;
    },
    async readPin(session: SqlSession, occurrenceId: string, recipeId: string) {
      const [row] = await session.all<{
        recipeId: string | null;
        revisionId: string | null;
        contentFingerprint: string | null;
        retained: number;
      }>(
        `SELECT CASE WHEN typeof(s.recipe_id)='text' AND length(CAST(s.recipe_id AS BLOB))<=20 THEN s.recipe_id END recipeId,
          CASE WHEN typeof(s.revision_id)='text' AND length(CAST(s.revision_id AS BLOB))<=120 THEN s.revision_id END revisionId,
          CASE WHEN typeof(s.content_fingerprint)='text' AND length(CAST(s.content_fingerprint AS BLOB))=64 THEN s.content_fingerprint END contentFingerprint,
          EXISTS(SELECT 1 FROM recipe_content_revision r WHERE r.recipe_id=s.recipe_id AND r.revision_id=s.revision_id AND r.content_fingerprint=s.content_fingerprint) retained
          FROM plan_content_pin s WHERE s.occurrence_id=?`,
        [occurrenceId],
      );
      const ref = row && {
        recipeId: row.recipeId,
        revisionId: row.revisionId,
        contentFingerprint: row.contentFingerprint,
      };
      stored(row?.retained === 1 && validateRecipeContentRef(ref) && ref.recipeId === recipeId);
      return ref;
    },
    requireCurrent(recipeId: string) {
      check();
      const value = reading.lookupCurrent(recipeId);
      if (value.kind !== 'readable' || value.state !== 'current')
        rejectCommand('stale_context', 'content.current_recipe_unavailable');
      return { ...value.recipe.contentRef };
    },
    async retainCurrent(session: SqlSession, recipeId: string) {
      const ref = context.requireCurrent(recipeId);
      stored((await requireCookingContentReadVersion(session)) === commandSchemaVersion);
      check();
      if (snapshot)
        await retainVerifiedRevisionsForSchemaInSnapshot(
          session,
          snapshot,
          [ref],
          checkedHash,
          commandSchemaVersion,
        );
      else {
        const baseline = await createBundledRecipeRevision(recipeId, checkedHash);
        stored(same(baseline.ref, ref));
        await retainCookingRevisionInSnapshot(session, baseline, checkedHash);
      }
      check();
      return ref;
    },
    async insertPin(session: SqlSession, occurrenceId: string, ref: RecipeContentRef) {
      stored(validateRecipeContentRef(ref));
      await runBound(session, 'INSERT INTO plan_content_pin VALUES (?,?,?,?)', [
        occurrenceId,
        ref.recipeId,
        ref.revisionId,
        ref.contentFingerprint,
      ]);
    },
    async requirePlanCapacity(session: SqlSession) {
      const [row] = await session.all<{ count: number }>(
        'SELECT COUNT(*) count FROM plan_occurrence',
      );
      stored(row && row.count < 20_000);
    },
    async projection(session: SqlSession) {
      check();
      const result = await readPinnedShoppingContextInSnapshot(session, {
        lookupExact: reading.lookupExact,
        sha256: checkedHash,
      });
      check();
      return result.options;
    },
    async projectionForOccurrences(
      session: SqlSession,
      occurrences: readonly Immutable<PlanOccurrence>[],
    ) {
      check();
      stored(
        Array.isArray(occurrences) && occurrences.length <= REVISION_SHOPPING_LIMITS.occurrences,
      );
      const pinned: PinnedShoppingOccurrence[] = [];
      for (const occurrence of occurrences) {
        const ref = await context.readPin(session, occurrence.occurrenceId, occurrence.recipeId);
        check();
        pinned.push({ occurrence, contentRef: ref });
      }
      return createPinnedShoppingProjectionOptions(pinned, {
        lookupExact: reading.lookupExact,
        sha256: checkedHash,
      });
    },
  });
  issued.set(context, commandSchemaVersion);
  return context;
}

/** Legacy callers cannot write schema 7/8 without an explicitly issued verified context. */
export async function contentCommandSession(
  session: SqlSession,
  context?: ContentCommandContext,
): Promise<SqlSession> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (context) {
    stored(issued.has(context) && version === issued.get(context));
    return context.enter(session);
  }
  stored(version !== undefined && version >= 2 && version <= 6);
  return session;
}
