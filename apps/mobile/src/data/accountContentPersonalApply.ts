import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  validateAccountPersonal,
  type AccountPersonalData,
} from '@cookmate/account-sync';
import { catalogueBoundary } from '@cookmate/catalogue';
import { OVERLAY_LIMITS } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import {
  applyAdmittedAccountPersonal,
  type AccountPersonalApplyResult,
} from './accountPersonalApply';
import { fail, readBinding, uuid } from './accountReplicationRecords';
import type { ContentReferenceInspectionView } from './contentReleaseStore';
import { readAccountContentPersonalRows } from './portablePersonalRestore';
import { runBound, type SqlSession, type SqlValue } from './sql';

export interface AccountContentPersonalApplyOptions {
  ownerId: string;
  /** The authenticated adopted inventory must remain reserved through the caller's commit. */
  view: ContentReferenceInspectionView;
  /** Live owner/generation/installation and captured restore/adoption fencing belongs to the host. */
  assertAccess(): undefined;
}

function ownCandidate(input: Immutable<AccountPersonalData>): AccountPersonalData {
  let value: unknown;
  try {
    value = JSON.parse(canonicalPortableContentJson(input, ACCOUNT_SNAPSHOT_MAX_BYTES));
  } catch (error) {
    fail(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
  if (!validateAccountPersonal(value)) fail('invalid_input');
  return value;
}

function ownIdentities(input: readonly string[]): ReadonlySet<string> {
  let value: unknown;
  try {
    value = JSON.parse(canonicalPortableContentJson(input, 512 * 1024));
  } catch {
    fail('stored_data_invalid');
  }
  if (
    !Array.isArray(value) ||
    value.length > OVERLAY_LIMITS.overrides + catalogueBoundary.recipeIds.size ||
    !value.every((id): id is string => typeof id === 'string' && /^[0-9]{1,20}$/.test(id)) ||
    new Set(value).size !== value.length
  )
    fail('stored_data_invalid');
  return new Set(value);
}

/**
 * Private schema8 data-level reviewed primitive, never an approval or complete account apply.
 * The host must recompute mergeAccountContentSnapshots with reviewPersonalRemovals:true, bind
 * its exact resolutions/candidate to an issued review and recheck that captured scope. A journal
 * fingerprint cannot replace this review. Live counterparts of retained removal keys are allowed.
 * The host owns content-before-cooking lock order, SQL transaction and final commit/postack guard.
 * No body lookup, restore deletion synthesis, receipt mutation or runtime activation occurs here.
 */
export async function applyReviewedAccountContentPersonal(
  raw: SqlSession,
  personal: Immutable<AccountPersonalData>,
  options: AccountContentPersonalApplyOptions,
): Promise<AccountPersonalApplyResult> {
  const { ownerId, view, assertAccess } = options;
  if (!uuid(ownerId)) fail('invalid_input');
  const active = () => {
    if (assertAccess() !== undefined || view.assertActive() !== undefined) fail('account_changed');
  };
  active();
  const candidate = ownCandidate(personal),
    identities = ownIdentities(view.adoptedRecipeIds);
  active();
  const ids = [
    ...new Set([...candidate.notes, ...candidate.memberships].map((row) => row.recipeId)),
  ];
  if (ids.some((id) => !identities.has(id))) fail('invalid_input');
  const session: SqlSession = {
    async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
      active();
      const result = await raw.all<Row>(sql, values);
      active();
      return result;
    },
    async exec(sql) {
      active();
      await raw.exec(sql);
      active();
    },
    async prepare(sql) {
      active();
      const statement = await raw.prepare(sql);
      try {
        active();
      } catch (error) {
        await statement.finalize();
        throw error;
      }
      return {
        async run(values) {
          active();
          await statement.run(values);
          active();
        },
        // Finalization must still run after authority expires; the enclosing transaction rolls back.
        async finalize() {
          await statement.finalize();
          active();
        },
      };
    },
  };
  if (
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8 ||
    (await session.all<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]?.foreign_keys !== 1
  )
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  // Existing orphan relationships are corruption, not permission to repair them from new input.
  const orphan = await session.all<{ invalid: number }>(
    `SELECT 1 invalid FROM recipe_note n LEFT JOIN recipe_identity r ON r.recipe_id=n.recipe_id WHERE r.recipe_id IS NULL
     UNION ALL SELECT 1 invalid FROM personal_collection_member m LEFT JOIN recipe_identity r ON r.recipe_id=m.recipe_id WHERE r.recipe_id IS NULL LIMIT 1`,
  );
  if (orphan.length) fail('stored_data_invalid');
  const { state, personal: current } = await readAccountContentPersonalRows(session);
  const result = await applyAdmittedAccountPersonal(
    session,
    candidate,
    state,
    current,
    async () => {
      // Only exact admitted IDs can be selected/materialized, below SQLite's older variable limit.
      const batchSize = 400;
      for (let start = 0; start < ids.length; start += batchSize) {
        const batch = ids.slice(start, start + batchSize);
        const rows = await session.all<{ recipeId: string }>(
          `SELECT recipe_id recipeId FROM recipe_identity WHERE recipe_id IN (${batch.map(() => '?').join(',')})`,
          batch,
        );
        const existing = new Set(rows.map((row) => row.recipeId));
        if (rows.length !== existing.size || rows.some((row) => !batch.includes(row.recipeId)))
          fail('stored_data_invalid');
        for (const recipeId of batch)
          if (!existing.has(recipeId))
            await runBound(session, 'INSERT INTO recipe_identity(recipe_id) VALUES (?)', [
              recipeId,
            ]);
      }
    },
  );
  active();
  return result;
}
