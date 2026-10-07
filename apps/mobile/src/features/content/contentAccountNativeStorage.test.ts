import { createContentAccountNativeStorage } from './contentAccountNativeStorage';
import { CONTENT_ACCOUNT_MARKER_KEY } from './contentAccountWorkspaces';
import {
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
} from './privateContentConfig';

// Controlled Expo boundary: models backup images and handle lifetime, not a native SQLite proof.
// Naming tests do not configure or exercise release trust.
jest.mock('@cookmate/catalogue/content-trust', () => ({
  createContentTrustVerifier: jest.fn(() => {
    throw new Error('Release verification is outside this platform-boundary fixture');
  }),
}));
const installationId = '650a0000-0000-4000-8000-000000000001';
const ownerId = '650b0000-0000-4000-8000-000000000001';
const otherOwner = '650b0000-0000-4000-8000-000000000002';
const names = privateContentDatabaseNames(installationId);
const destinationName = privateContentAccountDatabaseName(installationId, ownerId);
const mockEvents: string[] = [];
const mockTransferredMetadata: (string | null)[] = [];
class ImageHandle {
  version = 0;
  pageCount = 8;
  pageSize = 4096;
  occupied = false;
  metadata = new Map<string, string>();
  constructor(readonly name: string) {}
  getFirstAsync = jest.fn(async (sql: string, ...values: string[]): Promise<object | null> => {
    mockEvents.push(`read:${this.name}:${sql}`);
    if (sql === 'PRAGMA page_count') return { page_count: this.pageCount };
    if (sql === 'PRAGMA page_size') return { page_size: this.pageSize };
    if (sql === 'PRAGMA user_version') return { user_version: this.version };
    if (sql.includes('sqlite_master')) return this.occupied ? { exists: 1 } : null;
    if (sql.includes("key='installation_id'")) {
      expect(sql).toContain(
        "CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END",
      );
      const raw = this.metadata.get('installation_id');
      const value = typeof raw === 'string' && raw.length === 36 ? raw : null;
      mockTransferredMetadata.push(value);
      return { value };
    }
    if (sql.includes("key LIKE 'account-replication:%'"))
      return [...this.metadata.keys()].some(
        (key) => key.startsWith('account-replication:') || key === values[0],
      )
        ? { exists: 1 }
        : null;
    if (sql.includes('FROM app_metadata WHERE key=?')) {
      expect(sql).toContain(
        "CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=2048 THEN value END",
      );
      const raw = this.metadata.get(values[0]!);
      const value = typeof raw === 'string' && raw.length <= 2048 ? raw : null;
      mockTransferredMetadata.push(value);
      return { value };
    }
    throw new Error(`Unexpected read ${sql}`);
  });
  execAsync = jest.fn(async (sql: string) => {
    mockEvents.push(`exec:${this.name}:${sql}`);
  });
  runAsync = jest.fn(async (sql: string, key: string, value: string) => {
    mockEvents.push(`write:${this.name}:${key}`);
    if (sql !== 'INSERT INTO app_metadata(key,value) VALUES (?,?)')
      throw new Error('Unexpected write');
    this.metadata.set(key, value);
  });
  closeAsync = jest.fn(async () => {
    mockEvents.push(`close:${this.name}`);
  });
}
const mockImages = new Map<string, ImageHandle>();
const mockOpen = jest.fn(async (name: string, _options?: { useNewConnection: boolean }) => {
  mockEvents.push(`open:${name}`);
  const image = mockImages.get(name);
  if (!image) throw new Error(`Unexpected file ${name}`);
  return image;
});
const mockDelete = jest.fn(async (name: string) => {
  mockEvents.push(`delete:${name}`);
});
const mockBackup = jest.fn(
  async ({
    sourceDatabase,
    destDatabase,
  }: {
    sourceDatabase: ImageHandle;
    destDatabase: ImageHandle;
  }) => {
    mockEvents.push(`backup:${sourceDatabase.name}->${destDatabase.name}`);
    destDatabase.metadata = new Map(sourceDatabase.metadata);
    destDatabase.version = sourceDatabase.version;
    destDatabase.occupied = sourceDatabase.occupied;
  },
);
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...args: Parameters<typeof mockOpen>) => mockOpen(...args),
  backupDatabaseAsync: (...args: Parameters<typeof mockBackup>) => mockBackup(...args),
  deleteDatabaseAsync: (...args: Parameters<typeof mockDelete>) => mockDelete(...args),
}));
jest.mock('./contentAccountWorkspaces', () => ({
  CONTENT_ACCOUNT_MARKER_KEY: 'account-workspace:content-identity',
}));
jest.mock('./privateContentRuntime', () => ({
  PrivateContentCleanupError: class extends AggregateError {
    constructor(errors: unknown[]) {
      super(errors, 'Private recipe resources could not be closed.');
      this.name = 'PrivateContentCleanupError';
    }
  },
}));
function fixture(browser = false) {
  let closed = true;
  const source = new ImageHandle(browser ? `cmr-${installationId}-c.db` : names.cooking),
    memory = new ImageHandle(':memory:'),
    target = new ImageHandle(destinationName);
  source.version = 8;
  source.occupied = true;
  source.metadata.set('installation_id', installationId);
  source.metadata.set('original-private-value', 'unaltered guest data');
  for (const item of [source, memory, target]) mockImages.set(item.name, item);
  const sha256 = jest.fn(async (_text: string) => 'a'.repeat(64));
  const assertClosed = jest.fn(() => {
    if (!closed) throw new Error('retired barrier');
  });
  const options = { installationId, browser, sha256, assertClosed };
  const storage = createContentAccountNativeStorage(options);
  const marker = {
    key: CONTENT_ACCOUNT_MARKER_KEY,
    value: JSON.stringify({
      installationId,
      ownerId,
      databaseName: destinationName,
      copyGuest: true,
      phase: 'copied',
    }),
  };
  return {
    source,
    memory,
    target,
    sha256,
    options,
    storage,
    marker,
    retire: () => {
      closed = false;
    },
    clone: () => storage.cloneGuestWithMarker(names.cooking, destinationName, marker),
  };
}
beforeEach(() => {
  mockImages.clear();
  mockEvents.length = 0;
  mockTransferredMetadata.length = 0;
  mockOpen.mockClear();
  mockDelete.mockClear();
  mockBackup.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

test('stamps only the owned memory image before the atomic destination backup and closes all handles', async () => {
  const f = fixture();
  const original = [...f.source.metadata];
  await f.clone();
  expect(mockBackup).toHaveBeenCalledTimes(2);
  expect(mockBackup.mock.calls[0]?.[0]).toEqual({
    sourceDatabase: f.source,
    destDatabase: f.memory,
  });
  expect(mockBackup.mock.calls[1]?.[0]).toEqual({
    sourceDatabase: f.memory,
    destDatabase: f.target,
  });
  expect(f.memory.metadata.get(CONTENT_ACCOUNT_MARKER_KEY)).toBe(f.marker.value);
  expect(f.target.metadata.get(CONTENT_ACCOUNT_MARKER_KEY)).toBe(f.marker.value);
  expect([...f.source.metadata]).toEqual(original);
  expect(f.source.runAsync).not.toHaveBeenCalled();
  expect(f.source.execAsync).not.toHaveBeenCalled();
  expect(mockEvents.slice(-3)).toEqual([
    `close:${destinationName}`,
    'close::memory:',
    `close:${names.cooking}`,
  ]);
});
test.each([
  { occupied: true, version: 0 },
  { occupied: false, version: 8 },
])('never overwrites a nonempty or version-stamped destination: %j', async (existing) => {
  const f = fixture();
  Object.assign(f.target, existing);
  f.target.metadata.set('existing-private', 'must survive');
  const before = [...f.target.metadata];
  await expect(f.clone()).rejects.toThrow('destination is not empty');
  expect(mockBackup).toHaveBeenCalledTimes(1);
  expect([...f.target.metadata]).toEqual(before);
  expect(f.target.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.memory.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
});
test('unknown logical targets, cross-installation sources and false markers never open a database', async () => {
  const f = fixture();
  for (const target of [
    'cookmate.db',
    destinationName + '-journal',
    '../' + destinationName,
    privateContentAccountDatabaseName('650a0000-0000-4000-8000-000000000002', ownerId),
  ])
    await expect(f.storage.cloneGuestWithMarker(names.cooking, target, f.marker)).rejects.toThrow();
  for (const source of ['cookmate.db', names.content])
    await expect(
      f.storage.cloneGuestWithMarker(source, destinationName, f.marker),
    ).rejects.toThrow();
  for (const marker of [
    { ...f.marker, key: 'other' },
    { ...f.marker, value: JSON.stringify({ ...JSON.parse(f.marker.value), ownerId: otherOwner }) },
    { ...f.marker, value: 'x'.repeat(2049) },
  ])
    await expect(
      f.storage.cloneGuestWithMarker(names.cooking, destinationName, marker),
    ).rejects.toThrow();
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockBackup).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});
test.each([
  { pageCount: 16385, pageSize: 4096 },
  { pageCount: 0, pageSize: 4096 },
  { pageCount: 8, pageSize: 513 },
])(
  'rejects unsupported memory admission before opening the memory image or copying: %j',
  async (admission) => {
    const f = fixture();
    Object.assign(f.source, admission);
    await expect(f.clone()).rejects.toThrow();
    expect(mockOpen.mock.calls.map((call) => call[0])).toEqual([names.cooking]);
    expect(mockBackup).not.toHaveBeenCalled();
    expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
  },
);
test('admits the 64MiB boundary without a real allocation and rejects changed copied identity', async () => {
  const f = fixture();
  f.source.pageCount = 16384;
  f.source.metadata.set('installation_id', '650a0000-0000-4000-8000-000000000002');
  await expect(f.clone()).rejects.toThrow('identity changed');
  expect(mockBackup).toHaveBeenCalledTimes(1);
  expect(mockOpen.mock.calls.map((call) => call[0])).toEqual([names.cooking, ':memory:']);
  expect(f.memory.runAsync).not.toHaveBeenCalled();
  expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
});
test('retirement during target inspection blocks final backup and preserves both actual images', async () => {
  const f = fixture();
  const read = f.target.getFirstAsync.getMockImplementation()!;
  f.target.getFirstAsync.mockImplementation(async (sql, ...values) => {
    const result = await read(sql, ...values);
    if (sql === 'PRAGMA user_version') f.retire();
    return result;
  });
  await expect(f.clone()).rejects.toThrow('retired barrier');
  expect(mockBackup).toHaveBeenCalledTimes(1);
  expect(f.target.metadata.size).toBe(0);
  expect(f.source.metadata.has(CONTENT_ACCOUNT_MARKER_KEY)).toBe(false);
  expect(f.target.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.memory.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
});
test.each(['source', 'destination'] as const)(
  'failure at %s backup closes every owned handle without retry or source mutation',
  async (phase) => {
    const f = fixture();
    const original = [...f.source.metadata];
    if (phase === 'destination')
      mockBackup.mockImplementationOnce(mockBackup.getMockImplementation()!);
    mockBackup.mockRejectedValueOnce(new Error(`${phase} backup failed`));
    await expect(f.clone()).rejects.toThrow(`${phase} backup failed`);
    expect(mockBackup).toHaveBeenCalledTimes(phase === 'source' ? 1 : 2);
    expect(f.target.closeAsync).toHaveBeenCalledTimes(phase === 'source' ? 0 : 1);
    expect(f.memory.closeAsync).toHaveBeenCalledTimes(1);
    expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
    expect([...f.source.metadata]).toEqual(original);
  },
);
test('oversized copied installation metadata is bounded before returning the scalar or opening the destination', async () => {
  const f = fixture();
  f.source.metadata.set('installation_id', 'x'.repeat(4096));
  await expect(f.clone()).rejects.toThrow('identity changed');
  expect(mockTransferredMetadata).toEqual([null]);
  expect(mockBackup).toHaveBeenCalledTimes(1);
  expect(mockOpen.mock.calls.map((call) => call[0])).toEqual([names.cooking, ':memory:']);
  expect(f.memory.runAsync).not.toHaveBeenCalled();
  expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.memory.closeAsync).toHaveBeenCalledTimes(1);
});
test('oversized post-backup marker is not transferred as a scalar or reported as a confirmed copy', async () => {
  const f = fixture();
  const backup = mockBackup.getMockImplementation()!;
  mockBackup.mockImplementationOnce(backup).mockImplementationOnce(async (args) => {
    await backup(args);
    args.destDatabase.metadata.set(CONTENT_ACCOUNT_MARKER_KEY, 'x'.repeat(4096));
  });
  await expect(f.clone()).rejects.toThrow('not confirmed');
  expect(mockTransferredMetadata).toEqual([installationId, null]);
  expect(mockBackup).toHaveBeenCalledTimes(2);
  expect(f.source.metadata.has(CONTENT_ACCOUNT_MARKER_KEY)).toBe(false);
  expect(f.target.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.memory.closeAsync).toHaveBeenCalledTimes(1);
  expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
});
test.each(['source', 'memory', 'target'] as const)(
  'a failed %s close attempts all cleanup and latches refusal of every later open/delete',
  async (which) => {
    const f = fixture();
    f[which].closeAsync.mockRejectedValue(new Error('unclosed handle'));
    await expect(f.clone()).rejects.toMatchObject({ name: 'PrivateContentCleanupError' });
    expect(f.source.closeAsync).toHaveBeenCalledTimes(1);
    expect(f.memory.closeAsync).toHaveBeenCalledTimes(1);
    expect(f.target.closeAsync).toHaveBeenCalledTimes(1);
    const opened = mockOpen.mock.calls.length;
    await expect(f.storage.openConnection(names.cooking)).rejects.toMatchObject({
      name: 'PrivateContentCleanupError',
    });
    await expect(f.storage.deleteDatabase(destinationName)).rejects.toMatchObject({
      name: 'PrivateContentCleanupError',
    });
    expect(mockOpen).toHaveBeenCalledTimes(opened);
    expect(mockDelete).not.toHaveBeenCalled();
  },
);
test('logical open/delete guards preserve the guest and content cache', async () => {
  const f = fixture();
  for (const name of ['cookmate.db', '../' + destinationName, destinationName + '\n'])
    await expect(f.storage.openConnection(name)).rejects.toThrow();
  for (const name of [names.cooking, names.content, 'cookmate.db'])
    await expect(f.storage.deleteDatabase(name)).rejects.toThrow();
  expect(mockDelete).not.toHaveBeenCalled();
  await f.storage.deleteDatabase(destinationName);
  expect(mockDelete).toHaveBeenCalledWith(destinationName);
});
