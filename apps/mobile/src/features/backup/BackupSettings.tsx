import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { catalogue, catalogueBoundary } from '@cookmate/catalogue';
import { validatePortableBackup } from '@cookmate/domain';
import type {
  Immutable,
  PortableBackupCounts,
  PortableBackupFailure,
  PortableBackupPreview,
} from '@cookmate/domain';
import { ActionButton, Notice, SegmentControl } from '../../components/Controls';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { AppText } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { controlStateProps } from '../../components/controlStateProps';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { formatCalendarDate } from '../../localization';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { createBackupTransfer } from './backupTransfer';
import {
  assertBackupTextSize,
  backupFilename,
  BackupTransferError,
  type BackupTransfer,
} from './backupTransferTypes';
import { RestoreSettings } from './RestoreSettings';
import { BackupScopeSummary, ExpandedBackupCounts } from './BackupScopeSummary';
import { BackupReferenceSummary } from './BackupReferenceSummary';

interface Inspection {
  createdAt: string;
  preview: Immutable<PortableBackupPreview>;
}

interface PreparedExport {
  serialized: string;
  createdAt: string;
  sourceRevision: number;
  filename: string;
  counts: Immutable<PortableBackupCounts>;
}

const validationMessages: Record<PortableBackupFailure, string> = {
  too_large: 'Choose a CookMate JSON backup no larger than 8 MiB.',
  invalid_json: 'This file is not readable JSON. Choose an original CookMate backup file.',
  unsupported_version:
    'This backup uses a version this app cannot inspect. It has not been changed or imported.',
  invalid_structure:
    'This file is incomplete or has unsupported records. Nothing has been imported.',
  checksum_mismatch:
    'The backup contents do not match their integrity check. The file may have changed or been damaged. Nothing has been imported.',
  integrity_unavailable: 'The integrity check could not run. Try again; nothing has been imported.',
};

export function BackupSettings({
  createTransfer = createBackupTransfer,
  showTitle = true,
}: {
  createTransfer?: () => BackupTransfer;
  showTitle?: boolean;
}) {
  const { availability } = useWorkspace();
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState<'export' | 'text' | 'copy' | 'pick' | 'validate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [exportCounts, setExportCounts] = useState<Immutable<PortableBackupCounts> | null>(null);
  const [preparedExport, setPreparedExport] = useState<PreparedExport | null>(null);
  const [textVisible, setTextVisible] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [includeCookingHistory, setIncludeCookingHistory] = useState(false);
  const [task, setTask] = useState<'export' | 'inspect' | 'restore'>('export');
  const [scopeOpen, setScopeOpen] = useState(false);
  const expandedAvailable = availability.kind === 'ready' && !!availability.services.personal;
  const transfer = useRef<BackupTransfer | null>(null);
  const active = useRef(false);
  const running = useRef(false);
  const generation = useRef(0);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      setBusy(null);
      setError(null);
      setMessage(null);
      setInspection(null);
      setExportCounts(null);
      setPreparedExport(null);
      setTextVisible(false);
      setIncludeCookingHistory(false);
      setTask('export');
      setScopeOpen(false);
      return () => {
        active.current = false;
        running.current = false;
        generation.current++;
        transfer.current?.dispose();
        transfer.current = null;
        setInspection(null);
        setExportCounts(null);
        setPreparedExport(null);
        setTextVisible(false);
        setIncludeCookingHistory(false);
      };
    }, []),
  );

  const fileTransfer = () => (transfer.current ??= createTransfer());
  async function run(kind: 'export' | 'text' | 'pick') {
    if (
      !active.current ||
      running.current ||
      restoreBusy ||
      (kind !== 'pick' && availability.kind !== 'ready')
    )
      return;
    running.current = true;
    const ownGeneration = ++generation.current;
    const current = () => active.current && generation.current === ownGeneration;
    setBusy(kind);
    setError(null);
    setMessage(null);
    setInspection(null);
    setExportCounts(null);
    setPreparedExport(null);
    setTextVisible(false);
    try {
      if (kind !== 'pick') {
        if (availability.kind !== 'ready') return;
        const includeHistory = expandedAvailable && includeCookingHistory;
        // An opt-in applies to this attempt only, including a failed or cancelled offer.
        setIncludeCookingHistory(false);
        const snapshot = await availability.services.queries.readPortableBackup({
          includeCookingHistory: includeHistory,
        });
        if (!current()) return;
        if (snapshot.kind !== 'ready') {
          setError(
            snapshot.error.code === 'too_large'
              ? validationMessages.too_large
              : 'Your workspace could not be exported. No backup file was offered; your saved work is unchanged. Try again.',
          );
          return;
        }
        const serialized = JSON.stringify(snapshot.value);
        assertBackupTextSize(serialized);
        if (Platform.OS === 'web')
          setPreparedExport({
            serialized,
            createdAt: snapshot.value.createdAt,
            sourceRevision: snapshot.value.sourceRevision,
            filename: backupFilename(),
            counts: snapshot.value.counts,
          });
        if (kind === 'text') {
          setMessage(
            'Backup text prepared locally. It has not been copied, downloaded or saved to a file.',
          );
          return;
        }
        const outcome = await fileTransfer().exportFile(serialized);
        if (!current()) return;
        setExportCounts(snapshot.value.counts);
        setMessage(
          outcome === 'download_requested'
            ? 'Download requested. Check your browser’s downloads to confirm the file was saved.'
            : 'The share sheet has closed. CookMate cannot tell whether you saved, shared or cancelled. Check the destination you chose.',
        );
      } else {
        const file = await fileTransfer().pickFile();
        if (!current()) return;
        if (file.kind === 'cancelled') {
          setMessage('No file selected. Your workspace is unchanged.');
          return;
        }
        setBusy('validate');
        const result = await validatePortableBackup(file.serialized, {
          sha256: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
          currentCatalogue:
            availability.kind === 'ready'
              ? availability.services.queries.catalogue
              : catalogue.identity,
          knownRecipeIds: catalogueBoundary.recipeIds,
        });
        if (!current()) return;
        if (result.kind !== 'ready') {
          setError(validationMessages[result.reason]);
          return;
        }
        // Retain only review metadata, not preference values or the complete imported file.
        setInspection({ createdAt: result.value.createdAt, preview: result.preview });
      }
    } catch (failure) {
      if (!current()) return;
      setError(
        failure instanceof BackupTransferError
          ? failure.reason === 'too_large'
            ? validationMessages.too_large
            : failure.reason === 'cleanup_failed'
              ? 'A temporary backup copy could not be removed from CookMate’s cache. Your cooking workspace has not changed.'
              : failure.reason === 'unavailable'
                ? 'File access is unavailable here. Try again in a supported browser or app build.'
                : kind !== 'pick'
                  ? 'The backup file could not be offered for saving. Your cooking workspace has not changed.'
                  : 'The selected file could not be read. Try another CookMate backup; nothing has been imported.'
          : 'The backup operation could not finish. Your cooking workspace has not changed. Try again.',
      );
    } finally {
      if (current()) {
        running.current = false;
        setBusy(null);
      }
    }
  }

  async function copyPrepared() {
    if (!active.current || running.current || restoreBusy || !preparedExport) return;
    running.current = true;
    const ownGeneration = ++generation.current;
    const current = () => active.current && generation.current === ownGeneration;
    setBusy('copy');
    setError(null);
    setMessage(null);
    try {
      const adapter = fileTransfer();
      if (!adapter.copyText) throw new BackupTransferError('unavailable');
      await adapter.copyText(preparedExport.serialized);
      if (current())
        setMessage(
          'Copied to the clipboard. Paste into a private plain-text file and save it with the suggested .json filename. Copying alone is not a saved backup; inspect the saved file to check it.',
        );
    } catch {
      if (current())
        setError(
          'Clipboard access could not be confirmed. No copy success is claimed. Use Show backup JSON, select all its contents and copy manually, then save a private .json file.',
        );
    } finally {
      if (current()) {
        running.current = false;
        setBusy(null);
      }
    }
  }

  return (
    <View style={styles.section}>
      {showTitle && (
        <AppText role="section" accessibilityRole="header">
          Backup & restore
        </AppText>
      )}
      <AppText color="inkSecondary">Keep a private backup of this workspace.</AppText>
      <SegmentControl
        value={task}
        onChange={setTask}
        disabled={busy !== null || restoreBusy}
        options={[
          { value: 'export', label: 'Export' },
          { value: 'inspect', label: 'Inspect' },
          { value: 'restore', label: 'Restore' },
        ]}
      />
      <View
        style={[styles.section, task !== 'export' && styles.hidden]}
        accessibilityElementsHidden={task !== 'export'}
        importantForAccessibility={task !== 'export' ? 'no-hide-descendants' : 'auto'}
      >
        <Notice title="This file is not encrypted" tone="caution">
          Anyone with the file can read its personal data. Keep it somewhere private. CookMate does
          not upload it; a destination you choose in the share sheet may be an external service.
        </Notice>
        <AppText role="support">
          {expandedAvailable
            ? 'Includes favourites, meals, shopping progress, preferences, private recipe notes, collections and manual items. Removal records are included.'
            : 'Includes favourites, meals, shopping progress, preferences and removal records.'}
        </AppText>
        <ActionButton
          label={scopeOpen ? 'Hide backup contents' : 'What is included?'}
          variant="quiet"
          accessibilityState={{ expanded: scopeOpen }}
          onPress={() => setScopeOpen((value) => !value)}
        />
        <AnimatedDisclosure expanded={scopeOpen}>
          {scopeOpen && (
            <View style={styles.card}>
              <AppText role="bodyStrong">What the file contains</AppText>
              <AppText>
                Saved favourites, dated meals, shopping meal selections, purchased-item marks and
                saved cooking preferences.
              </AppText>
              <AppText role="support" color="inkSecondary">
                Earlier favourite removals and retained preference-removal records are included.
                These may contain previous preference values.
              </AppText>
              <AppText role="support" color="inkSecondary">
                {expandedAvailable
                  ? 'This workspace also exports private recipe notes, named collections and memberships, manual shopping items and their purchased state, plus redacted removal records.'
                  : 'This workspace exports the core format. Private recipe notes, collections, manual shopping items and cooking history are not included.'}
              </AppText>
              <AppText role="support" color="inkSecondary">
                Chat history, unsent drafts, AI actions, credentials, display settings and recipe
                photographs are excluded. AI-sharing choices, reading progress and restore archives
                are also excluded.
              </AppText>
            </View>
          )}
        </AnimatedDisclosure>
        {!(availability.kind === 'ready' && availability.services.portableRestore) && (
          <Notice title="Restoring is not available yet">
            You can export and inspect backup files in this build. Inspection does not restore,
            merge or replace your workspace. Keep the original app data until restore is supported
            and tested.
          </Notice>
        )}
        {availability.kind !== 'ready' && (
          <Notice title="Export needs your local workspace">
            {availability.kind === 'opening'
              ? 'Local storage is still opening.'
              : 'Your local workspace could not be opened. You can still inspect an existing backup file.'}
          </Notice>
        )}
        {expandedAvailable && (
          <View style={styles.historyChoice}>
            <HistoryChoice
              checked={includeCookingHistory}
              disabled={busy !== null || restoreBusy}
              onPress={() => setIncludeCookingHistory((value) => !value)}
            />
            <AppText role="support" color="inkSecondary">
              {includeCookingHistory
                ? 'Includes recorded recipes, dates and private cooking notes. Resets after export or leaving.'
                : 'Optional: recorded recipes, dates and private cooking notes. Excluded unless selected; resets after export or leaving.'}
            </AppText>
          </View>
        )}
        <ActionButton
          label="Export plain-text backup"
          disabled={availability.kind !== 'ready' || busy !== null || restoreBusy}
          busy={busy === 'export'}
          onPress={() => void run('export')}
        />
        {Platform.OS === 'web' && (
          <>
            <AppText role="support" color="inkSecondary">
              If this browser cannot deliver a download, prepare the same backup as local text.
              Nothing is copied automatically.
            </AppText>
            <ActionButton
              label="Prepare backup text"
              variant="secondary"
              disabled={availability.kind !== 'ready' || busy !== null || restoreBusy}
              busy={busy === 'text'}
              onPress={() => void run('text')}
            />
            {preparedExport && (
              <View style={styles.card}>
                <AppText role="bodyStrong" accessibilityRole="header">
                  Prepared backup text
                </AppText>
                <AppText role="support">
                  Snapshot from {new Date(preparedExport.createdAt).toLocaleString()} · workspace
                  revision {preparedExport.sourceRevision}. Later changes are not included.
                </AppText>
                <AppText role="support" selectable>
                  Suggested filename: {preparedExport.filename}
                </AppText>
                <BackupCounts counts={preparedExport.counts} />
                <BackupScopeSummary counts={preparedExport.counts} />
                <AppText role="support" color="caution">
                  This is the complete unencrypted JSON, including personal meal choices and
                  retained preference-removal values and every private scope listed above. Reveal or
                  copy it only in a private place. It is kept here until you discard it or leave
                  this screen.
                </AppText>
                <ActionButton
                  label={textVisible ? 'Hide backup JSON' : 'Show backup JSON'}
                  variant="quiet"
                  disabled={busy !== null || restoreBusy}
                  onPress={() => setTextVisible((visible) => !visible)}
                />
                {textVisible && (
                  <TextInput
                    accessibilityLabel="Prepared backup JSON"
                    accessibilityHint="Read-only complete backup. Select all and copy if clipboard access is unavailable."
                    editable={false}
                    multiline
                    selectTextOnFocus
                    value={preparedExport.serialized}
                    style={styles.jsonText}
                  />
                )}
                <ActionButton
                  label="Copy backup JSON"
                  variant="secondary"
                  disabled={busy !== null || restoreBusy}
                  busy={busy === 'copy'}
                  onPress={() => void copyPrepared()}
                />
                <ActionButton
                  label="Discard prepared text"
                  variant="quiet"
                  disabled={busy !== null || restoreBusy}
                  onPress={() => {
                    setPreparedExport(null);
                    setTextVisible(false);
                    setMessage(null);
                    setError(null);
                  }}
                />
              </View>
            )}
          </>
        )}
      </View>
      <View
        style={[styles.section, task !== 'inspect' && styles.hidden]}
        accessibilityElementsHidden={task !== 'inspect'}
        importantForAccessibility={task !== 'inspect' ? 'no-hide-descendants' : 'auto'}
      >
        <AppText role="bodyStrong" accessibilityRole="header">
          Inspect a backup
        </AppText>
        <AppText role="support" color="inkSecondary">
          Choose one CookMate JSON file, up to 8 MiB. Its structure and integrity are checked
          locally. No records are imported.
        </AppText>
        <ActionButton
          label="Inspect backup file"
          variant="secondary"
          disabled={busy !== null || restoreBusy}
          busy={busy === 'pick' || busy === 'validate'}
          onPress={() => void run('pick')}
        />
      </View>
      {busy && (
        <AppText accessibilityLiveRegion="polite" role="support">
          {busy === 'export' || busy === 'text'
            ? 'Preparing your backup file…'
            : busy === 'copy'
              ? 'Waiting for clipboard confirmation…'
              : busy === 'pick'
                ? 'Waiting for your file selection…'
                : 'Checking backup structure and integrity…'}
        </AppText>
      )}
      {error && (
        <View accessibilityLiveRegion="polite">
          <Notice title="Backup needs attention" tone="error">
            {error}
          </Notice>
        </View>
      )}
      {message && (
        <AppText accessibilityLiveRegion="polite" role="support">
          {message}
        </AppText>
      )}
      {exportCounts && !preparedExport && (
        <View style={styles.card}>
          <AppText role="bodyStrong">Contents offered for export</AppText>
          <BackupCounts counts={exportCounts} />
          <BackupScopeSummary counts={exportCounts} />
        </View>
      )}
      {inspection && (
        <View style={styles.card}>
          <AppText role="section" accessibilityRole="header">
            Backup inspection
          </AppText>
          <AppText role="support">
            Created {new Date(inspection.createdAt).toLocaleString()}
          </AppText>
          <AppText>Structure and integrity checks passed. Nothing has been imported.</AppText>
          <BackupCounts counts={inspection.preview.counts} />
          <BackupScopeSummary counts={inspection.preview.counts} />
          {inspection.preview.selectedDateRange && (
            <AppText role="support">
              Selected shopping meals:{' '}
              {formatCalendarDate(inspection.preview.selectedDateRange.first, 'en', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}{' '}
              —{' '}
              {formatCalendarDate(inspection.preview.selectedDateRange.last, 'en', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              .
            </AppText>
          )}
          <BackupReferenceSummary summary={inspection.preview.referenceSummary} />
          {!inspection.preview.catalogueMatches && (
            <Notice title="Different recipe catalogue" tone="caution">
              This file refers to another catalogue version. It can be inspected, but replacement
              requires an exact catalogue match.
            </Notice>
          )}
          {inspection.preview.warnings.includes('shopping_requires_reprojection') && (
            <AppText role="support" color="inkSecondary">
              Shopping quantities and purchased marks must be checked against the available recipes
              before a restore can be confirmed.
            </AppText>
          )}
          <AppText role="support" color="inkSecondary">
            The checksum detects changes or damage. It does not prove who created this file.
          </AppText>
          <ActionButton
            label="Close inspection"
            variant="quiet"
            disabled={busy !== null || restoreBusy}
            onPress={() => setInspection(null)}
          />
        </View>
      )}
      <View
        style={[styles.section, task !== 'restore' && styles.hidden]}
        accessibilityElementsHidden={task !== 'restore'}
        importantForAccessibility={task !== 'restore' ? 'no-hide-descendants' : 'auto'}
      >
        {availability.kind === 'ready' && availability.services.portableRestore ? (
          <RestoreSettings
            service={availability.services.portableRestore}
            readInstallationId={availability.services.queries.readInstallationId}
            createTransfer={createTransfer}
            disabled={busy !== null}
            onBusyChange={setRestoreBusy}
          />
        ) : (
          <Notice title="Restore is unavailable here">
            Your saved workspace has not changed. You can still inspect a backup file.
          </Notice>
        )}
      </View>
    </View>
  );
}

function HistoryChoice({
  checked,
  disabled,
  onPress,
}: {
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel="Include cooking history in the next export"
      {...controlStateProps({ checked, disabled }, 'checkbox')}
      disabled={disabled}
      onPress={onPress}
      style={styles.historyToggle}
    >
      <View
        style={[
          styles.check,
          checked && { backgroundColor: t.color.brand, borderColor: t.color.brand },
        ]}
      >
        {checked && <AppIcon name="check" size={16} color={t.color.onBrand} />}
      </View>
      <AppText role="bodyStrong" style={styles.countLabel}>
        Include cooking history
      </AppText>
    </Pressable>
  );
}

function BackupCounts({ counts }: { counts: Immutable<PortableBackupCounts> }) {
  const styles = useThemedStyles(createStyles);
  const rows = [
    ['Saved favourite recipes', counts.favourites],
    ['Favourite removal records', counts.tombstones],
    ['Planned meals', counts.plannedMeals],
    ['Meals selected for shopping', counts.selectedMeals],
    ['Shopping progress records', counts.purchaseMarks],
    ['Items marked purchased', counts.purchasedItems],
    ['Saved cooking preferences', counts.preferences],
    ['Preference removal records', counts.preferenceRemovals],
  ] as const;
  return (
    <View style={styles.section}>
      {rows.map(([label, count]) => (
        <View key={label} style={styles.countRow}>
          <AppText role="support" style={styles.countLabel}>
            {label}
          </AppText>
          <AppText role="bodyStrong" accessibilityLabel={`${label}: ${count}`}>
            {count}
          </AppText>
        </View>
      ))}
      <ExpandedBackupCounts counts={counts} />
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    hidden: { display: 'none' },
    historyChoice: { gap: t.space.xs },
    historyToggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    check: {
      width: 24,
      height: 24,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: {
      gap: t.space.sm,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderWidth: 1,
      borderColor: t.color.divider,
      borderRadius: t.radius.card,
    },
    divider: { height: 1, backgroundColor: t.color.divider, marginVertical: t.space.sm },
    countRow: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.sm },
    countLabel: { flex: 1 },
    jsonText: {
      height: 220,
      padding: t.space.sm,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: t.radius.small,
      backgroundColor: t.color.canvas,
      color: t.color.ink,
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 18,
      textAlignVertical: 'top',
    },
  });
