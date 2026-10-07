import { useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  personalLimits,
  type Immutable,
  type RecipeNote,
  type PersonalCommand,
  type PersonalMutationResult,
  type PersonalReceipt,
} from '@cookmate/domain';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { confirmAction } from '../../components/confirmAction';
import { fieldHelpProps } from '../../components/fieldHelpProps';
import { useTheme } from '../../design/ThemeProvider';
import { useUnsavedDraft } from '../../hooks/useUnsavedDraft';
import { usePersonalStyles, validPersonalText } from './PersonalUI';
import type { usePersonalOperations } from './usePersonalOperations';
export type NoteSnapshot = Immutable<{ epoch: number; note: RecipeNote | null }>;
export type NoteExecute = (
  command: Immutable<Extract<PersonalCommand, { kind: 'saveNote' | 'deleteNote' }>>,
) => Promise<PersonalMutationResult>;
type NoteRecovery = { receipt: Immutable<PersonalReceipt>; snapshot: NoteSnapshot | undefined };
const alwaysCurrent = () => true;
/** Shared editor; collection membership and content identity authority stay with its callers. */
export function RecipeNoteEditor({
  recipeId,
  query,
  operation,
  execute,
  canAddNote,
  isCurrent = alwaysCurrent,
  onEditingChange,
}: {
  recipeId: string;
  query: {
    value: NoteSnapshot | null;
    loading: boolean;
    error: string | null;
    reload(): Promise<void>;
    refresh(): Promise<NoteSnapshot | undefined>;
  };
  operation: ReturnType<typeof usePersonalOperations>;
  execute: NoteExecute;
  canAddNote: boolean;
  isCurrent?: () => boolean;
  onEditingChange?: (value: boolean) => void;
}) {
  const styles = usePersonalStyles();
  const [editing, setEditing] = useState<NoteSnapshot | null>(null);
  const [deleting, setDeleting] = useState<NoteSnapshot | null>(null);
  const [recovered, setRecovered] = useState<NoteRecovery | null>(null);
  const deletingOperation = useRef<string | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ query, operation, editing, deleting, isCurrent });
  latest.current = { query, operation, editing, deleting, isCurrent };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () => mounted.current && latest.current.isCurrent === isCurrent && isCurrent();
  const changeEditor = (value: NoteSnapshot | null) => {
    if (active()) {
      setEditing(value);
      onEditingChange?.(!!value);
    }
  };
  async function refreshReceipt(receipt: Immutable<PersonalReceipt>) {
    if (!active()) return;
    const value = await latest.current.query.refresh();
    if (active() && latest.current.operation.receipt === receipt)
      setRecovered({ receipt, snapshot: value });
  }
  useEffect(() => {
    const receipt = operation.receipt;
    if (!receipt || !active() || !['saveNote', 'deleteNote', null].includes(receipt.commandKind))
      return;
    if (receipt.operationId === deletingOperation.current) {
      setDeleting(null);
      deletingOperation.current = null;
    }
    void refreshReceipt(receipt);
  }, [operation.receipt]);
  async function removeNote() {
    const snapshot = deleting;
    if (
      !active() ||
      latest.current.deleting !== snapshot ||
      !snapshot?.note ||
      !latest.current.operation.ready
    )
      return;
    const note = snapshot.note;
    const saved = await operation.perform((operationId) => {
      deletingOperation.current = operationId;
      return execute({
        kind: 'deleteNote',
        operationId,
        expectedEpoch: snapshot.epoch,
        noteId: note.noteId,
        expectedRevision: note.revision,
      });
    });
    if (saved && active()) {
      setDeleting(null);
      await query.reload();
    }
  }
  return (
    <>
      {query.error && (
        <Notice title="Private note unavailable" tone="error">
          <AppText>{query.error}</AppText>
          <ActionButton
            label="Retry private recipe data"
            variant="secondary"
            disabled={operation.busy || query.loading}
            onPress={() => {
              if (active()) {
                if (operation.receipt) void refreshReceipt(operation.receipt);
                else void query.reload();
              }
            }}
          />
        </Notice>
      )}
      {operation.receipt &&
        recovered?.receipt === operation.receipt &&
        !recovered.snapshot &&
        !query.loading && (
          <Notice title="Check the current saved note">
            <AppText>
              The operation receipt is retained. Reload the saved note before making another change.
            </AppText>
            <ActionButton
              label="Reload saved private note"
              variant="secondary"
              disabled={operation.busy}
              onPress={() => {
                if (active() && operation.receipt) void refreshReceipt(operation.receipt);
              }}
            />
          </Notice>
        )}
      {query.loading && <AppText role="support">Loading private recipe data…</AppText>}
      {editing ? (
        <NoteForm
          snapshot={editing}
          recovered={recovered}
          recipeId={recipeId}
          execute={execute}
          operation={operation}
          isCurrent={isCurrent}
          onClose={() => changeEditor(null)}
        />
      ) : (
        query.value && (
          <View style={styles.card}>
            <AppText role="section">Private note</AppText>
            <AppText selectable>
              {query.value.note?.text ??
                'Keep your own substitutions or reminders here. Original recipe instructions stay unchanged.'}
            </AppText>
            <ActionButton
              label={query.value.note?.text ? 'Edit private note' : 'Add private note'}
              variant="secondary"
              disabled={
                !operation.ready ||
                query.loading ||
                !!query.error ||
                (!query.value.note?.text && !canAddNote)
              }
              onPress={() => {
                if (
                  active() &&
                  latest.current.query === query &&
                  operation.ready &&
                  !query.loading &&
                  !query.error &&
                  (!!query.value?.note?.text || canAddNote)
                ) {
                  setDeleting(null);
                  changeEditor(query.value);
                }
              }}
            />
            {!!query.value.note?.text && (
              <ActionButton
                label="Delete private note"
                variant="quiet"
                disabled={!operation.ready || query.loading || !!query.error}
                onPress={() => {
                  if (
                    active() &&
                    latest.current.query === query &&
                    operation.ready &&
                    !query.loading &&
                    !query.error
                  )
                    setDeleting(query.value);
                }}
              />
            )}
            {deleting && (
              <Notice title="Delete this private note?">
                <AppText>
                  Your note will be removed from this workspace. Recipe instructions and collections
                  remain.
                </AppText>
                <AppText selectable>{deleting.note?.text}</AppText>
                <ActionButton
                  label="Confirm delete private note"
                  disabled={!operation.ready}
                  onPress={() => void removeNote()}
                />
                <ActionButton
                  label="Keep private note"
                  variant="quiet"
                  disabled={operation.busy}
                  onPress={() => {
                    if (active() && !latest.current.operation.busy) setDeleting(null);
                  }}
                />
              </Notice>
            )}
          </View>
        )
      )}
    </>
  );
}
function NoteForm({
  snapshot,
  recovered,
  recipeId,
  execute,
  isCurrent,
  operation,
  onClose,
}: {
  snapshot: NoteSnapshot;
  recovered: NoteRecovery | null;
  recipeId: string;
  execute: NoteExecute;
  isCurrent(): boolean;
  operation: ReturnType<typeof usePersonalOperations>;
  onClose(): void;
}) {
  const styles = usePersonalStyles();
  const controls = useControlStyles();
  const theme = useTheme();
  const helpId = useId();
  const [baselineSnapshot, setBaselineSnapshot] = useState(snapshot);
  const [submission, setSubmission] = useState<{
    operationId: string;
    noteId: string;
    text: string;
  } | null>(null);
  const [changedAfterSave, setChangedAfterSave] = useState(false);
  const baseline = baselineSnapshot.note?.text ?? '';
  const [text, setText] = useState(baseline);
  const count = Array.from(text).length;
  const nearLimit = count >= personalLimits.noteCharacters * 0.9;
  const tooLong = count > personalLimits.noteCharacters;
  const guidance = `${count}/${personalLimits.noteCharacters} characters${tooLong ? '. Shorten your note before saving.' : ''}`;
  useUnsavedDraft(text !== baseline, 'Discard private note changes?');
  const mounted = useRef(true);
  const latest = useRef({
    text,
    operation,
    isCurrent,
    baselineSnapshot,
    submission,
    changedAfterSave,
  });
  latest.current = { text, operation, isCurrent, baselineSnapshot, submission, changedAfterSave };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () => mounted.current && isCurrent() && latest.current.isCurrent === isCurrent;
  function close() {
    if (active()) onClose();
  }
  const confirmed = !!submission && operation.receipt?.operationId === submission.operationId;
  useEffect(() => {
    if (
      !active() ||
      !submission ||
      !recovered ||
      recovered.receipt.operationId !== submission.operationId ||
      !recovered.snapshot
    )
      return;
    const receipt = recovered.receipt,
      fresh = recovered.snapshot;
    const saved = receipt.outcome === 'committed' || receipt.outcome === 'no_op';
    const matching = saved
      ? fresh.epoch === receipt.epoch &&
        fresh.note?.noteId === submission.noteId &&
        fresh.note.revision === receipt.revision
      : fresh.epoch === baselineSnapshot.epoch &&
        fresh.note?.revision === baselineSnapshot.note?.revision &&
        fresh.note?.noteId === baselineSnapshot.note?.noteId;
    if (!matching) {
      setChangedAfterSave(true);
      return;
    }
    if (saved && latest.current.text === submission.text) {
      close();
      return;
    }
    setBaselineSnapshot(fresh);
    setSubmission(null);
    setChangedAfterSave(false);
  }, [recovered, submission]);
  function cancel() {
    if (!active() || latest.current.operation.busy) return;
    if (text === baseline) {
      close();
      return;
    }
    confirmAction({
      title: 'Discard private note changes?',
      message: 'Your saved note will stay unchanged.',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard changes',
      destructive: true,
      onConfirm: close,
    });
  }
  async function save() {
    if (
      !active() ||
      !latest.current.operation.ready ||
      confirmed ||
      changedAfterSave ||
      latest.current.text !== text ||
      latest.current.baselineSnapshot !== baselineSnapshot ||
      latest.current.submission !== submission ||
      latest.current.changedAfterSave ||
      !validPersonalText(text, personalLimits.noteCharacters) ||
      text === baseline
    )
      return;
    const noteId = baselineSnapshot.note?.noteId ?? Crypto.randomUUID();
    const saved = await operation.perform((operationId) => {
      setSubmission({ operationId, noteId, text });
      return execute({
        kind: 'saveNote',
        operationId,
        expectedEpoch: baselineSnapshot.epoch,
        recipeId,
        noteId,
        expectedRevision: baselineSnapshot.note?.revision ?? null,
        text,
      });
    });
    if (saved) close();
  }
  return (
    <View style={styles.section}>
      <AppText role="support" color="inkSecondary">
        Private to this workspace. Original instructions stay unchanged.
      </AppText>
      <AppText role="label">Private recipe note</AppText>
      <TextInput
        accessibilityLabel="Private recipe note"
        {...(nearLimit ? fieldHelpProps({ id: helpId, text: guidance, invalid: tooLong }) : {})}
        value={text}
        onChangeText={(value) => {
          if (active() && !latest.current.operation.busy) setText(value);
        }}
        multiline
        autoFocus
        maxLength={personalLimits.noteCharacters * 2}
        placeholder="Your substitutions, reminders or ideas for next time…"
        placeholderTextColor={theme.color.inkSecondary}
        style={[controls.field, detailStyles.noteField]}
        editable={!operation.busy}
      />
      {nearLimit && (
        <AppText nativeID={helpId} role="support" color={tooLong ? 'error' : 'inkSecondary'}>
          {guidance}
        </AppText>
      )}
      {changedAfterSave && (
        <Notice title="Saved note changed">
          Your draft is kept here. Cancel editing and reopen the current saved note before reviewing
          another save.
        </Notice>
      )}
      <ActionButton
        label="Save private note"
        disabled={
          !operation.ready ||
          confirmed ||
          changedAfterSave ||
          !validPersonalText(text, personalLimits.noteCharacters) ||
          text === baseline
        }
        onPress={() => void save()}
      />
      <ActionButton
        label="Cancel note changes"
        variant="quiet"
        disabled={operation.busy}
        onPress={cancel}
      />
    </View>
  );
}
const detailStyles = StyleSheet.create({ noteField: { minHeight: 220, textAlignVertical: 'top' } });
