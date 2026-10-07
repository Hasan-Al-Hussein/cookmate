import { isAppId } from '../../data/conversationRecords';
import { createOwnedLocalControllers } from '../private-local/ownedLocalControllers';
import {
  createRecentlyViewedController,
  type RecentlyViewedOptions,
  type RecentlyViewedStore,
} from './recentlyViewed';

export function bundledRecentlyViewedKey(ownerId: string | null): string {
  if (ownerId !== null && (!isAppId(ownerId) || ownerId.length !== 36))
    throw new Error('Invalid recently viewed owner');
  return `cookmate.recently-viewed.${ownerId === null ? 'guest' : `account.${ownerId}`}`;
}

export function createRecentlyViewedOwners(
  storeForOwner: (ownerId: string | null) => RecentlyViewedStore,
  isCurrent: (ownerId: string | null) => boolean,
  options: RecentlyViewedOptions = {},
) {
  const now = options.now;
  return createOwnedLocalControllers(
    storeForOwner,
    isCurrent,
    (store) => createRecentlyViewedController(store, now ? { now } : {}),
    {
      changed: 'Recently viewed workspace changed',
      removing: 'Recently viewed is already being removed',
    },
  );
}
