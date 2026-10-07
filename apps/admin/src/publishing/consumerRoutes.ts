import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConsumerDeliveryError, type ConsumerContentDelivery } from './consumerDelivery';

const messages = {
  invalid_request: [400, 'The recipe delivery request is invalid.'],
  not_found: [404, 'This recipe release or image is not available.'],
  too_large: [413, 'This recipe release exceeds the supported delivery limits.'],
  busy: [503, 'Recipe delivery is busy. Try again after the current read finishes.'],
  unavailable: [503, 'Verified recipe delivery is unavailable.'],
} as const;
const loopback = (value: string | undefined) =>
  !!value &&
  (value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '[::1]' ||
    value === '::ffff:127.0.0.1');

/** Initial local consumer adapter. Register on a separate app, never inside administrator auth. */
export function registerConsumerContentRoutes(
  app: FastifyInstance,
  options: {
    origin: string;
    delivery: ConsumerContentDelivery;
  },
): void {
  const originText = options.origin;
  let origin: URL;
  try {
    origin = new URL(originText);
    if (
      originText !== origin.origin ||
      !loopback(origin.hostname) ||
      !['http:', 'https:'].includes(origin.protocol)
    )
      throw new Error();
  } catch {
    throw new ConsumerDeliveryError('unavailable');
  }
  const source = options.delivery;
  const delivery = Object.freeze({
    readPackage: source.readPackage.bind(source),
    readMedia: source.readMedia.bind(source),
    close: source.close.bind(source),
  });
  let closing = false;
  const active = () => {
    if (closing) throw new ConsumerDeliveryError('unavailable');
  };
  const deny = () => {
    throw new ConsumerDeliveryError('invalid_request');
  };
  function admit(request: FastifyRequest) {
    active();
    if (
      request.headers.host !== origin.host ||
      request.protocol !== origin.protocol.slice(0, -1) ||
      !loopback(request.raw.socket.remoteAddress) ||
      (request.headers.origin !== undefined && request.headers.origin !== originText) ||
      (request.headers['sec-fetch-site'] !== undefined &&
        !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) ||
      request.headers.cookie !== undefined ||
      request.headers.authorization !== undefined ||
      request.url.includes('?')
    )
      deny();
  }
  function error(error: unknown, reply: FastifyReply) {
    const code = error instanceof ConsumerDeliveryError ? error.code : 'unavailable';
    const [status, message] = messages[code];
    return reply.code(status).send({ error: { code: `content_delivery_${code}`, message } });
  }
  app.register(async (consumer) => {
    consumer.addHook('preClose', async () => {
      closing = true;
      await delivery.close();
    });
    consumer.addHook('onRequest', async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Referrer-Policy', 'no-referrer');
      admit(request);
    });
    consumer.setErrorHandler((failure, _request, reply) => error(failure, reply));
    const root = '/cookmate-content/releases/:releaseId';
    consumer.get<{ Params: { releaseId: string } }>(`${root}/package`, async (request, reply) => {
      const result = await delivery.readPackage(request.params.releaseId);
      active();
      return reply.type('application/json').send(result);
    });
    consumer.get<{ Params: { releaseId: string; sha256: string } }>(
      `${root}/media/:sha256`,
      async (request, reply) => {
        const result = await delivery.readMedia(request.params.releaseId, request.params.sha256);
        active();
        return reply
          .header('Content-Length', result.bytes.length)
          .type(result.descriptor.mimeType)
          .send(result.bytes);
      },
    );
  });
}
