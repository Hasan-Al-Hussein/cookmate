import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import { schema, strictAjvOptions } from '../schema/contract.schema.mjs';
import {
  API_VERSION,
  CONTRACT_SCHEMA_VERSION,
  DATABASE_SCHEMA_VERSION,
  assistantJsonByteLength,
  checkAssistantRequest,
  checkAssistantResponse,
  checkMemoryRequest,
  checkMemoryResponseForRequest,
  sourcePredatesPreferenceRemoval,
  validateAssistantTurnRequest,
  validateAssistantTurnResponse,
  validateLocalCommand,
  validateModelMemoryUpdate,
  validateOperationReceipt,
  validatePairRequest,
  validatePairResponse,
  validateHealthResponse,
} from '../src/index.js';
import type { MemoryItem, UserMemorySource } from '../src/index.js';
import {
  catalogueBoundary,
  commandFixture,
  ids,
  receiptFixture,
  requestFixture,
  responseFixture,
} from './fixtures.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`;
function source(sequence = 0, quote = 'No peanuts; Monday'): UserMemorySource {
  return {
    sourceMessageId: id(sequence),
    sourceSequence: sequence,
    quote,
    sourceDateContext: { localDate: '2026-09-27', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 },
    preferenceRevisionAtSource: 0,
    preferenceLinks: [],
  };
}
function item(sequence = 0): MemoryItem {
  return {
    ...source(sequence),
    memoryId: id(sequence + 40),
    revision: 0,
    kind: 'constraint',
    scope: { kind: 'conversation' },
    relations: [],
  };
}
function batch() {
  const request = requestFixture();
  request.message.sourceSequence = 2;
  request.message.text = 'Tuesday instead';
  request.context.memory.pendingSources = [source()];
  request.context.memory.reviewTargetMessageIds = [id(0), ids.message];
  Object.assign(request.context.memory.coverage, {
    pendingUserSourceCount: 2,
    pendingWorkingSourceCount: 2,
    suppliedReviewTargetCount: 2,
  });
  const response = responseFixture();
  response.memoryUpdate = {
    baseRevision: 0,
    baseContextRevision: 0,
    reviews: [
      { sourceMessageId: id(0), disposition: 'retain' },
      { sourceMessageId: ids.message, disposition: 'retain' },
    ],
    entries: [
      {
        sourceMessageId: id(0),
        quote: source().quote,
        kind: 'constraint',
        scope: { kind: 'conversation' },
        relations: [],
      },
      {
        sourceMessageId: ids.message,
        quote: request.message.text,
        kind: 'correction',
        scope: { kind: 'conversation' },
        relations: [{ kind: 'supersedes', target: { kind: 'source', sourceMessageId: id(0) } }],
      },
    ],
  };
  return { request, response };
}

test('API2 is explicit across assistant, pairing and health; command2 and receipt1 are independent', () => {
  assert.equal(API_VERSION, '2');
  assert.equal(CONTRACT_SCHEMA_VERSION, 2);
  assert.equal(DATABASE_SCHEMA_VERSION, 2);
  const pairRequest = { apiVersion: '2', code: 'ABCDEFGHJKLM' };
  const pairResponse = {
    apiVersion: '2',
    clientId: ids.intent,
    token: 'a'.repeat(43),
    expiresAt: '2026-09-28T02:00:00.000Z',
    catalogue: requestFixture().catalogue,
  };
  const health = { apiVersion: '2', status: 'ready' };
  for (const [validate, value] of [
    [validatePairRequest, pairRequest],
    [validatePairResponse, pairResponse],
    [validateHealthResponse, health],
    [validateAssistantTurnRequest, requestFixture()],
    [validateAssistantTurnResponse, responseFixture()],
  ] as const) {
    assert.equal(validate(value), true);
    assert.equal(validate({ ...value, apiVersion: '1' }), false);
  }
  assert.equal(validateLocalCommand({ ...commandFixture(), schemaVersion: 1 }), false);
  assert.equal(validateOperationReceipt(receiptFixture()), true);
  assert.equal(validateOperationReceipt({ ...receiptFixture(), schemaVersion: 2 }), false);
  const request: any = requestFixture();
  request.context.facts = [];
  delete request.context.memory;
  assert.equal(validateAssistantTurnRequest(request), false);
});

test('atomic edit keeps recipe/date/meal and requires the shopping-scope guard', () => {
  const command: any = {
    ...commandFixture(),
    command: {
      kind: 'editPlan',
      occurrenceId: ids.occurrence,
      expectedRevision: 1,
      expectedShoppingScopeRevision: 3,
      recipeId: '52771',
      placement: { actualDate: '2026-09-30', mealKey: 'lunch' },
    },
  };
  assert.equal(validateLocalCommand(command), true);
  for (const key of ['expectedShoppingScopeRevision', 'recipeId', 'placement']) {
    const changed = structuredClone(command);
    delete changed.command[key];
    assert.equal(validateLocalCommand(changed), false, key);
  }
});

test('normal responses require expanded quotes; errors reject sidecars; model variant rejects quotes/provenance', () => {
  const { response } = batch();
  assert.equal(validateAssistantTurnResponse(response), true);
  const wire: any = structuredClone(response);
  delete wire.memoryUpdate.entries[0].quote;
  assert.equal(validateAssistantTurnResponse(wire), false);
  delete wire.memoryUpdate;
  assert.equal(validateAssistantTurnResponse(wire), false);
  const { text, sources, referenceSets, proposals, memoryUpdate, ...base } = response;
  void text;
  void sources;
  void referenceSets;
  void proposals;
  const error = {
    ...base,
    kind: 'error',
    error: { code: 'too_large', messageKey: 'memory.narrow', retry: 'after_correction' },
  };
  assert.equal(validateAssistantTurnResponse(error), true);
  assert.equal(validateAssistantTurnResponse({ ...error, memoryUpdate }), false);
  const model = {
    ...memoryUpdate,
    entries: memoryUpdate.entries.map(({ quote, ...entry }) => {
      void quote;
      return entry;
    }),
  };
  assert.equal(validateModelMemoryUpdate(model), true);
  assert.equal(validateModelMemoryUpdate(memoryUpdate), false);
  assert.equal(
    validateModelMemoryUpdate({
      ...model,
      entries: [{ ...model.entries[0], preferenceLinks: [] }],
    }),
    false,
  );
});

test('same-batch correction retains the full original constraint and exact reviews', () => {
  const { request, response } = batch();
  assert.equal(checkMemoryResponseForRequest(response, request).ok, true);
  assert.equal(response.memoryUpdate.entries[0]!.quote, 'No peanuts; Monday');
  const mutations: ((r: any) => void)[] = [
    (r) => r.memoryUpdate.reviews.pop(),
    (r) => r.memoryUpdate.reviews.push(r.memoryUpdate.reviews[0]),
    (r) => (r.memoryUpdate.reviews[0].sourceMessageId = id(90)),
    (r) => r.memoryUpdate.entries.pop(),
    (r) => r.memoryUpdate.entries.push(r.memoryUpdate.entries[0]),
    (r) => (r.memoryUpdate.reviews[0].disposition = 'non_memory'),
    (r) => (r.memoryUpdate.entries[0].sourceMessageId = id(90)),
    (r) => r.memoryUpdate.baseRevision++,
    (r) => r.memoryUpdate.baseContextRevision++,
    (r) => (r.requestId = id(90)),
    (r) => r.conversationGeneration++,
    (r) => r.preferenceRevision++,
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(response);
    mutate(changed);
    assert.equal(checkMemoryResponseForRequest(changed, request).ok, false);
  }
});

test('unresolved review permits only a clarification and no retained entry for that source', () => {
  const request = requestFixture();
  const response = responseFixture();
  response.memoryUpdate.reviews[0]!.disposition = 'unresolved';
  assert.equal(checkMemoryResponseForRequest(response, request).ok, false);
  const { proposals, ...normal } = response;
  void proposals;
  const clarification = { ...normal, kind: 'clarification', missing: ['intent'] };
  assert.equal(checkMemoryResponseForRequest(clarification, request).ok, true);
  assert.equal(checkMemoryResponseForRequest({ ...normal, kind: 'answer' }, request).ok, false);
});

test('quotes reject whitespace/Unicode alteration, and only declared USER sources can be retained', () => {
  const { request, response } = batch();
  request.context.memory.pendingSources[0]!.quote = '  Café 🍎\nNo peanuts; Monday';
  response.memoryUpdate.entries[0]!.quote = request.context.memory.pendingSources[0]!.quote;
  assert.equal(checkMemoryResponseForRequest(response, request).ok, true);
  for (const quote of [
    response.memoryUpdate.entries[0]!.quote.trim(),
    response.memoryUpdate.entries[0]!.quote.normalize('NFD'),
    'No peanuts',
  ]) {
    const changed = structuredClone(response);
    changed.memoryUpdate.entries[0]!.quote = quote;
    assert.equal(checkMemoryResponseForRequest(changed, request).ok, false);
  }
  request.context.history = [
    {
      role: 'assistant',
      messageId: id(0),
      sourceSequence: 0,
      text: request.context.memory.pendingSources[0]!.quote,
    },
  ];
  assert.equal(checkMemoryRequest(request).ok, false);
});

test('relations reject unknown/self/newer/cyclic sources and stale/unknown selected memory', () => {
  const { request, response } = batch();
  for (const target of [id(90), ids.message]) {
    const changed = structuredClone(response);
    changed.memoryUpdate.entries[1]!.relations[0]!.target = {
      kind: 'source',
      sourceMessageId: target,
    };
    assert.equal(checkMemoryResponseForRequest(changed, request).ok, false);
  }
  const cyclic = structuredClone(response);
  cyclic.memoryUpdate.entries[0]!.relations = [
    { kind: 'conflicts_with', target: { kind: 'source', sourceMessageId: ids.message } },
  ];
  assert.equal(checkMemoryResponseForRequest(cyclic, request).ok, false);
  request.context.memory.items = [item()];
  Object.assign(request.context.memory.coverage, { retainedEntryCount: 1, suppliedEntryCount: 1 });
  response.memoryUpdate.entries[1]!.relations[0]!.target = {
    kind: 'memory',
    memoryId: id(40),
    expectedRevision: 0,
  };
  assert.equal(checkMemoryResponseForRequest(response, request).ok, true);
  for (const target of [
    { kind: 'memory', memoryId: id(90), expectedRevision: 0 },
    { kind: 'memory', memoryId: id(40), expectedRevision: 1 },
  ]) {
    const changed: any = structuredClone(response);
    changed.memoryUpdate.entries[1].relations[0].target = target;
    assert.equal(checkMemoryResponseForRequest(changed, request).ok, false);
  }
  const changed: any = structuredClone(request);
  changed.context.memory.items[0].relations = [
    { kind: 'supersedes', target: { kind: 'source', sourceMessageId: ids.message } },
  ];
  assert.equal(validateAssistantTurnRequest(changed), false);
});

test('required provenance agrees across channels, with original dates preserved', () => {
  const { request } = batch();
  const original = request.context.memory.pendingSources[0]!;
  const { sourceMessageId, quote, ...provenance } = original;
  request.context.history = [
    { messageId: sourceMessageId, text: quote, role: 'user', ...structuredClone(provenance) },
  ];
  assert.equal(checkAssistantRequest(request, catalogueBoundary).ok, true);
  for (const mutate of [
    (r: any) => r.context.history[0].sourceSequence++,
    (r: any) => (r.context.history[0].sourceDateContext.localDate = '2026-09-26'),
    (r: any) => r.context.history[0].preferenceRevisionAtSource++,
    (r: any) => delete r.context.history[0].preferenceLinks,
    (r: any) => (r.message.sourceDateContext.localDate = '2026-09-27'),
    (r: any) => r.message.preferenceRevisionAtSource++,
    (r: any) => (r.context.memory.pendingSources[0].sourceSequence = 2),
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.equal(checkMemoryRequest(changed).ok, false);
  }
});

test('preference links preserve removal markers without a count cap or model authority', () => {
  const { request } = batch();
  request.context.preferences = { revision: 3, lastRemovalRevision: 2, items: [] };
  request.message.preferenceRevisionAtSource = 3;
  const links = Array.from({ length: 101 }, (_, n) => ({
    sourceMessageId: id(0),
    preferenceId: id(200 + n),
    type: 'cuisine' as const,
    value: 'Italian',
    savedRevision: 9,
    removedRevision: 2,
  }));
  request.context.memory.pendingSources[0]!.preferenceLinks = links;
  assert.equal(checkMemoryRequest(request).ok, true);
  const before = structuredClone(request);
  assert.equal(validateAssistantTurnRequest(request), true);
  assert.deepEqual(request, before);
  request.context.memory.pendingSources[0]!.preferenceLinks[0]!.sourceMessageId = ids.message;
  assert.equal(checkMemoryRequest(request).ok, false);
  assert.equal(sourcePredatesPreferenceRemoval(1, 2), true);
  assert.equal(sourcePredatesPreferenceRemoval(2, 2), false);
  assert.equal(sourcePredatesPreferenceRemoval(3, null), false);
});

test('working boundary excludes every supplied old source unless explicitly carried', () => {
  const { request } = batch();
  request.context.memory.workingContext.afterSequence = 1;
  assert.equal(checkMemoryRequest(request).ok, false);
  request.context.memory.items = [item()];
  request.context.memory.workingContext.carryMemoryIds = [id(40)];
  Object.assign(request.context.memory.coverage, {
    retainedEntryCount: 40,
    suppliedEntryCount: 1,
    omittedEntryCount: 39,
    pendingUserSourceCount: 40,
  });
  assert.equal(checkMemoryRequest(request).ok, true);
  request.context.history = [
    {
      role: 'assistant',
      messageId: id(99),
      sourceSequence: 1,
      text: 'An excluded implicit reference',
    },
  ];
  assert.equal(checkMemoryRequest(request).ok, false);
  request.context.history = [];
  request.context.memory.workingContext.carryMemoryIds = [];
  request.context.memory.items = [];
  request.context.memory.pendingSources = [];
  request.context.memory.reviewTargetMessageIds = [ids.message];
  Object.assign(request.context.memory.coverage, {
    suppliedEntryCount: 0,
    omittedEntryCount: 40,
    suppliedReviewTargetCount: 1,
    pendingWorkingSourceCount: 1,
  });
  assert.equal(checkMemoryRequest(request).ok, true); // fresh brief; old local evidence remains counted
});

test('carry IDs include the complete expanded relation group, not only chosen roots', () => {
  const request = requestFixture();
  request.message.sourceSequence = 3;
  const a = item(0);
  const b = item(1);
  b.kind = 'correction';
  b.quote = 'Tuesday instead';
  b.relations = [
    {
      kind: 'supersedes',
      target: { kind: 'memory', memoryId: a.memoryId, expectedRevision: a.revision },
    },
  ];
  request.context.memory.items = [a, b];
  request.context.memory.workingContext = {
    afterSequence: 2,
    carryMemoryIds: [a.memoryId, b.memoryId],
  };
  Object.assign(request.context.memory.coverage, {
    retainedEntryCount: 40,
    suppliedEntryCount: 2,
    omittedEntryCount: 38,
  });
  assert.equal(checkMemoryRequest(request).ok, true);
  request.context.memory.workingContext.carryMemoryIds = [b.memoryId];
  assert.equal(checkMemoryRequest(request).ok, false);
  request.context.memory.workingContext.carryMemoryIds = [a.memoryId, b.memoryId];
  request.context.memory.items = [b];
  Object.assign(request.context.memory.coverage, { suppliedEntryCount: 1, omittedEntryCount: 39 });
  assert.equal(checkMemoryRequest(request).ok, false);
});

test('live and removed source links agree with the complete frozen preference snapshot', () => {
  const { request } = batch();
  request.context.preferences = {
    revision: 3,
    lastRemovalRevision: 2,
    items: [{ preferenceId: id(80), type: 'cuisine', value: 'Italian\u0000', revision: 9 }],
  };
  request.message.preferenceRevisionAtSource = 3;
  const link = {
    sourceMessageId: id(0),
    preferenceId: id(80),
    type: 'cuisine' as const,
    value: 'Italian\u0000',
    savedRevision: 9,
    removedRevision: null,
  };
  request.context.memory.pendingSources[0]!.preferenceLinks = [link];
  assert.equal(checkMemoryRequest(request).ok, true);
  for (const mutate of [
    (r: any) => (r.context.preferences.items = []),
    (r: any) => r.context.preferences.items[0].revision++,
    (r: any) => (r.context.preferences.items[0].value = 'Italian'),
    (r: any) => (r.context.preferences.items[0].type = 'dietary_style'),
    (r: any) => (r.context.memory.pendingSources[0].preferenceLinks[0].removedRevision = 2),
    (r: any) => r.context.memory.pendingSources[0].preferenceLinks.push(link),
    (r: any) => r.message.preferenceLinks.push({ ...link, sourceMessageId: ids.message }),
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.equal(checkMemoryRequest(changed).ok, false);
  }
});

test('coverage is internally consistent and unresolved pending evidence cannot appear within budget', () => {
  const { request } = batch();
  for (const change of [
    { suppliedEntryCount: 1 },
    { retainedEntryCount: 1 },
    { suppliedReviewTargetCount: 1 },
    { pendingWorkingSourceCount: 3 },
    { pendingUserSourceCount: 1 },
  ]) {
    const changed = structuredClone(request);
    Object.assign(changed.context.memory.coverage, change);
    assert.equal(checkMemoryRequest(changed).ok, false);
  }
  request.context.memory.coverage = {
    ...request.context.memory.coverage,
    pendingUserSourceCount: 40,
    pendingWorkingSourceCount: 33,
    selectionStatus: 'narrowing_required',
  };
  assert.equal(validateAssistantTurnRequest(request), true); // coverage shape is also used locally
  assert.equal(checkMemoryRequest(request).ok, false); // never a partial sendable packet
  assert.equal(checkMemoryResponseForRequest(batch().response, request).ok, false);
});

test('an unbounded working context cannot hide pending sources behind a smaller scoped count', () => {
  const request = requestFixture();
  request.context.memory.coverage.pendingUserSourceCount = 40;
  assert.equal(validateAssistantTurnRequest(request), true);
  assert.equal(checkMemoryRequest(request).ok, false);
  request.context.memory.coverage.pendingWorkingSourceCount = 40;
  assert.equal(checkMemoryRequest(request).ok, false); // all pending evidence cannot fit this packet
});

test('a source-linked withdrawal is later than its original global preference revision', () => {
  const { request } = batch();
  request.context.preferences = { revision: 3, lastRemovalRevision: 3, items: [] };
  request.message.preferenceRevisionAtSource = 3;
  const original = request.context.memory.pendingSources[0]!;
  original.preferenceRevisionAtSource = 2;
  original.preferenceLinks = [
    {
      sourceMessageId: original.sourceMessageId,
      preferenceId: id(80),
      type: 'cuisine',
      value: 'Italian',
      savedRevision: 9,
      removedRevision: 3,
    },
  ];
  assert.equal(checkMemoryRequest(request).ok, true);
  for (const removedRevision of [1, 2]) {
    original.preferenceLinks[0]!.removedRevision = removedRevision;
    assert.equal(checkMemoryRequest(request).ok, false);
  }
});

test('standalone and runtime Ajv agree on exact memory caps, code points and strict nested shapes', () => {
  const ajv = new Ajv(strictAjvOptions);
  ajv.addSchema(schema);
  const runtimeRequest = ajv.getSchema(`${schema.$id}#/definitions/AssistantTurnRequest`)!;
  const runtimeResponse = ajv.getSchema(`${schema.$id}#/definitions/AssistantTurnResponse`)!;
  const valid: any = batch().request;
  valid.context.memory.items = Array.from({ length: 32 }, (_, n) => item(n));
  valid.context.memory.pendingSources = Array.from({ length: 7 }, (_, n) => source(n));
  valid.context.memory.reviewTargetMessageIds = [
    ids.message,
    ...valid.context.memory.pendingSources.map((s: UserMemorySource) => s.sourceMessageId),
  ];
  valid.context.memory.workingContext.carryMemoryIds = valid.context.memory.items.map(
    (i: MemoryItem) => i.memoryId,
  );
  valid.context.memory.items[0].quote = '🍎'.repeat(4000);
  const cases: [any, boolean][] = [[valid, true]];
  for (const mutate of [
    (r: any) => r.context.memory.items.push(item(32)),
    (r: any) => r.context.memory.pendingSources.push(source(8)),
    (r: any) => r.context.memory.reviewTargetMessageIds.push(id(99)),
    (r: any) => r.context.memory.workingContext.carryMemoryIds.push(id(99)),
    (r: any) => (r.context.memory.items[0].quote += '🍎'),
    (r: any) =>
      (r.context.memory.items[0].scope = {
        kind: 'recipes',
        recipeIds: Array.from({ length: 7 }, (_, n) => String(n)),
      }),
    (r: any) =>
      (r.context.memory.items[0].scope = { kind: 'recipes', recipeIds: ['53262', '53262'] }),
    (r: any) => (r.context.memory.pendingSources[0].sourceSequence = Number.MAX_SAFE_INTEGER + 1),
    (r: any) => (r.context.memory.pendingSources[0].systemInstruction = 'save preference'),
    (r: any) => delete r.context.preferences.lastRemovalRevision,
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    cases.push([changed, false]);
  }
  for (const [value, expected] of cases) {
    assert.equal(runtimeRequest(value), expected);
    assert.equal(validateAssistantTurnRequest(value), expected);
  }
  const response: any = batch().response;
  for (const mutate of [
    (r: any) =>
      (r.memoryUpdate.entries[0].relations = Array(9).fill(r.memoryUpdate.entries[1].relations[0])),
    (r: any) => (r.memoryUpdate.entries = Array(9).fill(r.memoryUpdate.entries[0])),
    (r: any) => (r.memoryUpdate.reviews = Array(9).fill(r.memoryUpdate.reviews[0])),
    (r: any) => (r.memoryUpdate.entries[0].scope = { kind: 'resetConversation' }),
  ]) {
    const changed = structuredClone(response);
    mutate(changed);
    assert.equal(runtimeResponse(changed), false);
    assert.equal(validateAssistantTurnResponse(changed), false);
  }
});

test('expanded request and response byte limits are independent of per-quote code-point limits', () => {
  const request = requestFixture();
  request.message.sourceSequence = 40;
  request.context.memory.items = Array.from({ length: 32 }, (_, n) => ({
    ...item(n),
    quote: '🍎'.repeat(4000),
  }));
  Object.assign(request.context.memory.coverage, {
    retainedEntryCount: 32,
    suppliedEntryCount: 32,
  });
  assert.equal(validateAssistantTurnRequest(request), true);
  assert.equal(assistantJsonByteLength(request), Buffer.byteLength(JSON.stringify(request)));
  assert.equal(checkMemoryRequest(request).ok, false);
  const response = responseFixture();
  response.memoryUpdate.entries = Array.from({ length: 8 }, (_, n) => ({
    sourceMessageId: id(n),
    quote: '🍎'.repeat(4000),
    kind: 'constraint',
    scope: { kind: 'conversation' },
    relations: [],
  }));
  response.text = '🍎'.repeat(8000);
  assert.equal(validateAssistantTurnResponse(response), true);
  assert.equal(checkAssistantResponse(response, catalogueBoundary).ok, false);
  assert.equal(
    assistantJsonByteLength({ quote: '\ud800' }),
    Buffer.byteLength(JSON.stringify({ quote: '\ud800' })),
  );
});
