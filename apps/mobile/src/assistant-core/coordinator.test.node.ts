import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity, catalogueBoundary } from '@cookmate/catalogue';
import {
  createCommandPreparer,
  validateReceiptSemantics,
  verifyCommandFingerprint,
} from '@cookmate/domain';
import { checkLocalCommand, matchOperationReceipt } from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  CommandResult,
  ContractError,
  ErrorResponse,
  LocalCommand,
  OperationReceipt,
} from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  CookMateQueries,
  RepositoryResult,
  StoredAssistantIntent,
  AuthorizedActionPlan,
  AssistantActionRecovery,
  AssistantActionContinuationReview,
} from '@cookmate/domain';
import type { GatewayConnection } from '../connection';
import { createAssistantCoordinator } from './coordinator';
import { AssistantCoreError } from './actions';
import { ConnectionError } from '../connection/errors';
import { current, date, guard, id, platform, response, snapshot } from './fixtures.test-support';

const ready = <Value>(value: Value): RepositoryResult<Value> => ({
  kind: 'ready',
  value,
  revision: 0,
});
const unused = async (): Promise<never> => {
  throw new Error('Unexpected fixture port call');
};
function deferred() {
  let resolve: () => void = () => {
    throw new Error('Promise was not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function errorResponse(turn: AssistantTurnRequest, error: ContractError): ErrorResponse {
  return {
    apiVersion: turn.apiVersion,
    catalogue: turn.catalogue,
    requestId: turn.requestId,
    userIntentId: turn.userIntentId,
    intentRevision: turn.intentRevision,
    conversationId: turn.conversationId,
    conversationGeneration: turn.conversationGeneration,
    connectionGeneration: turn.connectionGeneration,
    preferenceRevision: turn.context.preferences.revision,
    kind: 'error',
    error,
  };
}
function receipt(command: LocalCommand): OperationReceipt {
  return {
    schemaVersion: 1,
    operationId: command.operationId,
    userIntentId: command.userIntentId,
    payloadFingerprint: command.payloadFingerprint,
    outcome: 'committed',
    committedAt: '2026-09-28T00:00:00.000Z',
    effects: [{ kind: 'favourite', entityId: '53262', revision: 1, saved: true }],
    shoppingProjection: 'unchanged',
  };
}

/** Controlled lifecycle/receipt double; this is deliberately not a persistence implementation. */
function fixture() {
  let saved: StoredAssistantIntent | null = null;
  let acknowledged: StoredAssistantIntent | null = null;
  let acceptedInput: string | null = null;
  let preferenceRevision = 0;
  let continuationInvalidations = 0;
  const receipts = new Map<string, OperationReceipt>();
  const calls: string[] = [];
  let execute: (command: LocalCommand) => Promise<CommandResult> = async (command) => ({
    kind: 'uncertain',
    operationId: command.operationId,
  });
  function recovery(userIntentId: string): RepositoryResult<AssistantActionRecovery | null> {
    if (!saved || saved.intent.userIntentId !== userIntentId)
      return {
        kind: 'failed',
        error: { code: 'stale_context', messageKey: 'test.intent_missing', retry: 'reconcile' },
      };
    if (!saved.actionPlan) return ready(null);
    const phase = saved.intent.phase;
    return ready({
      conversationId: saved.request.conversationId,
      conversationGeneration: saved.request.conversationGeneration,
      userIntentId,
      intentRevision: saved.intent.revision,
      phase,
      slots: saved.actionPlan.slots.map((slot) => {
        const actual = receipts.get(slot.operationId);
        return {
          slotId: slot.slotId,
          operationId: slot.operationId,
          outcome: actual
            ? 'receipt'
            : ['cancelled', 'reconciling'].includes(phase)
              ? 'not_executed'
              : 'unresolved',
          receipt: actual ?? null,
        };
      }),
    });
  }
  const persistence: AssistantPersistencePort = {
    refreshRecoveryGate: unused,
    readContext: async ({ messageId, text }) => ready(snapshot(messageId, text)),
    readMemoryPage: unused,
    setWorkingContext: unused,
    readCurrentActionState: async () => ready(current()),
    readConversation: unused,
    readIntentPage: unused,
    readActionContinuationReview: async () => ready(null),
    confirmActionContinuation: unused,
    invalidateActionContinuationReview() {
      continuationInvalidations++;
    },
    async reconcileActionRecovery(userIntentId) {
      calls.push('reconcile-recovery');
      return recovery(userIntentId);
    },
    async readActionRecovery(userIntentId) {
      calls.push('recovery');
      return recovery(userIntentId);
    },
    readReferenceSets: unused,
    saveDraft: unused,
    readIntent: async () => ready(saved),
    readAcceptance: async () => ready(acknowledged),
    async beginTurn({ request }) {
      calls.push('begin');
      saved = {
        actionPlan: null,
        acceptanceEnvelope: { assistantMessageId: id(900), expectedIntentRevision: 0 },
        request,
        intent: {
          userIntentId: request.userIntentId,
          revision: 0,
          phase: 'awaiting_response',
          slots: [],
        },
        response: null,
        guards: null,
        slotResults: [],
      };
      return ready(saved);
    },
    async acceptResponse(input) {
      const { response: result, assistantMessageId } = input;
      calls.push('accept');
      if (!saved) throw new Error();
      if (acknowledged) {
        if (JSON.stringify(input) !== acceptedInput)
          return {
            kind: 'failed',
            error: {
              code: 'operation_conflict',
              messageKey: 'test.changed_acceptance',
              retry: 'never',
            },
          };
        return ready({ acknowledgement: acknowledged, replay: true });
      }
      const normalized =
        result.kind === 'error'
          ? result
          : {
              ...result,
              referenceSets: result.referenceSets.map((set) => ({
                ...set,
                messageId: assistantMessageId,
              })),
            };
      saved = {
        ...saved,
        response: normalized,
        guards: guard(),
        intent: { ...saved.intent, phase: 'confirmation' },
      };
      acknowledged = saved;
      acceptedInput = JSON.stringify(input);
      return ready({ acknowledgement: saved, replay: false });
    },
    async recordTurnFailure() {
      calls.push('failed');
      if (!saved) throw new Error();
      return ready(saved);
    },
    async rearmTurn() {
      calls.push('rearm');
      if (!saved) throw new Error();
      saved = { ...saved, intent: { ...saved.intent, phase: 'awaiting_response' } };
      return ready(saved);
    },
    async freezeActionPlan({ plan, guards }) {
      calls.push('freeze');
      if (!saved) throw new Error();
      saved = {
        ...saved,
        actionPlan: plan,
        guards,
        intent: { ...saved.intent, origin: plan.origin, phase: 'ready' },
      };
      return ready(saved);
    },
    async finalizeNextIntentSlot({ slotId }) {
      if (!saved) throw new Error();
      const plan = saved.actionPlan?.slots.find((slot) => slot.slotId === slotId);
      if (!plan) throw new Error();
      const existing = saved.intent.slots.find((slot) => slot.slotId === slotId);
      if (existing) return ready({ intent: saved, slot: existing });
      const payload =
        plan.payload.kind === 'savePreference'
          ? { ...plan.payload, expectedPreferenceRevision: preferenceRevision }
          : plan.payload;
      const prepare = createCommandPreparer(
        { ...platform(), newId: () => plan.operationId },
        catalogueBoundary,
      );
      const command = await prepare(payload, {
        userIntentId: saved.intent.userIntentId,
        intentRevision: saved.intent.revision,
        origin: saved.actionPlan!.origin,
      });
      const slot = { slotId, command };
      saved = { ...saved, intent: { ...saved.intent, slots: [...saved.intent.slots, slot] } };
      return ready({ intent: saved, slot });
    },
    async freezeIntent({ intent, guards }) {
      calls.push('freeze');
      if (!saved) throw new Error();
      saved = { ...saved, intent, guards };
      return ready(saved);
    },
    async executeIntentSlot({ slotId }) {
      if (!saved) throw new Error();
      const slot = saved.intent.slots.find((item) => item.slotId === slotId);
      if (!slot) throw new Error();
      calls.push(`execute:${slotId}`);
      const result = await execute(JSON.parse(JSON.stringify(slot.command)) as LocalCommand);
      saved = { ...saved, slotResults: [...saved.slotResults, { slotId, result }] };
      return result;
    },
    async cancelIntent() {
      calls.push('cancel');
      if (!saved) throw new Error();
      saved = { ...saved, intent: { ...saved.intent, phase: 'reconciling' } };
      return ready(saved);
    },
  };
  const connection: GatewayConnection = {
    getState: () => ({ generation: 1, status: 'paired' }),
    restore: unused,
    health: unused,
    pair: unused,
    async turn(request) {
      calls.push('turn');
      return response(request);
    },
    cancel() {
      calls.push('abort');
    },
    forget: unused,
    revokeAndForget: unused,
  };
  const queries: CookMateQueries = {
    catalogue: identity,
    readInstallationId: unused,
    readRecipe: unused,
    readFavourites: unused,
    readPlan: unused,
    readShopping: unused,
    readPreferences: unused,
    readPortableBackup: unused,
    readReceipt: async (operationId) => ready(receipts.get(operationId) ?? null),
    readDirectRecovery: unused,
    subscribe: () => () => undefined,
    subscribeRecoveryInvalidation: () => {
      throw new Error('Unexpected fixture recovery invalidation subscription');
    },
  };
  const coordinator = (commandPlatform = platform()) =>
    createAssistantCoordinator({
      persistence,
      connection,
      services: { queries },
      platform: commandPlatform,
      currentDate: () => date,
    });
  return {
    persistence,
    connection,
    queries,
    receipts,
    calls,
    coordinator,
    continuationInvalidations: () => continuationInvalidations,
    saved: () => saved!,
    setSaved: (value: StoredAssistantIntent) => {
      saved = value;
    },
    setExecute: (value: typeof execute) => {
      execute = value;
    },
    setPreferenceRevision: (value: number) => {
      preferenceRevision = value;
    },
    clearConversation: () => {
      saved = null;
      acknowledged = null;
      acceptedInput = null;
    },
  };
}

async function prepareBatch(f: ReturnType<typeof fixture>): Promise<{
  core: ReturnType<ReturnType<typeof fixture>['coordinator']>;
  intent: AuthorizedActionPlan;
}> {
  const core = f.coordinator();
  f.connection.turn = async (request) => {
    const reply = response(request);
    reply.proposals.push({
      kind: 'addPlan',
      recipeId: '53262',
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty' },
    });
    return reply;
  };
  const turn = await core.send('Save this recipe and plan dinner.');
  assert.equal(turn.kind, 'reply');
  const saved = f.saved();
  if (!saved.response || saved.response.kind !== 'proposal') throw new Error();
  const intent = await core.approve(saved.intent.userIntentId, {
    source: 'explicit_user',
    proposals: JSON.parse(JSON.stringify(saved.response.proposals)),
    replacementConfirmations: [],
  });
  return { core, intent };
}

test('coordinator persists user intent before network, stages proposal and never repeats provider success prose', async () => {
  const f = fixture();
  const result = await f.coordinator().send('Save this recipe.');
  assert.equal(result.kind, 'reply');
  assert.deepEqual(f.calls, ['begin', 'turn', 'accept']);
  if (result.kind !== 'reply' || result.response.kind !== 'proposal') return;
  assert.equal(result.actionStatus, 'not_executed');
  assert.equal(result.response.text.includes('Saved!'), false);
  assert.equal(f.saved().intent.slots.length, 0);
});

test('returned references use the app-owned persisted assistant message identity', async () => {
  const f = fixture();
  f.connection.turn = async (request) => ({
    ...response(request),
    referenceSets: [{ referenceSetId: id(70), messageId: id(888), recipeIds: ['53262'] }],
  });
  const result = await f.coordinator().send('Show that recipe.');
  assert.equal(result.kind, 'reply');
  if (result.kind !== 'reply' || result.response.kind === 'error') return;
  assert.notEqual(result.response.referenceSets[0]?.messageId, id(888));
  assert.deepEqual(result.response, f.saved().response);
});

test('late response after invalidate is discarded without accepting or executing anything', async () => {
  const f = fixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.connection.turn = async (request) => {
    entered();
    await gate;
    return response(request);
  };
  const core = f.coordinator();
  const pending = core.send('Save this recipe.');
  await started;
  core.invalidate();
  release();
  const result = await pending;
  assert.equal(result.kind, 'failed');
  assert.equal(f.calls.includes('accept'), false);
  assert.equal(
    f.calls.some((call) => call.startsWith('execute')),
    false,
  );
});

test('save success and plan failure report separate outcomes; second dispatch never replays completed save', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  f.setExecute(async (command) => {
    if (command.command.kind === 'setFavourite') {
      const proof = receipt(command);
      f.receipts.set(command.operationId, proof);
      return { kind: 'receipt', receipt: proof };
    }
    return {
      kind: 'failed',
      operationId: command.operationId,
      error: { code: 'stale_target', retry: 'after_correction', messageKey: 'test.plan_changed' },
    };
  });
  const result = await core.dispatch(intent.userIntentId);
  assert.equal(result.summary, 'partial');
  assert.deepEqual(
    result.results.slots.map((slot) => slot.result.kind),
    ['receipt', 'failed'],
  );
  assert.equal(f.calls.filter((call) => call.startsWith('execute')).length, 2);
  await core.dispatch(intent.userIntentId);
  assert.equal(f.calls.filter((call) => call.startsWith('execute')).length, 2);
});

test('uncertain effect stops later slots; restore and receipt reconciliation never execute', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  const result = await core.dispatch(intent.userIntentId);
  assert.equal(result.summary, 'uncertain');
  assert.equal(f.calls.filter((call) => call.startsWith('execute')).length, 1);
  const frozen = f.saved().intent.slots[0]!;
  f.receipts.set(
    frozen.command.operationId,
    receipt(JSON.parse(JSON.stringify(frozen.command)) as LocalCommand),
  );
  const restored = f.coordinator();
  const reconciled = await restored.reconcile(intent.userIntentId);
  assert.equal(reconciled.results.slots[0]?.result.kind, 'receipt');
  assert.equal(reconciled.results.slots[1]?.result.kind, 'uncertain');
  assert.equal(f.calls.filter((call) => call.startsWith('execute')).length, 1);
});

async function recoveryProof(
  f: ReturnType<typeof fixture>,
  userIntentId: string,
): Promise<AssistantActionRecovery> {
  const result = await f.persistence.readActionRecovery(userIntentId);
  if (result.kind !== 'ready' || !result.value)
    throw new Error('Expected controlled recovery proof');
  return JSON.parse(JSON.stringify(result.value)) as AssistantActionRecovery;
}

for (const phase of ['ready', 'dispatched'] as const) {
  test(`explicit reconciliation of active ${phase} reservations remains uncertain without absence proof`, async () => {
    const f = fixture();
    const { core, intent } = await prepareBatch(f);
    f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase } });
    const before = [...f.calls];
    const result = await core.reconcile(intent.userIntentId);
    assert.equal(result.summary, 'uncertain');
    assert.deepEqual(
      result.results.slots.map((slot) => slot.result.kind),
      ['uncertain', 'uncertain'],
    );
    assert.deepEqual(f.calls, [...before, 'reconcile-recovery']);
    assert.equal(f.saved().intent.phase, phase);
    assert.equal(f.saved().intent.slots.length, 0);
  });
}

for (const phase of ['cancelled', 'reconciling'] as const) {
  test(`durable ${phase} absence proof resolves earlier uncertainty and an unfinalized reservation without execution`, async () => {
    const f = fixture();
    const { core, intent } = await prepareBatch(f);
    const finalized = await f.persistence.finalizeNextIntentSlot({
      userIntentId: intent.userIntentId,
      expectedIntentRevision: intent.revision,
      slotId: intent.slots[0]!.slotId,
    });
    if (finalized.kind !== 'ready') throw new Error();
    f.setSaved({
      ...f.saved(),
      intent: { ...f.saved().intent, phase },
      slotResults: [
        {
          slotId: intent.slots[0]!.slotId,
          result: { kind: 'uncertain', operationId: intent.slots[0]!.operationId },
        },
      ],
    });
    const before = [...f.calls];
    const result = await core.reconcile(intent.userIntentId);
    assert.equal(result.summary, 'failed');
    for (const slot of result.results.slots) {
      assert.equal(slot.result.kind, 'failed');
      if (slot.result.kind === 'failed') {
        assert.equal(slot.result.error.code, 'cancelled');
        assert.equal(slot.result.error.messageKey, 'assistant.not_dispatched');
      }
    }
    assert.deepEqual(f.calls, [...before, 'reconcile-recovery']);
    assert.equal(f.saved().intent.slots.length, 1);
  });
}

test('recovery preserves an exact historical receipt while proving the remaining reservation was not executed', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  const finalized = await f.persistence.finalizeNextIntentSlot({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
    slotId: intent.slots[0]!.slotId,
  });
  if (finalized.kind !== 'ready') throw new Error();
  const command = JSON.parse(JSON.stringify(finalized.value.slot.command)) as LocalCommand;
  const actual = receipt(command);
  f.receipts.set(command.operationId, actual);
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
  f.queries.readReceipt = unused; // Recovery uses the serialized proof; dispatch keeps its own checks.
  const before = [...f.calls];
  const result = await core.reconcile(intent.userIntentId);
  assert.equal(result.summary, 'partial');
  assert.deepEqual(result.results.slots[0]?.result, { kind: 'receipt', receipt: actual });
  assert.equal(result.results.slots[1]?.result.kind, 'failed');
  assert.deepEqual(f.calls, [...before, 'reconcile-recovery']);
});

test('null, malformed and mismatched recovery snapshots cannot fabricate successful or absent effects', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
  const valid = await recoveryProof(f, intent.userIntentId);
  const cases: unknown[] = [
    null,
    [],
    {},
    { ...valid, conversationId: id(900) },
    { ...valid, conversationGeneration: valid.conversationGeneration + 1 },
    { ...valid, userIntentId: id(901) },
    { ...valid, intentRevision: valid.intentRevision + 1 },
    { ...valid, phase: 'ready' },
    { ...valid, slots: null },
    { ...valid, slots: [] },
    { ...valid, slots: [...valid.slots].reverse() },
    { ...valid, slots: [valid.slots[0], valid.slots[0]] },
    { ...valid, slots: [{ ...valid.slots[0], operationId: id(902) }, valid.slots[1]] },
    { ...valid, slots: [null, valid.slots[1]] },
    {
      ...valid,
      slots: [
        {
          slotId: valid.slots[0]!.slotId,
          operationId: valid.slots[0]!.operationId,
          outcome: 'not_executed',
        },
        valid.slots[1],
      ],
    },
    { ...valid, slots: [{ ...valid.slots[0], outcome: 'unknown' }, valid.slots[1]] },
    {
      ...valid,
      slots: [{ ...valid.slots[0], outcome: 'unresolved', receipt: {} }, valid.slots[1]],
    },
    { ...valid, slots: [{ ...valid.slots[0], receipt: {} }, valid.slots[1]] },
  ];
  const before = [...f.calls];
  for (const candidate of cases) {
    // Deliberately malformed JSON at the injected boundary; no production fallback is supplied.
    f.persistence.reconcileActionRecovery = async () =>
      ready(JSON.parse(JSON.stringify(candidate)));
    await assert.rejects(
      core.reconcile(intent.userIntentId),
      (error: unknown) =>
        error instanceof AssistantCoreError && error.detail.code === 'stale_context',
    );
  }
  assert.deepEqual(f.calls, before);
  assert.equal(f.saved().intent.slots.length, 0);
});

test('active-phase absence, storage failure and phase drift reject recovery without a retry loop', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  const proof = await recoveryProof(f, intent.userIntentId);
  for (const slot of proof.slots) slot.outcome = 'not_executed';
  let reads = 0;
  f.persistence.reconcileActionRecovery = async () => {
    reads++;
    return ready(proof);
  };
  await assert.rejects(core.reconcile(intent.userIntentId), AssistantCoreError);
  assert.equal(reads, 1);
  f.persistence.reconcileActionRecovery = async () => {
    reads++;
    return {
      kind: 'failed',
      error: { code: 'storage_failure', messageKey: 'test.recovery_failed', retry: 'reconcile' },
    };
  };
  await assert.rejects(
    core.reconcile(intent.userIntentId),
    (error: unknown) =>
      error instanceof AssistantCoreError && error.detail.code === 'storage_failure',
  );
  assert.equal(reads, 2);
  f.persistence.reconcileActionRecovery = async () => {
    reads++;
    f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
    return ready(proof); // A proof of the previous phase cannot match the fresh intent.
  };
  await assert.rejects(
    core.reconcile(intent.userIntentId),
    (error: unknown) =>
      error instanceof AssistantCoreError && error.detail.code === 'stale_context',
  );
  assert.equal(reads, 3);
  assert.equal(
    f.calls.some((call) => call.startsWith('execute')),
    false,
  );
});

test('receipt proof requires an exact frozen command, valid receipt semantics and matching operation fingerprint', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  const finalized = await f.persistence.finalizeNextIntentSlot({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
    slotId: intent.slots[0]!.slotId,
  });
  if (finalized.kind !== 'ready') throw new Error();
  const command = JSON.parse(JSON.stringify(finalized.value.slot.command)) as LocalCommand;
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
  const valid = await recoveryProof(f, intent.userIntentId);
  const actual = receipt(command);
  const alteredReceipts: (OperationReceipt | null)[] = [
    null,
    { ...actual, operationId: id(903) },
    { ...actual, userIntentId: id(904) },
    { ...actual, payloadFingerprint: 'f'.repeat(64) },
    { ...actual, committedAt: 'invalid' },
    { ...actual, effects: [{ kind: 'favourite', entityId: '99999999', revision: 1, saved: true }] },
  ];
  for (const altered of alteredReceipts) {
    f.persistence.reconcileActionRecovery = async () =>
      ready({
        ...valid,
        slots: [{ ...valid.slots[0]!, outcome: 'receipt', receipt: altered }, valid.slots[1]!],
      });
    await assert.rejects(
      core.reconcile(intent.userIntentId),
      (error: unknown) =>
        error instanceof AssistantCoreError && error.detail.code === 'operation_conflict',
    );
  }
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, slots: [] } });
  f.persistence.reconcileActionRecovery = async () =>
    ready({
      ...valid,
      slots: [{ ...valid.slots[0]!, outcome: 'receipt', receipt: actual }, valid.slots[1]!],
    });
  await assert.rejects(
    core.reconcile(intent.userIntentId),
    (error: unknown) =>
      error instanceof AssistantCoreError && error.detail.code === 'operation_conflict',
  );
});

async function mismatchedReceiptFixture(field: 'operationId' | 'userIntentId') {
  const f = fixture();
  const core = f.coordinator();
  await core.send('Save this recipe.');
  const saved = f.saved();
  if (!saved.response || saved.response.kind !== 'proposal') throw new Error();
  const intent = await core.approve(saved.intent.userIntentId, {
    source: 'explicit_user',
    proposals: JSON.parse(JSON.stringify(saved.response.proposals)),
    replacementConfirmations: [],
  });
  const reservation = intent.slots[0]!;
  const finalized = await f.persistence.finalizeNextIntentSlot({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
    slotId: reservation.slotId,
  });
  if (finalized.kind !== 'ready') throw new Error();
  const prepare = createCommandPreparer(
    {
      ...platform(),
      newId: () => (field === 'operationId' ? id(950) : reservation.operationId),
    },
    catalogueBoundary,
  );
  const command = await prepare(finalized.value.slot.command.command, {
    userIntentId: field === 'userIntentId' ? id(951) : intent.userIntentId,
    intentRevision: intent.revision,
    origin: intent.origin,
  });
  const actual = receipt(command);
  assert.equal(checkLocalCommand(command, catalogueBoundary).ok, true);
  assert.equal(await verifyCommandFingerprint(command, platform()), true);
  assert.equal(validateReceiptSemantics(actual, catalogueBoundary), true);
  assert.equal(matchOperationReceipt(command, actual), 'existing');
  // Keep the app reservation intact while injecting a separately valid command/receipt pair.
  f.setSaved({
    ...f.saved(),
    intent: { ...f.saved().intent, slots: [{ slotId: reservation.slotId, command }] },
  });
  return { f, core, intent, reservation, command, actual };
}

for (const field of ['operationId', 'userIntentId'] as const) {
  test(`recovery rejects a valid command and matching receipt whose ${field} contradicts the reservation`, async () => {
    const { f, core, intent, reservation, actual } = await mismatchedReceiptFixture(field);
    f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
    f.receipts.set(reservation.operationId, actual);
    const proof = await recoveryProof(f, intent.userIntentId);
    assert.equal(proof.userIntentId, intent.userIntentId);
    assert.equal(proof.slots[0]?.operationId, reservation.operationId);
    assert.deepEqual(proof.slots[0]?.receipt, actual);
    const before = [...f.calls];
    await assert.rejects(
      core.reconcile(intent.userIntentId),
      (error: unknown) =>
        error instanceof AssistantCoreError && error.detail.code === 'operation_conflict',
    );
    assert.deepEqual(f.calls, [...before, 'reconcile-recovery']);
  });

  test(`dispatch summary rejects a valid command and matching receipt whose ${field} contradicts the reservation`, async () => {
    const { f, core, intent, command, actual } = await mismatchedReceiptFixture(field);
    f.receipts.set(command.operationId, actual);
    const before = [...f.calls];
    const result = await core.dispatch(intent.userIntentId);
    assert.equal(result.summary, 'invalid');
    assert.deepEqual(f.calls, before);
  });
}

test('contradictory absence proof cannot turn a remembered receipt into not-dispatched', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  const finalized = await f.persistence.finalizeNextIntentSlot({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
    slotId: intent.slots[0]!.slotId,
  });
  if (finalized.kind !== 'ready') throw new Error();
  const actual = receipt(JSON.parse(JSON.stringify(finalized.value.slot.command)) as LocalCommand);
  f.setSaved({
    ...f.saved(),
    intent: { ...f.saved().intent, phase: 'reconciling' },
    slotResults: [
      { slotId: intent.slots[0]!.slotId, result: { kind: 'receipt', receipt: actual } },
    ],
  });
  await assert.rejects(
    core.reconcile(intent.userIntentId),
    (error: unknown) =>
      error instanceof AssistantCoreError && error.detail.code === 'stale_context',
  );
  assert.equal(
    f.calls.some((call) => call.startsWith('execute')),
    false,
  );
});

test('clear while the serialized recovery proof is pending discards the captured historical result', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
  const readProof = f.persistence.reconcileActionRecovery;
  const entered = deferred();
  const release = deferred();
  f.persistence.reconcileActionRecovery = async (userIntentId) => {
    const captured = await readProof(userIntentId);
    entered.resolve();
    await release.promise;
    return captured;
  };
  const pending = core.reconcile(intent.userIntentId);
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof AssistantCoreError && error.detail.code === 'cancelled',
  );
  await entered.promise;
  core.invalidate();
  f.clearConversation();
  release.resolve();
  await rejected;
  assert.equal(
    f.calls.some((call) => call.startsWith('execute')),
    false,
  );
});

test('cancel after dispatch retains actual receipt and prevents next slot', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setExecute(async (command) => {
    const proof = receipt(command);
    f.receipts.set(command.operationId, proof);
    entered();
    await gate;
    return { kind: 'receipt', receipt: proof };
  });
  const pending = core.dispatch(intent.userIntentId);
  await started;
  await core.cancel(intent.userIntentId);
  release();
  const result = await pending;
  assert.equal(result.summary, 'partial');
  assert.equal(result.results.slots[0]?.result.kind, 'receipt');
  assert.equal(result.results.slots[1]?.result.kind, 'failed');
  assert.equal(f.calls.filter((call) => call.startsWith('execute')).length, 1);
});

test('foreign receipt or storage failure cannot become success', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  f.setExecute(async (command) => ({
    kind: 'receipt',
    receipt: { ...receipt(command), operationId: id(999) },
  }));
  const result = await core.dispatch(intent.userIntentId);
  assert.equal(result.summary, 'uncertain');
  assert.equal(
    result.results.slots.some((slot) => slot.result.kind === 'receipt'),
    false,
  );
});

test('narrowing happens before begin or network and exposes deliberate working-context recovery', async () => {
  const f = fixture();
  const state = snapshot();
  f.persistence.readContext = async () => ({
    kind: 'narrowing',
    revision: 4,
    reason: 'pending_evidence',
    coverage: { ...state.memory.coverage, selectionStatus: 'narrowing_required' },
    workingContext: state.memory.workingContext,
  });
  const core = f.coordinator();
  assert.equal((await core.send('New brief')).kind, 'narrowing');
  assert.deepEqual(f.calls, []);
  f.persistence.setWorkingContext = async () => ({
    kind: 'failed',
    error: { code: 'stale_context', messageKey: 'test.stale', retry: 'after_correction' },
  });
  await core.setWorkingContext({
    expectedContextRevision: 4,
    afterSequence: 40,
    carryMemoryIds: [],
  });
  assert.deepEqual(f.calls, []);
  f.persistence.setWorkingContext = async (input) =>
    ready({
      conversationId: id(1),
      generation: 0,
      revision: input.expectedContextRevision + 1,
      composerDraft: 'New brief',
      nextSequence: 41,
    });
  await core.setWorkingContext({
    expectedContextRevision: 4,
    afterSequence: 40,
    carryMemoryIds: [id(71)],
  });
  assert.deepEqual(f.calls, ['abort']);
});

test('lost acceptance acknowledgement retries the same envelope and returns historical acknowledgement after reopen', async () => {
  const f = fixture();
  const accept = f.persistence.acceptResponse;
  let loseAck = true;
  const inputs: Parameters<typeof accept>[0][] = [];
  f.persistence.acceptResponse = async (input) => {
    inputs.push(JSON.parse(JSON.stringify(input)) as typeof input);
    const result = await accept(input);
    if (loseAck) {
      loseAck = false;
      throw new Error('commit acknowledgement lost');
    }
    return result;
  };
  const failed = await f.coordinator().send('Save recipe');
  assert.equal(failed.kind, 'failed');
  if (failed.kind !== 'failed' || !failed.acceptanceRetry) throw new Error();
  assert.equal(f.calls.includes('failed'), false);
  const acceptedId = f.saved().acceptanceEnvelope.assistantMessageId;
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'cancelled' } });
  const reopened = f.coordinator();
  const replay = await reopened.retryAcceptance(
    failed.acceptanceRetry.userIntentId,
    failed.acceptanceRetry.response,
  );
  assert.equal(replay.kind, 'reply');
  if (replay.kind === 'reply') assert.equal(replay.historicalAcknowledgement, true);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(inputs[1]?.assistantMessageId, acceptedId);
  assert.equal(f.saved().intent.phase, 'cancelled');
  assert.equal((await reopened.readAcceptance(failed.acceptanceRetry.userIntentId))?.kind, 'reply');
  const altered = { ...failed.acceptanceRetry.response, text: 'Changed text' };
  const rejected = await reopened.retryAcceptance(failed.acceptanceRetry.userIntentId, altered);
  assert.equal(rejected.kind, 'failed');
  assert.equal(f.calls.filter((call) => call === 'turn').length, 1);
});

test('explicit provider retry keeps frozen IDs and context, while accepted replay performs no provider call', async () => {
  const f = fixture();
  const seen: string[] = [];
  f.connection.turn = async (request) => {
    seen.push(JSON.stringify(request));
    if (seen.length === 1)
      throw new ConnectionError({
        code: 'network_unavailable',
        messageKey: 'test.offline',
        retry: 'after_reconnect',
      });
    return response(request);
  };
  const core = f.coordinator();
  const failed = await core.send('Retry this exact request');
  if (failed.kind !== 'failed' || !failed.userIntentId) throw new Error();
  const envelope = f.saved().acceptanceEnvelope;
  assert.equal((await core.retryTurn(failed.userIntentId)).kind, 'reply');
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.deepEqual(f.saved().acceptanceEnvelope, envelope);
  assert.equal((await core.retryTurn(failed.userIntentId)).kind, 'reply');
  assert.equal(seen.length, 2);
  assert.equal(f.calls.filter((call) => call === 'begin').length, 1);
});

test('sequential preference commands use Data actual revision after each durable receipt, including no-op', async () => {
  const f = fixture();
  f.connection.turn = async (request) => ({
    ...response(request),
    proposals: [
      { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
      { kind: 'savePreference', type: 'cuisine', explicitValue: 'French' },
    ],
  });
  const core = f.coordinator();
  await core.send('Save both preferences');
  const saved = f.saved();
  if (saved.response?.kind !== 'proposal') throw new Error();
  const plan = await core.approve(saved.intent.userIntentId, {
    source: 'explicit_user',
    proposals: JSON.parse(JSON.stringify(saved.response.proposals)),
    replacementConfirmations: [],
  });
  const revisions: number[] = [];
  f.setExecute(async (command) => {
    if (command.command.kind !== 'savePreference') throw new Error();
    revisions.push(command.command.expectedPreferenceRevision);
    const proof: OperationReceipt = {
      ...receipt(command),
      outcome: revisions.length === 1 ? 'no_op' : 'committed',
      effects: [{ kind: 'preference', entityId: command.command.preferenceId, revision: 0 }],
    };
    f.receipts.set(command.operationId, proof);
    // First is a no-op: the global revision remains zero, not an assumed +1.
    f.setPreferenceRevision(revisions.length === 1 ? 0 : 1);
    return { kind: 'receipt', receipt: proof };
  });
  assert.equal((await core.dispatch(plan.userIntentId)).summary, 'complete');
  assert.deepEqual(revisions, [0, 0]);
  await core.dispatch(plan.userIntentId);
  assert.deepEqual(revisions, [0, 0]);
  assert.deepEqual(
    f.saved().intent.slots.map((slot) => slot.command.operationId),
    plan.slots.map((slot) => slot.operationId),
  );
});

test('Data rejecting deferred finalization stops remaining actions without guessing a revision', async () => {
  const f = fixture();
  const { core, intent } = await prepareBatch(f);
  f.persistence.finalizeNextIntentSlot = async () => ({
    kind: 'failed',
    error: { code: 'stale_context', messageKey: 'test.changed', retry: 'after_correction' },
  });
  const result = await core.dispatch(intent.userIntentId);
  assert.equal(result.summary, 'failed');
  assert.equal(
    f.calls.some((call) => call.startsWith('execute')),
    false,
  );
});

for (const method of ['retryTurn', 'readAcceptance'] as const) {
  test(`clear during ${method} acknowledgement read cannot return the captured historical reply`, async () => {
    const f = fixture();
    const core = f.coordinator();
    await core.send('Save recipe');
    const intentId = f.saved().intent.userIntentId;
    const read = f.persistence.readAcceptance;
    const entered = deferred();
    const release = deferred();
    f.persistence.readAcceptance = async (userIntentId) => {
      const captured = await read(userIntentId);
      entered.resolve();
      await release.promise;
      return captured;
    };
    const pending = core[method](intentId);
    const checked =
      method === 'readAcceptance'
        ? assert.rejects(
            pending,
            (error: unknown) => error instanceof Error && error.message === 'assistant.cancelled',
          )
        : pending.then((result) => {
            assert.equal(result?.kind, 'failed');
            if (result?.kind === 'failed') assert.equal(result.error.code, 'cancelled');
          });
    await entered.promise;
    core.invalidate();
    f.clearConversation();
    release.resolve();
    await checked;
    assert.deepEqual(f.calls, ['begin', 'turn', 'accept', 'abort']);
  });
}

test('valid provider ErrorResponse journals the exact error without acceptance or acceptance retry', async () => {
  const f = fixture();
  const error: ContractError = {
    code: 'provider_unavailable',
    retry: 'after_delay',
    messageKey: 'test.provider_unavailable',
    retryAfterSeconds: 15,
  };
  const journal = f.persistence.recordTurnFailure;
  const recorded: ContractError[] = [];
  f.persistence.recordTurnFailure = async (input) => {
    recorded.push(input.error);
    return journal(input);
  };
  f.connection.turn = async (request) => {
    f.calls.push('turn');
    return errorResponse(request, error);
  };
  const result = await f.coordinator().send('Show a recipe');
  assert.equal(result.kind, 'failed');
  if (result.kind !== 'failed') throw new Error();
  assert.deepEqual(result.error, error);
  assert.equal(result.acceptanceRetry, undefined);
  assert.deepEqual(recorded, [error]);
  assert.deepEqual(f.calls, ['begin', 'turn', 'failed']);
  assert.equal(f.saved().response, null);
});

for (const field of ['context.token_limit', 'context.byte_limit'] as const) {
  test(`${field} returns narrowing from fresh authority after journaling, without resending the original turn`, async () => {
    const f = fixture();
    const error: ContractError = {
      code: 'too_large',
      retry: 'after_correction',
      messageKey: 'test.budget',
      field,
    };
    const selection = {
      reference: { referenceSetId: id(70), ordinal: 2 },
      selectedPlacement: { actualDate: '2026-10-01', mealKey: 'dinner' as const },
    };
    const reads: Parameters<AssistantPersistencePort['readContext']>[0][] = [];
    const journal = f.persistence.recordTurnFailure;
    let journaled = false;
    let original = '';
    f.persistence.recordTurnFailure = async (input) => {
      assert.deepEqual(input.error, error);
      const result = await journal(input);
      journaled = true;
      return result;
    };
    f.persistence.readContext = async (input) => {
      reads.push(input);
      const fresh = snapshot(input.messageId, input.text);
      fresh.referenceSets = [
        { referenceSetId: id(70), messageId: id(71), recipeIds: ['53262', '52765'] },
      ];
      if (reads.length === 2) {
        assert.equal(journaled, true);
        const sent = f.saved().request.message;
        fresh.contextRevision = 8;
        fresh.currentMessage.sourceSequence = sent.sourceSequence + 1;
        fresh.memory.baseContextRevision = 8;
        fresh.memory.projectionRevision = 3;
        fresh.memory.pendingSources = [
          {
            sourceMessageId: sent.messageId,
            quote: sent.text,
            sourceSequence: sent.sourceSequence,
            sourceDateContext: { ...sent.sourceDateContext },
            preferenceRevisionAtSource: sent.preferenceRevisionAtSource,
            preferenceLinks: [],
          },
        ];
        fresh.memory.reviewTargetMessageIds = [sent.messageId, input.messageId];
        fresh.memory.coverage = {
          ...fresh.memory.coverage,
          pendingUserSourceCount: 2,
          pendingWorkingSourceCount: 2,
          suppliedReviewTargetCount: 2,
        };
        fresh.memory.workingContext = { afterSequence: 90, carryMemoryIds: [] };
      }
      return ready(fresh);
    };
    f.connection.turn = async (request) => {
      f.calls.push('turn');
      original = JSON.stringify(request);
      if (field === 'context.byte_limit') throw new ConnectionError(error);
      return errorResponse(request, error);
    };
    const result = await f.coordinator().send('Use that second recipe for dinner', selection);
    assert.equal(result.kind, 'narrowing');
    if (result.kind !== 'narrowing') throw new Error();
    assert.equal(result.reason, field === 'context.token_limit' ? 'token_limit' : 'byte_limit');
    assert.equal(result.revision, 8);
    assert.equal(result.coverage.pendingWorkingSourceCount, 2);
    assert.deepEqual(result.workingContext, { afterSequence: 90, carryMemoryIds: [] });
    assert.equal(reads.length, 2);
    assert.deepEqual(reads[1]?.selection, selection);
    assert.equal(reads[1]?.text, f.saved().request.message.text);
    assert.notEqual(reads[1]?.messageId, f.saved().request.message.messageId);
    assert.equal(JSON.stringify(f.saved().request), original);
    assert.deepEqual(f.calls, ['begin', 'turn', 'failed']);
  });
}

test('budget recovery preserves Data narrowing and derives retry selection only from frozen resolved fields', async () => {
  const f = fixture();
  const core = f.coordinator();
  f.connection.turn = async () => {
    throw new ConnectionError({
      code: 'network_unavailable',
      retry: 'after_reconnect',
      messageKey: 'test.offline',
    });
  };
  const first = await core.send('Use this recipe', {
    selectedRecipeId: '53262',
    selectedPlacement: { actualDate: '2026-10-01', mealKey: 'dinner' },
  });
  if (first.kind !== 'failed' || !first.userIntentId) throw new Error();
  const original = JSON.stringify(f.saved().request);
  const fresh = {
    kind: 'narrowing' as const,
    revision: 9,
    reason: 'pending_evidence' as const,
    coverage: { ...snapshot().memory.coverage, selectionStatus: 'narrowing_required' as const },
    workingContext: { afterSequence: 80, carryMemoryIds: [] },
  };
  f.connection.turn = async (request) =>
    errorResponse(request, {
      code: 'too_large',
      retry: 'after_correction',
      messageKey: 'test.budget',
      field: 'context.token_limit',
    });
  f.persistence.readContext = async (input) => {
    assert.deepEqual(input.selection, {
      selectedRecipeId: '53262',
      selectedPlacement: { actualDate: '2026-10-01', mealKey: 'dinner' },
    });
    assert.notEqual(input.messageId, f.saved().request.message.messageId);
    return fresh;
  };
  assert.deepEqual(await core.retryTurn(first.userIntentId), fresh);
  assert.equal(JSON.stringify(f.saved().request), original);
  assert.equal(f.calls.filter((call) => call === 'begin').length, 1);
  assert.equal(f.calls.includes('accept'), false);
});

test('clear during the budget recovery read discards the captured next-brief context', async () => {
  const f = fixture();
  const read = f.persistence.readContext;
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  f.persistence.readContext = async (input) => {
    const value = await read(input);
    if (++reads === 2) {
      entered.resolve();
      await release.promise;
    }
    return value;
  };
  f.connection.turn = async (request) =>
    errorResponse(request, {
      code: 'too_large',
      retry: 'after_correction',
      messageKey: 'test.budget',
      field: 'context.token_limit',
    });
  const core = f.coordinator();
  const pending = core.send('Use this recipe');
  await entered.promise;
  core.invalidate();
  f.clearConversation();
  release.resolve();
  const result = await pending;
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.error.code, 'cancelled');
  assert.equal(f.calls.includes('accept'), false);
});

test('budget journal failure does not preview an unrecorded next brief', async () => {
  const f = fixture();
  let reads = 0;
  const read = f.persistence.readContext;
  f.persistence.readContext = (input) => {
    reads++;
    return read(input);
  };
  f.persistence.recordTurnFailure = async () => ({
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'test.storage', retry: 'reconcile' },
  });
  f.connection.turn = async (request) =>
    errorResponse(request, {
      code: 'too_large',
      retry: 'after_correction',
      messageKey: 'test.budget',
      field: 'context.byte_limit',
    });
  const result = await f.coordinator().send('Use this recipe');
  assert.equal(result.kind, 'failed');
  assert.equal(reads, 1);
  assert.equal(f.calls.includes('accept'), false);
});

function copyContinuationReview(
  review: AssistantActionContinuationReview,
): AssistantActionContinuationReview {
  return JSON.parse(JSON.stringify(review)) as AssistantActionContinuationReview;
}

function continuationReceipt(command: LocalCommand): OperationReceipt {
  if (command.command.kind !== 'addPlan') return receipt(command);
  return {
    ...receipt(command),
    effects: [
      {
        kind: 'plan',
        entityId: command.command.occurrenceId,
        revision: 1,
        change: 'added',
        recipeId: command.command.recipeId,
        placement: command.command.placement,
      },
    ],
  };
}

/** Data eligibility/admission is controlled evidence here, not a second transaction implementation. */
async function continuationFixture(
  cursor: 0 | 1 = 0,
  commandState: AssistantActionContinuationReview['slot']['commandState'] = 'frozen',
) {
  const f = fixture();
  const { intent } = await prepareBatch(f);
  for (const reservation of intent.slots.slice(0, cursor + (commandState === 'frozen' ? 1 : 0))) {
    const finalized = await f.persistence.finalizeNextIntentSlot({
      userIntentId: intent.userIntentId,
      expectedIntentRevision: intent.revision,
      slotId: reservation.slotId,
    });
    if (finalized.kind !== 'ready') throw new Error('Expected frozen continuation slot');
  }
  const prefixReceipts = f
    .saved()
    .intent.slots.slice(0, cursor)
    .map((slot) => {
      const command = JSON.parse(JSON.stringify(slot.command)) as LocalCommand;
      const actual = continuationReceipt(command);
      f.receipts.set(command.operationId, actual);
      return { slotId: slot.slotId, receipt: actual };
    });
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'reconciling' } });
  const reservation = intent.slots[cursor]!;
  const frozen = f.saved().intent.slots[cursor];
  const prepare = createCommandPreparer(
    { ...platform(), newId: () => reservation.operationId },
    catalogueBoundary,
  );
  // A prospective descriptor has canonical bytes but no persisted command slot.
  const command = frozen
    ? (JSON.parse(JSON.stringify(frozen.command)) as LocalCommand)
    : await prepare(
        reservation.payload.kind === 'savePreference'
          ? {
              ...reservation.payload,
              expectedPreferenceRevision: f.saved().guards!.preferenceRevision,
            }
          : reservation.payload,
        {
          userIntentId: intent.userIntentId,
          intentRevision: intent.revision,
          origin: intent.origin,
        },
      );
  const review: AssistantActionContinuationReview = {
    reviewToken: 'test-current-store-review',
    cursor,
    slot: { slotId: reservation.slotId, command, commandState },
    prefixReceipts,
    state: current(),
    catalogue: { ...identity },
  };
  f.persistence.readActionContinuationReview = async () => {
    f.calls.push('continuation:read');
    return ready(copyContinuationReview(review));
  };
  f.persistence.confirmActionContinuation = async ({ review: selected }) => {
    f.calls.push('continuation:confirm');
    return { kind: 'uncertain', operationId: selected.slot.command.operationId };
  };
  // Setup is complete. A continuation must not reuse approval, ordinary dispatch or the provider.
  f.persistence.beginTurn = unused;
  f.persistence.acceptResponse = unused;
  f.persistence.rearmTurn = unused;
  f.persistence.freezeActionPlan = unused;
  f.persistence.freezeIntent = unused;
  f.persistence.finalizeNextIntentSlot = unused;
  f.persistence.executeIntentSlot = unused;
  f.connection.turn = unused;
  const commandPlatform = {
    ...platform(),
    newId: (): string => {
      throw new Error('A continuation cannot allocate a replacement identity');
    },
  };
  return { f, intent, review, commandPlatform, core: f.coordinator(commandPlatform) };
}

const coreError = (code: ContractError['code']) => (error: unknown) =>
  error instanceof AssistantCoreError && error.detail.code === code;

test('explicit reconciliation settles metadata before reloading the unchanged original intent and full plan', async () => {
  const { f, core, intent, review } = await continuationFixture();
  f.setSaved({ ...f.saved(), intent: { ...f.saved().intent, phase: 'dispatched' } });
  const originalPlan = JSON.stringify(f.saved().actionPlan);
  const originalSlots = JSON.stringify(f.saved().intent.slots);
  const attempt: CommandResult = {
    kind: 'failed',
    operationId: review.slot.command.operationId,
    error: { code: 'storage_failure', messageKey: 'test.original_failure', retry: 'reconcile' },
  };
  const order: string[] = [];
  const readProof = f.persistence.readActionRecovery;
  const readIntent = f.persistence.readIntent;
  f.persistence.readActionRecovery = unused;
  f.persistence.reconcileActionRecovery = async (userIntentId) => {
    order.push('settle');
    f.setSaved({
      ...f.saved(),
      intent: { ...f.saved().intent, phase: 'reconciling' },
      slotResults: [{ slotId: review.slot.slotId, result: attempt }],
    });
    const proof = await readProof(userIntentId);
    // Store metadata advancement is independent of the original intent revision.
    return proof.kind === 'ready' ? { ...proof, revision: 37 } : proof;
  };
  f.persistence.readIntent = async (userIntentId) => {
    order.push('reload');
    return readIntent(userIntentId);
  };
  f.connection.getState = () => ({ status: 'unpaired', generation: 2 });
  const result = await core.reconcile(intent.userIntentId);
  assert.deepEqual(order, ['settle', 'reload']);
  assert.equal(result.summary, 'failed');
  assert.deepEqual(result.results.slots[0], { slotId: review.slot.slotId, result: attempt });
  assert.equal(result.results.slots[1]?.result.kind, 'failed');
  assert.equal(result.results.slots.length, intent.slots.length);
  assert.equal(f.saved().intent.revision, intent.revision);
  assert.equal(JSON.stringify(f.saved().actionPlan), originalPlan);
  assert.equal(JSON.stringify(f.saved().intent.slots), originalSlots);
  assert.equal(f.calls.includes('continuation:confirm'), false);
});

test('reconciliation owns the returned proof before the later saved-intent await', async () => {
  const { f, core, intent } = await continuationFixture();
  const proof = await recoveryProof(f, intent.userIntentId);
  f.persistence.reconcileActionRecovery = async () => ready(proof);
  const readIntent = f.persistence.readIntent;
  f.persistence.readIntent = async (userIntentId) => {
    proof.slots.reverse();
    return readIntent(userIntentId);
  };
  const result = await core.reconcile(intent.userIntentId);
  assert.deepEqual(
    result.results.slots.map((slot) => slot.slotId),
    intent.slots.map((slot) => slot.slotId),
  );
  assert.equal(result.summary, 'failed');
});

test('a fresh saved-intent mismatch cannot be merged with the earlier settlement proof', async () => {
  const { f, core, intent } = await continuationFixture();
  const proof = await recoveryProof(f, intent.userIntentId);
  const saved = f.saved();
  const changed: StoredAssistantIntent[] = [
    { ...saved, intent: { ...saved.intent, userIntentId: id(990) } },
    { ...saved, intent: { ...saved.intent, revision: saved.intent.revision + 1 } },
    { ...saved, request: { ...saved.request, conversationId: id(991) } },
    {
      ...saved,
      request: {
        ...saved.request,
        conversationGeneration: saved.request.conversationGeneration + 1,
      },
    },
    { ...saved, intent: { ...saved.intent, phase: 'cancelled' } },
    {
      ...saved,
      actionPlan: { ...saved.actionPlan!, slots: [...saved.actionPlan!.slots].reverse() },
    },
    { ...saved, actionPlan: { ...saved.actionPlan!, slots: saved.actionPlan!.slots.slice(0, 1) } },
  ];
  for (const candidate of changed) {
    f.persistence.reconcileActionRecovery = async () => {
      f.setSaved(candidate);
      return ready(proof);
    };
    await assert.rejects(core.reconcile(intent.userIntentId), coreError('stale_context'));
  }
  f.setSaved(saved);
  f.persistence.reconcileActionRecovery = async () => ready(proof);
  assert.equal((await core.reconcile(intent.userIntentId)).summary, 'failed');
});

for (const entry of ['reconcile', 'dispatch'] as const) {
  test(`${entry} recovery owns one exclusive guard and rejects overlapping reconcile, dispatch and confirmation`, async () => {
    const { f, core, intent, review } = await continuationFixture();
    const entered = deferred();
    const release = deferred();
    const readProof = f.persistence.readActionRecovery;
    let settlements = 0;
    f.persistence.reconcileActionRecovery = async (userIntentId) => {
      settlements++;
      entered.resolve();
      await release.promise;
      return readProof(userIntentId);
    };
    const pending = core[entry](intent.userIntentId);
    await entered.promise;
    await assert.rejects(core.reconcile(intent.userIntentId), coreError('already_pending'));
    await assert.rejects(core.dispatch(intent.userIntentId), coreError('already_pending'));
    await assert.rejects(
      core.confirmActionContinuation({ source: 'explicit_user', review }),
      coreError('already_pending'),
    );
    release.resolve();
    assert.equal((await pending).summary, 'failed');
    assert.equal(settlements, 1);
    assert.equal((await core.reconcile(intent.userIntentId)).summary, 'failed');
    assert.equal(settlements, 2);
    assert.equal(f.calls.includes('continuation:confirm'), false);
  });

  for (const boundary of ['settlement', 'reload'] as const) {
    test(`${entry} releases exclusive ownership after a thrown ${boundary} failure`, async () => {
      const { f, core, intent } = await continuationFixture();
      const settle = f.persistence.reconcileActionRecovery;
      const readIntent = f.persistence.readIntent;
      const failure = new Error(`test.${boundary}_failure`);
      let settled = false;
      f.persistence.reconcileActionRecovery = async (userIntentId) => {
        if (boundary === 'settlement') throw failure;
        settled = true;
        return settle(userIntentId);
      };
      f.persistence.readIntent = async (userIntentId) => {
        if (settled) throw failure;
        return readIntent(userIntentId);
      };
      await assert.rejects(core[entry](intent.userIntentId), (error: unknown) => error === failure);
      f.persistence.reconcileActionRecovery = settle;
      f.persistence.readIntent = readIntent;
      assert.equal((await core.reconcile(intent.userIntentId)).summary, 'failed');
    });
  }

  test(`${entry} keeps its captured epoch while settlement waits and releases the guard after invalidation`, async () => {
    const { f, core, intent } = await continuationFixture();
    const entered = deferred();
    const release = deferred();
    const settle = f.persistence.reconcileActionRecovery;
    f.persistence.reconcileActionRecovery = async (userIntentId) => {
      const proof = await settle(userIntentId);
      entered.resolve();
      await release.promise;
      return proof;
    };
    const pending = core[entry](intent.userIntentId);
    const rejected = assert.rejects(pending, coreError('cancelled'));
    await entered.promise;
    core.invalidate();
    release.resolve();
    await rejected;
    f.persistence.reconcileActionRecovery = settle;
    assert.equal((await core.reconcile(intent.userIntentId)).summary, 'failed');
  });
}

test('dispatch cannot recapture a new epoch after its initial saved-intent read', async () => {
  const { f, core, intent } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  const readIntent = f.persistence.readIntent;
  f.persistence.readIntent = async (userIntentId) => {
    const saved = await readIntent(userIntentId);
    entered.resolve();
    await release.promise;
    return saved;
  };
  let settlements = 0;
  f.persistence.reconcileActionRecovery = async () => {
    settlements++;
    return ready(null);
  };
  const pending = core.dispatch(intent.userIntentId);
  const rejected = assert.rejects(pending, coreError('cancelled'));
  await entered.promise;
  core.invalidate();
  release.resolve();
  await rejected;
  assert.equal(settlements, 0);
});

test('invalidation during the fresh reload suppresses publication and releases recovery ownership', async () => {
  const { f, core, intent } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  const readIntent = f.persistence.readIntent;
  f.persistence.readIntent = async (userIntentId) => {
    const saved = await readIntent(userIntentId);
    entered.resolve();
    await release.promise;
    return saved;
  };
  const pending = core.reconcile(intent.userIntentId);
  const rejected = assert.rejects(pending, coreError('cancelled'));
  await entered.promise;
  core.invalidate();
  release.resolve();
  await rejected;
  f.persistence.readIntent = readIntent;
  assert.equal((await core.reconcile(intent.userIntentId)).summary, 'failed');
});

test('an active continuation attempt excludes public metadata reconciliation', async () => {
  const { f, core, intent, review } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  f.persistence.reconcileActionRecovery = unused;
  f.persistence.confirmActionContinuation = async () => {
    entered.resolve();
    await release.promise;
    return { kind: 'uncertain', operationId: review.slot.command.operationId };
  };
  const pending = core.confirmActionContinuation({ source: 'explicit_user', review });
  await entered.promise;
  await assert.rejects(core.reconcile(intent.userIntentId), coreError('already_pending'));
  release.resolve();
  assert.equal((await pending).actionOutcome?.summary, 'uncertain');
});

test('missing and unknown command states cannot enter review or confirmation', async () => {
  const { f, core, intent, review } = await continuationFixture();
  for (const commandState of [undefined, null, 'ready', 0]) {
    const malformed = {
      ...copyContinuationReview(review),
      slot: { ...review.slot, commandState },
    } as unknown as AssistantActionContinuationReview;
    f.persistence.readActionContinuationReview = async () => ready(malformed);
    await assert.rejects(
      core.readActionContinuationReview({
        userIntentId: intent.userIntentId,
        expectedIntentRevision: intent.revision,
      }),
      coreError('operation_conflict'),
    );
    await assert.rejects(
      core.confirmActionContinuation({ source: 'explicit_user', review: malformed }),
      coreError('invalid_input'),
    );
  }
  assert.equal(f.calls.includes('continuation:confirm'), false);
});

test('prospective review remains pure and carries the exact original unfinalized reservation', async () => {
  const { f, core, intent, review } = await continuationFixture(1, 'prospective');
  const saved = JSON.stringify(f.saved());
  f.persistence.reconcileActionRecovery = unused;
  const shown = await core.readActionContinuationReview({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
  });
  assert.deepEqual(shown, review);
  assert.equal(shown?.slot.commandState, 'prospective');
  assert.equal(shown?.slot.command.operationId, intent.slots[1]!.operationId);
  assert.equal(f.saved().intent.slots.length, 1);
  assert.equal(JSON.stringify(f.saved()), saved);
  assert.equal(f.calls.includes('continuation:confirm'), false);
});

for (const kind of ['failed', 'uncertain'] as const) {
  test(`a ${kind} prospective finalization attempt preserves its diagnostic with null aggregate and no phantom slot`, async () => {
    const { f, core, intent, review } = await continuationFixture(1, 'prospective');
    const saved = JSON.stringify(f.saved());
    const attempt: CommandResult =
      kind === 'uncertain'
        ? { kind, operationId: review.slot.command.operationId }
        : {
            kind,
            operationId: review.slot.command.operationId,
            error: {
              code: 'storage_failure',
              messageKey: 'test.finalization_failed',
              retry: 'reconcile',
            },
          };
    f.persistence.confirmActionContinuation = async () => attempt;
    f.persistence.reconcileActionRecovery = unused;
    const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
    assert.deepEqual(result.command, review.slot.command);
    assert.deepEqual(result.result, attempt);
    assert.equal(result.actionOutcome, null);
    assert.equal(result.recoveryError?.messageKey, 'assistant.continuation_history_changed');
    assert.equal(JSON.stringify(f.saved()), saved);
    assert.equal(f.saved().actionPlan?.slots.length, intent.slots.length);
    assert.equal(f.receipts.size, 1);
  });
}

for (const cursor of [0, 1] as const) {
  test(`prospective slot ${cursor} preserves exact bytes and reports completion only when every original receipt exists`, async () => {
    const { f, core, intent, review } = await continuationFixture(cursor, 'prospective');
    const originalPlan = JSON.stringify(f.saved().actionPlan);
    const prefix = JSON.stringify(f.saved().intent.slots);
    let confirmations = 0;
    f.persistence.reconcileActionRecovery = unused;
    f.persistence.confirmActionContinuation = async ({ review: selected }) => {
      confirmations++;
      assert.deepEqual(selected, review);
      const slot = {
        slotId: selected.slot.slotId,
        command: JSON.parse(JSON.stringify(selected.slot.command)) as LocalCommand,
      };
      f.setSaved({
        ...f.saved(),
        intent: { ...f.saved().intent, slots: [...f.saved().intent.slots, slot] },
      });
      const actual = continuationReceipt(slot.command);
      f.receipts.set(actual.operationId, actual);
      return { kind: 'receipt', receipt: actual };
    };
    const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
    assert.equal(confirmations, 1);
    assert.equal(result.result.kind, 'receipt');
    assert.equal(result.actionOutcome?.summary, cursor === 0 ? 'partial' : 'complete');
    assert.deepEqual(
      result.actionOutcome?.results.slots.map((slot) => slot.slotId),
      intent.slots.map((slot) => slot.slotId),
    );
    assert.deepEqual(f.saved().intent.slots[cursor]?.command, review.slot.command);
    assert.equal(JSON.stringify(f.saved().intent.slots.slice(0, cursor)), prefix);
    assert.equal(JSON.stringify(f.saved().actionPlan), originalPlan);
    assert.equal(f.saved().intent.revision, intent.revision);
  });
}

for (const kind of ['failed', 'uncertain'] as const) {
  test(`a ${kind} prospective freeze without a receipt retains its diagnostic and real prefix instead of completing the plan`, async () => {
    const { f, core, intent, review } = await continuationFixture(1, 'prospective');
    f.persistence.reconcileActionRecovery = unused;
    const attempt: CommandResult =
      kind === 'uncertain'
        ? { kind, operationId: review.slot.command.operationId }
        : {
            kind,
            operationId: review.slot.command.operationId,
            error: {
              code: 'storage_failure',
              messageKey: 'test.execution_failed',
              retry: 'reconcile',
            },
          };
    f.persistence.confirmActionContinuation = async ({ review: selected }) => {
      const slot = {
        slotId: selected.slot.slotId,
        command: JSON.parse(JSON.stringify(selected.slot.command)) as LocalCommand,
      };
      f.setSaved({
        ...f.saved(),
        intent: { ...f.saved().intent, slots: [...f.saved().intent.slots, slot] },
      });
      return attempt;
    };
    const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
    assert.deepEqual(result.result, attempt);
    assert.equal(result.actionOutcome?.summary, kind === 'failed' ? 'partial' : 'uncertain');
    assert.deepEqual(
      result.actionOutcome?.results.slots.map((slot) => slot.result.kind),
      ['receipt', kind],
    );
    assert.deepEqual(result.actionOutcome?.results.slots[1]?.result, attempt);
    assert.equal(f.saved().intent.revision, intent.revision);
    assert.equal(f.receipts.size, 1);
  });
}

test('continuation review owns the read input, exposes only Data evidence and performs no action', async () => {
  const { f, core, intent, review } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  const input = { userIntentId: intent.userIntentId, expectedIntentRevision: intent.revision };
  const originalInput = { ...input };
  let observed: typeof input | undefined;
  f.persistence.readActionContinuationReview = async (owned) => {
    observed = owned;
    entered.resolve();
    await release.promise;
    return ready(review);
  };
  const before = [...f.calls];
  const invalidations = f.continuationInvalidations();
  const pending = core.readActionContinuationReview(input);
  await entered.promise;
  input.userIntentId = id(980);
  input.expectedIntentRevision++;
  release.resolve();
  const shown = await pending;
  assert.deepEqual(observed, originalInput);
  assert.deepEqual(shown, review);
  assert.notEqual(shown, review);
  assert.deepEqual(f.calls, before);
  assert.equal(f.continuationInvalidations(), invalidations + 1);
});

test('a null continuation review stays null and a Data read failure keeps its exact error', async () => {
  const { f, core, intent } = await continuationFixture();
  const input = { userIntentId: intent.userIntentId, expectedIntentRevision: intent.revision };
  f.persistence.readActionContinuationReview = async () => ready(null);
  assert.equal(await core.readActionContinuationReview(input), null);
  const error: ContractError = {
    code: 'storage_failure',
    messageKey: 'test.continuation_read',
    retry: 'reconcile',
  };
  f.persistence.readActionContinuationReview = async () => ({ kind: 'failed', error });
  await assert.rejects(
    core.readActionContinuationReview(input),
    (caught: unknown) => caught instanceof AssistantCoreError && caught.detail === error,
  );
  assert.equal(f.calls.includes('continuation:confirm'), false);
});

test('dismissing a delayed continuation read cannot resurrect it and does not cancel transport', async () => {
  const { f, core, intent, review } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  f.persistence.readActionContinuationReview = async () => {
    entered.resolve();
    await release.promise;
    return ready(copyContinuationReview(review));
  };
  const input = { userIntentId: intent.userIntentId, expectedIntentRevision: intent.revision };
  const pending = core.readActionContinuationReview(input);
  const rejected = assert.rejects(pending, coreError('cancelled'));
  await entered.promise;
  const before = [...f.calls];
  const invalidations = f.continuationInvalidations();
  core.invalidateActionContinuationReview();
  assert.equal(f.continuationInvalidations(), invalidations + 1);
  assert.deepEqual(f.calls, before);
  release.resolve();
  await rejected;
  // A subsequent review can replace the discarded one only after that read has settled.
  f.persistence.readActionContinuationReview = async () =>
    ready({ ...copyContinuationReview(review), reviewToken: 'replacement-review' });
  assert.equal((await core.readActionContinuationReview(input))?.reviewToken, 'replacement-review');
});

for (const retirement of ['cancel', 'invalidate', 'working_context'] as const) {
  test(`${retirement} retires a pending continuation review before it can be published`, async () => {
    const { f, core, intent, review } = await continuationFixture();
    const entered = deferred();
    const release = deferred();
    f.persistence.readActionContinuationReview = async () => {
      entered.resolve();
      await release.promise;
      return ready(copyContinuationReview(review));
    };
    const pending = core.readActionContinuationReview({
      userIntentId: intent.userIntentId,
      expectedIntentRevision: intent.revision,
    });
    const rejected = assert.rejects(pending, coreError('cancelled'));
    await entered.promise;
    const invalidations = f.continuationInvalidations();
    if (retirement === 'cancel') {
      const cancelling = core.cancel(intent.userIntentId);
      assert.equal(f.continuationInvalidations(), invalidations + 1);
      await cancelling;
    } else if (retirement === 'invalidate') {
      core.invalidate();
    } else {
      f.persistence.setWorkingContext = async () =>
        ready({
          conversationId: id(1),
          generation: 0,
          revision: 1,
          composerDraft: '',
          nextSequence: 101,
        });
      await core.setWorkingContext({
        expectedContextRevision: 0,
        afterSequence: 100,
        carryMemoryIds: [],
      });
    }
    assert.equal(f.continuationInvalidations(), invalidations + 1);
    assert.equal(f.calls.filter((call) => call === 'abort').length, 1);
    release.resolve();
    await rejected;
  });
}

test('failed working-context CAS does not revoke an otherwise current continuation review', async () => {
  const { f, core, intent } = await continuationFixture();
  await core.readActionContinuationReview({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
  });
  const invalidations = f.continuationInvalidations();
  f.persistence.setWorkingContext = async () => ({
    kind: 'failed',
    error: { code: 'stale_context', messageKey: 'test.context_cas', retry: 'after_correction' },
  });
  await core.setWorkingContext({
    expectedContextRevision: 0,
    afterSequence: 100,
    carryMemoryIds: [],
  });
  assert.equal(f.continuationInvalidations(), invalidations);
  assert.equal(f.calls.includes('abort'), false);
});

test('continuation requires explicit confirmation and a paired connection before calling Data', async () => {
  const { f, core, intent, review } = await continuationFixture();
  await assert.rejects(
    core.confirmActionContinuation({ source: 'automatic', review } as unknown as Parameters<
      typeof core.confirmActionContinuation
    >[0]),
    coreError('invalid_input'),
  );
  f.connection.getState = () => ({ generation: 2, status: 'unpaired' });
  await assert.rejects(
    core.readActionContinuationReview({
      userIntentId: intent.userIntentId,
      expectedIntentRevision: intent.revision,
    }),
    coreError('unauthenticated'),
  );
  await assert.rejects(
    core.confirmActionContinuation({ source: 'explicit_user', review }),
    coreError('unauthenticated'),
  );
  assert.equal(
    f.calls.some((call) => call.startsWith('continuation:')),
    false,
  );
});

test('connection generation changing during review rejects the stale descriptor', async () => {
  const { f, core, intent, review } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  f.persistence.readActionContinuationReview = async () => {
    entered.resolve();
    await release.promise;
    return ready(review);
  };
  const pending = core.readActionContinuationReview({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
  });
  const rejected = assert.rejects(pending, coreError('stale_context'));
  await entered.promise;
  f.connection.getState = () => ({ generation: 2, status: 'paired' });
  release.resolve();
  await rejected;
});

test('one dedicated continuation acknowledges the prefix and executes only the selected original command', async () => {
  const { f, core, intent, review } = await continuationFixture(1);
  const originalPlan = JSON.stringify(f.saved().actionPlan);
  const originalSlots = JSON.stringify(f.saved().intent.slots);
  const prefix = JSON.stringify(review.prefixReceipts);
  const seen: AssistantActionContinuationReview[] = [];
  f.persistence.confirmActionContinuation = async ({ review: selected }) => {
    seen.push(JSON.parse(JSON.stringify(selected)) as AssistantActionContinuationReview);
    const actual = continuationReceipt(
      JSON.parse(JSON.stringify(selected.slot.command)) as LocalCommand,
    );
    f.receipts.set(actual.operationId, actual);
    return { kind: 'receipt', receipt: actual };
  };
  const shown = await core.readActionContinuationReview({
    userIntentId: intent.userIntentId,
    expectedIntentRevision: intent.revision,
  });
  assert.ok(shown);
  const invalidations = f.continuationInvalidations();
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review: shown });
  assert.equal(f.continuationInvalidations(), invalidations);
  assert.deepEqual(seen, [review]);
  assert.deepEqual(result.command, review.slot.command);
  assert.equal(result.result.kind, 'receipt');
  assert.equal(result.actionOutcome?.summary, 'complete');
  assert.deepEqual(
    result.actionOutcome?.results.slots.map((slot) => slot.result.kind),
    ['receipt', 'receipt'],
  );
  assert.equal(JSON.stringify(f.saved().actionPlan), originalPlan);
  assert.equal(JSON.stringify(f.saved().intent.slots), originalSlots);
  assert.equal(JSON.stringify(review.prefixReceipts), prefix);
});

test('a successful frozen continuation leaves later unfinalized reservations visibly partial', async () => {
  const { f, core, intent, review } = await continuationFixture();
  f.persistence.confirmActionContinuation = async ({ review: selected }) => {
    const actual = continuationReceipt(
      JSON.parse(JSON.stringify(selected.slot.command)) as LocalCommand,
    );
    f.receipts.set(actual.operationId, actual);
    return { kind: 'receipt', receipt: actual };
  };
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.equal(result.result.kind, 'receipt');
  assert.equal(result.actionOutcome?.summary, 'partial');
  assert.equal(result.actionOutcome?.results.slots.length, intent.slots.length);
  assert.equal(result.actionOutcome?.results.slots[1]?.slotId, intent.slots[1]?.slotId);
  assert.notEqual(result.actionOutcome?.results.slots[1]?.result.kind, 'receipt');
  assert.equal(f.saved().intent.slots.length, 1);
  assert.equal(f.saved().actionPlan?.slots.length, 2);
});

for (const kind of ['failed', 'uncertain'] as const) {
  test(`actual ${kind} continuation is not erased by a generic not-executed recovery proof`, async () => {
    const { f, core, review } = await continuationFixture();
    const attempt: CommandResult =
      kind === 'failed'
        ? {
            kind,
            operationId: review.slot.command.operationId,
            error: {
              code: 'storage_failure',
              messageKey: 'test.original_attempt',
              retry: 'reconcile',
            },
          }
        : { kind, operationId: review.slot.command.operationId };
    f.persistence.confirmActionContinuation = async () => attempt;
    const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
    assert.deepEqual(result.result, attempt);
    assert.deepEqual(result.actionOutcome?.results.slots[0]?.result, attempt);
    assert.equal(result.actionOutcome?.summary, kind);
    assert.equal(result.actionOutcome?.results.slots[1]?.result.kind, 'failed');
  });
}

test('journaled continuation failure and prefix receipt survive immediate, later and recreated-core reconciliation', async () => {
  const { f, core, intent, review, commandPlatform } = await continuationFixture(1);
  const attempt: CommandResult = {
    kind: 'failed',
    operationId: review.slot.command.operationId,
    error: { code: 'storage_failure', messageKey: 'test.plan_insert_failed', retry: 'reconcile' },
  };
  let confirmations = 0;
  f.persistence.confirmActionContinuation = async () => {
    confirmations++;
    f.setSaved({
      ...f.saved(),
      slotResults: [...f.saved().slotResults, { slotId: review.slot.slotId, result: attempt }],
    });
    return attempt;
  };
  const immediate = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.deepEqual(immediate.result, attempt);
  const outcomes = [
    immediate.actionOutcome,
    await core.reconcile(intent.userIntentId),
    await f.coordinator(commandPlatform).reconcile(intent.userIntentId),
  ];
  for (const result of outcomes) {
    assert.ok(result);
    assert.equal(result.summary, 'partial');
    assert.deepEqual(result.results.slots, [
      {
        slotId: review.prefixReceipts[0]!.slotId,
        result: { kind: 'receipt', receipt: review.prefixReceipts[0]!.receipt },
      },
      { slotId: review.slot.slotId, result: attempt },
    ]);
  }
  assert.equal(confirmations, 1);
  assert.deepEqual(f.saved().slotResults, [{ slotId: review.slot.slotId, result: attempt }]);
});

test('a correlated failed continuation does not downgrade independent unresolved target evidence', async () => {
  const { f, core, intent, review } = await continuationFixture(1);
  const attempt: CommandResult = {
    kind: 'failed',
    operationId: review.slot.command.operationId,
    error: {
      code: 'storage_failure',
      messageKey: 'test.attempt_failed_effect_unknown',
      retry: 'reconcile',
    },
  };
  const proof = await recoveryProof(f, intent.userIntentId);
  proof.slots[1] = { ...proof.slots[1]!, outcome: 'unresolved', receipt: null };
  f.persistence.readActionRecovery = async () => ready(proof);
  f.persistence.confirmActionContinuation = async () => {
    f.setSaved({
      ...f.saved(),
      slotResults: [{ slotId: review.slot.slotId, result: attempt }],
    });
    return attempt;
  };
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.deepEqual(result.result, attempt);
  assert.equal(result.actionOutcome?.summary, 'uncertain');
  assert.deepEqual(result.actionOutcome?.results.slots, [
    {
      slotId: review.prefixReceipts[0]!.slotId,
      result: { kind: 'receipt', receipt: review.prefixReceipts[0]!.receipt },
    },
    {
      slotId: review.slot.slotId,
      result: { kind: 'uncertain', operationId: review.slot.command.operationId },
    },
  ]);
});

test('authoritative not-executed evidence still resolves earlier journal uncertainty with the prefix receipt intact', async () => {
  const { f, core, intent, review, commandPlatform } = await continuationFixture(1);
  f.setSaved({
    ...f.saved(),
    slotResults: [
      {
        slotId: review.slot.slotId,
        result: { kind: 'uncertain', operationId: review.slot.command.operationId },
      },
    ],
  });
  for (const caller of [core, f.coordinator(commandPlatform)]) {
    const result = await caller.reconcile(intent.userIntentId);
    assert.equal(result.summary, 'partial');
    assert.deepEqual(result.results.slots[0], {
      slotId: review.prefixReceipts[0]!.slotId,
      result: { kind: 'receipt', receipt: review.prefixReceipts[0]!.receipt },
    });
    assert.deepEqual(result.results.slots[1], {
      slotId: review.slot.slotId,
      result: {
        kind: 'failed',
        operationId: review.slot.command.operationId,
        error: {
          code: 'cancelled',
          messageKey: 'assistant.not_dispatched',
          retry: 'after_correction',
        },
      },
    });
  }
  assert.equal(f.calls.includes('continuation:confirm'), false);
});

test('reconciliation rejects a journaled failure belonging to a different operation instead of reusing it', async () => {
  const { f, core, intent, review } = await continuationFixture(1);
  f.setSaved({
    ...f.saved(),
    slotResults: [
      {
        slotId: review.slot.slotId,
        result: {
          kind: 'failed',
          operationId: id(989),
          error: {
            code: 'storage_failure',
            messageKey: 'test.foreign_journal_failure',
            retry: 'reconcile',
          },
        },
      },
    ],
  });
  await assert.rejects(
    core.reconcile(intent.userIntentId),
    (error: unknown) => error instanceof AssistantCoreError,
  );
  assert.equal(f.calls.includes('continuation:confirm'), false);
});

test('only an independent actual receipt resolves uncertain continuation progress while retaining the attempt', async () => {
  const { f, core, review } = await continuationFixture();
  const actual = continuationReceipt(review.slot.command);
  f.persistence.confirmActionContinuation = async () => {
    f.receipts.set(actual.operationId, actual);
    return { kind: 'uncertain', operationId: actual.operationId };
  };
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.deepEqual(result.result, { kind: 'uncertain', operationId: actual.operationId });
  assert.deepEqual(result.actionOutcome?.results.slots[0]?.result, {
    kind: 'receipt',
    receipt: actual,
  });
  assert.equal(result.actionOutcome?.summary, 'partial');
});

for (const mismatch of [
  'operation',
  'intent',
  'fingerprint',
  'semantics',
  'failed_operation',
  'unknown',
] as const) {
  test(`a ${mismatch} continuation result cannot become receipt-backed success`, async () => {
    const { f, core, review } = await continuationFixture();
    const actual = continuationReceipt(review.slot.command);
    let returned: CommandResult = { kind: 'receipt', receipt: actual };
    if (mismatch === 'operation') actual.operationId = id(981);
    if (mismatch === 'intent') actual.userIntentId = id(982);
    if (mismatch === 'fingerprint') actual.payloadFingerprint = 'f'.repeat(64);
    if (mismatch === 'semantics')
      actual.effects = [{ kind: 'favourite', entityId: '99999', revision: 1, saved: true }];
    if (mismatch === 'failed_operation')
      returned = {
        kind: 'failed',
        operationId: id(983),
        error: { code: 'storage_failure', messageKey: 'test.foreign_failure', retry: 'reconcile' },
      };
    if (mismatch === 'unknown') returned = { kind: 'unexpected' } as unknown as CommandResult;
    f.persistence.confirmActionContinuation = async () => returned;
    const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
    const unknown: CommandResult = {
      kind: 'uncertain',
      operationId: review.slot.command.operationId,
    };
    assert.deepEqual(result.command, review.slot.command);
    assert.deepEqual(result.result, unknown);
    assert.deepEqual(result.actionOutcome?.results.slots[0]?.result, unknown);
    assert.equal(result.actionOutcome?.summary, 'uncertain');
  });
}

test('a thrown continuation acknowledgement remains uncertain without a retry', async () => {
  const { f, core, review } = await continuationFixture();
  let confirmations = 0;
  f.persistence.confirmActionContinuation = async () => {
    confirmations++;
    throw new Error('Lost acknowledgement');
  };
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.equal(confirmations, 1);
  assert.deepEqual(result.result, {
    kind: 'uncertain',
    operationId: review.slot.command.operationId,
  });
  assert.equal(result.actionOutcome?.summary, 'uncertain');
});

test('a recovery read failure cannot replace or hide the actual failed continuation attempt', async () => {
  const { f, core, review } = await continuationFixture();
  const attempt: CommandResult = {
    kind: 'failed',
    operationId: review.slot.command.operationId,
    error: {
      code: 'stale_target',
      messageKey: 'test.original_target_changed',
      retry: 'after_correction',
    },
  };
  const recoveryError: ContractError = {
    code: 'storage_failure',
    messageKey: 'test.proof_unavailable',
    retry: 'reconcile',
  };
  f.persistence.confirmActionContinuation = async () => attempt;
  f.persistence.readActionRecovery = async () => ({ kind: 'failed', error: recoveryError });
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.deepEqual(result.result, attempt);
  assert.equal(result.actionOutcome, null);
  assert.deepEqual(result.recoveryError, recoveryError);
});

for (const corruption of ['schema', 'fingerprint'] as const) {
  test(`invalid continuation command ${corruption} is rejected before Data confirmation`, async () => {
    const { f, core, review } = await continuationFixture();
    if (corruption === 'schema') review.slot.command.operationId = 'invalid';
    else review.slot.command.payloadFingerprint = 'f'.repeat(64);
    await assert.rejects(
      core.confirmActionContinuation({ source: 'explicit_user', review }),
      coreError(corruption === 'schema' ? 'invalid_input' : 'operation_conflict'),
    );
    assert.equal(f.calls.includes('continuation:confirm'), false);
  });
}

for (const history of ['cleared', 'missing_plan', 'missing_receipt'] as const) {
  test(`a historical single-operation receipt with ${history} history never manufactures batch completion`, async () => {
    const { f, core, review } = await continuationFixture();
    const actual = continuationReceipt(review.slot.command);
    f.persistence.confirmActionContinuation = async () => {
      if (history === 'cleared') f.clearConversation();
      if (history === 'missing_plan') f.setSaved({ ...f.saved(), actionPlan: null });
      if (history !== 'missing_receipt') f.receipts.set(actual.operationId, actual);
      return { kind: 'receipt', receipt: actual };
    };
    const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
    assert.deepEqual(result.command, review.slot.command);
    assert.deepEqual(result.result, { kind: 'receipt', receipt: actual });
    assert.equal(result.actionOutcome, null);
    assert.ok(result.recoveryError);
  });
}

test('historical receipt ancillary slot labels and supplied prefix receipts cannot relabel actual plan progress', async () => {
  const { f, core, intent, review } = await continuationFixture();
  const actual = continuationReceipt(review.slot.command);
  review.cursor = 7;
  review.reviewToken = 'consumed-token';
  review.slot.commandState = 'prospective';
  review.slot.slotId = intent.slots[1]!.slotId;
  review.prefixReceipts = [{ slotId: intent.slots[1]!.slotId, receipt: actual }];
  f.persistence.confirmActionContinuation = async () => {
    f.receipts.set(actual.operationId, actual);
    return { kind: 'receipt', receipt: actual };
  };
  const result = await core.confirmActionContinuation({ source: 'explicit_user', review });
  assert.equal(result.result.kind, 'receipt');
  assert.equal(result.actionOutcome?.summary, 'partial');
  assert.deepEqual(result.actionOutcome?.results.slots[0], {
    slotId: intent.slots[0]!.slotId,
    result: { kind: 'receipt', receipt: actual },
  });
  assert.equal(result.actionOutcome?.results.slots[1]?.result.kind, 'failed');
});

test('concurrent continuation confirmations are rejected while the first owns the Data attempt', async () => {
  const { f, core, review } = await continuationFixture();
  const entered = deferred();
  const release = deferred();
  let confirmations = 0;
  f.persistence.confirmActionContinuation = async ({ review: selected }) => {
    confirmations++;
    entered.resolve();
    await release.promise;
    return { kind: 'uncertain', operationId: selected.slot.command.operationId };
  };
  const first = core.confirmActionContinuation({ source: 'explicit_user', review });
  await entered.promise;
  await assert.rejects(
    core.confirmActionContinuation({ source: 'explicit_user', review }),
    coreError('already_pending'),
  );
  assert.equal(confirmations, 1);
  release.resolve();
  assert.equal((await first).result.kind, 'uncertain');
});

for (const boundary of ['hash', 'data'] as const) {
  test(`caller mutation during the ${boundary} await cannot switch the confirmed frozen command`, async () => {
    const { f, review, commandPlatform } = await continuationFixture();
    const original = copyContinuationReview(review);
    const entered = deferred();
    const release = deferred();
    let hashes = 0;
    const core = f.coordinator({
      ...commandPlatform,
      async sha256(text) {
        hashes++;
        if (boundary === 'hash' && hashes === 1) {
          entered.resolve();
          await release.promise;
        }
        return commandPlatform.sha256(text);
      },
    });
    let passed: AssistantActionContinuationReview | undefined;
    f.persistence.confirmActionContinuation = async ({ review: selected }) => {
      if (boundary === 'data') {
        entered.resolve();
        await release.promise;
      }
      passed = JSON.parse(JSON.stringify(selected)) as AssistantActionContinuationReview;
      return { kind: 'uncertain', operationId: selected.slot.command.operationId };
    };
    const authority = { source: 'explicit_user' as const, review };
    const pending = core.confirmActionContinuation(authority);
    await entered.promise;
    review.slot.commandState = 'prospective';
    review.slot.command.operationId = id(985);
    review.slot.command.userIntentId = id(986);
    review.slot.command.payloadFingerprint = 'a'.repeat(64);
    if (review.slot.command.command.kind !== 'setFavourite') throw new Error();
    review.slot.command.command.saved = false;
    review.slot.slotId = id(987);
    review.reviewToken = 'switched-token';
    review.state.guards.contextRevision++;
    release.resolve();
    const result = await pending;
    assert.deepEqual(passed, original);
    assert.deepEqual(result.command, original.slot.command);
    assert.deepEqual(result.result, {
      kind: 'uncertain',
      operationId: original.slot.command.operationId,
    });
  });
}

for (const retirement of ['dismiss', 'cancel', 'invalidate', 'connection'] as const) {
  test(`${retirement} during command hashing prevents continuation admission`, async () => {
    const { f, review, commandPlatform } = await continuationFixture();
    const entered = deferred();
    const release = deferred();
    const core = f.coordinator({
      ...commandPlatform,
      async sha256(text) {
        entered.resolve();
        await release.promise;
        return commandPlatform.sha256(text);
      },
    });
    const pending = core.confirmActionContinuation({ source: 'explicit_user', review });
    const rejected = assert.rejects(
      pending,
      coreError(retirement === 'connection' ? 'stale_context' : 'cancelled'),
    );
    await entered.promise;
    if (retirement === 'dismiss') core.invalidateActionContinuationReview();
    if (retirement === 'cancel') await core.cancel();
    if (retirement === 'invalidate') core.invalidate();
    if (retirement === 'connection')
      f.connection.getState = () => ({ generation: 2, status: 'paired' });
    release.resolve();
    await rejected;
    assert.equal(f.calls.includes('continuation:confirm'), false);
  });
}

for (const retirement of ['dismiss', 'cancel', 'clear'] as const) {
  test(`${retirement} after Data admission retains only the actual command result and suppresses stale batch publication`, async () => {
    const { f, core, review } = await continuationFixture();
    const entered = deferred();
    const release = deferred();
    const actual = continuationReceipt(review.slot.command);
    f.persistence.confirmActionContinuation = async () => {
      f.receipts.set(actual.operationId, actual);
      entered.resolve();
      await release.promise;
      return { kind: 'receipt', receipt: actual };
    };
    const pending = core.confirmActionContinuation({ source: 'explicit_user', review });
    await entered.promise;
    if (retirement === 'dismiss') core.invalidateActionContinuationReview();
    if (retirement === 'cancel') await core.cancel();
    if (retirement === 'clear') {
      core.invalidate();
      f.clearConversation();
    }
    release.resolve();
    const result = await pending;
    assert.deepEqual(result.result, { kind: 'receipt', receipt: actual });
    assert.equal(result.actionOutcome, null);
    assert.equal(result.recoveryError?.code, 'cancelled');
  });
}
