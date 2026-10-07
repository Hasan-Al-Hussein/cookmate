import { emptyAccountSnapshot, type AccountPlanOccurrence } from '@cookmate/account-sync';
import type { AccountContentSnapshot } from '../../../packages/account-sync/src/contentSnapshot';

/** Synthetic data-only wire fixture. No signatures, publication or owner consent are asserted. */
export function contentSnapshotFixture(): AccountContentSnapshot {
  const at = '2026-10-01T12:00:00.000Z';
  const occurrenceId = '40000000-0000-4000-8000-000000000001';
  const contentRef = {
    recipeId: '52819',
    revisionId: 'fixture-exact-1',
    contentFingerprint: 'b'.repeat(64),
  };
  return {
    ...emptyAccountSnapshot(
      { version: 'fixture-v1', fingerprint: 'a'.repeat(64) },
      {
        appPreferences: { theme: 'dark', motion: 'reduced', locale: 'en' },
        profile: { displayName: '  Original profile  ' },
      },
    ),
    schemaVersion: 3,
    plan: [
      {
        occurrenceId,
        recipeId: contentRef.recipeId,
        placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
        createdAt: at,
        updatedAt: at,
      },
    ],
    planReferences: [{ occurrenceId, contentRef }],
    personal: {
      notes: [
        {
          noteId: '50000000-0000-4000-8000-000000000001',
          recipeId: contentRef.recipeId,
          text: '  Private original\n量 🍲  ',
          deleted: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
      collections: [],
      memberships: [],
      manualItems: [
        {
          kind: 'manual',
          itemId: '60000000-0000-4000-8000-000000000001',
          name: null,
          amountText: null,
          unitText: null,
          category: null,
          purchased: false,
          deleted: true,
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
    cookingHistory: {
      entries: [
        {
          kind: 'exact',
          entry: {
            readerVersion: 2,
            eventId: '70000000-0000-4000-8000-000000000001',
            recipeId: contentRef.recipeId,
            contentRef,
            recipeTitle: 'Synthetic exact recipe',
            photoAssetId: `sha256:${'c'.repeat(64)}`,
            cookedOn: '2026-10-01',
            timeZone: 'Asia/Dubai',
            recordedAt: at,
            note: '  Original history  ',
          },
        },
      ],
      removedEventIds: ['70000000-0000-4000-8000-000000000002'],
    },
  };
}

/** Whole valid row shapes near a requested byte size; caller tests the aggregate wire cap. */
export function largeContentSnapshot(targetBytes: number): AccountContentSnapshot {
  const value = contentSnapshotFixture();
  value.plan = [];
  value.planReferences = [];
  const occurrence = (index: number): AccountPlanOccurrence => ({
    occurrenceId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    recipeId: '52819',
    placement: {
      actualDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      mealKey: 'dinner',
    },
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  });
  const reference = (row: AccountPlanOccurrence) => ({
    occurrenceId: row.occurrenceId,
    contentRef: {
      recipeId: row.recipeId,
      revisionId: 'fixture-exact-1',
      contentFingerprint: 'b'.repeat(64),
    },
  });
  const emptyBytes = Buffer.byteLength(JSON.stringify(value));
  const pairBytes =
    Buffer.byteLength(JSON.stringify(occurrence(0))) +
    Buffer.byteLength(JSON.stringify(reference(occurrence(0)))) +
    2;
  const count = Math.floor((targetBytes - emptyBytes) / pairBytes);
  value.plan = Array.from({ length: count }, (_, index) => occurrence(index));
  value.planReferences = value.plan.map(reference);
  return value;
}
