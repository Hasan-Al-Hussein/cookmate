import { CONTENT_LIMITS, validateRecipeContentRef } from '@cookmate/catalogue/content';
import type { VerifiedContentPhoto } from '../../data/contentReadingMedia';

/** A display copy of already verified bytes. The caller owns its entire lifetime. */
export interface ContentPhotoResource {
  readonly uri: string;
  /** Idempotent; false means the owned temporary resource could not be released. */
  release(): boolean;
}

/** The owner must retain this capability until cleanup succeeds; no path is shown to the user. */
export class ContentPhotoCleanupError extends Error {
  constructor(readonly resource: ContentPhotoResource) {
    super('Recipe photo temporary copy could not be released');
    this.name = 'ContentPhotoCleanupError';
  }
}

/** This is transport admission, not a replacement for content-store signature/media verification. */
export function admitContentPhoto(photo: VerifiedContentPhoto) {
  if (
    !validateRecipeContentRef(photo.contentRef) ||
    !/^[a-f0-9]{64}$/.test(photo.sha256) ||
    photo.assetId !== `sha256:${photo.sha256}` ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(photo.mimeType) ||
    !(photo.bytes instanceof Uint8Array) ||
    photo.bytes.byteLength < 1 ||
    photo.bytes.byteLength > CONTENT_LIMITS.mediaBytes ||
    !Number.isSafeInteger(photo.width) ||
    !Number.isSafeInteger(photo.height) ||
    photo.width < 1 ||
    photo.height < 1 ||
    photo.width > CONTENT_LIMITS.imageDimension ||
    photo.height > CONTENT_LIMITS.imageDimension
  )
    throw new Error('Verified recipe photo is not displayable');
}
