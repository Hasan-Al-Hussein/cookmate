/** Disposable local review environment. Never opens the real operator database. */
import { mkdtemp, rm } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdminServer } from '../src/server';
import { registerAdminAssets } from '../src/staticAssets';
import { openAdminDatabase } from '../src/storage/database';
import { hashPassword } from '../src/auth/passwords';

const reviewArguments = process.argv.slice(2).join(' ');
if (
  reviewArguments !== '--browser-review' &&
  reviewArguments !== '--browser-review --signed-release-fixture' &&
  reviewArguments !== '--browser-review --signed-release-fixture --lose-first-issue-response'
)
  throw new Error('This disposable fixture requires the explicit --browser-review flag.');

const directory = await mkdtemp(path.join(tmpdir(), 'cookmate-admin-browser-'));
const filename = path.join(directory, 'fixture.sqlite');
const db = openAdminDatabase(filename);
try {
  db.createFirstAdministrator({
    userId: 'browser-review-fixture',
    username: 'review.fixture',
    passwordHash: await hashPassword('Disposable CookMate review only!'),
  });
} finally {
  db.close();
}

// Explicit disposable test trust. No operator key is read, written or configured.
const fixtureKey = process.argv.includes('--signed-release-fixture')
  ? generateKeyPairSync('ed25519')
  : null;
const app = buildAdminServer({
  databaseFile: filename,
  mediaDirectory: path.join(directory, 'media'),
  bundledPhotoDirectory: fileURLToPath(
    new URL('../../../packages/catalogue/assets/photos/', import.meta.url),
  ),
  origin: 'http://127.0.0.1:3445',
  sessionSecret: randomBytes(32).toString('hex'),
  allowInsecureLoopback: true,
  ...(fixtureKey
    ? {
        publication: {
          issuedDatabaseFile: path.join(directory, 'fixture-issued.sqlite'),
          signingKeyId: 'disposable-browser-review',
          signingPrivateKey: fixtureKey.privateKey,
          trustedKeys: [
            {
              keyId: 'disposable-browser-review',
              publicKeyHex: fixtureKey.publicKey
                .export({ type: 'spki', format: 'der' })
                .subarray(-32)
                .toString('hex'),
            },
          ],
        },
      }
    : {}),
});
// Explicit fault injection after a real commit, confined to this disposable server.
// Recovery must use the retained operation; no recipe/client state is fabricated.
let loseIssueResponse = process.argv.includes('--lose-first-issue-response');
app.addHook('onSend', async (request, reply, payload) => {
  if (
    loseIssueResponse &&
    request.method === 'POST' &&
    request.routeOptions.url === '/admin/api/publication/releases' &&
    reply.statusCode === 200
  ) {
    loseIssueResponse = false;
    reply.hijack();
    reply.raw.destroy();
  }
  return payload;
});
registerAdminAssets(app, fileURLToPath(new URL('../dist/', import.meta.url)));
let closed = false;
const expiry = setTimeout(() => void close(), 30 * 60 * 1000);
async function close() {
  if (closed) return;
  closed = true;
  clearTimeout(expiry);
  try {
    await app.close();
  } finally {
    const target = path.resolve(directory);
    const relative = path.relative(path.resolve(tmpdir()), target);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !relative.startsWith('cookmate-admin-browser-')
    )
      throw new Error('Refusing cleanup outside the named temporary fixture.');
    await rm(target, { recursive: true, force: true });
  }
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
try {
  await app.listen({ host: '127.0.0.1', port: 3445 });
  process.stdout.write(
    'Disposable CookMate review fixture: http://127.0.0.1:3445/admin/\nNo real operator or mobile data is used. Expires in 30 minutes.\n',
  );
} catch (error) {
  await close();
  throw error;
}
