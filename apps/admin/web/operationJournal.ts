export interface PendingOperation {
  operationId: string;
  userId: string;
  kind: 'create' | 'save' | 'restore' | 'review' | 'rights' | 'metadata';
  draftId: string | null;
  createdAt: string;
}
const KEY = 'cookmate.admin.pending.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function read(storage: Pick<Storage, 'getItem'>): PendingOperation | null {
  const text = storage.getItem(KEY);
  if (text === null) return null;
  if (text.length > 4096)
    throw new Error('Recovery reference is too large. Existing storage was not changed.');
  const data: unknown = JSON.parse(text);
  if (
    !data ||
    typeof data !== 'object' ||
    Object.keys(data).length !== 2 ||
    !('version' in data) ||
    data.version !== 1 ||
    !('pending' in data)
  )
    throw new Error('Recovery storage cannot be read by this version. It was not changed.');
  const p = data.pending;
  if (
    !p ||
    typeof p !== 'object' ||
    Object.keys(p).length !== 5 ||
    !('operationId' in p) ||
    typeof p.operationId !== 'string' ||
    !UUID.test(p.operationId) ||
    !('userId' in p) ||
    typeof p.userId !== 'string' ||
    !p.userId ||
    p.userId.length > 256 ||
    !('kind' in p) ||
    !['create', 'save', 'restore', 'review', 'rights', 'metadata'].includes(String(p.kind)) ||
    !('draftId' in p) ||
    !(p.draftId === null || (typeof p.draftId === 'string' && p.draftId.length <= 256)) ||
    !('createdAt' in p) ||
    typeof p.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(p.createdAt))
  )
    throw new Error('Recovery reference is invalid. Existing storage was not changed.');
  return p as PendingOperation;
}
export function createOperationJournal(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  return {
    read: () => read(storage),
    remember(pending: PendingOperation) {
      const previous = read(storage);
      if (previous && previous.operationId !== pending.operationId)
        throw new Error('Resolve the earlier operation before making another change.');
      storage.setItem(KEY, JSON.stringify({ version: 1, pending }));
      if (read(storage)?.operationId !== pending.operationId)
        throw new Error('The recovery reference could not be retained. Nothing was sent.');
    },
    forget(operationId: string) {
      const previous = read(storage);
      if (!previous) return;
      if (previous.operationId !== operationId)
        throw new Error('The recovery reference has changed. It was not removed.');
      storage.removeItem(KEY);
      if (read(storage)) throw new Error('The recovery reference could not be removed.');
    },
  };
}
