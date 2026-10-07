import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  emptyAccountSnapshot,
  parseAccountSnapshot,
} from '@cookmate/account-sync';
import type { AccountPlanOccurrence } from '@cookmate/account-sync';

/** Full valid domain payload, within 1 KiB plus one occurrence of the wire boundary. */
export function largeSnapshot() {
  const snapshot = emptyAccountSnapshot(
    { version: 'test-large-v1', fingerprint: 'a'.repeat(64) },
    {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    },
  );
  const occurrence = (index: number): AccountPlanOccurrence => ({
    occurrenceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    recipeId: '52819',
    placement: {
      actualDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      mealKey: 'dinner',
    },
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  const emptyBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const entryBytes = Buffer.byteLength(JSON.stringify(occurrence(0))) + 1;
  const count = Math.floor((ACCOUNT_SNAPSHOT_MAX_BYTES - 1024 - emptyBytes) / entryBytes);
  snapshot.plan = Array.from({ length: count }, (_, index) => occurrence(index));
  return parseAccountSnapshot(JSON.stringify(snapshot));
}
