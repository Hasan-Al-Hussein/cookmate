import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerOptions } from 'node:https';
import { schema, strictAjvOptions } from '@cookmate/contracts/schema';
import {
  API_VERSION,
  MAX_ASSISTANT_BODY_BYTES,
  checkAssistantRequest,
  checkAssistantResponse,
  checkMemoryResponseForRequest,
  isResponseCurrent,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  CatalogueBoundary,
} from '@cookmate/contracts';
import type { CredentialRegistry } from './registry';
import { createPairingService } from './pairing';
import { abortable, createAdmission } from './admission';
import { gatewayError, GatewayError, safeError } from './errors';
import { LIMITS } from './limits';

export type TurnHandler = (
  request: AssistantTurnRequest,
  execution: { signal: AbortSignal; deadline: number },
) => Promise<AssistantTurnResponse>;
export interface GatewayOptions {
  catalogue: CatalogueBoundary;
  registry: CredentialRegistry;
  turn: TurnHandler;
  tls?: ServerOptions;
  now?: () => number;
  deadlineMs?: number;
}

/** No socket is opened. The production launcher must supply TLS before calling listen. */
export function createGateway(options: GatewayOptions) {
  const now = options.now ?? Date.now;
  const app = Fastify({
    ...(options.tls ? { https: options.tls } : {}),
    logger: false,
    bodyLimit: MAX_ASSISTANT_BODY_BYTES,
    requestTimeout: LIMITS.deadlineMs,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    trustProxy: false,
    ajv: { customOptions: strictAjvOptions },
  });
  app.addSchema(schema);
  const pairing = createPairingService(options.registry, options.catalogue.identity, now);
  const admission = createAdmission(options.deadlineMs, now);
  const removeListener = options.registry.onRevoked((clientId) => admission.revoke(clientId));
  const authenticated = new WeakMap<object, { clientId: string; token: string }>();
  let healthWindow = now();
  let healthCount = 0;

  function authorize(request: FastifyRequest) {
    const authorizationCount = request.raw.rawHeaders.filter(
      (_header, index, all) => index % 2 === 0 && all[index]?.toLowerCase() === 'authorization',
    ).length;
    const header = request.headers.authorization;
    if (
      authorizationCount !== 1 ||
      typeof header !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)
    )
      throw gatewayError('unauthenticated', 401, 'after_reconnect');
    const token = header.slice(7);
    const principal = options.registry.authenticate(token);
    authenticated.set(request, { clientId: principal.clientId, token });
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (Object.keys(request.query as object).length > 0) throw gatewayError('invalid_input', 400);
    if (
      request.routeOptions.url === '/v2/assistant/turn' ||
      request.routeOptions.url === '/v2/pairing'
    )
      authorize(request);
  });
  app.addHook('preValidation', async (request) => {
    const body = request.body as Record<string, unknown> | null;
    if (
      body &&
      typeof body === 'object' &&
      Object.hasOwn(body, 'apiVersion') &&
      body.apiVersion !== API_VERSION
    )
      throw gatewayError('incompatible_version', 409);
  });
  app.setErrorHandler((error: unknown, _request, reply) => {
    const fastify = error as { code?: string; validation?: unknown };
    let safe: GatewayError;
    if (error instanceof GatewayError) safe = error;
    else if (fastify.code === 'FST_ERR_CTP_BODY_TOO_LARGE') safe = gatewayError('too_large', 413);
    else if (fastify.validation || fastify.code?.startsWith('FST_ERR_CTP_'))
      safe = gatewayError('invalid_input', 400);
    else safe = safeError(error);
    return reply.code(safe.status).send({ error: safe.detail });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: gatewayError('unsupported_request', 404, 'never').detail }),
  );

  app.get('/health', async () => {
    if (now() - healthWindow >= 60_000) {
      healthWindow = now();
      healthCount = 0;
    }
    if (++healthCount > LIMITS.healthRequestsPerMinute)
      throw gatewayError('busy', 429, 'after_delay');
    return { status: 'ready', apiVersion: API_VERSION };
  });
  app.post(
    '/v2/pair',
    {
      bodyLimit: LIMITS.pairingBodyBytes,
      schema: { body: { $ref: `${schema.$id}#/definitions/PairRequest` } },
    },
    async (request) => pairing.pair((request.body as { code: string }).code),
  );
  app.delete('/v2/pairing', async (request, reply) => {
    if (request.body !== undefined) throw gatewayError('invalid_input', 400);
    const principal = authenticated.get(request);
    if (!principal) throw gatewayError('unauthenticated', 401, 'after_reconnect');
    await options.registry.revoke(principal.clientId);
    return reply.code(204).send();
  });
  app.post(
    '/v2/assistant/turn',
    { schema: { body: { $ref: `${schema.$id}#/definitions/AssistantTurnRequest` } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = authenticated.get(request);
      if (!principal) throw gatewayError('unauthenticated', 401, 'after_reconnect');
      const checked = checkAssistantRequest(request.body, options.catalogue);
      if (!checked.ok)
        throw new GatewayError(
          checked.error,
          checked.error.code === 'incompatible_version' ? 409 : 422,
        );
      // Body parsing can outlive the early auth hook; revocation/expiry must deny dispatch.
      options.registry.authenticate(principal.token);
      const turn = admission.begin(principal.clientId, checked.value);
      const abortOnDisconnect = () => {
        if (!reply.raw.writableEnded) turn.cancel();
      };
      request.raw.once('aborted', turn.cancel);
      reply.raw.once('close', abortOnDisconnect);
      try {
        const result = await abortable(options.turn(checked.value, turn), turn.signal);
        turn.signal.throwIfAborted();
        options.registry.authenticate(principal.token);
        const response = checkAssistantResponse(result, options.catalogue);
        if (!response.ok && response.error.code === 'too_large')
          throw gatewayError('too_large', 422);
        if (
          !response.ok ||
          !checkMemoryResponseForRequest(result, checked.value).ok ||
          !isResponseCurrent(result, {
            ...checked.value,
            preferenceRevision: checked.value.context.preferences.revision,
          })
        )
          throw gatewayError('invalid_model_result', 502, 'never');
        return response.value;
      } finally {
        request.raw.removeListener('aborted', turn.cancel);
        reply.raw.removeListener('close', abortOnDisconnect);
        turn.finish();
      }
    },
  );
  app.addHook('onClose', async () => {
    admission.close();
    pairing.closeWindow();
    removeListener();
  });
  return { app, pairing, admission, revoke: options.registry.revoke };
}
