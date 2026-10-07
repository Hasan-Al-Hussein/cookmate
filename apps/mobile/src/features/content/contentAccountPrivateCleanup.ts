import { createContentPrivateState } from './contentPrivateState';
import { contentUpdateJournalKey } from './contentUpdateJournal';

interface RemovalStorage {
  read(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

export interface ContentAccountPrivateCleanupPorts {
  /** Raw content metadata storage, without a second account/settings prefix. */
  metadata: RemovalStorage;
  /** The platform owns the physical session key; these methods take a draft scope key. */
  sessionDraft: RemovalStorage;
}

/** The lifecycle must hold its closed-workspace lease throughout this operation.
 * Only reference metadata, local planning defaults, the content-update journal and the assistant draft are owned
 * here. Account settings, lifecycle/deletion recovery and credentials have other owners.
 */
export async function removeContentAccountPrivateState(
  scope: Readonly<{ installationId: string; ownerId: string }>,
  options: ContentAccountPrivateCleanupPorts,
): Promise<void> {
  const metadata = {
    read: options.metadata.read.bind(options.metadata),
    remove: options.metadata.remove.bind(options.metadata),
  };
  const sessionDraft = {
    read: options.sessionDraft.read.bind(options.sessionDraft),
    remove: options.sessionDraft.remove.bind(options.sessionDraft),
  };
  const state = createContentPrivateState(scope, {
    read: metadata.read,
    async write() {
      throw new Error('Private-state cleanup cannot write records');
    },
  });
  if (state.scope.ownerId === null) throw new Error('An account owner is required for cleanup');
  const keys = [
    ...state.storageKeys,
    contentUpdateJournalKey(state.scope.installationId, state.scope.ownerId),
  ];
  async function absent(storage: RemovalStorage, key: string) {
    if ((await storage.read(key)) !== null)
      throw new Error('Account private-state removal was not confirmed');
  }
  async function remove(storage: RemovalStorage, key: string) {
    try {
      await storage.remove(key);
    } catch {
      // A lost acknowledgement is settled only by confirming this exact key is absent.
    }
    await absent(storage, key);
  }
  for (const key of keys) await remove(metadata, key);
  await remove(sessionDraft, state.draftScopeKey);
  // Do not report success if another retained key reappeared during an earlier await.
  for (const key of keys) await absent(metadata, key);
  await absent(sessionDraft, state.draftScopeKey);
}
