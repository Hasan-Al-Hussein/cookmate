import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const files: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'brand.png': 'image/png',
  'Newsreader-Regular.ttf': 'font/ttf',
  'Newsreader-Italic.ttf': 'font/ttf',
};
export function registerAdminAssets(app: FastifyInstance, directory: string) {
  for (const [name, type] of Object.entries(files)) {
    app.get(name === 'index.html' ? '/admin/' : `/admin/${name}`, async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'same-origin');
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      try {
        return reply.type(type).send(await readFile(path.join(directory, name)));
      } catch {
        return reply
          .code(503)
          .type('text/plain')
          .send('Build the CookMate admin assets before opening the dashboard.');
      }
    });
  }
  app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
}
