import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  parseAccountSnapshot,
  type AccountSnapshot,
} from '@cookmate/account-sync';
import { normalizeAccountContentSnapshot } from '../../../packages/account-sync/src/contentSnapshot';
import { canonicalPortableContentJson } from '../../../packages/domain/src/portableBackupContent';
import { record } from './protocol';

export type AccountServiceSnapshot =
  | AccountSnapshot
  | ReturnType<typeof normalizeAccountContentSnapshot>;

/** Storage validation only: exact references are data, never publication or client consent proof. */
export function parseAccountServiceSnapshot(
  input: unknown,
  enableContentSnapshots = false,
): AccountServiceSnapshot {
  // Own bounded inert values before either codec inspects them. Legacy arrays/values stay unchanged.
  const serialized = canonicalPortableContentJson(input, ACCOUNT_SNAPSHOT_MAX_BYTES);
  const value: unknown = JSON.parse(serialized);
  if (enableContentSnapshots && record(value) && value.schemaVersion === 3)
    return normalizeAccountContentSnapshot(value);
  return parseAccountSnapshot(serialized);
}
