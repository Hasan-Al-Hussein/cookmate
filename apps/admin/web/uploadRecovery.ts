export interface UploadReference {
  operationId: string;
  userId: string;
  draftId: string;
  expectedRevision: number;
}
const key = (draftId: string) => `cookmate.admin.upload.v1:${draftId}`;
export function readUploadReference(
  storage: Pick<Storage, 'getItem'>,
  draftId: string,
): UploadReference | null {
  const raw = storage.getItem(key(draftId));
  if (raw === null) return null;
  if (raw.length > 2048) throw new Error('Upload recovery reference is too large');
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    !('version' in value) ||
    value.version !== 1 ||
    !('reference' in value)
  )
    throw new Error('Unsupported upload recovery reference');
  const p = value.reference;
  if (
    !p ||
    typeof p !== 'object' ||
    Object.keys(p).length !== 4 ||
    !('operationId' in p) ||
    typeof p.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.operationId) ||
    !('userId' in p) ||
    typeof p.userId !== 'string' ||
    !p.userId ||
    p.userId.length > 256 ||
    !('draftId' in p) ||
    p.draftId !== draftId ||
    !('expectedRevision' in p) ||
    typeof p.expectedRevision !== 'number' ||
    !Number.isSafeInteger(p.expectedRevision) ||
    p.expectedRevision < 1
  )
    throw new Error('Invalid upload recovery reference');
  return p as UploadReference;
}
export function rememberUploadReference(storage: Storage, reference: UploadReference) {
  const old = readUploadReference(storage, reference.draftId);
  if (old && old.operationId !== reference.operationId)
    throw new Error('Earlier upload must be resolved');
  storage.setItem(key(reference.draftId), JSON.stringify({ version: 1, reference }));
  if (readUploadReference(storage, reference.draftId)?.operationId !== reference.operationId)
    throw new Error('Upload reference was not saved');
}
export function forgetUploadReference(storage: Storage, reference: UploadReference) {
  const old = readUploadReference(storage, reference.draftId);
  if (old && old.operationId !== reference.operationId) throw new Error('Upload reference changed');
  storage.removeItem(key(reference.draftId));
}
