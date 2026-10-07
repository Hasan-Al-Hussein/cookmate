import { StyleSheet, View } from 'react-native';
import type { Immutable, PortableBackupCounts, PortableRestoreReview } from '@cookmate/domain';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';

const personalRows = [
  ['notes', 'Private recipe notes'],
  ['noteTombstones', 'Recipe note removal records'],
  ['collections', 'Personal collections'],
  ['collectionTombstones', 'Collection removal records'],
  ['memberships', 'Collection memberships'],
  ['removedMemberships', 'Removed memberships'],
  ['manualItems', 'Manual shopping items'],
  ['manualTombstones', 'Manual item removal records'],
  ['purchasedManualItems', 'Purchased manual items'],
] as const;

/** Optional scope is never displayed as zero: omission means absent, not an empty replacement. */
export function ExpandedBackupCounts({
  counts,
  before,
  recorded = false,
}: {
  counts: Immutable<PortableBackupCounts>;
  before?: Immutable<PortableBackupCounts> | undefined;
  recorded?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const personal = counts.personal;
  const rows: { label: string; count: number; previous: number | undefined }[] = personal
    ? personalRows.map(([key, label]) => ({
        label,
        count: personal[key],
        previous: before?.personal?.[key],
      }))
    : [];
  if (counts.cookingHistory !== undefined)
    rows.push({
      label: 'Cooking history entries',
      count: counts.cookingHistory,
      previous: before?.cookingHistory,
    });
  return (
    <View style={styles.section}>
      {rows.map(({ label, count, previous }) => (
        <View key={label} style={styles.row}>
          <AppText role="support" style={styles.label}>
            {label}
          </AppText>
          <AppText
            role="bodyStrong"
            accessibilityLabel={
              before
                ? `${label}: current ${previous ?? 'not included'}, backup ${count}`
                : `${recorded ? 'Recorded ' : ''}${label}: ${count}`
            }
          >
            {before ? `${previous ?? 'Not included'} → ${count}` : count}
          </AppText>
        </View>
      ))}
    </View>
  );
}

export function BackupScopeSummary({ counts }: { counts: Immutable<PortableBackupCounts> }) {
  return (
    <>
      <AppText role="support">
        {counts.personal
          ? 'Format 2 includes private recipe notes, personal collections and memberships, manual shopping items and their purchase state, with redacted removal records.'
          : 'This core backup does not include private recipe notes, personal collections or manual shopping items.'}
      </AppText>
      <AppText role="support">
        {counts.cookingHistory !== undefined
          ? 'Cooking history is included, with recorded recipe details, dates and private cooking notes.'
          : 'Cooking history and its private notes are not included.'}
      </AppText>
      <AppText role="support">
        Reading progress, chat, unsent drafts, credentials, AI-sharing choices and operation
        receipts are not included. Restore archives must be exported separately.
      </AppText>
    </>
  );
}

export function RestoreScopeSummary({
  scopes = ['core'],
  committed = false,
}: {
  scopes?: Immutable<NonNullable<PortableRestoreReview['replacedScopes']>> | undefined;
  committed?: boolean;
}) {
  const personal = scopes.includes('personal');
  const history = scopes.includes('cookingHistory');
  const replaced = committed ? 'Replaced' : 'Will replace';
  const preserved = committed ? 'Preserved by this operation' : 'Will preserve';
  return (
    <>
      <AppText role="bodyStrong">
        {committed ? 'Recorded replacement scope' : 'Replacement and preservation'}
      </AppText>
      <AppText role="support">
        {replaced}: favourites and removal records, dated meals, recipe shopping selections and
        progress, saved cooking preferences.
      </AppText>
      <AppText role="support">
        {personal ? replaced : preserved}: private recipe notes, personal collections and
        memberships, and manual shopping items.
      </AppText>
      <AppText role="support">
        {history ? replaced : preserved}: cooking history and its private notes.
      </AppText>
      {history && (
        <AppText role="support">
          Imported history receives new local IDs and an “Imported from backup” label. Imported
          entries cannot authorize or replay old operations.
        </AppText>
      )}
      <AppText role="support">
        Reading progress, chat, unsent drafts, display settings, AI-sharing choices, credentials and
        existing operation receipts are not replaced.
      </AppText>
      <AppText role="support">
        The retained pre-restore snapshot covers core cooking data
        {personal ? ', private recipe notes, collections and manual items' : ''}
        {history ? ', and cooking history with its notes' : ''}. It excludes preserved scopes. The
        original-file archive keeps the selected file exactly.
      </AppText>
    </>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.sm },
    row: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.sm },
    label: { flex: 1 },
  });
