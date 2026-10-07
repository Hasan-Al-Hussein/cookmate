import type { AccountReplicationScope, AccountSnapshotOptions } from '@cookmate/account-sync';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { portablePersonalLimits, type Immutable } from '@cookmate/domain';
import {
  accountContentSnapshotFromBackup,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import type { AccountContentCaptureScope } from '../../../../packages/account-sync/src/contentScope';
import {
  canonicalPortableContentJson,
  type PortableContentBackupEnvelope,
} from '../../../../packages/domain/src/portableBackupContent';
import {
  readAccountContentCaptureFence,
  readAccountContentPendingCaptureFence,
  type AccountContentPendingCaptureIdentity,
} from './accountContentScopeApproval';
import { exact, fail, revision, snapshotOptions, uuid } from './accountReplicationRecords';
import { capturePortableContentBackupInSnapshot } from './portableContentBackup';
import { freezeResult } from './query';
import type { SqlSession } from './sql';

export interface AccountContentCaptureOptions {
  installationId: string;
  catalogue: Readonly<CatalogueIdentity>;
  currentScope(): AccountReplicationScope | null;
  getLocalSettings(): AccountSnapshotOptions;
  now(): string;
  sha256(text: string): Promise<string>;
}
export interface AccountContentLocalCapture {
  storeRevision: number;
  snapshot: AccountContentSnapshot;
  scope: AccountContentCaptureScope;
  /** Local stale-capture evidence only. Never part of the account snapshot or write authority. */
  fence: Awaited<ReturnType<typeof readAccountContentCaptureFence>> & {
    authGeneration: number;
  };
}
export interface AccountContentPendingBundle {
  capture: AccountContentLocalCapture;
  backup: PortableContentBackupEnvelope;
}

const removedSql = `SELECT event_id AS eventId FROM cooking_history_withdrawal
  UNION SELECT event_id FROM account_cooking_history_removed WHERE owner_id=?
  UNION SELECT event_id FROM cooking_event WHERE state IN ('cleared','cancelled')
  UNION SELECT source_event_id FROM imported_cooking_history imported
    WHERE EXISTS(SELECT 1 FROM cooking_history_withdrawal removed WHERE removed.event_id=imported.event_id)`;

/** Removal identifiers are read only after history approval, with SQL admission before transfer. */
async function historyRemovals(session: SqlSession, binding: string | null): Promise<string[]> {
  // A guest cannot carry another account's entries or deletion facts.
  for (const table of ['account_cooking_history', 'account_cooking_history_removed']) {
    const foreign = await session.all(
      `SELECT 1 FROM ${table} ${binding === null ? '' : 'WHERE owner_id IS NOT ?'} LIMIT 1`,
      binding === null ? [] : [binding],
    );
    if (foreign.length) fail('different_data_owner');
  }
  const values = [binding ?? ''];
  const totals = await session.all<{ count: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(MAX(CASE WHEN typeof(eventId)='text' AND length(CAST(eventId AS BLOB))=36 THEN 0 ELSE 1 END),0) invalid FROM (${removedSql})`,
    values,
  );
  if (totals.length !== 1 || !revision(totals[0]!.count) || totals[0]!.invalid !== 0)
    fail('stored_data_invalid');
  if (totals[0]!.count > portablePersonalLimits.history) fail('too_large');
  const rows = await session.all<{ eventId: string }>(
    `${removedSql} ORDER BY eventId LIMIT ${portablePersonalLimits.history + 1}`,
    values,
  );
  if (rows.length !== totals[0]!.count || rows.some((row) => !uuid(row.eventId)))
    fail('stored_data_invalid');
  return rows.map((row) => row.eventId);
}

/**
 * Private schema7/8 format3 capture. Caller owns one serialized SQL snapshot and checks access
 * again when admitting a later operation. No remote calls, writes, approval promotion or
 * mutation authority are performed here. Locally checked pins do not authenticate publication.
 */
async function captureLocal<Value>(
  session: SqlSession,
  value: AccountReplicationScope,
  options: AccountContentCaptureOptions,
  project: (
    capture: Immutable<AccountContentLocalCapture>,
    backup: Immutable<PortableContentBackupEnvelope>,
  ) => Value,
  pendingIdentity?: AccountContentPendingCaptureIdentity,
): Promise<Value> {
  // Own caller values before the first SQL/hash await.
  if (
    !exact(value, ['ownerId', 'authGeneration']) ||
    !uuid(value.ownerId) ||
    !revision(value.authGeneration) ||
    !uuid(options.installationId)
  )
    fail('invalid_input');
  const scope = Object.freeze({ ownerId: value.ownerId, authGeneration: value.authGeneration });
  let wanted: Readonly<AccountContentPendingCaptureIdentity> | undefined;
  if (pendingIdentity !== undefined) {
    if (
      !exact(pendingIdentity, ['operationId', 'requestFingerprint']) ||
      !uuid(pendingIdentity.operationId) ||
      typeof pendingIdentity.requestFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(pendingIdentity.requestFingerprint)
    )
      fail('invalid_input');
    wanted = Object.freeze({
      operationId: pendingIdentity.operationId,
      requestFingerprint: pendingIdentity.requestFingerprint,
    });
  }
  const installationId = options.installationId;
  function checkScope(): undefined {
    const current = options.currentScope();
    if (
      !current ||
      current.ownerId !== scope.ownerId ||
      current.authGeneration !== scope.authGeneration
    )
      fail('account_changed');
    return undefined;
  }
  // Refuse a stale/closed owner before even consulting their local settings provider.
  checkScope();
  const catalogue: CatalogueIdentity = JSON.parse(
    canonicalPortableContentJson(options.catalogue, 4096),
  );
  const settings = snapshotOptions(
    JSON.parse(canonicalPortableContentJson(options.getLocalSettings(), 4096)),
    catalogue,
  );
  const settingsJson = canonicalPortableContentJson(settings, 4096);
  function check(): undefined {
    checkScope();
    let currentSettings: string;
    try {
      currentSettings = canonicalPortableContentJson(options.getLocalSettings(), 4096);
    } catch {
      fail('settings_changed');
    }
    if (currentSettings !== settingsJson) fail('settings_changed');
    return undefined;
  }
  check();
  // Guard every asynchronous boundary, including helper queries after a hash completes.
  const guarded: SqlSession = {
    all: async <Row extends object>(sql: string, values?: Parameters<SqlSession['all']>[1]) => {
      check();
      const rows = await session.all<Row>(sql, values);
      check();
      return rows;
    },
    exec: async () => fail('invalid_input'),
    prepare: async () => fail('invalid_input'),
  };
  const sha256 = async (text: string) => {
    check();
    const digest = await options.sha256(text);
    check();
    return digest;
  };
  try {
    const readFence = () =>
      wanted
        ? readAccountContentPendingCaptureFence(
            guarded,
            scope.ownerId,
            installationId,
            sha256,
            settings,
            wanted,
          )
        : readAccountContentCaptureFence(guarded, scope.ownerId, installationId, sha256, settings);
    const before = await readFence();
    const { binding, approval } = before;
    if (!approval) fail('scope_review_required');
    const historyIncluded = approval.record.historyIncluded;
    const backup = await capturePortableContentBackupInSnapshot(
      guarded,
      {
        installationId,
        // Initial approved guest capture still reads the guest's unbound local store.
        ownerId: binding,
        catalogue,
        sha256,
        now: options.now,
        assertActive: check,
      },
      historyIncluded,
    );
    const removedHistoryEventIds = historyIncluded
      ? await historyRemovals(guarded, binding)
      : undefined;
    const snapshot = await accountContentSnapshotFromBackup(
      backup,
      settings,
      {
        schemaVersion: 3,
        includeCookingHistory: historyIncluded,
        ...(removedHistoryEventIds ? { removedHistoryEventIds } : {}),
      },
      sha256,
    );
    const after = await readFence();
    if (canonicalPortableContentJson(before, 32768) !== canonicalPortableContentJson(after, 32768))
      fail('local_changed');
    check();
    const capture = freezeResult({
      storeRevision: backup.sourceRevision,
      snapshot,
      scope: { version: 3 as const, approvalDigest: approval.digest, historyIncluded },
      fence: { ...before, authGeneration: scope.authGeneration },
    });
    // These fixed internal projections are synchronous: never add a wrapper await after the
    // final access check or recapture backup data in a different snapshot.
    return project(capture, backup);
  } catch (error) {
    // Codecs can wrap callback failures; preserve the current access/settings failure first.
    check();
    throw error;
  }
}

/** Fresh private capture; retained pending operations must settle before another can start. */
export function captureAccountContentLocal(
  session: SqlSession,
  scope: AccountReplicationScope,
  options: AccountContentCaptureOptions,
): Promise<Immutable<AccountContentLocalCapture>> {
  return captureLocal(session, scope, options, (capture) => capture);
}

/** Fresh capture and its exact removal evidence from one caller-owned SQL snapshot. */
export function captureAccountContentLocalBundle(
  session: SqlSession,
  scope: AccountReplicationScope,
  options: AccountContentCaptureOptions,
): Promise<Immutable<AccountContentPendingBundle>> {
  return captureLocal(session, scope, options, (capture, backup) =>
    freezeResult({ capture, backup }),
  );
}

/**
 * Current local data for an exact retained pending operation, under its unchanged scope consent.
 * The caller still owns the SQL snapshot, content trust, merge/review and final commit admission.
 * This does not modify the original capture, authorize a write, or send data to a service.
 */
export function captureAccountContentPendingLocal(
  session: SqlSession,
  scope: AccountReplicationScope,
  identity: AccountContentPendingCaptureIdentity,
  options: AccountContentCaptureOptions,
): Promise<Immutable<AccountContentLocalCapture>> {
  if (!identity) fail('invalid_input');
  return captureLocal(session, scope, options, (capture) => capture, identity);
}

/** The exact portable envelope used for pending recapture, from the same caller-owned snapshot. */
export function captureAccountContentPendingBundle(
  session: SqlSession,
  scope: AccountReplicationScope,
  identity: AccountContentPendingCaptureIdentity,
  options: AccountContentCaptureOptions,
): Promise<Immutable<AccountContentPendingBundle>> {
  if (!identity) fail('invalid_input');
  return captureLocal(
    session,
    scope,
    options,
    (capture, backup) => freezeResult({ capture, backup }),
    identity,
  );
}
