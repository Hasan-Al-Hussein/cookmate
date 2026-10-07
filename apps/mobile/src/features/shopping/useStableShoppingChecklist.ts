import { useLayoutEffect, useMemo, useState } from 'react';
import type { Immutable, ManualShoppingItem, ShoppingGroup } from '@cookmate/domain';
import { shoppingChecklist, type ChecklistRow, type ShoppingFilter } from './shoppingChecklist';

type Session = {
  owner: unknown;
  manualEpoch: number | null;
  filter: ShoppingFilter;
  search: string;
  retained: ReadonlyMap<string, string>;
};

const identity = (row: ChecklistRow) =>
  row.kind === 'recipe' ? row.group.demandFingerprint : row.item.createdAt;

/** Keeps touched row identities, never cached purchase values, during one filter/search session. */
export function useStableShoppingChecklist({
  groups,
  manual,
  owner,
  manualEpoch,
  filter,
  search,
}: {
  groups: readonly Immutable<ShoppingGroup>[];
  manual: readonly Immutable<ManualShoppingItem>[];
  owner: unknown;
  manualEpoch: number | null;
  filter: ShoppingFilter;
  search: string;
}) {
  const [session, setSession] = useState<Session>({
    owner,
    manualEpoch,
    filter,
    search,
    retained: new Map(),
  });
  const candidates = useMemo(
    () => shoppingChecklist(groups, manual, 'all', search),
    [groups, manual, search],
  );
  const byKey = useMemo(() => new Map(candidates.map((row) => [row.key, row])), [candidates]);
  const sameScope = (previous: Session) =>
    previous.owner === owner && previous.filter === filter && previous.search === search;
  function validRetention(previous: Session) {
    if (!sameScope(previous)) return new Map<string, string>();
    return new Map(
      [...previous.retained].filter(([key, fingerprint]) => {
        const row = byKey.get(key);
        return (
          !!row &&
          identity(row) === fingerprint &&
          (row.kind === 'recipe' || previous.manualEpoch === manualEpoch)
        );
      }),
    );
  }
  const retained = validRetention(session);
  useLayoutEffect(() => {
    // Drop invalid identities now, so a later re-add cannot revive a previous exception.
    if (
      session.retained.size > 0 &&
      (!sameScope(session) ||
        session.manualEpoch !== manualEpoch ||
        retained.size !== session.retained.size)
    )
      setSession({ owner, manualEpoch, filter, search, retained });
  });
  const rows = shoppingChecklist(groups, manual, filter, search, new Set(retained.keys()));
  const retainedCount =
    filter === 'all'
      ? 0
      : rows.filter(
          (row) =>
            (row.kind === 'recipe' ? row.group.purchased : row.item.purchased) !==
            (filter === 'purchased'),
        ).length;
  return {
    rows,
    retainedCount,
    retain(row: ChecklistRow) {
      if (filter === 'all') return;
      const current = byKey.get(row.key);
      if (!current || identity(current) !== identity(row)) return;
      setSession((previous) => {
        const next = validRetention(previous);
        next.set(row.key, identity(current));
        return { owner, manualEpoch, filter, search, retained: next };
      });
    },
    reset() {
      setSession({ owner, manualEpoch, filter, search, retained: new Map() });
    },
  };
}
