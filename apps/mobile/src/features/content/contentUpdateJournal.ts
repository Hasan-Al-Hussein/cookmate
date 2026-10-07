import { canonicalContentJson } from '@cookmate/catalogue/content';
import { isAppId } from '../../data/conversationRecords';
import type { ContentUpdateIntent, ContentUpdateJournal } from './contentWorkspaceHost';

interface Storage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export function contentUpdateJournalKey(installationId: string, ownerId: string | null): string {
  if (!isAppId(installationId) || (ownerId !== null && !isAppId(ownerId)))
    throw new Error('Invalid content journal owner');
  return `cookmate:content-update:v1:${installationId}:${ownerId ?? 'guest'}`;
}
/** Non-secret receipt identity only. The host must hold the workspace's single-writer lease. */
export function createLocalContentUpdateJournal(
  installationId: string,
  ownerId: string | null,
  storage: Storage,
): ContentUpdateJournal {
  const key = contentUpdateJournalKey(installationId, ownerId);
  const read = storage.read.bind(storage),
    write = storage.write.bind(storage),
    remove = storage.remove.bind(storage);
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }
  function canonical(raw: unknown): string {
    const text = canonicalContentJson(raw, 4096);
    const value = JSON.parse(text) as ContentUpdateIntent;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'fingerprint,installationId,kind,operationId,ownerId,version' ||
      value.version !== 1 ||
      !['activation', 'adoption'].includes(value.kind) ||
      value.installationId !== installationId ||
      value.ownerId !== ownerId ||
      !isAppId(value.operationId) ||
      typeof value.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint)
    )
      throw new Error('Invalid content update receipt identity');
    return text;
  }
  async function retained() {
    const text = await read(key);
    if (text === null) return null;
    if (typeof text !== 'string' || text.length > 4096)
      throw new Error('Content update journal is invalid');
    return canonical(JSON.parse(text));
  }
  return Object.freeze({
    read: () =>
      serial(async () => {
        const value = await retained();
        return value === null ? null : Object.freeze(JSON.parse(value));
      }),
    save: (intent: Readonly<ContentUpdateIntent>) => {
      const owned = canonical(intent);
      return serial(async () => {
        const previous = await retained();
        if (previous !== null && previous !== owned)
          throw new Error('Another content update needs recovery');
        await write(key, owned);
        if ((await retained()) !== owned)
          throw new Error('Content update journal write was not confirmed');
      });
    },
    clear: (intent: Readonly<ContentUpdateIntent>) => {
      const owned = canonical(intent);
      return serial(async () => {
        const previous = await retained();
        if (previous === null) return;
        if (previous !== owned) throw new Error('Content update journal changed');
        await remove(key);
        if ((await retained()) !== null)
          throw new Error('Content update journal clearing was not confirmed');
      });
    },
  });
}
