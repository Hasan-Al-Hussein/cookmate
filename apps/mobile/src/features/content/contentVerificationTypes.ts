import type { ContentTrustKey } from '@cookmate/catalogue/content-trust';

export interface ContentVerificationOptions {
  /** Independently configured host keys; release payloads never supply trust. */
  trustKeys: readonly ContentTrustKey[];
  readerVersion?: number;
}
/** Browser capability cap, stricter than the wire's per-dimension maximum. */
export const CONTENT_BROWSER_MAX_IMAGE_PIXELS = 16_000_000;
export const CONTENT_BROWSER_IO_TIMEOUT_MS = 20_000;
export class ContentVerificationCapabilityError extends Error {
  constructor(readonly reason: 'native_unavailable' | 'browser_unavailable' | 'image_limit') {
    super(
      reason === 'image_limit'
        ? 'This browser verifier supports still images up to 16 million pixels.'
        : 'Verified content media is unavailable in this environment.',
    );
    this.name = 'ContentVerificationCapabilityError';
  }
}
