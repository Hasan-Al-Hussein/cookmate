import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import type { VerifiedContentPhoto } from '../../data/contentReadingMedia';
import {
  admitContentPhoto,
  ContentPhotoCleanupError,
  type ContentPhotoResource,
} from './contentPhotoResourceTypes';

export function createContentPhotoResource(photo: VerifiedContentPhoto): ContentPhotoResource {
  admitContentPhoto(photo);
  const suffix = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[photo.mimeType];
  // No content ID, supplied photoKey, URL or user path becomes a filesystem path.
  const filename = `cookmate-content-photo-${randomUUID()}.${suffix}`;
  const file = new File(Paths.cache, filename);
  const expected = `${Paths.cache.uri.replace(/\/$/, '')}/${filename}`;
  if (file.uri !== expected) throw new Error('Recipe photo cache path differs');
  let owned = false;
  let released = false;
  const release = () => {
    if (released || !owned) return true;
    try {
      if (file.uri !== expected) return false;
      if (file.exists) file.delete();
      released = true;
      return true;
    } catch {
      return false;
    }
  };
  const resource = Object.freeze({ uri: expected, release });
  try {
    file.create({ overwrite: false });
    owned = true;
    file.write(new Uint8Array(photo.bytes));
    return resource;
  } catch (error) {
    if (!release()) throw new ContentPhotoCleanupError(resource);
    throw error;
  }
}
