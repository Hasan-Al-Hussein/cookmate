import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { Pressable, StyleSheet, View } from 'react-native';
import type { ReactNode, Ref } from 'react';
import { AppText } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { controlStateProps } from '../../components/controlStateProps';
import { CommittedSelectionAccent } from '../../components/CommittedSelectionAccent';
import { useNativeLayout } from '../../hooks/useNativeLayout';

/** Presentation only: the caller owns demand identity, revisions and committed state. */
export function PurchaseRow({
  name,
  amount,
  purchased,
  changed,
  unavailable = false,
  onToggle,
  focusRef,
  accessory,
}: {
  name: string;
  amount: string;
  purchased: boolean;
  changed: boolean;
  unavailable?: boolean;
  onToggle: () => void;
  focusRef?: Ref<View>;
  accessory?: ReactNode;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const { enlarged, width } = useNativeLayout();
  const stackMeasure = enlarged || (width > 0 && width < 360);
  return (
    <View style={[styles.rowContainer, purchased && styles.purchasedRow]}>
      <Pressable
        ref={focusRef}
        accessibilityRole="checkbox"
        accessibilityLabel={`Purchased ${name}, ${amount}${changed ? ', changed, review' : ''}`}
        {...controlStateProps({ checked: purchased, disabled: unavailable }, 'checkbox')}
        disabled={unavailable}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <CommittedSelectionAccent
          selected={purchased}
          enabled={!unavailable}
          style={[styles.checkbox, purchased && styles.checked]}
        >
          {purchased && <AppIcon name="check" size={16} color={t.color.onAssistant} />}
        </CommittedSelectionAccent>
        <View style={styles.content}>
          <View style={[styles.measureRow, stackMeasure && styles.stacked]}>
            <AppText
              role="bodyStrong"
              color={purchased ? 'inkSecondary' : 'ink'}
              style={[styles.name, purchased && styles.purchasedName]}
            >
              {name}
            </AppText>
            <AppText
              color="inkSecondary"
              style={[styles.amount, stackMeasure && styles.largeAmount]}
            >
              {amount}
            </AppText>
          </View>
          {changed && (
            <View style={styles.changed}>
              <AppText role="support" color="caution">
                Changed — review
              </AppText>
            </View>
          )}
        </View>
      </Pressable>
      {accessory && <View style={styles.accessory}>{accessory}</View>}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    rowContainer: { flexDirection: 'row', alignItems: 'flex-start' },
    accessory: { paddingTop: t.space.xs, flexShrink: 0 },
    row: {
      flex: 1,
      minWidth: 0,
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.sm,
      paddingVertical: t.space.md,
    },
    pressed: { backgroundColor: t.color.selection },
    purchasedRow: { backgroundColor: t.color.successSurface },
    purchasedName: { textDecorationLine: 'line-through' },
    checkbox: {
      width: t.control.checkbox,
      flexShrink: 0,
      height: t.control.checkbox,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    checked: { backgroundColor: t.color.assistant, borderColor: t.color.assistant },
    content: { flex: 1, minWidth: 0, gap: t.space.xxs },
    measureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm },
    stacked: { flexDirection: 'column' },
    name: { flex: 1, minWidth: 0 },
    amount: { flexBasis: '38%', flexShrink: 1, textAlign: 'right' },
    largeAmount: { flexBasis: 'auto', width: '100%', textAlign: 'left' },
    changed: {
      alignSelf: 'flex-start',
      backgroundColor: t.color.cautionSurface,
      borderRadius: t.radius.small,
      paddingHorizontal: t.space.xs,
      paddingVertical: t.space.xxs,
    },
  });
