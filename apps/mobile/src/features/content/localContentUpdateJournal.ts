import { localAccountStorage } from '../account/localAccountStorage';
import { createLocalContentUpdateJournal } from './contentUpdateJournal';

/** Platform-resolved localStorage on web, Expo SQLite key/value storage on native. */
export function localContentUpdateJournal(installationId: string, ownerId: string | null) {
  return createLocalContentUpdateJournal(installationId, ownerId, localAccountStorage);
}
