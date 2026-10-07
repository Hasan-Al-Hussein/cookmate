export const GUEST_DATABASE_NAME = 'cookmate.db';
export const WORKSPACE_MANIFEST_STORAGE_KEY = 'cookmate.workspace-selection.v1';
export const WORKSPACE_MANIFEST_MAX_BYTES = 16 * 1024;
export const WORKSPACE_ACCOUNT_LIMIT = 64;

export type LocalWorkspace =
  | { readonly kind: 'guest' }
  | { readonly kind: 'account'; readonly ownerId: string };
export type PendingWorkspaceChange =
  | { readonly kind: 'activate'; readonly ownerId: string; readonly copyGuest: boolean }
  | { readonly kind: 'remove'; readonly ownerId: string };
export interface WorkspaceManifest {
  readonly format: 'cookmate-workspaces';
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly guestDatabase: string;
  /** Permanent even after removing an account copy; no subsequent account inherits guest work. */
  readonly guestClaim: string | null;
  /** Only destinations whose preparation completed. Filenames are always derived, never stored. */
  readonly accountOwners: readonly string[];
  readonly active: LocalWorkspace;
  readonly pending: PendingWorkspaceChange | null;
}
export type WorkspaceSelectionSnapshot =
  | {
      readonly status: 'uninitialized' | 'unavailable';
      readonly manifest: null;
      readonly databaseName: null;
    }
  | {
      readonly status: 'pending';
      readonly manifest: WorkspaceManifest;
      readonly databaseName: null;
    }
  | {
      readonly status: 'ready';
      readonly manifest: WorkspaceManifest;
      readonly databaseName: string;
    };
export type WorkspaceSelectionFailure =
  | 'invalid_owner'
  | 'invalid_manifest'
  | 'unsupported_manifest'
  | 'manifest_too_large'
  | 'manifest_changed'
  | 'not_initialized'
  | 'storage_unavailable'
  | 'storage_write_failed'
  | 'workspace_open'
  | 'workspace_changed'
  | 'pending_change'
  | 'account_limit'
  | 'revision_exhausted'
  | 'prepare_failed'
  | 'removal_failed';
export class WorkspaceSelectionError extends Error {
  constructor(
    public readonly reason: WorkspaceSelectionFailure,
    cause?: unknown,
  ) {
    super(`Local workspace: ${reason}`, { cause });
    this.name = 'WorkspaceSelectionError';
  }
}
export interface WorkspaceSelectionStorage {
  read(): Promise<string | null>;
  /** One atomic persisted record. The runtime must give this manager exclusive manifest ownership. */
  write(serialized: string): Promise<void>;
}
export interface WorkspaceDatabaseAdapter {
  /** Idempotent: stamp/verify destination owner + preparation marker before completing a clone. */
  prepare(ownerId: string, copyGuest: boolean): Promise<void>;
  /** Idempotent: only this owner's closed database and private KV namespaces; never guest data. */
  remove(ownerId: string): Promise<void>;
}
/** Trusted host configuration only; never derive this policy from a saved manifest or remote input. */
export interface WorkspaceDatabaseNamingPolicy {
  readonly guestDatabase: string;
  accountDatabaseName(ownerId: string): string;
}
export interface WorkspaceSelectionOptions {
  readonly naming?: WorkspaceDatabaseNamingPolicy;
  storage: WorkspaceSelectionStorage;
  databases: WorkspaceDatabaseAdapter;
  /** Caller holds its drain/close barrier for the entire mutation and any pending recovery. */
  assertClosed(): void;
}

function fail(reason: WorkspaceSelectionFailure): never {
  throw new WorkspaceSelectionError(reason);
}
function isOwner(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
function requireOwner(ownerId: unknown): asserts ownerId is string {
  if (!isOwner(ownerId)) fail('invalid_owner');
}
export function accountDatabaseName(ownerId: string): string {
  requireOwner(ownerId);
  return `cookmate-account-${ownerId}.db`;
}
function requireDatabaseName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !value.endsWith('.db') ||
    !/^[a-z0-9][a-z0-9._-]*\.db$/.test(value)
  )
    fail('invalid_manifest');
}
function ownNaming(
  naming?: WorkspaceDatabaseNamingPolicy,
): Readonly<WorkspaceDatabaseNamingPolicy> {
  const guestDatabase = naming === undefined ? GUEST_DATABASE_NAME : naming.guestDatabase;
  const resolveAccount = naming === undefined ? accountDatabaseName : naming.accountDatabaseName;
  requireDatabaseName(guestDatabase);
  if (typeof resolveAccount !== 'function') fail('invalid_manifest');
  return Object.freeze({ guestDatabase, accountDatabaseName: resolveAccount });
}
function accountName(ownerId: string, naming: Readonly<WorkspaceDatabaseNamingPolicy>): string {
  requireOwner(ownerId);
  const name = naming.accountDatabaseName(ownerId);
  requireDatabaseName(name);
  if (name === naming.guestDatabase) fail('invalid_manifest');
  return name;
}
export function workspaceDatabaseName(
  workspace: LocalWorkspace,
  naming?: WorkspaceDatabaseNamingPolicy,
): string {
  const owned = ownNaming(naming);
  return workspace.kind === 'guest' ? owned.guestDatabase : accountName(workspace.ownerId, owned);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function freezeManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  Object.freeze(manifest.accountOwners);
  Object.freeze(manifest.active);
  if (manifest.pending) Object.freeze(manifest.pending);
  return Object.freeze(manifest);
}
function initialManifest(guestDatabase: string): WorkspaceManifest {
  return freezeManifest({
    format: 'cookmate-workspaces',
    schemaVersion: 1,
    revision: 0,
    guestDatabase,
    guestClaim: null,
    accountOwners: [],
    active: { kind: 'guest' },
    pending: null,
  });
}

/** The allowlisted manifest is ASCII-only. The length bound therefore also bounds accepted UTF-8 bytes. */
export function parseWorkspaceManifest(
  serialized: string,
  naming?: WorkspaceDatabaseNamingPolicy,
): WorkspaceManifest {
  const owned = ownNaming(naming);
  if (typeof serialized !== 'string') fail('invalid_manifest');
  if (serialized.length > WORKSPACE_MANIFEST_MAX_BYTES) fail('manifest_too_large');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return fail('invalid_manifest');
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1)
    fail('unsupported_manifest');
  if (
    !exact(value, [
      'format',
      'schemaVersion',
      'revision',
      'guestDatabase',
      'guestClaim',
      'accountOwners',
      'active',
      'pending',
    ]) ||
    value.format !== 'cookmate-workspaces' ||
    value.schemaVersion !== 1 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.guestDatabase !== owned.guestDatabase ||
    (value.guestClaim !== null && !isOwner(value.guestClaim)) ||
    !Array.isArray(value.accountOwners) ||
    value.accountOwners.length > WORKSPACE_ACCOUNT_LIMIT ||
    !value.accountOwners.every(isOwner) ||
    new Set(value.accountOwners).size !== value.accountOwners.length
  )
    fail('invalid_manifest');
  const owners = value.accountOwners as string[];
  if (!exact(value.active, ['kind']) && !exact(value.active, ['kind', 'ownerId']))
    fail('invalid_manifest');
  if (value.active.kind === 'guest') {
    if (!exact(value.active, ['kind'])) fail('invalid_manifest');
  } else if (
    value.active.kind !== 'account' ||
    !isOwner(value.active.ownerId) ||
    !owners.includes(value.active.ownerId)
  )
    fail('invalid_manifest');
  if (
    value.guestClaim === null &&
    (owners.length > 0 || value.active.kind !== 'guest' || value.pending !== null)
  )
    fail('invalid_manifest');
  if (value.pending !== null) {
    if (value.revision === Number.MAX_SAFE_INTEGER) fail('invalid_manifest');
    if (
      !exact(value.pending, ['kind', 'ownerId']) &&
      !exact(value.pending, ['kind', 'ownerId', 'copyGuest'])
    )
      fail('invalid_manifest');
    if (!isOwner(value.pending.ownerId)) fail('invalid_manifest');
    if (value.pending.kind === 'activate') {
      if (
        !exact(value.pending, ['kind', 'ownerId', 'copyGuest']) ||
        typeof value.pending.copyGuest !== 'boolean' ||
        owners.includes(value.pending.ownerId) ||
        owners.length >= WORKSPACE_ACCOUNT_LIMIT ||
        (value.pending.copyGuest &&
          (value.guestClaim !== value.pending.ownerId ||
            owners.length !== 0 ||
            value.active.kind !== 'guest'))
      )
        fail('invalid_manifest');
    } else if (
      value.pending.kind !== 'remove' ||
      !exact(value.pending, ['kind', 'ownerId']) ||
      value.active.kind !== 'account' ||
      value.active.ownerId !== value.pending.ownerId ||
      !owners.includes(value.pending.ownerId)
    )
      fail('invalid_manifest');
  }
  const namedOwners = new Set(owners);
  if (value.pending !== null) {
    const owner = value.pending.ownerId;
    requireOwner(owner);
    namedOwners.add(owner);
  }
  const names = new Set<string>();
  for (const owner of namedOwners) {
    const name = accountName(owner, owned);
    if (names.has(name)) fail('invalid_manifest');
    names.add(name);
  }
  return freezeManifest({
    format: 'cookmate-workspaces',
    schemaVersion: 1,
    revision: value.revision,
    guestDatabase: owned.guestDatabase,
    guestClaim: value.guestClaim,
    accountOwners: [...owners].sort(),
    active: { ...value.active } as LocalWorkspace,
    pending: value.pending === null ? null : ({ ...value.pending } as PendingWorkspaceChange),
  });
}
function serialize(manifest: WorkspaceManifest): string {
  return JSON.stringify(manifest);
}
function nextRevision(manifest: WorkspaceManifest, steps = 1): number {
  if (!Number.isSafeInteger(manifest.revision + steps)) fail('revision_exhausted');
  return manifest.revision + steps;
}

/** Construction does no I/O. Use one manager per runtime; drain/close SQLite before any mutation. */
export function createWorkspaceSelection(options: WorkspaceSelectionOptions) {
  const naming = ownNaming(options.naming);
  const storage = options.storage,
    databases = options.databases;
  const readStorage = storage.read.bind(storage),
    writeStorage = storage.write.bind(storage);
  const prepareDatabase = databases.prepare.bind(databases),
    removeDatabase = databases.remove.bind(databases);
  const checkClosed = options.assertClosed.bind(options);
  let snapshot: WorkspaceSelectionSnapshot = Object.freeze({
    status: 'uninitialized',
    manifest: null,
    databaseName: null,
  });
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  function unavailable() {
    snapshot = Object.freeze({ status: 'unavailable', manifest: null, databaseName: null });
  }
  function publish(manifest: WorkspaceManifest) {
    snapshot = manifest.pending
      ? Object.freeze({ status: 'pending', manifest, databaseName: null })
      : Object.freeze({
          status: 'ready',
          manifest,
          databaseName: workspaceDatabaseName(manifest.active, naming),
        });
    return snapshot;
  }
  function current(): WorkspaceManifest {
    if (!snapshot.manifest) fail('not_initialized');
    return snapshot.manifest;
  }
  function assertClosed() {
    try {
      checkClosed();
    } catch {
      return fail('workspace_open');
    }
  }
  async function read(): Promise<WorkspaceManifest | null> {
    let raw: string | null;
    try {
      raw = await readStorage();
    } catch {
      unavailable();
      return fail('storage_unavailable');
    }
    if (raw === null) return null;
    try {
      return parseWorkspaceManifest(raw, naming);
    } catch (error) {
      unavailable();
      throw error;
    }
  }
  async function ensureCurrent(expected: WorkspaceManifest | null) {
    const found = await read();
    if (
      (found === null ? null : serialize(found)) !==
      (expected === null ? null : serialize(expected))
    ) {
      unavailable();
      fail('manifest_changed');
    }
  }
  async function persist(next: WorkspaceManifest, expected = snapshot.manifest) {
    const validated = parseWorkspaceManifest(serialize(next), naming);
    assertClosed();
    await ensureCurrent(expected);
    assertClosed();
    // Resolve both thrown writes and successful-but-unpersisted writes by rereading the exact record.
    try {
      await writeStorage(serialize(validated));
    } catch {
      /* Readback is the proof. */
    }
    const found = await read();
    if (found && serialize(found) === serialize(validated)) return publish(found);
    if (
      (found === null ? null : serialize(found)) ===
      (expected === null ? null : serialize(expected))
    ) {
      if (expected) publish(expected);
      else
        snapshot = Object.freeze({ status: 'uninitialized', manifest: null, databaseName: null });
      fail('storage_write_failed');
    }
    unavailable();
    return fail('manifest_changed');
  }
  async function recover() {
    const before = current();
    if (!before.pending) return snapshot;
    assertClosed();
    await ensureCurrent(before);
    assertClosed();
    const pending = before.pending;
    if (pending.kind === 'activate') {
      try {
        await prepareDatabase(pending.ownerId, pending.copyGuest);
      } catch (error) {
        throw new WorkspaceSelectionError('prepare_failed', error);
      }
      assertClosed();
      return persist({
        ...before,
        revision: nextRevision(before),
        accountOwners: [...before.accountOwners, pending.ownerId].sort(),
        active: { kind: 'account', ownerId: pending.ownerId },
        pending: null,
      });
    }
    try {
      await removeDatabase(pending.ownerId);
    } catch (error) {
      throw new WorkspaceSelectionError('removal_failed', error);
    }
    assertClosed();
    return persist({
      ...before,
      revision: nextRevision(before),
      accountOwners: before.accountOwners.filter((owner) => owner !== pending.ownerId),
      active: { kind: 'guest' },
      pending: null,
    });
  }
  function noPending(manifest: WorkspaceManifest) {
    if (manifest.pending) fail('pending_change');
  }
  function activeOwner(manifest: WorkspaceManifest, ownerId: string) {
    if (manifest.active.kind !== 'account' || manifest.active.ownerId !== ownerId)
      fail('workspace_changed');
  }
  return Object.freeze({
    getSnapshot: (): WorkspaceSelectionSnapshot => snapshot,
    initialize: () =>
      queue(async () => {
        const found = await read();
        return found ? publish(found) : persist(initialManifest(naming.guestDatabase), null);
      }),
    activate: (ownerId: string) =>
      queue(async () => {
        requireOwner(ownerId);
        const before = current();
        assertClosed();
        await ensureCurrent(before);
        if (before.pending) {
          if (before.pending.kind === 'activate' && before.pending.ownerId === ownerId)
            return recover();
          fail('pending_change');
        }
        if (before.active.kind === 'account' && before.active.ownerId === ownerId) return snapshot;
        if (before.accountOwners.includes(ownerId))
          return persist({
            ...before,
            revision: nextRevision(before),
            active: { kind: 'account', ownerId },
          });
        if (before.accountOwners.length >= WORKSPACE_ACCOUNT_LIMIT) fail('account_limit');
        nextRevision(before, 2);
        const copyGuest = before.guestClaim === null;
        await persist({
          ...before,
          revision: nextRevision(before),
          guestClaim: before.guestClaim ?? ownerId,
          pending: { kind: 'activate', ownerId, copyGuest },
        });
        return recover();
      }),
    activateGuest: () =>
      queue(async () => {
        const before = current();
        noPending(before);
        assertClosed();
        await ensureCurrent(before);
        return before.active.kind === 'guest'
          ? snapshot
          : persist({ ...before, revision: nextRevision(before), active: { kind: 'guest' } });
      }),
    keepLocalCopy: (ownerId: string) =>
      queue(async () => {
        requireOwner(ownerId);
        const before = current();
        noPending(before);
        activeOwner(before, ownerId);
        assertClosed();
        await ensureCurrent(before);
        return snapshot;
      }),
    removeLocalCopy: (ownerId: string) =>
      queue(async () => {
        requireOwner(ownerId);
        const before = current();
        assertClosed();
        await ensureCurrent(before);
        if (before.pending) {
          if (before.pending.kind === 'remove' && before.pending.ownerId === ownerId)
            return recover();
          fail('pending_change');
        }
        activeOwner(before, ownerId);
        nextRevision(before, 2);
        await persist({
          ...before,
          revision: nextRevision(before),
          pending: { kind: 'remove', ownerId },
        });
        return recover();
      }),
    recoverPending: () => queue(recover),
  });
}
export type WorkspaceSelection = ReturnType<typeof createWorkspaceSelection>;
