import { catalogueMatches, isUtcInstant } from '@cookmate/contracts';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { createPortableBackup } from '@cookmate/domain';
import type { ShoppingProjectionOptions, StoreChange } from '@cookmate/domain';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  accountCaptureScope,
  accountCaptureScopesEqual,
  canonicalAccountHistory,
  accountSnapshotFromBackup,
  accountSnapshotsEqual,
  canonicalAccountSnapshot,
  normalizeAccountSnapshot,
} from '@cookmate/account-sync';
import type {
  AccountApplyReceipt,
  AccountLocalCapture,
  AccountPendingSettings,
  AccountReplicationJournal,
  AccountReplicationRepository,
  AccountReplicationScope,
  AccountSnapshotOptions,
  AccountRemoteState,
  AccountCaptureScope,
} from '@cookmate/account-sync';
import { readBackupData } from './portableBackup';
import { freezeResult, readRevision } from './query';
import { nextStoredRevision, readShoppingLedgerInSnapshot } from './shoppingRepository';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';
import { runBound } from './sql';
import { applyAccountCookingData } from './accountReplicationApply';
import { captureAccountExpandedLocal } from './accountExpandedCapture';
import { readAccountScopeApproval } from './accountScopeApproval';
import {
  mergeAccountHistoryProjection,
  verifyAccountHistoryContent,
} from './accountHistoryProjection';
import { applyReviewedAccountPersonal } from './accountPersonalApply';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_GUEST_KEY,
  ACCOUNT_SETTINGS_KEY,
  assertSnapshotCatalogue,
  capture,
  commitReceipt,
  exact,
  fail,
  journalKey,
  readBinding,
  readJournal,
  readMetadata,
  readPendingSettings,
  remoteState,
  revision,
  sameRemote,
  snapshotOptions,
  uuid,
  writeMetadata,
} from './accountReplicationRecords';

export interface AccountReplicationOptions extends ShoppingProjectionOptions {
  reader: SerializedReader;
  writer: SerializedWriter;
  catalogue: Readonly<CatalogueIdentity>;
  knownRecipeIds: ReadonlySet<string>;
  now(): string;
  currentScope(): AccountReplicationScope | null;
  /** Synchronous KV/controller snapshot; never credentials or connection state. */
  getLocalSettings(): AccountSnapshotOptions;
  acquireExclusive(): (() => void) | null;
  /** Explicit rollout only; requires schema6 and durable per-owner scope approval. */
  enableExpandedScope?: boolean;
  onCommitted(
    change: StoreChange,
    expanded?: { personalRevision?: number; historyRevision?: number },
  ): void;
}
const sameOptions = (left: AccountSnapshotOptions, right: AccountSnapshotOptions) =>
  left.appPreferences.theme === right.appPreferences.theme &&
  left.appPreferences.motion === right.appPreferences.motion &&
  left.appPreferences.locale === right.appPreferences.locale &&
  left.profile.displayName === right.profile.displayName;
const sameCapture = (left: AccountLocalCapture, right: AccountLocalCapture) =>
  left.storeRevision === right.storeRevision &&
  accountCaptureScopesEqual(accountCaptureScope(left), accountCaptureScope(right)) &&
  accountSnapshotsEqual(left.snapshot, right.snapshot);

/** Uses only the facade's existing serialized writer/reader. No HTTP or auth persistence belongs here. */
export function createAccountReplicationRepository(
  options: AccountReplicationOptions,
): AccountReplicationRepository {
  function scopeAdmission(scope: AccountReplicationScope): () => undefined {
    if (
      !exact(scope, ['ownerId', 'authGeneration']) ||
      !uuid(scope.ownerId) ||
      !revision(scope.authGeneration)
    )
      fail('invalid_input');
    const ownerId = scope.ownerId;
    const authGeneration = scope.authGeneration;
    const assert = (): undefined => {
      const current = options.currentScope();
      if (!current || current.ownerId !== ownerId || current.authGeneration !== authGeneration)
        fail('account_changed');
      return undefined;
    };
    assert();
    return assert;
  }
  function settings() {
    return snapshotOptions(options.getLocalSettings(), options.catalogue);
  }
  function finalGuard(admit: () => undefined, before: AccountSnapshotOptions) {
    return (): undefined => {
      admit();
      if (!sameOptions(settings(), before)) fail('settings_changed');
      return undefined;
    };
  }
  async function activated(session: SqlSession) {
    const schemaVersion = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    if (schemaVersion !== 3 && schemaVersion !== 4 && schemaVersion !== 5 && schemaVersion !== 6)
      fail('stored_data_invalid');
    const catalogue = (
      await session.all<CatalogueIdentity>(
        'SELECT catalogue_version AS version,fingerprint FROM catalogue_manifest WHERE singleton=1',
      )
    )[0];
    if (!catalogue || !catalogueMatches(catalogue, options.catalogue)) fail('catalogue_mismatch');
    return schemaVersion;
  }
  async function local(
    session: SqlSession,
    currentSettings: AccountSnapshotOptions,
    ownerId: string,
    currentJournal: AccountReplicationJournal | null,
  ): Promise<AccountLocalCapture> {
    const databaseSchemaVersion = await activated(session);
    await readShoppingLedgerInSnapshot(session, options);
    // Settle a retained legacy operation with its exact original core-only capture first.
    if (
      options.enableExpandedScope &&
      currentJournal?.pending?.capturedLocal.snapshot.schemaVersion !== 1
    ) {
      const approval = await readAccountScopeApproval(session, ownerId, options.sha256);
      if (approval) return captureAccountExpandedLocal(session, ownerId, currentSettings, options);
    }
    const createdAt = options.now();
    if (!isUtcInstant(createdAt)) fail('invalid_input');
    const source = await createPortableBackup(
      {
        schemaVersion: 1,
        databaseSchemaVersion,
        createdAt,
        catalogue: { ...options.catalogue },
        sourceRevision: await readRevision(session, 'store'),
        data: await readBackupData(session),
      },
      options.sha256,
    );
    const snapshot = accountSnapshotFromBackup(source, currentSettings);
    assertSnapshotCatalogue(snapshot, options.catalogue, options.knownRecipeIds);
    return { storeRevision: source.sourceRevision, snapshot };
  }
  async function verifyExpandedScope(
    session: SqlSession,
    ownerId: string,
    expected: AccountCaptureScope,
  ) {
    if (expected.version !== 2) return;
    if (!options.enableExpandedScope) fail('scope_review_required');
    const approval = await readAccountScopeApproval(session, ownerId, options.sha256);
    if (!approval) fail('scope_review_required');
    if (
      approval.digest !== expected.approvalDigest ||
      approval.record.historyIncluded !== expected.historyIncluded
    )
      fail('scope_changed');
  }
  async function owned(session: SqlSession, ownerId: string) {
    await activated(session);
    const binding = await readBinding(session);
    if (binding !== null && binding !== ownerId) fail('different_data_owner');
    return binding;
  }
  async function journal(session: SqlSession, ownerId: string) {
    const value = await readJournal(session, ownerId, options.sha256);
    if (value && (await readBinding(session)) !== ownerId) fail('stored_data_invalid');
    if (value?.lastApply && value.lastApply.storeRevision > (await readRevision(session, 'store')))
      fail('stored_data_invalid');
    if (
      value?.pending &&
      value.pending.capturedLocal.storeRevision > (await readRevision(session, 'store'))
    )
      fail('stored_data_invalid');
    for (const snapshot of [
      value?.base?.snapshot,
      value?.pending?.capturedLocal.snapshot,
      value?.pending?.remote.snapshot,
      value?.pending?.proposed,
    ]) {
      if (snapshot) assertSnapshotCatalogue(snapshot, options.catalogue, options.knownRecipeIds);
    }
    return value;
  }
  function advanceRemote(base: AccountRemoteState | null, incoming: AccountRemoteState) {
    if (incoming.deletionOperationId !== null) fail('deletion_pending');
    if (incoming.snapshot)
      assertSnapshotCatalogue(incoming.snapshot, options.catalogue, options.knownRecipeIds);
    if (
      base &&
      (incoming.revision < base.revision ||
        (incoming.revision === base.revision && !sameRemote(base, incoming)))
    )
      fail('stale_server_revision');
  }
  async function remoteFence(
    remote: AccountRemoteState,
  ): Promise<NonNullable<AccountReplicationJournal['observed']>> {
    return {
      revision: remote.revision,
      snapshotDigest: remote.snapshot
        ? await options.sha256(canonicalAccountSnapshot(remote.snapshot))
        : null,
      updatedAt: remote.updatedAt,
    };
  }
  async function writeJournal(session: SqlSession, value: AccountReplicationJournal) {
    await writeMetadata(session, journalKey(value.ownerId), value);
    return freezeResult(value) as AccountReplicationJournal;
  }
  async function activeActions(session: SqlSession) {
    if (
      (
        await session.all(
          `SELECT 1 FROM pending_intent WHERE phase NOT IN ('settled','cancelled') LIMIT 1`,
        )
      ).length ||
      (
        await session.all(
          `SELECT 1 FROM assistant_intent_context WHERE lifecycle='awaiting_response' LIMIT 1`,
        )
      ).length
    )
      fail('active_actions');
    if (
      (
        await session.all(`SELECT 1 FROM command_slot s JOIN pending_intent p ON p.user_intent_id=s.user_intent_id
      LEFT JOIN operation_receipt r ON r.operation_id=s.operation_id WHERE p.phase='settled' AND r.operation_id IS NULL LIMIT 1`)
      ).length
    )
      fail('recovery_required');
  }
  return Object.freeze<AccountReplicationRepository>({
    inspect: async (scope) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      const before = settings();
      const result = await options.reader.transaction(async (session) => {
        await activated(session);
        const deviceDataOwnerId = await readBinding(session);
        const currentJournal = await journal(session, scope.ownerId);
        if (currentJournal && deviceDataOwnerId !== scope.ownerId) fail('stored_data_invalid');
        const pendingSettings = await readPendingSettings(session, options.catalogue);
        if (pendingSettings && pendingSettings.ownerId !== deviceDataOwnerId)
          fail('stored_data_invalid');
        if (
          pendingSettings &&
          deviceDataOwnerId === scope.ownerId &&
          currentJournal?.lastApply?.operationId !== pendingSettings.operationId
        )
          fail('stored_data_invalid');
        return {
          local: await local(session, before, scope.ownerId, currentJournal),
          journal: currentJournal,
          deviceDataOwnerId,
          pendingSettings,
          ...(options.enableExpandedScope
            ? {
                scopeApproval: await readAccountScopeApproval(
                  session,
                  scope.ownerId,
                  options.sha256,
                ),
              }
            : {}),
        };
      });
      finalGuard(admit, before)();
      return freezeResult(result) as typeof result;
    },
    stage: async (scope, input) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      if (
        !exact(input, [
          'operationId',
          'expectedJournalRevision',
          'expectedDeviceDataOwnerId',
          'initialImportReviewed',
          'capturedLocal',
          'remote',
          'proposed',
          'mode',
        ]) ||
        !uuid(input.operationId) ||
        !revision(input.expectedJournalRevision) ||
        (input.expectedDeviceDataOwnerId !== null && !uuid(input.expectedDeviceDataOwnerId)) ||
        typeof input.initialImportReviewed !== 'boolean' ||
        !['push', 'pull'].includes(input.mode)
      )
        fail('invalid_input');
      const {
        operationId,
        expectedJournalRevision,
        expectedDeviceDataOwnerId,
        initialImportReviewed,
        mode,
      } = input;
      const capturedLocal = capture(input.capturedLocal);
      const remote = remoteState(input.remote, scope.ownerId);
      const proposed = normalizeAccountSnapshot(input.proposed);
      // Parsing v2 alone never activates expanded local writes.
      if (
        !options.enableExpandedScope &&
        (proposed.schemaVersion === 2 ||
          capturedLocal.snapshot.schemaVersion === 2 ||
          remote.snapshot?.schemaVersion === 2)
      )
        fail('scope_review_required');
      const captureScope = accountCaptureScope(capturedLocal);
      if (options.enableExpandedScope && captureScope.version !== 2) fail('scope_review_required');
      if (
        proposed.schemaVersion !== captureScope.version ||
        (remote.snapshot?.schemaVersion === 2 && captureScope.version !== 2)
      )
        fail('scope_review_required');
      assertSnapshotCatalogue(proposed, options.catalogue, options.knownRecipeIds);
      advanceRemote(null, remote);
      if (
        mode === 'pull' &&
        (!remote.snapshot || !accountSnapshotsEqual(proposed, remote.snapshot))
      )
        fail('invalid_input');
      const proposedDigest = await options.sha256(canonicalAccountSnapshot(proposed));
      const observed = await remoteFence(remote);
      const before = settings();
      return options.writer.transaction(
        async (session) => {
          const binding = await owned(session, scope.ownerId);
          if (binding !== expectedDeviceDataOwnerId) fail('journal_changed');
          if (await readPendingSettings(session, options.catalogue)) fail('settings_pending');
          const current = await journal(session, scope.ownerId);
          await verifyExpandedScope(session, scope.ownerId, captureScope);
          if (current?.schemaVersion === 2 && captureScope.version !== 2) fail('scope_changed');
          if ((current?.revision ?? 0) !== expectedJournalRevision) fail('journal_changed');
          if (current?.pending) fail('operation_pending');
          if (current?.lastApply?.operationId === operationId) fail('operation_changed');
          advanceRemote(current?.base ?? null, remote);
          if (
            current?.observed &&
            (observed.revision < current.observed.revision ||
              (observed.revision === current.observed.revision &&
                JSON.stringify(observed) !== JSON.stringify(current.observed)))
          )
            fail('stale_server_revision');
          if (!sameCapture(await local(session, before, scope.ownerId, current), capturedLocal))
            fail('local_changed');
          if (
            proposed.schemaVersion === 2 &&
            captureScope.version === 2 &&
            captureScope.historyIncluded
          ) {
            if (!proposed.cookingHistory) fail('invalid_input');
            await verifyAccountHistoryContent(proposed.cookingHistory, options);
          }
          if (binding === null) {
            if (!initialImportReviewed) fail('initial_review_required');
            if (
              current ||
              (await readMetadata(session, ACCOUNT_GUEST_KEY, ACCOUNT_SNAPSHOT_MAX_BYTES + 4096))
            )
              fail('stored_data_invalid');
            await writeMetadata(
              session,
              ACCOUNT_GUEST_KEY,
              { schemaVersion: 1, ownerId: scope.ownerId, capturedLocal },
              ACCOUNT_SNAPSHOT_MAX_BYTES + 4096,
            );
            await writeMetadata(
              session,
              ACCOUNT_BINDING_KEY,
              { schemaVersion: 1, ownerId: scope.ownerId },
              256,
            );
          }
          return writeJournal(session, {
            ...(captureScope.version === 2
              ? { schemaVersion: 2 as const, scope: captureScope }
              : { schemaVersion: 1 as const }),
            ownerId: scope.ownerId,
            revision: nextStoredRevision(expectedJournalRevision),
            base: current?.base ?? null,
            observed,
            lastApply: current?.lastApply ?? null,
            pending: {
              operationId,
              mode,
              capturedLocal,
              remote,
              proposed,
              proposedDigest,
              acknowledgement: null,
            },
          });
        },
        { kind: 'none' },
        finalGuard(admit, before),
      );
    },
    recordAcknowledgement: async (scope, input) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      if (!exact(input, ['operationId', 'receipt']) || !uuid(input.operationId))
        fail('invalid_input');
      // Clone the caller-owned receipt before entering any asynchronous transaction work.
      const receiptValue: unknown = JSON.parse(JSON.stringify(input.receipt));
      const operationId = input.operationId;
      return options.writer.transaction(
        async (session) => {
          await owned(session, scope.ownerId);
          const current = await journal(session, scope.ownerId);
          const pending = current?.pending;
          if (
            !current ||
            !pending ||
            pending.operationId !== operationId ||
            pending.mode !== 'push'
          )
            fail('operation_changed');
          const receipt = commitReceipt(
            receiptValue,
            scope.ownerId,
            operationId,
            pending.remote.revision,
          );
          if (pending.acknowledgement) {
            if (JSON.stringify(receipt) !== JSON.stringify(pending.acknowledgement))
              fail('operation_changed');
            return freezeResult(current) as AccountReplicationJournal;
          }
          current.pending = { ...pending, acknowledgement: receipt };
          current.revision = nextStoredRevision(current.revision);
          return writeJournal(session, current);
        },
        { kind: 'none' },
        admit,
      );
    },
    apply: async (scope, input) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      if (
        !exact(input, ['operationId', 'expectedJournalRevision', 'expectedLocal', 'rebased']) ||
        !uuid(input.operationId) ||
        !revision(input.expectedJournalRevision)
      )
        fail('invalid_input');
      const { operationId, expectedJournalRevision } = input;
      const expectedLocal = capture(input.expectedLocal);
      const rebased = normalizeAccountSnapshot(input.rebased);
      if (
        !options.enableExpandedScope &&
        (rebased.schemaVersion === 2 || expectedLocal.snapshot.schemaVersion === 2)
      )
        fail('scope_review_required');
      const expectedScope = accountCaptureScope(expectedLocal);
      if (rebased.schemaVersion !== expectedScope.version) fail('scope_changed');
      assertSnapshotCatalogue(rebased, options.catalogue, options.knownRecipeIds);
      const before = settings();
      const release = options.acquireExclusive();
      if (!release) fail('store_busy');
      let change: StoreChange | null = null;
      let expandedChange: { personalRevision?: number; historyRevision?: number } | undefined;
      try {
        const receipt = await options.writer.transaction(
          async (session) => {
            await owned(session, scope.ownerId);
            const current = await journal(session, scope.ownerId);
            if (current?.lastApply?.operationId === operationId) {
              if (current.pending) fail('operation_changed');
              return current.lastApply;
            }
            if (!current || current.revision !== expectedJournalRevision) fail('journal_changed');
            const pending = current.pending;
            if (!pending || pending.operationId !== operationId) fail('operation_changed');
            if (pending.proposed.schemaVersion === 2 && !options.enableExpandedScope)
              fail('scope_review_required');
            await verifyExpandedScope(session, scope.ownerId, expectedScope);
            if (
              !accountCaptureScopesEqual(accountCaptureScope(pending.capturedLocal), expectedScope)
            )
              fail('scope_changed');
            if (pending.mode === 'push' && !pending.acknowledgement)
              fail('acknowledgement_required');
            if (await readPendingSettings(session, options.catalogue)) fail('settings_pending');
            await activeActions(session);
            const currentLocal = await local(session, before, scope.ownerId, current);
            if (!sameCapture(currentLocal, expectedLocal)) fail('local_changed');
            const acknowledged: AccountRemoteState =
              pending.mode === 'push'
                ? {
                    ownerId: scope.ownerId,
                    revision: pending.acknowledgement!.revision,
                    snapshot: pending.proposed,
                    updatedAt: pending.acknowledgement!.committedAt,
                    deletionOperationId: null,
                  }
                : pending.remote;
            advanceRemote(current.base, acknowledged);
            const appliedAt = options.now();
            if (!isUtcInstant(appliedAt)) fail('invalid_input');
            if (
              rebased.schemaVersion === 2 &&
              currentLocal.snapshot.schemaVersion === 2 &&
              expectedScope.version === 2
            ) {
              let historyChanged = false;
              if (expectedScope.historyIncluded) {
                if (!rebased.cookingHistory || !currentLocal.snapshot.cookingHistory)
                  fail('scope_changed');
                const knownEntries = new Map(
                  currentLocal.snapshot.cookingHistory.entries.map((entry) => [
                    entry.eventId,
                    entry,
                  ]),
                );
                for (const entry of rebased.cookingHistory.entries) {
                  const prior = knownEntries.get(entry.eventId);
                  if (
                    prior &&
                    canonicalAccountHistory({ entries: [prior], removedEventIds: [] }) !==
                      canonicalAccountHistory({ entries: [entry], removedEventIds: [] })
                  )
                    fail('history_content_mismatch');
                }
                historyChanged = (
                  await mergeAccountHistoryProjection(
                    session,
                    scope.ownerId,
                    rebased.cookingHistory,
                    options,
                  )
                ).changed;
              }
              const personalChange = await applyReviewedAccountPersonal(session, rebased.personal);
              expandedChange = {
                ...(personalChange.changed ? { personalRevision: personalChange.revision } : {}),
                ...(historyChanged ? { historyRevision: 0 } : {}),
              };
            }
            change = await applyAccountCookingData(
              session,
              rebased,
              await readBackupData(session),
              currentLocal.snapshot,
              options,
              appliedAt,
            );
            if (expandedChange?.historyRevision !== undefined) {
              expandedChange.historyRevision = change.revision;
              await runBound(
                session,
                'UPDATE cooking_state SET history_revision=? WHERE singleton=1',
                [change.revision],
              );
            }
            const receipt: AccountApplyReceipt = {
              ownerId: scope.ownerId,
              operationId,
              storeRevision: change.revision,
              serverRevision: acknowledged.revision,
              appliedAt,
            };
            const projection = snapshotOptions(
              { appPreferences: rebased.appPreferences, profile: rebased.profile },
              options.catalogue,
            );
            if (!sameOptions(before, projection))
              await writeMetadata(
                session,
                ACCOUNT_SETTINGS_KEY,
                {
                  ownerId: scope.ownerId,
                  operationId,
                  previous: before,
                  projection,
                } satisfies AccountPendingSettings,
                4096,
              );
            // The base is the exact accepted server state, never the rebased late-local state.
            await writeJournal(session, {
              ...current,
              revision: nextStoredRevision(current.revision),
              base: acknowledged,
              observed: await remoteFence(acknowledged),
              pending: null,
              lastApply: receipt,
            });
            return receipt;
          },
          { kind: 'all' },
          finalGuard(admit, before),
        );
        release();
        if (change) options.onCommitted(change, expandedChange);
        return freezeResult(receipt) as AccountApplyReceipt;
      } catch (error) {
        // COMMIT may succeed before its acknowledgement is lost. Only the durable, owner-bound
        // local receipt proves adoption; a network/auth failure by itself never does.
        try {
          admit();
          const proof = await options.reader.transaction(async (session) => {
            await owned(session, scope.ownerId);
            const receipt = (await journal(session, scope.ownerId))?.lastApply;
            return receipt?.operationId === operationId ? receipt : null;
          });
          admit();
          if (proof) {
            release();
            if (change) options.onCommitted(change, expandedChange);
            return freezeResult(proof) as AccountApplyReceipt;
          }
        } catch {
          /* Retain the original failure when proof cannot be established. */
        }
        throw error;
      } finally {
        release();
      }
    },
    readApplyReceipt: async (scope, operationId) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      if (!uuid(operationId)) fail('invalid_input');
      const result = await options.reader.transaction(async (session) => {
        await owned(session, scope.ownerId);
        const last = (await journal(session, scope.ownerId))?.lastApply;
        return last?.operationId === operationId ? last : null;
      });
      admit();
      return freezeResult(result) as typeof result;
    },
    acknowledgeSettings: async (scope, expected) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      if (
        !exact(expected, ['ownerId', 'operationId', 'previous', 'projection']) ||
        expected.ownerId !== scope.ownerId ||
        !uuid(expected.operationId)
      )
        fail('invalid_input');
      const copy: AccountPendingSettings = {
        ownerId: expected.ownerId,
        operationId: expected.operationId,
        previous: snapshotOptions(expected.previous, options.catalogue),
        projection: snapshotOptions(expected.projection, options.catalogue),
      };
      const before = settings();
      if (!sameOptions(before, copy.projection)) fail('settings_changed');
      await options.writer.transaction(
        async (session) => {
          await owned(session, scope.ownerId);
          const pending = await readPendingSettings(session, options.catalogue);
          if (!pending || JSON.stringify(pending) !== JSON.stringify(copy))
            fail('operation_changed');
          if (
            (await journal(session, scope.ownerId))?.lastApply?.operationId !== pending.operationId
          )
            fail('stored_data_invalid');
          await runBound(session, 'DELETE FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY]);
        },
        { kind: 'none' },
        finalGuard(admit, before),
      );
    },
    readInitialGuestCapture: async (scope) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      const result = await options.reader.transaction(async (session) => {
        await owned(session, scope.ownerId);
        const value = await readMetadata(
          session,
          ACCOUNT_GUEST_KEY,
          ACCOUNT_SNAPSHOT_MAX_BYTES + 4096,
        );
        if (value === null) return null;
        if (
          !exact(value, ['schemaVersion', 'ownerId', 'capturedLocal']) ||
          value.schemaVersion !== 1 ||
          value.ownerId !== scope.ownerId
        )
          fail('stored_data_invalid');
        try {
          return capture(value.capturedLocal);
        } catch {
          return fail('stored_data_invalid');
        }
      });
      admit();
      return freezeResult(result) as typeof result;
    },
    discardRejected: async (scope, input) => {
      scope = { ...scope };
      const admit = scopeAdmission(scope);
      if (
        !exact(input, ['operationId', 'expectedJournalRevision', 'reason']) ||
        !uuid(input.operationId) ||
        !revision(input.expectedJournalRevision) ||
        input.reason !== 'needs_review'
      )
        fail('invalid_input');
      const { operationId, expectedJournalRevision } = input;
      return options.writer.transaction(
        async (session) => {
          await owned(session, scope.ownerId);
          const current = await journal(session, scope.ownerId);
          if (!current || current.revision !== expectedJournalRevision) fail('journal_changed');
          if (
            !current.pending ||
            current.pending.operationId !== operationId ||
            current.pending.mode !== 'push' ||
            current.pending.acknowledgement !== null
          )
            fail('operation_changed');
          return writeJournal(session, {
            ...current,
            revision: nextStoredRevision(current.revision),
            pending: null,
          });
        },
        { kind: 'none' },
        admit,
      );
    },
  });
}
