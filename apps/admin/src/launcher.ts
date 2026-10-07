import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAdminServer } from './server';
import { registerAdminAssets } from './staticAssets';
import { readAdminPublicationConfiguration } from './publishing/runtime';
import {
  adminStateDirectory,
  assertRegularAdminFile,
  lockAdminDirectory,
  protectAdminDirectory,
  readAdminSecret,
} from './privateState';

async function main() {
  let args = process.argv.slice(2);
  let publicationFilename: string | undefined;
  const publicationFlag = args.indexOf('--content-signing-config');
  if (publicationFlag >= 0) {
    if (publicationFlag !== args.length - 2 || !args[publicationFlag + 1])
      throw new Error(
        'Supply one explicit private publication configuration file after the listener options.',
      );
    publicationFilename = args[publicationFlag + 1];
    args = args.slice(0, publicationFlag);
  }
  const insecure = args.length === 1 && args[0] === '--local-http';
  const tls = args.length === 4 && args[0] === '--tls-cert' && args[2] === '--tls-key';
  if (!insecure && !tls)
    throw new Error('Choose explicit local HTTP or supply a trusted TLS certificate and key.');
  const https = tls ? { cert: await readFile(args[1]!), key: await readFile(args[3]!) } : undefined;
  const directory = adminStateDirectory();
  await protectAdminDirectory(directory);
  const unlock = await lockAdminDirectory(directory);
  try {
    const secret = await readAdminSecret(directory);
    const publication = await readAdminPublicationConfiguration(directory, publicationFilename);
    for (const name of ['admin.sqlite', 'admin.sqlite-wal', 'admin.sqlite-shm'])
      await assertRegularAdminFile(path.join(directory, name));
    if (publication)
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        await assertRegularAdminFile(publication.issuedDatabaseFile + suffix);
    const media = path.join(directory, 'media');
    await protectAdminDirectory(media);
    const origin = `${insecure ? 'http' : 'https'}://127.0.0.1:3444`;
    const app = buildAdminServer({
      databaseFile: path.join(directory, 'admin.sqlite'),
      mediaDirectory: media,
      bundledPhotoDirectory: fileURLToPath(
        new URL('../../../packages/catalogue/assets/photos/', import.meta.url),
      ),
      origin,
      sessionSecret: secret,
      allowInsecureLoopback: insecure,
      ...(https ? { https } : {}),
      ...(publication ? { publication } : {}),
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try {
        await app.close();
      } finally {
        await unlock();
      }
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    try {
      registerAdminAssets(app, fileURLToPath(new URL('../dist/', import.meta.url)));
      await app.listen({ host: '127.0.0.1', port: 3444 });
    } catch (error) {
      await close();
      throw error;
    }
    process.stdout.write(
      `CookMate private recipe studio: ${origin}/admin/\n${insecure ? 'Local loopback HTTP development; not a public deployment.' : 'TLS enabled; loopback listener only.'}\n`,
    );
  } catch (error) {
    await unlock();
    throw error;
  }
}
void main().catch(() => {
  process.stderr.write(
    'CookMate admin could not start. Complete operator setup, build the dashboard and check local configuration. No credentials were printed.\n',
  );
  process.exitCode = 1;
});
