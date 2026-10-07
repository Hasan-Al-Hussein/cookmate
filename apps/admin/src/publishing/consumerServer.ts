import Fastify from 'fastify';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { ConsumerContentDelivery } from './consumerDelivery';
import { registerConsumerContentRoutes } from './consumerRoutes';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const loopback = (ip: string | undefined) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
const maximumAssetBytes = 64 * 1024 * 1024;
const ordinaryEntries = new Set([
  '/',
  '/private-content',
  '/plan',
  '/favourites',
  '/settings',
  '/manual-shopping',
  '/collections',
  '/plan-edit',
  '/shopping-meals',
  '/cooking-history',
]);
function isApplicationEntry(pathname: string) {
  if (pathname.includes('//')) return false;
  const route = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return (
    ordinaryEntries.has(route) ||
    /^\/(recipe|recipe-personal)\/[0-9]{1,20}$/.test(route) ||
    /^\/collection\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      route,
    )
  );
}

/** Private, loopback-only exported web app plus read-only issued content. No admin or proxy. */
export function buildConsumerReviewServer(options: {
  origin: string;
  webRoot: string;
  delivery: ConsumerContentDelivery;
}) {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port
  )
    throw new Error('Private content review requires an explicit 127.0.0.1 HTTP origin.');
  const root = resolve(options.webRoot);
  if (
    !isAbsolute(options.webRoot) ||
    !samePath(realpathSync(root), root) ||
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink()
  )
    throw new Error('Private content review requires an existing exported web directory.');
  const index = resolve(root, 'index.html');
  if (!lstatSync(index).isFile() || !samePath(realpathSync(index), index))
    throw new Error('Private content review requires its exported index.');
  const app = Fastify({
    logger: false,
    trustProxy: false,
    exposeHeadRoutes: false,
    requestTimeout: 20_000,
    connectionTimeout: 20_000,
    bodyLimit: 1024,
  });
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Opener-Policy', 'same-origin')
      .header('Cross-Origin-Embedder-Policy', 'require-corp')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Referrer-Policy', 'no-referrer');
    if (
      !loopback(request.raw.socket.remoteAddress) ||
      request.headers.host !== origin.host ||
      request.protocol !== 'http' ||
      (request.headers.origin !== undefined && request.headers.origin !== origin.origin) ||
      (request.headers['sec-fetch-site'] !== undefined &&
        !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))
    )
      return reply.code(403).send({ error: 'Private review origin does not match.' });
  });
  registerConsumerContentRoutes(app, { origin: origin.origin, delivery: options.delivery });
  app.get('/*', async (request, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(request.url.split('?')[0]!);
    } catch {
      return reply.code(400).send({ error: 'Invalid asset path.' });
    }
    if (
      !pathname.startsWith('/') ||
      pathname.includes('\\') ||
      pathname.includes('\0') ||
      pathname.split('/').some((part) => part.startsWith('.')) ||
      pathname.startsWith('/cookmate-content/') ||
      pathname.startsWith('/admin')
    )
      return reply.code(404).send({ error: 'Private review asset not found.' });
    const entry = isApplicationEntry(pathname);
    const filename = entry ? index : resolve(root, `.${pathname}`);
    const inside = relative(root, filename);
    if (inside.startsWith('..') || isAbsolute(inside))
      return reply.code(404).send({ error: 'Private review asset not found.' });
    const mime = types[extname(filename).toLowerCase()];
    if (!mime) return reply.code(404).send({ error: 'Private review asset not found.' });
    try {
      const info = await lstat(filename);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > maximumAssetBytes ||
        !samePath(await realpath(filename), filename)
      )
        return reply.code(404).send({ error: 'Private review asset not found.' });
      const handle = await open(filename, 'r');
      try {
        const actual = await handle.stat();
        if (
          !actual.isFile() ||
          actual.size !== info.size ||
          actual.dev !== info.dev ||
          actual.ino !== info.ino
        )
          throw new Error('Asset changed.');
        if (actual.size === 0) {
          await handle.close();
          return reply.type(mime).header('Content-Length', 0).send('');
        }
        // A growing export file must not exceed the byte range admitted above.
        const stream = handle.createReadStream({ autoClose: true, start: 0, end: actual.size - 1 });
        return reply.type(mime).header('Content-Length', actual.size).send(stream);
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch {
      return reply.code(404).send({ error: 'Private review asset not found.' });
    }
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(503).send({ error: 'Private review is unavailable.' }),
  );
  return app;
}
