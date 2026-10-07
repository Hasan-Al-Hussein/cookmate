import { emptyAccountSnapshot } from '../src/index';
import type {
  AccountPlanOccurrence,
  AccountPreference,
  AccountPurchaseMark,
  AccountSnapshot,
} from '../src/index';

export const timestamp = '2026-09-30T08:00:00.000Z';
export const later = '2026-09-30T09:00:00.000Z';
export const catalogue = { version: 'test-catalogue', fingerprint: 'a'.repeat(64) };
export const options = {
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
} as const;
export const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const snapshot = () => emptyAccountSnapshot(catalogue, options);
export const clone = (value: AccountSnapshot): AccountSnapshot => JSON.parse(JSON.stringify(value));
export function occurrence(
  value: number,
  recipeId = '52819',
  actualDate = '2026-09-30',
): AccountPlanOccurrence {
  return {
    occurrenceId: id(value),
    recipeId,
    placement: { actualDate, mealKey: 'dinner' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
export function preference(value: number, text = 'Italian'): AccountPreference {
  return { preferenceId: id(value), type: 'cuisine', value: text };
}
export function purchase(purchased = false): AccountPurchaseMark {
  return {
    groupKey: 'b'.repeat(64),
    groupingVersion: 'test-quantity-v1',
    demandFingerprint: 'c'.repeat(64),
    purchased,
    changed: false,
  };
}
