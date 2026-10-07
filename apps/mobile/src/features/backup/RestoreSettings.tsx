import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import type { ContractError } from '@cookmate/contracts';
import type {
  CookMateQueries,
  Immutable,
  PortableBackupCounts,
  PortableRestoreReceipt,
  PortableRestoreReview,
} from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import {
  assertBackupTextSize,
  BackupTransferError,
  type BackupTransfer,
} from './backupTransferTypes';
import { createBackupTransfer } from './backupTransfer';
import { restoreReferenceStore } from './restoreReferenceStorage';
import type { RestoreReference, RestoreReferenceStore } from './restoreReferences';
import { ExpandedBackupCounts, RestoreScopeSummary } from './BackupScopeSummary';
import { BackupReferenceSummary } from './BackupReferenceSummary';
import type { RestoreReviewPresentation, RestoreSettingsPort } from './restoreSettingsPorts';

const warningCopy: Readonly<Record<string, string>> = {
  retains_personal_removal_records:
    'Existing personal removal records are retained. Notes, collections, memberships and manual items omitted from this file become removals. Older files cannot silently bring removed records back.',
  replaces_backed_up_cooking_data:
    'Replaces favourites and removal markers, dated planned meals, shopping selections and progress, and saved cooking preferences. This does not merge two workspaces.',
  automatic_before_snapshot_is_cooking_data_only:
    'An automatic snapshot of those current cooking collections is saved locally in the same transaction before replacement. It is not a full-device backup or an automatically downloaded file.',
  messages_drafts_settings_credentials_and_receipts_stay_local:
    'Messages, unsent drafts, display settings, installation identity, credentials and existing operation receipts stay local. They are not imported or replaced.',
  imported_preference_removals_retained_in_original_archive_only:
    'Imported preference-removal records are retained in the original-file archive. They do not become local chat provenance. Replaced local preference links are withdrawn.',
  portable_exports_exclude_restore_archives_download_archives_separately:
    'Ordinary backup exports do not include restore archives. Export the before snapshot and original imported file separately after a proved restore.',
  archives_retained_locally_without_automatic_deletion:
    'Restore archives remain locally without automatic deletion. They can contain earlier private values; clearing browser/app storage or uninstalling can remove them.',
  personal_data_plaintext:
    'The backup and retained archives contain unencrypted personal data. Choose private storage and sharing destinations.',
  replaces_personal_notes_collections_and_manual_items:
    'Live private recipe notes, personal collections and memberships, and manual shopping items will be replaced by this file. Existing removal records remain protected.',
  automatic_before_snapshot_covers_every_replaced_scope:
    'The automatic pre-restore snapshot covers every replaced scope, including private personal data and history when selected. Preserved scopes are excluded. The snapshot remains on this device until you export it; it is not a full-device backup.',
  replaces_visible_history_with_new_local_ids:
    'All visible cooking history will be replaced by the file’s entries. An empty included history replaces it with an empty list. Imported entries get new local IDs.',
  old_operation_receipts_are_not_imported_or_replayed:
    'Imported cooking history is data only. It brings no operation receipts or permission to replay an earlier change.',
  history_clear_does_not_remove_retained_backup_archives:
    'Clearing visible cooking history later does not remove private notes or other data retained in these restore archives or in files saved elsewhere.',
  cooking_history_is_not_included_and_stays_unchanged:
    'This file excludes cooking history. Your current cooking history and its private notes stay unchanged.',
};
const blockerCopy: Readonly<Record<string, string>> = {
  content_unavailable:
    'An exact recipe version required by this restore is missing or withdrawn. A newer version will not be substituted.',
  history_unresolved:
    'Some recorded history cannot be matched to its exact recipe content. Restore is blocked; keep the original file unchanged.',
  account_operation_pending:
    'An account change is still pending. Finish its recovery before reviewing this restore again.',
  favourite_removal_conflict:
    'This file would bring back a removed favourite. Restore is blocked to preserve that removal.',
  preference_removal_conflict:
    'This file may bring back a removed cooking preference. Restore is blocked where the retained removal cannot be safely preserved.',
  history_removal_conflict:
    'This file includes cooking history previously removed from this workspace. Restore is blocked so those entries cannot silently return. Keep the original file for reference.',
  personal_removal_conflict:
    'This file would bring back a removed personal record or replace a recipe note with a different identity. Restore is blocked. Keep this file unchanged and use a newer backup that preserves those removals.',
  catalogue_mismatch: 'The backup uses a different recipe catalogue. The whole restore is blocked.',
  unknown_recipes: 'Some recipe IDs are not available here. No recipes will be silently dropped.',
  active_actions:
    'An action or conversation request is still active or awaiting recovery. Resolve it before reviewing again.',
  archive_full:
    'The local restore archive is full. Existing archives have not been deleted to make room.',
  expanded_storage_unavailable:
    'This workspace does not support the file’s expanded personal-data format. Nothing will be replaced; keep the original file until a compatible build is available.',
  history_content_mismatch:
    'A recorded history entry does not match the verified recipe title, photo or source content in this catalogue. The whole restore is blocked; no substituted recipe details will be shown as verified.',
};
function failureCopy(error: ContractError): string {
  if (error.messageKey === 'restore.history_removal_conflict')
    return blockerCopy.history_removal_conflict!;
  if (error.messageKey === 'restore.personal_removal_conflict')
    return blockerCopy.personal_removal_conflict!;
  if (error.code === 'too_large') return 'Choose a backup no larger than 8 MiB.';
  if (error.code === 'stale_context')
    return 'The workspace or action state changed. Refresh the restore review and inspect its consequences before confirming again.';
  if (error.messageKey.includes('checksum'))
    return 'The file does not match its integrity check. Choose an unchanged CookMate backup.';
  if (error.code === 'invalid_input')
    return 'This backup or review could not be accepted. Choose a valid CookMate backup and review it again.';
  return 'Restore information could not be read or saved safely. No success is claimed. Resolve the local storage issue and check the recorded operation when one is shown.';
}
type Outcome =
  | { kind: 'receipt'; receipt: Immutable<PortableRestoreReceipt> }
  | { kind: 'uncertain' | 'not_found'; operationId: string };

export function RestoreSettings<
  Review extends RestoreReviewPresentation = Immutable<PortableRestoreReview>,
>({
  service,
  readInstallationId,
  createTransfer = createBackupTransfer,
  references = restoreReferenceStore,
  disabled = false,
  onBusyChange,
  isCurrent,
  contentMode = false,
}: {
  service: RestoreSettingsPort<Review>;
  readInstallationId: CookMateQueries['readInstallationId'];
  createTransfer?: () => BackupTransfer;
  references?: RestoreReferenceStore;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  isCurrent?: () => boolean;
  contentMode?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savedReferences, setSavedReferences] = useState<readonly RestoreReference[]>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [cleanupReference, setCleanupReference] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [archive, setArchive] = useState<{
    kind: 'before' | 'imported';
    serialized: string;
  } | null>(null);
  const [archiveVisible, setArchiveVisible] = useState(false);
  const source = useRef<string | null>(null);
  const active = useRef(false);
  const running = useRef(false);
  const generation = useRef(0);
  const focusGeneration = useRef(0);
  const transfer = useRef<BackupTransfer | null>(null);
  const cleanupFailed = useRef(false);
  const reviewFile = service.review,
    prepareRestore = service.prepare,
    executeRestore = service.execute,
    readReceipt = service.readReceipt,
    readArchive = service.readArchive;
  const renderedGeneration = generation.current;
  const latest = useRef({
    service,
    readInstallationId,
    references,
    createTransfer,
    isCurrent,
    disabled,
  });
  latest.current = { service, readInstallationId, references, createTransfer, isCurrent, disabled };
  const authorityCurrent = useCallback(
    () =>
      latest.current.service === service &&
      service.review === reviewFile &&
      service.prepare === prepareRestore &&
      service.execute === executeRestore &&
      service.readReceipt === readReceipt &&
      service.readArchive === readArchive &&
      latest.current.readInstallationId === readInstallationId &&
      latest.current.references === references &&
      latest.current.createTransfer === createTransfer &&
      latest.current.isCurrent === isCurrent &&
      (!isCurrent || isCurrent()),
    [
      service,
      reviewFile,
      prepareRestore,
      executeRestore,
      readReceipt,
      readArchive,
      readInstallationId,
      references,
      createTransfer,
      isCurrent,
    ],
  );
  const actionCurrent = () =>
    active.current &&
    authorityCurrent() &&
    renderedGeneration === generation.current &&
    !latest.current.disabled;
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      const ownFocus = ++focusGeneration.current;
      const current = () =>
        active.current && authorityCurrent() && focusGeneration.current === ownFocus;
      setReview(null);
      setOutcome(null);
      setError(
        cleanupFailed.current
          ? 'A temporary archive transfer resource could not be confirmed removed. Check your downloads or chosen destination before exporting again.'
          : null,
      );
      setMessage(null);
      setBusy(null);
      setArchive(null);
      setArchiveVisible(false);
      setInstallationId(null);
      setReferenceError(null);
      setCleanupReference(null);
      setSavedReferences([]);
      source.current = null;
      void (async () => {
        try {
          if (!current()) return;
          const identity = await readInstallationId();
          if (!current()) return;
          if (identity.kind !== 'ready') throw new Error('Workspace identity unavailable');
          const stored = await references.load(identity.value);
          if (!current()) return;
          setInstallationId(identity.value);
          setSavedReferences(stored);
        } catch {
          if (current())
            setReferenceError(
              'Restore recovery references could not be loaded. New restores stay unavailable so their operation IDs cannot be lost. Existing records have not been cleared.',
            );
        }
      })();
      return () => {
        active.current = false;
        running.current = false;
        generation.current++;
        focusGeneration.current++;
        const owned = transfer.current;
        transfer.current = null;
        try {
          owned?.dispose();
        } catch {
          cleanupFailed.current = true;
        }
        source.current = null;
        setReview(null);
        setArchive(null);
        setArchiveVisible(false);
        onBusyChange?.(false);
      };
    }, [authorityCurrent, onBusyChange]),
  );
  const adapter = () => (transfer.current ??= createTransfer());
  async function task(label: string, operation: (current: () => boolean) => Promise<void>) {
    if (!actionCurrent() || running.current) return;
    running.current = true;
    const ownGeneration = ++generation.current;
    const current = () =>
      active.current && authorityCurrent() && generation.current === ownGeneration;
    setBusy(label);
    onBusyChange?.(true);
    setError(null);
    setMessage(null);
    try {
      await operation(current);
    } catch (failure) {
      if (current())
        setError(
          failure instanceof BackupTransferError && failure.reason === 'too_large'
            ? 'Choose a backup no larger than 8 MiB.'
            : 'This step could not finish. No success is claimed. Your operation reference, when shown, is available for receipt lookup.',
        );
    } finally {
      if (current()) {
        running.current = false;
        setBusy(null);
        onBusyChange?.(false);
      }
    }
  }
  async function reviewSource(current: () => boolean) {
    if (!current() || source.current === null) return;
    const result = await reviewFile.call(service, source.current);
    if (!current()) return;
    if (result.kind === 'failed') {
      setReview(null);
      setError(failureCopy(result.error));
      return;
    }
    setReview(result.value);
    setOutcome(null);
  }
  function choose() {
    void task('Reading restore file…', async (current) => {
      const selected = await adapter().pickFile();
      if (!current()) return;
      if (selected.kind === 'cancelled') {
        setMessage('No restore file selected. Nothing was replaced.');
        return;
      }
      assertBackupTextSize(selected.serialized);
      source.current = selected.serialized;
      setReview(null);
      setOutcome(null);
      setArchive(null);
      setArchiveVisible(false);
      await reviewSource(current);
    });
  }
  function cancel() {
    if (!actionCurrent() || running.current) return;
    generation.current++;
    source.current = null;
    setReview(null);
    setOutcome(null);
    setError(null);
    setArchive(null);
    setArchiveVisible(false);
    setMessage('Restore review cancelled. Nothing was replaced.');
  }
  async function releaseUnusedReference(
    workspaceId: string,
    operationId: string,
    reason: 'not_dispatched' | 'definite_failure',
    current: () => boolean,
  ) {
    if (!authorityCurrent()) return false;
    try {
      const remaining = await references.forget(workspaceId, operationId, reason);
      if (current()) setSavedReferences(remaining);
      return true;
    } catch {
      if (current()) {
        setCleanupReference(operationId);
        setReferenceError(
          `This attempt did not replace your workspace. Cleanup of its recovery reference could not be confirmed. Operation ID: ${operationId}. Keep it for receipt checks; no other references were intentionally changed.`,
        );
      }
      return false;
    }
  }
  function confirm() {
    void task('Applying your confirmed replacement…', async (current) => {
      if (
        !review ||
        review.blockers.length ||
        !review.shopping ||
        !installationId ||
        referenceError ||
        review.warnings.some((warning) => !warningCopy[warning])
      )
        return;
      const prepared = await prepareRestore.call(service, review);
      if (!current() || latest.current.disabled) return;
      if (prepared.kind === 'failed') {
        setReview(null);
        setError(failureCopy(prepared.error));
        return;
      }
      const operationId = prepared.value.operationId;
      try {
        const recorded = await references.remember(installationId, {
          operationId,
          preparedAt: new Date().toISOString(),
        });
        if (!current() || latest.current.disabled) {
          await releaseUnusedReference(installationId, operationId, 'not_dispatched', current);
          return;
        }
        setSavedReferences(recorded);
      } catch {
        const released = await releaseUnusedReference(
          installationId,
          operationId,
          'not_dispatched',
          current,
        );
        if (current()) {
          setReview(null);
          if (released)
            setReferenceError(
              'The operation ID could not be retained safely. Restore was not started; no unused reference remains for this attempt. Other recovery references remain unchanged.',
            );
        }
        return;
      }
      // Keep the exact issued object. Retained IDs are only for queries, never replay authority.
      setReview(null);
      try {
        const result = await executeRestore.call(service, prepared.value);
        if (result.kind === 'failed') {
          // The service reports failed only after proving no commit/rollback uncertainty.
          await releaseUnusedReference(installationId, operationId, 'definite_failure', current);
          if (current())
            setError(`Restore failed. ${failureCopy(result.error)} No automatic retry will run.`);
          return;
        }
        if (!current()) return;
        if (result.kind === 'receipt' && result.receipt.operationId === operationId) {
          source.current = null;
          setOutcome({ kind: 'receipt', receipt: result.receipt });
        } else {
          source.current = null;
          setOutcome({ kind: 'uncertain', operationId });
        }
      } catch {
        if (current()) {
          source.current = null;
          setOutcome({ kind: 'uncertain', operationId });
        }
      }
    });
  }
  function check(operationId: string) {
    void task('Checking the stored restore receipt…', async (current) => {
      source.current = null;
      setReview(null);
      setArchive(null);
      setArchiveVisible(false);
      setOutcome({ kind: 'uncertain', operationId });
      const result = await readReceipt.call(service, operationId);
      if (!current()) return;
      if (result.kind === 'failed') {
        setOutcome({ kind: 'uncertain', operationId });
        setError(failureCopy(result.error));
        return;
      }
      if (result.value && result.value.operationId !== operationId) {
        setOutcome({ kind: 'uncertain', operationId });
        setError(
          'The returned receipt does not identify this operation. No restore success or archive access is claimed.',
        );
        return;
      }
      setOutcome(
        result.value
          ? { kind: 'receipt', receipt: result.value }
          : { kind: 'not_found', operationId },
      );
    });
  }
  function exportArchive(kind: 'before' | 'imported') {
    void task('Preparing the retained archive…', async (current) => {
      if (outcome?.kind !== 'receipt') return;
      const result = await readArchive.call(service, outcome.receipt.operationId, kind);
      if (!current()) return;
      if (result.kind === 'failed' || result.value === null) {
        setError('The retained archive could not be verified. No archive file was offered.');
        return;
      }
      assertBackupTextSize(result.value);
      setArchive({ kind, serialized: result.value });
      setArchiveVisible(false);
      let offered;
      try {
        const file = adapter();
        if (!current()) return;
        offered = await file.exportFile(result.value);
      } catch {
        if (current())
          setError(
            'The archive transfer result is unconfirmed. A download or share may already have been offered. Check your downloads or chosen destination before trying again.',
          );
        return;
      }
      if (current())
        setMessage(
          offered === 'download_requested'
            ? 'Archive download requested. Check your downloads; CookMate cannot confirm the file was saved.'
            : 'The archive share sheet has closed. Check the destination you chose; saving or delivery is not confirmed.',
        );
    });
  }
  const blocked = disabled || busy !== null;
  const unresolved = outcome?.kind === 'uncertain';
  return (
    <View style={styles.section}>
      <AppText role="section" accessibilityRole="header">
        Restore from a backup
      </AppText>
      <AppText>
        Restore replaces the backed-up cooking collections in this workspace. First choose a file
        and review the exact replacement. Inspecting a file above never starts a restore.
      </AppText>
      <ActionButton
        label="Choose file to review restore"
        variant="secondary"
        disabled={blocked || unresolved}
        onPress={choose}
      />
      {referenceError && (
        <Notice title="Recovery references unavailable" tone="error">
          {referenceError}
        </Notice>
      )}
      {cleanupReference && (
        <ActionButton
          label="Check retained recovery reference"
          variant="quiet"
          disabled={blocked}
          onPress={() => check(cleanupReference)}
        />
      )}
      {!installationId && !referenceError && (
        <AppText role="support">Loading this workspace’s recovery references…</AppText>
      )}
      {review && (
        <View style={styles.card}>
          <AppText role="section" accessibilityRole="header">
            Review replacement
          </AppText>
          <AppText role="support">
            Counts compare the current snapshot with the selected file. Purchased checks are
            reconciled below, and imported preference-removal records stay in the archive.
          </AppText>
          <RestoreCounts before={review.before} counts={review.after} />
          <RestoreScopeSummary scopes={review.replacedScopes} />
          {review.referenceSummary && <BackupReferenceSummary summary={review.referenceSummary} />}
          {review.shopping && (
            <Notice title="Shopping progress after restore" tone="caution">
              <AppText>
                {review.shopping.restoredChecks} purchased checks match and will be restored.{' '}
                {review.shopping.uncheckedImportedChecks} imported purchased checks will not be
                restored; review those items.
              </AppText>
              <AppText role="support">
                {contentMode
                  ? 'Quantities are rebuilt from the exact restored recipe versions and complete selected meals, including selections across weeks. Newer versions are not substituted.'
                  : 'Quantities are rebuilt from the current catalogue and the complete selected meals, including selections across weeks.'}
              </AppText>
            </Notice>
          )}
          {review.warnings.map((warning) => (
            <AppText key={warning} role="support">
              {warningCopy[warning] ??
                'This app cannot explain an additional restore consequence. Restore is unavailable until the app is updated.'}
            </AppText>
          ))}
          {review.blockers.map((blocker) => (
            <Notice key={blocker} title="Restore blocked" tone="error">
              {blockerCopy[blocker] ?? 'This restore cannot proceed.'}
            </Notice>
          ))}
          {!!review.unknownRecipeIds.length && (
            <AppText role="support">
              Unavailable recipe IDs: {review.unknownRecipeIds.join(', ')}.
            </AppText>
          )}
          <ActionButton
            label="Replace local cooking data"
            disabled={
              blocked ||
              !!review.blockers.length ||
              !review.shopping ||
              !installationId ||
              !!referenceError ||
              review.warnings.some((warning) => !warningCopy[warning])
            }
            onPress={confirm}
          />
          <ActionButton
            label="Refresh restore review"
            variant="quiet"
            disabled={blocked}
            onPress={() => void task('Refreshing the restore review…', reviewSource)}
          />
          <ActionButton
            label="Cancel restore review"
            variant="quiet"
            disabled={blocked}
            onPress={cancel}
          />
        </View>
      )}
      {!review && source.current !== null && !unresolved && (
        <ActionButton
          label="Refresh restore review"
          variant="secondary"
          disabled={blocked}
          onPress={() => void task('Refreshing the restore review…', reviewSource)}
        />
      )}
      {outcome?.kind === 'uncertain' && (
        <Notice title="Restore result is uncertain" tone="caution">
          <AppText>
            CookMate cannot yet prove whether this replacement committed. Do not repeat it. Check
            its saved receipt; no automatic retry will run.
          </AppText>
          <AppText role="support" selectable>
            Operation ID: {outcome.operationId}
          </AppText>
          <ActionButton
            label="Check restore receipt"
            variant="secondary"
            disabled={blocked}
            onPress={() => check(outcome.operationId)}
          />
        </Notice>
      )}
      {outcome?.kind === 'not_found' && (
        <Notice title="No committed receipt found" tone="caution">
          <AppText>
            CookMate will not replay this operation. Review the current workspace before choosing
            another file. The saved reference is retained for later checks.
          </AppText>
          <AppText role="support" selectable>
            Operation ID: {outcome.operationId}
          </AppText>
          <ActionButton
            label="Check restore receipt again"
            variant="quiet"
            disabled={blocked}
            onPress={() => check(outcome.operationId)}
          />
        </Notice>
      )}
      {outcome?.kind === 'receipt' && (
        <View style={styles.card}>
          <AppText role="section" accessibilityRole="header">
            Restore committed
          </AppText>
          <AppText role="support">
            Recorded {new Date(outcome.receipt.committedAt).toLocaleString()} · workspace revision{' '}
            {outcome.receipt.revision}.
          </AppText>
          <AppText role="support" selectable>
            Operation ID: {outcome.receipt.operationId}
          </AppText>
          <RestoreCounts counts={outcome.receipt.restoredCounts} />
          <RestoreScopeSummary scopes={outcome.receipt.replacedScopes} committed />
          <AppText>
            {outcome.receipt.shopping.restoredChecks} purchased checks restored;{' '}
            {outcome.receipt.shopping.uncheckedImportedChecks} imported checks left unchecked.
          </AppText>
          <AppText>
            {outcome.receipt.importedPreferenceRemovals} imported preference-removal records
            retained in the original-file archive.
          </AppText>
          <AppText role="support">
            These are the recorded results of this operation. Later edits may have changed the
            current workspace.
          </AppText>
          <Notice title="Keep the retained archives private" tone="caution">
            They contain unencrypted personal cooking data. Export each separately; ordinary backups
            do not include these archives. Clearing visible notes, collections, manual items or
            cooking history does not erase either retained archive or files you saved elsewhere.
          </Notice>
          <ActionButton
            label="Export pre-restore snapshot"
            variant="secondary"
            disabled={blocked}
            onPress={() => exportArchive('before')}
          />
          <ActionButton
            label="Export original imported file"
            variant="secondary"
            disabled={blocked}
            onPress={() => exportArchive('imported')}
          />
        </View>
      )}
      {archive && Platform.OS === 'web' && (
        <View style={styles.card}>
          <AppText role="bodyStrong">
            Prepared {archive.kind === 'before' ? 'pre-restore snapshot' : 'original imported file'}
          </AppText>
          <AppText role="support">
            This is the exact retained{' '}
            {archive.kind === 'before' ? 'snapshot of the replaced scopes' : 'selected file'}. It
            may contain private values removed from the current workspace. Revealing or copying it
            does not delete the retained archive.
          </AppText>
          <ActionButton
            label={archiveVisible ? 'Hide archive JSON' : 'Show archive JSON'}
            variant="quiet"
            disabled={blocked}
            onPress={() => {
              if (actionCurrent() && !running.current) setArchiveVisible((value) => !value);
            }}
          />
          {archiveVisible && (
            <TextInput
              accessibilityLabel="Retained archive JSON"
              editable={false}
              multiline
              selectTextOnFocus
              value={archive.serialized}
              style={styles.json}
            />
          )}
          <ActionButton
            label="Copy archive JSON"
            variant="secondary"
            disabled={blocked}
            onPress={() =>
              void task('Copying the retained archive…', async (current) => {
                const file = adapter();
                if (!file.copyText) throw new BackupTransferError('unavailable');
                await file.copyText(archive.serialized);
                if (current())
                  setMessage(
                    'Archive copied to the clipboard. Paste into a private .json file and inspect the saved file; copying alone is not a saved backup.',
                  );
              })
            }
          />
        </View>
      )}
      {!!savedReferences.length && (
        <View style={styles.section}>
          <AppText role="bodyStrong" accessibilityRole="header">
            Saved restore references
          </AppText>
          <AppText role="support">
            References allow receipt and archive lookup after reopening. A reference alone is not
            proof a restore happened.
          </AppText>
          {[...savedReferences].reverse().map((reference) => (
            <View key={reference.operationId}>
              <AppText role="support" selectable>
                {reference.operationId}
              </AppText>
              <ActionButton
                label={`Check saved restore ${reference.operationId.slice(0, 8)}`}
                variant="quiet"
                disabled={blocked}
                onPress={() => check(reference.operationId)}
              />
            </View>
          ))}
        </View>
      )}
      {busy && (
        <AppText role="support" accessibilityLiveRegion="polite">
          {busy}
        </AppText>
      )}
      {error && (
        <View accessibilityLiveRegion="polite">
          <Notice title="Restore needs attention" tone="error">
            {error}
          </Notice>
        </View>
      )}
      {message && (
        <AppText role="support" accessibilityLiveRegion="polite">
          {message}
        </AppText>
      )}
    </View>
  );
}

function RestoreCounts({
  before,
  counts,
}: {
  before?: Immutable<PortableBackupCounts>;
  counts: Immutable<PortableBackupCounts>;
}) {
  const styles = useThemedStyles(createStyles);
  const rows = [
    ['favourites', 'Saved favourites'],
    ['tombstones', 'Favourite removal records'],
    ['plannedMeals', 'Planned meals'],
    ['selectedMeals', 'Shopping meals'],
    ['purchaseMarks', 'Shopping progress records'],
    ['purchasedItems', 'Purchased checks'],
    ['preferences', 'Saved preferences'],
    ['preferenceRemovals', 'Preference removal records'],
  ] as const;
  return (
    <View style={styles.section}>
      <AppText role="bodyStrong">
        {before ? 'Current snapshot → selected backup' : 'Recorded restored collections'}
      </AppText>
      {rows.map(([key, label]) => (
        <View key={key} style={styles.countRow}>
          <AppText role="support" style={styles.countLabel}>
            {label}
          </AppText>
          <AppText
            role="bodyStrong"
            accessibilityLabel={
              before
                ? `${label}: current ${before[key]}, backup ${counts[key]}`
                : `Recorded ${label}: ${counts[key]}`
            }
          >
            {before ? `${before[key]} → ${counts[key]}` : counts[key]}
          </AppText>
        </View>
      ))}
      <ExpandedBackupCounts counts={counts} before={before} recorded={!before} />
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    card: {
      gap: t.space.sm,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      borderWidth: 1,
      borderColor: t.color.divider,
    },
    countRow: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.sm },
    countLabel: { flex: 1 },
    json: {
      height: 220,
      padding: t.space.sm,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: t.radius.small,
      color: t.color.ink,
      backgroundColor: t.color.canvas,
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 18,
      textAlignVertical: 'top',
    },
  });
