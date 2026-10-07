import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor, AdminDatabase } from '../storage/database';
import { identifier, object, publicOperationIdentifier, revision } from '../drafts/validation';
import { requireAdmin } from '../auth/errors';
import { TranslationRepository } from './repository';
import { fingerprint } from './validation';

function id(request: FastifyRequest): string {
  object(request.params, ['id']);
  identifier(request.params.id);
  return request.params.id;
}
function optionalRevision(request: FastifyRequest): number | undefined {
  object(request.query, [], ['revision']);
  if (request.query.revision === undefined) return undefined;
  requireAdmin(
    typeof request.query.revision === 'string' && /^[1-9][0-9]{0,15}$/.test(request.query.revision),
    400,
    'invalid_revision',
    'Use an exact positive saved revision.',
  );
  const value = Number(request.query.revision);
  revision(value);
  return value;
}
/** Mounted only inside the existing authenticated, same-origin, CSRF-protected backend. */
export function registerTranslationRoutes(
  backend: FastifyInstance,
  options: {
    db: AdminDatabase;
    now(): Date;
    actor(request: FastifyRequest): Actor;
  },
): void {
  const translations = new TranslationRepository(options.db, options.now);
  backend.get('/admin/api/drafts/:id/translations', (request) => {
    const sourceId = id(request);
    object(request.query, []);
    options.actor(request);
    return { items: translations.list(sourceId) };
  });
  backend.post('/admin/api/drafts/:id/translations', (request) => {
    const sourceId = id(request);
    object(request.query, []);
    return translations.create(options.actor(request), sourceId, request.body);
  });
  backend.get('/admin/api/translations/:id', (request) => {
    const translationId = id(request);
    const version = optionalRevision(request);
    options.actor(request);
    return translations.read(translationId, version);
  });
  backend.get('/admin/api/translations/:id/original', (request) => {
    const translationId = id(request);
    const version = optionalRevision(request);
    options.actor(request);
    return translations.original(translationId, version);
  });
  backend.get('/admin/api/translations/:id/history', (request) => {
    const translationId = id(request);
    object(request.query, []);
    options.actor(request);
    return { items: translations.history(translationId), limit: 100 };
  });
  backend.put('/admin/api/translations/:id', (request) => {
    const translationId = id(request);
    object(request.query, []);
    object(request.body, ['operationId', 'expectedRevision', 'input']);
    publicOperationIdentifier(request.body.operationId);
    revision(request.body.expectedRevision);
    return translations.mutate(
      options.actor(request),
      translationId,
      request.body.operationId,
      request.body.expectedRevision,
      { kind: 'save', input: request.body.input },
    );
  });
  backend.post('/admin/api/translations/:id/rebase', (request) => {
    const translationId = id(request);
    object(request.query, []);
    object(request.body, ['operationId', 'expectedRevision', 'sourceRevision', 'input']);
    publicOperationIdentifier(request.body.operationId);
    revision(request.body.expectedRevision);
    revision(request.body.sourceRevision);
    return translations.mutate(
      options.actor(request),
      translationId,
      request.body.operationId,
      request.body.expectedRevision,
      { kind: 'rebase', sourceRevision: request.body.sourceRevision, input: request.body.input },
    );
  });
  backend.post('/admin/api/translations/:id/reviews', (request) => {
    const translationId = id(request);
    object(request.query, []);
    object(request.body, [
      'operationId',
      'expectedRevision',
      'decision',
      'note',
      'acknowledgeHumanReview',
    ]);
    publicOperationIdentifier(request.body.operationId);
    revision(request.body.expectedRevision);
    requireAdmin(
      (request.body.decision === 'approved' || request.body.decision === 'changes_requested') &&
        typeof request.body.note === 'string' &&
        typeof request.body.acknowledgeHumanReview === 'boolean',
      400,
      'invalid_translation_review',
      'Choose an operator review decision.',
    );
    return translations.mutate(
      options.actor(request),
      translationId,
      request.body.operationId,
      request.body.expectedRevision,
      {
        kind: 'review',
        decision: request.body.decision,
        note: request.body.note,
        acknowledgeHumanReview: request.body.acknowledgeHumanReview,
      },
    );
  });
  backend.get('/admin/api/translation-operations/:id', (request) => {
    const operationId = id(request);
    object(request.query, [], ['requestFingerprint']);
    if (request.query.requestFingerprint !== undefined)
      fingerprint(request.query.requestFingerprint);
    return translations.receipt(
      options.actor(request),
      operationId,
      request.query.requestFingerprint,
    );
  });
  backend.post('/admin/api/translation-operations/:id/resolve', { bodyLimit: 1024 }, (request) => {
    const operationId = id(request);
    object(request.query, []);
    object(request.body, ['requestFingerprint']);
    fingerprint(request.body.requestFingerprint);
    return translations.resolve(
      options.actor(request),
      operationId,
      request.body.requestFingerprint,
    );
  });
}
