import { validateRecipeContentRef, type RecipeContentRef } from '@cookmate/contracts';

export const RECENTLY_VIEWED_LIMIT = 20;
export const RECENTLY_VIEWED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RECENTLY_VIEWED_MAXIMUM_LENGTH = 8192;
const maximumTimestamp = 8_640_000_000_000_000;

export interface RecentlyViewedEntry {
  readonly ref: Readonly<RecipeContentRef>;
  readonly openedAt: number;
}
export interface RecentlyViewedRecord {
  readonly enabled: boolean;
  readonly entries: readonly RecentlyViewedEntry[];
}
export interface RecentlyViewedSnapshot extends RecentlyViewedRecord {
  readonly hydrated: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}
export interface RecentlyViewedStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}
export interface RecentlyViewedOptions {
  readonly now?: () => number;
}
export interface RecentlyViewedController {
  getSnapshot(): RecentlyViewedSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  /** Re-read and prune on use. No background deletion deadline is promised. */
  refresh(): Promise<void>;
  setEnabled(enabled: boolean): Promise<boolean>;
  /** Caller supplies only a deliberately opened, readable exact recipe; this is not read authority. */
  recordOpen(ref: RecipeContentRef, isCurrent?: () => boolean): Promise<boolean>;
  clear(): Promise<boolean>;
  drain(): Promise<void>;
  dispose(): void;
}

export const defaultRecentlyViewed: RecentlyViewedRecord = Object.freeze({
  enabled: false,
  entries: Object.freeze([]),
});
const validTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximumTimestamp;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const refKey = (ref: Readonly<RecipeContentRef>) =>
  `${ref.recipeId}/${ref.revisionId}/${ref.contentFingerprint}`;

function copyRef(value: unknown): Readonly<RecipeContentRef> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 3
  )
    return null;
  const scalar = (key: string): string | null => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  };
  const recipeId = scalar('recipeId'),
    revisionId = scalar('revisionId'),
    contentFingerprint = scalar('contentFingerprint');
  const ref = { recipeId, revisionId, contentFingerprint };
  return validateRecipeContentRef(ref) ? Object.freeze(ref) : null;
}

type DecodeResult =
  | { readonly ok: true; readonly value: RecentlyViewedRecord }
  | {
      readonly ok: false;
      readonly reason: 'invalid-record' | 'unsupported-version' | 'clock-changed';
    };

export function decodeRecentlyViewed(text: string | null, now: number): DecodeResult {
  if (!validTime(now)) return { ok: false, reason: 'clock-changed' };
  if (text === null) return { ok: true, value: defaultRecentlyViewed };
  if (typeof text !== 'string' || text.length > RECENTLY_VIEWED_MAXIMUM_LENGTH)
    return { ok: false, reason: 'invalid-record' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-record' };
  }
  if (
    raw &&
    typeof raw === 'object' &&
    'schemaVersion' in raw &&
    typeof raw.schemaVersion === 'number' &&
    Number.isSafeInteger(raw.schemaVersion) &&
    raw.schemaVersion > 1
  )
    return { ok: false, reason: 'unsupported-version' };
  if (
    !exact(raw, ['schemaVersion', 'enabled', 'entries']) ||
    raw.schemaVersion !== 1 ||
    typeof raw.enabled !== 'boolean' ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > RECENTLY_VIEWED_LIMIT
  )
    return { ok: false, reason: 'invalid-record' };
  const entries: RecentlyViewedEntry[] = [];
  const seen = new Set<string>();
  let previous = now;
  for (const item of raw.entries) {
    if (!exact(item, ['ref', 'openedAt']) || !validTime(item.openedAt))
      return { ok: false, reason: 'invalid-record' };
    if (item.openedAt > now) return { ok: false, reason: 'clock-changed' };
    const ref = copyRef(item.ref);
    if (!ref || seen.has(refKey(ref)) || item.openedAt > previous)
      return { ok: false, reason: 'invalid-record' };
    seen.add(refKey(ref));
    previous = item.openedAt;
    entries.push(Object.freeze({ ref, openedAt: item.openedAt }));
  }
  return {
    ok: true,
    value: Object.freeze({ enabled: raw.enabled, entries: Object.freeze(entries) }),
  };
}

export function encodeRecentlyViewed(value: RecentlyViewedRecord): string {
  const text = JSON.stringify({ schemaVersion: 1, enabled: value.enabled, entries: value.entries });
  if (!decodeRecentlyViewed(text, maximumTimestamp).ok)
    throw new Error('Invalid recently viewed record');
  return text;
}

const clockError =
  'Recently viewed could not use the current clock safely. Saved history has been kept unchanged. Check the device time and retry.';
const privacyPausedError = 'Recording is paused until you retry this privacy change.';
const current = (guard: () => boolean): boolean => {
  try {
    return guard() === true;
  } catch {
    return false;
  }
};
const sameRecord = (a: RecentlyViewedRecord, b: RecentlyViewedRecord) =>
  a.enabled === b.enabled &&
  a.entries.length === b.entries.length &&
  a.entries.every(
    (item, index) =>
      item.openedAt === b.entries[index]!.openedAt &&
      refKey(item.ref) === refKey(b.entries[index]!.ref),
  );

/** One serial owner-bound record. Opt-in and deletion are independent of all cooking data. */
export function createRecentlyViewedController(
  store: RecentlyViewedStore,
  options: RecentlyViewedOptions = {},
): RecentlyViewedController {
  const read = store.read.bind(store),
    write = store.write.bind(store),
    now = options.now ?? Date.now;
  let snapshot: RecentlyViewedSnapshot = Object.freeze({
    ...defaultRecentlyViewed,
    hydrated: false,
    saving: false,
    error: null,
  });
  let record: RecentlyViewedRecord = defaultRecentlyViewed;
  let admission: 'unread' | 'ready' | 'invalid' = 'unread';
  let queue = Promise.resolve();
  let disposed = false,
    pending = 0,
    privacyGeneration = 0,
    recordingBlocked = false,
    privacyUnconfirmed = false;
  const listeners = new Set<() => void>();
  function publish(next: RecentlyViewedSnapshot) {
    if (disposed) return;
    const error = privacyUnconfirmed && !next.error?.includes(privacyPausedError)
      ? `${next.error ? `${next.error} ` : ''}${privacyPausedError}`
      : next.error;
    snapshot = Object.freeze({ ...next, error });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A presentation observer cannot change a durable result. */
      }
    }
  }
  function settlePrivacy(saved: boolean, generation: number) {
    if (disposed || generation !== privacyGeneration) return;
    privacyUnconfirmed = !saved;
    recordingBlocked = !saved || !record.enabled;
    publish({ ...snapshot, error: saved ? null : snapshot.error });
  }
  function time(): number | null {
    try {
      const value = now();
      if (validTime(value)) return value;
    } catch {
      /* Report safe fixed copy. */
    }
    publish({ ...snapshot, error: clockError });
    return null;
  }
  function retained(value: RecentlyViewedRecord, at: number): RecentlyViewedRecord {
    return Object.freeze({
      enabled: value.enabled,
      entries: Object.freeze(
        value.entries.filter((entry) => at - entry.openedAt < RECENTLY_VIEWED_RETENTION_MS),
      ),
    });
  }
  async function load(force = false): Promise<number | null> {
    if (disposed || (admission === 'invalid' && !force)) return null;
    if (force || admission === 'unread') {
      let text: string | null;
      try {
        text = await read();
      } catch {
        admission = 'unread';
        publish({
          ...snapshot,
          hydrated: true,
          error:
            'Recently viewed storage is unavailable. Saved history has not been replaced. Retry when storage is available.',
        });
        return null;
      }
      if (disposed) return null;
      const at = time();
      if (at === null) {
        publish({ ...snapshot, hydrated: true });
        return null;
      }
      const decoded = decodeRecentlyViewed(text, at);
      if (!decoded.ok) {
        admission = 'invalid';
        publish({
          ...snapshot,
          hydrated: true,
          error:
            decoded.reason === 'clock-changed'
              ? clockError
              : decoded.reason === 'unsupported-version'
                ? 'Recently viewed was saved by a newer CookMate version and has been kept unchanged. Update the app to edit it.'
                : 'Saved recently viewed history could not be read safely and has been kept unchanged.',
        });
        return null;
      }
      record = decoded.value;
      admission = 'ready';
      publish({ ...snapshot, ...retained(record, at), hydrated: true, error: null });
      return at;
    }
    const at = time();
    if (at === null) return null;
    // A backward clock must neither delete newer confirmed entries nor write unsorted timestamps.
    if (record.entries.some((entry) => entry.openedAt > at)) {
      publish({ ...snapshot, error: clockError });
      return null;
    }
    return at;
  }
  async function persist(
    next: RecentlyViewedRecord,
    canPublish: () => boolean = () => true,
    canWrite: () => boolean = () => true,
  ): Promise<boolean> {
    if (disposed || !current(canWrite)) return false;
    if (!sameRecord(record, next)) {
      try {
        await write(encodeRecentlyViewed(next));
      } catch {
        admission = 'unread';
        publish({
          ...snapshot,
          error:
            'The recently viewed change could not be confirmed. Retry to check the saved record before changing it again.',
        });
        return false;
      }
      if (disposed) return false;
      record = next;
    }
    if (!current(canPublish)) return false;
    publish({ ...snapshot, ...next, hydrated: true, error: null });
    return true;
  }
  function enqueue(work: () => Promise<boolean>, saving: boolean): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (saving) pending++;
    const result = queue
      .then(() => (disposed ? false : work()))
      .finally(() => {
        if (saving && --pending === 0) publish({ ...snapshot, saving: false });
      });
    queue = result.then(() => undefined);
    if (saving && !snapshot.saving) publish({ ...snapshot, saving: true });
    return result;
  }
  const inspect = (force: boolean) =>
    enqueue(async () => {
      const at = await load(force);
      return at !== null && persist(retained(record, at));
    }, false).then(() => undefined);

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate: () => inspect(false),
    refresh: () => inspect(true),
    setEnabled(enabled: boolean) {
      if (disposed) return Promise.resolve(false);
      if (typeof enabled !== 'boolean') {
        publish({ ...snapshot, error: 'That recently viewed setting is not supported.' });
        return Promise.resolve(false);
      }
      const generation = ++privacyGeneration;
      recordingBlocked = true;
      return enqueue(async () => {
        const at = await load();
        const saved = at !== null && await persist(
          Object.freeze({ ...retained(record, at), enabled }),
          () => generation === privacyGeneration,
        );
        settlePrivacy(saved, generation);
        return saved;
      }, true);
    },
    recordOpen(input: RecipeContentRef, isCurrent: () => boolean = () => true) {
      if (
        disposed ||
        recordingBlocked ||
        (admission === 'ready' && !record.enabled) ||
        !current(isCurrent)
      )
        return Promise.resolve(false);
      let ref: Readonly<RecipeContentRef> | null;
      try {
        ref = copyRef(input);
      } catch {
        ref = null;
      }
      if (!ref) {
        publish({
          ...snapshot,
          error: 'That recipe version could not be added to recently viewed.',
        });
        return Promise.resolve(false);
      }
      const ownedRef = ref;
      const openedAt = time();
      if (openedAt === null) return Promise.resolve(false);
      const generation = privacyGeneration;
      const active = () =>
        generation === privacyGeneration && !recordingBlocked && current(isCurrent);
      return enqueue(async () => {
        if (!active()) return false;
        const at = await load();
        if (
          at === null ||
          !active() ||
          !record.enabled ||
          at - openedAt >= RECENTLY_VIEWED_RETENTION_MS
        )
          return false;
        if (openedAt > at) {
          publish({ ...snapshot, error: clockError });
          return false;
        }
        const entries = [
          Object.freeze({ ref: ownedRef, openedAt }),
          ...retained(record, at).entries.filter((entry) => refKey(entry.ref) !== refKey(ownedRef)),
        ]
          .sort((a, b) => b.openedAt - a.openedAt)
          .slice(0, RECENTLY_VIEWED_LIMIT);
        return persist(
          Object.freeze({ enabled: true, entries: Object.freeze(entries) }),
          active,
          active,
        );
      }, true);
    },
    clear() {
      if (disposed) return Promise.resolve(false);
      const generation = ++privacyGeneration;
      recordingBlocked = true;
      return enqueue(async () => {
        const at = await load();
        const saved = at !== null && await persist(
          Object.freeze({ enabled: record.enabled, entries: Object.freeze([]) }),
          () => generation === privacyGeneration,
        );
        settlePrivacy(saved, generation);
        return saved;
      }, true);
    },
    async drain() {
      let previous: Promise<void>;
      do {
        previous = queue;
        await previous;
      } while (previous !== queue);
    },
    dispose() {
      disposed = true;
      privacyGeneration++;
      recordingBlocked = true;
      listeners.clear();
    },
  });
}
