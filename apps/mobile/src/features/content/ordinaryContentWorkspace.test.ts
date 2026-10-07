import type { ContractError, LocalCommand } from '@cookmate/contracts';
import type { DirectActionReview, Immutable } from '@cookmate/domain';
import type { ContentCookingStoreChange } from '../../data/contentCookingStore';
import type { ContentWorkspaceState } from './contentWorkspaceHost';
import {
  createOrdinaryContentWorkspace,
  type OrdinaryContentHost,
} from './ordinaryContentWorkspace';

const error: ContractError = { code: 'storage_failure', messageKey: 'fixture', retry: 'never' };
const failed = { kind: 'failed', error } as const;
const input = {
  kind: 'placeRecipe',
  recipeId: '52764',
  placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
} as const;
const review: Immutable<DirectActionReview> = {
  guard: { kind: 'none' },
  input,
  payload: {
    kind: 'addPlan',
    occurrenceId: '10000000-0000-4000-8000-000000000004',
    recipeId: input.recipeId,
    placement: input.placement,
    expectedTarget: { kind: 'empty' },
  },
  consequences: {
    kind: 'plan',
    source: null,
    destination: null,
    resultRecipeId: input.recipeId,
    resultPlacement: input.placement,
    sourceSelected: false,
    destinationSelected: false,
    resultSelected: false,
    shoppingScope: {
      scopeId: '10000000-0000-4000-8000-000000000005',
      revision: 0,
      occurrenceIds: [],
    },
  },
};
const command: Immutable<LocalCommand> = {
  schemaVersion: 2,
  operationId: '10000000-0000-4000-8000-000000000006',
  userIntentId: '10000000-0000-4000-8000-000000000007',
  intentRevision: 1,
  payloadFingerprint: 'a'.repeat(64),
  command: review.payload,
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let state: ContentWorkspaceState = {
    status: 'ready',
    scopeKey: 'opening:1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>();
  const changes = new Set<(change: ContentCookingStoreChange) => void>();
  const host = {
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    commands: {
      reviewDirect: jest.fn<
        ReturnType<OrdinaryContentHost['commands']['reviewDirect']>,
        Parameters<OrdinaryContentHost['commands']['reviewDirect']>
      >(async () => failed),
      prepareDirect: jest.fn<
        ReturnType<OrdinaryContentHost['commands']['prepareDirect']>,
        Parameters<OrdinaryContentHost['commands']['prepareDirect']>
      >(async () => failed),
      execute: jest.fn<
        ReturnType<OrdinaryContentHost['commands']['execute']>,
        Parameters<OrdinaryContentHost['commands']['execute']>
      >(async (command) => ({ ...failed, operationId: command.operationId })),
      acknowledgeDirectRecovery: jest.fn<
        ReturnType<OrdinaryContentHost['commands']['acknowledgeDirectRecovery']>,
        [string]
      >(async () => ({ kind: 'ready', value: null, revision: 0 })),
      readReceipt: jest.fn<ReturnType<OrdinaryContentHost['commands']['readReceipt']>, [string]>(
        async () => ({ kind: 'ready', value: null, revision: 0 }),
      ),
      readDirectRecovery: jest.fn<
        ReturnType<OrdinaryContentHost['commands']['readDirectRecovery']>,
        Parameters<OrdinaryContentHost['commands']['readDirectRecovery']>
      >(async () => ({
        kind: 'ready',
        value: { entries: [], nextAfterSequence: null },
        revision: 0,
      })),
    },
    queries: {
      readFavourites: jest.fn<ReturnType<OrdinaryContentHost['queries']['readFavourites']>, []>(
        async () => failed,
      ),
      readPlan: jest.fn<ReturnType<OrdinaryContentHost['queries']['readPlan']>, [string, string]>(
        async () => failed,
      ),
      readShopping: jest.fn<ReturnType<OrdinaryContentHost['queries']['readShopping']>, []>(
        async () => failed,
      ),
    },
    readerStore: {
      // The action adapter deliberately has no catalogue-reading dependency.
      content: {} as OrdinaryContentHost['readerStore']['content'],
      subscribe: (callback: (change: ContentCookingStoreChange) => void) => {
        changes.add(callback);
        return () => {
          changes.delete(callback);
        };
      },
    },
    close: jest.fn(),
  };
  return {
    host,
    listeners,
    changes,
    set(status: ContentWorkspaceState['status'], key = state.scopeKey) {
      state = { ...state, status, scopeKey: key };
      for (const callback of listeners) callback();
    },
  };
}
function ready(adapter: ReturnType<typeof createOrdinaryContentWorkspace>) {
  const value = adapter.getSnapshot();
  if (value.kind !== 'ready') throw new Error('Expected ready workspace');
  return value;
}

test('normal action ports wait for the real recovery query before allowing a review', async () => {
  const f = fixture();
  const recovery = deferred<Awaited<ReturnType<typeof f.host.commands.readDirectRecovery>>>();
  f.host.commands.readDirectRecovery.mockImplementation(() => recovery.promise);
  const adapter = createOrdinaryContentWorkspace(f.host);
  const state = ready(adapter);
  expect(state.actions.blocked).toBe(true);
  await state.actions.begin(input, { confirm: true });
  expect(f.host.commands.reviewDirect).not.toHaveBeenCalled();
  recovery.resolve({ kind: 'ready', value: { entries: [], nextAfterSequence: null }, revision: 0 });
  await settle();
  expect(ready(adapter).actions.blocked).toBe(false);
  await ready(adapter).actions.begin(input, { confirm: true });
  expect(f.host.commands.reviewDirect).toHaveBeenCalledWith(input);
  expect(ready(adapter).actionState.kind).toBe('failed');
  adapter.close();
  expect(f.host.close).not.toHaveBeenCalled();
});

test('pending recovery entries continue holding actions and acknowledgement uses the content host', async () => {
  const f = fixture();
  const operationId = '10000000-0000-4000-8000-000000000001';
  f.host.commands.readDirectRecovery.mockResolvedValueOnce({
    kind: 'ready',
    revision: 1,
    value: {
      entries: [
        {
          sequence: 1,
          operationId,
          userIntentId: '10000000-0000-4000-8000-000000000002',
          commandKind: 'addPlan',
          phase: 'cancelled',
          outcome: 'not_executed',
          receipt: null,
        },
      ],
      nextAfterSequence: null,
    },
  });
  const adapter = createOrdinaryContentWorkspace(f.host);
  await settle();
  expect(ready(adapter).actions.blocked).toBe(true);
  await ready(adapter).recovery.dismiss(operationId);
  expect(f.host.commands.acknowledgeDirectRecovery).toHaveBeenCalledWith(operationId);
  expect(ready(adapter).actions.blocked).toBe(false);
  adapter.close();
});

test('an adopted-head change retires old actions and exact query callbacks', async () => {
  const f = fixture(),
    adapter = createOrdinaryContentWorkspace(f.host);
  await settle();
  const old = ready(adapter);
  f.set('updating', 'opening:2');
  expect(adapter.getSnapshot()).toEqual({ kind: 'unavailable', status: 'updating' });
  await old.actions.begin(input);
  await expect(old.queries.readShopping()).rejects.toThrow('workspace changed');
  expect(f.host.commands.reviewDirect).not.toHaveBeenCalled();
  expect(f.host.queries.readShopping).not.toHaveBeenCalled();
  f.set('ready', 'opening:3');
  await settle();
  expect(ready(adapter).actions).not.toBe(old.actions);
  expect(ready(adapter).scopeKey).toBe('opening:3');
  await expect(old.queries.readShopping()).rejects.toThrow();
  adapter.close();
});

test('late query data from a retired owner is never delivered', async () => {
  const f = fixture();
  const read = deferred<Awaited<ReturnType<typeof f.host.queries.readPlan>>>();
  f.host.queries.readPlan.mockImplementation(() => read.promise);
  const adapter = createOrdinaryContentWorkspace(f.host);
  const pending = ready(adapter).queries.readPlan('2026-10-01', '2026-10-01');
  const rejected = expect(pending).rejects.toThrow('workspace changed');
  f.set('revoked', 'opening:2');
  read.resolve(failed);
  await rejected;
  expect(adapter.getSnapshot()).toEqual({ kind: 'unavailable', status: 'revoked' });
  adapter.close();
});

test('a late recovery result does not unlock the next opening', async () => {
  const f = fixture();
  const recovery = deferred<Awaited<ReturnType<typeof f.host.commands.readDirectRecovery>>>();
  f.host.commands.readDirectRecovery.mockImplementation(() => recovery.promise);
  const adapter = createOrdinaryContentWorkspace(f.host);
  const previous = ready(adapter);
  f.set('ready', 'opening:2');
  expect(ready(adapter).actions).not.toBe(previous.actions);
  f.host.commands.readDirectRecovery.mockResolvedValue(failed);
  recovery.resolve({ kind: 'ready', revision: 0, value: { entries: [], nextAfterSequence: null } });
  await settle();
  expect(previous.actions.externallyHeld).toBe(true);
  adapter.close();
});

test('committed changes refresh exact queries without recreating a live review controller', async () => {
  const f = fixture(),
    adapter = createOrdinaryContentWorkspace(f.host);
  await settle();
  const before = ready(adapter);
  for (const change of f.changes)
    change({ kind: 'store', value: { revision: 1, collections: ['plan'] } });
  expect(ready(adapter).refreshVersion).toBe(before.refreshVersion + 1);
  expect(ready(adapter).actions).toBe(before.actions);
  await ready(adapter).queries.readPlan('2026-10-01', '2026-10-01');
  expect(f.host.queries.readPlan).toHaveBeenCalledWith('2026-10-01', '2026-10-01');
  adapter.close();
});

test('render-level host replacement fences retained callbacks before effect cleanup', async () => {
  const f = fixture();
  let current = true;
  const adapter = createOrdinaryContentWorkspace(f.host, { isCurrent: () => current });
  await settle();
  const old = ready(adapter);
  current = false;
  await old.actions.begin(input);
  await expect(old.queries.readShopping()).rejects.toThrow();
  expect(f.host.commands.reviewDirect).not.toHaveBeenCalled();
  adapter.close();
});

test('closing detaches subscriptions, leaves host ownership intact and cannot reopen', async () => {
  const f = fixture(),
    adapter = createOrdinaryContentWorkspace(f.host);
  const old = ready(adapter);
  adapter.close();
  adapter.close();
  f.set('ready', 'opening:2');
  expect(adapter.getSnapshot()).toEqual({ kind: 'unavailable', status: 'closed' });
  expect(f.listeners.size).toBe(0);
  expect(f.changes.size).toBe(0);
  await expect(old.queries.readShopping()).rejects.toThrow();
  expect(f.host.close).not.toHaveBeenCalled();
});

test.each(['closed', 'revoked'] as const)(
  'already %s hosts do not subscribe to dead cooking services',
  (status) => {
    const f = fixture();
    f.set(status);
    f.host.readerStore.subscribe = () => {
      throw new Error('Closed store');
    };
    const adapter = createOrdinaryContentWorkspace(f.host);
    expect(adapter.getSnapshot()).toEqual({ kind: 'unavailable', status });
    adapter.close();
  },
);

test('recovery beginning during a review blocks the subsequent command preparation', async () => {
  const f = fixture(),
    adapter = createOrdinaryContentWorkspace(f.host);
  await settle();
  const held = deferred<Awaited<ReturnType<typeof f.host.commands.readDirectRecovery>>>();
  const reviewing = deferred<Awaited<ReturnType<typeof f.host.commands.reviewDirect>>>();
  f.host.commands.reviewDirect.mockImplementation(() => reviewing.promise);
  const state = ready(adapter);
  const action = state.actions.begin(input);
  f.host.commands.readDirectRecovery.mockImplementation(() => held.promise);
  const checking = state.recovery.check();
  reviewing.resolve({ kind: 'ready', value: review, revision: 0 });
  await action;
  expect(f.host.commands.prepareDirect).not.toHaveBeenCalled();
  expect(f.host.commands.execute).not.toHaveBeenCalled();
  held.resolve(failed);
  await checking;
  adapter.close();
});

test('recovery beginning during preparation blocks execution of the already registered command', async () => {
  const f = fixture(),
    adapter = createOrdinaryContentWorkspace(f.host);
  await settle();
  f.host.commands.reviewDirect.mockResolvedValue({ kind: 'ready', value: review, revision: 0 });
  const preparing = deferred<Awaited<ReturnType<typeof f.host.commands.prepareDirect>>>();
  f.host.commands.prepareDirect.mockImplementation(() => preparing.promise);
  const state = ready(adapter);
  const action = state.actions.begin(input);
  await settle();
  expect(f.host.commands.prepareDirect).toHaveBeenCalledTimes(1);
  const held = deferred<Awaited<ReturnType<typeof f.host.commands.readDirectRecovery>>>();
  f.host.commands.readDirectRecovery.mockImplementation(() => held.promise);
  const checking = state.recovery.check();
  preparing.resolve({ kind: 'ready', value: command, revision: 1 });
  await action;
  expect(f.host.commands.execute).not.toHaveBeenCalled();
  expect(ready(adapter).actionState.kind).toBe('uncertain');
  held.resolve(failed);
  await checking;
  adapter.close();
});
