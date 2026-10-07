import type { AccountReplicationRepository } from '@cookmate/account-sync';
import type { CookMateServices, StoreInitializationResult } from '@cookmate/domain';
import type { AccountScopeApprovalService } from './accountScopeApproval';

/** Account transport is an app concern; the cooking domain does not depend on it. */
export type LocalCookMateServices = CookMateServices & {
  accountReplication?: AccountReplicationRepository;
  accountScopeApproval?: AccountScopeApprovalService;
};
export type LocalStoreInitializationResult =
  | { kind: 'ready'; services: LocalCookMateServices; initialization?: 'created' | 'existing' }
  | Extract<StoreInitializationResult, { kind: 'failed' }>;
