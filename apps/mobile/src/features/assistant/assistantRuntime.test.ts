import type { AssistantTurnRequest, CommandResult, ContractError } from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  ConversationHeader,
  ConversationPage,
  CookMateServices,
  RepositoryResult,
  StoredConversationMessage,
  StoredAssistantIntent,
  StoreChange,
  RecoveryGate,
  AssistantActionContinuationReview,
} from '@cookmate/domain';
import type { ConnectionState, GatewayConnection } from '../../connection';
import type { ActionContinuationOutcome, TurnOutcome } from '../../assistant-core';
import { AssistantRuntime, type AssistantCoordinator } from './assistantRuntime';
import { AiConsentController } from './aiConsent';
import { API_VERSION, type ProposalResponse } from '@cookmate/contracts';
import { identity } from '@cookmate/catalogue';

// A synthetic received reply. No node-only hash helper or provider is needed for runtime tests.
function fixtureResponse(): ProposalResponse {
  return {
    apiVersion: API_VERSION,
    catalogue: identity,
    requestId: '00000000-0000-4000-8000-000000000001',
    userIntentId: '00000000-0000-4000-8000-000000000002',
    intentRevision: 1,
    conversationId: '00000000-0000-4000-8000-000000000003',
    conversationGeneration: 0,
    connectionGeneration: 1,
    preferenceRevision: 0,
    kind: 'proposal',
    text: 'Would you like to save this recipe?',
    sources: [{ recipeId: '53262', section: 'recipe' }],
    referenceSets: [],
    proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
    memoryUpdate: {
      baseRevision: 0,
      baseContextRevision: 0,
      reviews: [
        { sourceMessageId: '00000000-0000-4000-8000-000000000004', disposition: 'non_memory' },
      ],
      entries: [],
    },
  };
}

test('AI permission gates send and provider retry without changing the retained draft or sending on agreement', async () => {
  let stored: string | null = null;
  const consent = new AiConsentController({
    read: async () => stored,
    write: async (value) => {
      stored = value;
    },
  });
  const f = fixture(consent);
  await f.runtime.reload();
  await f.runtime.restoreConnection();
  const draft = f.runtime.state.draft;
  await f.runtime.send({});
  await f.runtime.retryTurn('old-intent');
  expect(f.send).not.toHaveBeenCalled();
  expect(f.core.retryTurn).not.toHaveBeenCalled();
  expect(f.runtime.state.draft).toBe(draft);
  await consent.decide(true);
  expect(f.send).not.toHaveBeenCalled();
  await f.runtime.send({});
  expect(f.send).toHaveBeenCalledWith(draft, {});
  await f.runtime.dispose();
});

test.each([false, true])(
  'withdrawal while draft persistence is pending prevents queued transmission even after regrant=%s',
  async (regrant) => {
    let stored: string | null = null;
    const consent = new AiConsentController({
      read: async () => stored,
      write: async (value) => {
        stored = value;
      },
    });
    const f = fixture(consent);
    await f.runtime.reload();
    await f.runtime.restoreConnection();
    await consent.decide(true);
    const saving = deferred<RepositoryResult<ConversationHeader>>();
    f.saveDraft.mockReturnValueOnce(saving.promise);
    f.runtime.setDraft('Keep this local');
    await tick();
    const sending = f.runtime.send({});
    await consent.decide(false);
    if (regrant) await consent.decide(true);
    f.header.composerDraft = 'Keep this local';
    saving.resolve(ready({ ...f.header, composerDraft: 'Keep this local' }));
    await sending;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.runtime.state.draft).toBe('Keep this local');
    expect(f.runtime.state.composerPaused).toBe(false);
    await f.runtime.dispose();
  },
);

test('withdrawing AI sharing invalidates outstanding transmission while local acceptance retry remains available', async () => {
  let stored: string | null = null;
  const consent = new AiConsentController({
    read: async () => stored,
    write: async (value) => {
      stored = value;
    },
  });
  const f = fixture(consent);
  await f.runtime.reload();
  await f.runtime.restoreConnection();
  await consent.decide(true);
  const response = fixtureResponse();
  f.runtime.state.outcome = {
    kind: 'failed',
    error: failed,
    acceptanceRetry: { userIntentId: 'received-answer', response },
  };
  const invalidations = jest.mocked(f.core.invalidate).mock.calls.length;
  const withdrawing = consent.decide(false);
  expect(f.core.invalidate).toHaveBeenCalledTimes(invalidations);
  await withdrawing;
  expect(f.runtime.state.aiConsent?.status).toBe('declined');
  await f.runtime.retryTurn('old-intent');
  expect(f.core.retryTurn).not.toHaveBeenCalled();
  expect(f.runtime.state.draft).toBe('Retained draft');
  await f.runtime.retryAcceptance();
  expect(f.core.retryAcceptance).toHaveBeenCalledWith('received-answer', response);
  expect(f.send).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test('withdrawing during a provider turn stops external waiting without discarding its received-answer recovery', async () => {
  let stored: string | null = null;
  const consent = new AiConsentController({
    read: async () => stored,
    write: async (value) => {
      stored = value;
    },
  });
  const f = fixture(consent);
  await f.runtime.reload();
  await f.runtime.restoreConnection();
  await consent.decide(true);
  const waiting = deferred<TurnOutcome>();
  f.send.mockReturnValueOnce(waiting.promise);
  const sending = f.runtime.send({});
  await tick();
  const invalidations = jest.mocked(f.core.invalidate).mock.calls.length;
  await consent.decide(false);
  expect(f.core.invalidate).toHaveBeenCalledTimes(invalidations + 1);
  const response = fixtureResponse();
  waiting.resolve({
    kind: 'failed',
    error: failed,
    acceptanceRetry: { userIntentId: 'already-received', response },
  });
  await sending;
  await f.runtime.retryAcceptance();
  expect(f.core.retryAcceptance).toHaveBeenCalledWith('already-received', response);
  expect(f.send).toHaveBeenCalledTimes(1);
  await f.runtime.dispose();
});

const ready = <T>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 0 });
const failed: ContractError = {
  code: 'storage_failure',
  messageKey: 'test.storage',
  retry: 'after_correction',
};
const failure: TurnOutcome = {
  kind: 'failed',
  error: { code: 'network_unavailable', messageKey: 'test.offline', retry: 'after_reconnect' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Isolated port doubles prove UI sequencing only; no database/provider acceptance is implied. */
function fixture(consent?: AiConsentController) {
  let storeRevision = 0;
  const snapshot = <T>(value: T): RepositoryResult<T> => ({
    kind: 'ready',
    value,
    revision: storeRevision,
  });
  const header: ConversationHeader = {
    conversationId: 'conversation',
    generation: 0,
    revision: 0,
    composerDraft: 'Retained draft',
    nextSequence: 1,
  };
  let messages: StoredConversationMessage[] = [];
  const page = (): ConversationPage => ({
    header: { ...header },
    messages: [...messages],
    beforeSequence: null,
    hasEarlier: false,
  });
  const readConversation = jest.fn(async () => snapshot(page()));
  const readIntentPage = jest.fn(async () =>
    snapshot({ header: { ...header }, items: [], beforeSequence: null, hasEarlier: false }),
  );
  const refreshRecoveryGate = jest
    .fn<
      ReturnType<AssistantPersistencePort['refreshRecoveryGate']>,
      Parameters<AssistantPersistencePort['refreshRecoveryGate']>
    >()
    .mockImplementation(async () =>
      ready({
        kind: 'ready',
        token: 'test-token',
        conversationId: header.conversationId,
        conversationGeneration: header.generation,
        candidates: [],
      }),
    );
  const saveDraft = jest.fn(async (_guard: unknown, text: string) => {
    header.composerDraft = text;
    return ready({ ...header });
  });
  const persistence = {
    readConversation,
    readIntentPage,
    saveDraft,
    refreshRecoveryGate,
    readActionRecovery: jest.fn(async () => ready(null)),
    reconcileActionRecovery: jest.fn(async () => ready(null)),
    readIntent: jest.fn(async () => ready(null)),
  } as unknown as AssistantPersistencePort;
  const send = jest.fn(async (): Promise<TurnOutcome> => failure);
  const core = {
    send,
    retryTurn: jest.fn(async () => failure),
    retryAcceptance: jest.fn(async () => failure),
    invalidate: jest.fn(),
    cancel: jest.fn(async () => undefined),
    dispatch: jest.fn(),
    reconcile: jest.fn(),
    readActionContinuationReview: jest.fn(async () => null),
    invalidateActionContinuationReview: jest.fn(),
    confirmActionContinuation: jest.fn(),
  } as unknown as AssistantCoordinator;
  const connectionState = {
    status: 'paired' as const,
    generation: 1,
    endpoint: 'https://private.example',
  };
  const connection = {
    getState: (): Readonly<ConnectionState> => connectionState,
    restore: jest.fn(async () => connectionState),
    health: jest.fn(async () => undefined),
    pair: jest.fn(async () => connectionState),
    forget: jest.fn(async () => undefined),
    revokeAndForget: jest.fn(async () => ({ localForgotten: true as const, serverRevoked: false })),
    cancel: jest.fn(),
    turn: jest.fn(),
  } satisfies GatewayConnection;
  const readInstallationId = jest.fn(
    async (): Promise<RepositoryResult<string>> => ready('real-installation-marker'),
  );
  let changed: ((change: StoreChange) => void) | undefined;
  let invalidated: (() => void) | undefined;
  const subscribe = jest.fn((listener: (change: StoreChange) => void) => {
    changed = listener;
    return () => {
      changed = undefined;
    };
  });
  const subscribeRecoveryInvalidation = jest.fn((listener: () => void) => {
    invalidated = listener;
    return () => {
      invalidated = undefined;
    };
  });
  const services = {
    queries: { readInstallationId, subscribe, subscribeRecoveryInvalidation },
  } as unknown as CookMateServices;
  const runtime = new AssistantRuntime(persistence, core, connection, services, consent);
  return {
    runtime,
    header,
    readConversation,
    readIntentPage,
    refreshRecoveryGate,
    notify: (change: StoreChange) => {
      storeRevision = Math.max(storeRevision, change.revision);
      changed?.(change);
    },
    invalidateRecovery: () => invalidated?.(),
    saveDraft,
    send,
    core,
    connection,
    readInstallationId,
    setMessages: (value: StoredConversationMessage[]) => {
      messages = value;
    },
  };
}

function continuationReview(
  userIntentId = 'continuing',
  commandState: AssistantActionContinuationReview['slot']['commandState'] = 'frozen',
): AssistantActionContinuationReview {
  return {
    reviewToken: `review-${userIntentId}`,
    cursor: 1,
    slot: {
      slotId: 'next-slot',
      commandState,
      command: {
        schemaVersion: 2,
        operationId: 'next-operation',
        userIntentId,
        intentRevision: 2,
        payloadFingerprint: 'a'.repeat(64),
        command: {
          kind: 'addPlan',
          occurrenceId: 'meal',
          recipeId: '52839',
          placement: { actualDate: '2026-10-07', mealKey: 'lunch' },
          expectedTarget: { kind: 'empty' },
        },
      },
    },
    prefixReceipts: [],
    state: {
      guards: {
        conversationId: 'conversation',
        conversationGeneration: 0,
        contextRevision: 0,
        connectionGeneration: 1,
        preferenceRevision: 0,
        relativeDateContext: {
          localDate: '2026-09-28',
          timeZone: 'Asia/Dubai',
          utcOffsetMinutes: 240,
        },
      },
      planOccurrences: [],
      shoppingScope: { scopeId: 'scope', revision: 0, occurrenceIds: [] },
    },
    catalogue: { version: 'test', fingerprint: 'b'.repeat(64) },
  };
}

async function continuationFixture(
  commandState: AssistantActionContinuationReview['slot']['commandState'] = 'frozen',
) {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  const review = continuationReview('continuing', commandState);
  jest.mocked(f.core.readActionContinuationReview).mockResolvedValue(review);
  const result: ActionContinuationOutcome = {
    command: review.slot.command,
    result: {
      kind: 'receipt',
      receipt: {
        schemaVersion: 1,
        operationId: review.slot.command.operationId,
        userIntentId: review.slot.command.userIntentId,
        payloadFingerprint: review.slot.command.payloadFingerprint,
        outcome: 'committed',
        committedAt: '2026-09-28T00:00:00.000Z',
        effects: [],
        shoppingProjection: 'unchanged',
      },
    },
    actionOutcome: null,
    recoveryError: failed,
  };
  jest.mocked(f.core.confirmActionContinuation).mockResolvedValue(result);
  return { ...f, review, result };
}

async function loadedContinuationFixture(
  commandState: AssistantActionContinuationReview['slot']['commandState'] = 'frozen',
) {
  const f = await continuationFixture(commandState);
  const revision = 2;
  let saved = false;
  jest.mocked(f.runtime.persistence.readIntentPage).mockImplementation(async () =>
    ready({
      header: { ...f.header },
      items: [
        {
          userIntentId: 'continuing',
          revision,
          phase: 'reconciling',
          userMessageId: 'u',
          assistantMessageId: 'a',
          sourceSequence: 1,
          hasActionPlan: true,
        },
      ],
      beforeSequence: null,
      hasEarlier: false,
    }),
  );
  jest.mocked(f.runtime.persistence.readIntent).mockImplementation(async () =>
    ready({
      request: {
        conversationId: 'conversation',
        conversationGeneration: 0,
        message: { messageId: 'u', sourceSequence: 1 },
      },
      intent: {
        userIntentId: 'continuing',
        revision,
        phase: 'reconciling',
        slots:
          commandState === 'frozen' || saved
            ? [{ slotId: 'next-slot', command: f.review.slot.command }]
            : [],
      },
      actionPlan: {
        slots: [
          {
            slotId: 'next-slot',
            operationId: 'next-operation',
            payload: f.review.slot.command.command,
          },
        ],
      },
      slotResults: saved ? [{ slotId: 'next-slot', result: f.result.result }] : [],
    } as unknown as StoredAssistantIntent),
  );
  const proof = () =>
    ready({
      conversationId: 'conversation',
      conversationGeneration: 0,
      userIntentId: 'continuing',
      intentRevision: revision,
      phase: 'reconciling' as const,
      slots: [
        {
          slotId: 'next-slot',
          operationId: 'next-operation',
          outcome: saved ? ('receipt' as const) : ('not_executed' as const),
          receipt: saved && f.result.result.kind === 'receipt' ? f.result.result.receipt : null,
        },
      ],
    });
  jest.mocked(f.runtime.persistence.readActionRecovery).mockImplementation(async () => proof());
  await f.runtime.reload();
  return {
    ...f,
    proof,
    markSaved: () => {
      saved = true;
    },
  };
}

test.each(['frozen', 'prospective'] as const)(
  '%s confirmation keeps the next review reserved through gate, reload and final proof refresh',
  async (commandState) => {
    const f = await loadedContinuationFixture(commandState);
    await f.runtime.reviewContinuation('continuing', 2);
    const gateStarted = deferred<void>();
    const gate = deferred<RepositoryResult<RecoveryGate>>();
    const reloadStarted = deferred<void>();
    const reloading = deferred<RepositoryResult<ConversationPage>>();
    const proofStarted = deferred<void>();
    const proving = deferred<Awaited<ReturnType<AssistantPersistencePort['readActionRecovery']>>>();
    jest.mocked(f.core.confirmActionContinuation).mockImplementation(async () => {
      f.markSaved();
      f.refreshRecoveryGate.mockImplementationOnce(() => {
        gateStarted.resolve();
        return gate.promise;
      });
      f.readConversation.mockImplementationOnce(() => {
        reloadStarted.resolve();
        return reloading.promise;
      });
      jest
        .mocked(f.runtime.persistence.readActionRecovery)
        .mockResolvedValueOnce(f.proof())
        .mockImplementationOnce(() => {
          proofStarted.resolve();
          return proving.promise;
        });
      return f.result;
    });
    const confirming = f.runtime.confirmContinuation(f.review);
    for (const stage of ['gate', 'reload', 'proof'] as const) {
      await (stage === 'gate' ? gateStarted : stage === 'reload' ? reloadStarted : proofStarted)
        .promise;
      expect(f.runtime.state).toMatchObject({
        busy: true,
        mutating: false,
        activeIntentId: 'continuing',
      });
      expect(f.runtime.state.conversation?.intents.continuing?.slotResults).toHaveLength(
        stage === 'proof' ? 1 : 0,
      );
      await f.runtime.reviewContinuation('continuing', 2);
      expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(1);
      if (stage === 'gate')
        gate.resolve(
          ready({
            kind: 'ready',
            token: 'after-action',
            conversationId: 'conversation',
            conversationGeneration: 0,
            candidates: [],
          }),
        );
      if (stage === 'reload')
        reloading.resolve(
          ready({ header: { ...f.header }, messages: [], beforeSequence: null, hasEarlier: false }),
        );
      if (stage === 'proof') proving.resolve(f.proof());
    }
    await confirming;
    expect(f.runtime.state.busy).toBe(false);
    expect(f.runtime.state.activeIntentId).toBeUndefined();
    expect(f.runtime.state.conversation?.intents.continuing?.intent.revision).toBe(2);
    expect(f.runtime.state.conversation?.intents.continuing?.intent.slots).toEqual([
      { slotId: 'next-slot', command: f.review.slot.command },
    ]);
    expect(f.runtime.state.historyProofs?.continuing?.slots[0]?.outcome).toBe('receipt');
    expect(jest.mocked(f.core.confirmActionContinuation).mock.calls[0]?.[0].review).toBe(f.review);
    expect(f.core.invalidateActionContinuationReview).not.toHaveBeenCalled();
    expect(f.core.dispatch).not.toHaveBeenCalled();
    await f.runtime.reviewContinuation('continuing', 2);
    expect(f.core.readActionContinuationReview).toHaveBeenLastCalledWith({
      userIntentId: 'continuing',
      expectedIntentRevision: 2,
    });
    await f.runtime.dispose();
  },
);

test.each([
  { fence: 'intent page', dispose: false },
  { fence: 'latest header', dispose: false },
  { fence: 'intent page', dispose: true },
] as const)(
  'postflight $fence drift keeps the replacement read reserved (dispose=$dispose)',
  async ({ fence, dispose }) => {
    const f = await loadedContinuationFixture('prospective');
    await f.runtime.reviewContinuation('continuing', 2);
    const replacementStarted = deferred<void>();
    const replacement = deferred<RepositoryResult<ConversationPage>>();
    const page = () =>
      ready({ header: { ...f.header }, messages: [], beforeSequence: null, hasEarlier: false });
    jest.mocked(f.core.confirmActionContinuation).mockImplementation(async () => {
      f.markSaved();
      f.readConversation.mockResolvedValueOnce(page());
      if (fence === 'intent page') {
        jest.mocked(f.runtime.persistence.readIntentPage).mockResolvedValueOnce(
          ready({
            header: { ...f.header, revision: 99 },
            items: [],
            beforeSequence: null,
            hasEarlier: false,
          }),
        );
      } else {
        f.readConversation.mockResolvedValueOnce(
          ready({
            header: { ...f.header, nextSequence: 99 },
            messages: [],
            beforeSequence: null,
            hasEarlier: false,
          }),
        );
      }
      f.readConversation.mockImplementationOnce(() => {
        replacementStarted.resolve();
        return replacement.promise;
      });
      return f.result;
    });
    const confirming = f.runtime.confirmContinuation(f.review);
    await replacementStarted.promise;
    expect(f.runtime.state.busy).toBe(true);
    expect(f.runtime.state.conversation?.intents.continuing?.slotResults).toHaveLength(0);
    await f.runtime.reviewContinuation('continuing', 2);
    expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(1);
    if (dispose) {
      const disposing = f.runtime.dispose();
      await tick();
      const snapshot = f.runtime.state;
      const proofCalls = jest.mocked(f.runtime.persistence.readActionRecovery).mock.calls.length;
      replacement.resolve(page());
      await Promise.all([confirming, disposing]);
      expect(f.runtime.state).toBe(snapshot);
      expect(f.runtime.persistence.readActionRecovery).toHaveBeenCalledTimes(proofCalls);
    } else {
      replacement.resolve(page());
      await confirming;
      expect(f.runtime.state.busy).toBe(false);
      expect(f.runtime.state.readError).toBeUndefined();
      expect(f.runtime.state.conversation?.intents.continuing?.intent.revision).toBe(2);
      expect(f.runtime.state.conversation?.intents.continuing?.slotResults).toHaveLength(1);
      expect(f.runtime.state.historyProofs?.continuing?.slots[0]?.outcome).toBe('receipt');
      await f.runtime.reviewContinuation('continuing', 2);
      expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(2);
      await f.runtime.dispose();
    }
  },
);

test('exhausted postflight drift retires its retry chain and explicit reconciliation can recover', async () => {
  const f = await loadedContinuationFixture('prospective');
  await f.runtime.reviewContinuation('continuing', 2);
  const readIntents = jest.mocked(f.runtime.persistence.readIntentPage);
  const originalReadIntents = readIntents.getMockImplementation()!;
  jest.mocked(f.core.confirmActionContinuation).mockImplementation(async () => {
    f.markSaved();
    readIntents.mockResolvedValue(
      ready({
        header: { ...f.header, revision: 99 },
        items: [],
        beforeSequence: null,
        hasEarlier: false,
      }),
    );
    return f.result;
  });
  f.readConversation.mockClear();
  await f.runtime.confirmContinuation(f.review);
  expect(f.runtime.state.busy).toBe(false);
  expect(f.runtime.state.readError?.code).toBe('stale_context');
  expect(f.runtime.state.continuationOutcomes?.continuing).toEqual(f.result);
  expect(f.runtime.state.conversation?.intents.continuing?.slotResults).toHaveLength(0);
  expect(f.readConversation).toHaveBeenCalledTimes(2);
  await tick();
  expect(f.readConversation).toHaveBeenCalledTimes(2);
  await f.runtime.reviewContinuation('continuing', 2);
  const mutation = jest.fn();
  await f.runtime.runAction('continuing', mutation, true);
  expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(1);
  expect(mutation).not.toHaveBeenCalled();
  expect(f.runtime.state.readError?.code).toBe('stale_context');

  readIntents.mockImplementation(originalReadIntents);
  await f.runtime.runAction('continuing', () => f.core.reconcile('continuing'));
  expect(f.core.reconcile).toHaveBeenCalledTimes(1);
  expect(f.runtime.state.readError).toBeUndefined();
  expect(f.runtime.state.conversation?.intents.continuing?.slotResults).toHaveLength(1);
  await f.runtime.reviewContinuation('continuing', 2);
  expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(2);
  expect(f.core.confirmActionContinuation).toHaveBeenCalledTimes(1);
  expect(f.core.dispatch).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test.each(['gate', 'reload', 'proof'] as const)(
  'a failed post-action %s read releases the reservation and keeps the real attempt',
  async (stage) => {
    const f = await loadedContinuationFixture('prospective');
    await f.runtime.reviewContinuation('continuing', 2);
    jest.mocked(f.core.confirmActionContinuation).mockImplementation(async () => {
      if (stage === 'gate')
        f.refreshRecoveryGate.mockResolvedValueOnce({ kind: 'failed', error: failed });
      if (stage === 'reload')
        f.readConversation.mockRejectedValueOnce(new Error('unreadable page'));
      if (stage === 'proof')
        jest
          .mocked(f.runtime.persistence.readActionRecovery)
          .mockRejectedValueOnce(new Error('unreadable proof'));
      return f.result;
    });
    await f.runtime.confirmContinuation(f.review);
    expect(f.runtime.state.busy).toBe(false);
    expect(f.runtime.state.activeIntentId).toBeUndefined();
    expect(f.runtime.state.continuationOutcomes?.continuing).toEqual(f.result);
    if (stage === 'gate') expect(f.runtime.state.recovery.kind).toBe('failed');
    if (stage === 'reload') expect(f.runtime.state.readError?.code).toBe('storage_failure');
    if (stage === 'proof')
      expect(f.runtime.state.historyProofErrors?.continuing?.code).toBe('storage_failure');
    await f.runtime.reviewContinuation('continuing', 2);
    if (stage === 'reload') {
      expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(1);
      await f.runtime.reload();
      await f.runtime.reviewContinuation('continuing', 2);
    }
    expect(f.core.readActionContinuationReview).toHaveBeenCalledTimes(2);
    await f.runtime.dispose();
  },
);

test('unexpected post-action rejection still releases busy through the finalizer', async () => {
  const f = await continuationFixture();
  const error = new Error('Unexpected postflight failure');
  jest.spyOn(f.runtime.recovery, 'check').mockRejectedValueOnce(error);
  await expect(f.runtime.runAction('continuing', async () => null)).rejects.toBe(error);
  expect(f.runtime.state.busy).toBe(false);
  expect(f.runtime.state.activeIntentId).toBeUndefined();
  await f.runtime.dispose();
});

test('disposal during an action skips later refreshes and publishes no late state', async () => {
  const f = await continuationFixture('prospective');
  await f.runtime.reviewContinuation('continuing', 2);
  const started = deferred<void>();
  const pending = deferred<ActionContinuationOutcome>();
  jest.mocked(f.core.confirmActionContinuation).mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const confirming = f.runtime.confirmContinuation(f.review);
  await started.promise;
  await f.runtime.dispose();
  const snapshot = f.runtime.state;
  f.readConversation.mockClear();
  f.refreshRecoveryGate.mockClear();
  pending.resolve(f.result);
  await confirming;
  expect(f.runtime.state).toBe(snapshot);
  expect(f.readConversation).not.toHaveBeenCalled();
  expect(f.refreshRecoveryGate).not.toHaveBeenCalled();
});

test('background refreshes stay pure and explicit saved-results checking only calls Core reconciliation', async () => {
  const f = await loadedContinuationFixture();
  await f.runtime.refreshForForeground();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  expect(f.runtime.persistence.readActionRecovery).toHaveBeenCalled();
  expect(f.runtime.persistence.reconcileActionRecovery).not.toHaveBeenCalled();
  expect(f.core.reconcile).not.toHaveBeenCalled();
  await f.runtime.runAction('continuing', () => f.core.reconcile('continuing'));
  expect(f.core.reconcile).toHaveBeenCalledTimes(1);
  expect(f.runtime.persistence.reconcileActionRecovery).not.toHaveBeenCalled();
  expect(f.core.dispatch).not.toHaveBeenCalled();
  expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test('continuation review is read-only and remains available while recovery holds mutations', async () => {
  const f = await continuationFixture();
  f.runtime.recovery.invalidate();
  await f.runtime.reviewContinuation('continuing', 2);
  expect(f.core.readActionContinuationReview).toHaveBeenCalledWith({
    userIntentId: 'continuing',
    expectedIntentRevision: 2,
  });
  expect(f.runtime.state.continuationReview).toMatchObject({ kind: 'ready', review: f.review });
  expect(f.runtime.mutationsHeld).toBe(true);
  expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
  expect(f.core.dispatch).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test.each(['null', 'failure'] as const)(
  'a %s review never becomes completion or confirmation',
  async (kind) => {
    const f = await continuationFixture();
    if (kind === 'null') jest.mocked(f.core.readActionContinuationReview).mockResolvedValue(null);
    else
      jest.mocked(f.core.readActionContinuationReview).mockRejectedValue(new Error('unreadable'));
    await f.runtime.reviewContinuation('continuing', 2);
    expect(f.runtime.state.continuationReview?.kind).toBe(
      kind === 'null' ? 'unavailable' : 'failed',
    );
    await f.runtime.confirmContinuation(f.review);
    expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
    expect(f.runtime.state.continuationOutcomes?.continuing).toBeUndefined();
    expect(f.runtime.state.actionOutcomes).toEqual({});
    await f.runtime.dispose();
  },
);

test.each(['dismiss', 'clear', 'cancel', 'context', 'connection', 'dispose'] as const)(
  '%s suppresses a delayed continuation review',
  async (reason) => {
    const f = await continuationFixture();
    const pending = deferred<AssistantActionContinuationReview>();
    jest.mocked(f.core.readActionContinuationReview).mockReturnValue(pending.promise);
    const reading = f.runtime.reviewContinuation('continuing', 2);
    const requestId = f.runtime.state.continuationReview!.requestId;
    let cancelling: Promise<void> | undefined;
    if (reason === 'dismiss') {
      f.runtime.dismissContinuationReview(requestId);
      expect(f.core.invalidateActionContinuationReview).toHaveBeenCalledTimes(1);
    } else if (reason === 'cancel') cancelling = f.runtime.cancel();
    else if (reason === 'context') f.runtime.workingContextChanged();
    else if (reason === 'dispose') await f.runtime.dispose();
    else f.runtime.invalidate();
    pending.resolve(f.review);
    await reading;
    await cancelling;
    expect(f.runtime.state.continuationReview?.kind).not.toBe('ready');
    expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
    if (reason !== 'dispose') await f.runtime.dispose();
  },
);

test('a retired row ticket cannot dismiss a later review', async () => {
  const f = await continuationFixture();
  await f.runtime.reviewContinuation('continuing', 2);
  const oldRequest = f.runtime.state.continuationReview!.requestId;
  f.runtime.dismissContinuationReview(oldRequest);
  const next = continuationReview('second');
  jest.mocked(f.core.readActionContinuationReview).mockResolvedValue(next);
  await f.runtime.reviewContinuation('second', 2);
  jest.mocked(f.core.invalidateActionContinuationReview).mockClear();
  f.runtime.dismissContinuationReview(oldRequest);
  expect(f.runtime.state.continuationReview).toMatchObject({
    kind: 'ready',
    userIntentId: 'second',
  });
  expect(f.core.invalidateActionContinuationReview).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test('confirmation claims one exact review without modal dismissal revocation or invented aggregate', async () => {
  const f = await continuationFixture();
  await f.runtime.reviewContinuation('continuing', 2);
  const requestId = f.runtime.state.continuationReview!.requestId;
  const confirming = f.runtime.confirmContinuation(f.review);
  expect(f.runtime.state.continuationReview).toBeUndefined();
  expect(f.runtime.state.busy).toBe(true);
  f.runtime.dismissContinuationReview(requestId);
  await f.runtime.confirmContinuation(f.review);
  await confirming;
  expect(f.core.confirmActionContinuation).toHaveBeenCalledTimes(1);
  expect(f.core.confirmActionContinuation).toHaveBeenCalledWith({
    source: 'explicit_user',
    review: f.review,
  });
  expect(f.core.invalidateActionContinuationReview).not.toHaveBeenCalled();
  expect(f.core.dispatch).not.toHaveBeenCalled();
  expect(f.runtime.state.continuationOutcomes?.continuing).toEqual(f.result);
  expect(f.runtime.state.actionOutcomes).toEqual({});
  expect(f.runtime.state.continuationReview).toBeUndefined();
  await f.runtime.dispose();
});

test('a copied or obsolete review cannot replace the exact displayed confirmation', async () => {
  const f = await continuationFixture();
  await f.runtime.reviewContinuation('continuing', 2);
  await f.runtime.confirmContinuation({ ...f.review });
  expect(f.runtime.state.continuationReview).toMatchObject({ kind: 'ready', review: f.review });
  expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test.each(['clear', 'cancel'] as const)(
  '%s during continuation preflight prevents core admission',
  async (reason) => {
    const f = await continuationFixture();
    await f.runtime.reviewContinuation('continuing', 2);
    const auditing = deferred<RepositoryResult<RecoveryGate>>();
    const auditStarted = deferred<void>();
    f.refreshRecoveryGate.mockImplementationOnce(() => {
      auditStarted.resolve();
      return auditing.promise;
    });
    const confirming = f.runtime.confirmContinuation(f.review);
    await auditStarted.promise;
    let cancelling: Promise<void> | undefined;
    if (reason === 'clear') f.runtime.invalidate();
    else cancelling = f.runtime.cancel();
    auditing.resolve(
      ready({
        kind: 'ready',
        token: 'old',
        conversationId: 'conversation',
        conversationGeneration: 0,
        candidates: [],
      }),
    );
    await confirming;
    await cancelling;
    expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
    expect(f.runtime.state.continuationOutcomes?.continuing).toBeUndefined();
    expect(f.runtime.state.busy).toBe(false);
    await f.runtime.dispose();
  },
);

test('a later reconciliation replaces current uncertainty without changing the original attempt', async () => {
  const f = await continuationFixture();
  const aggregate = {
    summary: 'complete' as const,
    results: {
      userIntentId: 'continuing',
      slots: [{ slotId: 'next-slot', result: f.result.result }] as [
        { slotId: string; result: CommandResult },
      ],
    },
  };
  f.runtime.state = { ...f.runtime.state, actionOutcomes: { continuing: aggregate } };
  await f.runtime.reviewContinuation('continuing', 2);
  await f.runtime.confirmContinuation(f.review);
  expect(f.runtime.state.actionOutcomes.continuing).toBeUndefined();
  expect(f.runtime.state.continuationOutcomes?.continuing).toEqual(f.result);
  jest.mocked(f.core.reconcile).mockResolvedValue(aggregate);
  await f.runtime.runAction('continuing', () => f.core.reconcile('continuing'));
  expect(f.runtime.state.actionOutcomes.continuing).toEqual(aggregate);
  expect(f.runtime.state.continuationOutcomes?.continuing).toEqual(f.result);
  await f.runtime.dispose();
});

test('ordinary executor recovery invalidation does not revoke a valid confirmation handoff', async () => {
  const f = await continuationFixture();
  f.runtime.start();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  await f.runtime.reviewContinuation('continuing', 2);
  jest.mocked(f.core.confirmActionContinuation).mockImplementation(async () => {
    expect(f.runtime.state.mutating).toBe(true);
    f.invalidateRecovery();
    f.notify({ revision: 1, collections: ['conversation'] });
    return f.result;
  });
  await f.runtime.confirmContinuation(f.review);
  expect(f.core.invalidateActionContinuationReview).not.toHaveBeenCalled();
  expect(f.runtime.state.continuationOutcomes?.continuing).toEqual(f.result);
  expect(f.runtime.mutationsHeld).toBe(false);
  await f.runtime.dispose();
});

test('the direct-action gate blocks continuation and revokes unconsumed consent', async () => {
  const f = await continuationFixture();
  await f.runtime.reviewContinuation('continuing', 2);
  f.runtime.setMutationGate(() => false);
  await f.runtime.confirmContinuation(f.review);
  expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
  expect(f.core.invalidateActionContinuationReview).toHaveBeenCalledTimes(1);
  expect(f.runtime.state.actionError?.error.code).toBe('already_pending');
  await f.runtime.dispose();
});

test('continuation cannot exclude its own unresolved candidate from the fresh admission audit', async () => {
  const f = await continuationFixture();
  await f.runtime.reviewContinuation('continuing', 2);
  f.refreshRecoveryGate.mockResolvedValue(
    ready({
      kind: 'ready',
      token: 'unresolved',
      conversationId: 'conversation',
      conversationGeneration: 0,
      candidates: [
        {
          conversationId: 'conversation',
          conversationGeneration: 0,
          userIntentId: 'continuing',
          intentRevision: 2,
          phase: 'dispatched',
          slots: [
            {
              slotId: 'next-slot',
              operationId: 'next-operation',
              outcome: 'unresolved',
              receipt: null,
            },
          ],
        },
      ],
    }),
  );
  await f.runtime.confirmContinuation(f.review);
  expect(f.core.confirmActionContinuation).not.toHaveBeenCalled();
  expect(f.runtime.mutationsHeld).toBe(true);
  expect(f.runtime.state.continuationOutcomes?.continuing).toBeUndefined();
  await f.runtime.dispose();
});

test.each(['clear', 'dismiss'] as const)(
  '%s during confirmation suppresses obsolete attempt display',
  async (reason) => {
    const f = await continuationFixture();
    await f.runtime.reviewContinuation('continuing', 2);
    const pending = deferred<ActionContinuationOutcome>();
    const started = deferred<void>();
    jest.mocked(f.core.confirmActionContinuation).mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const confirming = f.runtime.confirmContinuation(f.review);
    await started.promise;
    if (reason === 'clear') {
      f.runtime.invalidate();
      f.header.generation++;
    } else f.runtime.dismissContinuationReview();
    pending.resolve(f.result);
    await confirming;
    expect(f.runtime.state.continuationOutcomes?.continuing).toBeUndefined();
    expect(f.runtime.state.actionOutcomes).toEqual({});
    await f.runtime.dispose();
  },
);

test.each(['failed', 'uncertain'] as const)(
  'an original %s attempt stays separate from a later confirmed aggregate',
  async (kind) => {
    const f = await continuationFixture();
    const original: CommandResult =
      kind === 'failed'
        ? { kind, operationId: 'next-operation', error: failed }
        : { kind, operationId: 'next-operation' };
    const result: ActionContinuationOutcome = {
      command: f.result.command,
      result: original,
      actionOutcome: {
        summary: 'complete',
        results: {
          userIntentId: 'continuing',
          slots: [{ slotId: 'next-slot', result: f.result.result }],
        },
      },
    };
    jest.mocked(f.core.confirmActionContinuation).mockResolvedValue(result);
    await f.runtime.reviewContinuation('continuing', 2);
    await f.runtime.confirmContinuation(f.review);
    expect(f.runtime.state.continuationOutcomes?.continuing?.result).toEqual(original);
    expect(f.runtime.state.actionOutcomes.continuing).toEqual(result.actionOutcome);
    await f.runtime.dispose();
  },
);

test('restore uses owner installation marker, reads history/draft and never sends or health checks', async () => {
  const f = fixture();
  f.runtime.start();
  await tick();
  await f.runtime.reload();
  expect(f.connection.restore).toHaveBeenCalledWith('real-installation-marker');
  expect(f.runtime.state.draft).toBe('Retained draft');
  expect(f.send).not.toHaveBeenCalled();
  expect(f.core.dispatch).not.toHaveBeenCalled();
  expect(f.connection.health).not.toHaveBeenCalled();
  await f.runtime.dispose();
});
test('failed installation read never becomes null restore or credential erasure', async () => {
  const f = fixture();
  f.readInstallationId.mockResolvedValue({ kind: 'failed', error: failed });
  await f.runtime.restoreConnection();
  expect(f.connection.restore).not.toHaveBeenCalled();
  expect(f.connection.forget).not.toHaveBeenCalled();
  expect(f.runtime.state.connectionReady).toBe(false);
  expect(f.runtime.state.connectionError).toEqual(failed);
});
test('history read failure stays failure rather than ready-empty', async () => {
  const f = fixture();
  f.readConversation.mockResolvedValue({ kind: 'failed', error: failed });
  await f.runtime.reload();
  expect(f.runtime.state.conversation).toBeNull();
  expect(f.runtime.state.readError).toEqual(failed);
});
test('a failed refresh retains the last readable conversation', async () => {
  const f = fixture();
  await f.runtime.reload();
  f.readConversation.mockResolvedValue({ kind: 'failed', error: failed });
  await f.runtime.reload();
  expect(f.runtime.state.conversation?.header.composerDraft).toBe('Retained draft');
  expect(f.runtime.state.readError).toEqual(failed);
});
test('draft edits are coalesced and use the current owner header guard', async () => {
  const f = fixture();
  await f.runtime.reload();
  f.runtime.setDraft('First');
  f.runtime.setDraft('Second');
  await tick();
  expect(f.saveDraft).toHaveBeenCalledTimes(1);
  expect(f.saveDraft).toHaveBeenCalledWith(
    { conversationId: 'conversation', generation: 0, expectedConversationRevision: 0 },
    'Second',
  );
});
test('a pending draft is flushed before disposing the app controller', async () => {
  const f = fixture();
  await f.runtime.reload();
  f.runtime.setDraft('Keep through close');
  await f.runtime.dispose();
  expect(f.header.composerDraft).toBe('Keep through close');
});
test('oversized Unicode draft stays visible with no truncated write', async () => {
  const f = fixture();
  await f.runtime.reload();
  const text = '🥑'.repeat(4001);
  f.runtime.setDraft(text);
  await tick();
  expect(f.runtime.state.draft).toBe(text);
  expect(f.runtime.state.draftError?.code).toBe('too_large');
  expect(f.saveDraft).not.toHaveBeenCalled();
  f.runtime.setDraft('🥑'.repeat(4000));
  await tick();
  expect(f.saveDraft).toHaveBeenCalledTimes(1);
  expect(f.runtime.state.draftError).toBeUndefined();
});
test('draft write failure retains input and blocks send until explicit correction/retry', async () => {
  const f = fixture();
  await f.runtime.reload();
  f.saveDraft.mockResolvedValue({ kind: 'failed', error: failed });
  f.runtime.setDraft('Do not lose me');
  await tick();
  await f.runtime.send({});
  expect(f.runtime.state.draft).toBe('Do not lose me');
  expect(f.send).not.toHaveBeenCalled();
});
test('a send queued behind draft persistence cannot run after clear invalidation', async () => {
  const f = fixture();
  await f.runtime.reload();
  const saving = deferred<RepositoryResult<ConversationHeader>>();
  f.saveDraft.mockImplementation(() => saving.promise);
  f.runtime.setDraft('Old request');
  await tick();
  const sending = f.runtime.send({});
  f.runtime.invalidate();
  f.header.generation++;
  f.header.revision++;
  f.header.composerDraft = '';
  saving.resolve(ready({ ...f.header }));
  await sending;
  expect(f.send).not.toHaveBeenCalled();
  expect(f.runtime.state.draft).toBe('');
});
test('a draft queued before clear cannot write into the new conversation generation', async () => {
  const f = fixture();
  await f.runtime.reload();
  f.runtime.setDraft('Old text');
  f.header.generation++;
  f.header.composerDraft = '';
  await tick();
  await f.runtime.reload();
  expect(f.saveDraft).not.toHaveBeenCalled();
  expect(f.runtime.state.draft).toBe('');
});
test('pending send prevents duplicate send and pauses composer only until user message is journalled', async () => {
  const f = fixture();
  await f.runtime.reload();
  const pending = deferred<TurnOutcome>();
  f.send.mockImplementation(() => pending.promise);
  const sending = f.runtime.send({ selectedRecipeId: '52839' });
  await tick();
  await f.runtime.send({});
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.runtime.state.composerPaused).toBe(true);
  f.header.nextSequence = 2;
  f.header.composerDraft = '';
  f.header.revision++;
  f.setMessages([
    {
      messageId: 'user1',
      conversationId: 'conversation',
      generation: 0,
      sequence: 1,
      role: 'user',
      text: 'Retained draft',
      status: 'sending',
      createdAt: '2026-09-28T00:00:00Z',
      referenceSets: [],
    },
  ]);
  await f.runtime.reload();
  expect(f.runtime.state.composerPaused).toBe(false);
  f.runtime.setDraft('My next request');
  await tick();
  pending.resolve(failure);
  await sending;
  expect(f.header.composerDraft).toBe('My next request');
  expect(f.runtime.state.draft).toBe('My next request');
});
test('late outcome after clear is suppressed and does not resurrect its failure/retry', async () => {
  const f = fixture();
  await f.runtime.reload();
  const pending = deferred<TurnOutcome>();
  f.send.mockImplementation(() => pending.promise);
  const sending = f.runtime.send({});
  await tick();
  f.runtime.invalidate();
  f.header.generation++;
  f.header.composerDraft = '';
  pending.resolve({ ...failure, userIntentId: 'old-intent' });
  await sending;
  expect(f.runtime.state.outcome).toBeUndefined();
  expect(f.runtime.state.draft).toBe('');
});
test.each(['send', 'retryTurn'] as const)(
  '%s follows exhausted notification recovery with one fresh audit after reload',
  async (method) => {
    const f = fixture();
    f.runtime.start();
    await f.runtime.reload();
    await f.runtime.recovery.check();
    await tick();
    f.refreshRecoveryGate.mockClear();
    const first = deferred<RepositoryResult<RecoveryGate>>();
    const second = deferred<RepositoryResult<RecoveryGate>>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const driftObserved = deferred<void>();
    let turnSettled = false;
    const snapshot = (token: string): RecoveryGate => ({
      kind: 'ready',
      token,
      conversationId: f.header.conversationId,
      conversationGeneration: f.header.generation,
      candidates: [],
    });
    const stop = f.runtime.subscribe(() => {
      const recovery = f.runtime.state.recovery;
      if (
        recovery.kind === 'failed' &&
        recovery.error.messageKey === 'ui.recovery_snapshot_changed'
      )
        driftObserved.resolve();
    });
    f.refreshRecoveryGate
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return first.promise;
      })
      .mockImplementationOnce(() => {
        secondStarted.resolve();
        return second.promise;
      })
      .mockImplementation(async () => {
        expect(turnSettled).toBe(true);
        expect(f.runtime.state.loading).toBe(false);
        expect(f.runtime.state.busy).toBe(true);
        return ready(snapshot('settled'));
      });
    const operation = async () => {
      f.invalidateRecovery();
      await firstStarted.promise;
      f.notify({ revision: 1, collections: ['conversation'] });
      first.resolve(ready(snapshot('begin')));
      await secondStarted.promise;
      f.invalidateRecovery();
      f.notify({ revision: 2, collections: ['conversation'] });
      second.resolve(ready(snapshot('accept')));
      await driftObserved.promise;
      expect(f.runtime.mutationsHeld).toBe(true);
      turnSettled = true;
      return failure;
    };
    try {
      if (method === 'send') {
        f.send.mockImplementation(operation);
        await f.runtime.send({});
      } else {
        jest.mocked(f.core.retryTurn).mockImplementation(operation);
        await f.runtime.retryTurn('retry-intent');
      }
      expect(f.refreshRecoveryGate).toHaveBeenCalledTimes(3);
      expect(f.runtime.state.recovery).toEqual({ kind: 'ready', proofs: {}, unresolvedIds: [] });
      expect(f.runtime.mutationsHeld).toBe(false);
      expect(f.runtime.state.busy).toBe(false);
      expect(f.runtime.state.outcome).toEqual(failure);
      expect(f.core.dispatch).not.toHaveBeenCalled();
    } finally {
      stop();
      await f.runtime.dispose();
    }
  },
);

test('turn reservation covers the final reload and recovery audit', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  const reading = deferred<RepositoryResult<ConversationPage>>();
  const readStarted = deferred<void>();
  const auditing = deferred<RepositoryResult<RecoveryGate>>();
  const auditStarted = deferred<void>();
  f.readConversation.mockImplementationOnce(() => {
    readStarted.resolve();
    return reading.promise;
  });
  f.refreshRecoveryGate.mockImplementationOnce(() => {
    auditStarted.resolve();
    return auditing.promise;
  });
  const sending = f.runtime.send({});
  const action = jest.fn();
  await readStarted.promise;
  expect(f.runtime.state.busy).toBe(true);
  await f.runtime.send({});
  await f.runtime.retryTurn('other');
  await f.runtime.runAction('other', action, true);
  reading.resolve(ready(f.runtime.state.conversation!));
  await auditStarted.promise;
  expect(f.runtime.state.busy).toBe(true);
  await f.runtime.send({});
  await f.runtime.runAction('other', action, true);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.core.retryTurn).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
  auditing.resolve(
    ready({
      kind: 'ready',
      token: 'settled',
      conversationId: f.header.conversationId,
      conversationGeneration: f.header.generation,
      candidates: [],
    }),
  );
  await sending;
  expect(f.runtime.state.busy).toBe(false);
  expect(f.runtime.state.composerPaused).toBe(false);
  await f.runtime.dispose();
});

test.each(['storage failure', 'unresolved candidate', 'repeated drift'] as const)(
  'post-turn recovery preserves the hold for %s',
  async (condition) => {
    const f = fixture();
    await f.runtime.reload();
    await f.runtime.recovery.check();
    f.refreshRecoveryGate.mockClear();
    f.refreshRecoveryGate.mockImplementation(async () => {
      if (condition === 'storage failure') return { kind: 'failed', error: failed };
      if (condition === 'repeated drift') f.runtime.recovery.invalidate();
      return ready({
        kind: 'ready',
        token: 'settled',
        conversationId: f.header.conversationId,
        conversationGeneration: f.header.generation,
        candidates:
          condition === 'unresolved candidate'
            ? [
                {
                  conversationId: f.header.conversationId,
                  conversationGeneration: f.header.generation,
                  userIntentId: 'earlier',
                  intentRevision: 0,
                  phase: 'dispatched',
                  slots: [
                    { slotId: 'slot', operationId: 'op', outcome: 'unresolved', receipt: null },
                  ],
                },
              ]
            : [],
      });
    });
    f.send.mockImplementation(async () => {
      f.runtime.recovery.invalidate();
      return failure;
    });
    await f.runtime.send({});
    expect(f.runtime.mutationsHeld).toBe(true);
    expect(f.runtime.state.busy).toBe(false);
    expect(f.refreshRecoveryGate).toHaveBeenCalledTimes(condition === 'repeated drift' ? 2 : 1);
    if (condition === 'unresolved candidate') {
      expect(f.runtime.state.recovery).toMatchObject({
        kind: 'ready',
        unresolvedIds: ['earlier'],
      });
    } else {
      expect(f.runtime.state.recovery).toEqual({
        kind: 'failed',
        error:
          condition === 'storage failure'
            ? failed
            : {
                code: 'stale_context',
                messageKey: 'ui.recovery_snapshot_changed',
                retry: 'after_correction',
              },
      });
    }
    expect(f.core.dispatch).not.toHaveBeenCalled();
    await f.runtime.dispose();
  },
);

test.each(['clear', 'cancel'] as const)(
  '%s during the final audit rejects its old ready result',
  async (invalidation) => {
    const f = fixture();
    await f.runtime.reload();
    await f.runtime.recovery.check();
    const auditing = deferred<RepositoryResult<RecoveryGate>>();
    const auditStarted = deferred<void>();
    f.refreshRecoveryGate.mockClear();
    f.refreshRecoveryGate.mockImplementationOnce(() => {
      auditStarted.resolve();
      return auditing.promise;
    });
    const sending = f.runtime.send({});
    await auditStarted.promise;
    let cancelling: Promise<void> | undefined;
    if (invalidation === 'clear') {
      f.runtime.invalidate();
      f.header.generation++;
    } else {
      cancelling = f.runtime.cancel();
    }
    f.refreshRecoveryGate.mockResolvedValue({ kind: 'failed', error: failed });
    auditing.resolve(
      ready({
        kind: 'ready',
        token: 'old',
        conversationId: f.header.conversationId,
        conversationGeneration: 0,
        candidates: [],
      }),
    );
    await sending;
    await cancelling;
    expect(f.runtime.state.recovery).toEqual({ kind: 'failed', error: failed });
    expect(f.runtime.mutationsHeld).toBe(true);
    expect(f.runtime.state.busy).toBe(false);
    if (invalidation === 'clear') expect(f.runtime.state.outcome).toBeUndefined();
    expect(f.core.dispatch).not.toHaveBeenCalled();
    await f.runtime.dispose();
  },
);

test('a turn settling after disposal cannot start a final audit or revive its outcome', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  const pending = deferred<TurnOutcome>();
  f.send.mockImplementation(() => pending.promise);
  const sending = f.runtime.send({});
  await tick();
  await f.runtime.dispose();
  f.refreshRecoveryGate.mockClear();
  pending.resolve(failure);
  await sending;
  expect(f.refreshRecoveryGate).not.toHaveBeenCalled();
  expect(f.runtime.state.outcome).toBeUndefined();
});

test('disposal during the final audit prevents its ready result from reopening the gate', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  const auditing = deferred<RepositoryResult<RecoveryGate>>();
  const auditStarted = deferred<void>();
  f.refreshRecoveryGate.mockImplementationOnce(() => {
    auditStarted.resolve();
    return auditing.promise;
  });
  const sending = f.runtime.send({});
  await auditStarted.promise;
  const disposing = f.runtime.dispose();
  await tick();
  auditing.resolve(
    ready({
      kind: 'ready',
      token: 'disposed',
      conversationId: f.header.conversationId,
      conversationGeneration: f.header.generation,
      candidates: [],
    }),
  );
  await disposing;
  await sending;
  expect(f.runtime.state.recovery.kind).toBe('loading');
  expect(f.runtime.mutationsHeld).toBe(true);
});

test('disconnect does not send drafts or mutate cooking data and reports unconfirmed server revocation', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.restoreConnection();
  await f.runtime.connectionAction('revoke');
  expect(f.connection.revokeAndForget).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.runtime.state.connectionNotice).toContain('has not confirmed revocation');
  expect(f.runtime.state.connectionNotice).toContain('access may already have been revoked');
  expect(f.runtime.state.connectionNotice).not.toContain('client ID');
  expect(f.runtime.state.draft).toBe('Retained draft');
});
test('unconfirmed revocation preserves the pre-operation client ID after local credentials disappear', async () => {
  const f = fixture();
  const clientId = '11111111-2222-4333-8444-555555555555';
  const state = jest.spyOn(f.connection, 'getState').mockReturnValue({
    status: 'paired',
    generation: 1,
    endpoint: 'https://private.example',
    clientId,
  });
  await f.runtime.reload();
  await f.runtime.restoreConnection();
  const response = deferred<Awaited<ReturnType<GatewayConnection['revokeAndForget']>>>();
  f.connection.revokeAndForget.mockImplementationOnce(() => {
    state.mockReturnValue({ status: 'unpaired', generation: 2 });
    return response.promise;
  });
  const revoking = f.runtime.connectionAction('revoke');
  expect(f.runtime.state.connectionNotice).toBeUndefined();
  response.resolve({
    localForgotten: true,
    serverRevoked: false,
    error: {
      code: 'network_unavailable',
      messageKey: 'test.lost_response',
      retry: 'after_reconnect',
    },
  });
  await revoking;
  expect(f.runtime.state.connection).toEqual({ status: 'unpaired', generation: 2 });
  expect(f.runtime.state.connectionNotice).toBe(
    'Disconnected on this iPhone. The laptop has not confirmed revocation; access may already have been revoked.' +
      ` Give the laptop operator this client ID to check or revoke: ${clientId}.`,
  );
  expect(f.connection.revokeAndForget).toHaveBeenCalledTimes(1);
  expect(f.connection.pair).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.saveDraft).not.toHaveBeenCalled();
  expect(f.core.dispatch).not.toHaveBeenCalled();
  expect(f.runtime.state.draft).toBe('Retained draft');
  await f.runtime.connectionAction('health', 'https://private.example');
  expect(f.runtime.state.connectionNotice).not.toContain(clientId);
  expect(f.connection.revokeAndForget).toHaveBeenCalledTimes(1);
});

test('confirmed revocation keeps its acknowledgement and does not retain an operator-recovery ID', async () => {
  const f = fixture();
  jest.spyOn(f.connection, 'getState').mockReturnValue({
    status: 'paired',
    generation: 1,
    clientId: '11111111-2222-4333-8444-555555555555',
  });
  await f.runtime.restoreConnection();
  f.connection.revokeAndForget.mockResolvedValueOnce({ localForgotten: true, serverRevoked: true });
  await f.runtime.connectionAction('revoke');
  expect(f.runtime.state.connectionNotice).toBe(
    'Disconnected on this iPhone and access revoked by the laptop.',
  );
});

test('successful health check is labelled as laptop availability, never provider success', async () => {
  const f = fixture();
  await f.runtime.restoreConnection();
  await f.runtime.connectionAction('health', 'https://private.example');
  expect(f.runtime.state.connectionNotice).toContain('An AI answer has not been tested');
  expect(f.send).not.toHaveBeenCalled();
});

test('shared direct-recovery gate blocks assistant mutations while leaving read-only result checks available', async () => {
  const f = fixture();
  await f.runtime.reload();
  f.runtime.setMutationGate(() => false);
  const operation = jest.fn(
    async () =>
      ({
        summary: 'failed' as const,
        results: {
          userIntentId: 'old',
          slots: [{ slotId: 'slot', result: { kind: 'uncertain' as const, operationId: 'op' } }],
        },
      }) as import('../../assistant-core').ActionOutcome,
  );
  await f.runtime.runAction('old', operation, true);
  expect(operation).not.toHaveBeenCalled();
  expect(f.runtime.state.actionError?.error.messageKey).toBe('ui.resolve_earlier_change');
  await f.runtime.runAction('old', operation);
  expect(operation).toHaveBeenCalledTimes(1);
});

test('one owned approval-to-dispatch path proceeds without self-hold while new unrelated writes remain blocked', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  f.runtime.setMutationGate(() => !f.runtime.mutationsHeld);
  const dispatch = jest.fn(
    async () =>
      ({
        summary: 'failed' as const,
        results: {
          userIntentId: 'mine',
          slots: [
            { slotId: 's', result: { kind: 'failed' as const, operationId: 'op', error: failed } },
          ],
        },
      }) as import('../../assistant-core').ActionOutcome,
  );
  await f.runtime.runAction(
    'mine',
    async () => {
      expect(f.runtime.mutationsHeld).toBe(true);
      await f.runtime.recovery.check();
      return dispatch();
    },
    true,
  );
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(f.runtime.state.busy).toBe(false);
  expect(f.runtime.mutationsHeld).toBe(false);
});

test('a new reservation cannot exclude its own already-unresolved target during freshness admission', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  f.refreshRecoveryGate.mockResolvedValue(
    ready({
      kind: 'ready',
      token: 'changed',
      conversationId: 'conversation',
      conversationGeneration: 0,
      candidates: [
        {
          conversationId: 'conversation',
          conversationGeneration: 0,
          userIntentId: 'mine',
          intentRevision: 1,
          phase: 'ready',
          slots: [{ slotId: 's', operationId: 'op', outcome: 'unresolved', receipt: null }],
        },
      ],
    }),
  );
  const operation = jest.fn();
  await f.runtime.runAction('mine', operation, true);
  expect(operation).not.toHaveBeenCalled();
  expect(f.runtime.mutationsHeld).toBe(true);
  expect(f.runtime.state.actionError?.error.code).toBe('already_pending');
});

test('certified draft notifications cause no recovery scan or transient hold; unknown invalidation holds synchronously', async () => {
  const f = fixture();
  f.runtime.start();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  f.refreshRecoveryGate.mockClear();
  const held: boolean[] = [];
  const stop = f.runtime.subscribe(() => held.push(f.runtime.mutationsHeld));
  for (let i = 0; i < 20; i++)
    f.notify({
      revision: i + 1,
      collections: ['conversation'],
      recovery: { kind: 'unchanged', token: 'test-token' },
    });
  await f.runtime.reload();
  expect(f.refreshRecoveryGate).not.toHaveBeenCalled();
  expect(held).not.toContain(true);
  f.invalidateRecovery();
  expect(f.runtime.mutationsHeld).toBe(true);
  await f.runtime.recovery.check();
  expect(f.refreshRecoveryGate).toHaveBeenCalledTimes(1);
  stop();
  await f.runtime.dispose();
});

async function settleReads(runtime: AssistantRuntime) {
  let pending: Promise<void>;
  do {
    pending = Reflect.get(runtime, 'reads') as Promise<void>;
    await pending;
  } while (pending !== Reflect.get(runtime, 'reads'));
}
function draftEvent(header: ConversationHeader, revision: number): StoreChange {
  return {
    revision,
    collections: ['conversation'],
    recovery: { kind: 'unchanged', token: 'test-token' },
    conversationChange: { kind: 'draft_only', header: { ...header } },
  };
}

test('acknowledged draft-only burst preserves loaded structures with zero transcript or gate reads', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  const previous = f.runtime.state;
  f.readConversation.mockClear();
  f.readIntentPage.mockClear();
  f.refreshRecoveryGate.mockClear();
  for (let i = 1; i <= 20; i++) {
    f.header.composerDraft = `Saved ${i}`;
    f.notify(draftEvent(f.header, i));
  }
  await settleReads(f.runtime);
  expect(f.runtime.state.draft).toBe('Saved 20');
  expect(f.runtime.state.conversation?.messages).toBe(previous.conversation?.messages);
  expect(f.runtime.state.conversation?.intents).toBe(previous.conversation?.intents);
  expect(f.runtime.state.historyProofs).toBe(previous.historyProofs);
  expect(f.readConversation).not.toHaveBeenCalled();
  expect(f.readIntentPage).not.toHaveBeenCalled();
  expect(f.refreshRecoveryGate).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test.each([
  'unknown_commit',
  'missing_certificate',
  'mismatched_certificate',
  'conversation',
  'generation',
  'semantic_revision',
  'sequence',
  'stale_revision',
  'duplicate_revision',
] as const)('draft-only %s falls back to ordinary transcript refresh', async (variant) => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  f.notify(draftEvent(f.header, 10));
  const event = draftEvent(f.header, 11);
  switch (variant) {
    case 'unknown_commit':
      delete event.conversationChange;
      break;
    case 'missing_certificate':
      delete event.recovery;
      break;
    case 'mismatched_certificate':
      event.recovery = { kind: 'unchanged', token: 'old' };
      break;
    case 'conversation':
      event.conversationChange = {
        kind: 'draft_only',
        header: { ...f.header, conversationId: 'other' },
      };
      break;
    case 'generation':
      event.conversationChange = { kind: 'draft_only', header: { ...f.header, generation: 1 } };
      break;
    case 'semantic_revision':
      event.conversationChange = { kind: 'draft_only', header: { ...f.header, revision: 1 } };
      break;
    case 'sequence':
      event.conversationChange = { kind: 'draft_only', header: { ...f.header, nextSequence: 2 } };
      break;
    case 'stale_revision':
      event.revision = 9;
      break;
    case 'duplicate_revision':
      event.revision = 10;
      break;
  }
  f.readConversation.mockClear();
  f.notify(event);
  await settleReads(f.runtime);
  expect(f.readConversation).toHaveBeenCalledTimes(2);
  expect(f.runtime.state.conversation?.header).toEqual(f.header);
  await f.runtime.dispose();
});

test('draft-only event before first history snapshot cannot establish a loaded conversation', async () => {
  const f = fixture();
  f.runtime.start();
  f.notify(draftEvent(f.header, 1));
  expect(f.runtime.state.conversation).toBeNull();
  await settleReads(f.runtime);
  expect(f.readConversation).toHaveBeenCalled();
  expect(f.runtime.state.conversation?.header).toEqual(f.header);
  await f.runtime.dispose();
});

test('draft acknowledgement before save resolves preserves a newer unsaved local edit', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  const saving = deferred<RepositoryResult<ConversationHeader>>();
  f.saveDraft.mockImplementationOnce(() => saving.promise);
  f.runtime.setDraft('A');
  await tick();
  f.runtime.setDraft('B');
  f.header.composerDraft = 'A';
  f.notify(draftEvent(f.header, 1));
  expect(f.runtime.state.draft).toBe('B');
  expect(Reflect.get(f.runtime, 'savedDraftVersion')).not.toBe(
    Reflect.get(f.runtime, 'draftVersion'),
  );
  saving.resolve(ready({ ...f.header }));
  await (Reflect.get(f.runtime, 'drafts') as Promise<void>);
  expect(f.saveDraft).toHaveBeenLastCalledWith(expect.anything(), 'B');
  expect(f.runtime.state.draft).toBe('B');
  await f.runtime.dispose();
});

test('stale acknowledged draft cannot replace a newer persisted draft or oversized local edit', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  const old = draftEvent({ ...f.header, composerDraft: 'Old A' }, 1);
  f.header.composerDraft = 'New B';
  f.notify(draftEvent(f.header, 2));
  const observed: string[] = [];
  const stop = f.runtime.subscribe(() => observed.push(f.runtime.state.draft));
  f.notify(old);
  await settleReads(f.runtime);
  expect(observed).not.toContain('Old A');
  expect(f.runtime.state.draft).toBe('New B');
  const oversized = '🥑'.repeat(4001);
  f.runtime.setDraft(oversized);
  f.notify(draftEvent(f.header, 3));
  expect(f.runtime.state.draft).toBe(oversized);
  expect(f.runtime.state.draftError?.code).toBe('too_large');
  stop();
  await f.runtime.dispose();
});

test('new acknowledged header prevents an older in-flight final read from rolling back draft or header', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  const oldPage = {
    header: { ...f.header },
    messages: [],
    beforeSequence: null,
    hasEarlier: false,
  };
  const finalRead = deferred<RepositoryResult<ConversationPage>>();
  f.readConversation
    .mockResolvedValueOnce(ready(oldPage))
    .mockImplementationOnce(() => finalRead.promise);
  const reading = f.runtime.reload();
  await tick();
  f.header.composerDraft = 'New acknowledged draft';
  f.notify(draftEvent(f.header, 1));
  const observed: string[] = [];
  const stop = f.runtime.subscribe(() => observed.push(f.runtime.state.draft));
  finalRead.resolve(ready(oldPage));
  await reading;
  await settleReads(f.runtime);
  expect(observed).not.toContain('Retained draft');
  expect(f.runtime.state.draft).toBe('New acknowledged draft');
  expect(f.runtime.state.conversation?.header.composerDraft).toBe('New acknowledged draft');
  stop();
  await f.runtime.dispose();
});

test('draft-only event retains transcript read errors and send pause; real journal refresh unpauses', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  f.readConversation.mockResolvedValueOnce({ kind: 'failed', error: failed });
  await f.runtime.reload();
  const sending = deferred<TurnOutcome>();
  f.send.mockImplementationOnce(() => sending.promise);
  const task = f.runtime.send({});
  await tick();
  f.notify(draftEvent(f.header, 1));
  expect(f.runtime.state.composerPaused).toBe(true);
  expect(f.runtime.state.readError).toEqual(failed);
  f.setMessages([
    {
      messageId: 'user',
      sequence: 1,
      role: 'user',
      text: 'Retained draft',
      status: 'sending',
      conversationId: 'conversation',
      generation: 0,
      createdAt: '2026-09-28T00:00:00.000Z',
      referenceSets: [],
    },
  ]);
  f.header.nextSequence++;
  f.header.revision++;
  f.notify({ revision: 2, collections: ['conversation'] });
  await settleReads(f.runtime);
  expect(f.runtime.state.composerPaused).toBe(false);
  expect(f.runtime.state.readError).toBeUndefined();
  sending.resolve(failure);
  await task;
  await f.runtime.dispose();
});

test('a matching draft certificate preserves cold progress without completing recovery', async () => {
  const f = fixture();
  const finish = deferred<RepositoryResult<RecoveryGate>>();
  f.refreshRecoveryGate
    .mockResolvedValueOnce(
      ready({
        kind: 'checking',
        token: 'test-token',
        conversationId: 'conversation',
        conversationGeneration: 0,
        continuation: 'next',
      }),
    )
    .mockImplementationOnce(() => finish.promise);
  f.runtime.start();
  await settleReads(f.runtime);
  f.notify(draftEvent(f.header, 1));
  expect(f.runtime.recovery.state.kind).toBe('loading');
  expect(f.runtime.mutationsHeld).toBe(true);
  finish.resolve(
    ready({
      kind: 'ready',
      token: 'test-token',
      conversationId: 'conversation',
      conversationGeneration: 0,
      candidates: [],
    }),
  );
  await f.runtime.recovery.check();
  expect(f.runtime.mutationsHeld).toBe(false);
  await f.runtime.dispose();
});

test('unclassified lost draft acknowledgement refreshes history but does not claim a failed local draft saved', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  f.saveDraft.mockResolvedValueOnce({ kind: 'failed', error: failed });
  f.runtime.setDraft('Unconfirmed local draft');
  await (Reflect.get(f.runtime, 'drafts') as Promise<void>);
  // A later durable proof notification deliberately carries no draft-only classification.
  f.header.composerDraft = 'Unconfirmed local draft';
  f.readConversation.mockClear();
  f.notify({
    revision: 1,
    collections: ['conversation'],
    recovery: { kind: 'unchanged', token: 'test-token' },
  });
  await settleReads(f.runtime);
  expect(f.readConversation).toHaveBeenCalledTimes(2);
  expect(f.runtime.state.draftError).toEqual(failed);
  expect(Reflect.get(f.runtime, 'savedDraftVersion')).not.toBe(
    Reflect.get(f.runtime, 'draftVersion'),
  );
  await f.runtime.send({});
  expect(f.send).not.toHaveBeenCalled();
  await f.runtime.dispose();
});

test('ordinary reply and clear notifications refresh; stale pre-clear draft cannot restore text', async () => {
  const f = fixture();
  f.runtime.start();
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  const oldDraft = draftEvent(f.header, 1);
  f.setMessages([
    {
      messageId: 'reply',
      conversationId: 'conversation',
      generation: 0,
      sequence: 1,
      role: 'assistant',
      text: 'A persisted reply',
      status: 'complete',
      createdAt: '2026-09-28T00:00:00.000Z',
      referenceSets: [],
    },
  ]);
  f.header.revision++;
  f.header.nextSequence++;
  f.notify({
    revision: 2,
    collections: ['conversation'],
    recovery: { kind: 'unchanged', token: 'test-token' },
  });
  await settleReads(f.runtime);
  expect(f.runtime.state.conversation?.messages[0]?.text).toBe('A persisted reply');
  f.runtime.invalidate();
  f.header.generation++;
  f.header.revision++;
  f.header.nextSequence = 1;
  f.header.composerDraft = '';
  f.setMessages([]);
  f.notify({ revision: 3, collections: ['conversation'] });
  await settleReads(f.runtime);
  await f.runtime.recovery.check();
  f.notify(oldDraft);
  await settleReads(f.runtime);
  expect(f.runtime.state.conversation?.messages).toEqual([]);
  expect(f.runtime.state.draft).toBe('');
  expect(f.runtime.state.conversation?.header.generation).toBe(1);
  await f.runtime.dispose();
  f.readConversation.mockClear();
  f.notify(draftEvent(f.header, 4));
  await settleReads(f.runtime);
  expect(f.readConversation).not.toHaveBeenCalled();
});

function pagingFixture(sequences: readonly number[]) {
  const f = fixture();
  const messages: StoredConversationMessage[] = sequences.map((sequence) => ({
    messageId: `page-${sequence}`,
    conversationId: 'conversation',
    generation: 0,
    sequence,
    role: 'assistant',
    text: `Reference-bearing message ${sequence}`,
    status: 'complete',
    createdAt: '2026-09-28T00:00:00.000Z',
    referenceSets: [],
  }));
  f.header.nextSequence = (sequences[sequences.length - 1] ?? -1) + 1;
  const readPage = async (input?: { beforeSequence?: number; limit?: number }) => {
    const all = messages.filter(
      (message) => message.sequence < (input?.beforeSequence ?? f.header.nextSequence),
    );
    const selected = all.slice(-(input?.limit ?? 30));
    const hasEarlier = selected.length < all.length;
    return ready({
      header: { ...f.header },
      messages: selected,
      hasEarlier,
      beforeSequence: hasEarlier ? selected[0]!.sequence : null,
    });
  };
  jest.mocked(f.runtime.persistence.readConversation).mockImplementation(readPage);
  return { ...f, messages, readPage };
}

test('sparse transcript sequences page from message coverage until an empty prefix is proven', async () => {
  const f = pagingFixture(Array.from({ length: 70 }, (_, i) => 10 + i * 10));
  await f.runtime.reload();
  // The empty intent page must not claim that all transcript messages have been loaded.
  expect(f.runtime.state.conversation?.beforeSequence).toBe(410);
  await f.runtime.reload(true);
  expect(f.runtime.state.conversation?.beforeSequence).toBe(110);
  await f.runtime.reload(true);
  expect(f.runtime.state.conversation?.beforeSequence).toBeNull();
  expect(f.runtime.state.conversation?.hasEarlier).toBe(false);
  expect(f.runtime.state.conversation?.messages.map((item) => item.messageId)).toEqual(
    f.messages.map((item) => item.messageId),
  );
  const reads = f.readConversation.mock.calls.length;
  await f.runtime.reload(true);
  expect(f.readConversation).toHaveBeenCalledTimes(reads);
});

test('failed earlier final read leaves visible history and retry cursor unchanged without consuming coverage', async () => {
  const f = pagingFixture(Array.from({ length: 70 }, (_, i) => i));
  await f.runtime.reload();
  const previous = f.runtime.state.conversation;
  f.readConversation
    .mockImplementationOnce(() => f.readPage({ beforeSequence: 40, limit: 30 }))
    .mockResolvedValueOnce({ kind: 'failed', error: failed });
  await f.runtime.reload(true);
  expect(f.runtime.state.conversation).toBe(previous);
  expect(f.runtime.state.conversation?.beforeSequence).toBe(40);
  expect(f.runtime.state.readError).toEqual(failed);
  await f.runtime.reload(true);
  expect(f.runtime.state.conversation?.beforeSequence).toBe(10);
  expect(f.runtime.state.conversation?.messages).toHaveLength(60);
  expect(f.runtime.state.readError).toBeUndefined();
});

test('drifting earlier page does not consume coverage; loaded message references survive normal retry', async () => {
  const f = pagingFixture(Array.from({ length: 70 }, (_, i) => i));
  await f.runtime.reload();
  const original = f.runtime.state.conversation!.messages;
  f.readIntentPage.mockResolvedValueOnce(
    ready({
      header: { ...f.header, revision: 1 },
      items: [],
      beforeSequence: null,
      hasEarlier: false,
    }),
  );
  await f.runtime.reload(true);
  await settleReads(f.runtime);
  expect(f.runtime.state.conversation?.beforeSequence).toBe(40);
  expect(f.runtime.state.conversation?.messages).toEqual(original);
  await f.runtime.reload(true);
  expect(f.runtime.state.conversation?.beforeSequence).toBe(10);
  for (const message of original)
    expect(
      f.runtime.state.conversation?.messages.find((item) => item.messageId === message.messageId),
    ).toBe(message);
});

test('foreground and new mutation probe freshness without making their own reservation self-block', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  f.refreshRecoveryGate.mockClear();
  const foreground = f.runtime.refreshForForeground();
  expect(f.runtime.mutationsHeld).toBe(true);
  await foreground;
  expect(f.refreshRecoveryGate).toHaveBeenCalledTimes(1);
  const operation = jest.fn(
    async (): Promise<import('../../assistant-core').ActionOutcome> => ({
      summary: 'failed',
      results: {
        userIntentId: 'mine',
        slots: [{ slotId: 's', result: { kind: 'failed', operationId: 'op', error: failed } }],
      },
    }),
  );
  f.runtime.setMutationGate(() => !f.runtime.mutationsHeld);
  await f.runtime.runAction('mine', operation, true);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(f.refreshRecoveryGate).toHaveBeenCalledTimes(3);
});

test('clear during mutation preflight cannot dispatch the reserved action', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  const pending = deferred<RepositoryResult<RecoveryGate>>();
  f.refreshRecoveryGate.mockReturnValueOnce(pending.promise);
  const operation = jest.fn();
  const executing = f.runtime.runAction('mine', operation, true);
  await tick();
  f.runtime.invalidate();
  pending.resolve(
    ready({
      kind: 'ready',
      token: 'old',
      conversationId: 'conversation',
      conversationGeneration: 0,
      candidates: [],
    }),
  );
  await executing;
  expect(operation).not.toHaveBeenCalled();
  expect(f.runtime.state.busy).toBe(false);
});

test.each(['pair', 'forget', 'revoke'] as const)(
  'connection %s settles its recovery invalidation without a conversation commit',
  async (action) => {
    const f = fixture();
    await f.runtime.restoreConnection();
    await f.runtime.recovery.check();
    await f.runtime.connectionAction(action, 'https://private.example', 'synthetic-code');
    expect(f.runtime.mutationsHeld).toBe(false);
    expect(f.runtime.recovery.state.kind).toBe('ready');
    expect(f.send).not.toHaveBeenCalled();
  },
);

test('failed connection action still refreshes recovery instead of stranding local changes', async () => {
  const f = fixture();
  await f.runtime.restoreConnection();
  await f.runtime.recovery.check();
  f.connection.pair.mockRejectedValueOnce(new Error('Synthetic pairing failure'));
  await f.runtime.connectionAction('pair', 'https://private.example', 'synthetic-code');
  expect(f.runtime.state.connectionError).toBeDefined();
  expect(f.runtime.mutationsHeld).toBe(false);
});

test('Stop during preflight invalidates the queued UI action even when durable cancellation fails', async () => {
  const f = fixture();
  await f.runtime.reload();
  await f.runtime.recovery.check();
  const pending = deferred<RepositoryResult<RecoveryGate>>();
  f.refreshRecoveryGate.mockReturnValueOnce(pending.promise);
  const operation = jest.fn();
  const executing = f.runtime.runAction('mine', operation, true);
  await tick();
  jest.mocked(f.core.cancel).mockRejectedValueOnce(new Error('Synthetic failed durable cancel'));
  const cancelled = f.runtime.cancel('mine');
  pending.resolve(
    ready({
      kind: 'ready',
      token: 'old',
      conversationId: 'conversation',
      conversationGeneration: 0,
      candidates: [],
    }),
  );
  await Promise.all([cancelled, executing]);
  expect(operation).not.toHaveBeenCalled();
  expect(f.runtime.state.busy).toBe(false);
});

test('historical display proofs are bounded to a loaded page and unchanged drafts do not re-read their bodies', async () => {
  const f = fixture();
  const summaries = Array.from({ length: 30 }, (_, i) => ({
    userIntentId: `i${i}`,
    revision: 1,
    phase: 'reconciling' as const,
    userMessageId: `u${i}`,
    assistantMessageId: `a${i}`,
    sourceSequence: i + 1,
    hasActionPlan: true,
  }));
  jest
    .mocked(f.runtime.persistence.readIntentPage)
    .mockResolvedValue(
      ready({ header: f.header, items: summaries, beforeSequence: null, hasEarlier: false }),
    );
  jest.mocked(f.runtime.persistence.readIntent).mockImplementation(async (id) =>
    ready({
      request: {
        conversationId: 'conversation',
        conversationGeneration: 0,
        message: { messageId: `u${id}`, sourceSequence: 1 },
      },
      intent: { userIntentId: id, revision: 1, phase: 'reconciling', slots: [] },
      actionPlan: { slots: [] },
      slotResults: [],
    } as unknown as StoredAssistantIntent),
  );
  jest.mocked(f.runtime.persistence.readActionRecovery).mockImplementation(async (id) =>
    ready({
      conversationId: 'conversation',
      conversationGeneration: 0,
      userIntentId: id,
      intentRevision: 1,
      phase: 'reconciling',
      slots: [{ slotId: 's', operationId: `op${id}`, outcome: 'not_executed', receipt: null }],
    }),
  );
  await f.runtime.reload();
  expect(f.runtime.persistence.readActionRecovery).toHaveBeenCalledTimes(30);
  expect(Object.keys(f.runtime.state.historyProofs ?? {})).toHaveLength(30);
  f.header.composerDraft = 'Changed draft';
  await f.runtime.reload();
  expect(f.runtime.persistence.readActionRecovery).toHaveBeenCalledTimes(30);
  expect(f.refreshRecoveryGate).not.toHaveBeenCalled();
});

test('stopping an older loaded intent clears its stale proof and reads its actual result outside the newest page', async () => {
  const f = fixture();
  const summary = {
    userIntentId: 'old',
    revision: 1,
    phase: 'ready' as const,
    userMessageId: 'u-old',
    assistantMessageId: 'a-old',
    sourceSequence: 1,
    hasActionPlan: true,
  };
  let stopped = false;
  jest
    .mocked(f.runtime.persistence.readIntentPage)
    .mockResolvedValue(
      ready({ header: f.header, items: [summary], beforeSequence: null, hasEarlier: false }),
    );
  jest.mocked(f.runtime.persistence.readIntent).mockImplementation(async () =>
    ready({
      request: {
        conversationId: 'conversation',
        conversationGeneration: 0,
        message: { messageId: 'u-old', sourceSequence: 1 },
      },
      intent: {
        userIntentId: 'old',
        revision: 1,
        phase: stopped ? 'reconciling' : 'ready',
        slots: [],
      },
      actionPlan: { slots: [] },
      slotResults: [],
    } as unknown as StoredAssistantIntent),
  );
  jest.mocked(f.runtime.persistence.readActionRecovery).mockImplementation(async () =>
    ready({
      conversationId: 'conversation',
      conversationGeneration: 0,
      userIntentId: 'old',
      intentRevision: 1,
      phase: stopped ? 'reconciling' : 'ready',
      slots: [
        {
          slotId: 's',
          operationId: 'op-old',
          outcome: stopped ? 'not_executed' : 'unresolved',
          receipt: null,
        },
      ],
    }),
  );
  await f.runtime.reload();
  const stale = f.runtime.state.historyProofs!.old;
  jest
    .mocked(f.runtime.persistence.readIntentPage)
    .mockResolvedValue(
      ready({ header: f.header, items: [], beforeSequence: null, hasEarlier: false }),
    );
  const stalePublished: boolean[] = [];
  f.runtime.subscribe(() => {
    if (f.runtime.state.conversation?.intents.old?.intent.phase === 'reconciling')
      stalePublished.push(f.runtime.state.historyProofs?.old === stale);
  });
  jest.mocked(f.core.cancel).mockImplementation(async () => {
    stopped = true;
  });
  await f.runtime.cancel('old');
  expect(stalePublished).not.toContain(true);
  expect(f.runtime.state.historyProofs?.old?.slots[0]?.outcome).toBe('not_executed');
  expect(f.runtime.persistence.readActionRecovery).toHaveBeenCalledWith('old');
  expect(f.runtime.mutationsHeld).toBe(false);
});

test('an older retained request refreshes its status when its current intent changes off-page', async () => {
  const f = fixture();
  await f.runtime.reload();
  const oldMessage: StoredConversationMessage = {
    messageId: 'older-user',
    conversationId: 'conversation',
    generation: 0,
    sequence: 1,
    role: 'user',
    text: 'Earlier question',
    status: 'failed',
    createdAt: '2026-09-28T00:00:00Z',
    referenceSets: [],
  };
  const request = {
    conversationId: 'conversation',
    conversationGeneration: 0,
    message: { messageId: 'older-user', sourceSequence: 1 },
  } as AssistantTurnRequest;
  const oldRecord = { request, intent: { revision: 1 } } as unknown as StoredAssistantIntent;
  f.runtime.state = {
    ...f.runtime.state,
    conversation: {
      ...f.runtime.state.conversation!,
      messages: [oldMessage],
      intents: { old: oldRecord },
    },
  };
  jest
    .mocked(f.runtime.persistence.readIntent)
    .mockResolvedValue(ready({ ...oldRecord, intent: { ...oldRecord.intent, revision: 2 } }));
  const base = { header: { ...f.header }, beforeSequence: null, hasEarlier: false };
  f.readConversation
    .mockResolvedValueOnce(ready({ ...base, messages: [] }))
    .mockResolvedValueOnce(ready({ ...base, messages: [{ ...oldMessage, status: 'complete' }] }));
  await f.runtime.reload();
  expect(f.readConversation).toHaveBeenCalledWith({ beforeSequence: 2, limit: 1 });
  expect(f.runtime.state.conversation?.messages[0]?.status).toBe('complete');
});

test('a late old header cannot overwrite a newer draft typed and fully persisted during refresh', async () => {
  const f = fixture();
  await f.runtime.reload();
  const stalePage: ConversationPage = {
    header: { ...f.header },
    messages: [],
    beforeSequence: null,
    hasEarlier: false,
  };
  const finalRead = deferred<RepositoryResult<ConversationPage>>();
  f.readConversation.mockResolvedValueOnce(ready(stalePage)).mockReturnValueOnce(finalRead.promise);
  const reading = f.runtime.reload();
  await tick();
  f.runtime.setDraft('Newer draft');
  await tick();
  expect(f.header.composerDraft).toBe('Newer draft');
  finalRead.resolve(ready(stalePage));
  await reading;
  expect(f.runtime.state.draft).toBe('Newer draft');
});

test('a draft already dirty at refresh start cannot be replaced by an older header after its write finishes', async () => {
  const f = fixture();
  await f.runtime.reload();
  const stalePage: ConversationPage = {
    header: { ...f.header },
    messages: [],
    beforeSequence: null,
    hasEarlier: false,
  };
  const saving = deferred<RepositoryResult<ConversationHeader>>();
  const finalRead = deferred<RepositoryResult<ConversationPage>>();
  f.saveDraft.mockImplementationOnce(() => saving.promise);
  f.runtime.setDraft('Pending local draft');
  await tick();
  f.readConversation.mockResolvedValueOnce(ready(stalePage)).mockReturnValueOnce(finalRead.promise);
  const reading = f.runtime.reload();
  await tick();
  saving.resolve(ready({ ...f.header, composerDraft: 'Pending local draft' }));
  await tick();
  finalRead.resolve(ready(stalePage));
  await reading;
  expect(f.runtime.state.draft).toBe('Pending local draft');
});
