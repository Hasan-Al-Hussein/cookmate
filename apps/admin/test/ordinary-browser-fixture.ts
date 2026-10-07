/** Explicit disposable ordinary-app proof; no listener, operator key or mobile store is opened by preparation. */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  validateOverlayHead,
  validateRecipeContentRef,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { isUtcInstant, type CatalogueIdentity } from '@cookmate/contracts';
import {
  readPrivateContentConfiguration,
  type PrivateContentConfiguration,
} from '../../mobile/src/features/content/privateContentConfig';
import { hashPassword } from '../src/auth/passwords';
import type {
  AdminDraft,
  AdminPublicationIssueReceipt,
  AdminPublicationPreparation,
  AdminPublicationReleaseState,
} from '../src/contracts';
import { openConsumerContentDelivery } from '../src/publishing/consumerDelivery';
import { buildConsumerReviewServer } from '../src/publishing/consumerServer';
import { buildAdminServer } from '../src/server';
import { openAdminDatabase } from '../src/storage/database';
import { prepareIssuanceProposal } from '../web/issuanceProposal';
import { Client, fixturePassword, origin as injectedAdminOrigin } from './helpers';
import { prepareReviewedTranslationFixture } from './reviewedTranslationFixture';

const prefix = 'cookmate-ordinary-browser-';
const manifestName = 'fixture.json';
const configurationName = 'ordinary-config.json';
const archiveName = 'issued.sqlite';
const maximumManifestBytes = 16_384;
const maximumLifetimeMs = 60 * 60 * 1000;
interface Manifest {
  formatVersion: 1;
  kind: 'disposable-ordinary-browser';
  directory: string;
  createdAt: string;
  baseline: CatalogueIdentity;
  config: PrivateContentConfiguration;
  issuedHead: OverlayHead;
  recipe: { ref: RecipeContentRef; title: string };
}
export const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
class FixtureError extends Error {}
function demand(value: unknown, message: string): asserts value {
  if (!value) throw new FixtureError(message);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
export function consumerOrigin(text: string) {
  const url = new URL(text);
  demand(
    url.origin === text && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port,
    'Use an explicit fresh 127.0.0.1 HTTP origin.',
  );
  return url;
}
export async function ownedDirectory(input: string, expectedPrefix = prefix) {
  demand(/^cookmate-[a-z-]+-$/.test(expectedPrefix), 'Invalid disposable fixture prefix.');
  demand(
    isAbsolute(input) && input.length <= 4096,
    'Fixture root must be an absolute owned directory.',
  );
  const directory = resolve(input),
    parent = await realpath(tmpdir()),
    stat = await lstat(directory);
  demand(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      samePath(await realpath(directory), directory) &&
      samePath(dirname(directory), parent) &&
      basename(directory).startsWith(expectedPrefix),
    'Only this disposable temporary fixture root is accepted.',
  );
  return directory;
}
export async function boundedFile(filename: string) {
  const stat = await lstat(filename);
  demand(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= maximumManifestBytes &&
      samePath(await realpath(filename), filename),
    'The fixture manifest or configuration is not an owned bounded file.',
  );
  const handle = await open(filename, 'r');
  try {
    const actual = await handle.stat();
    demand(
      actual.isFile() &&
        actual.nlink === 1 &&
        actual.size === stat.size &&
        actual.ino === stat.ino &&
        actual.dev === stat.dev,
      'Fixture metadata changed during opening.',
    );
    const bytes = Buffer.alloc(stat.size + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    demand(result.bytesRead === stat.size, 'Fixture metadata changed during reading.');
    return bytes.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
export async function readOrdinaryBrowserFixture(input: string): Promise<Readonly<Manifest>> {
  const directory = await ownedDirectory(input);
  const serialized = await boundedFile(join(directory, manifestName));
  const value: unknown = JSON.parse(serialized);
  demand(
    exact(value, [
      'formatVersion',
      'kind',
      'directory',
      'createdAt',
      'baseline',
      'config',
      'issuedHead',
      'recipe',
    ]) &&
      value.formatVersion === 1 &&
      value.kind === 'disposable-ordinary-browser' &&
      value.directory === directory &&
      typeof value.createdAt === 'string' &&
      isUtcInstant(value.createdAt),
    'Fixture manifest identity is invalid.',
  );
  demand(
    canonicalContentJson(value.baseline) === canonicalContentJson(catalogue.identity),
    'Fixture bundled baseline no longer matches this checkout.',
  );
  demand(
    exact(value.config, ['version', 'origin', 'installationId', 'releaseId', 'trustKeys']) &&
      typeof value.config.origin === 'string',
    'Fixture configuration is invalid.',
  );
  consumerOrigin(value.config.origin);
  const config = readPrivateContentConfiguration(
    canonicalContentJson(value.config, 10_240),
    value.config.origin,
  );
  demand(
    config &&
      validateOverlayHead(value.issuedHead) &&
      value.issuedHead.sequence === 1 &&
      value.issuedHead.releaseId === config.releaseId,
    'Fixture release identity is invalid.',
  );
  demand(
    exact(value.recipe, ['ref', 'title']) &&
      validateRecipeContentRef(value.recipe.ref) &&
      typeof value.recipe.title === 'string' &&
      value.recipe.title.length <= 200 &&
      value.recipe.title.startsWith('Disposable proof: '),
    'Fixture recipe identity is invalid.',
  );
  demand(
    canonicalContentJson(value, maximumManifestBytes) === serialized,
    'Fixture manifest is not canonical.',
  );
  demand(
    (await boundedFile(join(directory, configurationName))) ===
      canonicalContentJson(config, 10_240),
    'Export configuration no longer matches the fixture.',
  );
  return Object.freeze({
    formatVersion: 1,
    kind: 'disposable-ordinary-browser',
    directory,
    createdAt: value.createdAt,
    baseline: catalogue.identity,
    config,
    issuedHead: Object.freeze({ ...value.issuedHead }),
    recipe: Object.freeze({
      ref: Object.freeze({ ...value.recipe.ref }),
      title: value.recipe.title,
    }),
  });
}

export async function prepareOrdinaryBrowserFixture(origin: string, withTranslation = false) {
  consumerOrigin(origin);
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = [
    {
      keyId: 'disposable-ordinary-proof',
      publicKeyHex: pair.publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(-32)
        .toString('hex'),
    },
  ];
  const databaseFile = join(directory, 'admin.sqlite'),
    issuedDatabaseFile = join(directory, archiveName);
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
  // Client uses Fastify.inject only. Its test origin is never listened on or fetched over HTTP.
  const admin = buildAdminServer({
    databaseFile,
    mediaDirectory: join(directory, 'media'),
    bundledPhotoDirectory: fileURLToPath(
      new URL('../../../packages/catalogue/assets/photos/', import.meta.url),
    ),
    origin: injectedAdminOrigin,
    sessionSecret: randomBytes(32).toString('hex'),
    allowInsecureLoopback: true,
    publication: {
      issuedDatabaseFile,
      signingKeyId: trustedKeys[0]!.keyId,
      signingPrivateKey: pair.privateKey,
      trustedKeys,
    },
  });
  const client = new Client(() => admin);
  async function request<Value>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<Value> {
    const response = await client.request(method, path, payload);
    demand(
      response.statusCode === 200,
      `Disposable administrator request failed (${method} ${path}: ${response.statusCode}).`,
    );
    return response.json() as Value;
  }
  try {
    await client.login();
    const source = catalogue.recipes[0]!;
    let draft = (await client.create(randomUUID(), source.recipeId)).draft;
    const title = `Disposable proof: ${source.title}`;
    draft = (
      await request<{ draft: AdminDraft }>('PUT', `/admin/api/drafts/${draft.draftId}`, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        input: {
          ...draft.input,
          title,
          changeSummary:
            'Disposable ordinary-app fixture: title only; ingredient quantities and original source evidence unchanged.',
        },
      })
    ).draft;
    for (const scope of [
      'recipe_text',
      'photo',
      ...(draft.input.videoUrl ? ['video_embed'] : []),
    ]) {
      draft = (
        await request<{ draft: AdminDraft }>('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
          operationId: randomUUID(),
          expectedRevision: draft.revision,
          scope,
          status: 'permitted',
          statement: 'Synthetic disposable test assertion only; not actual rights permission.',
          sourceUrl: null,
        })
      ).draft;
    }
    draft = (
      await request<{ draft: AdminDraft }>('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        decision: 'approved',
        note: 'Synthetic disposable proof only; no real editorial approval.',
      })
    ).draft;
    const translated = withTranslation
      ? await prepareReviewedTranslationFixture(client, draft)
      : null;
    const prepared = await request<AdminPublicationPreparation>(
      'POST',
      `/admin/api/drafts/${draft.draftId}/publication-preparation`,
      {
        expectedRevision: draft.revision,
        ...(translated ? { translations: [translated.selection] } : {}),
      },
    );
    const current = await request<AdminPublicationReleaseState>(
      'GET',
      '/admin/api/publication/releases/current',
    );
    demand(
      current.status === 'ready' && current.head === null,
      'The disposable archive must start with no issued head.',
    );
    const proposal = await prepareIssuanceProposal(current, prepared, randomUUID());
    const issued = await request<AdminPublicationIssueReceipt>(
      'POST',
      '/admin/api/publication/releases',
      proposal,
    );
    demand(
      issued.status === 'issued_not_activated' &&
        canonicalContentJson(issued.envelope.manifest.baseline) ===
          canonicalContentJson(catalogue.identity),
      'Issuance must retain the current bundled baseline.',
    );
    const config: PrivateContentConfiguration = {
      version: 1,
      origin,
      installationId: randomUUID(),
      releaseId: issued.envelope.manifest.releaseId,
      trustKeys: trustedKeys,
    };
    const issuedHead = {
      releaseId: config.releaseId,
      sequence: issued.envelope.manifest.sequence,
      fingerprint: issued.envelope.fingerprint,
    };
    const recipe = {
      ref: {
        recipeId: prepared.recipeId,
        revisionId: prepared.revisionId,
        contentFingerprint: prepared.contentFingerprint,
      },
      title,
    };
    const manifest: Manifest = {
      formatVersion: 1,
      kind: 'disposable-ordinary-browser',
      directory,
      createdAt: new Date().toISOString(),
      baseline: catalogue.identity,
      config,
      issuedHead,
      recipe,
    };
    await mkdir(join(directory, 'web'));
    await writeFile(join(directory, configurationName), canonicalContentJson(config, 10_240), {
      flag: 'wx',
    });
    await writeFile(
      join(directory, manifestName),
      canonicalContentJson(manifest, maximumManifestBytes),
      { flag: 'wx' },
    );
  } catch (error) {
    process.stderr.write(`Disposable preparation failed; retained owned fixture: ${directory}\n`);
    throw error;
  } finally {
    await admin.close();
  }
  const manifest = await readOrdinaryBrowserFixture(directory);
  const delivery = await openOrdinaryBrowserDelivery(manifest);
  await delivery.close();
  return manifest;
}

export async function openOrdinaryBrowserDelivery(manifest: Readonly<Manifest>) {
  const delivery = openConsumerContentDelivery({
    issuedDatabaseFile: join(manifest.directory, archiveName),
    trustedKeys: manifest.config.trustKeys,
    allowedReleaseIds: [manifest.config.releaseId],
  });
  try {
    const issued = await delivery.readPackage(manifest.config.releaseId);
    const publication = issued.publications[0];
    demand(
      publication &&
        issued.publications.length === 1 &&
        issued.envelope.manifest.releaseId === manifest.issuedHead.releaseId &&
        issued.envelope.manifest.sequence === manifest.issuedHead.sequence &&
        issued.envelope.fingerprint === manifest.issuedHead.fingerprint &&
        canonicalContentJson(issued.envelope.manifest.baseline) ===
          canonicalContentJson(manifest.baseline) &&
        publication.revision.document.recipe.title === manifest.recipe.title &&
        canonicalContentJson(issued.envelope.manifest.entries) ===
          canonicalContentJson([
            {
              state: 'current',
              ref: manifest.recipe.ref,
              publicationFingerprint: publication.publicationFingerprint,
            },
          ]),
      'The issued archive no longer matches the owned fixture manifest.',
    );
    const source = catalogue.getRecipe(manifest.recipe.ref.recipeId);
    const revised = publication.revision.document.recipe;
    demand(
      source &&
        canonicalContentJson(
          revised.ingredients.map(({ position, rawName, rawMeasure }) => ({
            position,
            rawName,
            rawMeasure,
          })),
        ) ===
          canonicalContentJson(
            source.ingredients.map(({ position, rawName, rawMeasure }) => ({
              position,
              rawName,
              rawMeasure,
            })),
          ) &&
        canonicalContentJson(
          revised.instructions.map(({ sequence, rawText, presentation }) => ({
            sequence,
            rawText,
            presentation,
          })),
        ) ===
          canonicalContentJson(
            source.instructions.map(({ sequence, rawText, presentation }) => ({
              sequence,
              rawText,
              presentation,
            })),
          ),
      'The disposable revision must preserve bundled raw ingredients, measures and passages.',
    );
    return delivery;
  } catch (error) {
    await delivery.close();
    throw error;
  }
}

export async function serveOrdinaryBrowserFixture(input: string, exportedDirectory: string) {
  const manifest = await readOrdinaryBrowserFixture(input),
    expectedWebRoot = join(manifest.directory, 'web');
  demand(
    isAbsolute(exportedDirectory) && samePath(resolve(exportedDirectory), expectedWebRoot),
    "Export only to this fixture's separate web directory.",
  );
  const delivery = await openOrdinaryBrowserDelivery(manifest);
  let app: ReturnType<typeof buildConsumerReviewServer>;
  try {
    app = buildConsumerReviewServer({
      origin: manifest.config.origin,
      webRoot: expectedWebRoot,
      delivery,
    });
  } catch (error) {
    await delivery.close();
    throw error;
  }
  try {
    await app.listen({
      host: '127.0.0.1',
      port: Number(consumerOrigin(manifest.config.origin).port),
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  function close() {
    if (!closing) {
      clearTimeout(expiry);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      closing = app.close();
    }
    return closing;
  }
  const stop = () => {
    void close().catch(() => {
      process.exitCode = 1;
      process.stderr.write(
        'Disposable consumer cleanup could not finish. Fixture files were retained.\n',
      );
    });
  };
  const expiry = setTimeout(stop, maximumLifetimeMs);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { manifest, close, expiresAt: new Date(Date.now() + maximumLifetimeMs).toISOString() };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    (args.length === 3 || (args.length === 4 && args[3] === '--with-translation')) &&
    args[0] === '--prepare' &&
    args[1] === '--origin'
  ) {
    const manifest = await prepareOrdinaryBrowserFixture(
      args[2]!,
      args[3] === '--with-translation',
    );
    process.stdout.write(
      JSON.stringify({
        kind: 'prepared_disposable_fixture',
        fixtureRoot: manifest.directory,
        manifest: join(manifest.directory, manifestName),
        publicConfig: join(manifest.directory, configurationName),
        webRoot: join(manifest.directory, 'web'),
        origin: manifest.config.origin,
        installationId: manifest.config.installationId,
        releaseId: manifest.config.releaseId,
        baseline: manifest.baseline,
        issuedHead: manifest.issuedHead,
        recipe: manifest.recipe,
        adopted: false,
        filesRetained: true,
      }) + '\n',
    );
    return;
  }
  if (args.length === 4 && args[0] === '--serve' && args[2] === '--web-root') {
    const active = await serveOrdinaryBrowserFixture(args[1]!, args[3]!);
    process.stdout.write(
      JSON.stringify({
        kind: 'serving_disposable_consumer',
        origin: active.manifest.config.origin,
        fixtureRoot: active.manifest.directory,
        webRoot: join(active.manifest.directory, 'web'),
        installationId: active.manifest.config.installationId,
        releaseId: active.manifest.config.releaseId,
        expiresAt: active.expiresAt,
        filesRetained: true,
      }) + '\n',
    );
    return;
  }
  throw new FixtureError(
    'Use --prepare --origin http://127.0.0.1:PORT [--with-translation] or --serve ABSOLUTE_FIXTURE_ROOT --web-root ABSOLUTE_FIXTURE_ROOT/web.',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.exitCode = 1;
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{1,59}$/.test(error.code)
        ? ` (${error.code})`
        : '';
    const reason =
      error instanceof FixtureError
        ? error.message
        : `Local operation failed${code}; check the fixture path, exported index, loopback origin and listener ownership.`;
    process.stderr.write(
      `Disposable ordinary fixture command failed: ${reason} Existing workspaces and retained fixture files were not reset or deleted.\n`,
    );
  }
}
