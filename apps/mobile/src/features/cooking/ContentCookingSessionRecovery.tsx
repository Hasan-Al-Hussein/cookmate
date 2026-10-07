import { useCallback, useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import type { Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import type { ContentCookingSessionView } from '../../data/contentCookingSessions';
import type { ContentCookingReaderHost } from './contentCookingPorts';
import { ContentCookingRecovery } from './ContentCookingRecovery';
import { useContentSessionOperations } from './useContentCookingProgress';
import { useContentCookingScope } from './useContentCookingScope';

export interface ContentCookingSessionRecoveryProps {
  host: ContentCookingReaderHost;
  scopeKey: string;
  view: Immutable<ContentCookingSessionView> | null;
  isCurrent?: () => boolean;
  onConfirmed?: () => Promise<void>;
}
export function ContentCookingPendingRecovery(
  props: Omit<ContentCookingSessionRecoveryProps, 'view'>,
) {
  return <ContentCookingSessionRecovery {...props} view={null} />;
}
export function ContentCookingSessionRecovery(props: ContentCookingSessionRecoveryProps) {
  const state = useSyncExternalStore(
    props.host.subscribe,
    props.host.getSnapshot,
    props.host.getSnapshot,
  );
  return state.status === 'ready' && state.scopeKey === props.scopeKey ? (
    <SessionControls key={props.scopeKey} {...props} />
  ) : null;
}
function SessionControls({
  host,
  scopeKey,
  view,
  isCurrent: parentCurrent,
  onConfirmed,
}: ContentCookingSessionRecoveryProps) {
  const isCurrent = useContentCookingScope(host, scopeKey, true, parentCurrent);
  const confirmed = useCallback(async () => {
    if (isCurrent()) await onConfirmed?.();
  }, [isCurrent, onConfirmed]);
  const operations = useContentSessionOperations(host, isCurrent, confirmed);
  const session = view?.session;
  return (
    <>
      <ContentCookingRecovery
        host={host}
        operations={operations}
        isCurrent={isCurrent}
        onConfirmed={confirmed}
      />
      {session?.state === 'active' &&
        (session.readerVersion === 2 ? (
          <ActionButton
            label="Dismiss saved cooking progress"
            variant="quiet"
            disabled={!operations.ready}
            onPress={() => {
              if (!isCurrent()) return;
              void operations.perform({
                kind: 'dismiss',
                input: {
                  operationId: Crypto.randomUUID(),
                  recipeId: session.recipeId,
                  sessionId: session.sessionId,
                  expectedRevision: session.revision,
                },
              });
            }}
          />
        ) : (
          <Notice title="Earlier reading progress">
            This earlier reading format needs an explicit restart from an available recipe version.
            It has not been marked cooked.
          </Notice>
        ))}
    </>
  );
}
