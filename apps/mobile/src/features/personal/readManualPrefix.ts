import type {
  Immutable,
  ManualShoppingPage,
  PersonalService,
  RepositoryResult,
} from '@cookmate/domain';
import { personalLimits } from '@cookmate/domain';
/** Preserve the already revealed stable prefix after a change; never mix stale cursor pages. */
export async function readManualPrefix(
  service: Pick<PersonalService, 'readManualShopping'>,
  revealedCount: number,
): Promise<RepositoryResult<Immutable<ManualShoppingPage>>> {
  const wanted = Math.min(
    personalLimits.manualItems,
    Math.max(20, Number.isFinite(revealedCount) ? Math.floor(revealedCount) : 20),
  );
  let result = await service.readManualShopping({ limit: Math.min(50, wanted) });
  if (result.kind !== 'ready') return result;
  let rows = [...result.value.items];
  const seenCursors = new Set<string>();
  while (rows.length < wanted && result.value.nextCursor) {
    if (seenCursors.has(result.value.nextCursor))
      return {
        kind: 'failed',
        error: {
          code: 'storage_failure',
          messageKey: 'personal.pagination_changed',
          retry: 'after_correction',
        },
      };
    seenCursors.add(result.value.nextCursor);
    const next = await service.readManualShopping({
      cursor: result.value.nextCursor,
      limit: Math.min(50, wanted - rows.length),
    });
    if (next.kind !== 'ready') return next;
    if (
      next.value.epoch !== result.value.epoch ||
      next.value.items.some((item) => rows.some((row) => row.itemId === item.itemId))
    )
      return {
        kind: 'failed',
        error: {
          code: 'storage_failure',
          messageKey: 'personal.pagination_changed',
          retry: 'after_correction',
        },
      };
    rows = [...rows, ...next.value.items];
    result = next;
  }
  return { ...result, value: { ...result.value, items: rows } };
}
