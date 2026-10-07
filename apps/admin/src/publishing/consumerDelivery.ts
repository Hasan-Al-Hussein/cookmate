import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  createContentTrustVerifier,
  type ContentTrustKey,
} from '@cookmate/catalogue/content-trust';
import { AdminFault } from '../auth/errors';
import {
  captureIssuedDelivery,
  ISSUED_DELIVERY_LIMITS,
  validateDeliveryIdentity,
  verifyIssuedDelivery,
} from './delivery';

export const CONSUMER_DELIVERY_LIMITS = Object.freeze({
  allowedReleases: ISSUED_DELIVERY_LIMITS.retainedReleases,
  configurationBytes: 64 * 1024,
  concurrentReads: 1,
});
export type ConsumerDeliveryFailure =
  | 'invalid_request'
  | 'not_found'
  | 'too_large'
  | 'busy'
  | 'unavailable';
export class ConsumerDeliveryError extends Error {
  constructor(readonly code: ConsumerDeliveryFailure) {
    super(`Recipe delivery: ${code}`);
    this.name = 'ConsumerDeliveryError';
  }
}
function requireValue(
  value: unknown,
  code: ConsumerDeliveryFailure = 'unavailable',
): asserts value {
  if (!value) throw new ConsumerDeliveryError(code);
}
function failure(error: unknown): ConsumerDeliveryError {
  if (error instanceof ConsumerDeliveryError) return error;
  if (error instanceof AdminFault) {
    if (error.code === 'invalid_delivery_request')
      return new ConsumerDeliveryError('invalid_request');
    if (error.code === 'issued_release_unknown' || error.code === 'issued_media_unknown')
      return new ConsumerDeliveryError('not_found');
    if (error.code === 'release_delivery_limit') return new ConsumerDeliveryError('too_large');
  }
  return new ConsumerDeliveryError('unavailable');
}
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === expected.sort().join(',');
const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export interface ConsumerDeliveryOptions {
  /** Preexisting issuance database only; never an administrator or cooking database. */
  issuedDatabaseFile: string;
  /** Independently provisioned public keys, not keys from a release or signer. */
  trustedKeys: readonly Readonly<ContentTrustKey>[];
  /** Explicit distribution decision. No current/latest alias or automatic publication. */
  allowedReleaseIds: readonly string[];
}

/** Opens no signer, administrator session, draft archive or writable database. */
export function openConsumerContentDelivery(input: ConsumerDeliveryOptions) {
  let sql: DatabaseSync | undefined;
  try {
    // Canonical admission rejects accessors and excessive input before any private file is opened.
    const config: ConsumerDeliveryOptions = JSON.parse(
      canonicalContentJson(input, CONSUMER_DELIVERY_LIMITS.configurationBytes),
    );
    requireValue(
      config &&
        typeof config === 'object' &&
        !Array.isArray(config) &&
        exactKeys(config, ['issuedDatabaseFile', 'trustedKeys', 'allowedReleaseIds']),
    );
    requireValue(
      typeof config.issuedDatabaseFile === 'string' &&
        isAbsolute(config.issuedDatabaseFile) &&
        Buffer.byteLength(config.issuedDatabaseFile) <= 4096 &&
        !config.issuedDatabaseFile.includes('\0'),
    );
    requireValue(
      Array.isArray(config.allowedReleaseIds) &&
        config.allowedReleaseIds.length > 0 &&
        config.allowedReleaseIds.length <= CONSUMER_DELIVERY_LIMITS.allowedReleases,
    );
    const allowed = new Set<string>();
    for (const id of config.allowedReleaseIds) {
      validateDeliveryIdentity(id);
      requireValue(!allowed.has(id));
      allowed.add(id);
    }
    requireValue(
      Array.isArray(config.trustedKeys) &&
        config.trustedKeys.length > 0 &&
        config.trustedKeys.length <= 32,
    );
    for (const key of config.trustedKeys) {
      requireValue(
        key &&
          typeof key === 'object' &&
          !Array.isArray(key) &&
          exactKeys(key, ['keyId', 'publicKeyHex']),
      );
      Object.freeze(key);
    }
    Object.freeze(config.trustedKeys);
    Object.freeze(config.allowedReleaseIds);
    Object.freeze(config);
    const verifier = createContentTrustVerifier(config.trustedKeys);
    const filename = resolve(config.issuedDatabaseFile);
    const before = lstatSync(filename);
    requireValue(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        samePath(realpathSync(filename), filename),
    );
    sql = new DatabaseSync(filename, { readOnly: true, enableForeignKeyConstraints: true });
    const after = lstatSync(filename);
    requireValue(
      after.isFile() &&
        !after.isSymbolicLink() &&
        after.nlink === 1 &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        samePath(realpathSync(filename), filename),
    );
    sql.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    const meta = sql
      .prepare(
        "SELECT COUNT(*) count,MIN(CASE WHEN typeof(version)='integer' AND version=2 THEN 2 END) version,SUM(CASE WHEN typeof(version)='integer' AND version=2 THEN 0 ELSE 1 END) invalid FROM issued_meta WHERE id=1",
      )
      .get();
    requireValue(meta?.count === 1 && meta.version === 2 && meta.invalid === 0);
    const tables = sql
      .prepare(
        "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN ('issued_meta','issued_release','issued_publication','issued_media','issued_operation','issued_cancelled')",
      )
      .get();
    requireValue(tables?.count === 6);
    const connection = sql;
    let busy = false;
    let closing = false;
    let closePromise: Promise<void> | undefined;
    let finishClose: (() => void) | undefined;
    function available() {
      requireValue(!closing);
    }
    async function read<Value>(
      releaseId: string,
      mediaHash: string | undefined,
      project: (value: Awaited<ReturnType<typeof verifyIssuedDelivery>>) => Value,
    ): Promise<Value> {
      available();
      try {
        validateDeliveryIdentity(releaseId, mediaHash);
      } catch (error) {
        throw failure(error);
      }
      requireValue(allowed.has(releaseId), 'not_found');
      requireValue(!busy, 'busy');
      busy = true;
      try {
        const value = await verifyIssuedDelivery(
          captureIssuedDelivery(connection, releaseId, mediaHash),
          verifier,
        );
        available();
        return project(value);
      } catch (error) {
        throw failure(error);
      } finally {
        busy = false;
        finishClose?.();
      }
    }
    return Object.freeze({
      readPackage: (releaseId: string) => read(releaseId, undefined, (value) => value.package),
      readMedia: (releaseId: string, mediaHash: string) =>
        read(releaseId, mediaHash, (value) => {
          requireValue(value.media);
          return Object.freeze({
            descriptor: Object.freeze({ ...value.media.descriptor }),
            bytes: Buffer.from(value.media.bytes),
          });
        }),
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = new Promise<void>((done, reject) => {
          finishClose = () => {
            finishClose = undefined;
            try {
              connection.close();
              done();
            } catch {
              reject(new ConsumerDeliveryError('unavailable'));
            }
          };
        });
        if (!busy) finishClose!();
        return closePromise;
      },
    });
  } catch (error) {
    try {
      sql?.close();
    } catch {
      /* Preserve the generic configuration failure. */
    }
    throw failure(error);
  }
}
export type ConsumerContentDelivery = ReturnType<typeof openConsumerContentDelivery>;
