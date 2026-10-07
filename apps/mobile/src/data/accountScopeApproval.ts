import {
  createAccountScopeApprovalEvidence,
  validateAccountScopeApprovalEvidence,
} from '@cookmate/account-sync';
import type { AccountReplicationScope, AccountScopeApprovalEvidence } from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import {
  ACCOUNT_SETTINGS_KEY,
  exact,
  fail,
  journalKey,
  readBinding,
  readJournal,
  readMetadata,
  revision,
  uuid,
  writeMetadata,
} from './accountReplicationRecords';
import { historyCount } from './cookingHistoryRows';
import { readPersonalState } from './personalRecords';
import { freezeResult, readRevision } from './query';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';

export const ACCOUNT_SCOPE_APPROVAL_MAX_BYTES = 1024;
type Sha256 = (text: string) => Promise<string>;

export function accountScopeApprovalKey(ownerId: string): string {
  if (!uuid(ownerId)) fail('invalid_input');
  return `account-replication:scope:${ownerId}`;
}

/** A digest detects changed evidence; it is not remote consent or a credential. */
export async function readAccountScopeApproval(
  session: SqlSession,
  ownerId: string,
  sha256: Sha256,
): Promise<Immutable<AccountScopeApprovalEvidence> | null> {
  const key = accountScopeApprovalKey(ownerId);
  const binding = await readBinding(session);
  if (binding !== null && binding !== ownerId) fail('different_data_owner');
  const value = await readMetadata(session, key, ACCOUNT_SCOPE_APPROVAL_MAX_BYTES);
  if (value === null) return null;
  if (!validateAccountScopeApprovalEvidence(value) || value.record.ownerId !== ownerId)
    fail('stored_data_invalid');
  const evidence = await createAccountScopeApprovalEvidence(value.record, sha256);
  if (evidence.digest !== value.digest) fail('stored_data_invalid');
  return freezeResult(evidence);
}

export interface AccountScopeApprovalCounts {
  notes: number;
  collections: number;
  memberships: number;
  manualItems: number;
  cookingHistory: number;
}
export interface AccountScopeApprovalReview {
  reviewId: string;
  ownerId: string;
  /** Live personal records and saved history in the current history epoch. */
  counts: AccountScopeApprovalCounts;
  historyIncluded: boolean;
  previousApprovalDigest: string | null;
}
export interface AccountScopeApprovalOptions {
  reader: SerializedReader;
  writer: SerializedWriter;
  currentScope(): AccountReplicationScope | null;
  now(): string;
  newId(): string;
  sha256: Sha256;
}
export interface AccountScopeApprovalService {
  read(scope: AccountReplicationScope): Promise<Immutable<AccountScopeApprovalEvidence> | null>;
  review(scope: AccountReplicationScope): Promise<Immutable<AccountScopeApprovalReview>>;
  approve(
    scope: AccountReplicationScope,
    review: Immutable<AccountScopeApprovalReview>,
    choice: { historyIncluded: boolean },
  ): Promise<Immutable<AccountScopeApprovalEvidence>>;
}
interface ReviewFence {
  ownerId: string;
  authGeneration: number;
  binding: string | null;
  storeRevision: number;
  personalRevision: number;
  personalEpoch: number;
  historyRevision: number;
  historyEpoch: number;
  previousApprovalDigest: string | null;
  counts: AccountScopeApprovalCounts;
}

async function requirePersonalSchema(session: SqlSession): Promise<void> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 5 && version !== 6) fail('stored_data_invalid');
}

/** Standalone approval storage only: no network, journal transition, or cooking-data mutation. */
export function createAccountScopeApprovalService(
  options: AccountScopeApprovalOptions,
): AccountScopeApprovalService {
  const reviews = new WeakMap<Immutable<AccountScopeApprovalReview>, ReviewFence>();

  function admission(value: AccountReplicationScope) {
    if (
      !exact(value, ['ownerId', 'authGeneration']) ||
      !uuid(value.ownerId) ||
      !revision(value.authGeneration)
    )
      fail('invalid_input');
    const scope = { ownerId: value.ownerId, authGeneration: value.authGeneration };
    const assert = (): undefined => {
      const current = options.currentScope();
      if (
        !current ||
        current.ownerId !== scope.ownerId ||
        current.authGeneration !== scope.authGeneration
      )
        fail('account_changed');
      return undefined;
    };
    assert();
    return { scope, assert };
  }

  async function available(session: SqlSession, ownerId: string): Promise<string | null> {
    await requirePersonalSchema(session);
    const binding = await readBinding(session);
    if (binding !== null && binding !== ownerId) fail('different_data_owner');
    // Foreign journals indicate broken owner isolation; their private payloads are not read.
    if (
      (
        await session.all(
          "SELECT 1 FROM app_metadata WHERE key GLOB 'account-replication:journal:*' AND key<>? LIMIT 1",
          [journalKey(ownerId)],
        )
      ).length
    )
      fail('stored_data_invalid');
    const journal = await readJournal(session, ownerId, options.sha256);
    if (journal && binding !== ownerId) fail('stored_data_invalid');
    if (journal?.pending) fail('operation_pending');
    if ((await readMetadata(session, ACCOUNT_SETTINGS_KEY, 4096)) !== null)
      fail('settings_pending');
    return binding;
  }

  async function capture(session: SqlSession, scope: AccountReplicationScope) {
    const binding = await available(session, scope.ownerId);
    const approval = await readAccountScopeApproval(session, scope.ownerId, options.sha256);
    const storeRevision = await readRevision(session, 'store');
    const personal = await readPersonalState(session);
    const historyRows = await session.all<{ historyRevision: number; historyEpoch: number }>(
      'SELECT history_revision AS historyRevision,history_epoch AS historyEpoch FROM cooking_state WHERE singleton=1',
    );
    const history = historyRows[0];
    if (
      historyRows.length !== 1 ||
      !history ||
      !revision(history.historyRevision) ||
      !revision(history.historyEpoch)
    )
      fail('stored_data_invalid');
    const countRows = await session.all<Omit<AccountScopeApprovalCounts, 'cookingHistory'>>(
      `SELECT
        (SELECT COUNT(*) FROM recipe_note WHERE deleted=0) AS notes,
        (SELECT COUNT(*) FROM personal_collection WHERE deleted=0) AS collections,
        (SELECT COUNT(*) FROM personal_collection_member m JOIN personal_collection c ON c.collection_id=m.collection_id WHERE m.present=1 AND c.deleted=0) AS memberships,
        (SELECT COUNT(*) FROM manual_shopping_item WHERE deleted=0) AS manualItems`,
    );
    if (countRows.length !== 1) fail('stored_data_invalid');
    const counts: AccountScopeApprovalCounts = {
      ...countRows[0]!,
      cookingHistory: await historyCount(session, history.historyEpoch),
    };
    if (!Object.values(counts).every(revision)) fail('stored_data_invalid');
    const fence: ReviewFence = {
      ...scope,
      binding,
      storeRevision,
      personalRevision: personal.revision,
      personalEpoch: personal.epoch,
      ...history,
      previousApprovalDigest: approval?.digest ?? null,
      counts,
    };
    return { approval, fence };
  }

  return Object.freeze<AccountScopeApprovalService>({
    read: async (value) => {
      const { scope, assert } = admission(value);
      const evidence = await options.reader.transaction(
        async (session) => {
          assert();
          await requirePersonalSchema(session);
          return readAccountScopeApproval(session, scope.ownerId, options.sha256);
        },
        { kind: 'read_only' },
        assert,
      );
      assert();
      return evidence;
    },
    review: async (value) => {
      const { scope, assert } = admission(value);
      const result = await options.reader.transaction(
        async (session) => {
          assert();
          const { approval, fence } = await capture(session, scope);
          const reviewId = options.newId();
          if (!uuid(reviewId)) fail('invalid_input');
          const review = freezeResult<AccountScopeApprovalReview>({
            reviewId,
            ownerId: scope.ownerId,
            counts: fence.counts,
            historyIncluded: approval?.record.historyIncluded ?? false,
            previousApprovalDigest: fence.previousApprovalDigest,
          });
          return { review, fence };
        },
        { kind: 'read_only' },
        assert,
      );
      assert();
      reviews.set(result.review, result.fence);
      return result.review;
    },
    approve: async (value, review, choice) => {
      const { scope, assert } = admission(value);
      if (!exact(choice, ['historyIncluded']) || typeof choice.historyIncluded !== 'boolean')
        fail('invalid_input');
      const historyIncluded = choice.historyIncluded;
      const before = reviews.get(review);
      if (!before) fail('scope_review_required');
      if (before.ownerId !== scope.ownerId || before.authGeneration !== scope.authGeneration)
        fail('account_changed');
      // A failed or uncertain attempt requires a new review; persisted evidence remains readable.
      reviews.delete(review);
      const evidence = await options.writer.transaction(
        async (session) => {
          assert();
          const { fence: current } = await capture(session, scope);
          if (current.binding !== before.binding) fail('different_data_owner');
          if (current.previousApprovalDigest !== before.previousApprovalDigest)
            fail('scope_changed');
          if (
            current.storeRevision !== before.storeRevision ||
            current.personalRevision !== before.personalRevision ||
            current.personalEpoch !== before.personalEpoch ||
            current.historyRevision !== before.historyRevision ||
            current.historyEpoch !== before.historyEpoch ||
            (Object.keys(current.counts) as (keyof AccountScopeApprovalCounts)[]).some(
              (key) => current.counts[key] !== before.counts[key],
            )
          )
            fail('local_changed');
          const approved = await createAccountScopeApprovalEvidence(
            {
              schemaVersion: 1,
              ownerId: scope.ownerId,
              scopeVersion: 2,
              personalApproved: true,
              historyIncluded,
              decidedAt: options.now(),
            },
            options.sha256,
          );
          assert();
          await writeMetadata(
            session,
            accountScopeApprovalKey(scope.ownerId),
            approved,
            ACCOUNT_SCOPE_APPROVAL_MAX_BYTES,
          );
          assert();
          return freezeResult(approved);
        },
        { kind: 'none' },
        assert,
      );
      assert();
      return evidence;
    },
  });
}
