import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CONTENT_LIMITS,
  ContentValidationError,
  OVERLAY_LIMITS,
  validateOverlayHead,
} from '@cookmate/catalogue/content';
import type { AdminPublicationIssueRequest, AdminPublicationReleaseState } from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import { AdminFault, requireAdmin } from '../auth/errors';
import { identifier, object } from '../drafts/validation';
import type { AdminPublicationRuntime } from './runtime';
import { validateDeliveryIdentity } from './delivery';

/** Private administrator routes inside the existing authenticated/CSRF-protected scope. */
export function registerIssuanceRoutes(
  backend: FastifyInstance,
  options: {
    db: AdminDatabase;
    publication: AdminPublicationRuntime | null;
    now(): Date;
    actor(request: FastifyRequest): Actor;
  },
) {
  const path = '/admin/api/publication/releases';
  const administrator = (request: FastifyRequest) => {
    const actor = options.actor(request);
    options.db.assertActor(actor, options.now().getTime(), ['administrator']);
    return actor;
  };
  const configured = () => {
    requireAdmin(
      options.publication,
      503,
      'publication_not_configured',
      'Private signed publication is not configured. Prepared packages remain unchanged.',
    );
    return options.publication.issuer;
  };
  backend.get(`${path}/current`, async (request): Promise<AdminPublicationReleaseState> => {
    const actor = administrator(request);
    object(request.query, []);
    if (!options.publication) return { status: 'not_configured' };
    return { status: 'ready', ...(await options.publication.issuer.current(actor)) };
  });
  backend.get(`${path}/:releaseId/package`, async (request) => {
    const actor = administrator(request);
    object(request.params, ['releaseId']);
    object(request.query, []);
    validateDeliveryIdentity(request.params.releaseId);
    const result = await configured().exportPackage(actor, request.params.releaseId);
    administrator(request);
    return result;
  });
  backend.get(`${path}/:releaseId/media/:sha256`, async (request, reply) => {
    const actor = administrator(request);
    object(request.params, ['releaseId', 'sha256']);
    object(request.query, []);
    validateDeliveryIdentity(request.params.releaseId, request.params.sha256);
    const result = await configured().exportMedia(
      actor,
      request.params.releaseId,
      request.params.sha256 as string,
    );
    administrator(request);
    return reply.type(result.descriptor.mimeType).send(result.bytes);
  });
  backend.post(path, { bodyLimit: CONTENT_LIMITS.releaseBytes }, async (request) => {
    const actor = administrator(request);
    object(request.query, []);
    object(request.body, ['operationId', 'expectedHead', 'entries']);
    identifier(request.body.operationId);
    requireAdmin(
      !/[^A-Za-z0-9_-]/.test(request.body.operationId) &&
        (request.body.expectedHead === null || validateOverlayHead(request.body.expectedHead)),
      400,
      'invalid_release_request',
      'Supply the exact reviewed release head and operation identifier.',
    );
    requireAdmin(
      Array.isArray(request.body.entries) &&
        request.body.entries.length <= OVERLAY_LIMITS.overrides,
      400,
      'invalid_release_request',
      'Supply a bounded cumulative release membership.',
    );
    const input = request.body as unknown as AdminPublicationIssueRequest;
    try {
      return await configured().issue(actor, input.operationId, {
        expectedHead: input.expectedHead,
        entries: input.entries,
      });
    } catch (error) {
      if (error instanceof ContentValidationError)
        throw new AdminFault(
          409,
          'release_verification_failed',
          'The proposed release failed content, media or ancestry verification. Review its exact membership and current release before trying again.',
        );
      throw error;
    }
  });
  backend.get(`${path}/operations/:operationId`, async (request) => {
    const actor = administrator(request);
    object(request.params, ['operationId']);
    object(request.query, ['requestFingerprint']);
    identifier(request.params.operationId);
    requireAdmin(
      !/[^A-Za-z0-9_-]/.test(request.params.operationId),
      400,
      'invalid_release_request',
      'Use the exact release operation identifier.',
    );
    requireAdmin(
      typeof request.query.requestFingerprint === 'string' &&
        request.query.requestFingerprint.length === 64 &&
        /^[a-f0-9]{64}$/.test(request.query.requestFingerprint),
      400,
      'invalid_release_request',
      'Use the exact release request fingerprint to recover its result.',
    );
    return configured().recover(
      actor,
      request.params.operationId,
      request.query.requestFingerprint,
    );
  });
  backend.post(`${path}/operations/:operationId/resolve`, { bodyLimit: 1024 }, async (request) => {
    const actor = administrator(request);
    object(request.params, ['operationId']);
    object(request.query, []);
    object(request.body, ['requestFingerprint']);
    identifier(request.params.operationId);
    requireAdmin(
      typeof request.body.requestFingerprint === 'string' &&
        request.body.requestFingerprint.length === 64,
      400,
      'invalid_release_request',
      'Use the exact release request fingerprint to resolve its result.',
    );
    return configured().resolve(actor, request.params.operationId, request.body.requestFingerprint);
  });
}
