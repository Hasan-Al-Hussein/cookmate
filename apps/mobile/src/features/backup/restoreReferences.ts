export interface RestoreReference {
  operationId: string;
  preparedAt: string;
}
export interface RestoreReferenceStore {
  load(installationId: string): Promise<readonly RestoreReference[]>;
  remember(
    installationId: string,
    reference: RestoreReference,
  ): Promise<readonly RestoreReference[]>;
  /** Only the current attempt's conclusively unused reference may be removed. */
  forget(
    installationId: string,
    operationId: string,
    reason: 'not_dispatched' | 'definite_failure',
  ): Promise<readonly RestoreReference[]>;
}
export interface RestoreReferenceStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}
const LIMIT = 20;
const MAX_BYTES = 4096;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function key(installationId: string) {
  if (!id(installationId)) throw new Error('Invalid restore-reference workspace');
  return `cookmate.restore-references.${installationId}`;
}
function validReference(value: unknown): value is RestoreReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return (
    Object.keys(reference).length === 2 &&
    id(reference.operationId) &&
    typeof reference.preparedAt === 'string' &&
    reference.preparedAt.length === 24 &&
    Number.isFinite(Date.parse(reference.preparedAt)) &&
    new Date(reference.preparedAt).toISOString() === reference.preparedAt
  );
}
function decode(text: string | null, installationId: string): readonly RestoreReference[] {
  if (text === null) return [];
  if (text.length > MAX_BYTES) throw new Error('Restore references are too large');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid restore references');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schemaVersion !== 1 ||
    record.installationId !== installationId ||
    !Array.isArray(record.operations) ||
    record.operations.length > LIMIT ||
    !record.operations.every(validReference) ||
    new Set(record.operations.map((item) => item.operationId)).size !== record.operations.length
  )
    throw new Error('Unsupported restore references');
  return Object.freeze(record.operations.map((reference) => Object.freeze({ ...reference })));
}

/** Recovery metadata only: it cannot reconstruct a prepared restore capability or private JSON. */
export function createRestoreReferenceStore(
  storage: RestoreReferenceStorage,
): RestoreReferenceStore {
  let queue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    load: (installationId) =>
      serialize(async () => decode(await storage.read(key(installationId)), installationId)),
    remember: (installationId, reference) =>
      serialize(async () => {
        if (!validReference(reference)) throw new Error('Invalid restore reference');
        const storageKey = key(installationId);
        const previous = decode(await storage.read(storageKey), installationId);
        if (previous.some((entry) => entry.operationId === reference.operationId)) return previous;
        if (previous.length >= LIMIT) throw new Error('Restore reference journal is full');
        const operations = [...previous, { ...reference }];
        const serialized = JSON.stringify({ schemaVersion: 1, installationId, operations });
        if (serialized.length > MAX_BYTES) throw new Error('Restore references are too large');
        await storage.write(storageKey, serialized);
        return decode(serialized, installationId);
      }),
    forget: (installationId, operationId, reason) =>
      serialize(async () => {
        if (!id(operationId) || (reason !== 'not_dispatched' && reason !== 'definite_failure'))
          throw new Error('Invalid restore-reference release');
        const storageKey = key(installationId);
        const previous = decode(await storage.read(storageKey), installationId);
        const operations = previous.filter((entry) => entry.operationId !== operationId);
        if (operations.length === previous.length) return previous;
        const serialized = JSON.stringify({ schemaVersion: 1, installationId, operations });
        await storage.write(storageKey, serialized);
        return decode(serialized, installationId);
      }),
  };
}
