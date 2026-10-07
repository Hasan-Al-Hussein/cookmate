export type AccountProviderName = 'apple' | 'google';
export interface AccountIdentity {
  ownerId: string;
  displayName: string | null;
  email: string | null;
  provider: AccountProviderName | null;
}
export type AccountAuthFailure =
  | 'not_configured'
  | 'unsupported'
  | 'cancelled'
  | 'network'
  | 'provider'
  | 'session_expired'
  | 'storage'
  | 'account_changed';
export class AccountAuthError extends Error {
  constructor(readonly reason: AccountAuthFailure) {
    super(`Account access: ${reason}`);
  }
}
