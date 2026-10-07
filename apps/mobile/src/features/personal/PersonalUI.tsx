import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import type { CookMateQueries, PersonalService } from '@cookmate/domain';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import type { usePersonalOperations } from './usePersonalOperations';

export interface PersonalPorts {
  service: PersonalService;
  readInstallationId: CookMateQueries['readInstallationId'];
}
export function usePersonalPorts(): PersonalPorts | null {
  const { availability } = useWorkspace();
  const content = useOrdinaryContentRuntime();
  return !content && availability.kind === 'ready' && availability.services.personal
    ? {
        service: availability.services.personal,
        readInstallationId: availability.services.queries.readInstallationId,
      }
    : null;
}
export function PersonalUnavailable() {
  return (
    <Notice title="Personal organization is unavailable here">
      This build has no active local service for private notes, collections or manual shopping
      items.
    </Notice>
  );
}
export { PersonalPrivacy } from './PersonalPrivacy';
export function PersonalField({
  label,
  limit,
  ...props
}: TextInputProps & { label: string; limit: number }) {
  const controls = useControlStyles();
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xs }}>
      <AppText role="label">{label}</AppText>
      <TextInput
        {...props}
        accessibilityLabel={label}
        maxLength={limit * 2}
        placeholderTextColor={theme.color.inkSecondary}
        style={[
          controls.field,
          props.multiline && { minHeight: 132, textAlignVertical: 'top' },
          props.style,
        ]}
      />
      <AppText role="support" color="inkSecondary">
        {Array.from(props.value ?? '').length}/{limit} characters
      </AppText>
    </View>
  );
}
export function PersonalOperationFeedback({
  operation,
  quietPurchase = false,
  purchasePending = false,
  purchaseOperationId,
}: {
  operation: ReturnType<typeof usePersonalOperations>;
  quietPurchase?: boolean;
  purchasePending?: boolean;
  purchaseOperationId?: string;
}) {
  const styles = usePersonalStyles();
  const healthyPurchase =
    quietPurchase &&
    purchasePending &&
    operation.busy &&
    !operation.error &&
    !operation.storageError &&
    operation.references.length <= 1;
  const references = healthyPurchase ? [] : operation.references;
  const receipt =
    quietPurchase &&
    operation.receipt?.operationId === purchaseOperationId &&
    operation.receipt?.commandKind === 'setManualPurchased' &&
    (operation.receipt.outcome === 'committed' || operation.receipt.outcome === 'no_op')
      ? null
      : operation.receipt;
  const showBusy = operation.busy && !healthyPurchase;
  if (!showBusy && !operation.storageError && !operation.error && !receipt && !references.length)
    return null;
  return (
    <View style={styles.section}>
      {showBusy && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Checking your local change…
        </AppText>
      )}
      {operation.storageError && (
        <Notice title="Recovery needs attention" tone="error">
          {operation.storageError}
        </Notice>
      )}
      {operation.error && (
        <Notice title="Change needs attention" tone="error">
          {operation.error}
        </Notice>
      )}
      {receipt && (
        <Notice
          title={
            receipt.outcome === 'cancelled'
              ? 'Earlier request cancelled'
              : receipt.outcome === 'no_op'
                ? 'Saved state already matches'
                : 'Local change saved'
          }
        >
          <AppText role="support">
            {receipt.outcome === 'cancelled'
              ? 'The unsaved old request is fenced off and cannot apply later. Review current data before starting a new change.'
              : 'Confirmed by the local operation receipt.'}
          </AppText>
        </Notice>
      )}
      {references.map((reference) => (
        <View key={reference.operationId} style={styles.card}>
          <AppText role="bodyStrong">Unconfirmed personal change</AppText>
          <AppText role="support" selectable>
            Operation ID: {reference.operationId}
          </AppText>
          <ActionButton
            label="Check personal change receipt"
            variant="secondary"
            disabled={operation.busy}
            onPress={() => void operation.recover(reference.operationId, false)}
          />
          <AppText role="support">
            Resolve to confirm the existing result or cancel an unsaved old request. This never
            replays your private change.
          </AppText>
          <ActionButton
            label="Resolve unconfirmed personal change"
            variant="quiet"
            disabled={operation.busy}
            onPress={() => void operation.recover(reference.operationId, true)}
          />
        </View>
      ))}
    </View>
  );
}
export const validPersonalText = (value: string, limit: number, optional = false) =>
  (optional || value.trim().length > 0) && Array.from(value).length <= limit;
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    card: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      padding: t.space.md,
      borderWidth: 1,
      borderColor: t.color.divider,
      gap: t.space.md,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
    text: { flex: 1, minWidth: 0, gap: t.space.xs },
    photo: { width: 88, flexShrink: 0 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    checked: { textDecorationLine: 'line-through', color: t.color.inkSecondary },
  });
export function usePersonalStyles() {
  return useThemedStyles(createStyles);
}
