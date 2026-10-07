import { useState, useSyncExternalStore } from 'react';
import { ActionButton, Notice } from '../../components/Controls';
import { IconButton } from '../../components/Icon';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { ContentRecipeReader, type ContentRecipeTarget } from './ContentRecipeReader';
import type { ContentWorkspaceHost } from './contentWorkspaceHost';

/** Private consumer mount, separate from the legacy workspace provider and its bundled lookups. */
export function ContentWorkspaceReader({
  host,
  target,
  onBack,
}: {
  host: ContentWorkspaceHost;
  target: ContentRecipeTarget;
  onBack(): void;
}) {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const [error, setError] = useState(false);
  if (state.status === 'ready')
    return (
      <ContentRecipeReader
        key={state.scopeKey}
        store={host.readerStore}
        scopeKey={state.scopeKey}
        target={target}
        onBack={onBack}
        onCleanupFailure={host.onPhotoCleanupFailure}
      />
    );
  const recovery = state.status === 'recovery_required';
  const confirmed = state.status === 'result_ready';
  return (
    <Page bottomInset>
      <IconButton name="back" label="Back" onPress={onBack} />
      <Notice
        title={
          confirmed
            ? 'Recipe update verified'
            : recovery
              ? 'Check the content update'
              : state.status === 'updating'
                ? 'Checking recipe content…'
                : 'This workspace is closed'
        }
        tone={recovery ? 'caution' : 'neutral'}
      >
        <AppText>
          {confirmed
            ? state.pending?.kind === 'activation'
              ? 'The release is verified on this device. Choosing whether to adopt it is a separate step. Your saved meal versions have not been replaced.'
              : 'Your reviewed recipe change is saved. Continue to read the recipes in this workspace.'
            : recovery
              ? 'The update result has not been confirmed. Check its saved receipt before using these recipes again.'
              : state.status === 'updating'
                ? 'Checking the saved result before showing this workspace again.'
                : 'Return to your current workspace to continue.'}
        </AppText>
      </Notice>
      {recovery && (
        <ActionButton
          label="Check saved result"
          onPress={() => {
            setError(false);
            void host.recoverUpdate().catch(() => setError(true));
          }}
        />
      )}
      {confirmed && (
        <ActionButton
          label="Continue"
          onPress={() => {
            setError(false);
            void host.acknowledgeUpdate().catch(() => setError(true));
          }}
        />
      )}
      {error && (recovery || confirmed) && (
        <AppText role="support">
          The saved result could not be acknowledged. You can try again; this does not send another
          update.
        </AppText>
      )}
    </Page>
  );
}
