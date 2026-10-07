import type { ContentVerificationPorts } from '../../data/contentReleaseStore';
import {
  ContentVerificationCapabilityError,
  type ContentVerificationOptions,
} from './contentVerificationTypes';
export * from './contentVerificationTypes';

/** Native byte decoding/cleanup has not been implemented or accepted. Never trust manifest dimensions. */
export async function createContentVerificationPorts(
  _options: ContentVerificationOptions,
): Promise<ContentVerificationPorts> {
  throw new ContentVerificationCapabilityError('native_unavailable');
}
