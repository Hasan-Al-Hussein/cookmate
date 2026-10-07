import type { VerifiedContentPhoto } from '../../data/contentReadingMedia';
import { admitContentPhoto, type ContentPhotoResource } from './contentPhotoResourceTypes';

export function createContentPhotoResource(photo: VerifiedContentPhoto): ContentPhotoResource {
  admitContentPhoto(photo);
  // Blob owns a snapshot; a released verification buffer cannot mutate the displayed photo.
  const blob = new Blob([new Uint8Array(photo.bytes)], { type: photo.mimeType });
  const uri = URL.createObjectURL(blob);
  let released = false;
  return Object.freeze({
    uri,
    release() {
      if (released) return true;
      try {
        URL.revokeObjectURL(uri);
        released = true;
        return true;
      } catch {
        return false;
      }
    },
  });
}
