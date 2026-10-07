import { createAccountRuntime } from './accountRuntime';
import type { AccountSyncState } from '@cookmate/account-sync';
import type { WorkspaceSelection } from './workspaceSelection';
import type { SupabaseAccountAccess } from './supabaseAccess';
import type { LocalAccountSettingsController } from './localAccountSettings';
import type { LocalCookMateServices } from '../../data/localServices';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let mockSyncState: AccountSyncState = { kind: 'local' };
const mockListeners = new Set<() => void>();
const mockSync = jest.fn(async () => { mockSyncState = { kind: 'working' }; mockListeners.forEach(listener => listener()); });
jest.mock('@cookmate/account-sync', () => ({
  createAccountRemote: () => ({}),
  createAccountSyncCoordinator: () => ({
    getSnapshot: () => mockSyncState, sync: mockSync, invalidate: async () => undefined,
    subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
  }),
}));

test('an edit during a slow sync schedules its own save once the current operation settles', async () => {
  jest.useFakeTimers(); mockListeners.clear(); mockSync.mockClear(); mockSyncState = { kind: 'local' };
  let changed!: (change: { collections: string[] }) => void;
  const selected = { status: 'ready', manifest: { active: { kind: 'account', ownerId } } };
  const runtime = createAccountRuntime({
    selection: { initialize: async () => selected, recoverPending: async () => selected, getSnapshot: () => selected, activate: async () => selected } as unknown as WorkspaceSelection,
    auth: { readSession: async () => ({ identity: { ownerId, provider: 'google', email: null, displayName: null }, accessToken: 'session.token' }), verifyNativeAccess: async () => undefined, subscribe: () => () => undefined, dispose: async () => undefined } as unknown as SupabaseAccountAccess,
    config: { url: 'https://account.example', serviceEndpoint: 'https://account.example/functions/v1/cookmate-account', publishableKey: 'sb_publishable_test', apple: false, google: true, googleWebClientId: null, googleIosClientId: null },
    metadata: { read: async () => null, write: async () => undefined, remove: async () => undefined },
    newId: () => ownerId, fetch: jest.fn(), guestPreferences: { read: async () => null, write: async () => undefined },
    settings: () => ({ hydrate: async () => undefined, getSnapshot: () => ({ kind: 'ready' }) }) as unknown as LocalAccountSettingsController,
    drainSettings: async () => undefined,
    open: async () => ({ kind: 'ready', services: { accountReplication: {}, queries: { subscribe: (listener: typeof changed) => { changed = listener; return () => undefined; } }, close: async () => undefined } as unknown as LocalCookMateServices }),
  });
  await runtime.initialize();
  const opened = await runtime.opener(runtime.getSnapshot().workspace)();
  if (opened.kind !== 'ready') throw new Error('Fixture did not open');
  await Promise.resolve(); expect(mockSync).toHaveBeenCalledTimes(1);
  changed({ collections: ['plan'] });
  await jest.advanceTimersByTimeAsync(3000);
  expect(mockSync).toHaveBeenCalledTimes(1);
  mockSyncState = { kind: 'local' }; mockListeners.forEach(listener => listener());
  await jest.advanceTimersByTimeAsync(2000);
  expect(mockSync).toHaveBeenCalledTimes(2);
  await opened.services.close(); await runtime.dispose();
  jest.useRealTimers();
});
