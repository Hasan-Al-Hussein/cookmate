import { fail, uuid } from './accountReplicationRecords';

export const ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX =
  'account-replication:legacy-content-transition:';

export function accountLegacyContentTransitionKey(ownerId: string) {
  if (!uuid(ownerId)) fail('invalid_input');
  return `${ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX}${ownerId}`;
}
