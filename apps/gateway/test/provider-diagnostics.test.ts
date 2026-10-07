import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import {
  classifyProviderError,
  createProviderErrorMetadata,
  classifyProviderErrorMetadata,
  describeSerializedBody,
  describeProviderInput,
  describeSdkRequestBody,
} from '../src/provider-diagnostics';
import type { ProviderInput } from '../src/provider-contract';

const empty = classifyProviderError('');
const wire = (message: unknown, status: unknown = 'INVALID_ARGUMENT') =>
  JSON.stringify({ error: { message, status } });

test('serialized body observation counts bytes without consuming or coercing unsupported input', () => {
  const text = 'PRIVATE_🍲_الطعام';
  assert.deepEqual(describeSerializedBody(text), {
    encoding: 'utf8_string',
    bytes: Buffer.byteLength(text, 'utf8'),
  });
  assert.deepEqual(describeSerializedBody(''), { encoding: 'utf8_string', bytes: 0 });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual(describeSerializedBody(bytes.subarray(1, 3)), { encoding: 'bytes', bytes: 2 });
  assert.deepEqual(describeSerializedBody(bytes.buffer), { encoding: 'bytes', bytes: 4 });
  const stream = new ReadableStream(
    {
      pull() {
        assert.fail('Diagnostic must not read the body');
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request('https://example.invalid', { method: 'POST', body: text });
  for (const value of [
    undefined,
    null,
    stream,
    request,
    new Blob([text]),
    {
      toString() {
        assert.fail('Diagnostic must not coerce the body');
      },
      toJSON() {
        assert.fail('Diagnostic must not serialize the body');
      },
    },
  ])
    assert.deepEqual(describeSerializedBody(value), { encoding: 'unavailable', bytes: null });
  assert.equal(stream.locked, false);
  assert.equal(request.bodyUsed, false);
  assert.equal(describeProviderInput({} as ProviderInput, 1), null);
});

test('SDK Request observation counts exact transient bytes and leaves the original body untouched', async () => {
  const text = 'PRIVATE_REQUEST_🍲_الطعام';
  const request = new Request('https://example.invalid', { method: 'POST', body: text });
  const controller = new AbortController();
  const shape = await describeSdkRequestBody(request, undefined, controller.signal);
  assert.deepEqual(shape, { encoding: 'bytes', bytes: Buffer.byteLength(text, 'utf8') });
  assert.equal(request.bodyUsed, false);
  assert.equal(request.body?.locked, false);
  assert.equal(await request.text(), text);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(JSON.stringify(shape).includes('PRIVATE_REQUEST'), false);
  assert.deepEqual(await describeSdkRequestBody(request, 'override'), {
    encoding: 'utf8_string',
    bytes: 8,
  });
});

test('ready empty chunks cannot bypass request observation bounds by starving its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls <= 2048) controller.enqueue(new Uint8Array(0));
      else controller.close();
    },
  });
  const request = new Request('https://example.invalid', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  const result = await describeSdkRequestBody(request, undefined);
  assert.deepEqual(result, { encoding: 'unavailable', bytes: null });
  assert.ok(pulls < 2048);
  assert.equal(request.bodyUsed, false);
  await request.body?.cancel();
});

test('SDK Request observation is bounded on oversized, stalled, aborted or already-used bodies', async () => {
  const unavailable = { encoding: 'unavailable', bytes: null };
  const oversized = new Request('https://example.invalid', {
    method: 'POST',
    body: new Uint8Array(1024 * 1024 + 1),
  });
  assert.deepEqual(await describeSdkRequestBody(oversized, undefined), unavailable);
  assert.equal(oversized.bodyUsed, false);
  await oversized.body?.cancel();
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    const request = new Request('https://example.invalid', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    const observed = describeSdkRequestBody(request, undefined, controller.signal);
    if (abort) controller.abort();
    assert.deepEqual(await observed, unavailable);
    assert.equal(request.bodyUsed, false);
    assert.equal(request.body?.locked, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await request.body?.cancel();
  }
  const used = new Request('https://example.invalid', { method: 'POST', body: 'used' });
  await used.text();
  assert.deepEqual(await describeSdkRequestBody(used, undefined), unavailable);
});

test('only the exact verified paid input-token quota pair is classified, without inferring absent details', () => {
  const metric = 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count';
  const ruleId = 'GenerateContentPaidTierInputTokensPerModelPerMinute';
  const privateValue = 'PRIVATE_QUOTA_428';
  for (const [quotaMetric, quotaId, value, category, limit] of [
    [metric, ruleId, '0', 'input_tokens_per_minute', { state: 'valid', value: 0 }],
    [metric, ruleId, undefined, 'input_tokens_per_minute', { state: 'absent', value: null }],
    [
      metric,
      'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
      100,
      'unknown',
      { state: 'valid', value: 100 },
    ],
    [metric + privateValue, ruleId, 100, 'unknown', { state: 'valid', value: 100 }],
    [metric, ruleId + privateValue, 100, 'unknown', { state: 'valid', value: 100 }],
  ] as const) {
    const metadata = createProviderErrorMetadata('9');
    classifyProviderErrorMetadata(
      Buffer.from(
        JSON.stringify({
          error: {
            message: privateValue,
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [
                  {
                    quotaMetric,
                    quotaId,
                    quotaValue: value,
                    quotaDimensions: { model: 'gemini-3.8-flash', project: privateValue },
                    subject: privateValue,
                    description: privateValue,
                  },
                ],
              },
            ],
          },
        }),
      ),
      metadata,
      ['gemini-3.8-flash'],
    );
    assert.equal(metadata.quotas[0]!.category, category);
    assert.deepEqual(metadata.quotas[0]!.limit, limit);
    if (category !== 'unknown') {
      assert.equal(metadata.quotas[0]!.metric, metric);
      assert.equal(metadata.quotas[0]!.ruleId, ruleId);
    }
    assert.equal(JSON.stringify(metadata).includes(privateValue), false);
  }
  const absent = createProviderErrorMetadata('9');
  classifyProviderErrorMetadata(
    Buffer.from(
      JSON.stringify({ error: { code: 'too_many_requests', message: `${metric} ${ruleId}` } }),
    ),
    absent,
    ['gemini-3.8-flash'],
  );
  assert.equal(absent.detailsState, 'absent');
  assert.deepEqual(absent.quotas, []);
});

test('runtime cooldown metadata only accepts an explicitly supplied bounded integer hint', () => {
  for (const [seconds, expected] of [
    [undefined, null],
    [0, 0],
    [8, 8000],
    [86400, 86_400_000],
    [-1, null],
    [0.5, null],
    [86401, null],
    [Infinity, null],
    [NaN, null],
  ] as const) {
    const metadata = createProviderErrorMetadata('PRIVATE_RAW_HEADER', seconds);
    assert.equal(metadata.runtimeRetryAfterDelayMs, expected);
    assert.deepEqual(metadata.retryAfterDelayMs, { state: 'invalid', value: null });
    assert.equal(JSON.stringify(metadata).includes('PRIVATE_RAW_HEADER'), false);
  }
});

test('shared error metadata never promotes unknown quota names or retains private dimensions', () => {
  const privateValue = 'PRIVATE_PROJECT_KEY_SUBJECT_537';
  const metadata = createProviderErrorMetadata('12');
  classifyProviderErrorMetadata(
    Buffer.from(
      JSON.stringify({
        error: {
          code: 'too_many_requests',
          message: privateValue,
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaMetric: `InputTokensPerMinute_${privateValue}`,
                  quotaId: `RequestsPerDay_${privateValue}`,
                  quotaValue: '32000',
                  quotaDimensions: { model: privateValue, project: privateValue },
                  subject: privateValue,
                  description: privateValue,
                  futureQuotaValue: privateValue,
                },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              domain: 'googleapis.com',
              reason: 'RATE_LIMIT_EXCEEDED',
              metadata: { consumer: privateValue, quota_limit: privateValue },
            },
          ],
        },
      }),
    ),
    metadata,
    ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
  );
  assert.equal(metadata.bodyState, 'parsed');
  assert.equal(metadata.code, 'too_many_requests');
  assert.deepEqual(metadata.quotas, [
    {
      category: 'unknown',
      metric: 'unknown',
      ruleId: 'unknown',
      model: 'unknown',
      limit: { state: 'valid', value: 32000 },
    },
  ]);
  assert.deepEqual(metadata.quotaReasons, ['rate_limit']);
  assert.deepEqual(metadata.retryAfterDelayMs, { state: 'valid', value: 12000 });
  const serialized = JSON.stringify(metadata);
  for (const forbidden of [
    privateValue,
    'subject',
    'description',
    'quotaDimensions',
    'futureQuotaValue',
    'consumer',
  ])
    assert.equal(serialized.includes(forbidden), false);
});

test('numeric metadata preserves absent, zero and unsupported encodings without time-based guesses', () => {
  for (const [value, state, expected] of [
    [null, 'absent', null],
    ['0', 'valid', 0],
    ['86400', 'valid', 86_400_000],
    ['86401', 'out_of_range', null],
    ['1.5', 'invalid', null],
    ['Wed, 21 Oct 2015 07:28:00 GMT', 'invalid', null],
    ['PRIVATE_RETRY_HEADER', 'invalid', null],
  ] as const) {
    const metadata = createProviderErrorMetadata(value);
    assert.deepEqual(metadata.retryAfterDelayMs, { state, value: expected });
    assert.equal(metadata.bodyState, 'no_body');
    assert.deepEqual(metadata.quotas, []);
    assert.equal(JSON.stringify(metadata).includes('PRIVATE_RETRY_HEADER'), false);
  }
  const metadata = createProviderErrorMetadata(null);
  classifyProviderErrorMetadata(
    Buffer.from('{"error":{"code":"too_many_requests"}}'),
    metadata,
    [],
  );
  assert.equal(metadata.detailsState, 'absent');
  assert.deepEqual(metadata.quotas, []);
  assert.deepEqual(metadata.retryInfoDelayMs, []);
  assert.deepEqual(metadata.retryAfterDelayMs, { state: 'absent', value: null });
});

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
