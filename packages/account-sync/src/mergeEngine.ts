import type {
  AccountConflictKind,
  AccountConflictValue,
  AccountMergeConflict,
  AccountMergeInput,
} from './types';
import { AccountSnapshotError } from './types';
import { canonicalJson } from './validation';
export const equal = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);
export const stableMetadata = <T>(left: T, right: T): T =>
  canonicalJson(left) <= canonicalJson(right) ? left : right;
export interface Merger {
  conflicts: AccountMergeConflict[];
  choose<T extends AccountConflictValue>(
    kind: AccountConflictKind,
    path: string,
    base: T,
    local: T,
    account: T,
  ): T;
  finish(): void;
}
export function createMerger(input: Pick<AccountMergeInput, 'resolutions'>): Merger {
  const conflicts: AccountMergeConflict[] = [];
  const used = new Set<string>();
  const resolutions = input.resolutions ?? {};
  if (
    resolutions === null ||
    typeof resolutions !== 'object' ||
    Array.isArray(resolutions) ||
    Object.values(resolutions).some((value) => value !== 'local' && value !== 'account')
  )
    throw new AccountSnapshotError('invalid_resolution');
  return {
    conflicts,
    choose(kind, path, base, local, account) {
      const id = canonicalJson([kind, path, base, local, account]);
      const conflict = { id, kind, path, base, local, account };
      if (Object.hasOwn(resolutions, id)) {
        if (used.has(id)) throw new AccountSnapshotError('invalid_resolution');
        used.add(id);
        return resolutions[id] === 'local' ? local : account;
      }
      conflicts.push(conflict);
      // This is only an internal provisional value; unresolved results expose no snapshot.
      return base;
    },
    finish() {
      if (Object.keys(resolutions).some((id) => !used.has(id)))
        throw new AccountSnapshotError('invalid_resolution');
    },
  };
}

export function mergeRows<T extends AccountConflictValue>(
  base: readonly T[],
  local: readonly T[],
  account: readonly T[],
  key: (item: T) => string,
  kind: AccountConflictKind,
  path: string,
  merger: Merger,
  equivalent: (left: T | null, right: T | null) => boolean = equal,
  deleted?: (item: T) => boolean,
  reviewRemovals = false,
): T[] {
  const maps = [base, local, account].map(
    (items) => new Map(items.map((item) => [key(item), item])),
  );
  const ids = [...new Set([...base, ...local, ...account].map(key))].sort();
  const merged: T[] = [];
  for (const id of ids) {
    const before = maps[0]!.get(id) ?? null;
    const device = maps[1]!.get(id) ?? null;
    const server = maps[2]!.get(id) ?? null;
    let chosen: T | null;
    const removalAgainstLive =
      device !== null &&
      server !== null &&
      deleted !== undefined &&
      deleted(device) !== deleted(server);
    if (reviewRemovals && removalAgainstLive)
      chosen = merger.choose('delete_edit', `${path}/${id}`, before, device, server) as T | null;
    else if (equivalent(device, server))
      chosen = device && server ? stableMetadata(device, server) : device;
    else if (equivalent(device, before)) chosen = server;
    else if (equivalent(server, before)) chosen = device;
    else
      chosen = merger.choose(
        before !== null && (device === null || server === null || removalAgainstLive)
          ? 'delete_edit'
          : kind,
        `${path}/${id}`,
        before,
        device,
        server,
      ) as T | null;
    if (chosen !== null) merged.push(chosen);
  }
  return merged;
}
