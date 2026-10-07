import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { MODEL_RESPONSE_SCHEMA } from '../src/provider-schema';
import { isModelStep } from '../src/model-validation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const placement = { actualDate: '2026-09-28', mealKey: 'dinner' };
const sources = [
  { recipeId: '53262', section: 'recipe' },
  { recipeId: '53262', section: 'ingredient', position: 1 },
  { recipeId: '53262', section: 'instruction', position: 1 },
  { recipeId: '53262', section: 'annotation', annotationId: '53262-instruction-only-salt' },
];
const proposals = [
  { kind: 'saveRecipe', recipeId: '53262' },
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
  { kind: 'addPlan', recipeId: '53262', placement, expectedTarget: { kind: 'empty' } },
  {
    kind: 'addPlan',
    recipeId: '53262',
    placement,
    expectedTarget: { kind: 'occupied', occurrenceId: id(5), expectedRevision: 0 },
  },
];
function examples() {
  const memoryUpdate = {
    baseRevision: 0,
    baseContextRevision: 0,
    reviews: [1, 2, 3].map((n) => ({ sourceMessageId: id(n), disposition: 'retain' })),
    entries: [
      { kind: 'conversation' },
      { kind: 'recipes', recipeIds: ['53262'] },
      { kind: 'placement', placement },
    ].map((scope, index) => ({
      sourceMessageId: id(index + 1),
      kind: 'constraint',
      scope,
      relations: [
        { kind: 'supersedes', target: { kind: 'memory', memoryId: id(4), expectedRevision: 0 } },
        { kind: 'conflicts_with', target: { kind: 'source', sourceMessageId: id(1) } },
      ],
    })),
  };
  return [
    {
      kind: 'retrieve',
      criteria: { query: 'Adana' },
      recipeIds: [],
      requiredFacts: ['ingredients'],
    },
    ...['answer', 'clarification', 'proposal'].map((kind) => ({
      kind: 'respond',
      sufficiency: kind === 'clarification' ? 'insufficient' : 'sufficient',
      missingFacts: [],
      memoryUpdate,
      response: {
        kind,
        text: 'Fictional structural contract fixture.',
        sources,
        recipeIds: ['53262'],
        ...(kind === 'clarification' ? { missing: ['recipe'] } : {}),
        ...(kind === 'proposal' ? { proposals } : {}),
      },
    })),
  ];
}

test('full contract admits structural witnesses covering all nine union locations and 27 branches', () => {
  // These exercise schema shape only. Request-aware provenance/capability checks still run later.
  const ajv = new Ajv({ strict: false });
  const validators = new Map<object, ReturnType<typeof ajv.compile>>();
  const coverage = new Map<string, { expected: number; branches: Set<number> }>();
  function visit(schema: any, value: any, path: string) {
    if (schema.anyOf) {
      const entry = coverage.get(path) ?? {
        expected: schema.anyOf.length,
        branches: new Set<number>(),
      };
      coverage.set(path, entry);
      schema.anyOf.forEach((branch: object, index: number) => {
        const validate = validators.get(branch) ?? ajv.compile(branch);
        validators.set(branch, validate);
        if (validate(value)) {
          entry.branches.add(index);
          visit(branch, value, `${path}/anyOf/${index}`);
        }
      });
    }
    if (schema.type === 'object' && value && typeof value === 'object')
      for (const [key, child] of Object.entries(schema.properties ?? {}))
        if (Object.hasOwn(value, key)) visit(child, value[key], `${path}/properties/${key}`);
    if (schema.type === 'array' && Array.isArray(value))
      value.forEach((item) => visit(schema.items, item, `${path}/items`));
  }
  for (const value of examples()) {
    const before = structuredClone(value);
    assert.equal(isModelStep(value), true);
    assert.deepEqual(value, before);
    visit(MODEL_RESPONSE_SCHEMA, value, '');
  }
  assert.equal(coverage.size, 9);
  assert.equal(
    [...coverage.values()].reduce((sum, item) => sum + item.branches.size, 0),
    27,
  );
  for (const [path, entry] of coverage) assert.equal(entry.branches.size, entry.expected, path);
});

test('full validation never coerces, supplies missing fields or deletes extra and wrong-branch fields', () => {
  const valid = examples()[1]!;
  const base = JSON.parse(JSON.stringify(valid));
  const missing = structuredClone(base);
  delete missing.memoryUpdate.entries;
  const variants = [
    { ...base, extra: 'must remain visible' },
    { ...base, criteria: {} },
    { ...base, memoryUpdate: { ...base.memoryUpdate, baseRevision: '0' } },
    { ...base, response: { ...base.response, proposals } },
    missing,
    { kind: 'retrieve' },
    { ...base, response: { ...base.response, kind: 'unknown' } },
  ];
  for (const value of variants) {
    const before = structuredClone(value);
    assert.equal(isModelStep(value), false);
    assert.deepEqual(value, before);
  }
  for (const value of [null, [], false, 1, 'answer', {}]) assert.equal(isModelStep(value), false);
});
