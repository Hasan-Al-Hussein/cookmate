import { View } from 'react-native';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { usePageStyles } from '../../components/Page';
import { useAssistant } from './useAssistant';

export function AssistantRecoveryFeedback() {
  const pageStyles = usePageStyles();

  const { assistant, state } = useAssistant();
  if (!assistant || !state) return null;
  const recovery = state.recovery;
  if (state.mutating)
    return (
      <Notice title="Saving the reviewed assistant changes…">
        Other changes are paused until the saved results are checked. You can keep browsing.
      </Notice>
    );
  if (recovery.kind === 'loading')
    return (
      <Notice title="Checking earlier assistant changes…">
        New changes are paused while saved results are checked. You can keep browsing.
      </Notice>
    );
  if (recovery.kind === 'failed')
    return (
      <Notice title="Earlier assistant changes need checking" tone="caution">
        <AppText role="support">
          The saved results changed during checking or could not be read. New changes are paused; no
          action has been repeated.
        </AppText>
        <ActionButton
          label="Check earlier assistant results"
          onPress={() => void assistant.recovery.check()}
        />
      </Notice>
    );
  return (
    <View style={pageStyles.section}>
      {recovery.unresolvedIds.map((id, index) => (
        <Notice key={id} title={`Unfinished assistant change ${index + 1}`} tone="caution">
          <AppText role="support">
            Its outcome is not yet confirmed. New changes are paused. Check which changes were
            saved; stopping unfinished work preserves anything already committed.
          </AppText>
          <ActionButton
            label={`Check assistant change ${index + 1}`}
            variant="secondary"
            disabled={state.busy}
            onPress={() => void assistant.runAction(id, () => assistant.core.reconcile(id))}
          />
          <ActionButton
            label={`Stop unfinished assistant change ${index + 1}`}
            variant="quiet"
            disabled={state.busy}
            onPress={() => void assistant.cancel(id)}
          />
        </Notice>
      ))}
    </View>
  );
}
