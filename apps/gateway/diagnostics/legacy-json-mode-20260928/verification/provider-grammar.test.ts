import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { compileProviderGrammar, ProviderGrammarError } from '../src/provider-grammar';
import type { ProviderGrammarSchema } from '../src/provider-grammar';
import { PROVIDER_RESPONSE_SCHEMA } from '../src/provider-schema';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const tag = (value: string) => ({ type: 'string', enum: [value] });
const union = (left: unknown, right: unknown) => ({ anyOf: [left, right] });
const choice = (left: unknown, right: unknown) =>
  union(object({ kind: tag('left'), value: left }), object({ kind: tag('right'), value: right }));
const ajv = new Ajv({ strict: false });

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function assertNoUnions(schema: ProviderGrammarSchema): void {
  assert.equal(Object.hasOwn(schema, 'anyOf'), false);
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    Object.values(schema.properties).forEach(assertNoUnions);
  } else if (schema.type === 'array') assertNoUnions(schema.items);
}
function witness(value: unknown): unknown {
  const node = record(value);
  if (Array.isArray(node.anyOf)) return witness(node.anyOf[0]);
  if (Array.isArray(node.enum)) return node.enum[0];
  if (node.type === 'object')
    return Object.fromEntries(
      Object.entries(record(node.properties)).map(([name, child]) => [name, witness(child)]),
    );
  if (node.type === 'array')
    return Array.from({ length: typeof node.minItems === 'number' ? node.minItems : 0 }, () =>
      witness(node.items),
    );
  if (node.type === 'string') return 'fictional';
  if (node.type === 'integer' || node.type === 'number') return node.minimum ?? 0;
  if (node.type === 'boolean') return false;
  if (node.type === 'null') return null;
  throw new Error('Unsupported test witness schema');
}
function discoverUnions(
  value: unknown,
  path: string[] = [],
): { schema: Record<string, unknown>; path: string[] }[] {
  const node = record(value);
  const found: { schema: Record<string, unknown>; path: string[] }[] = [];
  if (Array.isArray(node.anyOf)) {
    found.push({ schema: node, path });
    node.anyOf.forEach((branch) => found.push(...discoverUnions(branch, path)));
  }
  if (node.properties)
    for (const [name, child] of Object.entries(record(node.properties)))
      found.push(...discoverUnions(child, [...path, 'properties', name]));
  if (node.items) found.push(...discoverUnions(node.items, [...path, 'items']));
  return found;
}
function at(value: unknown, path: string[]): unknown {
  return path.reduce((node, key) => record(node)[key], value);
}

test('compilation is pure, deterministic, detached and removes every actual schema union', () => {
  const input = JSON.parse(JSON.stringify(PROVIDER_RESPONSE_SCHEMA));
  const before = JSON.stringify(input);
  freeze(input);
  const first = compileProviderGrammar(input);
  const second = compileProviderGrammar(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assertNoUnions(first);
  assert.ok(first.type === 'object');
  assert.deepEqual(first.required, ['kind']);
  assert.deepEqual(first.properties.kind, { type: 'string', enum: ['retrieve', 'respond'] });
  first.required.push('mutated_output_only');
  assert.deepEqual(compileProviderGrammar(input), second);
  assert.equal(JSON.stringify(input), before);
});

test('the complete compiled grammar admits all 27 branches at all nine current union locations', () => {
  const compiled = compileProviderGrammar(PROVIDER_RESPONSE_SCHEMA);
  const locations = discoverUnions(PROVIDER_RESPONSE_SCHEMA);
  assert.equal(locations.length, 9);
  let branchCount = 0;
  for (const { schema, path } of locations) {
    assert.ok(Array.isArray(schema.anyOf));
    const target = record(at(compiled, path));
    const grammar = ajv.compile(target);
    for (const branch of schema.anyOf) {
      const example = witness(branch);
      assert.equal(
        ajv.compile(record(branch))(example),
        true,
        `invalid branch witness at ${path.join('/')}`,
      );
      assert.equal(
        grammar(example),
        true,
        `branch rejected at ${path.join('/')}: ${JSON.stringify(grammar.errors)}`,
      );
      branchCount++;
    }
  }
  assert.equal(branchCount, 27);
});

test('descriptions state each branch discriminator and exact allowed and required keys', () => {
  const compiled = compileProviderGrammar(
    union(
      object({ kind: tag('brief'), text: string, optionalNote: string }, ['kind', 'text']),
      object({ kind: tag('detailed'), text: string, details: string }),
    ),
  );
  assert.ok(compiled.type === 'object');
  assert.deepEqual(compiled.required, ['kind', 'text']);
  assert.deepEqual(Object.keys(compiled.properties), ['details', 'kind', 'optionalNote', 'text']);
  assert.equal(compiled.additionalProperties, false);
  assert.equal(
    compiled.description,
    'Conditional fields by "kind": "brief": allowed ["kind","optionalNote","text"], required ["kind","text"]; "detailed": allowed ["details","kind","text"], required ["details","kind","text"]. Use only the fields allowed for the selected value.',
  );
  const validate = ajv.compile(compiled);
  assert.equal(validate({ kind: 'brief', text: 'fictional', unexpected: true }), false);
  // Grammar descriptions guide the conditional rule; the lead retains strict local validation.
  assert.equal(validate({ kind: 'brief', text: 'fictional', details: 'wrong branch' }), true);
});

test('section and inferred discriminators work while kind takes precedence when both qualify', () => {
  for (const name of ['section', 'mode']) {
    const compiled = compileProviderGrammar(
      union(
        object({ [name]: tag('one'), first: string }),
        object({ [name]: tag('two'), second: string }),
      ),
    );
    assert.ok(compiled.description?.startsWith(`Conditional fields by "${name}":`));
  }
  const preferred = compileProviderGrammar(
    union(
      object({ section: tag('one'), kind: tag('a') }),
      object({ section: tag('two'), kind: tag('b') }),
    ),
  );
  assert.ok(preferred.description?.startsWith('Conditional fields by "kind":'));
});

test('compatible string enums retain all constraints and recursively merge objects inside equal-bound arrays', () => {
  const constrained = (values: string[]) => ({
    type: 'string',
    enum: values,
    minLength: 2,
    maxLength: 8,
    pattern: '^[a-z]+$',
  });
  const array = (items: unknown) => ({
    type: 'array',
    items,
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  });
  const compiled = compileProviderGrammar(
    choice(
      array(
        object({
          shared: constrained(['warm', 'mild']),
          leftOnly: { type: 'integer', minimum: 0, maximum: 5 },
        }),
      ),
      array(
        object({
          shared: constrained(['mild', 'cold']),
          rightOnly: { type: 'integer', minimum: 0, maximum: 5 },
        }),
      ),
    ),
  );
  assert.ok(compiled.type === 'object');
  const values = compiled.properties.value;
  assert.ok(values?.type === 'array');
  assert.equal(values.minItems, 1);
  assert.equal(values.maxItems, 3);
  assert.equal(values.uniqueItems, true);
  assert.ok(values.items.type === 'object');
  assert.deepEqual(values.items.required, ['shared']);
  assert.equal(values.items.additionalProperties, false);
  assert.deepEqual(values.items.properties.shared, constrained(['warm', 'mild', 'cold']));
  assert.deepEqual(values.items.properties.leftOnly, { type: 'integer', minimum: 0, maximum: 5 });
  const validate = ajv.compile(compiled);
  assert.equal(validate({ kind: 'left', value: [{ shared: 'warm', leftOnly: 5 }] }), true);
  assert.equal(validate({ kind: 'right', value: [{ shared: 'cold', rightOnly: 5 }] }), true);
  assert.equal(validate({ kind: 'left', value: [] }), false);
  assert.equal(validate({ kind: 'left', value: [{ shared: 'warm', leftOnly: 6 }] }), false);
  assert.equal(validate({ kind: 'left', value: [{ shared: 'Warm', leftOnly: 0 }] }), false);
});

test('identical scalar schemas, bounds and annotations survive regardless of object keyword order', () => {
  const compiled = compileProviderGrammar(
    choice(
      object({
        count: { type: 'integer', minimum: 1, maximum: 9, description: 'bounded' },
        active: { type: 'boolean', enum: [true] },
        absent: { type: 'null' },
      }),
      object({
        absent: { type: 'null' },
        active: { enum: [true], type: 'boolean' },
        count: { maximum: 9, description: 'bounded', minimum: 1, type: 'integer' },
      }),
    ),
  );
  assert.ok(compiled.type === 'object');
  const value = compiled.properties.value;
  assert.ok(value?.type === 'object');
  assert.deepEqual(value.properties.count, {
    type: 'integer',
    minimum: 1,
    maximum: 9,
    description: 'bounded',
  });
  assert.deepEqual(value.properties.active, { type: 'boolean', enum: [true] });
  assert.deepEqual(value.properties.absent, { type: 'null' });
});

test('incompatible overlapping types, scalar bounds, enum constraints and array bounds fail loudly', () => {
  const incompatible: [unknown, unknown][] = [
    [string, { type: 'integer' }],
    [string, object({ x: string })],
    [
      { type: 'number', minimum: 0 },
      { type: 'number', minimum: 1 },
    ],
    [{ type: 'integer', maximum: 3 }, { type: 'integer' }],
    [
      { type: 'integer', enum: [1] },
      { type: 'integer', enum: [2] },
    ],
    [
      { type: 'boolean', enum: [true] },
      { type: 'boolean', enum: [false] },
    ],
    [tag('a'), string],
    [
      { ...tag('a'), maxLength: 4 },
      { ...tag('b'), maxLength: 5 },
    ],
    [
      { ...tag('a'), pattern: '^a$' },
      { ...tag('b'), pattern: '^b$' },
    ],
    [
      { type: 'array', items: string, maxItems: 2 },
      { type: 'array', items: string, maxItems: 3 },
    ],
    [
      { type: 'array', items: string, minItems: 1 },
      { type: 'array', items: string },
    ],
    [
      { type: 'array', items: string, uniqueItems: true },
      { type: 'array', items: string, uniqueItems: false },
    ],
    [
      { type: 'array', items: string },
      { type: 'array', items: { type: 'integer' } },
    ],
    [
      { ...object({ x: string }), description: 'one' },
      { ...object({ x: string }), description: 'two' },
    ],
  ];
  for (const [left, right] of incompatible)
    assert.throws(() => compileProviderGrammar(choice(left, right)), ProviderGrammarError);
});

test('non-discriminated, open, non-object and unsupported union siblings are rejected', () => {
  const good = union(object({ kind: tag('one') }), object({ kind: tag('two') }));
  assertNoUnions(compileProviderGrammar({ type: 'object', ...good }));
  for (const input of [
    union(string, tag('one')),
    union(object({ kind: tag('same') }), object({ kind: tag('same') })),
    union(object({ kind: tag('one') }, []), object({ kind: tag('two') })),
    union(
      object({ kind: { type: 'string', enum: ['one', 'extra'] } }),
      object({ kind: tag('two') }),
    ),
    union(object({ one: string }), object({ two: string })),
    union(
      { ...object({ kind: tag('one') }), additionalProperties: true },
      object({ kind: tag('two') }),
    ),
    { ...good, type: 'string' },
    { ...good, description: 'unsupported sibling' },
    { ...good, properties: {} },
    { ...good, required: [] },
    { anyOf: [] },
    { anyOf: [object({ kind: tag('one') })] },
  ])
    assert.throws(() => compileProviderGrammar(input), ProviderGrammarError);
});

test('strict node allowlists reject unsupported schema forms rather than dropping constraints', () => {
  for (const input of [
    true,
    null,
    [],
    {},
    { type: ['string', 'null'] },
    { ...string, default: 'no defaults' },
    { ...string, format: 'uuid' },
    { ...string, $ref: '#/definitions/Text' },
    { oneOf: [string, tag('one')] },
    { ...object({ x: string }), patternProperties: {} },
    { ...object({ x: string }), required: ['missing'] },
    { ...object({ x: string }), required: ['x', 'x'] },
    { type: 'array', items: [string] },
    { type: 'array', items: string, minItems: -1 },
    { type: 'array', items: string, maxItems: 1.5 },
    { type: 'array', items: string, minItems: 2, maxItems: 1 },
    { type: 'integer', maximum: Infinity },
    { type: 'integer', enum: [1.5] },
    { type: 'string', enum: ['same', 'same'] },
    { type: 'string', enum: [] },
    { type: 'string', enum: [1] },
  ])
    assert.throws(() => compileProviderGrammar(input), ProviderGrammarError);
  const cycle: Record<string, unknown> = object({});
  cycle.properties = { self: cycle };
  assert.throws(() => compileProviderGrammar(cycle), ProviderGrammarError);
});

test('property names that resemble schema keywords remain data, including inert __proto__', () => {
  const names = [
    'anyOf',
    'type',
    'properties',
    'required',
    'default',
    'items',
    '__proto__',
    'constructor',
  ];
  const properties = Object.fromEntries(names.map((name) => [name, string]));
  const compiled = compileProviderGrammar(object(properties));
  assert.ok(compiled.type === 'object');
  assert.deepEqual(Object.keys(compiled.properties), [...names].sort());
  assert.equal(Object.hasOwn(compiled.properties, '__proto__'), true);
  assert.deepEqual(compiled.properties.__proto__, { type: 'string' });
  assert.equal(Object.hasOwn(Object.prototype, 'type'), false);
  assertNoUnions(compiled);
  // Ajv intentionally excludes __proto__ from its generated property validator.
  // Assert that inert key's compiler preservation above; validate ordinary keyword names here.
  const ordinaryNames = names.filter((name) => name !== '__proto__');
  const ordinary = compileProviderGrammar(
    object(Object.fromEntries(ordinaryNames.map((name) => [name, string]))),
  );
  const value = Object.fromEntries(ordinaryNames.map((name) => [name, 'fictional']));
  assert.equal(ajv.compile(ordinary)(value), true);
});
