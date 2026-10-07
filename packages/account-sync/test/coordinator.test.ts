import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAccountSyncCoordinator } from '../src/coordinator';
import { AccountRemoteError, type AccountRemote, type AccountRemoteState } from '../src/remote';
import {
  AccountReplicationError,
  type AccountReplicationRepository,
  type AccountReplicationInspection,
} from '../src/replicationTypes';
import { accountSnapshotsEqual } from '../src/validation';
import { id, snapshot, timestamp, occurrence } from './fixtures';
import { expandedSnapshot, history, note } from './expandedFixtures';
import {
  accountCaptureScope,
  accountCaptureScopesEqual,
  createAccountScopeApprovalEvidence,
} from '../src/scope';
import type { AccountSnapshotV2 } from '../src/types';

/** Durable-port model complements the mobile repository's real SQLite transaction tests. */
function fixture() {
  const scope = { ownerId: id(100), authGeneration: 1 };
  const copy = <T>(value: T): T => structuredClone(value);
  let current = true,
    sequence = 200,
    commits = 0,
    applies = 0,
    discard = 0;
  let commitHook: (() => Promise<void>) | undefined;
  let settingsSucceed = true;
  let cloud: AccountRemoteState = {
    ownerId: scope.ownerId,
    revision: 0,
    snapshot: null,
    updatedAt: null,
    deletionOperationId: null,
  };
  const data: AccountReplicationInspection = {
    local: { storeRevision: 0, snapshot: snapshot() },
    journal: null,
    deviceDataOwnerId: null,
    pendingSettings: null,
  };
  const accepted = new Map<
    string,
    { ownerId: string; operationId: string; revision: number; committedAt: string }
  >();
  const check = () => {
    if (!current) throw new AccountReplicationError('account_changed');
  };
  const repository: AccountReplicationRepository = {
    async inspect() {
      check();
      return copy(data);
    },
    async stage(_scope, input) {
      check();
      if (
        data.local.storeRevision !== input.capturedLocal.storeRevision ||
        !accountSnapshotsEqual(data.local.snapshot, input.capturedLocal.snapshot)
      )
        throw new AccountReplicationError('local_changed');
      if (data.journal && data.journal.revision !== input.expectedJournalRevision)
        throw new AccountReplicationError('journal_changed');
      if (data.journal?.base && input.remote.revision < data.journal.base.revision)
        throw new AccountReplicationError('stale_server_revision');
      const captureScope = accountCaptureScope(input.capturedLocal);
      if (!accountCaptureScopesEqual(captureScope, accountCaptureScope(data.local)))
        throw new AccountReplicationError('scope_changed');
      if (
        captureScope.version === 2 &&
        (!data.scopeApproval ||
          data.scopeApproval.record.ownerId !== scope.ownerId ||
          data.scopeApproval.digest !== captureScope.approvalDigest ||
          data.scopeApproval.record.historyIncluded !== captureScope.historyIncluded)
      )
        throw new AccountReplicationError('scope_review_required');
      data.deviceDataOwnerId = scope.ownerId;
      data.journal = {
        ...(captureScope.version === 2
          ? { schemaVersion: 2 as const, scope: copy(captureScope) }
          : { schemaVersion: 1 as const }),
        ownerId: scope.ownerId,
        revision: (data.journal?.revision ?? 0) + 1,
        base: data.journal?.base ?? null,
        observed: null,
        lastApply: null,
        pending: {
          operationId: input.operationId,
          mode: input.mode,
          capturedLocal: copy(input.capturedLocal),
          remote: copy(input.remote),
          proposed: copy(input.proposed),
          proposedDigest: 'synthetic-digest',
          acknowledgement: null,
        },
      };
      return copy(data.journal);
    },
    async recordAcknowledgement(_scope, input) {
      check();
      assert.equal(data.journal?.pending?.operationId, input.operationId);
      data.journal!.pending!.acknowledgement = copy(input.receipt);
      data.journal!.revision++;
      return copy(data.journal!);
    },
    async apply(_scope, input) {
      check();
      if (data.local.storeRevision !== input.expectedLocal.storeRevision)
        throw new AccountReplicationError('local_changed');
      const pending = data.journal!.pending!;
      if (pending.mode === 'push') assert.ok(pending.acknowledgement);
      applies++;
      data.local = { storeRevision: data.local.storeRevision + 1, snapshot: copy(input.rebased) };
      const captureScope = accountCaptureScope(pending.capturedLocal);
      if (captureScope.version === 2) {
        data.local.scope = copy(captureScope);
        if (!captureScope.historyIncluded && data.local.snapshot.schemaVersion === 2)
          delete data.local.snapshot.cookingHistory;
      }
      const base =
        pending.mode === 'push'
          ? {
              ...pending.remote,
              snapshot: copy(pending.proposed),
              revision: pending.acknowledgement!.revision,
              updatedAt: pending.acknowledgement!.committedAt,
            }
          : copy(pending.remote);
      const receipt = {
        ownerId: scope.ownerId,
        operationId: input.operationId,
        storeRevision: data.local.storeRevision,
        serverRevision: base.revision,
        appliedAt: timestamp,
      };
      data.journal = {
        ...data.journal!,
        base,
        pending: null,
        revision: data.journal!.revision + 1,
        lastApply: receipt,
      };
      return receipt;
    },
    async readApplyReceipt() {
      return copy(data.journal?.lastApply ?? null);
    },
    async acknowledgeSettings() {
      check();
      data.pendingSettings = null;
    },
    async readInitialGuestCapture() {
      return null;
    },
    async discardRejected() {
      check();
      discard++;
      data.journal!.pending = null;
      data.journal!.revision++;
      return copy(data.journal!);
    },
  };
  const remote: AccountRemote = {
    ownerId: scope.ownerId,
    async read() {
      return copy(cloud);
    },
    async commit(input) {
      commits++;
      assert.equal(
        data.journal?.pending?.operationId,
        input.operationId,
        'outbox must exist before HTTP',
      );
      const existing = accepted.get(input.operationId);
      if (existing) return copy(existing);
      await commitHook?.();
      if (input.expectedRevision !== cloud.revision) throw new AccountRemoteError('needs_review');
      const receipt = {
        ownerId: scope.ownerId,
        operationId: input.operationId,
        revision: cloud.revision + 1,
        committedAt: timestamp,
      };
      cloud = {
        ...cloud,
        revision: receipt.revision,
        updatedAt: timestamp,
        snapshot: copy(input.snapshot),
      };
      accepted.set(input.operationId, receipt);
      return copy(receipt);
    },
    async delete() {
      throw new Error('Deletion must not be part of sync');
    },
  };
  const create = (enableExpandedScope = false) =>
    createAccountSyncCoordinator({
      scope,
      isCurrent: () => current,
      repository,
      remote,
      newId: () => id(sequence++),
      projectSettings: async () => settingsSucceed,
      enableExpandedScope,
    });
  return {
    data,
    remote,
    create,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setCloud: (value: AccountRemoteState) => {
      cloud = value;
    },
    cloud: () => copy(cloud),
    setHook: (hook: typeof commitHook) => {
      commitHook = hook;
    },
    setSettings: (value: boolean) => {
      settingsSucceed = value;
    },
    counts: () => ({ commits, applies, discard }),
  };
}

async function approve(
  f: ReturnType<typeof fixture>,
  historyIncluded = false,
  decidedAt = timestamp,
) {
  const evidence = await createAccountScopeApprovalEvidence(
    {
      schemaVersion: 1,
      ownerId: f.remote.ownerId,
      scopeVersion: 2,
      personalApproved: true,
      historyIncluded,
      decidedAt,
    },
    async (text) => createHash('sha256').update(text).digest('hex'),
  );
  f.data.scopeApproval = evidence;
  const local: AccountSnapshotV2 =
    f.data.local.snapshot.schemaVersion === 2
      ? f.data.local.snapshot
      : {
          ...f.data.local.snapshot,
          schemaVersion: 2 as const,
          personal: expandedSnapshot().personal,
        };
  if (historyIncluded) local.cookingHistory ??= { entries: [], removedEventIds: [] };
  else delete local.cookingHistory;
  f.data.local = {
    ...f.data.local,
    snapshot: local,
    scope: { version: 2, approvalDigest: evidence.digest, historyIncluded },
  };
}

test('expanded production mode blocks new work without durable owner approval despite UI/capture flags', async () => {
  for (const absent of [undefined, null]) {
    const f = fixture();
    await approve(f);
    if (absent === undefined) delete f.data.scopeApproval;
    else f.data.scopeApproval = null;
    const c = f.create(true);
    const before = structuredClone(f.data);
    let reads = 0;
    f.remote.read = async () => {
      reads++;
      return f.cloud();
    };
    await c.sync();
    assert.deepEqual(c.getSnapshot(), {
      kind: 'failed',
      reason: 'scope_review_required',
      pending: false,
    });
    assert.equal(reads, 0);
    assert.deepEqual(f.counts(), { commits: 0, applies: 0, discard: 0 });
    assert.deepEqual(f.data, before);
  }
});

test('expanded approval binds owner, exact digest/history and included capture before any staging', async () => {
  for (const failure of ['owner', 'digest', 'history', 'unexpectedHistory'] as const) {
    const f = fixture();
    await approve(f);
    if (failure === 'owner') f.data.scopeApproval!.record.ownerId = id(101);
    if (failure === 'digest') f.data.scopeApproval!.digest = 'f'.repeat(64);
    if (failure === 'history') f.data.scopeApproval!.record.historyIncluded = true;
    if (failure === 'unexpectedHistory' && f.data.local.snapshot.schemaVersion === 2)
      f.data.local.snapshot.cookingHistory = { entries: [history()], removedEventIds: [] };
    const c = f.create(true);
    await c.sync();
    assert.deepEqual(c.getSnapshot(), {
      kind: 'failed',
      reason:
        failure === 'owner'
          ? 'different_data_owner'
          : failure === 'unexpectedHistory'
            ? 'stored_data_invalid'
            : 'scope_changed',
      pending: false,
    });
    assert.equal(f.data.journal, null);
    assert.equal(f.counts().commits, 0);
  }
});

test('approved expanded review stages journal2 and converges with preserved remote history while history is off', async () => {
  const f = fixture();
  await approve(f);
  const cloud = expandedSnapshot();
  cloud.cookingHistory = { entries: [history()], removedEventIds: [] };
  f.setCloud({ ...f.cloud(), revision: 1, updatedAt: timestamp, snapshot: cloud });
  if (f.data.local.snapshot.schemaVersion === 2) f.data.local.snapshot.personal.notes = [note()];
  const c = f.create(true);
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'review');
  assert.equal(f.counts().commits, 0);
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.data.journal?.schemaVersion, 2);
  const savedSnapshot = f.cloud().snapshot;
  assert.deepEqual(
    savedSnapshot?.schemaVersion === 2 ? savedSnapshot.cookingHistory : null,
    cloud.cookingHistory,
  );
  assert.equal(Object.hasOwn(f.data.local.snapshot, 'cookingHistory'), false);
  assert.equal(f.data.journal?.base?.snapshot?.schemaVersion, 2);
  const saved = f.counts();
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.deepEqual(f.counts(), saved, 'excluded history causes no endless upload');
});

test('scope changed during an open review cannot stage; changed exact approval record also invalidates review', async () => {
  for (const sameDigest of [false, true]) {
    const f = fixture();
    await approve(f);
    const c = f.create(true);
    await c.sync();
    if (sameDigest) f.data.scopeApproval!.record.decidedAt = '2026-09-30T09:00:00.000Z';
    else await approve(f, true, '2026-09-30T09:00:00.000Z');
    await c.confirm();
    assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'scope_changed', pending: false });
    assert.equal(f.data.journal, null);
    assert.equal(f.counts().commits, 0);
  }
});

test('expanded use-account cannot downgrade or erase local personal/history absent from a v1 account', async () => {
  const f = fixture();
  await approve(f, true);
  if (f.data.local.snapshot.schemaVersion === 2) {
    f.data.local.snapshot.personal.notes = [note()];
    f.data.local.snapshot.cookingHistory = { entries: [history()], removedEventIds: [] };
  }
  const cloud = snapshot();
  cloud.profile.displayName = 'Account name';
  f.setCloud({ ...f.cloud(), revision: 1, updatedAt: timestamp, snapshot: cloud });
  const c = f.create(true);
  await c.sync();
  c.select('account');
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  const result = f.cloud().snapshot;
  assert.equal(result?.schemaVersion, 2);
  if (result?.schemaVersion !== 2) return;
  assert.equal(result.profile.displayName, 'Account name');
  assert.deepEqual(result.personal.notes, [note()]);
  assert.deepEqual(result.cookingHistory, { entries: [history()], removedEventIds: [] });
});

test('Prefer account versions cannot stage a known note revival before a separate exact choice', async () => {
  for (const localRemoved of [true, false]) {
    for (const chooseRemoval of [true, false]) {
      const f = fixture();
      await approve(f);
      const removed = { ...note(), text: null, deleted: true };
      if (f.data.local.snapshot.schemaVersion !== 2) throw new Error('Expected expanded capture');
      f.data.local.snapshot.personal.notes = [localRemoved ? removed : note()];
      const account = expandedSnapshot();
      account.personal.notes = [localRemoved ? note() : removed];
      f.setCloud({ ...f.cloud(), revision: 1, updatedAt: timestamp, snapshot: account });
      const c = f.create(true);
      await c.sync();
      c.select('account');
      const view = c.getSnapshot();
      assert.equal(view.kind, 'review');
      if (view.kind !== 'review') throw new Error('Expected review');
      assert.equal(view.canConfirm, false);
      assert.equal(view.conflicts.length, 1);
      assert.equal(view.conflicts[0]!.kind, 'delete_edit');
      await c.confirm();
      assert.equal(f.counts().commits, 0);
      assert.equal(f.data.journal, null);
      const choice = chooseRemoval === localRemoved ? 'local' : 'account';
      c.resolve(view.conflicts[0]!.id, choice);
      await c.confirm();
      assert.equal(c.getSnapshot().kind, 'synced');
      const result = f.cloud().snapshot;
      assert.equal(result?.schemaVersion, 2);
      if (result?.schemaVersion === 2)
        assert.equal(result.personal.notes[0]!.deleted, chooseRemoval);
    }
  }
});

test('cancelling a separate removal review preserves both replicas and stages nothing', async () => {
  const f = fixture();
  await approve(f);
  if (f.data.local.snapshot.schemaVersion !== 2) throw new Error('Expected expanded capture');
  f.data.local.snapshot.personal.notes = [{ ...note(), text: null, deleted: true }];
  const account = expandedSnapshot();
  account.personal.notes = [note()];
  f.setCloud({ ...f.cloud(), revision: 1, updatedAt: timestamp, snapshot: account });
  const before = structuredClone(f.data),
    cloudBefore = f.cloud();
  const c = f.create(true);
  await c.sync();
  c.select('account');
  c.cancelReview();
  assert.deepEqual(c.getSnapshot(), { kind: 'local' });
  await c.confirm();
  assert.deepEqual(f.data, before);
  assert.deepEqual(f.cloud(), cloudBefore);
  assert.deepEqual(f.counts(), { commits: 0, applies: 0, discard: 0 });
});

test('empty account remains non-replacement in expanded review', async () => {
  const f = fixture();
  await approve(f);
  const c = f.create(true);
  await c.sync();
  c.select('account');
  const view = c.getSnapshot();
  assert.equal(view.kind, 'review');
  if (view.kind === 'review') assert.equal(view.canConfirm, false);
  await c.confirm();
  assert.equal(f.counts().commits, 0);
});

test('expanded scope change during acknowledgement cannot apply old scope and keeps exact pending receipt', async () => {
  const f = fixture();
  await approve(f);
  const c = f.create(true);
  await c.sync();
  f.setHook(async () => {
    await approve(f, true, '2026-09-30T09:00:00.000Z');
  });
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'scope_changed', pending: true });
  assert.equal(f.counts().applies, 0);
  assert.ok(f.data.journal?.pending?.acknowledgement);
  assert.equal(f.data.journal?.pending?.capturedLocal.scope?.version, 2);
  const pending = structuredClone(f.data.journal!.pending);
  await c.sync();
  assert.deepEqual(f.data.journal!.pending, pending);
  assert.equal(f.counts().commits, 1);
});

test('interrupted v1 operation reconciles original bytes before expanded approval is required', async () => {
  const f = fixture(),
    old = f.create();
  f.setHook(async () => {
    throw new AccountRemoteError('unavailable');
  });
  await old.sync();
  await old.confirm();
  const pending = structuredClone(f.data.journal!.pending!);
  await old.invalidate();
  f.data.scopeApproval = null;
  // Decoding an old capture may add only an internal legacy discriminator.
  f.data.local.scope = { version: 1 };
  f.data.journal!.pending!.capturedLocal.scope = { version: 1 };
  f.setHook(undefined);
  const upgraded = f.create(true);
  await upgraded.sync();
  assert.equal(f.data.journal!.lastApply!.operationId, pending.operationId);
  assert.deepEqual(f.cloud().snapshot, pending.proposed);
  assert.equal(f.data.journal?.schemaVersion, 1);
  assert.equal(f.data.journal?.pending, null);
  assert.deepEqual(upgraded.getSnapshot(), {
    kind: 'failed',
    reason: 'scope_review_required',
    pending: false,
  });
  const saved = f.counts();
  await upgraded.sync();
  assert.deepEqual(f.counts(), saved);
});

test('a later history opt-in requires another scoped comparison even after previous personal sync', async () => {
  const f = fixture();
  await approve(f);
  const c = f.create(true);
  await c.sync();
  await c.confirm();
  const saved = f.counts();
  await approve(f, true, '2026-09-30T09:00:00.000Z');
  await c.sync();
  const view = c.getSnapshot();
  assert.equal(view.kind, 'review');
  if (view.kind === 'review') assert.equal(view.initial, true);
  assert.deepEqual(f.counts(), saved);
  c.cancelReview();
  assert.deepEqual(f.counts(), saved);
});

test('approval changing during an unchanged remote read cannot report stale synced status', async () => {
  const f = fixture();
  await approve(f);
  const c = f.create(true);
  await c.sync();
  await c.confirm();
  const saved = f.counts();
  f.remote.read = async () => {
    await approve(f, true, '2026-09-30T09:00:00.000Z');
    return f.cloud();
  };
  await c.sync();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'scope_changed', pending: false });
  assert.deepEqual(f.counts(), saved);
});

test('first guest upload needs review, then journals before sending and reports a verified save', async () => {
  const f = fixture(),
    c = f.create();
  f.data.local.snapshot.favourites.push({ recipeId: '52819', savedAt: timestamp });
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'review');
  assert.deepEqual(f.counts(), { commits: 0, applies: 0, discard: 0 });
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.deepEqual(f.cloud().snapshot?.favourites, f.data.local.snapshot.favourites);
  assert.equal(f.data.journal?.pending, null);
});

test('legacy coordinator rejects expanded local or remote scope before staging or replacement selection', async () => {
  for (const expandedLocal of [true, false]) {
    const f = fixture(),
      c = f.create();
    if (expandedLocal) f.data.local.snapshot = expandedSnapshot();
    else
      f.setCloud({ ...f.cloud(), revision: 1, snapshot: expandedSnapshot(), updatedAt: timestamp });
    const before = structuredClone(f.data);
    await c.sync();
    assert.deepEqual(c.getSnapshot(), {
      kind: 'failed',
      reason: 'scope_review_required',
      pending: false,
    });
    c.select('account');
    await c.confirm();
    assert.deepEqual(f.counts(), { commits: 0, applies: 0, discard: 0 });
    assert.deepEqual(f.data, before);
  }
});

test('expanded outbox is retained untouched and never committed without durable scope integration', async () => {
  const f = fixture(),
    c = f.create();
  f.setHook(async () => {
    throw new AccountRemoteError('unavailable');
  });
  await c.sync();
  await c.confirm();
  f.data.journal!.pending!.proposed = expandedSnapshot();
  const before = structuredClone(f.data);
  const counts = f.counts();
  await c.invalidate();
  const resumed = f.create();
  await resumed.sync();
  assert.deepEqual(resumed.getSnapshot(), {
    kind: 'failed',
    reason: 'scope_review_required',
    pending: true,
  });
  assert.deepEqual(f.data, before);
  assert.deepEqual(f.counts(), counts);
});

test('persisted expanded captures with mismatched history presence cannot retry or apply', async () => {
  for (const historyIncluded of [false, true]) {
    const f = fixture();
    await approve(f, historyIncluded);
    const c = f.create(true);
    f.setHook(async () => {
      throw new AccountRemoteError('unavailable');
    });
    await c.sync();
    await c.confirm();
    await c.invalidate();
    const captured = f.data.journal!.pending!.capturedLocal.snapshot;
    assert.equal(captured.schemaVersion, 2);
    if (captured.schemaVersion !== 2) throw new Error('Expected expanded capture');
    if (historyIncluded) delete captured.cookingHistory;
    else captured.cookingHistory = { entries: [history()], removedEventIds: [] };
    const before = structuredClone(f.data),
      counts = f.counts();
    f.setHook(undefined);
    const resumed = f.create(true);
    await resumed.sync();
    assert.deepEqual(resumed.getSnapshot(), {
      kind: 'failed',
      reason: 'stored_data_invalid',
      pending: true,
    });
    assert.deepEqual(f.counts(), counts);
    assert.deepEqual(f.data, before);
  }
});

test('cancelling initial review leaves guest data and cloud untouched', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  c.cancelReview();
  assert.equal(c.getSnapshot().kind, 'local');
  assert.equal(f.data.journal, null);
  assert.deepEqual(f.counts(), { commits: 0, applies: 0, discard: 0 });
});

test('uncertain upload keeps the exact outbox and resumes after coordinator restart', async () => {
  const f = fixture(),
    c = f.create();
  f.setHook(async () => {
    throw new AccountRemoteError('unavailable');
  });
  await c.sync();
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'unavailable', pending: true });
  const operationId = f.data.journal!.pending!.operationId;
  c.invalidate();
  f.setHook(undefined);
  const resumed = f.create();
  await resumed.sync();
  assert.equal(resumed.getSnapshot().kind, 'synced');
  assert.equal(f.data.journal!.lastApply!.operationId, operationId);
  assert.equal(f.counts().commits, 2);
});

test('late local edits survive server acknowledgement and remain unsynced until their own save', async () => {
  const f = fixture(),
    c = f.create();
  f.setHook(async () => {
    f.data.local.storeRevision++;
    f.data.local.snapshot.favourites.push({ recipeId: '52819', savedAt: timestamp });
  });
  await c.sync();
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'local');
  assert.equal(f.data.local.snapshot.favourites.length, 1);
  assert.equal(f.data.journal!.base!.snapshot!.favourites.length, 0);
  f.setHook(undefined);
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.cloud().snapshot!.favourites.length, 1);
});

test('a lost HTTP acknowledgement recovers the same server receipt without a second save', async () => {
  const f = fixture(),
    c = f.create();
  const commit = f.remote.commit;
  let first = true;
  f.remote.commit = async (input, signal) => {
    const receipt = await commit(input, signal);
    if (first) {
      first = false;
      throw new AccountRemoteError('unavailable');
    }
    return receipt;
  };
  await c.sync();
  await c.confirm();
  assert.equal(f.cloud().revision, 1);
  assert.equal(f.data.journal!.pending!.acknowledgement, null);
  const operation = f.data.journal!.pending!.operationId;
  c.invalidate();
  const resumed = f.create();
  await resumed.sync();
  assert.equal(f.cloud().revision, 1);
  assert.equal(resumed.getSnapshot().kind, 'synced');
  assert.equal(f.data.journal!.lastApply!.operationId, operation);
});

test('confirmed CAS rejection discards only the rejected outbox; uncertain failures do not', async () => {
  const f = fixture(),
    c = f.create();
  f.setHook(async () => {
    throw new AccountRemoteError('needs_review');
  });
  await c.sync();
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'needs_review', pending: false });
  assert.equal(f.counts().discard, 1);
  assert.equal(f.counts().applies, 0);
});

test('changing account during HTTP cannot apply or acknowledge the old response', async () => {
  const f = fixture(),
    c = f.create();
  f.setHook(async () => {
    f.setCurrent(false);
  });
  await c.sync();
  await c.confirm();
  assert.equal(f.data.journal!.pending!.acknowledgement, null);
  assert.equal(f.counts().applies, 0);
});

test('a workspace owned by another account makes no remote request', async () => {
  const f = fixture(),
    c = f.create();
  f.data.deviceDataOwnerId = id(999);
  f.remote.read = async () => {
    throw new Error('must not dispatch');
  };
  await c.sync();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'different_data_owner',
    pending: false,
  });
});

test('another owner’s pending display settings are rejected before any KV projection', async () => {
  const f = fixture(),
    c = f.create();
  f.data.deviceDataOwnerId = id(999);
  f.data.pendingSettings = {
    ownerId: id(999),
    operationId: id(200),
    previous: snapshot(),
    projection: snapshot(),
  };
  f.setSettings(false); // A projection attempt would incorrectly report settings_changed.
  await c.sync();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'different_data_owner',
    pending: false,
  });
  assert.ok(f.data.pendingSettings);
});

test('local edits after review require a new comparison instead of applying a stale choice', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  f.data.local.storeRevision++;
  f.data.local.snapshot.plan.push(occurrence(9));
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'local_changed', pending: false });
  assert.equal(f.counts().commits, 0);
  assert.equal(f.data.local.snapshot.plan.length, 1);
});

test('meal conflicts are explicitly resolved before any server write', async () => {
  const f = fixture(),
    c = f.create();
  f.data.local.snapshot.plan.push(occurrence(9, '52819'));
  const account = snapshot();
  account.plan.push(occurrence(10, '52820'));
  f.setCloud({ ...f.cloud(), revision: 2, snapshot: account, updatedAt: timestamp });
  await c.sync();
  const review = c.getSnapshot();
  assert.equal(review.kind, 'review');
  if (review.kind !== 'review') return;
  assert.equal(review.canConfirm, false);
  assert.equal(review.conflicts.length, 1);
  c.resolve(review.conflicts[0]!.id, 'local');
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.cloud().snapshot!.plan.length, 1);
  assert.equal(f.cloud().snapshot!.plan[0]!.recipeId, '52819');
});

test('display projection failure cannot report a completed sync', async () => {
  const f = fixture(),
    c = f.create();
  f.data.pendingSettings = {
    ownerId: id(100),
    operationId: id(200),
    previous: snapshot(),
    projection: snapshot(),
  };
  f.setSettings(false);
  await c.sync();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'settings_changed', pending: false });
  assert.ok(f.data.pendingSettings);
  assert.equal(f.counts().commits, 0);
});

test('using account data is an explicit reviewed pull without an invented upload', async () => {
  const f = fixture(),
    c = f.create();
  const account = snapshot();
  account.favourites.push({ recipeId: '52819', savedAt: timestamp });
  f.setCloud({ ...f.cloud(), revision: 3, snapshot: account, updatedAt: timestamp });
  await c.sync();
  c.select('account');
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.counts().commits, 0);
  assert.equal(f.data.local.snapshot.favourites.length, 1);
});
