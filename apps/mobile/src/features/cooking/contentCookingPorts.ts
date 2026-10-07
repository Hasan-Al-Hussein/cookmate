import type { CookingChange, CookMateQueries } from '@cookmate/domain';
import type { createContentCookingSessions } from '../../data/contentCookingSessions';
import type { createContentCookingHistory } from '../../data/contentCookingHistory';
import type { createContentCookingHistoryReader } from '../../data/contentCookingHistoryRead';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
export interface ContentCookingReaderHost extends Pick<
  ContentWorkspaceHost,
  'getSnapshot' | 'subscribe'
> {
  sessions: Pick<
    ReturnType<typeof createContentCookingSessions>,
    'readSession' | 'saveSession' | 'dismissSession' | 'recover'
  >;
  cooked: Pick<
    ReturnType<typeof createContentCookingHistory>,
    'saveCooked' | 'prepareCookedRecovery' | 'readCookedRecovery' | 'resolveCookedRecovery'
  >;
  history: Pick<ReturnType<typeof createContentCookingHistoryReader>, 'readHistory'>;
  readInstallationId: CookMateQueries['readInstallationId'];
  subscribeCooking(listener: (change: CookingChange) => void): () => void;
}
