export interface CookingReference {
  operationId: string;
  kind: 'cooked' | 'clear_history';
  recipeId: string | null;
  createdAt: string;
}
export interface CookingReferenceStore {
  load(installationId: string): Promise<readonly CookingReference[]>;
  remember(
    installationId: string,
    reference: CookingReference,
  ): Promise<readonly CookingReference[]>;
  release(
    installationId: string,
    operationId: string,
    proof: 'receipt' | 'definite_failure' | 'not_dispatched',
  ): Promise<readonly CookingReference[]>;
}
const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function validReference(value: unknown): value is CookingReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return (
    Object.keys(reference).length === 4 &&
    isId(reference.operationId) &&
    (reference.kind === 'clear_history'
      ? reference.recipeId === null
      : reference.kind === 'cooked' &&
        typeof reference.recipeId === 'string' &&
        /^[0-9]{1,12}$/.test(reference.recipeId)) &&
    typeof reference.createdAt === 'string' &&
    reference.createdAt.length === 24 &&
    Number.isFinite(Date.parse(reference.createdAt)) &&
    new Date(reference.createdAt).toISOString() === reference.createdAt
  );
}
function decode(text: string | null, installationId: string): readonly CookingReference[] {
  if (text === null) return [];
  if (text.length > 8192) throw new Error('Cooking recovery references too large');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid cooking recovery references');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schemaVersion !== 1 ||
    record.installationId !== installationId ||
    !Array.isArray(record.operations) ||
    record.operations.length > 20 ||
    !record.operations.every(validReference) ||
    new Set(record.operations.map((item) => item.operationId)).size !== record.operations.length
  )
    throw new Error('Unsupported cooking recovery references');
  return Object.freeze(record.operations.map((item) => Object.freeze({ ...item })));
}
/** Metadata only. These records never contain notes, draft inputs or execution authority. */
export function createCookingReferenceStore(storage: {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}): CookingReferenceStore {
  let queue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const key = (installationId: string) => {
    if (!isId(installationId)) throw new Error('Invalid installation ID');
    return `cookmate.cooking-recovery.${installationId}`;
  };
  const write = async (installationId: string, operations: readonly CookingReference[]) => {
    const serialized = JSON.stringify({ schemaVersion: 1, installationId, operations });
    await storage.write(key(installationId), serialized);
    return decode(serialized, installationId);
  };
  return {
    load: (installationId) =>
      serialize(async () => decode(await storage.read(key(installationId)), installationId)),
    remember: (installationId, reference) =>
      serialize(async () => {
        if (!validReference(reference)) throw new Error('Invalid cooking recovery reference');
        const previous = decode(await storage.read(key(installationId)), installationId);
        if (previous.some((item) => item.operationId === reference.operationId)) return previous;
        if (previous.length >= 20)
          throw new Error('Resolve existing cooking recovery references first');
        return write(installationId, [...previous, reference]);
      }),
    release: (installationId, operationId, proof) =>
      serialize(async () => {
        if (
          !isId(operationId) ||
          !['receipt', 'definite_failure', 'not_dispatched'].includes(proof)
        )
          throw new Error('Cooking recovery proof required');
        const previous = decode(await storage.read(key(installationId)), installationId);
        const remaining = previous.filter((item) => item.operationId !== operationId);
        return remaining.length === previous.length ? previous : write(installationId, remaining);
      }),
  };
}
