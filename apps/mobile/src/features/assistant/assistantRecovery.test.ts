import type {
  AssistantActionRecovery,
  AssistantPersistencePort,
  RecoveryGate,
  RepositoryResult,
} from '@cookmate/domain';
import { AssistantRecoveryController } from './assistantRecovery';
const ready = <T>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 40 });
const proof = (id = 'old'): AssistantActionRecovery => ({
  conversationId: 'chat',
  conversationGeneration: 0,
  userIntentId: id,
  intentRevision: 2,
  phase: 'ready',
  slots: [{ slotId: 'slot', operationId: 'op', outcome: 'unresolved', receipt: null }],
});
const gate = (candidates: AssistantActionRecovery[] = []): RecoveryGate => ({
  kind: 'ready',
  token: 'instance:1',
  conversationId: 'chat',
  conversationGeneration: 0,
  candidates,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const refresh = jest
    .fn<
      ReturnType<AssistantPersistencePort['refreshRecoveryGate']>,
      Parameters<AssistantPersistencePort['refreshRecoveryGate']>
    >()
    .mockResolvedValue(ready(gate()));
  const history = jest.fn(() => {
    throw new Error('Gate must not enumerate or read historical proofs');
  });
  const persistence = {
    refreshRecoveryGate: refresh,
    readIntentPage: history,
    readActionRecovery: history,
    reconcileActionRecovery: history,
  } as unknown as AssistantPersistencePort;
  let owner: string | undefined;
  const yieldBatch = jest.fn(async () => undefined);
  const controller = new AssistantRecoveryController(persistence, () => owner, yieldBatch);
  return {
    controller,
    refresh,
    history,
    yieldBatch,
    own: (id?: string) => {
      owner = id;
      controller.ownershipChanged();
    },
  };
}

test('complete empty inventory uses one owner call on cold and unchanged repeat, without historical traversal', async () => {
  const f = fixture();
  await f.controller.check();
  expect(f.controller.admitsNewMutation).toBe(true);
  await f.controller.check();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.history).not.toHaveBeenCalled();
  expect(f.controller.state).toEqual({ kind: 'ready', proofs: {}, unresolvedIds: [] });
});
test('ordinary cold continuations yield between batches and do not consume a drift-retry budget', async () => {
  const f = fixture();
  for (let i = 1; i <= 4; i++)
    f.refresh.mockResolvedValueOnce(
      ready({
        kind: 'checking',
        token: 'instance:1',
        conversationId: 'chat',
        conversationGeneration: 0,
        continuation: `cursor${i}`,
      }),
    );
  f.yieldBatch.mockImplementation(async () => {
    expect(f.controller.state.kind).toBe('loading');
  });
  await f.controller.check();
  expect(f.refresh).toHaveBeenCalledTimes(5);
  expect(f.refresh.mock.calls.map(([arg]) => arg?.continuation)).toEqual([
    undefined,
    'cursor1',
    'cursor2',
    'cursor3',
    'cursor4',
  ]);
  expect(f.yieldBatch).toHaveBeenCalledTimes(4);
  expect(f.controller.admitsNewMutation).toBe(true);
});
test('old unresolved and partial results supplied by Data hold new mutations regardless of transcript age', async () => {
  const f = fixture();
  f.refresh.mockResolvedValue(ready(gate([proof('beyond-10000')])));
  await f.controller.check();
  expect(f.controller.state.kind === 'ready' && f.controller.state.unresolvedIds).toEqual([
    'beyond-10000',
  ]);
  expect(f.controller.admitsNewMutation).toBe(false);
  expect(f.history).not.toHaveBeenCalled();
});
test('candidate omission never supplies a fictional receipt or no-effect historical proof', async () => {
  const f = fixture();
  f.refresh.mockResolvedValueOnce(ready(gate([proof()])));
  await f.controller.check();
  await f.controller.check();
  expect(f.controller.state.kind === 'ready' && f.controller.state.proofs).toEqual({});
});
test('same-token active owner release re-evaluates the unfiltered candidate without admitting a new reservation', async () => {
  const f = fixture();
  f.own('old');
  f.refresh.mockResolvedValue(ready(gate([proof()])));
  await f.controller.check();
  expect(f.controller.state.kind === 'ready' && f.controller.state.unresolvedIds).toEqual([]);
  expect(f.controller.admitsNewMutation).toBe(false);
  f.own();
  expect(f.controller.state.kind === 'ready' && f.controller.state.unresolvedIds).toEqual(['old']);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});
test('matching unchanged certificate preserves valid checking progress without establishing ready', async () => {
  const f = fixture();
  f.refresh.mockResolvedValueOnce(
    ready({
      kind: 'checking',
      token: 'instance:1',
      conversationId: 'chat',
      conversationGeneration: 0,
      continuation: 'next',
    }),
  );
  f.yieldBatch.mockImplementation(async () => {
    expect(f.controller.certifiesUnchanged('instance:1')).toBe(true);
    expect(f.controller.admitsNewMutation).toBe(false);
  });
  await f.controller.check();
  expect(f.controller.certifiesUnchanged('instance:1')).toBe(true);
  f.controller.invalidate();
  expect(f.controller.certifiesUnchanged('instance:1')).toBe(false);
  expect(f.controller.admitsNewMutation).toBe(false);
});
test('pre-mutation invalidation rejects a late ready result and reads fresh owner proof once', async () => {
  const f = fixture();
  const pending = deferred<RepositoryResult<RecoveryGate>>();
  f.refresh.mockReturnValueOnce(pending.promise).mockResolvedValue(ready(gate([proof()])));
  const checking = f.controller.check();
  await Promise.resolve();
  f.controller.invalidate();
  pending.resolve(ready(gate()));
  await checking;
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.controller.admitsNewMutation).toBe(false);
});
test('repeated relevant drift remains held after one restart', async () => {
  const f = fixture();
  f.refresh.mockImplementation(async () => {
    f.controller.invalidate();
    return ready(gate());
  });
  await f.controller.check();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.controller.state.kind).toBe('failed');
});
test('invalidation delivered during ready publication cannot strand loading or release stale readiness', async () => {
  const f = fixture();
  let first = true;
  f.controller.subscribe(() => {
    if (first && f.controller.state.kind === 'ready') {
      first = false;
      f.controller.invalidate();
      void f.controller.check();
    }
  });
  await f.controller.check();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.controller.state.kind).toBe('ready');
});
test('storage failures and malformed complete candidates cannot become empty-ready', async () => {
  const f = fixture();
  f.refresh.mockResolvedValueOnce({
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'test.unavailable', retry: 'reconcile' },
  });
  await f.controller.check();
  expect(f.controller.state.kind).toBe('failed');
  f.refresh.mockResolvedValue(ready(gate([{ ...proof(), conversationGeneration: 99 }])));
  await f.controller.check();
  expect(f.controller.state.kind).toBe('failed');
});
test('clear discards an old continuation and uses the next generation snapshot', async () => {
  const f = fixture();
  f.refresh
    .mockResolvedValueOnce(
      ready({
        kind: 'checking',
        token: 'old',
        conversationId: 'chat',
        conversationGeneration: 0,
        continuation: 'old-cursor',
      }),
    )
    .mockResolvedValue(ready({ ...gate(), token: 'new', conversationGeneration: 1 }));
  f.yieldBatch.mockImplementation(async () => {
    f.controller.invalidate();
  });
  await f.controller.check();
  expect(f.refresh.mock.calls[1]).toEqual([undefined]);
  expect(f.controller.certifiesUnchanged('new')).toBe(true);
});

test('repeated invalidation between cold batches uses the same bounded restart limit', async () => {
  const f = fixture();
  let cursor = 0;
  f.refresh.mockImplementation(async () =>
    ready({
      kind: 'checking',
      token: 'instance:1',
      conversationId: 'chat',
      conversationGeneration: 0,
      continuation: `cursor${++cursor}`,
    }),
  );
  f.yieldBatch.mockImplementation(async () => {
    f.controller.invalidate();
  });
  await f.controller.check();
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.controller.state.kind).toBe('failed');
});
