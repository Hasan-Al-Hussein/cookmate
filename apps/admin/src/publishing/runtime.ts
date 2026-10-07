import type { KeyObject } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  createContentTrustVerifier,
  type ContentTrustKey,
} from '@cookmate/catalogue/content-trust';
import { AdminFault } from '../auth/errors';
import type { AdminDatabase } from '../storage/database';
import type { AdminMedia } from '../media/service';
import { PreparedPublicationArchive } from './archive';
import { ContentOverlayIssuer } from './issuance';
import { IssuedOverlayStore } from './issuedStore';
import { createContentOverlaySigner } from './signer';

export interface AdminPublicationConfiguration {
  issuedDatabaseFile: string;
  signingKeyId: string;
  signingPrivateKey: string | KeyObject;
  /** Independently provisioned trust. Never populated from the signer or a downloaded envelope. */
  trustedKeys: readonly ContentTrustKey[];
}
const configurationLimit = 16 * 1024;
const samePath = (left: string, right: string) => {
  const a = resolve(left),
    b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
function configured(condition: unknown): asserts condition {
  if (!condition) configurationError();
}
function configurationError(): never {
  throw new AdminFault(
    500,
    'publication_configuration',
    'Private publication configuration is unavailable or invalid.',
  );
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function checkedSigner(config: AdminPublicationConfiguration) {
  try {
    configured(
      exact(config, ['issuedDatabaseFile', 'signingKeyId', 'signingPrivateKey', 'trustedKeys']),
    );
    configured(
      typeof config.issuedDatabaseFile === 'string' && isAbsolute(config.issuedDatabaseFile),
    );
    configured(
      Buffer.byteLength(config.issuedDatabaseFile) <= 4096 &&
        !config.issuedDatabaseFile.includes('\0'),
    );
    configured(
      typeof config.signingKeyId === 'string' &&
        config.signingKeyId.length > 0 &&
        config.signingKeyId.length <= 120 &&
        /^[A-Za-z0-9]/.test(config.signingKeyId) &&
        !/[^A-Za-z0-9._:-]/.test(config.signingKeyId),
    );
    configured(
      typeof config.signingPrivateKey !== 'string' ||
        Buffer.byteLength(config.signingPrivateKey) <= configurationLimit,
    );
    const keys: unknown = JSON.parse(canonicalContentJson(config.trustedKeys, configurationLimit));
    configured(
      Array.isArray(keys) &&
        keys.length >= 1 &&
        keys.length <= 32 &&
        keys.every(
          (key) =>
            exact(key, ['keyId', 'publicKeyHex']) &&
            typeof key.keyId === 'string' &&
            key.keyId.length <= 120 &&
            !/[^A-Za-z0-9._:-]/.test(key.keyId) &&
            typeof key.publicKeyHex === 'string' &&
            key.publicKeyHex.length === 64,
        ),
    );
    const trustVerifier = createContentTrustVerifier(keys as ContentTrustKey[]);
    const signer = createContentOverlaySigner({
      keyId: config.signingKeyId,
      privateKey: config.signingPrivateKey,
    });
    // Matching an independently supplied key is a configuration check, not self-issued trust.
    configured(
      (keys as ContentTrustKey[]).some(
        (key) =>
          key.keyId === signer.trustKey.keyId && key.publicKeyHex === signer.trustKey.publicKeyHex,
      ),
    );
    return { signer, trustVerifier };
  } catch {
    return configurationError();
  }
}

export function createAdminPublicationRuntime(options: {
  configuration: AdminPublicationConfiguration;
  adminDatabaseFile: string;
  db: AdminDatabase;
  media: Pick<AdminMedia, 'asset' | 'baseline'>;
  now(): Date;
}) {
  const config = options.configuration;
  const { signer, trustVerifier } = checkedSigner(config);
  configured(
    !['', '-wal', '-shm', '-journal'].some((suffix) =>
      samePath(config.issuedDatabaseFile, options.adminDatabaseFile + suffix),
    ),
  );
  // Reject aliases to an existing admin database before opening the separate issuance journal.
  try {
    const parent = lstatSync(dirname(config.issuedDatabaseFile));
    configured(parent.isDirectory() && !parent.isSymbolicLink());
    const issued = lstatSync(config.issuedDatabaseFile);
    const admin = lstatSync(options.adminDatabaseFile);
    configured(
      issued.isFile() &&
        !issued.isSymbolicLink() &&
        issued.nlink === 1 &&
        !(issued.dev === admin.dev && issued.ino === admin.ino),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') configured(false);
  }
  let issued: IssuedOverlayStore;
  try {
    issued = new IssuedOverlayStore(config.issuedDatabaseFile, trustVerifier);
  } catch {
    return configurationError();
  }
  try {
    const issuer = new ContentOverlayIssuer({
      db: options.db,
      prepared: new PreparedPublicationArchive(options.db, options.media, options.now),
      issued,
      media: options.media,
      signer,
      trustVerifier,
      now: options.now,
    });
    return { issuer, close: () => issued.close() };
  } catch (error) {
    issued.close();
    throw error;
  }
}
export type AdminPublicationRuntime = ReturnType<typeof createAdminPublicationRuntime>;

async function privateText(file: string): Promise<string> {
  const before = await lstat(file);
  configured(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= configurationLimit,
  );
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    configured(
      opened.isFile() &&
        opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size,
    );
    const bytes = Buffer.alloc(configurationLimit + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    configured(result.bytesRead === before.size && result.bytesRead <= configurationLimit);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
}

/** Called by the launcher only for an explicitly supplied private configuration file. */
export async function readAdminPublicationConfiguration(
  directory: string,
  filename?: string,
): Promise<AdminPublicationConfiguration | undefined> {
  if (filename === undefined) return undefined;
  try {
    configured(
      isAbsolute(directory) && isAbsolute(filename) && samePath(dirname(filename), directory),
    );
    const parent = await lstat(directory);
    configured(parent.isDirectory() && !parent.isSymbolicLink());
    const value: unknown = JSON.parse(await privateText(filename));
    configured(
      exact(value, ['schemaVersion', 'keyId', 'privateKeyFile', 'trustedKeys']) &&
        value.schemaVersion === 1,
    );
    configured(
      typeof value.keyId === 'string' &&
        typeof value.privateKeyFile === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.privateKeyFile) &&
        !/[^A-Za-z0-9._-]/.test(value.privateKeyFile),
    );
    configured(!samePath(filename, join(directory, value.privateKeyFile)));
    const config: AdminPublicationConfiguration = {
      issuedDatabaseFile: join(directory, 'issued-content.sqlite'),
      signingKeyId: value.keyId,
      signingPrivateKey: await privateText(join(directory, value.privateKeyFile)),
      trustedKeys: value.trustedKeys as ContentTrustKey[],
    };
    checkedSigner(config);
    return config;
  } catch {
    return configurationError();
  }
}
