import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { Immutable, PortableBackupCounts, PortableBackupFailure } from '@cookmate/domain';
import { ActionButton, Notice, SegmentControl } from '../../components/Controls';
import { AppIcon } from '../../components/Icon';
import { AppText } from '../../components/Typography';
import { controlStateProps } from '../../components/controlStateProps';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import type { createPortableContentBackupReader } from '../../data/portableContentBackup';
import type {
  createPortableContentBackupInspector,
  PortableContentReferenceInspection,
} from '../../data/portableContentInspection';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
import { ExpandedBackupCounts } from './BackupScopeSummary';
import { RestoreSettings } from './RestoreSettings';
import type { RestoreSettingsPort } from './restoreSettingsPorts';
import type { PortableContentRestoreReview } from '../../data/portableContentRestore';
import type { CookMateQueries } from '@cookmate/domain';
import type { RestoreReferenceStore } from './restoreReferences';
import { contentRestoreReferenceStore } from './contentRestoreReferenceStorage';
import { useOptionalContentPrivateState } from '../content/contentPrivateState';
import { createBackupTransfer } from './backupTransfer';
import {
  assertBackupTextSize,
  backupFilename,
  BackupTransferError,
  type BackupTransfer,
} from './backupTransferTypes';

export type ContentBackupHost = Pick<ContentWorkspaceHost, 'getSnapshot' | 'subscribe'> & {
  restore?: {
    service: RestoreSettingsPort<Immutable<PortableContentRestoreReview>>;
    readInstallationId: CookMateQueries['readInstallationId'];
  };
  backup: {
    capture: ReturnType<typeof createPortableContentBackupReader>['capture'];
    inspect: ReturnType<typeof createPortableContentBackupInspector>['inspect'];
  };
};
interface PreparedExport {
  serialized: string;
  createdAt: string;
  sourceRevision: number;
  counts: Immutable<PortableBackupCounts>;
  filename: string;
}
const invalidMessages: Record<PortableBackupFailure, string> = {
  too_large: 'Choose a CookMate JSON backup no larger than 8 MiB.',
  invalid_json: 'This file is not readable JSON. Choose an original CookMate backup file.',
  unsupported_version:
    'This inspector needs an exact-content Format 3 backup. This file has not been imported or changed.',
  invalid_structure:
    'This file is incomplete or contains unsupported records. Nothing has been imported.',
  checksum_mismatch:
    'The file does not match its integrity check. It may have changed or been damaged. Nothing has been imported.',
  integrity_unavailable:
    'The integrity check could not run. Try inspecting again; nothing has been imported.',
};
export function ContentBackupSettings({
  host,
  createTransfer = createBackupTransfer,
  showTitle = true,
  restoreReferences,
}: {
  host: ContentBackupHost;
  createTransfer?: () => BackupTransfer;
  showTitle?: boolean;
  restoreReferences?: RestoreReferenceStore;
}) {
  const privateState = useOptionalContentPrivateState();
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  return state.status === 'ready' ? (
    <ReadyBackupSettings
      key={state.scopeKey}
      host={host}
      scopeKey={state.scopeKey}
      createTransfer={createTransfer}
      showTitle={showTitle}
      restoreReferences={
        restoreReferences ?? privateState?.references.restore ?? contentRestoreReferenceStore
      }
    />
  ) : (
    <Notice title="Backup is unavailable here">
      Return after this workspace’s update or recovery finishes. Any transfer already started may
      still complete; check your downloads or chosen destination.
    </Notice>
  );
}
function ReadyBackupSettings({
  host,
  scopeKey,
  createTransfer,
  showTitle,
  restoreReferences,
}: {
  host: ContentBackupHost;
  scopeKey: string;
  createTransfer: () => BackupTransfer;
  showTitle: boolean;
  restoreReferences: RestoreReferenceStore;
}) {
  const styles = useThemedStyles(createStyles),
    t = useTheme();
  const [focused, setFocused] = useState(false),
    [task, setTask] = useState<'export' | 'inspect' | 'restore'>('export');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [history, setHistory] = useState(false),
    [textVisible, setTextVisible] = useState(false);
  const [prepared, setPrepared] = useState<PreparedExport | null>(null),
    [inspection, setInspection] = useState<Immutable<PortableContentReferenceInspection> | null>(
      null,
    );
  const [busy, setBusy] = useState<'export' | 'text' | 'pick' | 'inspect' | 'copy' | null>(null),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true),
    active = useRef(false),
    running = useRef(false),
    generation = useRef(0),
    transfer = useRef<BackupTransfer | null>(null);
  const capture = host.backup.capture,
    inspect = host.backup.inspect;
  const renderedGeneration = generation.current,
    cleanupFailed = useRef(false);
  const latest = useRef({ host, scopeKey, createTransfer, capture, inspect });
  latest.current = { host, scopeKey, createTransfer, capture, inspect };
  const current = useCallback(() => {
    const state = host.getSnapshot();
    return (
      mounted.current &&
      active.current &&
      latest.current.host === host &&
      latest.current.scopeKey === scopeKey &&
      latest.current.createTransfer === createTransfer &&
      latest.current.capture === capture &&
      latest.current.inspect === inspect &&
      state.status === 'ready' &&
      state.scopeKey === scopeKey
    );
  }, [host, scopeKey, createTransfer, capture, inspect]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      generation.current++;
      running.current = false;
      setFocused(true);
      setBusy(null);
      setRestoreBusy(false);
      setError(
        cleanupFailed.current
          ? 'A temporary transfer resource could not be confirmed removed. Check your downloads or chosen destination before another export.'
          : null,
      );
      setMessage(null);
      setPrepared(null);
      setInspection(null);
      setTextVisible(false);
      setHistory(false);
      setTask('export');
      return () => {
        active.current = false;
        generation.current++;
        running.current = false;
        setFocused(false);
        setPrepared(null);
        setInspection(null);
        setTextVisible(false);
        setHistory(false);
        const owned = transfer.current;
        transfer.current = null;
        try {
          owned?.dispose();
        } catch {
          cleanupFailed.current = true;
        }
      };
    }, [host, scopeKey, createTransfer, capture, inspect]),
  );
  const actionCurrent = () => current() && renderedGeneration === generation.current;
  function adapter() {
    if (!current()) throw new Error('Backup scope retired');
    return (transfer.current ??= createTransfer());
  }
  async function run(kind: 'export' | 'text' | 'pick') {
    if (!actionCurrent() || running.current) return;
    const attempt = ++generation.current,
      valid = () => current() && attempt === generation.current;
    running.current = true;
    setBusy(kind);
    setError(null);
    setMessage(null);
    setPrepared(null);
    setInspection(null);
    setTextVisible(false);
    let dispatched = false;
    try {
      if (kind === 'pick') {
        const file = await adapter().pickFile();
        if (!valid()) return;
        if (file.kind === 'cancelled') {
          setMessage('No file selected. Nothing has been imported.');
          return;
        }
        assertBackupTextSize(file.serialized);
        setBusy('inspect');
        const result = await inspect(file.serialized);
        if (!valid()) return;
        if (result.kind === 'invalid') {
          setError(invalidMessages[result.reason]);
          return;
        }
        if (result.kind === 'failed') {
          setError(
            result.error.code === 'too_large'
              ? 'This file has too many recipe references to inspect here. Keep the original file unchanged.'
              : 'The file’s exact references could not be checked against this workspace’s trusted content. Inspection is incomplete; nothing has been imported.',
          );
          return;
        }
        // Retain only checked metadata. The picked JSON and private payload are not put in UI state.
        setInspection(result.value);
        return;
      }
      const includeCookingHistory = history;
      setHistory(false);
      const result = await capture({ includeCookingHistory });
      if (!valid()) return;
      if (result.kind !== 'ready') {
        setError(
          result.error.code === 'too_large'
            ? 'This workspace exceeds the 8 MiB backup limit. No backup file was offered.'
            : 'The workspace snapshot could not be captured. No backup file was offered; try again when storage is available.',
        );
        return;
      }
      const serialized = JSON.stringify(result.value);
      assertBackupTextSize(serialized);
      setPrepared({
        serialized,
        counts: result.value.counts,
        createdAt: result.value.createdAt,
        sourceRevision: result.value.sourceRevision,
        filename: backupFilename(),
      });
      if (kind === 'text') {
        setMessage(
          'Backup text prepared locally. It has not been copied, downloaded or saved to a file.',
        );
        return;
      }
      const owned = adapter();
      if (!valid()) return;
      dispatched = true;
      const outcome = await owned.exportFile(serialized);
      if (!valid()) return;
      setMessage(
        outcome === 'download_requested'
          ? 'Download requested. Check your browser’s downloads to confirm the file was saved.'
          : 'The share sheet has closed. CookMate cannot tell whether you saved, shared or cancelled. Check the destination you chose.',
      );
    } catch (failure) {
      if (!valid()) return;
      if (dispatched) {
        setError(
          failure instanceof BackupTransferError && failure.reason === 'cleanup_failed'
            ? 'The transfer may have completed, but a temporary backup copy could not be confirmed removed from CookMate’s cache. Check your chosen destination before exporting again.'
            : 'The transfer result is unconfirmed. A download or share may already have been offered. Check downloads or your chosen destination before trying again.',
        );
      } else if (failure instanceof BackupTransferError && failure.reason === 'too_large')
        setError(invalidMessages.too_large);
      else if (failure instanceof BackupTransferError && failure.reason === 'cleanup_failed')
        setError(
          'The selected file could not be inspected because its temporary copy could not be confirmed removed. Nothing has been imported.',
        );
      else
        setError(
          kind === 'pick'
            ? 'The selected file could not be read. Try another CookMate backup; nothing has been imported.'
            : 'Backup preparation could not finish. No backup file was offered.',
        );
    } finally {
      if (valid()) {
        running.current = false;
        setBusy(null);
      }
    }
  }
  async function copyPrepared() {
    if (!actionCurrent() || running.current || !prepared) return;
    const attempt = ++generation.current,
      valid = () => current() && attempt === generation.current,
      serialized = prepared.serialized;
    running.current = true;
    setBusy('copy');
    setError(null);
    setMessage(null);
    try {
      const owned = adapter();
      if (!owned.copyText) throw new BackupTransferError('unavailable');
      await owned.copyText(serialized);
      if (valid())
        setMessage(
          'Copied to the clipboard. Paste into a private plain-text file and save it with the suggested .json filename. Copying alone is not a saved backup. Inspect the saved file to check it.',
        );
    } catch {
      if (valid())
        setError(
          'Clipboard access could not be confirmed. No copy success is claimed. Reveal the JSON and copy it manually if needed, then save a private .json file.',
        );
    } finally {
      if (valid()) {
        running.current = false;
        setBusy(null);
      }
    }
  }
  function toggleHistory() {
    if (actionCurrent() && !running.current) setHistory((value) => !value);
  }
  if (!focused) return null;
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
        disabled={busy !== null || restoreBusy}
        options={[
          { value: 'export', label: 'Export' },
          { value: 'inspect', label: 'Inspect' },
          { value: 'restore', label: 'Restore' },
        ]}
        onChange={(value) => {
          if (actionCurrent() && !running.current && !restoreBusy) {
            setTask(value);
            setError(null);
            setMessage(null);
            setPrepared(null);
            setTextVisible(false);
            setInspection(null);
            setHistory(false);
          }
        }}
      />
      {task === 'export' && (
        <>
          <Notice title="This file is not encrypted" tone="caution">
            Anyone with the file can read its personal data. Keep it somewhere private. CookMate
            does not upload it; a destination you choose in the share sheet may be an external
            service.
          </Notice>
          <AppText role="support">
            Format 3 includes favourites, dated meals and their exact recipe references, shopping
            progress, saved preferences, private recipe notes, collections, manual items and
            retained removal records.
          </AppText>
          <AppText role="support" color="inkSecondary">
            Recipe bodies and photographs, reading progress, chat, unsent drafts, credentials,
            display settings, AI-sharing choices, operation receipts and restore archives are
            excluded. Exact references do not grant access to recipe content.
          </AppText>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel="Include cooking history in the next export"
            {...controlStateProps({ checked: history, disabled: busy !== null }, 'checkbox')}
            disabled={busy !== null}
            onPress={toggleHistory}
            style={styles.historyToggle}
            {...(Platform.OS === 'web'
              ? {
                  onKeyDown: (event: { key: string; repeat: boolean; preventDefault(): void }) => {
                    if (event.key === ' ' || event.key === 'Spacebar') {
                      event.preventDefault();
                      if (!event.repeat) toggleHistory();
                    }
                  },
                }
              : {})}
          >
            <View
              style={[
                styles.check,
                history && { backgroundColor: t.color.brand, borderColor: t.color.brand },
              ]}
            >
              {history && <AppIcon name="check" size={16} color={t.color.onBrand} />}
            </View>
            <AppText role="bodyStrong" style={styles.countLabel}>
              Include cooking history
            </AppText>
          </Pressable>
          <AppText role="support" color="inkSecondary">
            Optional recorded meals, dates and private cooking notes. Excluded unless selected; the
            choice resets after each attempt or leaving.
          </AppText>
          <ActionButton
            label="Export plain-text backup"
            disabled={busy !== null}
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
                disabled={busy !== null}
                busy={busy === 'text'}
                onPress={() => void run('text')}
              />
            </>
          )}
          {prepared && (
            <View style={styles.card}>
              <AppText role="bodyStrong" accessibilityRole="header">
                Prepared backup snapshot
              </AppText>
              <AppText role="support">
                Format 3 · captured {new Date(prepared.createdAt).toLocaleString()} · workspace
                revision {prepared.sourceRevision}. Later changes are not included.
              </AppText>
              <Counts counts={prepared.counts} />
              <HistoryScope counts={prepared.counts} />
              {Platform.OS === 'web' && (
                <>
                  <AppText role="support" selectable>
                    Suggested filename: {prepared.filename}
                  </AppText>
                  <AppText role="support" color="caution">
                    The complete unencrypted JSON contains the private scopes listed above,
                    including retained preference-removal values. Reveal or copy it only in a
                    private place.
                  </AppText>
                  <ActionButton
                    label={textVisible ? 'Hide backup JSON' : 'Show backup JSON'}
                    variant="quiet"
                    disabled={busy !== null}
                    onPress={() => {
                      if (actionCurrent() && !running.current) setTextVisible((value) => !value);
                    }}
                  />
                  {textVisible && (
                    <TextInput
                      accessibilityLabel="Prepared backup JSON"
                      accessibilityHint="Read-only complete backup. Select all and copy if clipboard access is unavailable."
                      editable={false}
                      multiline
                      selectTextOnFocus
                      value={prepared.serialized}
                      style={styles.jsonText}
                    />
                  )}
                  <ActionButton
                    label="Copy backup JSON"
                    variant="secondary"
                    disabled={busy !== null}
                    busy={busy === 'copy'}
                    onPress={() => void copyPrepared()}
                  />
                </>
              )}
              <ActionButton
                label="Discard prepared text"
                variant="quiet"
                disabled={busy !== null}
                onPress={() => {
                  if (!actionCurrent() || running.current) return;
                  setPrepared(null);
                  setTextVisible(false);
                  setError(null);
                  setMessage(null);
                }}
              />
            </View>
          )}
        </>
      )}
      {task === 'inspect' && (
        <>
          <AppText role="bodyStrong" accessibilityRole="header">
            Inspect a backup
          </AppText>
          <AppText role="support" color="inkSecondary">
            Choose one Format 3 CookMate JSON file, up to 8 MiB. Structure, integrity and exact
            recipe references are checked against this workspace’s trusted content. Inspection does
            not import, merge or replace records.
          </AppText>
          <ActionButton
            label="Inspect backup file"
            variant="secondary"
            disabled={busy !== null}
            busy={busy === 'pick' || busy === 'inspect'}
            onPress={() => void run('pick')}
          />
          {inspection && (
            <View style={styles.card}>
              <AppText role="bodyStrong" accessibilityRole="header">
                Backup inspected
              </AppText>
              <Counts counts={inspection.counts} />
              <HistoryScope counts={inspection.counts} />
              <InspectionReferences value={inspection} />
              <AppText role="support">
                The checksum checks file integrity; it does not authenticate the file’s author.
                Inspection is not restore approval.
              </AppText>
            </View>
          )}
        </>
      )}
      {task === 'restore' && host.restore && (
        <RestoreSettings
          service={host.restore.service}
          readInstallationId={host.restore.readInstallationId}
          references={restoreReferences}
          createTransfer={createTransfer}
          isCurrent={current}
          contentMode
          onBusyChange={setRestoreBusy}
        />
      )}
      {!host.restore && (
        <Notice title="Restoring is unavailable in this workspace">
          You can export and inspect Format 3 backups here. This workspace does not currently
          support applying a restore. Keep the original app data and backup file; inspection makes
          no changes.
        </Notice>
      )}
      {busy && (
        <AppText role="support" accessibilityLiveRegion="polite">
          {busy === 'pick'
            ? 'Waiting for your file selection…'
            : busy === 'inspect'
              ? 'Checking backup structure and exact references…'
              : busy === 'copy'
                ? 'Waiting for clipboard confirmation…'
                : 'Preparing your backup snapshot…'}
        </AppText>
      )}
      {error && (
        <View accessibilityLiveRegion="polite">
          <Notice title="Backup needs attention" tone="error">
            {error}
          </Notice>
        </View>
      )}
      {message && <AppText accessibilityLiveRegion="polite">{message}</AppText>}
    </View>
  );
}
function HistoryScope({ counts }: { counts: Immutable<PortableBackupCounts> }) {
  return (
    <AppText role="support">
      {counts.cookingHistory === undefined
        ? 'Cooking history and its private notes are not included.'
        : 'Cooking history is included, with recorded recipe references, dates and private cooking notes.'}
    </AppText>
  );
}
function Counts({ counts }: { counts: Immutable<PortableBackupCounts> }) {
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
function InspectionReferences({ value }: { value: Immutable<PortableContentReferenceInspection> }) {
  const styles = useThemedStyles(createStyles);
  const rows = [
    ['Current exact versions', 'current'],
    ['Archived exact versions', 'archived'],
    ['Historical exact versions', 'historical'],
    ['Withdrawn exact versions', 'withdrawn'],
    ['Missing exact versions', 'missing'],
  ] as const;
  const issues = [
    ['Unresolved earlier history references', 'unresolved_legacy'],
    ['History metadata mismatches', 'metadata_mismatch'],
    ['Previously removed history entries', 'previously_removed'],
  ] as const;
  return (
    <View style={styles.section}>
      <AppText role="bodyStrong">Exact recipe references</AppText>
      {rows.map(([label, state]) => (
        <AppText role="support" key={state}>
          {label}: {value.references.filter((row) => row.state === state).length}
        </AppText>
      ))}
      {issues.map(([label, reason]) => (
        <AppText role="support" key={reason}>
          {label}: {value.historyIssues.filter((row) => row.reason === reason).length}
        </AppText>
      ))}
      <AppText role="support">
        {value.exactReferencesAvailable
          ? 'The listed exact recipe versions were available during inspection. A separate restore review and confirmation are required before any replacement.'
          : 'Some exact versions are missing or withdrawn. Their latest versions will not be substituted. Keep the original backup unchanged.'}
      </AppText>
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
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
