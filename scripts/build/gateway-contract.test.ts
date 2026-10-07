import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { schema, strictAjvOptions } from '../../packages/contracts/schema/contract.schema.mjs';
import { MAX_ASSISTANT_BODY_BYTES, checkAssistantRequest } from '@cookmate/contracts';
import { catalogueBoundary, requestFixture } from '@cookmate/contracts/fixtures';

test('Fastify fixture and generated phone validator reject the same malformed boundary', async () => {
  const app = Fastify({
    bodyLimit: MAX_ASSISTANT_BODY_BYTES,
    logger: false,
    ajv: { customOptions: strictAjvOptions },
  });
  app.addSchema(schema);
  let accepted = 0;
  app.post(
    '/contract-fixture',
    { schema: { body: { $ref: `${schema.$id}#/definitions/AssistantTurnRequest` } } },
    (request, reply) => {
      const check = checkAssistantRequest(request.body, catalogueBoundary);
      if (!check.ok) return reply.code(422).send({ code: check.error.code });
      accepted += 1;
      return { accepted: true };
    },
  );
  try {
    const valid = requestFixture();
    const cases = [
      valid,
      { ...valid, clientId: 'not-authentication' },
      { ...valid, intentRevision: '0' },
      { ...valid, apiVersion: '1' },
      { ...valid, message: { ...valid.message, tool: 'runSql' } },
      {
        ...valid,
        context: {
          ...valid.context,
          memory: {
            ...valid.context.memory,
            coverage: { ...valid.context.memory.coverage, selectionStatus: 'narrowing_required' },
          },
        },
      },
      {
        ...valid,
        context: { ...valid.context, preferences: { revision: 0, items: [] } },
      },
      {
        ...valid,
        message: { ...valid.message, sourceSequence: '0' },
      },
    ];
    for (const payload of cases) {
      const expected = checkAssistantRequest(payload, catalogueBoundary).ok;
      const result = await app.inject({ method: 'POST', url: '/contract-fixture', payload });
      assert.equal(result.statusCode === 200, expected);
    }
    const oversized = await app.inject({
      method: 'POST',
      url: '/contract-fixture',
      payload: {
        ...valid,
        message: { ...valid.message, text: 'x'.repeat(MAX_ASSISTANT_BODY_BYTES) },
      },
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(accepted, 1);
  } finally {
    await app.close();
  }
});
