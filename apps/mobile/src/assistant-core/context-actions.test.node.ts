import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAssistantRequest } from './context';
import {
  AssistantCoreError,
  prepareAuthorizedIntent,
  prepareAuthorizedActionPlan,
} from './actions';
import type { ExplicitActionAuthority } from './actions';
import {
  current,
  date,
  guard,
  id,
  platform,
  request,
  response,
  snapshot,
} from './fixtures.test-support';

const input = () => ({
  text: 'Please save this recipe.',
  ids: {
    requestId: id(2),
    userIntentId: id(3),
    intentRevision: 0,
    messageId: id(4),
    connectionGeneration: 1,
  },
  date,
  selection: {},
});
function authority(reply = response()): ExplicitActionAuthority {
  return { source: 'explicit_user', proposals: reply.proposals, replacementConfirmations: [] };
}
function rejected(expected: string) {
  return (error: unknown) => error instanceof AssistantCoreError && error.detail.code === expected;
}

test('old explicit ordinal uses persisted ordered reference metadata outside bounded history', () => {
  const state = snapshot();
  state.history = Array.from({ length: 20 }, (_, n) => ({
    messageId: id(n + 30),
    role: 'assistant' as const,
    text: `Turn ${n}`,
    sourceSequence: n + 50,
  }));
  state.referenceSets = [
    { referenceSetId: id(70), messageId: id(29), recipeIds: ['53262', '52765'] },
    { referenceSetId: id(71), messageId: id(49), recipeIds: ['52765', '53262'] },
  ];
  const original = structuredClone(state);
  assert.equal(
    state.history.some((turn) => turn.messageId === id(29)),
    false,
  );
  assert.equal(
    state.history.some((turn) => turn.messageId === id(49)),
    true,
  );
  const result = buildAssistantRequest(state, {
    ...input(),
    selection: { reference: { referenceSetId: id(70), ordinal: 2 } },
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.equal(result.request.context.selectedRecipeId, '52765');
  assert.equal(result.request.context.referenceSets[0]?.messageId, id(29));
  assert.notEqual(result.request.context.selectedRecipeId, state.referenceSets[1]!.recipeIds[1]);
  assert.deepEqual(result.request.context.referenceSets, original.referenceSets);
  assert.deepEqual(result.request.context.history, original.history);
  assert.equal(result.request.context.history.length, 20);
  assert.equal(result.request.context.referenceSets.length, 2);
  assert.equal(result.omittedHistoryCount, 0);
  assert.deepEqual(state, original);
});

test('ambiguous, missing and out-of-range old references require clarification, never latest-set substitution', () => {
  const state = snapshot();
  state.referenceSets = [
    { referenceSetId: id(70), messageId: id(30), recipeIds: ['53262'] },
    { referenceSetId: id(71), messageId: id(31), recipeIds: ['52765'] },
  ];
  for (const reference of [
    { ordinal: 1 },
    { ordinal: 2, referenceSetId: id(70) },
    { ordinal: 1, referenceSetId: id(90) },
  ])
    assert.deepEqual(buildAssistantRequest(state, { ...input(), selection: { reference } }), {
      kind: 'clarification',
      reason: 'reference',
      messageKey: 'assistant.clarify_reference',
    });
});

test('packet preserves older USER wording, later correction, unrelated constraint and removed-preference provenance', () => {
  const text = 'Which day did we settle on, and what constraint still applies?';
  const state = snapshot(id(4), text);
  state.preferences = { revision: 5, lastRemovalRevision: 5, items: [] };
  state.currentMessage.preferenceRevisionAtSource = 5;
  const removedPreference = {
    sourceMessageId: id(32),
    preferenceId: id(90),
    type: 'cuisine' as const,
    value: 'Italian',
    savedRevision: 1,
    removedRevision: 5,
  };
  const earlier = {
    messageId: id(30),
    role: 'user' as const,
    text: 'I want to cook on Thursday. Do not use peanuts in this request.',
    sourceSequence: 1,
    sourceDateContext: date,
    preferenceRevisionAtSource: 1,
    preferenceLinks: [],
  };
  const correction = {
    messageId: id(31),
    role: 'user' as const,
    text: 'Use Friday, not Thursday for this request.',
    sourceSequence: 2,
    sourceDateContext: date,
    preferenceRevisionAtSource: 1,
    preferenceLinks: [],
  };
  state.history = [
    {
      messageId: id(32),
      role: 'user',
      text: 'Save Italian as my cuisine preference.',
      sourceSequence: 0,
      sourceDateContext: date,
      preferenceRevisionAtSource: 0,
      preferenceLinks: [removedPreference],
    },
    earlier,
    correction,
  ];
  state.memory.items = [
    {
      memoryId: id(80),
      sourceMessageId: earlier.messageId,
      sourceSequence: earlier.sourceSequence,
      sourceDateContext: earlier.sourceDateContext,
      preferenceRevisionAtSource: earlier.preferenceRevisionAtSource,
      preferenceLinks: earlier.preferenceLinks,
      revision: 1,
      quote: earlier.text,
      kind: 'constraint',
      scope: { kind: 'conversation' },
      relations: [],
    },
    {
      memoryId: id(81),
      sourceMessageId: correction.messageId,
      sourceSequence: correction.sourceSequence,
      sourceDateContext: correction.sourceDateContext,
      preferenceRevisionAtSource: correction.preferenceRevisionAtSource,
      preferenceLinks: correction.preferenceLinks,
      revision: 2,
      quote: correction.text,
      kind: 'correction',
      scope: { kind: 'conversation' },
      relations: [
        {
          kind: 'supersedes',
          target: { kind: 'memory', memoryId: id(80), expectedRevision: 1 },
        },
      ],
    },
  ];
  state.memory.coverage = {
    ...state.memory.coverage,
    retainedEntryCount: 2,
    suppliedEntryCount: 2,
  };
  const original = structuredClone(state);
  const result = buildAssistantRequest(state, { ...input(), text });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  const context = result.request.context;
  assert.deepEqual(context.history, original.history);
  assert.deepEqual(context.memory, original.memory);
  assert.deepEqual(context.preferences, { revision: 5, lastRemovalRevision: 5, items: [] });
  assert.equal(context.memory.items[0]?.quote, earlier.text);
  assert.equal(context.memory.items[1]?.quote, correction.text);
  assert.deepEqual(context.memory.items[1]?.relations, [
    {
      kind: 'supersedes',
      target: { kind: 'memory', memoryId: id(80), expectedRevision: 1 },
    },
  ]);
  const savedPreferenceSource = context.history[0]!;
  assert.equal(savedPreferenceSource.role, 'user');
  if (savedPreferenceSource.role !== 'user') throw new Error('expected_user_source');
  assert.deepEqual(savedPreferenceSource.preferenceLinks, [removedPreference]);
  assert.equal(result.request.message.text, text);
  assert.equal(result.request.message.preferenceRevisionAtSource, 5);
  assert.equal(result.omittedHistoryCount, 0);
  assert.deepEqual(state, original);
});

test('context builder narrows over-budget essential evidence without deleting local history', () => {
  const state = snapshot();
  state.memory.items = Array.from({ length: 33 }, (_, n) => ({
    memoryId: id(n + 100),
    sourceMessageId: id(n + 30),
    sourceSequence: n,
    sourceDateContext: date,
    preferenceRevisionAtSource: 0,
    preferenceLinks: [],
    revision: 0,
    quote: 'Required correction',
    kind: 'correction',
    scope: { kind: 'conversation' },
    relations: [],
  }));
  const result = buildAssistantRequest(state, input());
  assert.equal(result.kind, 'narrowing');
  assert.equal(state.memory.items.length, 33);
});

test('byte and pending-evidence budgets narrow without editing Data coverage or provenance', () => {
  const state = snapshot();
  state.memory.coverage.pendingUserSourceCount = 10;
  state.memory.coverage.pendingWorkingSourceCount = 10;
  assert.equal(buildAssistantRequest(state, input()).kind, 'narrowing');
  const huge = snapshot();
  huge.history = Array.from({ length: 20 }, (_, i) => ({
    messageId: id(200 + i),
    role: 'assistant',
    sourceSequence: i,
    text: '🧑'.repeat(4000),
  }));
  const result = buildAssistantRequest(huge, input());
  assert.equal(result.kind, 'narrowing');
  if (result.kind === 'narrowing') assert.equal(result.reason, 'byte_limit');
  assert.equal(huge.history.length, 20);
});

test('current source identity, date and retained USER provenance are validated', () => {
  for (const mutate of [
    (state: ReturnType<typeof snapshot>) => {
      state.currentMessage.messageId = id(90);
    },
    (state: ReturnType<typeof snapshot>) => {
      state.currentMessage.sourceDateContext.localDate = '2026-09-27';
    },
    (state: ReturnType<typeof snapshot>) => {
      state.history = [{ ...state.currentMessage, role: 'user', sourceSequence: 1 }];
    },
  ]) {
    const state = snapshot();
    mutate(state);
    assert.equal(buildAssistantRequest(state, input()).kind, 'failed');
  }
});

test('multiple preference plans reserve identities without guessing future revisions', async () => {
  const reply = response();
  reply.proposals = [
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'French' },
  ];
  const plan = await prepareAuthorizedActionPlan(
    request(),
    reply,
    authority(reply),
    current(),
    guard(),
    platform(),
  );
  assert.equal(plan.slots.length, 2);
  assert.ok(plan.slots.every((slot) => !('expectedPreferenceRevision' in slot.payload)));
  assert.equal(new Set(plan.slots.map((slot) => slot.operationId)).size, 2);
});

test('app preparer freezes exactly authorized save, plan and explicit preference into independent slots', async () => {
  const reply = response();
  reply.proposals.push(
    {
      kind: 'addPlan',
      recipeId: '53262',
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty' },
    },
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
  );
  const intent = await prepareAuthorizedIntent(
    request(),
    reply,
    authority(reply),
    current(),
    guard(),
    platform(),
  );
  assert.equal(intent.phase, 'ready');
  assert.equal(intent.slots.length, 3);
  assert.deepEqual(
    intent.slots.map((slot) => slot.command.command.kind),
    ['setFavourite', 'addPlan', 'savePreference'],
  );
  assert.equal(new Set(intent.slots.map((slot) => slot.command.operationId)).size, 3);
  assert.ok(intent.slots.every((slot) => Object.isFrozen(slot.command.command)));
  assert.ok(intent.slots.every((slot) => slot.command.userIntentId === request().userIntentId));
});

test('provider text cannot authorize an action and unrequested additional work dispatches nothing', async () => {
  const reply = response();
  assert.equal(reply.text, 'Saved!');
  await assert.rejects(
    prepareAuthorizedIntent(
      request(),
      reply,
      { ...authority(), proposals: [] },
      current(),
      guard(),
      platform(),
    ),
    rejected('unsupported_request'),
  );
  reply.proposals.push({ kind: 'savePreference', type: 'cuisine', explicitValue: 'French' });
  await assert.rejects(
    prepareAuthorizedIntent(request(), reply, authority(), current(), guard(), platform()),
    rejected('unsupported_request'),
  );
});

test('stale generation, preference, context and local-date guards reject before command creation', async () => {
  for (const mutate of [
    (state: ReturnType<typeof current>) => {
      state.guards.conversationGeneration++;
    },
    (state: ReturnType<typeof current>) => {
      state.guards.preferenceRevision++;
    },
    (state: ReturnType<typeof current>) => {
      state.guards.contextRevision++;
    },
    (state: ReturnType<typeof current>) => {
      state.guards.relativeDateContext!.localDate = '2026-09-29';
    },
  ]) {
    const state = current();
    mutate(state);
    let identifiers = 0;
    await assert.rejects(
      prepareAuthorizedIntent(request(), response(), authority(), state, guard(), {
        ...platform(),
        newId: () => {
          identifiers++;
          return id(80);
        },
      }),
      rejected('stale_context'),
    );
    assert.equal(identifiers, 0);
  }
});

test('occupied plan action requires exact live occurrence and shopping consequences', async () => {
  const state = current();
  const placement = { actualDate: '2026-10-01', mealKey: 'dinner' as const };
  state.planOccurrences = [
    {
      occurrenceId: id(80),
      recipeId: '52765',
      placement,
      revision: 4,
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    },
  ];
  state.shoppingScope = { scopeId: id(5), revision: 3, occurrenceIds: [id(80)] };
  const reply = response();
  reply.proposals = [
    {
      kind: 'addPlan',
      recipeId: '53262',
      placement,
      expectedTarget: { kind: 'occupied', occurrenceId: id(80), expectedRevision: 4 },
    },
  ];
  await assert.rejects(
    prepareAuthorizedIntent(request(), reply, authority(reply), state, guard(), platform()),
    rejected('stale_target'),
  );
  const approved = authority(reply);
  approved.replacementConfirmations = [
    {
      occurrenceId: id(80),
      expectedRevision: 4,
      expectedShoppingScopeRevision: 3,
      currentRecipeId: '52765',
      replacementRecipeId: '53262',
      includedInShopping: true,
      placement,
    },
  ];
  const intent = await prepareAuthorizedIntent(
    request(),
    reply,
    approved,
    state,
    guard(),
    platform(),
  );
  assert.equal(intent.slots[0]?.command.command.kind, 'replacePlanRecipe');
  state.shoppingScope.revision++;
  await assert.rejects(
    prepareAuthorizedIntent(request(), reply, approved, state, guard(), platform()),
    rejected('stale_target'),
  );
});

test('relative dates and preference batches are not guessed into stale commands', async () => {
  const reply = response();
  const approved = authority();
  approved.relativeDateGuard = {
    interpretedAt: { ...date, localDate: '2026-09-27' },
    resolvedDate: '2026-09-29',
    sourceMessageId: id(4),
  };
  await assert.rejects(
    prepareAuthorizedIntent(request(), reply, approved, current(), guard(), platform()),
    rejected('stale_context'),
  );
  reply.proposals = [
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'French' },
  ];
  await assert.rejects(
    prepareAuthorizedIntent(request(), reply, authority(reply), current(), guard(), platform()),
    rejected('unsupported_request'),
  );
});
