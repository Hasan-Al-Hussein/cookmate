import { canonicalContentJson } from '@cookmate/catalogue/content';
import { isUtcInstant } from '@cookmate/contracts';
import type { Immutable } from '@cookmate/domain';
import { isAppId } from '../../data/conversationRecords';
import { freezeResult } from '../../data/query';
import {
  validateDismissContentCookingSessionInput,
  validateSaveContentCookingSessionInput,
} from '../../data/contentCookingRecords';
import type { ContentCookingSessionRequest } from '../../data/contentCookingSessions';
import {
  validateContentCookedRecoveryReference,
  type ContentCookedRecoveryReference,
} from '../../data/contentCookingHistoryRecords';
export type ContentCookingReference = { createdAt: string } & (
  | { kind: 'session'; request: ContentCookingSessionRequest }
  | { kind: 'cooked'; reference: ContentCookedRecoveryReference }
);
export const contentCookingReferenceId = (value: Immutable<ContentCookingReference>) =>
  value.kind === 'session' ? value.request.input.operationId : value.reference.eventId;
export const contentCookingReferenceRecipe = (value: Immutable<ContentCookingReference>) =>
  value.kind === 'cooked'
    ? value.reference.contentRef.recipeId
    : value.request.kind === 'save'
      ? value.request.input.contentRef.recipeId
      : value.request.input.recipeId;
const same = (a: unknown, b: unknown) =>
  canonicalContentJson(a, 128 * 1024) === canonicalContentJson(b, 128 * 1024);
function own(value: unknown): Immutable<ContentCookingReference> {
  const copy: unknown = JSON.parse(canonicalContentJson(value, 8192));
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    throw new Error('Invalid cooking reference');
  const v = copy as Record<string, unknown>;
  if (Object.keys(v).length !== 3 || typeof v.createdAt !== 'string' || !isUtcInstant(v.createdAt))
    throw new Error('Invalid cooking reference');
  if (v.kind === 'cooked') {
    if (!validateContentCookedRecoveryReference(v.reference))
      throw new Error('Invalid cooking reference');
  } else if (v.kind === 'session') {
    const r = v.request;
    if (
      !r ||
      typeof r !== 'object' ||
      Array.isArray(r) ||
      Object.keys(r).length !== 2 ||
      !('kind' in r) ||
      !('input' in r) ||
      !(r.kind === 'save'
        ? validateSaveContentCookingSessionInput(r.input)
        : r.kind === 'dismiss' && validateDismissContentCookingSessionInput(r.input))
    )
      throw new Error('Invalid cooking reference');
  } else throw new Error('Invalid cooking reference');
  return freezeResult(copy as ContentCookingReference);
}
export function createContentCookingReferenceStore(storage: {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}) {
  const read = storage.read.bind(storage),
    write = storage.write.bind(storage);
  const listeners = new Map<
    string,
    Set<(records: readonly Immutable<ContentCookingReference>[]) => void>
  >();
  let queue = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const key = (installationId: string) => {
    if (!isAppId(installationId)) throw new Error('Invalid installation');
    return `cookmate.content-cooking-recovery.${installationId}`;
  };
  function decode(
    text: string | null,
    installationId: string,
  ): readonly Immutable<ContentCookingReference>[] {
    if (text === null) return [];
    if (text.length > 128 * 1024) throw new Error('Cooking references exceed limit');
    const value: unknown = JSON.parse(text);
    canonicalContentJson(value, 128 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid cooking references');
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).length !== 3 ||
      v.formatVersion !== 1 ||
      v.installationId !== installationId ||
      !Array.isArray(v.records) ||
      v.records.length > 20
    )
      throw new Error('Invalid cooking references');
    const records = v.records.map(own);
    if (new Set(records.map(contentCookingReferenceId)).size !== records.length)
      throw new Error('Duplicate cooking reference');
    return Object.freeze(records);
  }
  async function save(
    installationId: string,
    records: readonly Immutable<ContentCookingReference>[],
  ) {
    const text = canonicalContentJson({ formatVersion: 1, installationId, records }, 128 * 1024);
    await write(key(installationId), text);
    const confirmed = decode(await read(key(installationId)), installationId);
    if (!same(confirmed, records)) throw new Error('Cooking reference write unconfirmed');
    for (const listener of listeners.get(installationId) ?? []) {
      try {
        listener(confirmed);
      } catch {}
    }
    return confirmed;
  }
  return Object.freeze({
    subscribe(
      installationId: string,
      listener: (records: readonly Immutable<ContentCookingReference>[]) => void,
    ) {
      key(installationId);
      const set = listeners.get(installationId) ?? new Set();
      set.add(listener);
      listeners.set(installationId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(installationId);
      };
    },
    load(installationId: string) {
      const storageKey = key(installationId);
      return serial(async () => decode(await read(storageKey), installationId));
    },
    remember(installationId: string, input: Immutable<ContentCookingReference>) {
      const storageKey = key(installationId),
        record = own(input);
      return serial(async () => {
        const records = decode(await read(storageKey), installationId),
          previous = records.find(
            (entry) => contentCookingReferenceId(entry) === contentCookingReferenceId(record),
          );
        if (previous) {
          if (!same(previous, record)) throw new Error('Cooking reference changed');
          return records;
        }
        if (records.length) throw new Error('Resolve earlier cooking changes');
        return save(installationId, [...records, record]);
      });
    },
    release(installationId: string, input: Immutable<ContentCookingReference>) {
      const storageKey = key(installationId),
        record = own(input);
      return serial(async () => {
        const records = decode(await read(storageKey), installationId),
          previous = records.find(
            (entry) => contentCookingReferenceId(entry) === contentCookingReferenceId(record),
          );
        if (!previous) return records;
        if (!same(previous, record)) throw new Error('Cooking reference changed');
        return save(
          installationId,
          records.filter((entry) => entry !== previous),
        );
      });
    },
  });
}
export type ContentCookingReferenceStore = ReturnType<typeof createContentCookingReferenceStore>;
