import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { Immutable } from '@cookmate/domain';
import type { AccountScopeApprovalReview } from '../../data/accountScopeApproval';
import { ActionButton } from '../../components/Controls';
import { controlStateProps } from '../../components/controlStateProps';
import { focusTarget } from '../../components/focusTarget';
import { AppIcon } from '../../components/Icon';
import { MotionPressable } from '../../components/MotionPressable';
import { AppText } from '../../components/Typography';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';

export interface AccountScopeReviewPanelProps {
  review: Immutable<AccountScopeApprovalReview>;
  busy?: boolean;
  onApprove(historyIncluded: boolean): void;
  onCancel(): void;
}

/** The exact service-issued review remains with the runtime; this panel owns only an unsaved choice. */
export function AccountScopeReviewPanel(props: AccountScopeReviewPanelProps) {
  return <ScopeChoice key={`${props.review.ownerId}:${props.review.reviewId}`} {...props} />;
}

function ScopeChoice({ review, busy = false, onApprove, onCancel }: AccountScopeReviewPanelProps) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const heading = useRef<View>(null);
  const [historyIncluded, setHistoryIncluded] = useState(review.historyIncluded);
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusTarget(heading.current));
    return () => cancelAnimationFrame(frame);
  }, []);
  const counts = [
    ['Recipe notes', review.counts.notes],
    ['Collections', review.counts.collections],
    ['Recipes in collections', review.counts.memberships],
    ['Manual shopping items', review.counts.manualItems],
  ] as const;
  const historyLabel = `${review.counts.cookingHistory} saved ${review.counts.cookingHistory === 1 ? 'entry' : 'entries'}`;
  return (
    <View style={styles.panel}>
      <View ref={heading} accessible accessibilityRole="header">
        <AppText role="title">
          {review.previousApprovalDigest ? 'Review sync choices' : 'Choose what syncs'}
        </AppText>
      </View>
      <AppText>
        For your private CookMate account. These choices do not share anything with a household or
        give the Assistant permission to use your data.
      </AppText>
      <View style={styles.section}>
        <AppText role="bodyStrong">Included with account sync</AppText>
        <AppText role="support" color="inkSecondary">
          Favourites, meal plans, supported shopping checks, saved cooking preferences, display name
          and app appearance preferences.
        </AppText>
      </View>
      <View style={styles.section}>
        <AppText role="section" accessibilityRole="header">
          Your personal cooking data
        </AppText>
        <AppText role="support" color="inkSecondary">
          Saving these choices includes your notes, collections and manual items. Counts show saved
          items on this device; a recipe can belong to more than one collection.
        </AppText>
        <View style={styles.counts}>
          {counts.map(([label, count]) => (
            <View
              key={label}
              style={styles.countRow}
              accessible
              accessibilityLabel={`${label}: ${count}`}
            >
              <AppText style={styles.countLabel}>{label}</AppText>
              <AppText role="bodyStrong">{count}</AppText>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.section}>
        <MotionPressable
          accessibilityRole="checkbox"
          accessibilityLabel={`Include cooking history, ${historyLabel}`}
          {...controlStateProps({ checked: historyIncluded, disabled: busy }, 'checkbox')}
          disabled={busy}
          onPress={() => setHistoryIncluded((value) => !value)}
          {...(Platform.OS === 'web'
            ? {
                // RN Web's press responder handles Enter, but Space only for button roles.
                onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
                  if (event.key !== ' ' && event.key !== 'Spacebar') return;
                  event.preventDefault();
                  if (!busy && !event.repeat) setHistoryIncluded((value) => !value);
                },
              }
            : {})}
          style={({ pressed }) => [styles.historyChoice, pressed && styles.pressed]}
        >
          <View style={[styles.checkbox, historyIncluded && styles.checked]}>
            {historyIncluded && <AppIcon name="check" size={18} color={t.color.onBrand} />}
          </View>
          <View style={styles.choiceCopy}>
            <AppText role="bodyStrong">Include cooking history</AppText>
            <AppText role="support" color="inkSecondary">
              {historyLabel} · Optional
            </AppText>
          </View>
        </MotionPressable>
        <AppText role="support" color="inkSecondary">
          {historyIncluded
            ? 'Saved cooking dates and their notes will join this account’s history. Your reading progress stays on this device.'
            : 'This device’s cooking history will not be uploaded or replaced by account sync.'}
        </AppText>
        <AppText role="support" color="inkSecondary">
          Turning this off leaves history already in your account. Clearing local history reaches
          the account only through a later confirmed history sync. Account deletion needs its own
          review.
        </AppText>
      </View>
      <View style={styles.section}>
        <AppText role="bodyStrong">Always excluded</AppText>
        <AppText role="support" color="inkSecondary">
          Assistant conversations and drafts, passwords, API keys, pairing credentials and AI
          sharing consent are not part of this cooking-data sync.
        </AppText>
      </View>
      <AppText role="support">
        Saving these choices records permission on this device. It does not confirm a cloud backup.
        Review the sync differences before the first expanded sync.
      </AppText>
      <ActionButton
        label="Save sync choices"
        busy={busy}
        onPress={() => onApprove(historyIncluded)}
      />
      <ActionButton label="Cancel" variant="quiet" disabled={busy} onPress={onCancel} />
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    panel: { gap: t.space.lg, minWidth: 0 },
    section: { gap: t.space.sm, minWidth: 0 },
    counts: { borderTopWidth: 1, borderTopColor: t.color.divider },
    countRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.md,
      paddingVertical: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    countLabel: { flex: 1, minWidth: 0 },
    historyChoice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: t.control.minimumTarget,
      paddingVertical: t.space.sm,
    },
    checkbox: {
      width: 24,
      height: 24,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: t.radius.small / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checked: { backgroundColor: t.color.brand, borderColor: t.color.brand },
    choiceCopy: { flex: 1, gap: t.space.xxs, minWidth: 0 },
    pressed: { opacity: 0.8 },
  });
