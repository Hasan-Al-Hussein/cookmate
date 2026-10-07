import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type {
  AdminPublicationPreparation,
  AdminPublicationTranslationSelection,
  AdminRetainedPublicationSummary,
} from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import type { AdminMedia } from '../media/service';
import { requireAdmin } from '../auth/errors';
import { sha256 } from '../drafts/repository';
import { identifier, object, revision } from '../drafts/validation';
import { PreparedPublicationArchive } from './archive';
import type { PreparedPublicationReceipt } from './archive';
import { ownTranslationSelections, PREPARATION_REQUEST_BYTES } from './translationSelection';

function ids(
  actor: Actor,
  draftId: string,
  expectedRevision: number,
  translations?: readonly AdminPublicationTranslationSelection[],
) {
  if (translations) {
    const digest = sha256(
      canonicalContentJson(
        [
          'cookmate-admin-preparation-request-v2',
          [actor.user.userId, draftId, { expectedRevision, translations }],
        ],
        PREPARATION_REQUEST_BYTES + 4096,
      ),
    );
    return { operationId: `prepare-v2-${digest}`, revisionId: `authored-v2-${digest}` };
  }
  const digest = sha256(
    canonicalContentJson([
      'cookmate-admin-preparation-request-v1',
      [actor.user.userId, draftId, expectedRevision],
    ]),
  );
  return { operationId: `prepare-${digest}`, revisionId: `authored-${digest}` };
}

function draftId(request: FastifyRequest): string {
  object(request.params, ['id']);
  identifier(request.params.id);
  return request.params.id;
}

function response(receipt: PreparedPublicationReceipt): AdminPublicationPreparation {
  const { publication } = receipt;
  return {
    status: receipt.status,
    draftId: receipt.draftId,
    draftRevision: receipt.draftRevision,
    recipeId: publication.revision.ref.recipeId,
    contentFingerprint: publication.revision.ref.contentFingerprint,
    publicationFingerprint: publication.publicationFingerprint,
    documentBytes: Buffer.byteLength(canonicalContentJson(publication.revision.document), 'utf8'),
    permissionScopes: [
      ...publication.permissions.map((record) => record.subject.scope),
      ...(publication.formatVersion === 3
        ? publication.translations.map((record) => record.permission.subject.scope)
        : []),
    ],
    originalEvidenceRetained: receipt.originalEvidence !== null,
    operationId: receipt.operationId,
    revisionId: publication.revision.ref.revisionId,
    retainedAt: receipt.preparedAt,
    ...(publication.formatVersion === 3
      ? {
          translations: publication.translations.map(
            ({ translationId, translationRevision, targetLanguage }) => ({
              translationId,
              translationRevision,
              targetLanguage,
            }),
          ),
        }
      : {}),
  };
}

/** Register inside the existing authenticated/CSRF-protected Fastify scope. No release endpoint. */
export function registerPublicationRoutes(
  backend: FastifyInstance,
  options: {
    db: AdminDatabase;
    media: Pick<AdminMedia, 'asset' | 'baseline'>;
    now(): Date;
    actor(request: FastifyRequest): Actor;
  },
): void {
  const archive = new PreparedPublicationArchive(options.db, options.media, options.now);
  const path = '/admin/api/drafts/:id/publication-preparation';
  const body = (value: unknown) => {
    const input: unknown = JSON.parse(canonicalContentJson(value, PREPARATION_REQUEST_BYTES));
    object(input, ['expectedRevision'], ['translations']);
    revision(input.expectedRevision);
    return {
      expectedRevision: input.expectedRevision,
      ...(Object.hasOwn(input, 'translations')
        ? { translations: ownTranslationSelections(input.translations) }
        : {}),
    };
  };
  backend.post(
    path,
    { bodyLimit: PREPARATION_REQUEST_BYTES },
    async (request): Promise<AdminPublicationPreparation> => {
      const id = draftId(request);
      object(request.query, []);
      const input = body(request.body);
      const actor = options.actor(request);
      const identity = ids(actor, id, input.expectedRevision, input.translations);
      return response(
        await archive.prepare(actor, identity.operationId, {
          draftId: id,
          ...input,
          revisionId: identity.revisionId,
        }),
      );
    },
  );
  // An absent result never starts a preparation. This is exact-request, read-only recovery.
  backend.post(
    `${path}/recovery`,
    { bodyLimit: PREPARATION_REQUEST_BYTES },
    async (request): Promise<AdminPublicationPreparation> => {
      const id = draftId(request);
      object(request.query, []);
      const input = body(request.body),
        actor = options.actor(request);
      const identity = ids(actor, id, input.expectedRevision, input.translations);
      const receipt = await archive.receipt(actor, identity.operationId);
      requireAdmin(
        receipt.draftId === id,
        404,
        'preparation_unknown',
        'This preparation does not belong to the selected draft.',
      );
      return response(receipt);
    },
  );
  backend.get(
    path,
    async (
      request,
    ): Promise<AdminPublicationPreparation | { items: AdminRetainedPublicationSummary[] }> => {
      const id = draftId(request);
      object(request.query, [], ['revision', 'operationId', 'list']);
      const actor = options.actor(request);
      if (Object.hasOwn(request.query, 'list')) {
        object(request.query, ['list']);
        requireAdmin(
          request.query.list === '1',
          400,
          'invalid_input',
          'Use list=1 to find retained preparations.',
        );
        return { items: await archive.retainedPreparations(actor, id) };
      }
      if (Object.hasOwn(request.query, 'operationId')) {
        object(request.query, ['operationId']);
        identifier(request.query.operationId);
        const receipt = await archive.receipt(actor, request.query.operationId);
        requireAdmin(
          receipt.draftId === id,
          404,
          'preparation_unknown',
          'This preparation does not belong to the selected draft.',
        );
        return response(receipt);
      }
      object(request.query, ['revision']);
      requireAdmin(
        typeof request.query.revision === 'string' &&
          /^[1-9]\d{0,15}$/.test(request.query.revision),
        400,
        'invalid_revision',
        'Use the exact positive integer draft revision to recover its preparation.',
      );
      const expectedRevision = Number(request.query.revision);
      revision(expectedRevision);
      return response(await archive.receipt(actor, ids(actor, id, expectedRevision).operationId));
    },
  );
}
