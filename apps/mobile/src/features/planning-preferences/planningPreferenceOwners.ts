import { isAppId } from '../../data/conversationRecords';
import { createOwnedLocalControllers } from '../private-local/ownedLocalControllers';
import {
  createPlanningPreferencesController,
  type PlanningPreferencesStore,
} from './planningPreferences';

export function bundledPlanningPreferenceKey(ownerId: string | null): string {
  if (ownerId !== null && (!isAppId(ownerId) || ownerId.length !== 36))
    throw new Error('Invalid planning preference owner');
  return `cookmate.planning-preferences.${ownerId === null ? 'guest' : `account.${ownerId}`}`;
}

/** Local preferences have their own lifetime; they are deliberately outside account sync.
 * Retirement fences queued saves before account removal. The next owner waits for earlier
 * writes, including a quick return to the same owner, before hydrating its saved record.
 */
export function createPlanningPreferenceOwners(
  storeForOwner: (ownerId: string | null) => PlanningPreferencesStore,
  isCurrent: (ownerId: string | null) => boolean,
) {
  return createOwnedLocalControllers(
    storeForOwner,
    isCurrent,
    createPlanningPreferencesController,
    {
      changed: 'Planning workspace changed',
      removing: 'Planning preferences are already being removed',
    },
  );
}
