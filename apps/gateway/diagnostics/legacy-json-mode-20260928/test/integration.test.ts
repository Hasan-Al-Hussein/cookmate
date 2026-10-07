import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createGateway } from '../src/server';
import { createGeminiProvider } from '../src/gemini';
import { createOrchestrator } from '../src/orchestrator';
import { memoryRegistry, request } from './helpers';

test('paired HTTP boundary composes official SDK and source orchestration using only injected fictional transport', async (t) => {
  const model = 'gemini-3.5-flash-lite';
  const { registry } = await memoryRegistry();
  let networkRequests = 0;
  const provider = createGeminiProvider({
    apiKey: 'FICTIONAL_INTEGRATION_ONLY',
    model,
    fetch: async (input) => {
      networkRequests++;
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 400 });
      return Response.json({
        id: 'fictional-integration',
        model,
        status: 'completed',
        usage: { total_input_tokens: 400, total_output_tokens: 40 },
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  step: {
                    kind: 'respond',
                    sufficiency: 'sufficient',
                    missingFacts: [],
                    memoryUpdate: {
                      baseRevision: 0,
                      baseContextRevision: 0,
                      reviews: [
                        { sourceMessageId: request().message.messageId, disposition: 'retain' },
                      ],
                      entries: [
                        {
                          sourceMessageId: request().message.messageId,
                          kind: 'context',
                          scope: { kind: 'conversation' },
                          relations: [],
                        },
                      ],
                    },
                    response: {
                      kind: 'proposal',
                      text: 'Please review.',
                      recipeIds: ['53262'],
                      sources: [{ recipeId: '53262', section: 'recipe' }],
                      proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
                    },
                  },
                }),
              },
            ],
          },
        ],
      });
    },
  });
  const gateway = createGateway({
    registry,
    catalogue: catalogue.boundary,
    turn: createOrchestrator(provider),
  });
  t.after(() => gateway.app.close());
  const pairing = gateway.pairing.openWindow();
  const paired = await gateway.app.inject({
    method: 'POST',
    url: '/v2/pair',
    payload: { apiVersion: '2', code: pairing.code },
  });
  const result = await gateway.app.inject({
    method: 'POST',
    url: '/v2/assistant/turn',
    headers: { authorization: `Bearer ${paired.json().token}` },
    payload: request(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().kind, 'proposal');
  assert.equal(result.json().proposals[0].recipeId, '53262');
  assert.equal(result.json().requestId, request().requestId);
  assert.equal(result.json().memoryUpdate.entries[0].quote, request().message.text);
  assert.ok(result.json().text.startsWith('Review these proposed changes'));
  assert.equal(networkRequests, 2);
  assert.equal(gateway.admission.size, 0);
});
