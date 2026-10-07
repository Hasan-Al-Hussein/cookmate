import { createNativeAccountRuntime } from './nativeAccountRuntime';

const mockValues = new Map<string, string>();
let mockWrite: Promise<void>;
let mockWriteStarted: () => void;
const mockDispose = jest.fn(async () => {
  throw new Error('Database close failed');
});
const mockStop = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../../data/nativeStore', () => ({ openCookMateStore: jest.fn() }));
jest.mock('./authConfig', () => ({ readAccountAuthConfig: () => null }));
jest.mock('./nativeAuth', () => ({ nativeAuthAvailability: jest.fn() }));
jest.mock('./supabaseAccess', () => ({ createSupabaseAccountAccess: jest.fn() }));
jest.mock('./credentialStorage', () => ({ accountCredentialStorage: {} }));
jest.mock('./workspaceDatabases', () => ({
  createWorkspaceDatabaseAdapter: () => ({}),
  verifyAccountWorkspace: jest.fn(),
}));
jest.mock('./workspaceSelection', () => ({
  createWorkspaceSelection: () => ({}),
  WORKSPACE_MANIFEST_STORAGE_KEY: 'fixture.manifest',
}));
jest.mock('./firstRunWelcome', () => ({
  createFirstRunWelcome: async () => ({}),
  WELCOME_DECISION_KEY: 'fixture.welcome',
}));
jest.mock('./deletionRecovery', () => ({
  createDeletionRecoveryJournal: () => ({}),
  createDeletionRecoveryTransport: jest.fn(),
}));
jest.mock('../app-preferences/preferenceStorage', () => ({ appPreferencesStore: {} }));
jest.mock('./localAccountStorage', () => ({
  localAccountStorage: {
    read: async (key: string) => mockValues.get(key) ?? null,
    write: async (key: string, text: string) => {
      mockWriteStarted();
      await mockWrite;
      mockValues.set(key, text);
    },
    remove: async (key: string) => {
      mockValues.delete(key);
    },
  },
}));
jest.mock('./accountRuntime', () => ({
  createAccountRuntime: () => ({
    getSnapshot: () => ({ workspace: { kind: 'guest' }, workspaceKey: 'guest', identity: null }),
    subscribe: () => mockStop,
    closed: false,
    dispose: mockDispose,
  }),
}));

beforeEach(() => {
  mockValues.clear();
  mockDispose.mockClear();
  mockStop.mockClear();
});

test.each(['planning', 'recent'] as const)(
  'a rejected database close still waits for an already-started %s write, with one owned disposal',
  async (kind) => {
    let release!: () => void;
    mockWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      mockWriteStarted = resolve;
    });
    const root = await createNativeAccountRuntime();
    const preferences = kind === 'planning' ? root.planningPreferences() : root.recentlyViewed();
    await preferences.hydrate();
    const save =
      'setPreference' in preferences
        ? preferences.setPreference('weekStart', 'sunday')
        : preferences.setEnabled(true);
    await started;
    const closing = root.runtime.dispose();
    expect(root.runtime.dispose()).toBe(closing);
    let closed = false;
    const observed = closing.catch((error: unknown) => {
      closed = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(() => root.planningPreferences()).toThrow('Planning workspace changed');
    expect(() => root.recentlyViewed()).toThrow();
    release();
    expect(await save).toBe(false);
    const failure = await observed;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([expect.any(Error)]);
    expect(closed).toBe(true);
    expect(mockValues.size).toBe(1);
    const snapshot = preferences.getSnapshot();
    if ('preferences' in snapshot) expect(snapshot.preferences.weekStart).toBe('monday');
    else expect(snapshot.enabled).toBe(false);
  },
);
