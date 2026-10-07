import {
  AccountSnapshotError,
  emptyAccountSnapshot,
  type AccountCommitReceipt,
  type AccountMergeResolutions,
  type AccountReplicationScope,
} from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import {
  ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES,
  accountLegacyContentTransitionFingerprint,
  serializeAccountLegacyContentTransition,
  type AccountLegacyContentTransition,
  type AccountLegacyContentTransitionDraft,
} from '../../../../packages/account-sync/src/contentLegacyTransition';
import {
  mergeAccountContentSnapshots,
  type AccountContentMergeResult,
} from '../../../../packages/account-sync/src/contentMerge';
import {
  accountContentPendingFingerprint,
  serializeAccountContentJournal,
  type AccountContentPendingDraft,
} from '../../../../packages/account-sync/src/contentReplicationRecords';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import type { AccountContentCaptureOptions } from './accountContentCapture';
import { accountContentJournalKey } from './accountContentJournalStorage';
import { readAccountContentScopeApproval } from './accountContentScopeApproval';
import {
  assertAccountContentRemovalResolution,
  createAccountContentRemovalReview,
  resolveAccountContentRemovalReview,
  type AccountContentRemovalChoices,
  type AccountContentRemovalReview,
} from './accountContentRemovalReview';
import {
  captureAccountLegacyTransitionInSnapshot,
  type AccountLegacyTransitionCapture,
} from './accountLegacyTransitionCapture';
import { accountLegacyContentTransitionKey } from './accountLegacyTransitionKeys';
import { readAccountLegacyContentTransitionState } from './accountLegacyTransitionStorage';
import {
  ACCOUNT_SETTINGS_KEY,
  commitReceipt,
  exact,
  fail,
  remoteState,
  revision,
  uuid,
} from './accountReplicationRecords';
import { freezeResult } from './query';
import {
  runBound,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

export interface AccountLegacyTransitionRepositoryOptions extends AccountContentCaptureOptions {
  reader: Pick<SerializedReader, 'transaction'>;
  writer: Pick<SerializedWriter, 'transaction' | 'requiresRecovery'>;
  newId(): string;
}
export interface AccountLegacyTransitionReview {
  reviewId: string;
  initialImportRequired: boolean;
  merge: AccountContentMergeResult;
  removalReview: AccountContentRemovalReview | null;
}
export interface AccountLegacyTransitionIdentity {
  operationId: string;
  requestFingerprint: string;
}
export interface AccountLegacyTransitionChoices {
  initialImportReviewed: boolean;
  resolutions?: AccountMergeResolutions;
  removalChoices?: AccountContentRemovalChoices;
}
interface Capability {
  scope: Readonly<AccountReplicationScope>;
  capture: Immutable<AccountLegacyTransitionCapture>;
  contextText: string;
  resolutions: AccountMergeResolutions;
  removalReview: Immutable<AccountContentRemovalReview> | null;
  reviewedCandidate: string | null;
  submitted: null | {
    choicesText: string;
    candidateText: string;
    networkOperationId: string;
    localApplyOperationId: string;
  };
}
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a: unknown, b: unknown, maximum = 4096) =>
  canonicalPortableContentJson(a, maximum) === canonicalPortableContentJson(b, maximum);
const ownContent = (value: unknown): AccountContentSnapshot =>
  JSON.parse(canonicalAccountContentSnapshot(value)) as AccountContentSnapshot;
function next(value: number) {
  if (!revision(value) || !Number.isSafeInteger(value + 1)) fail('stored_data_invalid');
  return value + 1;
}
function identity(input: unknown): Readonly<AccountLegacyTransitionIdentity> {
  if (
    !exact(input, ['operationId', 'requestFingerprint']) ||
    !uuid(input.operationId) ||
    !fingerprint(input.requestFingerprint)
  )
    fail('invalid_input');
  return Object.freeze({
    operationId: input.operationId,
    requestFingerprint: input.requestFingerprint,
  });
}
const removalChoicesMaximumBytes = 1024 * 1024;
const stageChoicesMaximumBytes =
  ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES + removalChoicesMaximumBytes + 1024;
function normalChoices(input: unknown): AccountMergeResolutions {
  const resolutions: unknown = JSON.parse(
    canonicalPortableContentJson(input, ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES),
  );
  if (
    !resolutions ||
    typeof resolutions !== 'object' ||
    Array.isArray(resolutions) ||
    Object.keys(resolutions).length > 1000 ||
    Object.entries(resolutions).some(
      ([key, choice]) => !key || (choice !== 'local' && choice !== 'account'),
    )
  )
    fail('invalid_input');
  return freezeResult(resolutions as AccountMergeResolutions);
}
function choices(input: unknown, defaults: AccountMergeResolutions) {
  let value: unknown;
  try {
    value = JSON.parse(canonicalPortableContentJson(input, stageChoicesMaximumBytes));
  } catch {
    return fail('invalid_input');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exact(value, [
      'initialImportReviewed',
      ...(Object.hasOwn(value, 'resolutions') ? ['resolutions'] : []),
      ...(Object.hasOwn(value, 'removalChoices') ? ['removalChoices'] : []),
    ]) ||
    typeof value.initialImportReviewed !== 'boolean'
  )
    fail('invalid_input');
  const resolutions = normalChoices(
    Object.hasOwn(value, 'resolutions') ? value.resolutions : defaults,
  );
  const removalChoices: unknown = Object.hasOwn(value, 'removalChoices')
    ? value.removalChoices
    : {};
  if (
    !removalChoices ||
    typeof removalChoices !== 'object' ||
    Array.isArray(removalChoices) ||
    Object.values(removalChoices).some(
      (choice) => choice !== 'keep_local' && choice !== 'save_account_version',
    )
  )
    fail('invalid_input');
  canonicalPortableContentJson(removalChoices, removalChoicesMaximumBytes);
  return freezeResult({
    initialImportReviewed: value.initialImportReviewed,
    resolutions,
    removalChoices: removalChoices as AccountContentRemovalChoices,
  });
}
function merge(
  capture: Immutable<AccountLegacyTransitionCapture>,
  resolutions?: AccountMergeResolutions,
): AccountContentMergeResult {
  // This provisional ancestor is used only to review an initial import. It is never persisted
  // as an original base, observation or apply receipt.
  const provisional: AccountContentSnapshot = {
    ...emptyAccountSnapshot(capture.local.snapshot.catalogue, {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    }),
    schemaVersion: 3,
    planReferences: [],
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
  };
  return mergeAccountContentSnapshots({
    base: capture.baseConversion?.snapshot ?? provisional,
    local: capture.local.snapshot,
    account: capture.remoteConversion.snapshot,
    contentScope: { schemaVersion: 3, historyIncluded: capture.local.scope.historyIncluded },
    reviewPersonalRemovals: true,
    ...(resolutions === undefined ? {} : { resolutions }),
  });
}
function captureContext(capture: Immutable<AccountLegacyTransitionCapture>) {
  // Complete bounded semantic/fence evidence, without concatenating six large snapshots.
  return canonicalPortableContentJson(
    {
      fence: capture.local.fence,
      scope: capture.local.scope,
      hasRestoreArchive: capture.hasRestoreArchive,
      legacy: {
        journalDigest: capture.legacy.journalDigest,
        journalRevision: capture.legacy.journalRevision,
        observed: capture.legacy.observed,
      },
      remote: {
        revision: capture.remote.revision,
        updatedAt: capture.remote.updatedAt,
        sourceDigest: capture.remoteConversion.sourceDigest,
      },
      baseProjectionDigest: capture.baseConversion?.convertedDigest ?? null,
      remoteProjectionDigest: capture.remoteConversion.convertedDigest,
    },
    65536,
  );
}

/** Private local metadata workflow only; it never sends HTTP or applies cooking data. */
export function createAccountLegacyTransitionRepository(
  inputOptions: AccountLegacyTransitionRepositoryOptions,
) {
  const options = {
    ...inputOptions,
    catalogue: JSON.parse(
      canonicalPortableContentJson(inputOptions.catalogue, 4096),
    ) as AccountContentCaptureOptions['catalogue'],
  };
  const installationId = options.installationId;
  if (!uuid(installationId)) fail('invalid_input');
  let closed = false;
  const issued = new WeakMap<object, Capability>();
  function access(input: AccountReplicationScope, checkSettings = false) {
    if (
      !exact(input, ['ownerId', 'authGeneration']) ||
      !uuid(input.ownerId) ||
      !revision(input.authGeneration)
    )
      fail('invalid_input');
    const scope = Object.freeze({ ownerId: input.ownerId, authGeneration: input.authGeneration });
    function owner(): undefined {
      const current = options.currentScope();
      if (
        closed ||
        !current ||
        current.ownerId !== scope.ownerId ||
        current.authGeneration !== scope.authGeneration
      )
        fail('account_changed');
      return undefined;
    }
    owner();
    const settingsText = checkSettings
      ? canonicalPortableContentJson(options.getLocalSettings(), 4096)
      : null;
    function check(): undefined {
      owner();
      if (settingsText !== null) {
        let current: string;
        try {
          current = canonicalPortableContentJson(options.getLocalSettings(), 4096);
        } catch {
          return fail('settings_changed');
        }
        if (current !== settingsText) fail('settings_changed');
      }
      return undefined;
    }
    const hash = async (text: string) => {
      check();
      const value = await options.sha256(text);
      check();
      if (!fingerprint(value)) fail('stored_data_invalid');
      return value;
    };
    const guarded = (raw: SqlSession): SqlSession => ({
      all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        check();
        const rows = await raw.all<Row>(sql, values);
        check();
        return rows;
      },
      exec: async (sql) => {
        check();
        await raw.exec(sql);
        check();
      },
      prepare: async (sql) => {
        check();
        const statement = await raw.prepare(sql);
        try {
          check();
        } catch (error) {
          await statement.finalize();
          throw error;
        }
        return {
          run: async (values) => {
            check();
            await statement.run(values);
            check();
          },
          finalize: () => statement.finalize(),
        };
      },
    });
    const readState = (session: SqlSession) =>
      readAccountLegacyContentTransitionState(session, scope.ownerId, installationId, hash);
    return { scope, check, hash, guarded, readState };
  }
  type Context = ReturnType<typeof access>;
  async function idle(session: SqlSession) {
    if (
      (await session.all('SELECT 1 FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY])).length
    )
      fail('settings_pending');
    if (
      (
        await session.all(
          "SELECT 1 FROM pending_intent WHERE phase NOT IN ('settled','cancelled') LIMIT 1",
        )
      ).length ||
      (
        await session.all(
          "SELECT 1 FROM assistant_intent_context WHERE lifecycle='awaiting_response' LIMIT 1",
        )
      ).length ||
      (await session.all('SELECT 1 FROM direct_command_recovery LIMIT 1')).length
    )
      fail('active_actions');
    if (
      (
        await session.all(
          "SELECT 1 FROM command_slot s JOIN pending_intent p ON p.user_intent_id=s.user_intent_id LEFT JOIN operation_receipt r ON r.operation_id=s.operation_id WHERE p.phase='settled' AND r.operation_id IS NULL LIMIT 1",
        )
      ).length
    )
      fail('recovery_required');
  }
  async function currentScope(
    session: SqlSession,
    context: Context,
    value: Immutable<AccountLegacyContentTransition>,
  ) {
    await idle(session);
    const approval = await readAccountContentScopeApproval(
      session,
      context.scope.ownerId,
      installationId,
      context.hash,
    );
    if (!approval) fail('scope_review_required');
    if (
      approval.digest !== value.capturedLocal.scope.approvalDigest ||
      approval.record.historyIncluded !== value.capturedLocal.scope.historyIncluded
    )
      fail('scope_changed');
  }
  async function read(scope: AccountReplicationScope) {
    const context = access(scope);
    try {
      const state = await options.reader.transaction(
        (raw) => context.readState(context.guarded(raw)),
        { kind: 'read_only' },
      );
      context.check();
      return state.transition;
    } catch (error) {
      context.check();
      throw error;
    }
  }
  async function recover(scope: AccountReplicationScope, input: AccountLegacyTransitionIdentity) {
    const context = access(scope),
      wanted = identity(input);
    const value = await read(context.scope);
    context.check();
    if (!value || value.networkOperationId !== wanted.operationId) return null;
    if (value.requestFingerprint !== wanted.requestFingerprint) fail('operation_changed');
    return value;
  }
  async function review(
    scope: AccountReplicationScope,
    inputRemote: unknown,
    inputResolutions?: AccountMergeResolutions,
  ): Promise<Immutable<AccountLegacyTransitionReview>> {
    const context = access(scope, true);
    const resolutions = normalChoices(inputResolutions ?? {});
    // Own remote before asynchronous SQL; a caller cannot exchange the reviewed account state.
    const remote = remoteState(
      JSON.parse(canonicalPortableContentJson(inputRemote, 2 * 1024 * 1024 + 8192)),
      context.scope.ownerId,
    );
    const reviewId = options.newId();
    if (!uuid(reviewId)) fail('invalid_input');
    try {
      const capture = await options.reader.transaction(
        async (raw) => {
          const session = context.guarded(raw);
          await idle(session);
          return captureAccountLegacyTransitionInSnapshot(session, context.scope, remote, {
            ...options,
            sha256: context.hash,
          });
        },
        { kind: 'read_only' },
      );
      context.check();
      const merged = merge(capture, resolutions);
      const removalReview =
        merged.status === 'merged'
          ? createAccountContentRemovalReview(
              merged.snapshot,
              capture.backup,
              capture.hasRestoreArchive,
            )
          : null;
      const result = freezeResult({
        reviewId,
        initialImportRequired: capture.legacy.base === null,
        merge: merged,
        removalReview,
      });
      issued.set(result, {
        scope: context.scope,
        capture,
        contextText: captureContext(capture),
        resolutions,
        removalReview,
        reviewedCandidate:
          merged.status === 'merged' ? canonicalAccountContentSnapshot(merged.snapshot) : null,
        submitted: null,
      });
      context.check();
      return result;
    } catch (error) {
      context.check();
      throw error;
    }
  }
  async function writeSidecar(session: SqlSession, value: unknown, context: Context) {
    const text = await serializeAccountLegacyContentTransition(
      value,
      context.scope.ownerId,
      installationId,
      context.hash,
    );
    await runBound(
      session,
      'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [accountLegacyContentTransitionKey(context.scope.ownerId), text],
    );
  }
  async function perform(
    context: Context,
    wanted: AccountLegacyTransitionIdentity,
    work: (
      session: SqlSession,
      writing: () => void,
    ) => Promise<Immutable<AccountLegacyContentTransition>>,
    acceptRecovered: (value: Immutable<AccountLegacyContentTransition>) => boolean,
  ) {
    let attempted = false;
    try {
      const value = await options.writer.transaction(
        (raw) =>
          work(context.guarded(raw), () => {
            attempted = true;
          }),
        { kind: 'none' },
        context.check,
      );
      context.check();
      return value;
    } catch (error) {
      context.check();
      if (attempted) {
        const saved = await recover(context.scope, wanted);
        context.check();
        if (saved && acceptRecovered(saved)) return saved;
      }
      throw error;
    }
  }
  async function stage(
    scope: AccountReplicationScope,
    reviewToken: Immutable<AccountLegacyTransitionReview>,
    input: AccountLegacyTransitionChoices,
  ) {
    const context = access(scope, true);
    const capability =
      reviewToken && typeof reviewToken === 'object' ? issued.get(reviewToken) : undefined;
    if (!capability || !same(capability.scope, context.scope)) fail('local_changed');
    const choice = choices(input, capability.resolutions),
      choicesText = canonicalPortableContentJson(choice, stageChoicesMaximumBytes);
    if (capability.capture.legacy.base === null && !choice.initialImportReviewed)
      fail('initial_review_required');
    if (capability.submitted && capability.submitted.choicesText !== choicesText)
      fail('operation_changed');
    let result: AccountContentMergeResult;
    try {
      result = merge(capability.capture, choice.resolutions);
    } catch (error) {
      if (error instanceof AccountSnapshotError) fail('invalid_input');
      throw error;
    }
    if (result.status !== 'merged') fail('invalid_input');
    const candidateText = canonicalAccountContentSnapshot(result.snapshot);
    let removalReview = capability.removalReview;
    if (removalReview) {
      // Different ordinary merge choices require another visible review of the exact candidate.
      if (candidateText !== capability.reviewedCandidate) fail('recovery_required');
    } else {
      removalReview = createAccountContentRemovalReview(
        result.snapshot,
        capability.capture.backup,
        capability.capture.hasRestoreArchive,
      );
      // Previously hidden removal conflicts cannot be accepted by guessing their stable IDs.
      if (removalReview.conflicts.length) fail('recovery_required');
    }
    const removalResolution = resolveAccountContentRemovalReview(
      removalReview,
      choice.removalChoices,
    );
    const proposed = removalResolution.snapshot;
    const adjustedCandidateText = canonicalAccountContentSnapshot(proposed);
    if (capability.submitted && capability.submitted.candidateText !== adjustedCandidateText)
      fail('operation_changed');
    if (!capability.submitted) {
      const networkOperationId = options.newId(),
        localApplyOperationId = options.newId();
      if (
        !uuid(networkOperationId) ||
        !uuid(localApplyOperationId) ||
        networkOperationId === localApplyOperationId
      )
        fail('invalid_input');
      capability.submitted = {
        choicesText,
        candidateText: adjustedCandidateText,
        networkOperationId,
        localApplyOperationId,
      };
    }
    // Exact choice and distinct identities are owned synchronously, before any awaited port.
    const submitted = capability.submitted,
      capture = capability.capture;
    const draft: AccountLegacyContentTransitionDraft = {
      ownerId: context.scope.ownerId,
      installationId,
      legacy: {
        ...JSON.parse(canonicalPortableContentJson(capture.legacy, 2 * 1024 * 1024 + 8192)),
        baseProjectionDigest: capture.baseConversion?.convertedDigest ?? null,
      },
      remote: remoteState(
        JSON.parse(canonicalPortableContentJson(capture.remote, 2 * 1024 * 1024 + 8192)),
        context.scope.ownerId,
      ),
      remoteDigest: capture.remoteConversion.sourceDigest,
      remoteProjectionDigest: capture.remoteConversion.convertedDigest,
      capturedLocal: {
        storeRevision: capture.local.storeRevision,
        snapshot: ownContent(capture.local.snapshot),
        scope: { ...capture.local.scope },
        fenceDigest: await context.hash(canonicalPortableContentJson(capture.local.fence, 32768)),
      },
      networkOperationId: submitted.networkOperationId,
      localApplyOperationId: submitted.localApplyOperationId,
      proposed: ownContent(proposed),
      proposedDigest: await context.hash(adjustedCandidateText),
      // The adjusted proposal binds removal choices. Private local tombstones and their
      // review records never become upload, sidecar or portable account data.
      review: {
        initialImportReviewed: choice.initialImportReviewed,
        resolutions: choice.resolutions,
      },
    };
    const requestFingerprint = await accountLegacyContentTransitionFingerprint(draft, context.hash);
    const wanted = { operationId: draft.networkOperationId, requestFingerprint };
    return perform(
      context,
      wanted,
      async (session, writing) => {
        const current = (await context.readState(session)).transition;
        if (current) {
          if (current.networkOperationId !== wanted.operationId) fail('operation_pending');
          if (current.requestFingerprint !== wanted.requestFingerprint) fail('operation_changed');
          await currentScope(session, context, current);
          return current;
        }
        await idle(session);
        const live = await captureAccountLegacyTransitionInSnapshot(
          session,
          context.scope,
          capture.remote,
          { ...options, sha256: context.hash },
        );
        if (
          captureContext(live) !== capability.contextText ||
          canonicalAccountContentSnapshot(live.local.snapshot) !==
            canonicalAccountContentSnapshot(capture.local.snapshot)
        )
          fail('local_changed');
        assertAccountContentRemovalResolution(
          removalResolution,
          proposed,
          live.backup,
          live.hasRestoreArchive,
        );
        const value: AccountLegacyContentTransition = {
          ...draft,
          schemaVersion: 1,
          kind: 'legacy_to_content3',
          revision: 1,
          requestFingerprint,
          acknowledgement: null,
          handoff: null,
          lastApply: null,
        };
        writing();
        await writeSidecar(session, value, context);
        const stored = (await context.readState(session)).transition;
        if (!stored) fail('stored_data_invalid');
        return stored;
      },
      (saved) => saved.requestFingerprint === wanted.requestFingerprint,
    );
  }
  async function recordAcknowledgement(
    scope: AccountReplicationScope,
    input: AccountLegacyTransitionIdentity & { receipt: AccountCommitReceipt },
  ) {
    const context = access(scope, true);
    const owned: unknown = JSON.parse(canonicalPortableContentJson(input, 4096));
    if (!exact(owned, ['operationId', 'requestFingerprint', 'receipt'])) fail('invalid_input');
    const wanted = identity({
      operationId: owned.operationId,
      requestFingerprint: owned.requestFingerprint,
    });
    let receipt: AccountCommitReceipt | null = null;
    return perform(
      context,
      wanted,
      async (session, writing) => {
        const current = (await context.readState(session)).transition;
        if (
          !current ||
          current.networkOperationId !== wanted.operationId ||
          current.requestFingerprint !== wanted.requestFingerprint
        )
          fail('operation_changed');
        await currentScope(session, context, current);
        receipt = commitReceipt(
          owned.receipt,
          context.scope.ownerId,
          wanted.operationId,
          current.remote.revision,
        );
        if (current.acknowledgement) {
          if (!same(current.acknowledgement, receipt)) fail('operation_changed');
          return current;
        }
        writing();
        await writeSidecar(
          session,
          { ...current, revision: next(current.revision), acknowledgement: receipt },
          context,
        );
        const stored = (await context.readState(session)).transition;
        if (!stored) fail('stored_data_invalid');
        return stored;
      },
      (saved) => receipt !== null && same(saved.acknowledgement, receipt),
    );
  }
  async function handoff(scope: AccountReplicationScope, input: AccountLegacyTransitionIdentity) {
    const context = access(scope, true),
      wanted = identity(input);
    return perform(
      context,
      wanted,
      async (session, writing) => {
        const current = (await context.readState(session)).transition;
        if (
          !current ||
          current.networkOperationId !== wanted.operationId ||
          current.requestFingerprint !== wanted.requestFingerprint
        )
          fail('operation_changed');
        await currentScope(session, context, current);
        if (current.handoff) return current;
        const ack = current.acknowledgement;
        if (!ack) fail('acknowledgement_required');
        const remote = {
          ownerId: context.scope.ownerId,
          revision: ack.revision,
          snapshot: ownContent(current.proposed),
          updatedAt: ack.committedAt,
          deletionOperationId: null,
        };
        const draft: AccountContentPendingDraft = {
          operationId: current.localApplyOperationId,
          mode: 'pull',
          capturedLocal: {
            ...current.capturedLocal,
            snapshot: ownContent(current.capturedLocal.snapshot),
          },
          remote,
          proposed: ownContent(current.proposed),
        };
        const requestFingerprint = await accountContentPendingFingerprint(
          context.scope.ownerId,
          installationId,
          current.legacy.journalDigest,
          draft,
          context.hash,
        );
        const journal = {
          schemaVersion: 3,
          ownerId: context.scope.ownerId,
          installationId,
          revision: 1,
          legacyJournalDigest: current.legacy.journalDigest,
          scope: current.capturedLocal.scope,
          base: null,
          lastApply: null,
          observed: {
            revision: ack.revision,
            snapshotDigest: current.proposedDigest,
            updatedAt: ack.committedAt,
          },
          pending: {
            ...draft,
            requestFingerprint,
            proposedDigest: current.proposedDigest,
            acknowledgement: null,
          },
        };
        const serialized = await serializeAccountContentJournal(
          journal,
          context.scope.ownerId,
          installationId,
          context.hash,
        );
        writing();
        await runBound(session, 'INSERT INTO app_metadata(key,value) VALUES (?,?)', [
          accountContentJournalKey(context.scope.ownerId),
          serialized,
        ]);
        await writeSidecar(
          session,
          { ...current, revision: next(current.revision), handoff: { requestFingerprint } },
          context,
        );
        const stored = (await context.readState(session)).transition;
        if (!stored) fail('stored_data_invalid');
        return stored;
      },
      (saved) => saved.handoff !== null,
    );
  }
  return Object.freeze({
    read,
    review,
    stage,
    recordAcknowledgement,
    handoff,
    recover,
    close: () => {
      closed = true;
    },
  });
}
