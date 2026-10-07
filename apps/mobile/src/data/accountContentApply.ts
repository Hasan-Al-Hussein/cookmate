import type {
  AccountMergeResolutions,
  AccountPendingSettings,
  AccountReplicationScope,
} from '@cookmate/account-sync';
import {
  OVERLAY_LIMITS,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { isUtcInstant } from '@cookmate/contracts';
import type { Immutable, StoreChange } from '@cookmate/domain';
import {
  mergeAccountContentSnapshots,
  type AccountContentMergeResult,
} from '../../../../packages/account-sync/src/contentMerge';
import { serializeAccountLegacyContentTransition } from '../../../../packages/account-sync/src/contentLegacyTransition';
import {
  serializeAccountContentJournal,
  type AccountContentJournalApplyReceipt,
  type AccountContentRemoteState,
  type AccountContentReplicationJournal,
} from '../../../../packages/account-sync/src/contentReplicationRecords';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import {
  captureAccountContentPendingBundle,
  captureAccountContentPendingLocal,
  type AccountContentCaptureOptions,
  type AccountContentLocalCapture,
} from './accountContentCapture';
import {
  applyAccountContentCore,
  nextAccountContentApplyRevision,
} from './accountContentCoreApply';
import { mergeAccountContentHistoryProjection } from './accountContentHistoryApply';
import {
  accountContentJournalKey,
  readAccountContentJournalState,
} from './accountContentJournalStorage';
import { applyReviewedAccountContentPersonal } from './accountContentPersonalApply';
import {
  createAccountContentRemovalReview,
  resolveAccountContentRemovalReview,
  type AccountContentRemovalChoices,
  type AccountContentRemovalReview,
} from './accountContentRemovalReview';
import { accountLegacyContentTransitionKey } from './accountLegacyTransitionKeys';
import { readAccountLegacyContentTransitionState } from './accountLegacyTransitionStorage';
import type { AccountContentPendingCaptureIdentity } from './accountContentScopeApproval';
import {
  ACCOUNT_SETTINGS_KEY,
  exact,
  fail,
  readBinding,
  readJournal,
  readPendingSettings,
  revision,
  snapshotOptions,
  uuid,
  writeMetadata,
} from './accountReplicationRecords';
import type { openContentReleaseStore } from './contentReleaseStore';
import { freezeResult } from './query';
import {
  runBound,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

interface Options extends AccountContentCaptureOptions {
  reader: Pick<SerializedReader, 'transaction'>;
  writer: Pick<SerializedWriter, 'transaction' | 'requiresRecovery'>;
  contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReferenceInspection'
  >;
  /** Host gate covers direct actions, restore, adoption and other account applies. */
  acquireExclusive(): (() => void) | null;
  onCommitted(
    change: StoreChange,
    expanded: { personalRevision?: number; historyRevision?: number },
  ): void;
}
export interface AccountContentApplyReview {
  operationId: string;
  requestFingerprint: string;
  storeRevision: number;
  serverRevision: number;
  blockers: 'removed_core_choices'[];
  /** Exact local capture and accepted account side used by this issued merge review. */
  comparison: { local: AccountContentSnapshot; account: AccountContentSnapshot | null };
  /** Merge result, not remote-write authority or a claim of service verification. */
  merge: AccountContentMergeResult;
  removalReview: AccountContentRemovalReview | null;
}
interface Capability {
  scope: Readonly<AccountReplicationScope>;
  identity: Readonly<AccountContentPendingCaptureIdentity>;
  local: Immutable<AccountContentLocalCapture>;
  journal: Immutable<AccountContentReplicationJournal>;
  transitionDigest: string | null;
  accepted: Immutable<AccountContentRemoteState>;
  head: OverlayHead | null;
  latestHead: OverlayHead | null;
  refs: RecipeContentRef[];
  submitted?: string;
  blockers: 'removed_core_choices'[];
  mergeChoices?: AccountMergeResolutions;
  removalReview: Immutable<AccountContentRemovalReview> | null;
  reviewedCandidate: string | null;
}
const same = (left: unknown, right: unknown) =>
  canonicalPortableContentJson(left) === canonicalPortableContentJson(right);
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function ownIdentity(value: unknown): Readonly<AccountContentPendingCaptureIdentity> {
  if (
    !exact(value, ['operationId', 'requestFingerprint']) ||
    !uuid(value.operationId) ||
    !fingerprint(value.requestFingerprint)
  )
    fail('invalid_input');
  return Object.freeze({
    operationId: value.operationId,
    requestFingerprint: value.requestFingerprint,
  });
}
function acceptedState(
  journal: Immutable<AccountContentReplicationJournal>,
): Immutable<AccountContentRemoteState> {
  const pending = journal.pending;
  if (!pending) fail('operation_changed');
  if (pending.mode === 'push') {
    if (!pending.acknowledgement) fail('acknowledgement_required');
    return freezeResult({
      ownerId: journal.ownerId,
      revision: pending.acknowledgement.revision,
      snapshot: pending.proposed,
      updatedAt: pending.acknowledgement.committedAt,
      deletionOperationId: null,
    });
  }
  if (!pending.remote.snapshot) fail('stored_data_invalid');
  return pending.remote;
}
function merge(capability: Capability, resolutions?: AccountMergeResolutions) {
  return mergeAccountContentSnapshots({
    base: capability.journal.pending!.capturedLocal.snapshot,
    local: capability.local.snapshot,
    account: capability.accepted.snapshot!,
    contentScope: { schemaVersion: 3, historyIncluded: capability.local.scope.historyIncluded },
    reviewPersonalRemovals: true,
    ...(resolutions === undefined ? {} : { resolutions }),
  });
}
function references(
  snapshots: readonly Immutable<AccountContentSnapshot>[],
  historyIncluded: boolean,
) {
  const refs = new Map<string, RecipeContentRef>();
  for (const snapshot of snapshots) {
    const values = [
      ...snapshot.planReferences.map((row) => row.contentRef),
      ...(historyIncluded
        ? (snapshot.cookingHistory?.entries.flatMap((row) =>
            row.kind === 'exact'
              ? [row.entry.contentRef]
              : row.pin.kind === 'exact'
                ? [row.pin.ref]
                : [],
          ) ?? [])
        : []),
    ];
    for (const ref of values) {
      refs.set(canonicalPortableContentJson(ref, 512), { ...ref });
      if (refs.size > OVERLAY_LIMITS.retainedRefs) fail('too_large');
    }
  }
  return [...refs.values()];
}

/**
 * Private schema8 host. Only an issued, current review permits a local account apply.
 * A retained remote acknowledgement is data; it is never a cooking receipt or conflict choice.
 * Content reservation precedes the cooking SQL transaction. No network or runtime activation.
 */
export function createAccountContentApplyService(options: Options) {
  const installationId = options.installationId;
  if (!uuid(installationId)) fail('invalid_input');
  let closed = false;
  const reviews = new WeakMap<object, Capability>();
  function access(value: AccountReplicationScope) {
    if (
      !exact(value, ['ownerId', 'authGeneration']) ||
      !uuid(value.ownerId) ||
      !revision(value.authGeneration)
    )
      fail('invalid_input');
    const scope = Object.freeze({ ownerId: value.ownerId, authGeneration: value.authGeneration });
    function check(): undefined {
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
    check();
    const hash = async (text: string) => {
      check();
      const digest = await options.sha256(text);
      check();
      if (!fingerprint(digest)) fail('stored_data_invalid');
      return digest;
    };
    return { scope, check, hash };
  }
  function guarded(raw: SqlSession, check: () => undefined): SqlSession {
    return {
      async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
        check();
        const rows = await raw.all<Row>(sql, values);
        check();
        return rows;
      },
      async exec(sql) {
        check();
        await raw.exec(sql);
        check();
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
  }
  async function owned(session: SqlSession, ownerId: string) {
    if ((await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8)
      fail('stored_data_invalid');
    if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
    const [row] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (row?.id !== installationId) fail('different_data_owner');
  }
  async function idle(session: SqlSession) {
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
  function captureOptions(context: ReturnType<typeof access>): AccountContentCaptureOptions {
    return {
      ...options,
      currentScope: () => {
        context.check();
        return options.currentScope();
      },
      sha256: context.hash,
    };
  }
  async function state(session: SqlSession, context: ReturnType<typeof access>) {
    await owned(session, context.scope.ownerId);
    const transitionState = await readAccountLegacyContentTransitionState(
      session,
      context.scope.ownerId,
      installationId,
      context.hash,
    );
    const { journal } = await readAccountContentJournalState(
      session,
      context.scope.ownerId,
      context.hash,
    );
    if (transitionState.transition === null) {
      const legacy = await readJournal(session, context.scope.ownerId, context.hash);
      if (legacy?.base || (legacy?.observed?.revision ?? 0) > 0) fail('recovery_required');
    }
    return { journal, transitionState };
  }
  async function pending(
    session: SqlSession,
    context: ReturnType<typeof access>,
    identity: Readonly<AccountContentPendingCaptureIdentity>,
  ) {
    const current = await state(session, context),
      { journal } = current;
    if (
      !journal?.pending ||
      journal.pending.operationId !== identity.operationId ||
      journal.pending.requestFingerprint !== identity.requestFingerprint
    )
      fail('operation_changed');
    return { journal, transitionState: current.transitionState };
  }
  async function review(
    scope: AccountReplicationScope,
    input: AccountContentPendingCaptureIdentity,
    resolutions?: AccountMergeResolutions,
  ): Promise<Immutable<AccountContentApplyReview>> {
    const context = access(scope),
      identity = ownIdentity(input);
    const mergeChoices: AccountMergeResolutions | undefined =
      resolutions === undefined ? undefined : JSON.parse(canonicalPortableContentJson(resolutions));
    const initial = await options.reader.transaction(
      async (raw) => {
        const session = guarded(raw, context.check);
        const { journal, transitionState } = await pending(session, context, identity),
          accepted = acceptedState(journal);
        await idle(session);
        const local = await captureAccountContentPendingLocal(
          session,
          context.scope,
          identity,
          captureOptions(context),
        );
        return { journal, accepted, local, transitionDigest: transitionState.digest };
      },
      { kind: 'read_only' },
    );
    context.check();
    const head: OverlayHead | null = JSON.parse(initial.local.fence.adoption).head;
    const refs = references(
      [
        initial.local.snapshot,
        initial.journal.pending!.capturedLocal.snapshot,
        initial.accepted.snapshot!,
      ],
      initial.local.scope.historyIncluded,
    );
    const capability = await options.contentStore.withVerifiedReferenceInspection(
      head,
      refs,
      async (view) => {
        const check = () => {
          context.check();
          view.assertActive();
          return undefined;
        };
        check();
        const capability: Capability = {
          ...initial,
          scope: context.scope,
          identity,
          head,
          latestHead: view.latestHead,
          refs,
          blockers: [],
          ...(mergeChoices === undefined ? {} : { mergeChoices }),
          removalReview: null,
          reviewedCandidate: null,
        };
        await options.reader.transaction(
          async (raw) => {
            const session = guarded(raw, check);
            const currentState = await pending(session, context, identity);
            if (currentState.transitionState.digest !== initial.transitionDigest)
              fail('journal_changed');
            await idle(session);
            const current = await captureAccountContentPendingBundle(
              session,
              context.scope,
              identity,
              captureOptions(context),
            );
            if (!same(current.capture, initial.local) || !same(view.head, head))
              fail('local_changed');
            const candidate = merge(capability, mergeChoices);
            if (candidate.status === 'merged') {
              const archivePresent =
                (await session.all('SELECT 1 FROM portable_restore_operation LIMIT 1')).length > 0;
              capability.removalReview = createAccountContentRemovalReview(
                candidate.snapshot,
                current.backup,
                archivePresent,
              );
              capability.reviewedCandidate = canonicalAccountContentSnapshot(candidate.snapshot);
              if (capability.removalReview.conflicts.length)
                capability.blockers.push('removed_core_choices');
            }
          },
          { kind: 'read_only' },
        );
        check();
        return capability;
      },
    );
    context.check();
    const result = freezeResult({
      operationId: identity.operationId,
      requestFingerprint: identity.requestFingerprint,
      storeRevision: capability.local.storeRevision,
      serverRevision: capability.accepted.revision,
      blockers: capability.blockers,
      comparison: {
        local: capability.local.snapshot,
        account: capability.accepted.snapshot,
      },
      merge: merge(capability, mergeChoices),
      removalReview: capability.removalReview,
    });
    reviews.set(result, capability);
    return result;
  }
  async function recover(
    scope: AccountReplicationScope,
    input: AccountContentPendingCaptureIdentity,
  ) {
    const context = access(scope),
      identity = ownIdentity(input);
    const receipt = await options.reader.transaction(
      async (raw) => {
        const { journal } = await state(guarded(raw, context.check), context);
        if (journal?.lastApply?.operationId !== identity.operationId) return null;
        if (journal.lastApply.requestFingerprint !== identity.requestFingerprint)
          fail('operation_changed');
        return journal.lastApply;
      },
      { kind: 'read_only' },
    );
    context.check();
    return receipt;
  }
  async function apply(
    scope: AccountReplicationScope,
    reviewValue: Immutable<AccountContentApplyReview>,
    resolutions?: AccountMergeResolutions,
    removalChoices?: AccountContentRemovalChoices,
  ): Promise<Immutable<AccountContentJournalApplyReceipt>> {
    const context = access(scope),
      capability = reviews.get(reviewValue);
    if (!capability || !same(capability.scope, context.scope)) fail('invalid_input');
    if (capability.blockers.length && removalChoices === undefined) fail('recovery_required');
    const choices: AccountMergeResolutions | undefined =
      resolutions === undefined
        ? capability.mergeChoices
        : JSON.parse(canonicalPortableContentJson(resolutions));
    // The pure merge owns/validates choices synchronously and binds them to these exact branches.
    const result = merge(capability, choices);
    if (result.status !== 'merged') fail('invalid_input');
    if (
      capability.reviewedCandidate !== null &&
      capability.reviewedCandidate !== canonicalAccountContentSnapshot(result.snapshot)
    )
      fail('operation_changed');
    if (!capability.removalReview && removalChoices !== undefined) fail('recovery_required');
    const removalResolution = capability.removalReview
      ? resolveAccountContentRemovalReview(capability.removalReview, removalChoices ?? {})
      : undefined;
    const candidate = removalResolution?.snapshot ?? result.snapshot;
    const submitted = canonicalPortableContentJson({
      candidate,
      choices: choices ?? {},
      removalChoices: removalResolution?.choices ?? {},
    });
    if (capability.submitted !== undefined && capability.submitted !== submitted)
      fail('operation_changed');
    capability.submitted = submitted;
    const beforeSettings = capability.local.fence.localSettings;
    function checkSettings(): undefined {
      context.check();
      if (canonicalPortableContentJson(options.getLocalSettings(), 4096) !== beforeSettings)
        fail('settings_changed');
      return undefined;
    }
    const release = options.acquireExclusive();
    if (!release) fail('store_busy');
    let change: StoreChange | undefined;
    let expanded: { personalRevision?: number; historyRevision?: number } = {};
    let attempted = false;
    let receipt: Immutable<AccountContentJournalApplyReceipt>;
    try {
      // A completed operation is inspected through recover(), not attributed to this submission's
      // possibly different merge choices. This also fences competing reviews/service instances.
      const saved = await recover(context.scope, capability.identity);
      context.check();
      if (saved) fail('operation_changed');
      checkSettings();
      try {
        receipt = await options.contentStore.withVerifiedReferenceInspection(
          capability.head,
          capability.refs,
          async (view) => {
            const check = () => {
              checkSettings();
              view.assertActive();
              return undefined;
            };
            check();
            if (!same(view.head, capability.head) || !same(view.latestHead, capability.latestHead))
              fail('local_changed');
            const value = await options.writer.transaction(
              async (raw) => {
                const session = guarded(raw, check);
                const { journal, transitionState } = await pending(
                  session,
                  context,
                  capability.identity,
                );
                if (transitionState.digest !== capability.transitionDigest) fail('journal_changed');
                if (journal.revision !== capability.journal.revision) fail('journal_changed');
                await idle(session);
                const current = await captureAccountContentPendingBundle(
                  session,
                  context.scope,
                  capability.identity,
                  captureOptions(context),
                );
                // The capture fence includes the raw journal digest, avoiding a second copy of its
                // four independently bounded snapshots and binding even same-revision tampering.
                if (!same(current.capture, capability.local)) fail('local_changed');
                const at = options.now();
                if (!isUtcInstant(at)) fail('invalid_input');
                const nextRevision = await nextAccountContentApplyRevision(session);
                attempted = true;
                change = await applyAccountContentCore(
                  session,
                  context.scope.ownerId,
                  candidate,
                  current.backup,
                  current.capture.snapshot,
                  {
                    view,
                    sha256: context.hash,
                    now: at,
                    revision: nextRevision,
                    assertAccess: check,
                    ...(removalResolution ? { removalResolution } : {}),
                  },
                );
                const personal = await applyReviewedAccountContentPersonal(
                  session,
                  candidate.personal,
                  { ownerId: context.scope.ownerId, view, assertAccess: check },
                );
                expanded = personal.changed ? { personalRevision: personal.revision } : {};
                if (capability.local.scope.historyIncluded) {
                  if (!candidate.cookingHistory) fail('scope_changed');
                  const history = await mergeAccountContentHistoryProjection(
                    session,
                    context.scope.ownerId,
                    candidate.cookingHistory,
                    { view, sha256: context.hash, revision: nextRevision },
                  );
                  if (history.changed) expanded.historyRevision = history.historyRevision;
                }
                const applied = {
                  ownerId: context.scope.ownerId,
                  ...capability.identity,
                  storeRevision: nextRevision,
                  serverRevision: capability.accepted.revision,
                  appliedAt: at,
                };
                const projection = snapshotOptions(
                  { appPreferences: candidate.appPreferences, profile: candidate.profile },
                  options.catalogue,
                );
                if (canonicalPortableContentJson(projection, 4096) !== beforeSettings)
                  await writeMetadata(
                    session,
                    ACCOUNT_SETTINGS_KEY,
                    {
                      ownerId: context.scope.ownerId,
                      operationId: capability.identity.operationId,
                      previous: JSON.parse(beforeSettings),
                      projection,
                    } satisfies AccountPendingSettings,
                    4096,
                  );
                if (!Number.isSafeInteger(journal.revision + 1)) fail('stored_data_invalid');
                const serialized = await serializeAccountContentJournal(
                  {
                    ...journal,
                    revision: journal.revision + 1,
                    base: capability.accepted,
                    observed: {
                      revision: capability.accepted.revision,
                      updatedAt: capability.accepted.updatedAt,
                      snapshotDigest: await context.hash(
                        canonicalAccountContentSnapshot(capability.accepted.snapshot!),
                      ),
                    },
                    pending: null,
                    lastApply: applied,
                  },
                  context.scope.ownerId,
                  installationId,
                  context.hash,
                );
                await runBound(
                  session,
                  'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                  [accountContentJournalKey(context.scope.ownerId), serialized],
                );
                // The first local installation and its transition receipt are one commit.
                // Never leave a completed content journal beside a pending legacy handoff.
                const transition = transitionState.transition;
                if (transition && !transition.lastApply) {
                  if (!Number.isSafeInteger(transition.revision + 1)) fail('stored_data_invalid');
                  const completed = await serializeAccountLegacyContentTransition(
                    { ...transition, revision: transition.revision + 1, lastApply: applied },
                    context.scope.ownerId,
                    installationId,
                    context.hash,
                  );
                  await runBound(
                    session,
                    'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                    [accountLegacyContentTransitionKey(context.scope.ownerId), completed],
                  );
                }
                check();
                return freezeResult(applied);
              },
              { kind: 'all' },
              check,
            );
            check();
            return value;
          },
        );
        checkSettings();
      } catch (error) {
        context.check();
        const proof = attempted ? await recover(context.scope, capability.identity) : null;
        context.check();
        if (!proof) throw error;
        receipt = proof;
      }
    } finally {
      release();
    }
    context.check();
    if (change) options.onCommitted(change, expanded);
    context.check();
    return receipt;
  }
  async function settingsInSnapshot(session: SqlSession, context: ReturnType<typeof access>) {
    const { journal } = await state(session, context);
    const present =
      (await session.all('SELECT 1 FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY])).length >
      0;
    const value = await readPendingSettings(session, options.catalogue);
    if (present && !value) fail('stored_data_invalid');
    if (
      value &&
      (value.ownerId !== context.scope.ownerId ||
        journal?.lastApply?.operationId !== value.operationId)
    )
      fail('stored_data_invalid');
    return { value, journal };
  }
  async function inspectSettings(scope: AccountReplicationScope) {
    const context = access(scope);
    const value = await options.reader.transaction(
      async (raw) => (await settingsInSnapshot(guarded(raw, context.check), context)).value,
      { kind: 'read_only' },
    );
    context.check();
    return freezeResult(value);
  }
  async function acknowledgeSettings(
    scope: AccountReplicationScope,
    input: AccountPendingSettings,
  ) {
    const context = access(scope);
    const value: unknown = JSON.parse(canonicalPortableContentJson(input, 4096));
    if (
      !exact(value, ['ownerId', 'operationId', 'previous', 'projection']) ||
      value.ownerId !== context.scope.ownerId ||
      !uuid(value.operationId)
    )
      fail('invalid_input');
    const expected = {
      ownerId: value.ownerId,
      operationId: value.operationId,
      previous: snapshotOptions(value.previous, options.catalogue),
      projection: snapshotOptions(value.projection, options.catalogue),
    };
    const check = () => {
      context.check();
      if (!same(options.getLocalSettings(), expected.projection)) fail('settings_changed');
      return undefined;
    };
    check();
    await options.writer.transaction(
      async (raw) => {
        const session = guarded(raw, check),
          current = await settingsInSnapshot(session, context);
        if (current.journal?.lastApply?.operationId !== expected.operationId)
          fail('operation_changed');
        if (current.value) {
          if (!same(current.value, expected)) fail('operation_changed');
          await runBound(session, 'DELETE FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY]);
        }
      },
      { kind: 'none' },
      check,
    );
    check();
  }
  return Object.freeze({
    review,
    apply,
    recover,
    inspectSettings,
    acknowledgeSettings,
    close: () => {
      closed = true;
    },
  });
}
