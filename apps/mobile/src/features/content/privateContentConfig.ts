import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  createContentTrustVerifier,
  type ContentTrustKey,
} from '@cookmate/catalogue/content-trust';
import { isAppId } from '../../data/conversationRecords';

export interface PrivateContentConfiguration {
  version: 1;
  origin: string;
  installationId: string;
  releaseId: string;
  trustKeys: readonly Readonly<ContentTrustKey>[];
}
export class PrivateContentConfigurationError extends Error {
  constructor() {
    super('Private recipe review is not configured for this browser origin.');
    this.name = 'PrivateContentConfigurationError';
  }
}
export function isPrivateContentPath(path: string) {
  return path === '/private-content' || path.startsWith('/private-content/');
}

/** Build/operator configuration only. Never call this with query parameters or release payloads. */
export function readPrivateContentConfiguration(
  input: unknown,
  actualOrigin: string,
): Readonly<PrivateContentConfiguration> | null {
  if (input === undefined || input === null || input === '') return null;
  try {
    if (typeof input !== 'string' || input.length > 10_240) throw new Error();
    const value: unknown = JSON.parse(input);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const config = value as PrivateContentConfiguration;
    if (
      Object.keys(config).sort().join(',') !==
        'installationId,origin,releaseId,trustKeys,version' ||
      config.version !== 1 ||
      !isAppId(config.installationId) ||
      typeof config.origin !== 'string' ||
      typeof config.releaseId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(config.releaseId)
    )
      throw new Error();
    const url = new URL(config.origin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.origin !== actualOrigin ||
      config.origin !== url.origin ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    )
      throw new Error();
    if (
      !Array.isArray(config.trustKeys) ||
      config.trustKeys.some(
        (key) =>
          !key ||
          typeof key !== 'object' ||
          Array.isArray(key) ||
          Object.keys(key).sort().join(',') !== 'keyId,publicKeyHex',
      )
    )
      throw new Error();
    createContentTrustVerifier(config.trustKeys);
    // Retain an immutable independent copy, never a live caller object.
    return Object.freeze({
      ...config,
      trustKeys: Object.freeze(config.trustKeys.map((key) => Object.freeze({ ...key }))),
    });
  } catch {
    throw new PrivateContentConfigurationError();
  }
}

export function ownPrivateContentConfiguration(config: Readonly<PrivateContentConfiguration>) {
  return readPrivateContentConfiguration(canonicalContentJson(config, 10_240), config.origin)!;
}

/** No arbitrary database path or ordinary guest/account database can enter this route. */
export function privateContentDatabaseNames(installationId: string) {
  if (!isAppId(installationId)) throw new PrivateContentConfigurationError();
  return Object.freeze({
    cooking: `cookmate-review-${installationId}-cooking.db`,
    content: `cookmate-review-${installationId}-content.db`,
  });
}

/** Trusted lifecycle input only; never accepts a filename from a route or release. */
export function privateContentAccountDatabaseName(installationId: string, ownerId: string) {
  if (!isAppId(installationId) || !isAppId(ownerId)) throw new PrivateContentConfigurationError();
  return `cookmate-review-${installationId}-account-${ownerId}.db`;
}
