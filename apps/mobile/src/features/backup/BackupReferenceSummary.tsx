import { StyleSheet, View } from 'react-native';
import type {
  Immutable,
  PortableBackupReferenceReason,
  PortableBackupReferenceSummary,
} from '@cookmate/domain';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';

const DISPLAY_LIMIT = 10;
const reasons: Record<PortableBackupReferenceReason, string> = {
  recipe_unavailable: 'This recipe ID is unavailable in the current catalogue.',
  catalogue_mismatch: 'The recorded catalogue identity does not match this workspace.',
  history_content_unverified:
    'Exact content for the recorded cooking history has not been verified.',
  history_content_mismatch:
    'The backup’s history content check failed; this history reference remains unresolved.',
};

/** Informational only. No archive lookup, import, substitution or restore authority. */
export function BackupReferenceSummary({
  summary,
}: {
  summary: Immutable<PortableBackupReferenceSummary>;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <AppText role="bodyStrong" accessibilityRole="header">
        Recipe references
      </AppText>
      <AppText role="support" color="inkSecondary">
        Counts are unique recipe IDs. An ID is confirmed only when all its recorded catalogue
        references and included history content are verified.
      </AppText>
      <AppText role="support">
        Known exact catalogue references: {summary.knownExactRecipeIds.length}
      </AppText>
      {summary.knownExactRecipeIds.length > 0 && (
        <AppText role="support" color="inkSecondary">
          Known IDs: {summary.knownExactRecipeIds.slice(0, DISPLAY_LIMIT).join(', ')}
          {summary.knownExactRecipeIds.length > DISPLAY_LIMIT
            ? ` (first ${DISPLAY_LIMIT} of ${summary.knownExactRecipeIds.length})`
            : ''}
        </AppText>
      )}
      <AppText role="support">Exact trusted archive references: unavailable</AppText>
      <AppText role="support" color="inkSecondary">
        Trusted archive resolution is not connected. No references are counted as recoverable from
        an archive.
      </AppText>
      <AppText role="support">Unresolved recipe references: {summary.unresolved.length}</AppText>
      {summary.totalRecipeIds === 0 && (
        <AppText role="support">This file contains no recipe references.</AppText>
      )}
      {summary.unresolved.slice(0, DISPLAY_LIMIT).map((entry) => (
        <View key={entry.recipeId} style={styles.reference}>
          <AppText role="bodyStrong">Recipe ID {entry.recipeId}</AppText>
          {entry.reasons.map((reason) => (
            <AppText key={reason} role="support">
              {reasons[reason]}
            </AppText>
          ))}
        </View>
      ))}
      {summary.unresolved.length > DISPLAY_LIMIT && (
        <AppText role="support" color="inkSecondary">
          Showing the first {DISPLAY_LIMIT} of {summary.unresolved.length} unresolved IDs. The
          original backup retains every reference.
        </AppText>
      )}
      {summary.historyEntries > 0 && (
        <AppText role="support" color="inkSecondary">
          {summary.historyContentVerification === 'verified'
            ? 'Included cooking history matches the checked recipe content.'
            : summary.historyContentVerification === 'mismatch'
              ? 'At least one history entry failed exact content verification. All history recipe IDs remain unresolved in this summary.'
              : 'Cooking history content has not been verified during this file inspection.'}
        </AppText>
      )}
      {summary.unresolved.length > 0 && (
        <AppText role="support">
          Restore stays blocked while exact references are unresolved. Keep the original backup
          unchanged. Use a workspace with the matching catalogue and verified history content, or
          retain the file for exact content recovery. A latest recipe or matching title will not be
          substituted.
        </AppText>
      )}
      <AppText role="support" color="inkSecondary">
        Reference inspection does not authorize restore. Other restore checks still apply.
      </AppText>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.sm },
    reference: { gap: t.space.xs },
  });
