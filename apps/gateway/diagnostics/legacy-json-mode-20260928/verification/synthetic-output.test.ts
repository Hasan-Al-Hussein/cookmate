import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeSyntheticModelOutput } from '../src/synthetic-output';
import type { SyntheticModelOutputSummary } from '../src/synthetic-output';

const apiKey = 'FICTIONAL_DIAGNOSTIC_KEY_ONLY.[*]+?$';
const sourceId = '00000000-0000-4000-8000-000000000004';
const valid = () => ({
  kind: 'respond',
  sufficiency: 'sufficient',
  missingFacts: [],
  memoryUpdate: {
    baseRevision: 0,
    baseContextRevision: 0,
    reviews: [{ sourceMessageId: sourceId, disposition: 'non_memory' }],
    entries: [],
  },
  response: { kind: 'answer', text: 'A fictional cooking answer.', sources: [], recipeIds: [] },
});
function serialized(value: unknown, key = apiKey) {
  const summary = summarizeSyntheticModelOutput(value, key);
  const text = JSON.stringify(summary);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.equal(text.includes(key), false);
  return { summary, text };
}
function metadata(summary: SyntheticModelOutputSummary): string {
  const { generatedJson: _generatedJson, ...rest } = summary;
  return JSON.stringify(rest);
}

test('valid model shapes retain fictional source IDs and report both static validators', () => {
  const value = valid();
  const { summary } = serialized(value);
  assert.equal(summary.validationPerformed, true);
  assert.equal(summary.projectedShapeValid, true);
  assert.equal(summary.fullShapeValid, true);
  assert.equal(summary.kind, 'respond');
  assert.equal(summary.responseKind, 'answer');
  assert.deepEqual(summary.rootFields, [
    'kind',
    'sufficiency',
    'missingFacts',
    'memoryUpdate',
    'response',
  ]);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.errorsTruncated, false);
  assert.equal(summary.generatedJsonStatus, 'included');
  assert.deepEqual(summary.generatedJson, value);
  assert.equal(summary.generatedJsonBytes, Buffer.byteLength(JSON.stringify(value)));
  assert.equal(summary.redactionCount, 0);
  const retrieve = summarizeSyntheticModelOutput(
    { kind: 'retrieve', criteria: { query: 'fictional soup' }, recipeIds: [], requiredFacts: [] },
    apiKey,
  );
  assert.equal(retrieve.projectedShapeValid, true);
  assert.equal(retrieve.fullShapeValid, true);
  assert.equal(retrieve.kind, 'retrieve');
  assert.equal(retrieve.responseKind, 'unknown');
});

test('missing kind and schema failures produce useful fixed fields without Ajv prose or params', () => {
  const { kind: _kind, ...missingKind } = valid();
  const { summary } = serialized(missingKind);
  assert.equal(summary.projectedShapeValid, false);
  assert.equal(summary.fullShapeValid, false);
  assert.equal(summary.kind, 'unknown');
  assert.equal(summary.responseKind, 'answer');
  assert.equal(summary.rootFields.includes('kind'), false);
  assert.ok(summary.errors.some((error) => error.keyword === 'required'));
  assert.ok(summary.errors.some((error) => error.schemaPath === '#/anyOf/*/required'));
  for (const error of summary.errors)
    assert.deepEqual(Object.keys(error).sort(), [
      'instancePath',
      'keyword',
      'schema',
      'schemaPath',
    ]);
});

test('shape validity is computed before redaction, including projected versus full length constraints', () => {
  const longKey = 'FICTIONAL_ONLY_' + 'x'.repeat(8001);
  const value = valid();
  value.response.text = longKey;
  const { summary } = serialized(value, longKey);
  assert.equal(summary.projectedShapeValid, true);
  assert.equal(summary.fullShapeValid, false);
  assert.ok(
    summary.errors.some(
      (error) => error.keyword === 'maxLength' && error.instancePath === '/response/text',
    ),
  );
  assert.equal(summary.generatedJsonStatus, 'included');
  assert.equal(JSON.stringify(summary.generatedJson).includes('[REDACTED]'), true);
  assert.equal(value.response.text, longKey);
});

test('literal API key replacement covers nested strings, property names and parsed JSON escapes', () => {
  const value = JSON.parse(
    JSON.stringify({
      kind: 'unknown_kind_PRIVATE',
      [`prefix-${apiKey}-suffix`]: `before ${apiKey} after ${apiKey}`,
      nested: [{ text: apiKey, [apiKey]: 'fictional safe value' }],
      parsedEscape: apiKey,
    }).replaceAll('FICTIONAL', '\\u0046ICTIONAL'),
  );
  const { summary, text } = serialized(value);
  assert.equal(summary.kind, 'unknown');
  assert.equal(summary.responseKind, 'unknown');
  assert.deepEqual(summary.rootFields, ['kind']);
  assert.equal(summary.generatedJsonStatus, 'included');
  assert.ok(summary.redactionCount >= 6);
  assert.ok(text.includes('prefix-[REDACTED]-suffix'));
  assert.ok(text.includes('before [REDACTED] after [REDACTED]'));
  assert.equal(metadata(summary).includes('unknown_kind_PRIVATE'), false);
  assert.equal(metadata(summary).includes('parsedEscape'), false);
});

test('generic credentials are removed from values and property names without losing source IDs', () => {
  const google = 'AIza' + 'aB9_-'.repeat(7);
  const sk = 'sk-proj-fictional_1234567890-ONLY';
  const bearer = 'eyJfictional.abc123_signature~+/==';
  const value = {
    google,
    note: `${google} ${sk} Bearer ${bearer}`,
    [google]: 'fictional',
    [sk]: 'fictional',
    [`Bearer ${bearer}`]: 'fictional',
    sourceMessageId: sourceId,
  };
  const { summary, text } = serialized(value);
  assert.equal(summary.generatedJsonStatus, 'included');
  for (const credential of [google, sk, bearer]) assert.equal(text.includes(credential), false);
  assert.equal(text.includes(sourceId), true);
  assert.ok(summary.redactionCount >= 7);
});

test('sensitive key names replace the entire associated value, including nested objects and numbers', () => {
  const names = [
    'authorization',
    'Proxy-Authorization',
    'api_key',
    'apiKey',
    'X-Goog-Api-Key',
    'token',
    'access_token',
    'refresh_token',
    'password',
    'databasePassword',
    'secret',
    'credential',
    'credentials',
    'private_key',
    'clientSecret',
    'sessionCookie',
  ];
  const value = Object.fromEntries(
    names.map((name, index) => [name, { privateValue: `PRIVATE_VALUE_${index}` }]),
  );
  const { summary, text } = serialized({ nested: value, password: 123456789 });
  assert.equal(summary.generatedJsonStatus, 'included');
  assert.equal(text.includes('PRIVATE_VALUE'), false);
  assert.equal(text.includes('123456789'), false);
  assert.equal(text.includes('privateValue'), false);
  assert.equal(summary.redactionCount, names.length + 1);
  assert.deepEqual(summary.generatedJson, {
    nested: Object.fromEntries(names.map((name) => [name, '[REDACTED]'])),
    password: '[REDACTED]',
  });
});

test('unknown fields appear only in redacted generated JSON and error paths contain static schema names', () => {
  const value = {
    ...valid(),
    ['HOSTILE_DYNAMIC_PRIVATE/' + apiKey]: apiKey,
    response: {
      kind: 'proposal',
      text: 'fictional',
      sources: [],
      recipeIds: ['NOT_NUMERIC_PRIVATE'],
      proposals: [{ kind: 'savePreference', type: 'unknown_PRIVATE', explicitValue: false }],
    },
  };
  const { summary, text } = serialized(value);
  assert.equal(summary.fullShapeValid, false);
  assert.equal(summary.generatedJsonStatus, 'included');
  assert.ok(text.includes('HOSTILE_DYNAMIC_PRIVATE'));
  for (const unknown of ['HOSTILE_DYNAMIC_PRIVATE', 'NOT_NUMERIC_PRIVATE', 'unknown_PRIVATE'])
    assert.equal(metadata(summary).includes(unknown), false);
  assert.ok(summary.errors.length <= 16);
  assert.ok(summary.errorCount > summary.errors.length);
  assert.equal(summary.errorsTruncated, true);
  assert.ok(summary.errors.some((error) => error.schema === 'projected'));
  assert.ok(summary.errors.some((error) => error.schema === 'full'));
});

test('hostile own __proto__ and constructor properties remain inert data', () => {
  const value = JSON.parse(
    `{"__proto__":{"polluted":true,"password":"PRIVATE_PASSWORD"},"constructor":{"prototype":{"polluted":true}},"text":"${sourceId}"}`,
  );
  const { summary, text } = serialized(value);
  assert.equal(summary.generatedJsonStatus, 'included');
  assert.ok(summary.generatedJson && typeof summary.generatedJson === 'object');
  assert.equal(Object.hasOwn(summary.generatedJson!, '__proto__'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(Object.hasOwn({}, 'polluted'), false);
  assert.equal(text.includes('PRIVATE_PASSWORD'), false);
  assert.equal(text.includes(sourceId), true);
});

test('cycles, non-JSON values and hostile accessors fail closed without calls or raw exceptions', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let called = 0;
  const getter = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      called++;
      throw new Error(apiKey);
    },
  });
  const serializer = {
    toJSON() {
      called++;
      throw new Error(apiKey);
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error(apiKey);
      },
    },
  );
  for (const input of [
    cycle,
    getter,
    serializer,
    proxy,
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol('PRIVATE_SYMBOL'),
    new Date(),
    new Map(),
    [undefined],
    Array(2),
  ]) {
    const { summary } = serialized(input);
    assert.equal(summary.validationPerformed, false);
    assert.equal(summary.generatedJsonStatus, 'omitted_invalid');
    assert.equal(summary.generatedJson, null);
    assert.equal(summary.projectedShapeValid, false);
    assert.equal(summary.fullShapeValid, false);
    assert.equal(summary.errorCount, 0);
  }
  assert.equal(called, 0);
});

test('depth and node caps reject input before validation or diagnostic capture', () => {
  let deep: unknown = 'PRIVATE_DEEP_VALUE';
  for (let index = 0; index < 26; index++) deep = { child: deep };
  const cases = [
    [deep, 'omitted_depth_limit'],
    [Array.from({ length: 4096 }, () => null), 'omitted_node_limit'],
    [
      Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [String(index), null])),
      'omitted_node_limit',
    ],
  ] as const;
  for (const [input, reason] of cases) {
    const { summary, text } = serialized(input);
    assert.equal(summary.generatedJsonStatus, reason);
    assert.equal(summary.validationPerformed, false);
    assert.equal(summary.generatedJson, null);
    assert.equal(text.includes('PRIVATE_DEEP_VALUE'), false);
  }
});

test('generated JSON uses an exact UTF-8 byte cap and oversized captures have fixed omission reasons', () => {
  const exact = summarizeSyntheticModelOutput('x'.repeat(32 * 1024 - 2), apiKey);
  assert.equal(exact.generatedJsonStatus, 'included');
  assert.equal(exact.generatedJsonBytes, 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(exact.generatedJson)) <= 32 * 1024);
  const over = summarizeSyntheticModelOutput('x'.repeat(32 * 1024 - 1), apiKey);
  assert.equal(over.generatedJsonStatus, 'omitted_too_large');
  assert.equal(over.generatedJson, null);
  assert.equal(over.validationPerformed, true);
  assert.equal(over.generatedJsonBytes, 32 * 1024 + 1);
  const unicode = summarizeSyntheticModelOutput('🍲'.repeat(8192), apiKey);
  assert.equal(unicode.generatedJsonStatus, 'omitted_too_large');
  assert.equal(unicode.generatedJsonBytes, 32 * 1024 + 2);
  const huge = summarizeSyntheticModelOutput('x'.repeat(128 * 1024 + 1), apiKey);
  assert.equal(huge.generatedJsonStatus, 'omitted_too_large');
  assert.equal(huge.validationPerformed, false);
  assert.equal(huge.generatedJson, null);
  assert.equal(huge.generatedJsonBytes, null);
});
