import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProviderError } from '../src/provider-diagnostics';

const empty = classifyProviderError('');
const wire = (message: unknown, status: unknown = 'INVALID_ARGUMENT') =>
  JSON.stringify({ error: { message, status } });

test('only allowlisted RPC status spellings enter the serialized summary', () => {
  const statuses = [
    'OK',
    'CANCELLED',
    'UNKNOWN',
    'INVALID_ARGUMENT',
    'DEADLINE_EXCEEDED',
    'NOT_FOUND',
    'ALREADY_EXISTS',
    'PERMISSION_DENIED',
    'UNAUTHENTICATED',
    'RESOURCE_EXHAUSTED',
    'FAILED_PRECONDITION',
    'ABORTED',
    'OUT_OF_RANGE',
    'UNIMPLEMENTED',
    'INTERNAL',
    'UNAVAILABLE',
    'DATA_LOSS',
  ];
  for (const status of statuses) {
    assert.equal(classifyProviderError(wire('', status)).rpcStatus, status);
    assert.equal(classifyProviderError(wire('', status.toLowerCase())).rpcStatus, status);
  }
  for (const status of [
    'unknown_status_PRIVATE',
    'INVALID_ARGUMENT secret',
    ' INVALID_ARGUMENT',
    400,
    null,
    { status: 'INVALID_ARGUMENT' },
  ]) {
    const summary = classifyProviderError(wire('', status));
    assert.equal(summary.rpcStatus, 'unknown');
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(summary).includes('secret'), false);
  }
});

test('known keyword presence is case-insensitive, token-bounded and never itself a cause classification', () => {
  const message =
    'response_format schema anyOf additionalProperties minLength maxLength pattern uniqueItems max_output_tokens api_version';
  for (const variant of [message, message.toUpperCase()]) {
    const summary = classifyProviderError(wire(variant));
    assert.ok(Object.values(summary.keywords).every(Boolean));
    assert.ok(Object.values(summary.phrases).every((value) => !value));
    assert.equal(summary.category, 'unknown');
    assert.equal(summary.tentative, true);
  }
  const embedded = message
    .split(' ')
    .map((word) => `prefix${word}suffix`)
    .join(' ');
  assert.ok(Object.values(classifyProviderError(wire(embedded)).keywords).every((value) => !value));
});

test('exact known phrases produce only tentative fixed categories; competing or unfamiliar wording stays unknown', () => {
  for (const [message, category, flag] of [
    ['The schema is too complex.', 'schema_complexity', 'complexity'],
    ['The input schema contains too many states for serving.', 'schema_complexity', 'complexity'],
    ['Schema exceeds the maximum allowed complexity.', 'schema_complexity', 'complexity'],
    [
      'Unknown name "minLength" at "response_format.schema".',
      'unsupported_field',
      'unsupportedField',
    ],
    ['Unsupported field.', 'unsupported_field', 'unsupportedField'],
    ['Invalid JSON schema.', 'invalid_schema', 'invalidSchema'],
    ['Schema validation failed.', 'invalid_schema', 'invalidSchema'],
  ] as const) {
    const summary = classifyProviderError(wire(message.toUpperCase()));
    assert.equal(summary.category, category);
    assert.equal(summary.phrases[flag], true);
    assert.equal(summary.tentative, true);
  }
  for (const message of [
    'The request cannot be processed.',
    'This schema has an unfamiliar difficulty.',
    'Invalid JSON payload received.',
    'The schema is not too complex.',
    'Schema is too complex. Unsupported field.',
  ])
    assert.equal(classifyProviderError(wire(message)).category, 'unknown');
});

test('malformed JSON, plaintext and HTML remain entirely unknown without parsing their prose', () => {
  for (const body of [
    '',
    '{"error":{"message":"Invalid schema"}',
    'Unsupported field schema response_format SECRET_BODY',
    '<html><body>Invalid schema Authorization: Bearer PRIVATE_HTML</body></html>',
  ])
    assert.deepEqual(classifyProviderError(body), empty);
  assert.equal(empty.jsonBody, false);
  assert.equal(empty.errorObject, false);
  assert.equal(empty.rpcStatus, 'unknown');
  assert.equal(empty.category, 'unknown');
});

test('valid JSON without a standard error object does not recursively scan content', () => {
  for (const value of [
    null,
    [],
    'Invalid schema',
    5,
    { message: 'Invalid schema', status: 'INVALID_ARGUMENT' },
    { outer: { error: { message: 'Invalid schema', status: 'INVALID_ARGUMENT' } } },
  ])
    assert.deepEqual(classifyProviderError(JSON.stringify(value)), { ...empty, jsonBody: true });
  for (const [error, type] of [
    ['Invalid schema', 'string'],
    [[{ message: 'Invalid schema' }], 'nonstring'],
  ] as const)
    assert.deepEqual(classifyProviderError(JSON.stringify({ error })), {
      ...empty,
      jsonBody: true,
      fieldTypes: { ...empty.fieldTypes, error: type },
    });
});

test('ignored headers, details, credential keys and nested message/status values cannot trigger classification', () => {
  const summary = classifyProviderError(
    JSON.stringify({
      headers: { Authorization: 'Bearer PRIVATE_HEADER', message: 'Invalid schema' },
      status: 'INVALID_ARGUMENT',
      message: 'Schema is too complex',
      api_key: 'PRIVATE_API_KEY',
      error: {
        code: 'schema',
        status: { value: 'INVALID_ARGUMENT' },
        message: { value: 'Invalid schema' },
        details: [{ status: 'INVALID_ARGUMENT', message: 'Unknown field response_format anyOf' }],
        headers: { Authorization: 'Bearer PRIVATE_ERROR_HEADER' },
        api_key: 'PRIVATE_ERROR_API_KEY',
        schema: 'schema is too complex',
      },
    }),
  );
  assert.deepEqual(summary, {
    ...empty,
    jsonBody: true,
    errorObject: true,
    fieldTypes: { error: 'nonstring', code: 'string', message: 'nonstring', status: 'nonstring' },
  });
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});

test('malicious standard-message prose can emit only booleans and fixed allowlisted strings', () => {
  const markers = [
    'FICTIONAL_PROVIDER_CREDENTIAL_921',
    'Bearer PRIVATE_AUTH_715',
    'RAW_DIAGNOSTIC_309',
    'UNRECOGNIZED_STATUS_533',
  ];
  const summary = classifyProviderError(
    wire(
      `Unknown field response_format schema anyOf. api_key=${markers[0]}; Authorization: ${markers[1]}; ${markers[2]}`,
      markers[3],
    ),
  );
  const serialized = JSON.stringify(summary);
  for (const marker of markers) assert.equal(serialized.includes(marker), false);
  assert.equal(summary.rpcStatus, 'unknown');
  assert.equal(summary.keywords.response_format, true);
  assert.equal(summary.phrases.unsupportedField, true);
  assert.equal(summary.category, 'unsupported_field');
  assert.deepEqual(Object.keys(summary).sort(), [
    'category',
    'errorObject',
    'fieldTypes',
    'interactionCode',
    'jsonBody',
    'keywords',
    'messageNonempty',
    'phrases',
    'rpcStatus',
    'tentative',
  ]);
  assert.ok(Object.values(summary.keywords).every((value) => typeof value === 'boolean'));
  assert.ok(Object.values(summary.phrases).every((value) => typeof value === 'boolean'));
});

test('parsed prototype-like fields are inert and separate calls do not retain observations', () => {
  const dangerous =
    '{"__proto__":{"error":{"message":"Invalid schema"}},"error":{"__proto__":{"status":"INVALID_ARGUMENT","message":"Unsupported field"}}}';
  assert.deepEqual(classifyProviderError(dangerous), {
    ...empty,
    jsonBody: true,
    errorObject: true,
    fieldTypes: { ...empty.fieldTypes, error: 'nonstring' },
  });
  classifyProviderError(wire('Unknown field response_format'));
  assert.deepEqual(classifyProviderError('{}'), { ...empty, jsonBody: true });
});

test('Interactions error.code accepts only the documented lowercase request-level allowlist', () => {
  const codes = [
    'invalid_request',
    'failed_precondition',
    'out_of_range',
    'parameter_unknown',
    'authentication',
    'payment_required',
    'permission_denied',
    'not_found',
    'model_not_found',
    'already_exists',
    'aborted',
    'rate_limit_exceeded',
    'quota_exceeded',
    'too_many_requests',
    'cancelled',
    'api_error',
    'unimplemented',
    'service_unavailable',
    'deadline_exceeded',
  ];
  for (const code of codes) {
    const summary = classifyProviderError(
      JSON.stringify({ error: { code, message: 'Invalid request.' } }),
    );
    assert.equal(summary.interactionCode, code);
    assert.equal(summary.rpcStatus, 'unknown');
    assert.deepEqual(summary.fieldTypes, {
      error: 'nonstring',
      code: 'string',
      message: 'string',
      status: 'absent',
    });
    assert.equal(summary.messageNonempty, true);
    assert.equal(summary.phrases.genericInvalidRequest, true);
    assert.equal(summary.category, 'unknown');
    for (const unknown of [code.toUpperCase(), ` ${code}`, `${code} `, `${code}_PRIVATE`]) {
      const result = classifyProviderError(JSON.stringify({ error: { code: unknown } }));
      assert.equal(result.interactionCode, 'unknown');
      assert.equal(JSON.stringify(result).includes(unknown), false);
    }
  }
});

test('fixed field types distinguish absent, null, nonstring and string without exposing values', () => {
  assert.deepEqual(empty.fieldTypes, {
    error: 'absent',
    code: 'absent',
    message: 'absent',
    status: 'absent',
  });
  assert.equal(empty.messageNonempty, false);
  for (const [value, type] of [
    [null, 'null'],
    [[], 'nonstring'],
    [5, 'nonstring'],
    [false, 'nonstring'],
    ['', 'string'],
    ['PRIVATE_ERROR', 'string'],
  ] as const) {
    const summary = classifyProviderError(JSON.stringify({ error: value }));
    assert.equal(summary.fieldTypes.error, type);
    assert.equal(summary.errorObject, false);
    assert.equal(summary.messageNonempty, false);
    assert.deepEqual({ ...summary.fieldTypes, error: 'absent' }, empty.fieldTypes);
  }
  for (const [value, type, nonempty] of [
    [null, 'null', false],
    [[], 'nonstring', false],
    [{ value: 'invalid_request' }, 'nonstring', false],
    [400, 'nonstring', false],
    [false, 'nonstring', false],
    ['', 'string', false],
    [' ', 'string', true],
    ['PRIVATE_VALUE', 'string', true],
  ] as const) {
    const summary = classifyProviderError(
      JSON.stringify({ error: { code: value, message: value, status: value } }),
    );
    assert.deepEqual(summary.fieldTypes, {
      error: 'nonstring',
      code: type,
      message: type,
      status: type,
    });
    assert.equal(summary.errorObject, true);
    assert.equal(summary.messageNonempty, nonempty);
    assert.equal(summary.interactionCode, 'unknown');
    assert.equal(summary.rpcStatus, 'unknown');
    assert.equal(JSON.stringify(summary).includes('PRIVATE_VALUE'), false);
  }
});

test('generic-invalid-request phrase flags recognize whole fixed messages only and never identify a cause', () => {
  for (const [message, flag] of [
    ['Invalid request', 'genericInvalidRequest'],
    ['Invalid argument.', 'genericInvalidArgument'],
    ['Request contains an invalid argument.', 'genericInvalidArgument'],
    ['Invalid JSON payload received.', 'genericInvalidJsonPayload'],
  ] as const) {
    const summary = classifyProviderError(wire(` ${message.toUpperCase()} `));
    assert.equal(summary.phrases[flag], true);
    assert.equal(summary.category, 'unknown');
    assert.equal(summary.tentative, true);
    for (const changed of [
      `Echoed: ${message}`,
      `${message} PRIVATE_PAYLOAD`,
      'Invalid requests',
      'This argument may be invalid',
    ])
      assert.equal(classifyProviderError(wire(changed)).phrases[flag], false);
  }
});

test('code is not inferred from prose, legacy RPC status, nested details or nonstandard top-level fields', () => {
  for (const value of [
    { code: 'invalid_request', error: {} },
    { error: { status: 'INVALID_ARGUMENT', message: 'invalid_request' } },
    { error: { code: 400, message: 'authentication' } },
    { error: { code: { value: 'authentication' }, details: [{ code: 'invalid_request' }] } },
    { headers: { code: 'invalid_request' }, error: { metadata: { code: 'invalid_request' } } },
  ])
    assert.equal(classifyProviderError(JSON.stringify(value)).interactionCode, 'unknown');
  const both = classifyProviderError(
    JSON.stringify({
      error: { code: 'authentication', status: 'INVALID_ARGUMENT', message: 'Invalid request.' },
    }),
  );
  assert.equal(both.interactionCode, 'authentication');
  assert.equal(both.rpcStatus, 'INVALID_ARGUMENT');
});

test('hostile and dynamic unknown codes cannot inject arbitrary text into serialized summaries', () => {
  for (let index = 0; index < 32; index++) {
    const marker = `PRIVATE_DYNAMIC_${index}_API_KEY_867`;
    const code =
      index % 2 === 0
        ? `invalid_request_${marker}`
        : `authentication\nAuthorization: Bearer ${marker}`;
    const body = JSON.stringify({
      error: {
        code,
        status: marker,
        message: `Invalid request. ${marker}`,
        details: [{ code: 'authentication', message: marker }],
        headers: { Authorization: marker },
      },
      api_key: marker,
    });
    const summary = classifyProviderError(body);
    const serialized = JSON.stringify(summary);
    assert.equal(summary.interactionCode, 'unknown');
    assert.equal(summary.rpcStatus, 'unknown');
    assert.equal(summary.category, 'unknown');
    assert.equal(summary.phrases.genericInvalidRequest, false);
    assert.equal(serialized.includes(marker), false);
    assert.equal(serialized.includes(code), false);
    assert.equal(serialized.includes('Authorization'), false);
    assert.equal(serialized.includes('details'), false);
    assert.equal(serialized.includes('headers'), false);
    assert.deepEqual(summary.fieldTypes, {
      error: 'nonstring',
      code: 'string',
      message: 'string',
      status: 'string',
    });
  }
  for (const body of [
    '<html>invalid_request PRIVATE_BODY</html>',
    '{"error":{"code":"invalid_request","message":"PRIVATE_BODY"',
    'invalid_request: PRIVATE_BODY',
  ])
    assert.deepEqual(classifyProviderError(body), empty);
});
