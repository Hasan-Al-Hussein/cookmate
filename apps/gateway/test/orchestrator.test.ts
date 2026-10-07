import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createEvidenceBuilder } from '../src/evidence';
import { createOrchestrator } from '../src/orchestrator';
import { GatewayError, gatewayError } from '../src/errors';
import type { ModelProvider, ProviderInput } from '../src/provider-contract';
import { request, nonMemoryUpdate } from './helpers';

const evidence = createEvidenceBuilder();
const execution = () => ({ signal: new AbortController().signal, deadline: Date.now() + 45000 });
const respond = (response: object) => ({
  kind: 'respond',
  sufficiency: 'sufficient',
  missingFacts: [],
  memoryUpdate: nonMemoryUpdate(),
  response,
});
const answer = () =>
  respond({
    kind: 'answer',
    text: 'Adana kebab is in the source.',
    sources: [{ recipeId: '53262', section: 'recipe' }],
    recipeIds: ['53262'],
  });
function fake(...values: unknown[]) {
  const inputs: ProviderInput[] = [];
  const provider: ModelProvider = {
    async complete(input) {
      inputs.push(structuredClone(input));
      return {
        value: values[inputs.length - 1],
        usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 },
      };
    },
  };
  return { inputs, run: createOrchestrator(provider) };
}
const invalid = (error: unknown) =>
  error instanceof GatewayError && error.detail.code === 'invalid_model_result';

test('complete source packets retain Adana, Padron, Bread omelette warnings, unknown measures and locator order', () => {
  const recipes = catalogue.recipes.filter((recipe) =>
    /adana|padron|bread omelette/i.test(recipe.title),
  );
  assert.equal(recipes.length, 3);
  for (const recipe of recipes) {
    const packet = evidence.packet([recipe.recipeId])[0]!;
    assert.equal(packet.ingredients.length, recipe.ingredients.length);
    assert.equal(packet.instructions.length, recipe.instructions.length);
    assert.equal(packet.annotations.length, recipe.annotations.length);
    assert.deepEqual(
      packet.instructions.map((item) => item.rawText),
      recipe.instructions.map((item) => item.rawText),
    );
    assert.equal(packet.annotations.length > 0, true);
    for (const field of ['photo', 'image', 'imageUrl', 'videoUrl', 'sourceUrl'])
      assert.equal(Object.hasOwn(packet, field), false);
  }
  const unknown = catalogue.recipes.find((recipe) =>
    recipe.ingredients.some((item) => item.rawMeasure === null),
  );
  assert.ok(unknown);
  assert.equal(
    evidence.packet([unknown.recipeId])[0]!.ingredients.some((item) => item.rawMeasure === null),
    true,
  );
});

test('valid reply receives original envelope and full reviewed source notes', async () => {
  const f = fake(answer());
  const result = await f.run(request(), execution());
  assert.equal(result.requestId, request().requestId);
  assert.equal(result.kind, 'answer');
  if (result.kind !== 'answer') return;
  for (const annotation of evidence.packet(['53262'])[0]!.annotations) {
    assert.ok(result.text.includes(annotation.note));
    const reference = annotation.source;
    assert.ok(
      reference.section === 'annotation' &&
        result.sources.some(
          (source) =>
            source.section === 'annotation' && source.annotationId === reference.annotationId,
        ),
    );
  }
});

test('rewritten retrieval uses domain search and a bounded second generation; no fabricated sources/actions pass', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  const f = fake(
    {
      kind: 'retrieve',
      criteria: { query: 'Adana' },
      recipeIds: [],
      requiredFacts: ['ingredients and instructions'],
    },
    answer(),
  );
  const result = await f.run(input, execution());
  assert.equal(result.kind, 'answer');
  assert.equal(f.inputs.length, 2);
  assert.equal(f.inputs[1]!.evidence[0]!.recipeId, '53262');
  const rewritten = f.inputs[1]!.retrieval.at(-1)!;
  assert.equal(rewritten.kind, 'search');
  if (rewritten.kind !== 'search') throw new Error('expected_search');
  assert.equal(rewritten.origin, 'model_requested');
  assert.equal(rewritten.strictMatchCount, 1);
  assert.equal(rewritten.spellingSuggestionCount, 0);
  assert.equal(rewritten.returnedFrom, 'strict_matches');
  assert.equal(rewritten.resultSetFullyReturned, true);
  assert.deepEqual(rewritten.criteria, { query: 'Adana' });
  assert.deepEqual(rewritten.requiredFacts, ['ingredients and instructions']);
  const more = fake(
    { kind: 'retrieve', criteria: {}, recipeIds: [], requiredFacts: [] },
    { kind: 'retrieve', criteria: {}, recipeIds: [], requiredFacts: [] },
  );
  assert.equal((await more.run(input, execution())).kind, 'clarification');
  assert.equal(more.inputs.length, 2);
  // An exhausted round does not authorize accepting a malformed retrieval step.
  const malformedLast = fake(
    { kind: 'retrieve', criteria: {}, recipeIds: [], requiredFacts: [] },
    { kind: 'retrieve' },
  );
  await assert.rejects(malformedLast.run(input, execution()), invalid);
  assert.equal(malformedLast.inputs.length, 2);
  const malformed = [
    { ...answer(), sufficiency: ['sufficient'] },
    respond({
      kind: 'answer',
      text: 'invented',
      sources: [{ recipeId: '53262', section: 'instruction', position: 999 }],
      recipeIds: [],
    }),
    respond({ kind: 'answer', text: 'I saved the recipe.', sources: [], recipeIds: [] }),
    respond({ kind: 'answer', text: 'Your recipe has been saved.', sources: [], recipeIds: [] }),
    respond({ kind: 'answer', text: 'Added to your plan.', sources: [], recipeIds: [] }),
    respond({
      kind: 'proposal',
      text: 'review',
      sources: [{ recipeId: '53262', section: 'recipe' }],
      recipeIds: [],
      proposals: [{ kind: 'removeRecipe', recipeId: '53262' }],
    }),
    {
      kind: 'retrieve',
      criteria: { url: 'https://example.invalid' },
      recipeIds: [],
      requiredFacts: [],
    },
  ];
  for (const value of malformed)
    await assert.rejects(fake(value).run(request(), execution()), invalid);
  const oversizedCriteria = fake(
    {
      kind: 'retrieve',
      criteria: { ingredients: Array.from({ length: 21 }, () => 'salt') },
      recipeIds: [],
      requiredFacts: [],
    },
    answer(),
  );
  await assert.rejects(oversizedCriteria.run(request(), execution()), invalid);
  assert.equal(oversizedCriteria.inputs.length, 1);
});

test('initial broad search carries exact count basis and a visible incomplete-evidence marker', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.text = 'chicken';
  const f = fake(
    respond({
      kind: 'answer',
      text: 'Please select a recipe to inspect its details.',
      sources: [],
      recipeIds: [],
    }),
  );
  await f.run(input, execution());
  const initial = f.inputs[0]!.retrieval[0]!;
  assert.equal(initial.kind, 'search');
  if (initial.kind !== 'search') throw new Error('expected_search');
  const found = evidence.retrieve({ query: 'chicken' });
  assert.equal(initial.origin, 'raw_message');
  assert.equal(initial.strictMatchCount, found.matches.length);
  assert.ok(initial.strictMatchCount > 6);
  assert.equal(initial.spellingSuggestionCount, 0);
  assert.equal(initial.returnedRecipeIds.length, 6);
  assert.equal(initial.returnedFrom, 'strict_matches');
  assert.equal(initial.resultSetFullyReturned, false);
  assert.equal(initial.intentCoverage, 'unverified');
  assert.equal(initial.packetCoverage, 'full_source_rows_for_returned_recipes');
  assert.equal(initial.searchRuleFingerprint, found.ruleFingerprint);
  assert.deepEqual(initial.indexedFields, ['title', 'ingredient_name', 'cuisine', 'category']);
});

test('direct reference IDs have separate provenance and cannot be mixed with search criteria', async () => {
  const direct = fake(
    { kind: 'retrieve', criteria: {}, recipeIds: ['53262'], requiredFacts: [] },
    answer(),
  );
  await direct.run(request(), execution());
  const provenance = direct.inputs[1]!.retrieval.at(-1)!;
  assert.deepEqual(provenance, {
    kind: 'selection',
    origin: 'explicit_recipes',
    returnedRecipeIds: ['53262'],
    requiredFacts: [],
    packetCoverage: 'full_source_rows_for_returned_recipes',
    intentCoverage: 'unverified',
  });
  assert.deepEqual(direct.inputs[0]!.retrieval[0], {
    ...provenance,
    origin: 'selected_recipe',
  });
  for (const step of [
    { kind: 'retrieve', criteria: { query: 'Adana' }, recipeIds: ['52765'], requiredFacts: [] },
    { kind: 'retrieve', criteria: {}, recipeIds: ['52765'], requiredFacts: [] },
  ])
    await assert.rejects(fake(step).run(request(), execution()), invalid);
});

test('bare ambiguous older reference clarifies before provider; unique older list resolves without newest substitution', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.text = 'The second recipe?';
  input.context.referenceSets = [
    {
      referenceSetId: '00000000-0000-4000-8000-000000000006',
      messageId: '00000000-0000-4000-8000-000000000007',
      recipeIds: ['52765', '53262'],
    },
    {
      referenceSetId: '00000000-0000-4000-8000-000000000008',
      messageId: '00000000-0000-4000-8000-000000000009',
      recipeIds: ['53262', '52765'],
    },
  ];
  const ambiguous = fake();
  const clarification = await ambiguous.run(input, execution());
  assert.equal(clarification.kind, 'clarification');
  if (clarification.kind !== 'clarification') throw new Error('expected_clarification');
  assert.deepEqual(clarification.referenceSets, []);
  assert.deepEqual(clarification.sources, []);
  assert.equal(Object.hasOwn(clarification, 'proposals'), false);
  assert.equal(ambiguous.inputs.length, 0);
  input.context.referenceSets.pop();
  input.message.text = 'Tell me about the second recipe.';
  const unique = fake(answer());
  assert.equal((await unique.run(input, execution())).kind, 'answer');
  assert.equal(unique.inputs[0]!.evidence[0]!.recipeId, '53262');
  assert.deepEqual(unique.inputs[0]!.retrieval[0], {
    kind: 'selection',
    origin: 'ordered_reference',
    returnedRecipeIds: ['53262'],
    requiredFacts: [],
    packetCoverage: 'full_source_rows_for_returned_recipes',
    intentCoverage: 'unverified',
  });
});

function descriptiveOlderListRequest() {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.sourceSequence = 3;
  input.context.referenceSets = [
    {
      referenceSetId: '00000000-0000-4000-8000-000000000006',
      messageId: '00000000-0000-4000-8000-000000000007',
      recipeIds: ['53150', '53262', '53076'],
    },
    {
      referenceSetId: '00000000-0000-4000-8000-000000000008',
      messageId: '00000000-0000-4000-8000-000000000009',
      recipeIds: ['53169', '52982', '53049'],
    },
  ];
  input.context.history = input.context.referenceSets.map((set, index) => ({
    messageId: set.messageId,
    role: 'assistant',
    sourceSequence: index + 1,
    text: set.recipeIds
      .map((id, ordinal) => `${ordinal + 1}. ${catalogue.getRecipe(id)!.title}`)
      .join('\n'),
  }));
  return input;
}

test('descriptive older-list dish and recipe wording reach interpretation with unchanged ordered evidence', async () => {
  for (const noun of ['dish', 'recipe']) {
    const input = descriptiveOlderListRequest();
    input.message.text = `The second ${noun} in that earlier peppers, kebab, omelette list—what meat does it list?`;
    assert.deepEqual(evidence.namedRecipeIds(input.message.text), []);
    const before = structuredClone(input);
    const meatSource = { recipeId: '53262', section: 'ingredient', position: 2 } as const;
    const f = fake(
      { kind: 'retrieve', criteria: {}, recipeIds: ['53262'], requiredFacts: ['meat and amount'] },
      respond({
        kind: 'answer',
        text: 'Adana kebab lists Lamb Mince, 800g.',
        sources: [meatSource],
        recipeIds: ['53262'],
      }),
    );
    const result = await f.run(input, execution());
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected_answer');
    assert.equal(f.inputs.length, 2);
    for (const captured of f.inputs) assert.deepEqual(captured.request, before);
    const initial = f.inputs[0]!.retrieval[0]!;
    assert.equal(initial.kind, 'search');
    if (initial.kind !== 'search') throw new Error('expected_search');
    assert.equal(initial.origin, 'raw_message');
    assert.deepEqual(initial.criteria, { query: input.message.text });
    assert.equal(initial.intentCoverage, 'unverified');
    assert.deepEqual(
      f.inputs[1]!.evidence.map((recipe) => recipe.recipeId),
      ['53262'],
    );
    assert.deepEqual(f.inputs[1]!.retrieval.at(-1), {
      kind: 'selection',
      origin: 'explicit_recipes',
      returnedRecipeIds: ['53262'],
      requiredFacts: ['meat and amount'],
      packetCoverage: 'full_source_rows_for_returned_recipes',
      intentCoverage: 'unverified',
    });
    const meat = f.inputs[1]!.evidence[0]!.ingredients.find(
      (item) => item.source.section === 'ingredient' && item.source.position === 2,
    );
    assert.ok(meat);
    assert.equal(meat.rawName, 'Lamb Mince');
    assert.equal(meat.rawMeasure, '800g');
    assert.deepEqual(meat.locator, { column: 'D', row: 7, sheet: 'Ingredients' });
    assert.ok(
      result.sources.some(
        (source) =>
          source.recipeId === '53262' && source.section === 'ingredient' && source.position === 2,
      ),
    );
    assert.deepEqual(
      result.referenceSets.map((set) => set.recipeIds),
      [['53262']],
    );
    assert.equal(Object.hasOwn(result, 'proposals'), false);
    assert.deepEqual(input, before);
  }
});

test('bare multi-list ordinal has no target; sentence-level ambiguity can receive a model clarification', async () => {
  const input = descriptiveOlderListRequest();
  input.message.text = 'second recipe';
  const bare = fake();
  const bareResult = await bare.run(input, execution());
  assert.equal(bareResult.kind, 'clarification');
  if (bareResult.kind !== 'clarification') throw new Error('expected_clarification');
  assert.deepEqual(bareResult.referenceSets, []);
  assert.deepEqual(bareResult.sources, []);
  assert.equal(Object.hasOwn(bareResult, 'proposals'), false);
  assert.equal(bare.inputs.length, 0);

  // A fake clarification proves transport here, not semantic ambiguity detection by a live model.
  input.message.text = 'Tell me about the second recipe.';
  const interpreted = fake({
    kind: 'respond',
    sufficiency: 'insufficient',
    missingFacts: ['which earlier recipe list'],
    memoryUpdate: nonMemoryUpdate(input),
    response: {
      kind: 'clarification',
      text: 'Which earlier recipe list do you mean?',
      missing: ['reference'],
      sources: [],
      recipeIds: [],
    },
  });
  const result = await interpreted.run(input, execution());
  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') throw new Error('expected_clarification');
  assert.deepEqual(result.referenceSets, []);
  assert.deepEqual(result.sources, []);
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  assert.equal(interpreted.inputs.length, 1);
  assert.deepEqual(interpreted.inputs[0]!.request, input);
  assert.equal(interpreted.inputs[0]!.retrieval[0]!.origin, 'raw_message');
});

test('D23 bare save ambiguity keeps every review pending without a provider or proposal', async () => {
  const input = descriptiveOlderListRequest();
  input.message.text = 'Save the second one';
  const priorSourceId = '00000000-0000-4000-8000-000000000010';
  input.context.memory.pendingSources = [
    {
      sourceMessageId: priorSourceId,
      sourceSequence: 0,
      quote: 'Keep meals peanut-free today.',
      sourceDateContext: { ...input.message.sourceDateContext },
      preferenceRevisionAtSource: 0,
      preferenceLinks: [],
    },
  ];
  input.context.memory.reviewTargetMessageIds = [priorSourceId, input.message.messageId];
  Object.assign(input.context.memory.coverage, {
    pendingUserSourceCount: 2,
    pendingWorkingSourceCount: 2,
    suppliedReviewTargetCount: 2,
  });
  const before = structuredClone(input);
  const f = fake();
  const result = await f.run(input, execution());
  assert.equal(f.inputs.length, 0);
  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') throw new Error('expected_clarification');
  assert.deepEqual(result.missing, ['reference']);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.referenceSets, []);
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  assert.deepEqual(result.memoryUpdate.entries, []);
  assert.deepEqual(result.memoryUpdate.reviews, [
    { sourceMessageId: priorSourceId, disposition: 'unresolved' },
    { sourceMessageId: input.message.messageId, disposition: 'unresolved' },
  ]);
  assert.deepEqual(input, before);
});

test('qualified save reference reaches interpretation with real ordered lists intact', async () => {
  const input = descriptiveOlderListRequest();
  input.message.text = 'Save the second one from the earlier Italian list';
  const before = structuredClone(input);
  // The scripted clarification proves routing; it does not resolve this description semantically.
  const f = fake({
    kind: 'respond',
    sufficiency: 'insufficient',
    missingFacts: ['which earlier recipe list'],
    memoryUpdate: nonMemoryUpdate(input),
    response: {
      kind: 'clarification',
      text: 'Which earlier recipe list do you mean?',
      missing: ['reference'],
      sources: [],
      recipeIds: [],
    },
  });
  const result = await f.run(input, execution());
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0]!.request, before);
  assert.equal(f.inputs[0]!.retrieval[0]!.origin, 'raw_message');
  assert.equal(result.kind, 'clarification');
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  assert.deepEqual(input, before);
});

test('raw sentence zero and a genuine requested zero retain distinct origin and no claim of intent coverage', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.text = "I've got olive oil and padron peprs—anything in our recipes for that?";
  const f = fake(
    {
      kind: 'retrieve',
      criteria: { query: 'zzzznotaningredient' },
      recipeIds: [],
      requiredFacts: ['matching source recipes'],
    },
    respond({
      kind: 'answer',
      text: 'That search returned no matches.',
      sources: [],
      recipeIds: [],
    }),
  );
  await f.run(input, execution());
  assert.equal(f.inputs.length, 2);
  const [initial, followup] = f.inputs[1]!.retrieval;
  assert.ok(initial?.kind === 'search' && followup?.kind === 'search');
  assert.equal(initial.origin, 'raw_message');
  assert.deepEqual(initial.criteria, { query: input.message.text });
  assert.equal(followup.origin, 'model_requested');
  assert.deepEqual(followup.criteria, { query: 'zzzznotaningredient' });
  for (const entry of [initial, followup]) {
    assert.equal(entry.strictMatchCount, 0);
    assert.equal(entry.spellingSuggestionCount, 0);
    assert.deepEqual(entry.returnedRecipeIds, []);
    assert.equal(entry.resultSetFullyReturned, true);
    assert.equal(entry.intentCoverage, 'unverified');
    for (const legacy of ['complete', 'totalMatches', 'approximate'])
      assert.equal(Object.hasOwn(entry, legacy), false);
  }
  assert.equal(initial.returnedFrom, 'strict_matches');
  assert.equal(followup.returnedFrom, 'spelling_suggestions');
});

test('spelling suggestions keep separate counts and the existing strict-only initial selection and action hold', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.text = 'Adna';
  const found = evidence.retrieve({ query: input.message.text });
  assert.equal(found.matches.length, 0);
  assert.ok(found.suggestions.some((item) => item.recipeId === '53262'));
  const initial = evidence.initial(input);
  assert.equal(initial.packet.length, 0);
  assert.equal(initial.selection.kind, 'search');
  if (initial.selection.kind !== 'search') throw new Error('expected_search');
  assert.equal(initial.selection.spellingSuggestionCount, found.suggestions.length);
  assert.equal(initial.selection.returnedFrom, 'strict_matches');
  assert.equal(initial.selection.resultSetFullyReturned, true);
  const f = fake(
    { kind: 'retrieve', criteria: { query: 'Adna' }, recipeIds: [], requiredFacts: [] },
    respond({
      kind: 'proposal',
      text: 'Review this possible recipe.',
      sources: [{ recipeId: '53262', section: 'recipe' }],
      recipeIds: ['53262'],
      proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
    }),
  );
  const result = await f.run(input, execution());
  assert.equal(result.kind, 'clarification');
  assert.equal(f.inputs.length, 2);
  const followup = f.inputs[1]!.retrieval.at(-1)!;
  assert.equal(followup.kind, 'search');
  if (followup.kind !== 'search') throw new Error('expected_search');
  assert.equal(followup.strictMatchCount, 0);
  assert.equal(followup.spellingSuggestionCount, found.suggestions.length);
  assert.equal(followup.returnedFrom, 'spelling_suggestions');
  assert.deepEqual(
    followup.returnedRecipeIds,
    found.suggestions.slice(0, 6).map((item) => item.recipeId),
  );
  assert.equal(followup.resultSetFullyReturned, found.suggestions.length <= 6);
});

test('metadata alone is not a semantic absence guard and natural source-free replies remain permitted', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.text = "I've got olive oil and padron peprs—anything in our recipes for that?";
  // Known semantic failure stays structurally valid; this is not a semantic PASS fixture.
  const unsupported =
    "I couldn't find any recipes in our catalogue using olive oil and padron peppers.";
  for (const text of [unsupported, 'Hello! What would you like to cook?']) {
    const f = fake(respond({ kind: 'answer', text, sources: [], recipeIds: [] }));
    const result = await f.run(input, execution());
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected_answer');
    assert.equal(result.text, text);
    assert.equal(f.inputs.length, 1);
  }
});

test('explicit recipe name or focused selection resolves ordinals across multiple older lists', async () => {
  const input = request();
  input.context.referenceSets = [
    {
      referenceSetId: '00000000-0000-4000-8000-000000000006',
      messageId: '00000000-0000-4000-8000-000000000007',
      recipeIds: ['52765', '53262'],
    },
    {
      referenceSetId: '00000000-0000-4000-8000-000000000008',
      messageId: '00000000-0000-4000-8000-000000000009',
      recipeIds: ['53262', '52765'],
    },
  ];
  input.message.text = 'Tell me about the second recipe.';
  const focused = fake(answer());
  await focused.run(input, execution());
  assert.equal(focused.inputs.length, 1);
  assert.equal(focused.inputs[0]!.evidence[0]!.recipeId, '53262');
  assert.equal(focused.inputs[0]!.retrieval[0]!.origin, 'selected_recipe');
  delete input.context.selectedRecipeId;
  input.message.text = `The second recipe, ${catalogue.getRecipe('53262')!.title}, please.`;
  const named = fake(answer());
  await named.run(input, execution());
  assert.equal(named.inputs.length, 1);
  assert.equal(named.inputs[0]!.evidence[0]!.recipeId, '53262');
  assert.equal(named.inputs[0]!.retrieval[0]!.origin, 'explicit_recipes');
});

test('ordinary cooking completion language is not treated as an app write receipt', async () => {
  const value = respond({
    kind: 'answer',
    text: 'When the sauce coats the spoon, you are done.',
    sources: [],
    recipeIds: [],
  });
  const result = await fake(value).run(request(), execution());
  assert.equal(result.kind, 'answer');
});

test('actual cited milk instruction survives the completion guard; its citation cannot authorize a save claim', async () => {
  const input = request();
  input.context.selectedRecipeId = '52928';
  input.message.text = 'What do I do after adding the milk for BeaverTails?';
  const source = { recipeId: '52928', section: 'instruction', position: 2 } as const;
  const text =
    'After the milk has been added with the sugar, butter, eggs and salt, whisk until combined';
  const f = fake(respond({ kind: 'answer', text, sources: [source], recipeIds: ['52928'] }));
  const result = await f.run(input, execution());
  assert.equal(result.kind, 'answer');
  if (result.kind !== 'answer') throw new Error('expected_answer');
  assert.ok(result.text.startsWith(text));
  assert.ok(
    result.sources.some(
      (item) => item.recipeId === '52928' && item.section === 'instruction' && item.position === 2,
    ),
  );
  const passage = f.inputs[0]!.evidence[0]!.instructions.find(
    (item) => item.source.section === 'instruction' && item.source.position === 2,
  );
  assert.ok(passage);
  assert.equal(
    passage.rawText,
    'Into the same bowl, add 1/2 cup sugar, warm milk, melted butter, eggs and salt, and whisk until combined.',
  );
  assert.deepEqual(passage.locator, { column: 'D', row: 67, sheet: 'Instructions' });
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  for (const claim of [
    'I saved the recipe.',
    'Your recipe has been saved.',
    'Added to your plan.',
  ]) {
    await assert.rejects(
      fake(
        respond({
          kind: 'answer',
          text: claim,
          sources: [source],
          recipeIds: ['52928'],
        }),
      ).run(input, execution()),
      invalid,
    );
  }
});

test('negative and quoted app-completion explanations are allowed while affirmative statements are rejected', async () => {
  for (const text of [
    'No recipe has been saved in this turn',
    'The phrase ‘I saved the recipe’ would be inaccurate before confirmation',
    'No preference has been saved in this turn.',
    'Your preference has not been saved.',
    'Your cuisine preference has not been saved.',
    'No dietary preference has been saved.',
    'No meal has been added to your plan.',
    'No recipe has been added to your favourites.',
    'The phrase ‘Your preference has been saved’ would be inaccurate before confirmation.',
    'The phrase ‘I added the meal to your plan’ would be inaccurate before confirmation.',
    'The phrase ‘Adana kebab has been saved to your favourites’ would be inaccurate before confirmation.',
    'The phrase ‘I saved Adana kebab’ would be inaccurate before confirmation.',
    'The phrase ‘I saved your cuisine preference’ would be inaccurate before confirmation.',
  ]) {
    const f = fake(respond({ kind: 'answer', text, sources: [], recipeIds: [] }));
    const result = await f.run(request(), execution());
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected_answer');
    assert.equal(result.text, text);
    assert.deepEqual(result.referenceSets, []);
    assert.equal(Object.hasOwn(result, 'proposals'), false);
  }
  for (const text of [
    'I saved the recipe.',
    'Your recipe has been saved.',
    'Added to your plan.',
    'The source is available. I saved the recipe.',
    'I saved your preference.',
    'I saved your cuisine preference.',
    'Your preference has been saved.',
    'Your preferences have been saved.',
    'Your cuisine preference has been saved.',
    'Your ingredient avoid preference has been saved.',
    'Your dietary style preference has been saved.',
    'I added the meal to your plan.',
    'The meal has been scheduled in your plan.',
    'Your plan has been saved.',
    'I added Adana kebab to your favourites.',
    'I saved Adana kebab.',
    'Adana kebab has been saved to your favourites.',
    'Your favourites have been saved.',
    'Added to your favorites.',
    'I removed it from your favourites.',
  ]) {
    await assert.rejects(
      fake(respond({ kind: 'answer', text, sources: [], recipeIds: [] })).run(
        request(),
        execution(),
      ),
      invalid,
    );
  }
});

test('completed cooking steps do not become app writes merely because they name milk or a meal', async () => {
  const input = request();
  input.message.text =
    'I added the milk to the bowl and removed the meal from the oven. Does that change my plan?';
  for (const text of [
    'The milk has been added to the bowl; that does not change your plan.',
    'Your meal has been removed from the oven; that does not change your plan.',
  ]) {
    const result = await fake(respond({ kind: 'answer', text, sources: [], recipeIds: [] })).run(
      input,
      execution(),
    );
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected_answer');
    assert.equal(result.text, text);
    assert.equal(Object.hasOwn(result, 'proposals'), false);
  }
});

test('proposal capabilities and expected occupied target must match; model prose never establishes success', async () => {
  const proposal = respond({
    kind: 'proposal',
    text: 'Ready.',
    sources: [{ recipeId: '53262', section: 'recipe' }],
    recipeIds: ['53262'],
    proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
  });
  const input = request();
  input.capabilities = ['addPlan'];
  await assert.rejects(fake(proposal).run(input, execution()), invalid);
  input.capabilities = ['saveRecipe'];
  const output = await fake(proposal).run(input, execution());
  assert.equal(output.kind, 'proposal');
  if (output.kind === 'proposal')
    assert.ok(output.text.startsWith('Review these proposed changes'));
});

test('source budget exhaustion returns a focused narrowing response instead of dropping evidence', async () => {
  const provider: ModelProvider = {
    async complete() {
      throw gatewayError('too_large', 422);
    },
  };
  assert.equal((await createOrchestrator(provider)(request(), execution())).kind, 'clarification');
});
