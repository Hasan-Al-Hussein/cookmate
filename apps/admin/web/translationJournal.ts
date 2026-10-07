import { canonicalContentJson } from '@cookmate/catalogue/content';
import type {
  AdminTranslationInput,
  AdminTranslationMutation,
} from '../src/translations/contracts';
import { ApiError } from './api';

export type TranslationWrite = { draftId: string; sourceRevision: number } & (
  | {
      kind: 'create';
      originalLanguage: string;
      targetLanguage: string;
      input: AdminTranslationInput;
    }
  | { kind: 'save' | 'rebase'; id: string; expectedRevision: number; input: AdminTranslationInput }
  | {
      kind: 'review';
      id: string;
      expectedRevision: number;
      decision: 'approved' | 'changes_requested';
      note: string;
      acknowledgeHumanReview: boolean;
    }
);
export interface PendingTranslation {
  version: 1;
  userId: string;
  operationId: string;
  requestFingerprint: string;
  draftId: string;
  sourceRevision: number;
  translationId: string | null;
  expectedRevision: number | null;
  kind: TranslationWrite['kind'];
}
const KEY = 'cookmate.admin.translation.pending.v1';
const same = (a: unknown, b: unknown) =>
  canonicalContentJson(a, 4096) === canonicalContentJson(b, 4096);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const fingerprint = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function decode(value: unknown): PendingTranslation {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'draftId,expectedRevision,kind,operationId,requestFingerprint,sourceRevision,translationId,userId,version'
  )
    throw new Error('Translation recovery reference is invalid. It was retained.');
  const p = value as PendingTranslation;
  if (
    p.version !== 1 ||
    !id(p.userId) ||
    !id(p.operationId) ||
    !id(p.draftId) ||
    !positive(p.sourceRevision) ||
    !fingerprint(p.requestFingerprint) ||
    !['create', 'save', 'rebase', 'review'].includes(p.kind) ||
    (p.kind === 'create'
      ? p.translationId !== null || p.expectedRevision !== null
      : !id(p.translationId) || !positive(p.expectedRevision))
  )
    throw new Error('Translation recovery reference is invalid. It was retained.');
  return Object.freeze(p);
}
export function createTranslationJournal(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  function read(): PendingTranslation | null {
    const raw = storage.getItem(KEY);
    if (raw === null) return null;
    if (raw.length > 4096)
      throw new Error('Translation recovery reference exceeds supported bounds.');
    return decode(JSON.parse(raw));
  }
  return {
    read,
    remember(input: PendingTranslation) {
      const encoded = canonicalContentJson(input, 4096);
      const owned = decode(JSON.parse(encoded));
      const previous = read();
      if (previous && !same(previous, owned))
        throw new Error('Resolve the previous translation change first.');
      storage.setItem(KEY, encoded);
      if (storage.getItem(KEY) !== encoded)
        throw new Error('Translation recovery could not be retained. Nothing was sent.');
      return owned;
    },
    forget(expected: PendingTranslation) {
      const previous = read();
      if (!previous || !same(previous, expected))
        throw new Error('Translation recovery changed. It was not cleared.');
      storage.removeItem(KEY);
      if (storage.getItem(KEY) !== null)
        throw new Error('Translation recovery could not be cleared.');
    },
  };
}
export async function prepareTranslationWrite(
  input: TranslationWrite,
  userId: string,
  operationId: string,
) {
  // Freeze the complete request value before hashing; the journal stores only identifiers and digest.
  const write: TranslationWrite = JSON.parse(canonicalContentJson(input, 1024 * 1024 + 8192));
  function freezeOwned(value: unknown): void {
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) freezeOwned(item);
      Object.freeze(value);
    }
  }
  freezeOwned(write);
  let bound: unknown;
  if (write.kind === 'create') {
    bound = {
      draftId: write.draftId,
      request: {
        operationId,
        sourceRevision: write.sourceRevision,
        originalLanguage: write.originalLanguage,
        targetLanguage: write.targetLanguage,
        input: write.input,
      },
    };
  } else {
    const action =
      write.kind === 'review'
        ? {
            kind: write.kind,
            decision: write.decision,
            note: write.note,
            acknowledgeHumanReview: write.acknowledgeHumanReview,
          }
        : write.kind === 'rebase'
          ? { kind: write.kind, sourceRevision: write.sourceRevision, input: write.input }
          : { kind: write.kind, input: write.input };
    bound = { id: write.id, operationId, expectedRevision: write.expectedRevision, action };
  }
  const bytes = new TextEncoder().encode(canonicalContentJson(bound, 1024 * 1024 + 16384));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const requestFingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const pending = decode({
    version: 1,
    userId,
    operationId,
    requestFingerprint,
    draftId: write.draftId,
    sourceRevision: write.sourceRevision,
    kind: write.kind,
    translationId: write.kind === 'create' ? null : write.id,
    expectedRevision: write.kind === 'create' ? null : write.expectedRevision,
  });
  return Object.freeze({ write, pending });
}
export function validateTranslationMutation(
  pending: PendingTranslation,
  input: AdminTranslationMutation,
): AdminTranslationMutation {
  const result: AdminTranslationMutation = JSON.parse(
    canonicalContentJson(input, 1024 * 1024 + 32768),
  );
  const record = result?.translation;
  if (
    result?.operationId !== pending.operationId ||
    result.requestFingerprint !== pending.requestFingerprint ||
    !record ||
    !id(record.translationId) ||
    (pending.translationId !== null && record.translationId !== pending.translationId) ||
    record.revision !== (pending.expectedRevision === null ? 1 : pending.expectedRevision + 1) ||
    record.source?.draftId !== pending.draftId ||
    record.source.revision !== pending.sourceRevision ||
    !record.input ||
    !Array.isArray(record.input.ingredients) ||
    !Array.isArray(record.input.instructions) ||
    !['draft', 'reviewed', 'changes_requested'].includes(record.status) ||
    !['draft', 'reviewed', 'changes_requested', 'stale'].includes(record.effectiveStatus)
  )
    throw new ApiError(
      0,
      'translation_receipt_mismatch',
      'The translation receipt does not match this request. Its recovery reference is retained.',
    );
  return result;
}
