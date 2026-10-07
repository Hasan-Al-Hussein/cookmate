import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMemorySmoke, SMOKE_TEXT } from '../src/memory-smoke';
import { GEMINI_MODELS } from '../src/gemini';

test('prepared smoke uses actual SDK/schema/normalization for two synthetic models with four fake requests', async () => {
  let calls = 0;
  const report = await runMemorySmoke({
    apiKey: 'FICTIONAL_SMOKE_ONLY',
    models: GEMINI_MODELS,
    fetch: async (input, init) => {
      calls++;
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 1000 });
      const body = JSON.parse(
        String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}')),
      );
      const provided = JSON.parse(body.input).request;
      const value = {
        kind: 'respond',
        sufficiency: 'sufficient',
        missingFacts: [],
        memoryUpdate: {
          baseRevision: 0,
          baseContextRevision: 0,
          reviews: [{ sourceMessageId: provided.message.messageId, disposition: 'retain' }],
          entries: [
            {
              sourceMessageId: provided.message.messageId,
              kind: 'constraint',
              scope: { kind: 'conversation' },
              relations: [],
            },
          ],
        },
        response: {
          kind: 'answer',
          text: 'Understood for this fictional dinner.',
          sources: [],
          recipeIds: [],
        },
      };
      return Response.json({
        id: 'fictional-smoke',
        model: body.model,
        status: 'completed',
        usage: { total_input_tokens: 1000, total_output_tokens: 100 },
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: JSON.stringify({ step: value }) }],
          },
        ],
      });
    },
  });
  assert.equal(calls, 4, JSON.stringify(report));
  assert.equal(report.networkRequests, 4);
  assert.deepEqual(
    report.cases.map((item) => item.disposition),
    ['PASS', 'PASS'],
  );
  assert.ok(report.cases.every((item) => item.exactQuote && item.exactReview));
  assert.ok(report.cases.every((item) => item.providerSchemaValid && item.normalizationValid));
  assert.equal(report.syntheticText, SMOKE_TEXT);
  assert.equal(JSON.stringify(report).includes('FICTIONAL_SMOKE_ONLY'), false);
});

test('diagnostic metadata distinguishes HTTP, completion, usage, JSON, shape and normalization failures without raw content', async () => {
  const privateText = 'PRIVATE_MODEL_OR_PROVIDER_CONTENT';
  for (const scenario of [
    'http',
    'completion',
    'usage',
    'json',
    'shape',
    'normalization',
    'retrieve',
  ] as const) {
    const report = await runMemorySmoke({
      apiKey: 'FICTIONAL_SMOKE_ONLY',
      models: [GEMINI_MODELS[0]],
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 1000 });
        if (scenario === 'http')
          return Response.json({ error: { code: 400, message: privateText } }, { status: 400 });
        const body = JSON.parse(
          String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}')),
        );
        const request = JSON.parse(body.input).request;
        const validShape = {
          kind: 'respond',
          sufficiency: 'sufficient',
          missingFacts: [],
          memoryUpdate: {
            baseRevision: 999,
            baseContextRevision: 0,
            reviews: [{ sourceMessageId: request.message.messageId, disposition: 'non_memory' }],
            entries: [],
          },
          response: { kind: 'answer', text: privateText, recipeIds: [], sources: [] },
        };
        return Response.json({
          id: 'fictional-diagnostic',
          model: body.model,
          status: scenario === 'completion' ? privateText : 'completed',
          ...(scenario === 'usage'
            ? {}
            : { usage: { total_input_tokens: 1000, total_output_tokens: 100 } }),
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text:
                    scenario === 'json'
                      ? privateText
                      : JSON.stringify({
                          step:
                            scenario === 'normalization'
                              ? validShape
                              : scenario === 'retrieve'
                                ? {
                                    kind: 'retrieve',
                                    criteria: {},
                                    recipeIds: [],
                                    requiredFacts: [],
                                  }
                                : {},
                        }),
                },
              ],
            },
          ],
        });
      },
    });
    const result = report.cases[0]!;
    assert.equal(result.disposition, 'FAIL', scenario);
    assert.equal(
      result.code,
      scenario === 'retrieve' ? 'unexpected_structured_result' : 'invalid_model_result',
      scenario,
    );
    assert.equal(report.networkRequests, 2);
    assert.equal(JSON.stringify(report).includes(privateText), false, scenario);
    assert.equal(JSON.stringify(report).includes('FICTIONAL_SMOKE_ONLY'), false, scenario);
    const last = result.diagnostics.at(-1)!;
    if (scenario === 'http') {
      assert.ok(
        result.diagnostics.some(
          (event) =>
            event.stage === 'http_response' &&
            event.operation === 'generation' &&
            event.httpStatus === 400,
        ),
      );
      assert.equal(last.stage, 'http_error_summary');
    }
    if (scenario === 'completion') {
      assert.equal(last.stage, 'completion_result');
      if (last.stage === 'completion_result') assert.equal(last.completionStatus, 'unknown');
    }
    if (scenario === 'usage') assert.deepEqual(last, { stage: 'usage_check', valid: false });
    if (scenario === 'json') assert.deepEqual(last, { stage: 'json_check', valid: false });
    assert.equal(
      result.providerSchemaValid,
      ['normalization', 'retrieve'].includes(scenario) ? true : scenario === 'shape' ? false : null,
    );
    assert.equal(result.normalizationValid, scenario === 'normalization' ? false : null);
  }
});

test('prepared smoke never retries a provider error or falls back to the next model', async () => {
  let calls = 0;
  const report = await runMemorySmoke({
    apiKey: 'FICTIONAL_SMOKE_ONLY',
    models: GEMINI_MODELS,
    fetch: async (input) => {
      calls++;
      if (String(input).endsWith(':countTokens')) return Response.json({ totalTokens: 1000 });
      return Response.json(
        { error: { code: 503, message: 'PRIVATE_PROVIDER_DIAGNOSTIC' } },
        { status: 503 },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.cases[0]!.disposition, 'FAIL');
  assert.equal(report.cases[1]!.disposition, 'NOT_RUN');
  assert.equal(report.networkRequests, 2);
  assert.equal(report.cases[0]!.generations, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_PROVIDER_DIAGNOSTIC'), false);
});

test('HTTP error classification observes the single bounded body without retaining injected secrets', async () => {
  const privateText = 'FICTIONAL_PRIVATE_KEY_HEADER_AND_BODY';
  let pulls = 0;
  let calls = 0;
  const body = new TextEncoder().encode(
    JSON.stringify({
      error: {
        status: 'INVALID_ARGUMENT',
        message: `response_format.schema: unsupported field uniqueItems. ${privateText}`,
      },
      headers: { authorization: privateText },
      apiKey: privateText,
    }),
  );
  const report = await runMemorySmoke({
    apiKey: privateText,
    models: [GEMINI_MODELS[0]],
    fetch: async (input) => {
      calls++;
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 1000 });
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls++;
            if (pulls === 1) controller.enqueue(body);
            else controller.close();
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json', 'x-private': privateText } },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(pulls, 2);
  const summary = report.cases[0]!.diagnostics.find(
    (event) => event.stage === 'http_error_summary',
  );
  assert.ok(summary && summary.stage === 'http_error_summary');
  assert.equal(summary.rpcStatus, 'INVALID_ARGUMENT');
  assert.equal(summary.keywords.response_format, true);
  assert.equal(summary.keywords.schema, true);
  assert.equal(summary.keywords.uniqueItems, true);
  assert.equal(summary.phrases.unsupportedField, true);
  assert.equal(report.cases[0]!.code, 'invalid_model_result');
  assert.equal(JSON.stringify(report).includes(privateText), false);
});
