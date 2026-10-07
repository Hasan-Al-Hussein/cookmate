/** Disposable shared admin/consumer proof. No real operator, signer or mobile store is opened. */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogue } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { isAppId } from '../../mobile/src/data/conversationRecords';
import { readPrivateContentConfiguration } from '../../mobile/src/features/content/privateContentConfig';
import { hashPassword } from '../src/auth/passwords';
import { openConsumerContentDelivery } from '../src/publishing/consumerDelivery';
import { buildConsumerReviewServer } from '../src/publishing/consumerServer';
import { buildAdminServer } from '../src/server';
import { registerAdminAssets } from '../src/staticAssets';
import { openAdminDatabase } from '../src/storage/database';
import { fixturePassword } from './helpers';
import { boundedFile, consumerOrigin, ownedDirectory, samePath } from './ordinary-browser-fixture';

const prefix = 'cookmate-configured-journey-';
const manifestName = 'journey.json';
const configName = 'ordinary-config.json';
const maximumLifetimeMs = 60 * 60 * 1000;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function requireFixture(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
interface JourneyManifest {
  version: 1;
  kind: 'disposable-configured-journey';
  directory: string;
  createdAt: string;
  adminOrigin: string;
  consumerOrigin: string;
  installationId: string;
  trustKeys: { keyId: string; publicKeyHex: string }[];
}
/** Public fixture metadata only. The ephemeral private signer never leaves the admin process. */
export async function createConfiguredBrowserJourney(
  options = {
    adminOrigin: 'http://127.0.0.1:3445',
    consumerOrigin: 'http://127.0.0.1:3458',
  },
) {
  consumerOrigin(options.adminOrigin);
  consumerOrigin(options.consumerOrigin);
  requireFixture(
    options.adminOrigin !== options.consumerOrigin,
    'Use separate admin and consumer origins.',
  );
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const pair = generateKeyPairSync('ed25519');
  const manifest: JourneyManifest = {
    version: 1,
    kind: 'disposable-configured-journey',
    directory,
    createdAt: new Date().toISOString(),
    ...options,
    installationId: randomUUID(),
    trustKeys: [
      {
        keyId: 'disposable-configured-journey',
        publicKeyHex: pair.publicKey
          .export({ type: 'spki', format: 'der' })
          .subarray(-32)
          .toString('hex'),
      },
    ],
  };
  const databaseFile = join(directory, 'admin.sqlite');
  const db = openAdminDatabase(databaseFile);
  try {
    db.createFirstAdministrator({
      userId: 'fixture-admin',
      username: 'fixture.admin',
      passwordHash: await hashPassword(fixturePassword),
    });
  } finally {
    db.close();
  }
  const app = buildAdminServer({
    databaseFile,
    mediaDirectory: join(directory, 'media'),
    bundledPhotoDirectory: fileURLToPath(
      new URL('../../../packages/catalogue/assets/photos/', import.meta.url),
    ),
    origin: manifest.adminOrigin,
    sessionSecret: randomBytes(32).toString('hex'),
    allowInsecureLoopback: true,
    publication: {
      issuedDatabaseFile: join(directory, 'issued.sqlite'),
      signingKeyId: manifest.trustKeys[0]!.keyId,
      signingPrivateKey: pair.privateKey,
      trustedKeys: manifest.trustKeys,
    },
  });
  try {
    await mkdir(join(directory, 'web'));
    await writeFile(join(directory, manifestName), canonicalContentJson(manifest, 16_384), {
      flag: 'wx',
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  return { manifest, app, close: () => app.close() };
}
export async function readConfiguredBrowserJourney(input: string): Promise<JourneyManifest> {
  const directory = await ownedDirectory(input, prefix);
  const serialized = await boundedFile(join(directory, manifestName));
  const value: unknown = JSON.parse(serialized);
  requireFixture(
    exact(value, [
      'version',
      'kind',
      'directory',
      'createdAt',
      'adminOrigin',
      'consumerOrigin',
      'installationId',
      'trustKeys',
    ]) &&
      value.version === 1 &&
      value.kind === 'disposable-configured-journey' &&
      value.directory === directory &&
      typeof value.createdAt === 'string' &&
      Number.isFinite(Date.parse(value.createdAt)) &&
      typeof value.adminOrigin === 'string' &&
      typeof value.consumerOrigin === 'string' &&
      value.adminOrigin !== value.consumerOrigin &&
      isAppId(value.installationId),
    'Invalid journey identity.',
  );
  consumerOrigin(value.adminOrigin);
  consumerOrigin(value.consumerOrigin);
  const config = readPrivateContentConfiguration(
    canonicalContentJson(
      {
        version: 1,
        origin: value.consumerOrigin,
        installationId: value.installationId,
        releaseId: 'fixture-validation-only',
        trustKeys: value.trustKeys,
      },
      10_240,
    ),
    value.consumerOrigin,
  );
  requireFixture(
    config && canonicalContentJson(value, 16_384) === serialized,
    'Invalid canonical public trust configuration.',
  );
  return Object.freeze({
    ...value,
    trustKeys: config.trustKeys.map((key) => Object.freeze({ ...key })),
  }) as JourneyManifest;
}
async function replaceOwnedPublicConfig(directory: string, text: string) {
  const filename = join(directory, configName);
  try {
    const info = await lstat(filename);
    requireFixture(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        samePath(await realpath(filename), filename),
      'Refusing an unowned public configuration.',
    );
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const temporary = join(directory, `config-${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: 'wx' });
  await rename(temporary, filename);
}
/** Explicit operator selection after issuance. Never selects a latest alias or changes trust/install identity. */
export async function selectConfiguredJourneyRelease(input: string, releaseId: string) {
  const manifest = await readConfiguredBrowserJourney(input);
  const config = readPrivateContentConfiguration(
    canonicalContentJson(
      {
        version: 1,
        origin: manifest.consumerOrigin,
        installationId: manifest.installationId,
        releaseId,
        trustKeys: manifest.trustKeys,
      },
      10_240,
    ),
    manifest.consumerOrigin,
  );
  requireFixture(config, 'Invalid selected release.');
  const delivery = openConsumerContentDelivery({
    issuedDatabaseFile: join(manifest.directory, 'issued.sqlite'),
    trustedKeys: manifest.trustKeys,
    allowedReleaseIds: [config.releaseId],
  });
  try {
    const issued = await delivery.readPackage(config.releaseId);
    requireFixture(
      canonicalContentJson(issued.envelope.manifest.baseline) ===
        canonicalContentJson(catalogue.identity),
      'Different bundled baseline.',
    );
    await replaceOwnedPublicConfig(manifest.directory, canonicalContentJson(config, 10_240));
    return {
      manifest,
      config,
      head: {
        releaseId: issued.envelope.manifest.releaseId,
        sequence: issued.envelope.manifest.sequence,
        fingerprint: issued.envelope.fingerprint,
      },
    };
  } finally {
    await delivery.close();
  }
}
/** No admin routes, signer or credentials enter the consumer server. Exactly the selected release is allowed. */
export async function openConfiguredJourneyConsumer(input: string) {
  const manifest = await readConfiguredBrowserJourney(input);
  const config = readPrivateContentConfiguration(
    await boundedFile(join(manifest.directory, configName)),
    manifest.consumerOrigin,
  );
  requireFixture(
    config &&
      config.origin === manifest.consumerOrigin &&
      config.installationId === manifest.installationId &&
      canonicalContentJson(config.trustKeys) === canonicalContentJson(manifest.trustKeys),
    'Selected configuration differs from its installation or public trust.',
  );
  const delivery = openConsumerContentDelivery({
    issuedDatabaseFile: join(manifest.directory, 'issued.sqlite'),
    trustedKeys: manifest.trustKeys,
    allowedReleaseIds: [config.releaseId],
  });
  try {
    await delivery.readPackage(config.releaseId);
    const app = buildConsumerReviewServer({
      origin: manifest.consumerOrigin,
      webRoot: join(manifest.directory, 'web'),
      delivery,
    });
    return { manifest, config, app };
  } catch (error) {
    await delivery.close();
    throw error;
  }
}
async function listenForReview(app: ReturnType<typeof buildAdminServer>, origin: string) {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      clearTimeout(expiry);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      closing = app.close();
    }
    return closing;
  };
  const stop = () => {
    void close().catch(() => {
      process.exitCode = 1;
      process.stderr.write('Fixture close failed; owned files retained.\n');
    });
  };
  try {
    await app.listen({ host: '127.0.0.1', port: Number(consumerOrigin(origin).port) });
  } catch (error) {
    await close();
    throw error;
  }
  expiry = setTimeout(stop, maximumLifetimeMs);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { close, expiresAt: new Date(Date.now() + maximumLifetimeMs).toISOString() };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--start' && args[1] === '--browser-review') {
    const active = await createConfiguredBrowserJourney();
    registerAdminAssets(active.app, fileURLToPath(new URL('../dist/', import.meta.url)));
    const listener = await listenForReview(active.app, active.manifest.adminOrigin);
    process.stdout.write(
      JSON.stringify({
        kind: 'serving_disposable_journey_admin',
        fixtureRoot: active.manifest.directory,
        origin: active.manifest.adminOrigin,
        consumerOrigin: active.manifest.consumerOrigin,
        installationId: active.manifest.installationId,
        expiresAt: listener.expiresAt,
        filesRetained: true,
      }) + '\n',
    );
    return;
  }
  if (args.length === 4 && args[0] === '--select-release' && args[2] === '--release-id') {
    const selected = await selectConfiguredJourneyRelease(args[1]!, args[3]!);
    process.stdout.write(
      JSON.stringify({
        kind: 'selected_disposable_journey_release',
        fixtureRoot: selected.manifest.directory,
        publicConfig: join(selected.manifest.directory, configName),
        webRoot: join(selected.manifest.directory, 'web'),
        origin: selected.config.origin,
        installationId: selected.config.installationId,
        head: selected.head,
        adopted: false,
      }) + '\n',
    );
    return;
  }
  if (args.length === 2 && args[0] === '--serve-consumer') {
    const active = await openConfiguredJourneyConsumer(args[1]!);
    const listener = await listenForReview(active.app, active.manifest.consumerOrigin);
    process.stdout.write(
      JSON.stringify({
        kind: 'serving_disposable_journey_consumer',
        fixtureRoot: active.manifest.directory,
        origin: active.manifest.consumerOrigin,
        installationId: active.config.installationId,
        releaseId: active.config.releaseId,
        expiresAt: listener.expiresAt,
        filesRetained: true,
      }) + '\n',
    );
    return;
  }
  throw new Error(
    'Use --start --browser-review; --select-release ABSOLUTE_JOURNEY_ROOT --release-id EXACT_ISSUED_ID; or --serve-consumer ABSOLUTE_JOURNEY_ROOT.',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stderr.write(
      'Disposable journey command failed. Check its owned directory, exact release, exported web assets and listener ownership. No real workspace or retained fixture is deleted.\n',
    );
  });
}
