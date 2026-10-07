import { View } from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { usePageStyles } from '../../components/Page';
import { useOrdinaryWorkspaceActions } from '../content/useOrdinaryWorkspace';
import { formatPlanDate, mealLabel } from './runtimeClock';

export function RecoveryFeedback() {
  const pageStyles = usePageStyles();

  const { mode, recovery, recoveryState: state } = useOrdinaryWorkspaceActions();
  const title = (id: string) =>
    mode === 'content' ? `Recipe ${id}` : (getRecipe(id)?.title ?? 'Recipe');
  if (state.kind === 'loading')
    return (
      <Notice title="Checking earlier saved changes…">
        You can browse while previous changes are checked.
      </Notice>
    );
  if (state.kind === 'failed')
    return (
      <Notice title="Couldn’t check earlier changes" tone="error">
        <AppText role="support">
          New changes are paused until their saved results can be checked. Your recipes remain
          available.
        </AppText>
        <ActionButton label="Check status" onPress={() => void recovery?.check()} />
      </Notice>
    );
  return (
    <View style={pageStyles.section}>
      {state.page.entries.map((entry) => (
        <Notice
          key={entry.operationId}
          title={
            entry.outcome === 'receipt'
              ? entry.receipt?.outcome === 'no_op'
                ? 'An earlier change was already up to date'
                : 'An earlier change was saved'
              : entry.outcome === 'not_executed'
                ? 'An earlier change was not applied'
                : 'An earlier change still needs checking'
          }
          tone={entry.outcome === 'unresolved' ? 'caution' : 'neutral'}
        >
          {entry.outcome === 'receipt' &&
            entry.receipt?.effects.map((effect, index) => (
              <AppText key={index} role="support">
                {effect.kind === 'favourite'
                  ? `${effect.saved ? 'Saved' : 'Unsaved'} ${title(effect.entityId)}.`
                  : effect.kind === 'plan'
                    ? `${title(effect.recipeId)} · ${formatPlanDate(effect.placement.actualDate)}, ${mealLabel(effect.placement.mealKey)} · ${effect.change}.`
                    : effect.kind === 'purchase'
                      ? 'Shopping purchase status saved.'
                      : effect.kind === 'shopping_selection'
                        ? 'Shopping meal selection saved.'
                        : 'Your change was saved.'}
              </AppText>
            ))}
          {entry.outcome === 'not_executed' && (
            <AppText role="support">
              No change was made by this interrupted action. Review your current choices before
              trying it again.
            </AppText>
          )}
          {entry.outcome === 'unresolved' ? (
            <>
              <AppText role="support">
                The result is still unconfirmed. New changes are paused; this action has not been
                repeated.
              </AppText>
              <ActionButton label="Check status" onPress={() => void recovery?.check()} />
            </>
          ) : (
            <ActionButton
              label="Dismiss restored result"
              variant="secondary"
              onPress={() => void recovery?.dismiss(entry.operationId)}
            />
          )}
        </Notice>
      ))}
      {state.page.nextAfterSequence !== null && (
        <Notice title="More earlier results remain">
          <AppText role="support">
            Dismiss the shown results to check the next saved changes.
          </AppText>
          {state.page.entries.length === 0 && (
            <ActionButton label="Check next saved results" onPress={() => void recovery?.next()} />
          )}
        </Notice>
      )}
    </View>
  );
}
