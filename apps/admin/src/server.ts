import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import csrf from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import type { AdminServerOptions } from './configuration';
import type { AdminSession, AdminUser, AdminLibraryStatus } from './contracts';
import { AdminFault, requireAdmin } from './auth/errors';
import { createPasswordVerifier } from './auth/passwords';
import { ABSOLUTE_MS, IDLE_MS, createSessionStore } from './auth/sessions';
import { openAdminDatabase, type Actor } from './storage/database';
import { DraftRepository } from './drafts/repository';
import {
  draftInput,
  identifier,
  object,
  publicOperationIdentifier,
  revision,
  rightsInput,
  text,
} from './drafts/validation';
import { AdminMedia, MAX_UPLOAD_BYTES } from './media/service';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { prepareReviewedPublication } from './publishing/prepare';
import type { AdminPublicationPreview } from './contracts';
import { registerPublicationRoutes } from './publishing/routes';
import { registerIssuanceRoutes } from './publishing/issuanceRoutes';
import { createAdminPublicationRuntime, type AdminPublicationRuntime } from './publishing/runtime';
import { PreparedPublicationArchive } from './publishing/archive';
import { readLibraryLifecycle } from './drafts/libraryStatus';
import { registerTranslationRoutes } from './translations/routes';

const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function operator(user: AdminUser): AdminUser {
  return { userId: user.userId, username: user.username, role: user.role };
}
function password(value: unknown): asserts value is string {
  requireAdmin(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      [...value].length <= 128,
    400,
    'invalid_credentials',
    'Enter a username and password within the supported bounds.',
  );
}
function params(request: FastifyRequest): Record<string, string> {
  return request.params as Record<string, string>;
}

/** Synchronous construction is deliberate: returning Fastify from an async function would invoke ready(). */
export function buildAdminServer(options: AdminServerOptions): FastifyInstance {
  const origin = new URL(options.origin);
  requireAdmin(
    options.origin === origin.origin &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      ((origin.protocol === 'https:' && !!options.https) ||
        (origin.protocol === 'http:' &&
          !options.https &&
          options.allowInsecureLoopback === true &&
          origin.hostname === '127.0.0.1')),
    500,
    'admin_origin',
    'Use HTTPS with TLS configuration, or explicitly enable local HTTP on 127.0.0.1.',
  );
  requireAdmin(
    typeof options.sessionSecret === 'string' &&
      Buffer.byteLength(options.sessionSecret) >= 32 &&
      Buffer.byteLength(options.sessionSecret) <= 4096,
    500,
    'session_configuration',
    'A valid private session signing secret is required.',
  );
  // Both listeners expose the same request/reply API; fix the public instance type
  // before registering plugins rather than propagating incompatible overload unions.
  const app = (options.https
    ? Fastify({
        https: options.https,
        logger: false,
        bodyLimit: 1024 * 1024,
        requestTimeout: 30_000,
        connectionTimeout: 30_000,
        trustProxy: false,
      })
    : Fastify({
        logger: false,
        bodyLimit: 1024 * 1024,
        requestTimeout: 30_000,
        connectionTimeout: 30_000,
        trustProxy: false,
      })) as unknown as FastifyInstance;
  const db = openAdminDatabase(options.databaseFile);
  const now = options.now ?? (() => new Date());
  const drafts = new DraftRepository(db, now);
  const media = new AdminMedia(
    db,
    drafts,
    options.mediaDirectory,
    options.bundledPhotoDirectory,
    now,
  );
  const libraryArchive = new PreparedPublicationArchive(db, media, now);
  let publication: AdminPublicationRuntime | null = null;
  try {
    if (options.publication)
      publication = createAdminPublicationRuntime({
        configuration: options.publication,
        adminDatabaseFile: options.databaseFile,
        db,
        media,
        now,
      });
  } catch (error) {
    db.close();
    throw error;
  }
  const verifyPassword = createPasswordVerifier();
  const actors = new WeakMap<FastifyRequest, Actor>();
  app.addHook('onClose', async () => {
    try {
      publication?.close();
    } finally {
      db.close();
    }
  });
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    requireAdmin(
      request.headers.host === origin.host && request.protocol === origin.protocol.slice(0, -1),
      403,
      'invalid_host',
      'This request does not match the configured admin origin.',
    );
    requireAdmin(
      !request.headers.origin || request.headers.origin === origin.origin,
      403,
      'invalid_origin',
      'This request does not match the configured admin origin.',
    );
    if (unsafe.has(request.method))
      requireAdmin(
        request.headers.origin === origin.origin,
        403,
        'origin_required',
        'A same-origin request is required.',
      );
    requireAdmin(
      !request.headers['sec-fetch-site'] ||
        ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])),
      403,
      'cross_site_request',
      'Cross-site admin requests are not accepted.',
    );
  });
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AdminFault)
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    const failure = error as { code?: string; statusCode?: number };
    if (failure.code?.startsWith('FST_CSRF'))
      return reply.status(403).send({
        error: {
          code: 'csrf_required',
          message:
            'Your request token expired. Refresh the session and retry without losing your changes.',
        },
      });
    if (failure.statusCode === 429)
      return reply.status(429).send({
        error: { code: 'rate_limit', message: 'Too many requests. Please try again shortly.' },
      });
    if (failure.statusCode === 413)
      return reply.status(413).send({
        error: { code: 'request_too_large', message: 'The request exceeds its supported size.' },
      });
    if (failure.statusCode === 400 || failure.statusCode === 415)
      return reply.status(failure.statusCode).send({
        error: {
          code: 'invalid_request',
          message: 'The request could not be read. Check its fields and format.',
        },
      });
    return reply.status(503).send({
      error: {
        code: 'admin_unavailable',
        message:
          'Admin storage or processing is unavailable. Keep your changes and recover using the same operation identifier.',
      },
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'This admin resource was not found.' } }),
  );
  app.register(async (backend) => {
    await backend.register(cookie);
    await backend.register(session, {
      secret: options.sessionSecret,
      cookieName: 'cookmate_admin',
      store: createSessionStore(db, now),
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: origin.protocol === 'https:',
        path: '/admin',
        maxAge: IDLE_MS,
      },
    });
    await backend.register(csrf, {
      sessionPlugin: '@fastify/session',
      getToken: (request) =>
        typeof request.headers['x-csrf-token'] === 'string'
          ? request.headers['x-csrf-token']
          : undefined,
    });
    await backend.register(rateLimit, { global: true, max: 200, timeWindow: '1 minute', ban: 3 });
    await backend.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 50 },
      throwFileSizeLimit: true,
    });
    backend.addHook('onSend', async (_request, reply, payload) => {
      // A rejected request can carry an older cookie. Its delayed response must
      // not clear or replace a later successful sign-in in the same browser.
      if (reply.statusCode >= 400) reply.removeHeader('set-cookie');
      return payload;
    });
    backend.addHook('onRequest', (request, reply, done) => {
      if (unsafe.has(request.method)) return backend.csrfProtection(request, reply, done);
      done();
    });
    const actor = (request: FastifyRequest): Actor => {
      const existing = actors.get(request);
      if (existing) return existing;
      const user = request.session.userId ? db.userById(request.session.userId) : undefined;
      requireAdmin(
        user?.enabled &&
          request.session.authEpoch === user.authEpoch &&
          (request.session.absoluteExpiresAt ?? 0) > now().getTime(),
        401,
        'sign_in_required',
        'Please sign in to manage recipe drafts. Your unsaved changes can be kept.',
      );
      const value = {
        user: operator(user),
        authEpoch: user.authEpoch,
        sessionId: request.session.sessionId,
      };
      db.assertActor(value, now().getTime());
      actors.set(request, value);
      return value;
    };
    backend.addHook('onRequest', async (request) => {
      const pathname = request.url.split('?')[0];
      if (pathname !== '/admin/api/session') actor(request);
    });
    const sessionResponse = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<AdminSession> => {
      let user = request.session.userId ? db.userById(request.session.userId) : undefined;
      if (
        (request.session.absoluteExpiresAt !== undefined &&
          request.session.absoluteExpiresAt <= now().getTime()) ||
        (request.session.userId && (!user?.enabled || user.authEpoch !== request.session.authEpoch))
      ) {
        await request.session.regenerate();
        user = undefined;
      }
      request.session.absoluteExpiresAt ??= now().getTime() + ABSOLUTE_MS;
      const csrfToken = reply.generateCsrf();
      await request.session.save();
      return {
        configured: db.countUsers() > 0,
        user: user ? operator(user) : null,
        csrfToken,
        expiresAt: user
          ? new Date(
              Math.min(request.session.absoluteExpiresAt, now().getTime() + IDLE_MS),
            ).toISOString()
          : null,
      };
    };
    backend.get('/admin/api/session', sessionResponse);
    backend.post(
      '/admin/api/session',
      { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
      async (request, reply) => {
        object(request.body, ['username', 'password']);
        text(request.body.username, 100);
        password(request.body.password);
        requireAdmin(
          typeof request.body.username === 'string' &&
            /^[A-Za-z0-9_.@-]{1,100}$/.test(request.body.username),
          400,
          'invalid_credentials',
          'Enter a valid username and password.',
        );
        const initial = db.userByName(request.body.username);
        const matches = await verifyPassword(initial?.passwordHash, request.body.password);
        const current = initial ? db.userById(initial.userId) : undefined;
        requireAdmin(
          matches &&
            initial?.enabled &&
            current?.enabled &&
            initial.passwordHash === current.passwordHash &&
            initial.authEpoch === current.authEpoch,
          401,
          'invalid_credentials',
          'The username or password was not accepted.',
        );
        await request.session.regenerate();
        request.session.userId = current.userId;
        request.session.authEpoch = current.authEpoch;
        request.session.absoluteExpiresAt = now().getTime() + ABSOLUTE_MS;
        request.session.authenticatedAt = now().getTime();
        request.session.recentAuthAt = now().getTime();
        return sessionResponse(request, reply);
      },
    );
    backend.delete('/admin/api/session', async (request, reply) => {
      await request.session.destroy();
      reply.clearCookie('cookmate_admin', {
        path: '/admin',
        httpOnly: true,
        sameSite: 'strict',
        secure: origin.protocol === 'https:',
      });
      return reply.status(204).send();
    });
    backend.post(
      '/admin/api/reauth',
      { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
      async (request, reply) => {
        object(request.body, ['password']);
        password(request.body.password);
        const currentActor = actor(request);
        const initial = db.userById(currentActor.user.userId)!;
        requireAdmin(
          await verifyPassword(initial.passwordHash, request.body.password),
          401,
          'invalid_credentials',
          'The password was not accepted.',
        );
        db.assertActor(currentActor, now().getTime());
        const current = db.userById(initial.userId)!;
        requireAdmin(
          current.passwordHash === initial.passwordHash,
          401,
          'session_expired',
          'Please sign in again.',
        );
        request.session.recentAuthAt = now().getTime();
        return sessionResponse(request, reply);
      },
    );
    backend.get('/admin/api/library', async (request) => {
      object(request.query, [], ['query', 'status', 'cursor']);
      const query = request.query.query ?? '';
      const status = request.query.status ?? 'all';
      const cursor = request.query.cursor ?? null;
      text(query, 200);
      text(cursor, 1024, true);
      requireAdmin(
        typeof query === 'string' &&
          ['all', 'bundled', 'draft', 'reviewed', 'prepared', 'published', 'archived'].includes(
            status as string,
          ),
        400,
        'invalid_search',
        'The library filters are invalid.',
      );
      const lifecycle = await readLibraryLifecycle({
        db,
        actor: actor(request),
        now,
        archive: libraryArchive,
        issuer: publication?.issuer ?? null,
      });
      return drafts.library(
        query.trim(),
        status as AdminLibraryStatus,
        cursor as string | null,
        lifecycle,
      );
    });
    backend.get('/admin/api/drafts/:id', async (request) => {
      const id = params(request).id;
      identifier(id);
      return drafts.read(id);
    });
    backend.get('/admin/api/drafts/:id/history', async (request) => {
      const id = params(request).id;
      identifier(id);
      return { items: drafts.history(id) };
    });
    backend.get('/admin/api/drafts/:id/revisions/:revision', async (request) => {
      const id = params(request).id;
      identifier(id);
      const version = Number(params(request).revision);
      revision(version);
      return drafts.read(id, version);
    });
    backend.post('/admin/api/drafts', async (request) => {
      object(request.body, ['operationId'], ['fromRecipeId']);
      publicOperationIdentifier(request.body.operationId);
      requireAdmin(
        request.body.fromRecipeId === undefined ||
          (typeof request.body.fromRecipeId === 'string' &&
            /^\d{1,16}$/.test(request.body.fromRecipeId)),
        400,
        'invalid_recipe',
        'The bundled recipe identifier is invalid.',
      );
      return drafts.create(
        actor(request),
        request.body.operationId,
        request.body.fromRecipeId as string | undefined,
      );
    });
    backend.put('/admin/api/drafts/:id', async (request) => {
      const id = params(request).id;
      identifier(id);
      object(request.body, ['operationId', 'expectedRevision', 'input']);
      publicOperationIdentifier(request.body.operationId);
      revision(request.body.expectedRevision);
      return drafts.mutate(
        actor(request),
        id,
        request.body.operationId,
        request.body.expectedRevision,
        { kind: 'save', input: draftInput(request.body.input) },
      );
    });
    backend.post('/admin/api/drafts/:id/restore', async (request) => {
      const id = params(request).id;
      identifier(id);
      object(request.body, ['operationId', 'expectedRevision', 'sourceRevision']);
      publicOperationIdentifier(request.body.operationId);
      revision(request.body.expectedRevision);
      revision(request.body.sourceRevision);
      return drafts.mutate(
        actor(request),
        id,
        request.body.operationId,
        request.body.expectedRevision,
        { kind: 'restore', sourceRevision: request.body.sourceRevision },
      );
    });
    backend.post('/admin/api/drafts/:id/rights', async (request) => {
      const id = params(request).id;
      identifier(id);
      object(request.body, [
        'operationId',
        'expectedRevision',
        'scope',
        'status',
        'statement',
        'sourceUrl',
      ]);
      publicOperationIdentifier(request.body.operationId);
      revision(request.body.expectedRevision);
      const { scope, status, statement, sourceUrl } = request.body;
      return drafts.mutate(
        actor(request),
        id,
        request.body.operationId,
        request.body.expectedRevision,
        { kind: 'rights', input: rightsInput({ scope, status, statement, sourceUrl }) },
      );
    });
    backend.post('/admin/api/drafts/:id/metadata', async (request) => {
      const id = params(request).id;
      identifier(id);
      object(request.body, ['operationId', 'expectedRevision', 'input']);
      publicOperationIdentifier(request.body.operationId);
      revision(request.body.expectedRevision);
      return drafts.mutate(
        actor(request),
        id,
        request.body.operationId,
        request.body.expectedRevision,
        { kind: 'metadata', input: request.body.input },
      );
    });
    backend.post('/admin/api/drafts/:id/reviews', async (request) => {
      const id = params(request).id;
      identifier(id);
      object(request.body, ['operationId', 'expectedRevision', 'decision', 'note']);
      publicOperationIdentifier(request.body.operationId);
      revision(request.body.expectedRevision);
      text(request.body.note, 2000);
      requireAdmin(
        (request.body.decision === 'approved' || request.body.decision === 'changes_requested') &&
          typeof request.body.note === 'string',
        400,
        'invalid_review',
        'Choose a valid review decision.',
      );
      return drafts.mutate(
        actor(request),
        id,
        request.body.operationId,
        request.body.expectedRevision,
        { kind: 'review', decision: request.body.decision, note: request.body.note },
      );
    });
    backend.post(
      '/admin/api/drafts/:id/publication-preview',
      async (request): Promise<AdminPublicationPreview> => {
        const id = params(request).id;
        identifier(id);
        object(request.body, ['expectedRevision']);
        revision(request.body.expectedRevision);
        const checked = await prepareReviewedPublication({
          db,
          media,
          actor: actor(request),
          draftId: id,
          expectedRevision: request.body.expectedRevision,
          revisionId: `preflight-${randomUUID()}`,
          now,
        });
        return {
          status: checked.status,
          draftId: checked.draftId,
          draftRevision: checked.draftRevision,
          recipeId: checked.publication.revision.ref.recipeId,
          contentFingerprint: checked.publication.revision.ref.contentFingerprint,
          publicationFingerprint: checked.publication.publicationFingerprint,
          documentBytes: Buffer.byteLength(
            canonicalContentJson(checked.publication.revision.document),
            'utf8',
          ),
          permissionScopes: checked.publication.permissions.map((record) => record.subject.scope),
          originalEvidenceRetained: checked.originalEvidence !== null,
        };
      },
    );
    registerPublicationRoutes(backend, { db, media, now, actor });
    registerIssuanceRoutes(backend, { db, publication, now, actor });
    registerTranslationRoutes(backend, { db, now, actor });
    backend.get('/admin/api/operations/:id', async (request) => {
      const id = params(request).id;
      identifier(id);
      return drafts.receipt(actor(request), id);
    });
    backend.post('/admin/api/operations/:id/cancel', async (request) => {
      const id = params(request).id;
      publicOperationIdentifier(id);
      object(request.body, []);
      return drafts.cancel(actor(request), id);
    });
    backend.post('/admin/api/drafts/:id/media', async (request) => {
      const id = params(request).id;
      identifier(id);
      const operationId = request.headers['x-operation-id'];
      publicOperationIdentifier(operationId);
      const raw = request.headers['x-draft-revision'];
      requireAdmin(
        typeof raw === 'string' && /^[1-9]\d{0,15}$/.test(raw),
        400,
        'invalid_revision',
        'The draft revision header is invalid.',
      );
      const expected = Number(raw);
      revision(expected);
      return media.upload(request, actor(request), id, expected, operationId);
    });
    backend.get('/admin/api/assets/:hash', async (request, reply) => {
      const result = await media.asset(params(request).hash ?? '');
      return reply.type(result.mimeType).send(result.bytes);
    });
    backend.get('/admin/api/baseline/:recipeId/photo', async (request, reply) => {
      const result = await media.baseline(params(request).recipeId ?? '');
      return reply.type(result.mimeType).send(result.bytes);
    });
  });
  return app;
}
