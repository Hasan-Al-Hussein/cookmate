import { canonicalContentJson, CONTENT_LIMITS } from '@cookmate/catalogue/content';
import type { AdminPublicationIssueRequest } from '../src/contracts';
import {
  issuanceRequestFingerprint,
  sameIssuanceValue,
  validateIssuanceRequest,
} from './issuanceProposal';

export interface PendingIssuance {
  version: 1;
  actorId: string;
  recipeTitle: string;
  request: AdminPublicationIssueRequest;
  requestFingerprint: string;
}
const KEY = 'cookmate.admin.issuance.v1';
type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
async function decode(value: unknown): Promise<PendingIssuance> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !('version' in value) ||
    value.version !== 1 ||
    !('actorId' in value) ||
    typeof value.actorId !== 'string' ||
    !value.actorId ||
    value.actorId.length > 256 ||
    !('recipeTitle' in value) ||
    typeof value.recipeTitle !== 'string' ||
    value.recipeTitle.length > 1000 ||
    !('request' in value) ||
    !validateIssuanceRequest(value.request) ||
    !('requestFingerprint' in value) ||
    typeof value.requestFingerprint !== 'string' ||
    (await issuanceRequestFingerprint(value.request)) !== value.requestFingerprint
  )
    throw new Error('The release recovery record is invalid. It has not been removed.');
  return value as PendingIssuance;
}
export function createIssuanceJournal(storage: JournalStorage) {
  async function read() {
    const text = storage.getItem(KEY);
    if (text === null) return null;
    if (text.length > CONTENT_LIMITS.releaseBytes)
      throw new Error(
        'The release recovery record exceeds the supported size. It has not been removed.',
      );
    const value: unknown = JSON.parse(text);
    canonicalContentJson(value, CONTENT_LIMITS.releaseBytes);
    return decode(value);
  }
  return {
    read,
    async remember(input: PendingIssuance) {
      // Own an exact detached copy before asynchronous validation or storage access.
      const encoded = canonicalContentJson(input, CONTENT_LIMITS.releaseBytes);
      const owned = await decode(JSON.parse(encoded));
      const prior = await read();
      if (prior && !sameIssuanceValue(prior, owned))
        throw new Error('Resolve the earlier release before starting another issuance.');
      storage.setItem(KEY, encoded);
      if (storage.getItem(KEY) !== encoded)
        throw new Error('Release recovery could not be retained. Nothing was sent.');
      return owned;
    },
    async forget(resolved: PendingIssuance) {
      const prior = await read();
      if (!prior) return;
      if (!sameIssuanceValue(prior, resolved))
        throw new Error('The recovery record changed. It has not been removed.');
      storage.removeItem(KEY);
      if (storage.getItem(KEY) !== null)
        throw new Error('The release is resolved, but its recovery record could not be removed.');
    },
  };
}
