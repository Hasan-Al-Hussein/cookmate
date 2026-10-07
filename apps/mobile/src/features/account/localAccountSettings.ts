import type { AccountSnapshotOptions } from '@cookmate/account-sync';
import { portableBackupByteLength } from '@cookmate/domain';
import {
  decodeAppPreferences,
  defaultAppPreferences,
  encodeAppPreferences,
  type AppPreferences,
  type AppPreferencesStore,
} from '../app-preferences/preferences';

const schemaVersion = 1;
const maximumStoredBytes = 2048;
const maximumDisplayNameLength = 120;

export type LocalAccountSettingsFailure =
  | 'invalid_owner'
  | 'invalid_options'
  | 'invalid_record'
  | 'unsupported_version'
  | 'owner_changed'
  | 'storage_unavailable'
  | 'stale_options'
  | 'save_unconfirmed';

export class LocalAccountSettingsError extends Error {
  constructor(readonly reason: LocalAccountSettingsFailure) {
    super(`Local account settings: ${reason}`);
    this.name = 'LocalAccountSettingsError';
  }
}

export interface LocalAccountSettingsSnapshot {
  readonly kind: 'loading' | 'ready' | 'failed';
  readonly options: AccountSnapshotOptions;
  readonly error: LocalAccountSettingsFailure | null;
}

export interface LocalAccountSettingsStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export interface LocalAccountSettingsController {
  hydrate(): Promise<void>;
  /** Retire the workspace generation first, then wait before removing its storage. */
  drain(): Promise<void>;
  getSnapshot(): LocalAccountSettingsSnapshot;
  subscribe(listener: () => void): () => void;
  readonly preferenceStore: AppPreferencesStore;
  replaceOptions(
    next: AccountSnapshotOptions,
    expected: AccountSnapshotOptions,
    isCurrent: () => boolean,
  ): Promise<boolean>;
}

export function localAccountSettingsKey(ownerId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ownerId))
    throw new LocalAccountSettingsError('invalid_owner');
  return `cookmate.account-settings.${ownerId}`;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    })
  );
}

function copyOptions(value: unknown): AccountSnapshotOptions {
  if (
    !exact(value, ['appPreferences', 'profile']) ||
    !exact(value.appPreferences, ['theme', 'motion', 'locale']) ||
    !Object.values(value.appPreferences).every((preference) => typeof preference === 'string') ||
    !exact(value.profile, ['displayName'])
  )
    throw new LocalAccountSettingsError('invalid_options');
  const name = value.profile.displayName;
  // Match the account snapshot contract's UTF-16 length, retaining the exact supplied name.
  if (
    !(
      name === null ||
      (typeof name === 'string' && name.length > 0 && name.length <= maximumDisplayNameLength)
    )
  )
    throw new LocalAccountSettingsError('invalid_options');
  const preferences = decodeAppPreferences(
    JSON.stringify({ schemaVersion: 1, preferences: value.appPreferences }),
  );
  if (!preferences.ok) throw new LocalAccountSettingsError('invalid_options');
  return Object.freeze({
    appPreferences: Object.freeze({ ...preferences.preferences }),
    profile: Object.freeze({ displayName: name }),
  });
}

const defaults = () =>
  copyOptions({ appPreferences: defaultAppPreferences, profile: { displayName: null } });
const samePreferences = (a: AppPreferences, b: AppPreferences) =>
  a.theme === b.theme && a.motion === b.motion && a.locale === b.locale;
const sameOptions = (a: AccountSnapshotOptions, b: AccountSnapshotOptions) =>
  samePreferences(a.appPreferences, b.appPreferences) &&
  a.profile.displayName === b.profile.displayName;

function decodeRecord(raw: string | null, ownerId: string): AccountSnapshotOptions {
  if (raw === null) return defaults();
  try {
    if (
      typeof raw !== 'string' ||
      raw.length > maximumStoredBytes ||
      portableBackupByteLength(raw) > maximumStoredBytes
    )
      throw new LocalAccountSettingsError('invalid_record');
    const value: unknown = JSON.parse(raw);
    if (!exact(value, ['schemaVersion', 'ownerId', 'options']) || value.ownerId !== ownerId)
      throw new LocalAccountSettingsError('invalid_record');
    if (
      typeof value.schemaVersion === 'number' &&
      Number.isInteger(value.schemaVersion) &&
      value.schemaVersion > schemaVersion
    )
      throw new LocalAccountSettingsError('unsupported_version');
    if (value.schemaVersion !== schemaVersion)
      throw new LocalAccountSettingsError('invalid_record');
    return copyOptions(value.options);
  } catch (error) {
    if (error instanceof LocalAccountSettingsError && error.reason === 'unsupported_version')
      throw error;
    throw new LocalAccountSettingsError('invalid_record');
  }
}

/** Retain one controller per owner/store. The port must atomically replace one key; a plain KV
 * cannot provide cross-process CAS. isCurrent fences an active workspace generation, not login.
 * hydrate re-reads storage for explicit recovery; it never writes defaults or migrates a record. */
export function createLocalAccountSettings({
  ownerId,
  store,
  isCurrent,
}: {
  ownerId: string;
  store: LocalAccountSettingsStore;
  isCurrent: () => boolean;
}): LocalAccountSettingsController {
  const key = localAccountSettingsKey(ownerId);
  let snapshot: LocalAccountSettingsSnapshot = Object.freeze({
    kind: 'loading',
    options: defaults(),
    error: null,
  });
  let queue: Promise<void> = Promise.resolve();
  let unconfirmed = false;
  // The existing preferences controller composes whole preference records from its last read.
  // Do not let that stale projection undo a newer sync's motion/locale/theme choices.
  let preferenceBaseline: AppPreferences | null = null;
  const listeners = new Set<() => void>();
  const current = (guard: () => boolean) => {
    try {
      return isCurrent() && guard();
    } catch {
      return false;
    }
  };
  const assertCurrent = (guard: () => boolean) => {
    if (!current(guard)) throw new LocalAccountSettingsError('owner_changed');
  };
  function publish(next: LocalAccountSettingsSnapshot, guard: () => boolean) {
    if (!current(guard)) return;
    // A subscribed preferences refresh reads this same store. Unchanged reads must not
    // notify again, otherwise the adapter and its consumer form a refresh loop.
    if (
      snapshot.kind === next.kind &&
      snapshot.error === next.error &&
      sameOptions(snapshot.options, next.options)
    )
      return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* Observers cannot undo a confirmed stored value. */
      }
    }
  }
  function fail(error: unknown, guard: () => boolean) {
    const reason =
      error instanceof LocalAccountSettingsError ? error.reason : 'storage_unavailable';
    publish({ kind: 'failed', options: snapshot.options, error: reason }, guard);
    return new LocalAccountSettingsError(reason);
  }
  function serial<T>(guard: () => boolean, operation: () => Promise<T>): Promise<T> {
    if (!current(guard)) return Promise.reject(new LocalAccountSettingsError('owner_changed'));
    const result = queue.then(() => {
      assertCurrent(guard);
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function readCurrent(guard: () => boolean) {
    assertCurrent(guard);
    const raw = await store.read(key);
    assertCurrent(guard);
    return decodeRecord(raw, ownerId);
  }
  async function refresh(guard: () => boolean) {
    const options = await readCurrent(guard);
    unconfirmed = false;
    publish({ kind: 'ready', options, error: null }, guard);
    return options;
  }
  async function save(
    next: AccountSnapshotOptions,
    before: AccountSnapshotOptions,
    guard: () => boolean,
  ) {
    assertCurrent(guard);
    if (!sameOptions(next, before)) {
      const raw = JSON.stringify({ schemaVersion, ownerId, options: next });
      if (portableBackupByteLength(raw) > maximumStoredBytes)
        throw new LocalAccountSettingsError('invalid_options');
      assertCurrent(guard);
      try {
        await store.write(key, raw);
      } catch {
        // A rejected acknowledgement does not prove that the atomic write failed.
        unconfirmed = true;
        const previousBaseline = preferenceBaseline;
        preferenceBaseline = null;
        let recovered: AccountSnapshotOptions;
        try {
          recovered = await readCurrent(guard);
        } catch {
          throw new LocalAccountSettingsError('save_unconfirmed');
        }
        if (!sameOptions(recovered, next)) {
          if (sameOptions(recovered, before)) {
            unconfirmed = false;
            preferenceBaseline = previousBaseline;
            throw new LocalAccountSettingsError('storage_unavailable');
          }
          throw new LocalAccountSettingsError('save_unconfirmed');
        }
        unconfirmed = false;
        // Sync recovery must still leave the preferences reader's older baseline intact.
        preferenceBaseline = previousBaseline;
      }
      assertCurrent(guard);
    }
    publish({ kind: 'ready', options: next, error: null }, guard);
  }
  const live = () => true;
  const preferenceStore: AppPreferencesStore = Object.freeze({
    read: () =>
      serial(live, async () => {
        const options = await refresh(live);
        preferenceBaseline = options.appPreferences;
        return encodeAppPreferences(options.appPreferences);
      }).catch((error: unknown) => {
        throw fail(error, live);
      }),
    write: (raw: string) => {
      const decoded = typeof raw === 'string' ? decodeAppPreferences(raw) : { ok: false as const };
      const baseline = preferenceBaseline;
      return serial(live, async () => {
        if (!decoded.ok) throw new LocalAccountSettingsError('invalid_options');
        if (unconfirmed) throw new LocalAccountSettingsError('save_unconfirmed');
        if (!baseline) throw new LocalAccountSettingsError('stale_options');
        const before = await readCurrent(live);
        if (!samePreferences(before.appPreferences, baseline))
          throw new LocalAccountSettingsError('stale_options');
        const next = copyOptions({ appPreferences: decoded.preferences, profile: before.profile });
        await save(next, before, live);
        preferenceBaseline = next.appPreferences;
      }).catch((error: unknown) => {
        throw fail(error, live);
      });
    },
  });
  return {
    drain: () => queue,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate: () =>
      serial(live, async () => {
        await refresh(live);
      }).catch((error: unknown) => {
        fail(error, live);
      }),
    preferenceStore,
    replaceOptions(next, expected, guard) {
      if (!current(guard)) return Promise.resolve(false);
      let requested: AccountSnapshotOptions;
      let before: AccountSnapshotOptions;
      try {
        requested = copyOptions(next);
        before = copyOptions(expected);
      } catch {
        fail(new LocalAccountSettingsError('invalid_options'), guard);
        return Promise.resolve(false);
      }
      return serial(guard, async () => {
        if (unconfirmed) throw new LocalAccountSettingsError('save_unconfirmed');
        const stored = await readCurrent(guard);
        if (!sameOptions(stored, before)) throw new LocalAccountSettingsError('stale_options');
        await save(requested, stored, guard);
        return true;
      }).catch((error: unknown) => {
        fail(error, guard);
        return false;
      });
    },
  };
}
