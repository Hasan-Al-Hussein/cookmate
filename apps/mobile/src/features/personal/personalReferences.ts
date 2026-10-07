export interface PersonalReference {
  operationId: string;
  createdAt: string;
}
export type PersonalReferenceProof = 'receipt' | 'definite_failure' | 'not_dispatched';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function decode(text: string | null, installationId: string): readonly PersonalReference[] {
  if (text === null) return [];
  if (text.length > 8192) throw new Error('Recovery metadata is too large');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery metadata');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schemaVersion !== 1 ||
    record.installationId !== installationId ||
    !Array.isArray(record.operations) ||
    record.operations.length > 20
  )
    throw new Error('Unsupported recovery metadata');
  const references: PersonalReference[] = [];
  for (const item of record.operations) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).length !== 2 ||
      !uuid(item.operationId) ||
      typeof item.createdAt !== 'string' ||
      item.createdAt.length !== 24 ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      new Date(item.createdAt).toISOString() !== item.createdAt ||
      references.some((entry) => entry.operationId === item.operationId)
    )
      throw new Error('Invalid recovery reference');
    references.push(Object.freeze({ operationId: item.operationId, createdAt: item.createdAt }));
  }
  return Object.freeze(references);
}
/** Only opaque IDs and timestamps, never private content or executable requests. */
export function createPersonalReferenceStore(storage: {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}) {
  let queue = Promise.resolve();
  const listeners = new Set<() => void>();
  const serial = <T>(work: () => Promise<T>) => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const key = (id: string) => {
    if (!uuid(id)) throw new Error('Invalid installation');
    return `cookmate.personal-recovery.${id}`;
  };
  const load = async (id: string) => decode(await storage.read(key(id)), id);
  const write = async (id: string, operations: readonly PersonalReference[]) => {
    const text = JSON.stringify({ schemaVersion: 1, installationId: id, operations });
    const validated = decode(text, id);
    await storage.write(key(id), text);
    for (const listener of listeners) listener();
    return validated;
  };
  return {
    load: (id: string) => serial(() => load(id)),
    remember: (id: string, operationId: string) =>
      serial(async () => {
        if (!uuid(operationId)) throw new Error('Invalid operation');
        const previous = await load(id);
        if (previous.some((item) => item.operationId === operationId)) return previous;
        if (previous.length >= 20) throw new Error('Resolve earlier personal changes first');
        return write(id, [...previous, { operationId, createdAt: new Date().toISOString() }]);
      }),
    release: (id: string, operationId: string, proof: PersonalReferenceProof) =>
      serial(async () => {
        if (
          !uuid(operationId) ||
          !['receipt', 'definite_failure', 'not_dispatched'].includes(proof)
        )
          throw new Error('Terminal proof required');
        const previous = await load(id);
        const remaining = previous.filter((item) => item.operationId !== operationId);
        return remaining.length === previous.length ? previous : write(id, remaining);
      }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
