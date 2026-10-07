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
  assert.equal(f.inputs[1]!.retrieval.at(-1)!.totalMatches, 1);
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
  assert.equal(initial.totalMatches, evidence.retrieve({ query: 'chicken' }).matches.length);
  assert.ok(initial.totalMatches > 6);
  assert.equal(initial.returnedRecipeIds.length, 6);
  assert.equal(initial.complete, false);
  assert.equal(initial.selection, 'search');
});

test('direct reference IDs have separate provenance and cannot be mixed with search criteria', async () => {
  const direct = fake(
    { kind: 'retrieve', criteria: {}, recipeIds: ['53262'], requiredFacts: [] },
    answer(),
  );
  await direct.run(request(), execution());
  const provenance = direct.inputs[1]!.retrieval.at(-1)!;
  assert.equal(provenance.selection, 'explicit_recipes');
  assert.equal(provenance.approximate, false);
  assert.equal(provenance.totalMatches, 1);
  assert.equal(provenance.complete, true);
  for (const step of [
    { kind: 'retrieve', criteria: { query: 'Adana' }, recipeIds: ['52765'], requiredFacts: [] },
    { kind: 'retrieve', criteria: {}, recipeIds: ['52765'], requiredFacts: [] },
  ])
    await assert.rejects(fake(step).run(request(), execution()), invalid);
});

test('ambiguous older reference sets clarify before provider; unique older list resolves without newest substitution', async () => {
  const input = request();
  delete input.context.selectedRecipeId;
  input.message.text = 'Tell me about the second recipe.';
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
  assert.equal((await ambiguous.run(input, execution())).kind, 'clarification');
  assert.equal(ambiguous.inputs.length, 0);
  input.context.referenceSets.pop();
  const unique = fake(answer());
  assert.equal((await unique.run(input, execution())).kind, 'answer');
  assert.equal(unique.inputs[0]!.evidence[0]!.recipeId, '53262');
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
  delete input.context.selectedRecipeId;
  input.message.text = `The second recipe, ${catalogue.getRecipe('53262')!.title}, please.`;
  const named = fake(answer());
  await named.run(input, execution());
  assert.equal(named.inputs.length, 1);
  assert.equal(named.inputs[0]!.evidence[0]!.recipeId, '53262');
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
