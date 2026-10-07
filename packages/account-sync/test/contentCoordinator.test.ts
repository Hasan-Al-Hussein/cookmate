import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Immutable } from '@cookmate/domain';
import {
  createAccountContentCoordinator,
  type ContentSyncServices,
  type ContentSyncBootstrapServices,
  type ContentSyncCapture,
  type ContentSyncPushReview,
  type ContentSyncApplyReview,
} from '../src/contentCoordinator';
import { mergeAccountContentSnapshots } from '../src/contentMerge';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../src/contentSnapshot';
import type {
  AccountContentRemoteState,
  AccountContentReplicationJournal,
} from '../src/contentReplicationRecords';
import type { AccountContentRemote, AccountContentServiceRemoteState } from '../src/contentRemote';
import { AccountRemoteError, type AccountCommitReceipt } from '../src/remote';
import { AccountReplicationError, type AccountPendingSettings } from '../src/replicationTypes';
import type { AccountMergeResolutions } from '../src/types';
import { expandedSnapshot, note } from './expandedFixtures';
import { id, timestamp, options, snapshot as legacySnapshot } from './fixtures';

const copy = <Value>(value: Value): Value => structuredClone(value);
const contentSnapshot = (): AccountContentSnapshot => {
  const { cookingHistory: _history, ...core } = expandedSnapshot();
  return { ...core, schemaVersion: 3, planReferences: [] };
};
type Capture = Omit<ContentSyncCapture, 'snapshot'> & {
  snapshot: AccountContentSnapshot;
  storeRevision: number;
  fence: { binding: string | null; nonce: number };
};
type Services = ContentSyncServices<Capture, ContentSyncPushReview, ContentSyncApplyReview>;
type StageInput = Parameters<Services['journal']['stage']>[1];
type PushInput = Parameters<Services['journal']['reviewPush']>[1];
type FixtureStageInput = Omit<StageInput, 'mode' | 'expectedDeviceDataOwnerId'> & {
  mode: 'push' | 'pull';
  expectedDeviceDataOwnerId: string | null;
};

/** Durable-port model tests orchestration; existing SQL suites own persistence/codec admission. */
function fixture(bootstrap = false) {
  const scope = { ownerId: id(100), authGeneration: 1 };
  const data: {
    local: Capture;
    journal: AccountContentReplicationJournal | null;
    settings: AccountPendingSettings | null;
    cloud: AccountContentServiceRemoteState;
  } = {
    local: {
      snapshot: contentSnapshot(),
      scope: { version: 3, approvalDigest: 'a'.repeat(64), historyIncluded: false },
      storeRevision: 0,
      fence: { binding: bootstrap ? null : scope.ownerId, nonce: 0 },
    },
    journal: null,
    settings: null,
    cloud: {
      ownerId: scope.ownerId,
      revision: 0,
      snapshot: null,
      updatedAt: null,
      deletionOperationId: null,
    },
  };
  const calls: string[] = [];
  const submitted: Parameters<AccountContentRemote['commit']>[0][] = [];
  const accepted = new Map<string, AccountCommitReceipt>();
  const pushes = new WeakMap<
    ContentSyncPushReview,
    { capture: Capture; input: PushInput; resolutions: AccountMergeResolutions }
  >();
  const applies = new WeakMap<ContentSyncApplyReview, AccountContentSnapshot>();
  const hooks: {
    commit?: (signal?: AbortSignal) => Promise<void>;
    afterCommit?: () => Promise<void>;
    ack?: () => Promise<void>;
    afterApply?: () => Promise<void>;
    capture?: () => Promise<void>;
    project?: () => Promise<boolean>;
    remoteRead?: () => Promise<void>;
    journalRead?: () => Promise<void>;
    afterReviewPush?: () => Promise<void>;
    afterStage?: () => Promise<void>;
  } = {};
  let current = true,
    sequence = 200,
    removal = false;
  function check() {
    if (!current) throw new AccountReplicationError('account_changed');
  }
  function pending() {
    assert.ok(data.journal?.pending);
    return data.journal.pending;
  }
  function exactIdentity(value: { operationId: string; requestFingerprint: string }) {
    assert.equal(value.operationId, pending().operationId);
    assert.equal(value.requestFingerprint, pending().requestFingerprint);
  }
  function own<Value>(value: Immutable<Value>): Value {
    return structuredClone(value) as Value;
  }
  function merge(
    base: Immutable<AccountContentSnapshot>,
    local: Immutable<AccountContentSnapshot>,
    account: Immutable<AccountContentSnapshot>,
    resolutions?: AccountMergeResolutions,
  ) {
    return mergeAccountContentSnapshots({
      base: own(base),
      local: own(local),
      account: own(account),
      contentScope: { schemaVersion: 3, historyIncluded: data.local.scope.historyIncluded },
      ...(resolutions ? { resolutions } : {}),
    });
  }
  async function stage(input: FixtureStageInput) {
    check();
    assert.equal(data.journal?.pending ?? null, null);
    assert.equal(input.initialImportReviewed, true);
    assert.equal(input.expectedDeviceDataOwnerId, data.local.fence.binding);
    assert.equal(input.expectedJournalRevision, data.journal?.revision ?? 0);
    assert.deepEqual(
      input.capturedLocal,
      data.local,
      'stage retains the entire original capture fence',
    );
    calls.push(`stage:${input.mode}`);
    const next: AccountContentReplicationJournal = {
      schemaVersion: 3,
      ownerId: scope.ownerId,
      installationId: id(101),
      revision: (data.journal?.revision ?? 0) + 1,
      legacyJournalDigest: null,
      scope: copy(input.capturedLocal.scope),
      base: data.journal?.base ?? null,
      observed: {
        revision: input.remote.revision,
        snapshotDigest: input.remote.snapshot ? 'd'.repeat(64) : null,
        updatedAt: input.remote.updatedAt,
      },
      lastApply: data.journal?.lastApply ?? null,
      pending: {
        operationId: input.operationId,
        mode: input.mode,
        capturedLocal: {
          storeRevision: input.capturedLocal.storeRevision,
          snapshot: own<AccountContentSnapshot>(input.capturedLocal.snapshot),
          scope: copy(input.capturedLocal.scope),
          fenceDigest: 'e'.repeat(64),
        },
        remote: own<AccountContentRemoteState>(input.remote),
        proposed: own<AccountContentSnapshot>(input.proposed),
        requestFingerprint: 'f'.repeat(64),
        proposedDigest: 'c'.repeat(64),
        acknowledgement: null,
      },
    };
    data.journal = next;
    data.local = { ...data.local, fence: { ...data.local.fence, binding: scope.ownerId } };
    await hooks.afterStage?.();
    return copy(next);
  }
  const services: Services = {
    scope,
    async capture() {
      check();
      calls.push('capture');
      assert.equal(
        data.journal?.pending ?? null,
        null,
        'ordinary capture cannot bypass pending recovery',
      );
      assert.equal(data.settings, null, 'settings must be acknowledged before capture');
      await hooks.capture?.();
      check();
      return copy(data.local);
    },
    journal: {
      async read() {
        check();
        calls.push('journal');
        await hooks.journalRead?.();
        return copy(data.journal);
      },
      async reviewPush(_scope, input, resolutions = {}) {
        check();
        calls.push('reviewPush');
        const result: ContentSyncPushReview = {
          operationId: input.operationId,
          initialImportRequired: !data.journal?.base,
          merge: merge(
            data.journal?.base?.snapshot ?? contentSnapshot(),
            data.local.snapshot,
            input.remote.snapshot ?? contentSnapshot(),
            resolutions,
          ),
          removalReview: removal ? { conflicts: [{ id: 'removed:core' }] } : null,
        };
        pushes.set(result, { capture: copy(data.local), input, resolutions });
        await hooks.afterReviewPush?.();
        return Object.freeze(result);
      },
      async stageReviewedPush(_scope, issued, choices) {
        const capability = pushes.get(issued);
        assert.ok(capability, 'only the exact issued push review is accepted');
        assert.deepEqual(choices.resolutions, capability.resolutions);
        if (issued.removalReview?.conflicts.length && !choices.removalChoices)
          throw new AccountReplicationError('recovery_required');
        if (choices.removalChoices)
          assert.deepEqual(choices.removalChoices, { 'removed:core': 'keep_local' });
        assert.equal(issued.merge.status, 'merged');
        if (issued.merge.status !== 'merged') throw new Error('unresolved review');
        return stage({
          operationId: issued.operationId,
          expectedJournalRevision: data.journal?.revision ?? 0,
          expectedDeviceDataOwnerId: capability.capture.fence.binding,
          initialImportReviewed: choices.initialImportReviewed,
          capturedLocal: capability.capture,
          remote: capability.input.remote,
          proposed: issued.merge.snapshot,
          mode: 'push',
        });
      },
      async stage(_scope, input) {
        return stage(input);
      },
      async recordAcknowledgement(_scope, input) {
        check();
        calls.push('ack');
        exactIdentity(input);
        await hooks.ack?.();
        check();
        pending().acknowledgement = own(input.receipt);
        data.journal!.revision++;
        return copy(data.journal!);
      },
      async discardRejected(_scope, input) {
        check();
        exactIdentity(input);
        assert.equal(input.expectedJournalRevision, data.journal!.revision);
        assert.equal(pending().mode, 'push');
        assert.equal(pending().acknowledgement, null);
        assert.equal(input.reason, 'needs_review');
        calls.push('discard');
        data.journal!.pending = null;
        data.journal!.revision++;
        return copy(data.journal!);
      },
    },
    apply: {
      async inspectSettings() {
        check();
        calls.push('settings');
        return copy(data.settings);
      },
      async acknowledgeSettings(_scope, value) {
        check();
        assert.deepEqual(value, data.settings);
        calls.push('settingsAck');
        data.settings = null;
      },
      async review(_scope, wanted, resolutions) {
        check();
        calls.push('reviewApply');
        exactIdentity(wanted);
        const saved = pending();
        if (saved.mode === 'push') assert.ok(saved.acknowledgement);
        const result: ContentSyncApplyReview = {
          ...wanted,
          blockers: removal ? ['removed_core_choices'] : [],
          removalReview: removal ? { conflicts: [{ id: 'removed:core' }] } : null,
          merge: merge(
            saved.capturedLocal.snapshot,
            data.local.snapshot,
            saved.proposed,
            resolutions,
          ),
        };
        if (result.merge.status === 'merged')
          applies.set(result, own<AccountContentSnapshot>(result.merge.snapshot));
        return Object.freeze(result);
      },
      async apply(_scope, issued, _resolutions, removals) {
        check();
        exactIdentity(issued);
        const candidate = applies.get(issued);
        assert.ok(candidate, 'only the exact issued apply review is accepted');
        if (issued.blockers.length && !removals)
          throw new AccountReplicationError('recovery_required');
        calls.push('apply');
        const saved = pending(),
          base =
            saved.mode === 'pull'
              ? saved.remote
              : {
                  ...saved.remote,
                  snapshot: saved.proposed,
                  revision: saved.acknowledgement!.revision,
                  updatedAt: saved.acknowledgement!.committedAt,
                };
        data.local = {
          ...data.local,
          snapshot: candidate,
          storeRevision: data.local.storeRevision + 1,
        };
        if (!data.local.scope.historyIncluded) {
          const { cookingHistory: _history, ...scoped } = data.local.snapshot;
          data.local.snapshot = scoped;
        }
        const receipt = {
          ...issued,
          ownerId: scope.ownerId,
          storeRevision: data.local.storeRevision,
          serverRevision: base.revision,
          appliedAt: timestamp,
        };
        data.journal = {
          ...data.journal!,
          base: copy(base),
          pending: null,
          lastApply: {
            ownerId: receipt.ownerId,
            operationId: receipt.operationId,
            requestFingerprint: receipt.requestFingerprint,
            storeRevision: receipt.storeRevision,
            serverRevision: receipt.serverRevision,
            appliedAt: receipt.appliedAt,
          },
          revision: data.journal!.revision + 1,
        };
        data.settings = {
          ownerId: scope.ownerId,
          operationId: issued.operationId,
          previous: options,
          projection: options,
        };
        await hooks.afterApply?.();
        check();
        return copy(data.journal.lastApply!);
      },
      async recover(_scope, wanted) {
        check();
        calls.push('recover');
        const value = data.journal?.lastApply;
        return value?.operationId === wanted.operationId &&
          value.requestFingerprint === wanted.requestFingerprint
          ? copy(value)
          : null;
      },
    },
  };
  const remote: AccountContentRemote = {
    ownerId: scope.ownerId,
    async read() {
      check();
      calls.push('remoteRead');
      await hooks.remoteRead?.();
      return copy(data.cloud);
    },
    async commit(input, signal) {
      calls.push('commit');
      submitted.push(copy(input));
      assert.equal(input.operationId, pending().operationId);
      const existing = accepted.get(input.operationId);
      if (existing) return copy(existing);
      await hooks.commit?.(signal);
      if (input.expectedRevision !== data.cloud.revision)
        throw new AccountRemoteError('needs_review');
      const receipt = {
        ownerId: scope.ownerId,
        operationId: input.operationId,
        revision: data.cloud.revision + 1,
        committedAt: timestamp,
      };
      data.cloud = {
        ...data.cloud,
        snapshot: own<AccountContentSnapshot>(input.snapshot),
        revision: receipt.revision,
        updatedAt: timestamp,
      };
      accepted.set(input.operationId, receipt);
      await hooks.afterCommit?.();
      return copy(receipt);
    },
  };
  const create = () =>
    createAccountContentCoordinator({
      scope,
      services,
      remote,
      isCurrent: () => current,
      newId: () => {
        calls.push('newId');
        return id(sequence++);
      },
      projectSettings: async (_pending, active) => {
        calls.push('project');
        assert.equal(active(), true);
        return hooks.project ? hooks.project() : true;
      },
    });
  const bootstrapServices: ContentSyncBootstrapServices<Capture, ContentSyncPushReview> = {
    scope,
    capture: services.capture,
    journal: {
      read: services.journal.read,
      reviewPush: services.journal.reviewPush,
      stageReviewedPush: services.journal.stageReviewedPush,
      async stage(_scope, input) {
        return stage(input);
      },
    },
  };
  const createBootstrap = () =>
    createAccountContentCoordinator<Capture, ContentSyncPushReview, ContentSyncApplyReview>({
      mode: 'bootstrap',
      scope,
      services: bootstrapServices,
      remote: { ownerId: remote.ownerId, read: remote.read },
      isCurrent: () => current,
      newId: () => {
        calls.push('newId');
        return id(sequence++);
      },
    });
  function cloud(value: AccountContentSnapshot) {
    data.cloud = {
      ...data.cloud,
      snapshot: copy(value),
      revision: data.cloud.revision + 1,
      updatedAt: timestamp,
    };
  }
  function edit(text: string) {
    data.local = {
      ...data.local,
      storeRevision: data.local.storeRevision + 1,
      snapshot: {
        ...data.local.snapshot,
        personal: { ...data.local.snapshot.personal, notes: [note(1, '52819', text)] },
      },
    };
  }
  return {
    data,
    calls,
    hooks,
    services,
    remote,
    submitted,
    create,
    createBootstrap,
    cloud,
    edit,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setRemoval: (value: boolean) => {
      removal = value;
    },
  };
}

test('initial bound sync retains opaque push/apply reviews and waits for confirmation', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('local private note');
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'review');
  assert.equal(f.data.journal, null);
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.calls.filter((call) => call === 'commit').length, 1);
  assert.ok(f.calls.indexOf('settingsAck') < f.calls.lastIndexOf('capture'));
  assert.equal(f.data.journal!.pending, null);
});

test('account choice stages pull with original full capture and performs no commit', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('local');
  const account = contentSnapshot();
  account.personal.notes = [note(1, '52819', 'account')];
  f.cloud(account);
  await c.sync();
  c.select('account');
  assert.equal(c.getSnapshot().kind, 'review');
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.ok(f.calls.includes('stage:pull'));
  assert.equal(f.submitted.length, 0);
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'account');
});

test('empty account replacement choice preserves local work', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('keep');
  await c.sync();
  c.select('account');
  await c.confirm();
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'keep');
  assert.equal(f.submitted.length, 1);
});

test('unknown commit outcome reopens original pending before capture and replays exact request', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('keep');
  f.hooks.afterCommit = async () => {
    throw new AccountRemoteError('unavailable');
  };
  await c.sync();
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'unavailable', pending: true });
  const pending = copy(f.data.journal!.pending);
  const count = f.calls.filter((call) => call === 'newId').length;
  await c.invalidate();
  f.calls.length = 0;
  delete f.hooks.afterCommit;
  const reopened = f.create();
  await reopened.sync();
  assert.equal(reopened.getSnapshot().kind, 'synced');
  assert.deepEqual(f.submitted[0], f.submitted[1]);
  assert.equal(f.data.journal!.lastApply!.requestFingerprint, pending!.requestFingerprint);
  assert.ok(f.calls.indexOf('reviewApply') < f.calls.indexOf('capture'));
  assert.equal(f.calls.includes('newId'), false);
  assert.equal(count, 1);
});

test('only exact transport CAS rejection discards pending', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('keep');
  await c.sync();
  f.cloud(contentSnapshot());
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'needs_review', pending: false });
  assert.equal(f.calls.filter((call) => call === 'discard').length, 1);
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'keep');
});

test('acknowledgement failure named needs_review preserves pending and retries original ID', async () => {
  const f = fixture(),
    c = f.create();
  f.hooks.ack = async () => {
    throw new AccountRemoteError('needs_review');
  };
  await c.sync();
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'needs_review', pending: true });
  assert.equal(f.calls.includes('discard'), false);
  delete f.hooks.ack;
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.deepEqual(f.submitted[0], f.submitted[1]);
});

test('acknowledged pending recovers without a second remote commit', async () => {
  const f = fixture(),
    c = f.create();
  f.setRemoval(true);
  await c.sync();
  await c.confirm({ 'removed:core': 'keep_local' });
  const state = c.getSnapshot();
  assert.equal(state.kind, 'review');
  if (state.kind === 'review') assert.equal(state.phase, 'apply');
  await c.invalidate();
  const reopened = f.create();
  await reopened.sync();
  await reopened.confirm({ 'removed:core': 'keep_local' });
  assert.equal(reopened.getSnapshot().kind, 'synced');
  assert.equal(f.submitted.length, 1);
});

test('settings projection failure leaves settlement pending and prevents fresh capture', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  f.hooks.project = async () => false;
  const count = f.calls.filter((call) => call === 'capture').length;
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'settings_changed', pending: false });
  assert.equal(f.calls.filter((call) => call === 'capture').length, count);
  assert.ok(f.data.settings);
  delete f.hooks.project;
  f.calls.length = 0;
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.ok(f.calls.indexOf('settingsAck') < f.calls.indexOf('capture'));
});

test('late local change after apply remains unsynced', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  f.hooks.afterApply = async () => {
    f.edit('late');
  };
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'local' });
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'late');
});

test('settled conflict-free changes sync automatically, scope expansion still requires review', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  await c.confirm();
  f.edit('automatic');
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.submitted.length, 2);
  f.data.local = {
    ...f.data.local,
    scope: { ...f.data.local.scope, historyIncluded: true, approvalDigest: 'b'.repeat(64) },
    snapshot: { ...f.data.local.snapshot, cookingHistory: { entries: [], removedEventIds: [] } },
  };
  await c.sync();
  const state = c.getSnapshot();
  assert.equal(state.kind, 'review');
  if (state.kind === 'review') assert.equal(state.initial, true);
  assert.equal(f.submitted.length, 2);
});

test('conflicts reissue opaque review under the original operation ID', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('base');
  await c.sync();
  await c.confirm();
  f.edit('local');
  const account = contentSnapshot();
  account.personal.notes = [note(1, '52819', 'remote')];
  f.cloud(account);
  await c.sync();
  const state = c.getSnapshot();
  assert.equal(state.kind, 'review');
  if (
    state.kind !== 'review' ||
    state.phase !== 'push' ||
    state.review.merge.status !== 'needs_review'
  )
    throw new Error('expected conflict');
  const original = state.review.operationId;
  await c.resolve(state.review.merge.conflicts[0]!.id, 'local');
  const resolved = c.getSnapshot();
  assert.equal(resolved.kind, 'review');
  if (resolved.kind === 'review' && resolved.phase === 'push') {
    assert.equal(resolved.review.operationId, original);
    assert.notEqual(resolved.review, state.review);
  }
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'local');
});

test('settled removal review never stages automatically and cancelling does not discard durable work', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  await c.confirm();
  f.edit('changed');
  f.setRemoval(true);
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'review');
  assert.equal(f.submitted.length, 1);
  c.cancelReview();
  assert.equal(f.data.journal!.pending, null);
  assert.equal(f.calls.includes('discard'), false);
  await c.sync();
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'recovery_required',
    pending: false,
  });
});

test('legacy remote is held without conversion, staging or fabricated binding', async () => {
  const f = fixture(),
    c = f.create();
  f.data.cloud = { ...f.data.cloud, snapshot: legacySnapshot(), revision: 1, updatedAt: timestamp };
  await c.sync();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'snapshot_upgrade_required',
    pending: false,
  });
  assert.equal(f.data.journal, null);
  assert.equal(f.calls.includes('reviewPush'), false);
});

test('deletion pending holds sync before staging', async () => {
  const f = fixture(),
    c = f.create();
  f.data.cloud.deletionOperationId = id(999);
  await c.sync();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'deletion_pending', pending: false });
  assert.equal(f.data.journal, null);
});

test('bound coordinator refuses a guest capture and mismatched service owner', async () => {
  const f = fixture(),
    c = f.create();
  f.data.local.fence.binding = null;
  await c.sync();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'different_data_owner',
    pending: false,
  });
  assert.equal(f.calls.includes('remoteRead'), false);
  assert.throws(
    () =>
      createAccountContentCoordinator({
        scope: { ownerId: id(999), authGeneration: 1 },
        services: f.services,
        remote: f.remote,
        isCurrent: () => true,
        newId: () => id(200),
        projectSettings: async () => true,
      }),
    { reason: 'account_changed' },
  );
});

test('retirement aborts and drains a late remote result without acknowledging or discarding it', async () => {
  const f = fixture(),
    c = f.create();
  let release!: () => void, entered!: () => void;
  let signal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hooks.commit = async (value) => {
    signal = value;
    entered();
    await blocked;
  };
  await c.sync();
  const job = c.confirm();
  await started;
  let drained = false;
  const drain = c.invalidate().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(signal?.aborted, true);
  release();
  await Promise.all([job, drain]);
  assert.ok(f.data.journal!.pending);
  assert.equal(f.calls.includes('ack'), false);
  assert.equal(f.calls.includes('discard'), false);
  delete f.hooks.commit;
  const reopened = f.create();
  await reopened.sync();
  assert.equal(reopened.getSnapshot().kind, 'synced');
  assert.deepEqual(f.submitted[0], f.submitted[1]);
});

test('late scope change during capture prevents remote access and state publication', async () => {
  const f = fixture(),
    c = f.create();
  f.hooks.capture = async () => {
    f.setCurrent(false);
  };
  await c.sync();
  assert.equal(f.calls.includes('remoteRead'), false);
  assert.equal(c.getSnapshot().kind, 'working');
});

test('history omitted by consent compares settled scope without deleting retained account history', async () => {
  const f = fixture(),
    c = f.create();
  const account = {
    ...contentSnapshot(),
    cookingHistory: { entries: [], removedEventIds: [id(44)] },
  };
  f.cloud(account);
  await c.sync();
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'synced');
  const saved = canonicalAccountContentSnapshot(f.data.cloud.snapshot);
  await c.sync();
  assert.equal(c.getSnapshot().kind, 'synced');
  assert.equal(canonicalAccountContentSnapshot(f.data.cloud.snapshot), saved);
  assert.equal(f.submitted.length, 0);
});

test('same-owner scope expansion during delayed remote read cannot inherit automatic consent', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  await c.confirm();
  f.edit('not yet uploaded');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hooks.remoteRead = async () => {
    entered();
    await blocked;
  };
  const job = c.sync();
  await started;
  f.data.local = {
    ...f.data.local,
    scope: { ...f.data.local.scope, historyIncluded: true, approvalDigest: 'b'.repeat(64) },
    snapshot: { ...f.data.local.snapshot, cookingHistory: { entries: [], removedEventIds: [] } },
  };
  release();
  await job;
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'local_changed', pending: false });
  assert.equal(f.data.journal!.pending, null);
  assert.equal(f.submitted.length, 1);
  delete f.hooks.remoteRead;
  await c.sync();
  const fresh = c.getSnapshot();
  assert.equal(fresh.kind, 'review');
  if (fresh.kind === 'review') assert.equal(fresh.initial, true);
  assert.equal(f.submitted.length, 1);
});

test('reissued conflict review cannot retain a different local capture', async () => {
  const f = fixture(),
    c = f.create();
  f.edit('base');
  await c.sync();
  await c.confirm();
  f.edit('local');
  const account = contentSnapshot();
  account.personal.notes = [note(1, '52819', 'remote')];
  f.cloud(account);
  await c.sync();
  const state = c.getSnapshot();
  if (
    state.kind !== 'review' ||
    state.phase !== 'push' ||
    state.review.merge.status !== 'needs_review'
  )
    throw new Error('expected conflict');
  const calls = f.calls.filter((value) => value === 'newId').length;
  f.hooks.afterReviewPush = async () => {
    f.edit('changed during reissue');
  };
  await c.resolve(state.review.merge.conflicts[0]!.id, 'local');
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'local_changed', pending: false });
  assert.equal(f.calls.filter((value) => value === 'newId').length, calls);
  assert.equal(f.data.journal!.pending, null);
  assert.equal(f.submitted.length, 1);
});

test('same-owner edit during final journal read cannot publish an older synced capture', async () => {
  const f = fixture(),
    c = f.create();
  await c.sync();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hooks.afterApply = async () => {
    f.hooks.journalRead = async () => {
      delete f.hooks.journalRead;
      entered();
      await blocked;
    };
  };
  const job = c.confirm();
  await started;
  f.edit('edit while checking settled journal');
  release();
  await job;
  assert.deepEqual(c.getSnapshot(), { kind: 'local' });
  assert.equal(
    f.data.local.snapshot.personal.notes[0]!.text,
    'edit while checking settled journal',
  );
});

test('bootstrap stages reviewed binding and requires bound reopen before any cloud commit or apply', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  f.edit('guest private note');
  await c.sync();
  const initial = c.getSnapshot();
  assert.equal(initial.kind, 'review');
  if (initial.kind === 'review') assert.equal(initial.initial, true);
  assert.equal(f.data.local.fence.binding, null);
  assert.equal(f.data.journal, null);
  await c.confirm();
  const pending = f.data.journal!.pending!;
  const expected = {
    kind: 'review',
    phase: 'reopen',
    initial: true,
    reason: 'binding_staged',
    operationId: pending.operationId,
    requestFingerprint: pending.requestFingerprint,
    canConfirm: false,
  };
  assert.deepEqual(c.getSnapshot(), expected);
  assert.equal(f.data.local.fence.binding, f.services.scope.ownerId);
  assert.equal(pending.acknowledgement, null);
  assert.equal(f.submitted.length, 0);
  for (const forbidden of ['settings', 'project', 'reviewApply', 'apply', 'ack', 'discard'])
    assert.equal(f.calls.includes(forbidden), false, forbidden);
  await c.confirm();
  await c.resolve('ignored', 'account');
  c.select('account');
  c.cancelReview();
  assert.deepEqual(c.getSnapshot(), expected);
  await c.invalidate();
  const bound = f.create();
  await bound.sync();
  assert.equal(bound.getSnapshot().kind, 'synced');
  assert.equal(f.submitted[0]!.operationId, pending.operationId);
  assert.equal(f.data.journal!.lastApply!.requestFingerprint, pending.requestFingerprint);
});

test('bootstrap account choice stages a null-owner pull and leaves settings for bound reopening', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  f.edit('local');
  const account = contentSnapshot();
  account.personal.notes = [note(1, '52819', 'account')];
  f.cloud(account);
  await c.sync();
  c.select('account');
  await c.confirm();
  const state = c.getSnapshot();
  assert.equal(state.kind, 'review');
  if (state.kind === 'review') assert.equal(state.phase, 'reopen');
  assert.equal(f.data.journal!.pending!.mode, 'pull');
  assert.equal(f.calls.includes('settings'), false);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'local');
  await c.invalidate();
  const bound = f.create();
  await bound.sync();
  assert.equal(bound.getSnapshot().kind, 'synced');
  assert.equal(f.data.local.snapshot.personal.notes[0]!.text, 'account');
  assert.equal(f.submitted.length, 0);
  assert.ok(f.calls.includes('settingsAck'));
});

test('lost bootstrap staging ACK requests reopen from the same stored ID without staging or sending again', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  f.hooks.afterStage = async () => {
    delete f.hooks.afterStage;
    throw new Error('lost local stage ACK');
  };
  await c.sync();
  await c.confirm();
  const saved = copy(f.data.journal!.pending!);
  const state = c.getSnapshot();
  assert.equal(state.kind, 'review');
  if (state.kind === 'review') {
    assert.equal(state.phase, 'reopen');
    if (state.phase === 'reopen') assert.equal(state.operationId, saved.operationId);
  }
  const captures = f.calls.filter((call) => call === 'capture').length,
    remoteReads = f.calls.filter((call) => call === 'remoteRead').length;
  await c.sync();
  assert.equal(f.calls.filter((call) => call === 'capture').length, captures);
  assert.equal(f.calls.filter((call) => call === 'remoteRead').length, remoteReads);
  assert.equal(f.calls.filter((call) => call.startsWith('stage:')).length, 1);
  assert.equal(f.calls.filter((call) => call === 'newId').length, 1);
  assert.equal(f.submitted.length, 0);
  assert.deepEqual(f.data.journal!.pending, saved);
});

test('lost bootstrap stage ACK cannot attribute a different pending operation to its own request', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  f.hooks.afterStage = async () => {
    f.data.journal!.pending!.operationId = id(999);
    throw new Error('lost local stage ACK');
  };
  await c.sync();
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), { kind: 'failed', reason: 'unavailable', pending: true });
  assert.equal(f.submitted.length, 0);
  assert.equal(f.calls.includes('reviewApply'), false);
});

test('cancelled bootstrap review leaves the clone unbound and performs no durable staging', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  await c.sync();
  c.cancelReview();
  assert.deepEqual(c.getSnapshot(), { kind: 'local' });
  assert.equal(f.data.local.fence.binding, null);
  assert.equal(f.data.journal, null);
  assert.equal(
    f.calls.some((call) => call.startsWith('stage:')),
    false,
  );
  assert.equal(f.submitted.length, 0);
});

test('retirement during bootstrap staging suppresses late disclosure and bound reopening retains original identity', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  f.hooks.afterStage = async () => {
    f.setCurrent(false);
  };
  await c.sync();
  await c.confirm();
  assert.equal(c.getSnapshot().kind, 'working');
  assert.ok(f.data.journal!.pending);
  const saved = copy(f.data.journal!.pending!);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.calls.includes('settings'), false);
  await c.invalidate();
  f.setCurrent(true);
  delete f.hooks.afterStage;
  const bound = f.create();
  await bound.sync();
  assert.equal(bound.getSnapshot().kind, 'synced');
  assert.equal(f.submitted[0]!.operationId, saved.operationId);
  assert.equal(f.data.journal!.lastApply!.requestFingerprint, saved.requestFingerprint);
});

test('bootstrap resolves the same issued conflict and removal choices before staging', async () => {
  const f = fixture(true),
    c = f.createBootstrap();
  f.edit('guest');
  const account = contentSnapshot();
  account.personal.notes = [note(1, '52819', 'account')];
  f.cloud(account);
  f.setRemoval(true);
  await c.sync();
  const initial = c.getSnapshot();
  if (
    initial.kind !== 'review' ||
    initial.phase !== 'push' ||
    initial.review.merge.status !== 'needs_review'
  )
    throw new Error('expected bootstrap conflict');
  const operationId = initial.review.operationId;
  await c.resolve(initial.review.merge.conflicts[0]!.id, 'local');
  await c.confirm();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'recovery_required',
    pending: false,
  });
  assert.equal(f.data.local.fence.binding, null);
  await c.confirm({ 'removed:core': 'keep_local' });
  const state = c.getSnapshot();
  if (state.kind !== 'review' || state.phase !== 'reopen')
    throw new Error('expected lifecycle handoff');
  assert.equal(state.operationId, operationId);
  assert.equal(f.data.journal!.pending!.proposed.personal.notes[0]!.text, 'guest');
  assert.equal(f.calls.filter((call) => call === 'newId').length, 1);
  assert.equal(f.submitted.length, 0);
});

test('bootstrap cannot capture an already bound store without authoritative pending staging', async () => {
  const f = fixture(),
    c = f.createBootstrap();
  await c.sync();
  assert.deepEqual(c.getSnapshot(), {
    kind: 'failed',
    reason: 'different_data_owner',
    pending: false,
  });
  assert.equal(f.calls.includes('remoteRead'), false);
  assert.equal(f.data.journal, null);
});
