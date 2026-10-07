import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { acceptanceFingerprintInput } from '../src/acceptance.js';
import type { AssistantAcceptanceInput, ProposalResponse } from '../src/generated/types.js';
import { ids, requestFixture, responseFixture } from './fixtures.js';

const fixtureIds = {
  firstMemory: '00000000-0000-4000-8000-000000000011',
  secondMemory: '00000000-0000-4000-8000-000000000012',
  firstUser: '00000000-0000-4000-8000-000000000013',
  secondUser: '00000000-0000-4000-8000-000000000014',
  pendingUser: '00000000-0000-4000-8000-000000000015',
  assistant: '00000000-0000-4000-8000-000000000016',
  firstPreference: '00000000-0000-4000-8000-000000000017',
  secondPreference: '00000000-0000-4000-8000-000000000018',
  response: '00000000-0000-4000-8000-000000000019',
  reference: '00000000-0000-4000-8000-000000000020',
};

function acceptanceFixture(): AssistantAcceptanceInput & { normalizedResponse: ProposalResponse } {
  const frozenRequest = requestFixture();
  const date = { ...frozenRequest.context.date };
  const firstSource = {
    sourceMessageId: fixtureIds.firstUser,
    sourceSequence: 1,
    sourceDateContext: date,
    preferenceRevisionAtSource: 1,
    quote: 'Save citrus; avoid peanuts tonight.',
    preferenceLinks: [
      {
        sourceMessageId: fixtureIds.firstUser,
        preferenceId: fixtureIds.firstPreference,
        type: 'ingredient_like' as const,
        value: 'citrus',
        savedRevision: 1,
        removedRevision: 2,
      },
      {
        sourceMessageId: fixtureIds.firstUser,
        preferenceId: fixtureIds.secondPreference,
        type: 'ingredient_avoid' as const,
        value: 'peanuts',
        savedRevision: 1,
        removedRevision: null,
      },
    ],
  };
  const secondSource = {
    sourceMessageId: fixtureIds.secondUser,
    sourceSequence: 3,
    sourceDateContext: date,
    preferenceRevisionAtSource: 2,
    quote: 'Actually, only avoid peanuts at dinner.',
    preferenceLinks: [],
  };
  const pendingSource = {
    sourceMessageId: fixtureIds.pendingUser,
    sourceSequence: 4,
    sourceDateContext: date,
    preferenceRevisionAtSource: 2,
    quote: 'Also consider tomorrow’s lunch.',
    preferenceLinks: [],
  };
  frozenRequest.message = {
    ...frozenRequest.message,
    sourceSequence: 5,
    sourceDateContext: date,
    preferenceRevisionAtSource: 2,
    preferenceLinks: [],
  };
  frozenRequest.context.history = [
    {
      messageId: firstSource.sourceMessageId,
      role: 'user',
      text: firstSource.quote,
      sourceSequence: firstSource.sourceSequence,
      sourceDateContext: date,
      preferenceRevisionAtSource: firstSource.preferenceRevisionAtSource,
      preferenceLinks: firstSource.preferenceLinks,
    },
    {
      messageId: fixtureIds.assistant,
      role: 'assistant',
      text: 'Which recipe would you like?',
      sourceSequence: 2,
    },
  ];
  frozenRequest.context.memory = {
    projectionRevision: 4,
    baseContextRevision: 7,
    workingContext: {
      afterSequence: 0,
      carryMemoryIds: [fixtureIds.firstMemory, fixtureIds.secondMemory],
    },
    items: [
      {
        ...firstSource,
        memoryId: fixtureIds.firstMemory,
        revision: 1,
        kind: 'constraint',
        scope: { kind: 'conversation' },
        relations: [],
      },
      {
        ...secondSource,
        memoryId: fixtureIds.secondMemory,
        revision: 2,
        kind: 'correction',
        scope: { kind: 'recipes', recipeIds: ['53262', '52771'] },
        relations: [
          {
            kind: 'supersedes',
            target: { kind: 'memory', memoryId: fixtureIds.firstMemory, expectedRevision: 1 },
          },
        ],
      },
    ],
    reviewTargetMessageIds: [pendingSource.sourceMessageId, frozenRequest.message.messageId],
    pendingSources: [pendingSource],
    coverage: {
      retainedEntryCount: 3,
      suppliedEntryCount: 2,
      omittedEntryCount: 1,
      pendingUserSourceCount: 1,
      pendingWorkingSourceCount: 1,
      suppliedReviewTargetCount: 2,
      selectionStatus: 'within_budget',
    },
  };
  frozenRequest.context.preferences = {
    revision: 2,
    lastRemovalRevision: 2,
    items: [
      {
        preferenceId: fixtureIds.secondPreference,
        type: 'ingredient_avoid',
        value: 'peanuts',
        revision: 1,
      },
    ],
  };
  frozenRequest.context.referenceSets = [
    {
      referenceSetId: fixtureIds.reference,
      messageId: fixtureIds.assistant,
      recipeIds: ['53262', '52771'],
    },
  ];
  frozenRequest.context.selectedPlacement = { actualDate: date.localDate, mealKey: 'dinner' };
  frozenRequest.context.planOccurrences = [
    {
      occurrenceId: ids.occurrence,
      recipeId: '53262',
      placement: { actualDate: date.localDate, mealKey: 'dinner' },
      revision: 1,
      createdAt: '2026-09-28T02:00:00.000Z',
      updatedAt: '2026-09-28T02:00:00.000Z',
    },
  ];
  const normalizedResponse = responseFixture();
  normalizedResponse.preferenceRevision = 2;
  normalizedResponse.referenceSets = [...frozenRequest.context.referenceSets];
  normalizedResponse.sources = [
    { recipeId: '53262', section: 'recipe' },
    { recipeId: '52771', section: 'instruction', position: 1 },
  ];
  normalizedResponse.proposals = [
    { kind: 'saveRecipe', recipeId: '53262' },
    {
      kind: 'addPlan',
      recipeId: '53262',
      placement: { actualDate: date.localDate, mealKey: 'dinner' },
      expectedTarget: { kind: 'occupied', occurrenceId: ids.occurrence, expectedRevision: 1 },
    },
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
  ];
  normalizedResponse.memoryUpdate = {
    baseRevision: 4,
    baseContextRevision: 7,
    reviews: [
      { sourceMessageId: pendingSource.sourceMessageId, disposition: 'retain' },
      { sourceMessageId: frozenRequest.message.messageId, disposition: 'retain' },
    ],
    entries: [
      {
        sourceMessageId: pendingSource.sourceMessageId,
        quote: pendingSource.quote,
        kind: 'context',
        scope: { kind: 'placement', placement: { actualDate: '2026-09-29', mealKey: 'lunch' } },
        relations: [],
      },
      {
        sourceMessageId: frozenRequest.message.messageId,
        quote: frozenRequest.message.text,
        kind: 'unresolved_intent',
        scope: { kind: 'recipes', recipeIds: ['53262', '52771'] },
        relations: [
          {
            kind: 'conflicts_with',
            target: { kind: 'source', sourceMessageId: pendingSource.sourceMessageId },
          },
          {
            kind: 'supersedes',
            target: { kind: 'memory', memoryId: fixtureIds.secondMemory, expectedRevision: 2 },
          },
        ],
      },
    ],
  };
  return {
    normalizationVersion: 1,
    frozenRequest,
    normalizedResponse,
    envelope: { assistantMessageId: fixtureIds.response, expectedIntentRevision: 1 },
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(acceptanceFingerprintInput(value), 'utf8').digest('hex');
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

type Path = (string | number)[];

function atPath(root: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (value, key) => (value as Record<string | number, unknown>)[key],
    root,
  );
}

function setPath(root: unknown, path: Path, value: unknown): void {
  const parent = atPath(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path.at(-1)!] = value;
}

test('canonical fingerprint includes the entire versioned input without mutation or object-key order sensitivity', () => {
  const input = acceptanceFixture();
  const before = structuredClone(input);
  const canonical = acceptanceFingerprintInput(input);
  assert.deepEqual(JSON.parse(canonical), input);
  assert.deepEqual(input, before);
  assert.equal(canonical, acceptanceFingerprintInput(reverseObjectKeys(input)));
  assert.match(fingerprint(input), /^[a-f0-9]{64}$/);
});

test('changes throughout frozen request, response, provenance, scope and envelope change the fingerprint', () => {
  const changes: [string, unknown][] = [
    ['frozenRequest.catalogue.version', 'different-catalogue'],
    ['frozenRequest.catalogue.fingerprint', 'd'.repeat(64)],
    ['frozenRequest.requestId', ids.destination],
    ['frozenRequest.userIntentId', ids.destination],
    ['frozenRequest.intentRevision', 2],
    ['frozenRequest.conversationId', ids.destination],
    ['frozenRequest.conversationGeneration', 1],
    ['frozenRequest.connectionGeneration', 1],
    ['frozenRequest.message.messageId', ids.destination],
    ['frozenRequest.message.text', 'Changed full user text.'],
    ['frozenRequest.message.sourceSequence', 6],
    ['frozenRequest.message.sourceDateContext.localDate', '2026-09-29'],
    ['frozenRequest.message.preferenceRevisionAtSource', 3],
    ['frozenRequest.context.history.0.text', 'Changed historical user text.'],
    ['frozenRequest.context.history.1.text', 'Changed historical assistant text.'],
    ['frozenRequest.context.memory.projectionRevision', 5],
    ['frozenRequest.context.memory.baseContextRevision', 8],
    ['frozenRequest.context.memory.workingContext.afterSequence', 1],
    ['frozenRequest.context.memory.workingContext.carryMemoryIds.0', ids.destination],
    ['frozenRequest.context.memory.items.0.memoryId', ids.destination],
    ['frozenRequest.context.memory.items.0.revision', 2],
    ['frozenRequest.context.memory.items.0.sourceMessageId', ids.destination],
    ['frozenRequest.context.memory.items.0.sourceSequence', 0],
    ['frozenRequest.context.memory.items.0.sourceDateContext.timeZone', 'UTC'],
    ['frozenRequest.context.memory.items.0.preferenceRevisionAtSource', 0],
    ['frozenRequest.context.memory.items.0.quote', 'Changed full retained quote.'],
    ['frozenRequest.context.memory.items.0.kind', 'context'],
    ['frozenRequest.context.memory.items.0.preferenceLinks.0.preferenceId', ids.destination],
    ['frozenRequest.context.memory.items.0.preferenceLinks.0.type', 'cuisine'],
    ['frozenRequest.context.memory.items.0.preferenceLinks.0.value', 'orange'],
    ['frozenRequest.context.memory.items.0.preferenceLinks.0.savedRevision', 0],
    ['frozenRequest.context.memory.items.0.preferenceLinks.0.removedRevision', null],
    ['frozenRequest.context.memory.items.1.scope.recipeIds.0', '11111'],
    ['frozenRequest.context.memory.items.1.relations.0.kind', 'conflicts_with'],
    ['frozenRequest.context.memory.items.1.relations.0.target.expectedRevision', 2],
    ['frozenRequest.context.memory.reviewTargetMessageIds.0', ids.destination],
    ['frozenRequest.context.memory.pendingSources.0.quote', 'Changed pending source.'],
    ['frozenRequest.context.memory.coverage.retainedEntryCount', 4],
    ['frozenRequest.context.memory.coverage.suppliedEntryCount', 3],
    ['frozenRequest.context.memory.coverage.omittedEntryCount', 2],
    ['frozenRequest.context.memory.coverage.pendingUserSourceCount', 2],
    ['frozenRequest.context.memory.coverage.pendingWorkingSourceCount', 2],
    ['frozenRequest.context.memory.coverage.suppliedReviewTargetCount', 3],
    ['frozenRequest.context.memory.coverage.selectionStatus', 'narrowing_required'],
    ['frozenRequest.context.preferences.revision', 3],
    ['frozenRequest.context.preferences.lastRemovalRevision', null],
    ['frozenRequest.context.preferences.items.0.value', 'walnuts'],
    ['frozenRequest.context.planOccurrences.0.revision', 2],
    ['frozenRequest.context.planOccurrences.0.placement.mealKey', 'lunch'],
    ['frozenRequest.context.referenceSets.0.recipeIds.0', '11111'],
    ['frozenRequest.context.date.utcOffsetMinutes', 0],
    ['frozenRequest.context.selectedRecipeId', '52771'],
    ['frozenRequest.context.selectedPlacement.actualDate', '2026-09-29'],
    ['normalizedResponse.requestId', ids.destination],
    ['normalizedResponse.preferenceRevision', 3],
    ['normalizedResponse.text', 'Changed response text.'],
    ['normalizedResponse.sources.1.position', 2],
    ['normalizedResponse.referenceSets.0.messageId', ids.destination],
    ['normalizedResponse.proposals.0.recipeId', '52771'],
    ['normalizedResponse.proposals.1.expectedTarget.expectedRevision', 2],
    ['normalizedResponse.proposals.2.explicitValue', 'Indian'],
    ['normalizedResponse.memoryUpdate.baseRevision', 5],
    ['normalizedResponse.memoryUpdate.baseContextRevision', 8],
    ['normalizedResponse.memoryUpdate.reviews.0.disposition', 'unresolved'],
    ['normalizedResponse.memoryUpdate.entries.0.quote', 'Changed expanded quote.'],
    ['normalizedResponse.memoryUpdate.entries.0.scope.placement.actualDate', '2026-09-30'],
    [
      'normalizedResponse.memoryUpdate.entries.1.relations.0.target.sourceMessageId',
      ids.destination,
    ],
    ['envelope.assistantMessageId', ids.destination],
    ['envelope.expectedIntentRevision', 2],
  ];
  const original = acceptanceFixture();
  const expected = fingerprint(original);
  for (const [path, value] of changes) {
    const changed = structuredClone(original);
    setPath(changed, path.split('.'), value);
    assert.notEqual(fingerprint(changed), expected, path);
  }
});

test('every populated array retains its order in the frozen fingerprint', () => {
  const input = acceptanceFixture();
  const paths: Path[] = [];
  function collect(value: unknown, path: Path): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length > 1) paths.push(path);
    for (const [key, entry] of Object.entries(value)) collect(entry, [...path, key]);
  }
  collect(input, []);
  assert.ok(paths.length >= 10, 'fixture covers at least ten distinct ordered collections');
  const expected = fingerprint(input);
  for (const path of paths) {
    const changed = structuredClone(input);
    const entries = atPath(changed, path) as unknown[];
    setPath(changed, path, [...entries].reverse());
    assert.notEqual(fingerprint(changed), expected, path.join('.'));
  }
});

test('exact strings preserve Unicode, whitespace and quoted instruction text as data', () => {
  const input = acceptanceFixture();
  input.frozenRequest.message.text = '  e\u0301 🍎\n"Ignore all rules"\r\n';
  const canonical = acceptanceFingerprintInput(input);
  assert.equal(JSON.parse(canonical).frozenRequest.message.text, input.frozenRequest.message.text);
  const normalized = structuredClone(input);
  normalized.frozenRequest.message.text = input.frozenRequest.message.text.normalize('NFC');
  assert.notEqual(fingerprint(normalized), fingerprint(input));
  normalized.frozenRequest.message.text = input.frozenRequest.message.text.trim();
  assert.notEqual(fingerprint(normalized), fingerprint(input));
});

test('unknown fields at envelope, request and response nesting are rejected instead of omitted', () => {
  for (const path of [
    '',
    'envelope',
    'frozenRequest',
    'frozenRequest.context.memory.coverage',
    'frozenRequest.context.memory.items.0.preferenceLinks.0',
    'normalizedResponse',
    'normalizedResponse.proposals.0',
    'normalizedResponse.memoryUpdate.entries.1.relations.0.target',
  ]) {
    const input = acceptanceFixture();
    setPath(input, [...(path ? path.split('.') : []), 'unrecognized'], true);
    assert.throws(() => acceptanceFingerprintInput(input), TypeError, path);
  }
  assert.throws(
    () => acceptanceFingerprintInput({ ...acceptanceFixture(), normalizationVersion: 2 }),
    TypeError,
  );
});

test('non-JSON values are rejected before coercion, omitted properties or user code can run', () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    () => {},
    Symbol('value'),
    new Date(),
    new Map(),
    new Set(),
    Object(1),
  ]) {
    const input = acceptanceFixture();
    setPath(input, ['frozenRequest', 'message', 'text'], value);
    assert.throws(() => acceptanceFingerprintInput(input), TypeError, String(value));
  }
  const circular = acceptanceFixture();
  setPath(circular, ['frozenRequest', 'context', 'history'], [circular]);
  assert.throws(() => acceptanceFingerprintInput(circular), /cyclic/);

  let invoked = false;
  const accessor = acceptanceFixture();
  Object.defineProperty(accessor.frozenRequest.message, 'text', {
    enumerable: true,
    get() {
      invoked = true;
      return 'User code executed.';
    },
  });
  assert.throws(() => acceptanceFingerprintInput(accessor), /accessor/);
  const customJson = acceptanceFixture();
  Object.defineProperty(customJson.frozenRequest.message, 'toJSON', {
    value() {
      invoked = true;
      return {};
    },
  });
  assert.throws(() => acceptanceFingerprintInput(customJson), /hidden/);
  assert.equal(invoked, false);

  const symbolField = acceptanceFixture();
  Object.defineProperty(symbolField.envelope, Symbol('unknown'), { value: true, enumerable: true });
  assert.throws(() => acceptanceFingerprintInput(symbolField), /symbol/);

  const sparse = acceptanceFixture();
  Reflect.deleteProperty(sparse.normalizedResponse.proposals, '0');
  assert.throws(() => acceptanceFingerprintInput(sparse), /sparse/);
  const extended = acceptanceFixture();
  Object.assign(extended.normalizedResponse.proposals, { unknown: true });
  assert.throws(() => acceptanceFingerprintInput(extended), /extended/);
});

test('normal answers and clarification are accepted; provider errors and missing expanded sidecars are rejected', () => {
  const original = acceptanceFixture();
  const { proposals: omitted, ...common } = original.normalizedResponse;
  void omitted;
  for (const normalizedResponse of [
    { ...common, kind: 'answer' },
    { ...common, kind: 'clarification', missing: ['intent'] },
  ])
    assert.doesNotThrow(() => acceptanceFingerprintInput({ ...original, normalizedResponse }));

  const {
    text: omittedText,
    sources: omittedSources,
    referenceSets: omittedReferences,
    memoryUpdate: omittedMemory,
    ...correlation
  } = common;
  void [omittedText, omittedSources, omittedReferences, omittedMemory];
  const providerError = {
    ...correlation,
    kind: 'error',
    error: { code: 'provider_unavailable', messageKey: 'provider.failed', retry: 'after_delay' },
  };
  assert.throws(
    () => acceptanceFingerprintInput({ ...original, normalizedResponse: providerError }),
    TypeError,
  );
  assert.throws(
    () =>
      acceptanceFingerprintInput({
        ...original,
        normalizedResponse: {
          ...providerError,
          memoryUpdate: original.normalizedResponse.memoryUpdate,
        },
      }),
    TypeError,
  );

  for (const path of ['memoryUpdate', 'memoryUpdate.entries.0.quote']) {
    const input = acceptanceFixture();
    const parts = path.split('.');
    const parent = atPath(input.normalizedResponse, parts.slice(0, -1)) as Record<string, unknown>;
    delete parent[parts.at(-1)!];
    assert.throws(() => acceptanceFingerprintInput(input), TypeError, path);
  }
});

test('canonicalization does not apply first-acceptance correlation or current-state policy', () => {
  const input = acceptanceFixture();
  input.normalizedResponse.requestId = ids.destination;
  input.envelope.expectedIntentRevision = 0;
  assert.doesNotThrow(() => acceptanceFingerprintInput(input));
});
