import { createWorkspaceDatabaseAdapter, verifyAccountWorkspace } from './workspaceDatabases';

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: string[]): unknown;
    all(...values: string[]): unknown[];
    run(...values: string[]): unknown;
  };
  close(): void;
}
const {
  DatabaseSync,
}: { DatabaseSync: new (name: string) => TestDatabase } = require('node:sqlite');
const mockDatabases = new Map<string, TestDatabase>();
const mockBackup = jest.fn();
const mockOpen = jest.fn(async (name: string) => {
  let db = mockDatabases.get(name);
  if (!db) {
    db = new DatabaseSync(':memory:');
    mockDatabases.set(name, db);
  }
  const current = db;
  return {
    db: current,
    closeAsync: jest.fn(async () => undefined),
    getFirstAsync: async (sql: string, ...values: string[]) =>
      current.prepare(sql).get(...values) ?? null,
    getAllAsync: async (sql: string, ...values: string[]) => current.prepare(sql).all(...values),
    runAsync: async (sql: string, ...values: string[]) => current.prepare(sql).run(...values),
  };
});
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...args: Parameters<typeof mockOpen>) => mockOpen(...args),
  backupDatabaseAsync: (...args: unknown[]) => mockBackup(...args),
}));
jest.mock('../workspace/runtimeClock', () => ({ runtimeClock: {} }));
jest.mock('../../data/nativeStore', () => ({
  openCookMateStore: async ({ databaseName }: { databaseName: string }) => {
    mockDatabases
      .get(databaseName)!
      .exec('CREATE TABLE IF NOT EXISTS app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    return { kind: 'ready', services: { close: async () => undefined } };
  },
}));
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const databaseName = `cookmate-account-${owner}.db`;
const markerKey = 'account-workspace:identity';
function readMarker() {
  const row = mockDatabases
    .get(databaseName)!
    .prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(markerKey) as { value: string };
  return JSON.parse(row.value) as { phase: string; ownerId: string; copyGuest: boolean };
}
function adapter(copy: (ownerId: string) => Promise<void> = async () => undefined) {
  return createWorkspaceDatabaseAdapter({
    assertClosed: jest.fn(),
    copyGuestPrivateState: copy,
    removePrivateState: jest.fn(async () => undefined),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockBackup.mockImplementation(
    async ({
      sourceDatabase,
      destDatabase,
    }: {
      sourceDatabase: { db: TestDatabase };
      destDatabase: { db: TestDatabase };
    }) => {
      destDatabase.db.exec('CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      for (const row of sourceDatabase.db
        .prepare('SELECT key,value FROM app_metadata')
        .all() as Array<{ key: string; value: string }>)
        destDatabase.db
          .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
          .run(row.key, row.value);
    },
  );
});
afterEach(() => {
  for (const db of mockDatabases.values()) db.close();
  mockDatabases.clear();
});

test('a new empty account reaches verified readiness using actual SQLite marker transitions', async () => {
  await adapter().prepare(owner, false);
  expect(readMarker()).toMatchObject({ phase: 'ready', ownerId: owner, copyGuest: false });
  await expect(verifyAccountWorkspace(owner)).resolves.toBeUndefined();
  expect(mockBackup).not.toHaveBeenCalled();
});

test('guest private-state failure keeps copied state and retry does not copy the guest again', async () => {
  const guest = await mockOpen('cookmate.db');
  guest.db.exec('CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  guest.db
    .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
    .run('guest-evidence', 'original');
  const privateCopy = jest.fn(async (_owner: string) => {
    expect(readMarker().phase).toBe('copied');
    if (privateCopy.mock.calls.length === 1) throw new Error('interrupted private settings copy');
  });
  const service = adapter(privateCopy);
  await expect(service.prepare(owner, true)).rejects.toThrow('interrupted');
  expect(readMarker().phase).toBe('copied');
  await expect(verifyAccountWorkspace(owner)).rejects.toThrow('identity');
  await service.prepare(owner, true);
  expect(readMarker().phase).toBe('ready');
  expect(mockBackup).toHaveBeenCalledTimes(1);
  expect(
    mockDatabases
      .get(databaseName)!
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get('guest-evidence'),
  ).toEqual({ value: 'original' });
  expect(
    guest.db.prepare('SELECT value FROM app_metadata WHERE key=?').get('guest-evidence'),
  ).toEqual({ value: 'original' });
});

test('private-state mutation cannot silently skip the final ready transition', async () => {
  const guest = await mockOpen('cookmate.db');
  guest.db.exec('CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const privateCopy = jest.fn(async (_owner: string) => {
    mockDatabases
      .get(databaseName)!
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run('changed', markerKey);
  });
  await expect(adapter(privateCopy).prepare(owner, true)).rejects.toThrow('readiness');
  await expect(verifyAccountWorkspace(owner)).rejects.toThrow('identity');
});
