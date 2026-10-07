/** The native adapter supplies device-only encrypted storage; no cooking data is written here. */
export interface AccountCredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
const maximumBytes = 64 * 1024;
// A JS character takes at most three UTF-8 bytes unless paired; this stays below 2 KiB.
const chunkCharacters = 350;
const maximumChunks = Math.ceil(maximumBytes / chunkCharacters);
export class AccountCredentialStorageError extends Error {
  constructor() {
    super('Account session storage is unavailable');
  }
}

/** Two encrypted slots keep the preceding session valid if a token refresh is interrupted. */
export function createAccountSessionStorage(
  store: AccountCredentialStore,
  hashKey: (key: string) => Promise<string>,
) {
  let queue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation).catch(() => {
      throw new AccountCredentialStorageError();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  async function prefix(key: string) {
    if (!/^cookmate\.account\.auth(?:-[A-Za-z0-9_-]{1,160})?$/.test(key))
      throw new AccountCredentialStorageError();
    const digest = await hashKey(key);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new AccountCredentialStorageError();
    return `cookmate.auth.${digest}`;
  }
  async function count(slot: string) {
    const raw = await store.get(`${slot}.count`);
    if (raw === null) return 0;
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > maximumChunks)
      throw new AccountCredentialStorageError();
    return Number(raw);
  }
  async function clearSlot(slot: string) {
    const chunks = await count(slot);
    for (let index = 0; index < chunks; index++) await store.remove(`${slot}.${index}`);
    await store.remove(`${slot}.count`);
  }
  return {
    getItem(key: string): Promise<string | null> {
      return serial(async () => {
        const root = await prefix(key),
          active = await store.get(root);
        if (active === null) return null;
        if (active !== 'a' && active !== 'b') throw new AccountCredentialStorageError();
        const slot = `${root}.${active}`,
          chunks = await count(slot);
        if (!chunks) throw new AccountCredentialStorageError();
        let value = '';
        for (let index = 0; index < chunks; index++) {
          const chunk = await store.get(`${slot}.${index}`);
          if (chunk === null || chunk.length > chunkCharacters)
            throw new AccountCredentialStorageError();
          value += chunk;
        }
        if (new TextEncoder().encode(value).byteLength > maximumBytes)
          throw new AccountCredentialStorageError();
        return value;
      });
    },
    setItem(key: string, value: string): Promise<void> {
      return serial(async () => {
        if (!value || new TextEncoder().encode(value).byteLength > maximumBytes)
          throw new AccountCredentialStorageError();
        const root = await prefix(key),
          active = await store.get(root);
        if (active !== null && active !== 'a' && active !== 'b')
          throw new AccountCredentialStorageError();
        const next = active === 'a' ? 'b' : 'a',
          slot = `${root}.${next}`;
        await clearSlot(slot);
        const chunks: string[] = [];
        for (let start = 0; start < value.length; ) {
          let end = Math.min(start + chunkCharacters, value.length);
          const last = value.charCodeAt(end - 1);
          if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
          chunks.push(value.slice(start, end));
          start = end;
        }
        // Save the bounded count first so an interrupted write can be cleaned on the next attempt.
        await store.set(`${slot}.count`, String(chunks.length));
        for (let index = 0; index < chunks.length; index++)
          await store.set(`${slot}.${index}`, chunks[index]!);
        await store.set(root, next);
        // Cleanup is best effort only after the active pointer is durably acknowledged.
        if (active) {
          try {
            await clearSlot(`${root}.${active}`);
          } catch {
            /* Encrypted stale slot; retry cleanup at the next refresh. */
          }
        }
      });
    },
    removeItem(key: string): Promise<void> {
      return serial(async () => {
        const root = await prefix(key);
        await store.remove(root);
        await clearSlot(`${root}.a`);
        await clearSlot(`${root}.b`);
      });
    },
  };
}
