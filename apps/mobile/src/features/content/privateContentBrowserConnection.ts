import type { SqlConnection } from '../../data/sql';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  PrivateContentConfigurationError,
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
} from './privateContentConfig';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve only this installation's two logical review names to approved browser files.
 * Expo's web VFS has a 64-byte path limit including './' and journal suffixes.
 * Full UUIDs remain distinct; logical markers and native database names are unchanged.
 */
export function createPrivateContentBrowserConnection(
  installationId: string,
  openPhysical: (name: string) => Promise<SqlConnection>,
): (logicalName: string) => Promise<SqlConnection> {
  if (!uuidV4.test(installationId)) throw new PrivateContentConfigurationError();
  const logical = privateContentDatabaseNames(installationId);
  return async (name) => {
    const physical =
      name === logical.cooking
        ? `cmr-${installationId}-c.db`
        : name === logical.content
          ? `cmr-${installationId}-r.db`
          : null;
    if (physical === null) throw new PrivateContentConfigurationError();
    return openPhysical(physical);
  };
}

function base64urlDigest(hex: string) {
  if (typeof hex !== 'string' || hex.length !== 64 || !/^[0-9a-f]{64}$/.test(hex))
    throw new PrivateContentConfigurationError();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let bits = 0,
    count = 0,
    encoded = '';
  for (let index = 0; index < hex.length; index += 2) {
    bits = (bits << 8) | parseInt(hex.slice(index, index + 2), 16);
    count += 8;
    while (count >= 6) {
      count -= 6;
      encoded += alphabet[(bits >>> count) & 63];
    }
  }
  if (count) encoded += alphabet[(bits << (6 - count)) & 63];
  return encoded;
}

/** Account preparation/opening may address only this owner and the same installation's guest/cache.
 * The full digest includes both identities; it is not a truncated UUID or a new installation ID.
 */
export async function privateContentAccountBrowserName(
  installationId: string,
  ownerId: string,
  sha256: (text: string) => Promise<string>,
) {
  privateContentAccountDatabaseName(installationId, ownerId);
  const digest = await sha256(
    canonicalContentJson(['content-account-cooking', installationId, ownerId]),
  );
  return `cma-${base64urlDigest(digest)}.db`;
}

export function createPrivateContentAccountBrowserConnection(
  installationId: string,
  ownerId: string,
  sha256: (text: string) => Promise<string>,
  openPhysical: (name: string) => Promise<SqlConnection>,
) {
  const account = privateContentAccountDatabaseName(installationId, ownerId);
  const openGuestOrCache = createPrivateContentBrowserConnection(installationId, openPhysical);
  let physical: Promise<string> | undefined;
  return async (logicalName: string) => {
    if (logicalName !== account) return openGuestOrCache(logicalName);
    physical ??= privateContentAccountBrowserName(installationId, ownerId, sha256);
    return openPhysical(await physical);
  };
}
