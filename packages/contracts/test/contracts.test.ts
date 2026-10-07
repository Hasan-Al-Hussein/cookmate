import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  canTransitionIntent,
  checkAssistantRequest,
  checkAssistantResponse,
  checkLocalCommand,
  commandFingerprintInput,
  isActualLocalDate,
  isRelativeDateContextCurrent,
  isResponseCurrent,
  isUtcInstant,
  matchOperationReceipt,
  phaseAfterCancel,
  phaseAfterStartupSuspension,
  summarizeActionResults,
  validateAiProposal,
  validateAssistantTurnRequest,
  validateAssistantTurnResponse,
  validateLocalCommand,
  validateOperationReceipt,
} from '../src/index.js';
import {
  catalogueBoundary,
  commandFixture,
  ids,
  receiptFixture,
  requestFixture,
  responseFixture,
} from './fixtures.js';

test('same strict envelope works for both mobile and gateway', () => {
  assert.equal(checkAssistantRequest(requestFixture(), catalogueBoundary).ok, true);
  assert.equal(checkAssistantResponse(responseFixture(), catalogueBoundary).ok, true);
  assert.equal(validateOperationReceipt(receiptFixture()), true);
});

test('reject consequential unknown fields at every nesting level without modifying input', () => {
  for (const mutate of [
    (r: Record<string, any>) => {
      r.clientId = ids.intent;
    },
    (r: Record<string, any>) => {
      r.context.preferences.admin = true;
    },
    (r: Record<string, any>) => {
      r.message.sql = 'DELETE FROM recipe';
    },
    (r: Record<string, any>) => {
      r.context.date.model = 'other-model';
    },
  ]) {
    const request = structuredClone(requestFixture());
    mutate(request);
    const before = structuredClone(request);
    assert.equal(validateAssistantTurnRequest(request), false);
    assert.deepEqual(request, before);
  }
});

test('no coercion, consequential default insertion or unsafe integer revisions', () => {
  for (const value of ['1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(
      validateAssistantTurnRequest({ ...requestFixture(), intentRevision: value }),
      false,
    );
  }
  const request: Record<string, unknown> = { ...requestFixture() };
  delete request.capabilities;
  assert.equal(validateAssistantTurnRequest(request), false);
  assert.equal('capabilities' in request, false);
});

test('only the three supported AI proposals are accepted', () => {
  assert.equal(validateAiProposal({ kind: 'saveRecipe', recipeId: '53262' }), true);
  assert.equal(
    validateAiProposal({
      kind: 'addPlan',
      recipeId: '53262',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty' },
    }),
    true,
  );
  assert.equal(
    validateAiProposal({
      kind: 'savePreference',
      type: 'ingredient_avoid',
      explicitValue: 'peanuts',
    }),
    true,
  );
  for (const kind of [
    'removePlan',
    'movePlanReplacing',
    'clearConversation',
    'executeSql',
    'saveRecipe; DROP',
  ])
    assert.equal(validateAiProposal({ kind, recipeId: '53262' }), false);
  assert.equal(
    validateAiProposal({ kind: 'saveRecipe', recipeId: '53262', committed: true }),
    false,
  );
  assert.equal(
    validateAiProposal({ kind: 'savePreference', type: 'apiKey', explicitValue: 'fake' }),
    false,
  );
});

test('version and unknown source identities fail; actual dates require semantic validation', () => {
  assert.equal(validateAssistantTurnRequest({ ...requestFixture(), apiVersion: '1' }), false);
  assert.equal(
    checkAssistantRequest(
      { ...requestFixture(), catalogue: { version: 'changed', fingerprint: 'a'.repeat(64) } },
      catalogueBoundary,
    ).ok,
    false,
  );
  const request = requestFixture();
  request.context.selectedRecipeId = '99999';
  assert.equal(checkAssistantRequest(request, catalogueBoundary).ok, false);
  request.context.selectedRecipeId = '53262';
  request.context.date.localDate = '2026-02-29';
  assert.equal(validateAssistantTurnRequest(request), true);
  assert.equal(checkAssistantRequest(request, catalogueBoundary).ok, false);
});

test('Gregorian dates, leap years and UTC audit timestamps do not normalize invalid values', () => {
  for (const date of ['2024-02-29', '2000-02-29', '0001-01-01', '2020-12-31'])
    assert.equal(isActualLocalDate(date), true, date);
  for (const date of [
    '1900-02-29',
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '0000-01-01',
    '2026-9-28',
    '2026-09-00',
  ])
    assert.equal(isActualLocalDate(date), false, date);
  assert.equal(isUtcInstant('2026-09-28T02:00:00.000Z'), true);
  assert.equal(isUtcInstant('2026-02-30T02:00:00.000Z'), false);
  assert.equal(isUtcInstant('2026-09-28T24:00:00.000Z'), false);
});

test('Unicode message limit counts code points and never truncates', () => {
  const request = requestFixture();
  request.message.text = '🍎'.repeat(4000);
  assert.equal(validateAssistantTurnRequest(request), true);
  request.message.text += '🍎';
  assert.equal(validateAssistantTurnRequest(request), false);
  assert.equal([...request.message.text].length, 4001);
});

test('ordered recipe references survive validation without fresh ranking', () => {
  const request = requestFixture();
  request.context.referenceSets = [
    { referenceSetId: ids.slot, messageId: ids.message, recipeIds: ['52771', '53262'] },
  ];
  assert.equal(checkAssistantRequest(request, catalogueBoundary).ok, true);
  assert.deepEqual(request.context.referenceSets[0]?.recipeIds, ['52771', '53262']);
});

test('every response scope counter participates in obsolete-response rejection', () => {
  const response = responseFixture();
  const active = { ...response };
  assert.equal(isResponseCurrent(response, active), true);
  for (const key of [
    'intentRevision',
    'conversationGeneration',
    'connectionGeneration',
    'preferenceRevision',
  ] as const)
    assert.equal(isResponseCurrent(response, { ...active, [key]: 1 }), false, key);
  for (const key of ['requestId', 'userIntentId', 'conversationId'] as const)
    assert.equal(isResponseCurrent(response, { ...active, [key]: ids.destination }), false, key);
  const before = requestFixture().context.date;
  assert.equal(isRelativeDateContextCurrent(before, { ...before, localDate: '2026-09-29' }), false);
  assert.equal(isRelativeDateContextCurrent(before, { ...before, utcOffsetMinutes: 0 }), false);
});

test('UI commands need no conversation; occupied replacement and move require distinct guards', () => {
  const command = commandFixture();
  assert.equal(validateLocalCommand(command), true);
  const move = {
    ...command,
    command: {
      kind: 'movePlanReplacing',
      occurrenceId: ids.occurrence,
      expectedRevision: 1,
      destinationOccurrenceId: ids.destination,
      expectedDestinationRevision: 2,
      expectedShoppingScopeRevision: 3,
      recipeId: '53262',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
    },
  };
  assert.equal(checkLocalCommand(move, catalogueBoundary).ok, true);
  for (const key of [
    'expectedRevision',
    'expectedDestinationRevision',
    'expectedShoppingScopeRevision',
  ]) {
    const broken = structuredClone(move) as Record<string, any>;
    delete broken.command[key];
    assert.equal(validateLocalCommand(broken), false, key);
  }
  assert.equal(
    checkLocalCommand(
      { ...move, command: { ...move.command, destinationOccurrenceId: ids.occurrence } },
      catalogueBoundary,
    ).ok,
    false,
  );
});

test('frozen payload canonicalization and operation identity expose changed retry arguments', () => {
  const command = commandFixture();
  const { payloadFingerprint: ignored, ...unhashed } = command;
  void ignored;
  const hash = (input: typeof unhashed) =>
    createHash('sha256').update(commandFingerprintInput(input)).digest('hex');
  assert.equal(
    hash(unhashed),
    hash({ ...unhashed, command: { saved: true, recipeId: '53262', kind: 'setFavourite' } }),
  );
  assert.equal(commandFingerprintInput(command), commandFingerprintInput(unhashed));
  assert.notEqual(
    hash(unhashed),
    hash({ ...unhashed, command: { kind: 'setFavourite', recipeId: '53262', saved: false } }),
  );
  assert.equal(matchOperationReceipt(command, receiptFixture()), 'existing');
  assert.equal(
    matchOperationReceipt({ ...command, payloadFingerprint: 'c'.repeat(64) }, receiptFixture()),
    'conflict',
  );
});

test('cancel after dispatch reconciles; settled and cancelled intents cannot auto-replay', () => {
  assert.equal(phaseAfterCancel('confirmation'), 'cancelled');
  assert.equal(phaseAfterCancel('dispatched'), 'reconciling');
  assert.equal(phaseAfterCancel('settled'), 'settled');
  assert.equal(canTransitionIntent('settled', 'dispatched'), false);
  assert.equal(canTransitionIntent('cancelled', 'ready'), false);
  assert.equal(canTransitionIntent('ready', 'dispatched'), true);
});

test('startup suspension is restricted to frozen-plan phases and does not reactivate authority', () => {
  for (const phase of ['ready', 'dispatched', 'reconciling'] as const)
    assert.equal(phaseAfterStartupSuspension(phase), 'reconciling');
  for (const phase of [
    'draft',
    'awaiting_response',
    'clarification',
    'confirmation',
    'settled',
    'cancelled',
  ] as const)
    assert.equal(phaseAfterStartupSuspension(phase), null);
  assert.equal(phaseAfterCancel('ready'), 'cancelled');
  assert.equal(canTransitionIntent('ready', 'reconciling'), false);
  assert.equal(canTransitionIntent('reconciling', 'ready'), false);
  assert.equal(canTransitionIntent('reconciling', 'dispatched'), false);
  assert.equal(canTransitionIntent('reconciling', 'settled'), true);
});

test('partial and uncertain outcomes cannot become unqualified success', () => {
  const first = { slotId: ids.slot, command: commandFixture() };
  const second = {
    slotId: ids.otherSlot,
    command: { ...commandFixture(), operationId: ids.destination },
  };
  assert.equal(
    summarizeActionResults(
      {
        userIntentId: ids.intent,
        slots: [
          { slotId: ids.slot, result: { kind: 'receipt', receipt: receiptFixture() } },
          {
            slotId: ids.otherSlot,
            result: {
              kind: 'failed',
              operationId: ids.destination,
              error: { code: 'storage_failure', messageKey: 'storage.failed', retry: 'reconcile' },
            },
          },
        ],
      },
      { userIntentId: ids.intent, slots: [first, second] },
    ),
    'partial',
  );
  assert.equal(
    summarizeActionResults(
      {
        userIntentId: ids.intent,
        slots: [{ slotId: ids.slot, result: { kind: 'uncertain', operationId: ids.operation } }],
      },
      { userIntentId: ids.intent, slots: [first] },
    ),
    'uncertain',
  );
});

test('batch summary rejects duplicate slots, mismatched intent and results outside frozen operations', () => {
  const first = { slotId: ids.slot, command: commandFixture() };
  const frozen = { userIntentId: ids.intent, slots: [first] };
  const result = {
    userIntentId: ids.intent,
    slots: [{ slotId: ids.slot, result: { kind: 'receipt', receipt: receiptFixture() } }],
  };
  assert.equal(summarizeActionResults(result, frozen), 'complete');
  assert.equal(
    summarizeActionResults(
      { ...result, slots: [...result.slots, ...result.slots] },
      { ...frozen, slots: [first, first] },
    ),
    'invalid',
  );
  for (const change of [
    { userIntentId: ids.destination },
    { operationId: ids.destination },
    { payloadFingerprint: 'c'.repeat(64) },
  ]) {
    assert.equal(
      summarizeActionResults(
        {
          ...result,
          slots: [
            {
              slotId: ids.slot,
              result: { kind: 'receipt', receipt: { ...receiptFixture(), ...change } },
            },
          ],
        },
        frozen,
      ),
      'invalid',
    );
  }
  assert.equal(
    summarizeActionResults(
      {
        ...result,
        slots: [{ slotId: ids.slot, result: { kind: 'uncertain', operationId: ids.destination } }],
      },
      frozen,
    ),
    'invalid',
  );
});

test('model output cannot insert an operation receipt into a proposal', () => {
  assert.equal(
    validateAssistantTurnResponse({ ...responseFixture(), receipt: receiptFixture() }),
    false,
  );
});

test('citation positions and annotations must belong to the cited recipe', () => {
  const response = responseFixture();
  for (const section of ['ingredient', 'instruction'] as const) {
    response.sources = [{ recipeId: '53262', section, position: 1 }];
    assert.equal(checkAssistantResponse(response, catalogueBoundary).ok, true);
    response.sources = [{ recipeId: '52771', section, position: 1 }];
    assert.equal(validateAssistantTurnResponse(response), true);
    assert.equal(checkAssistantResponse(response, catalogueBoundary).ok, false);
  }
  response.sources = [
    { recipeId: '53262', section: 'annotation', annotationId: 'fixture-53262-note' },
  ];
  assert.equal(checkAssistantResponse(response, catalogueBoundary).ok, true);
  response.sources = [
    { recipeId: '52771', section: 'annotation', annotationId: 'fixture-53262-note' },
  ];
  assert.equal(checkAssistantResponse(response, catalogueBoundary).ok, false);
  assert.equal(
    validateAssistantTurnResponse({
      ...response,
      sources: [{ recipeId: '53262', section: 'instruction' }],
    }),
    false,
  );
});

test('v2 supports inclusive 1900–2100 dates and rejects dates outside that range', () => {
  for (const [date, expected] of [
    ['1900-01-01', true],
    ['2100-12-31', true],
    ['1899-12-31', false],
    ['2101-01-01', false],
  ] as const) {
    const request = requestFixture();
    request.context.date.localDate = date;
    request.message.sourceDateContext.localDate = date;
    assert.equal(checkAssistantRequest(request, catalogueBoundary).ok, expected);
  }
});

test('relative-date guards describe the exact frozen placement, never another command', () => {
  const relativeDateGuard = {
    interpretedAt: requestFixture().context.date,
    resolvedDate: '2026-09-29',
    sourceMessageId: ids.message,
  };
  const command = {
    ...commandFixture(),
    relativeDateGuard,
    command: {
      kind: 'addPlan',
      occurrenceId: ids.occurrence,
      recipeId: '53262',
      placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty' },
    },
  };
  assert.equal(checkLocalCommand(command, catalogueBoundary).ok, true);
  assert.equal(
    checkLocalCommand(
      {
        ...command,
        command: {
          ...command.command,
          placement: { ...command.command.placement, actualDate: '2026-09-30' },
        },
      },
      catalogueBoundary,
    ).ok,
    false,
  );
  assert.equal(
    checkLocalCommand({ ...commandFixture(), relativeDateGuard }, catalogueBoundary).ok,
    false,
  );
});
