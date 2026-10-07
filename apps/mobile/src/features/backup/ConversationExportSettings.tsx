import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { formatConversationExportText } from '@cookmate/domain';
import type { ConversationExportSnapshot, CookMateServices, Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { createBackupTransfer } from './backupTransfer';
import type { BackupTransfer } from './backupTransferTypes';

const PREVIEW_CHARACTERS = 6000;
type PreparedTranscript = {
  owner: CookMateServices;
  snapshot: Immutable<ConversationExportSnapshot>;
  text: string;
};

/** Explicit, local-only display export. This component never reads or writes a composer draft. */
export function ConversationExportSettings({
  createTransfer = () => createBackupTransfer('conversation'),
}: {
  createTransfer?: () => BackupTransfer;
}) {
  const { availability } = useWorkspace();
  const services = availability.kind === 'ready' ? availability.services : null;
  const styles = useThemedStyles(createStyles);
  const [prepared, setPrepared] = useState<PreparedTranscript | null>(null);
  const visiblePrepared = prepared?.owner === services ? prepared : null;
  const [busy, setBusy] = useState<'prepare' | 'export' | 'copy' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const running = useRef(false);
  const transfer = useRef<BackupTransfer | null>(null);
  const owner = useRef(services);
  owner.current = services;

  useFocusEffect(
    useCallback(() => {
      active.current = true;
      setPrepared(null);
      setMessage(null);
      setError(null);
      setBusy(null);
      setShowText(false);
      return () => {
        active.current = false;
        generation.current++;
        running.current = false;
        transfer.current?.dispose();
        transfer.current = null;
      };
    }, [services]),
  );

  async function run(kind: 'prepare' | 'export' | 'copy') {
    // A press queued by an old render must not read or transfer that owner's private transcript.
    if (owner.current !== services) return;
    if (!active.current || running.current || !services?.queries.readConversationExport) return;
    if (kind !== 'prepare' && !visiblePrepared) return;
    const ownServices = services;
    const ownGeneration = ++generation.current;
    const current = () =>
      active.current && generation.current === ownGeneration && owner.current === ownServices;
    running.current = true;
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      if (kind === 'prepare') {
        setPrepared(null);
        setShowText(false);
        const result = await ownServices.queries.readConversationExport!();
        if (!current()) return;
        if (result.kind !== 'ready') {
          setError(
            result.error.code === 'too_large'
              ? 'This conversation exceeds the export limit of 1,000 messages or 2 MiB. No partial transcript was created; your saved conversation is unchanged.'
              : 'The saved conversation could not be read safely. Nothing was exported. Try again after storage recovery.',
          );
          return;
        }
        if (result.value.counts.messages === 0) {
          setMessage(
            'No saved messages to export. Unsent drafts and example conversations are not included.',
          );
          return;
        }
        const text = formatConversationExportText(result.value);
        if (current()) setPrepared({ owner: ownServices, snapshot: result.value, text });
      } else {
        const document = visiblePrepared!;
        const transport = (transfer.current ??= createTransfer());
        if (kind === 'copy') {
          if (!transport.copyText) throw new Error('Copy unavailable');
          await transport.copyText(document.text);
          if (current())
            setMessage(
              'Transcript copied. Paste it into a private text file to keep it. This is not a restorable backup.',
            );
        } else {
          const result = await transport.exportFile(document.text);
          if (current())
            setMessage(
              result === 'download_requested'
                ? 'Download requested. Check your browser’s downloads to confirm the transcript was saved.'
                : 'The share sheet has closed. Check your chosen destination; CookMate cannot tell whether you saved, shared or cancelled.',
            );
        }
      }
    } catch {
      if (current())
        setError(
          kind === 'prepare'
            ? 'The conversation could not be prepared within the supported format. Nothing was exported.'
            : kind === 'copy'
              ? 'The browser did not confirm copying. Your transcript is still available here.'
              : 'The transcript could not be offered as a file. Your saved conversation is unchanged.',
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
      <AppText role="section" accessibilityRole="header">
        Export conversation
      </AppText>
      <AppText role="support">
        Make a private, readable text copy of saved messages and their stored recipe references. It
        is separate from cooking backups and cloud sync, and cannot be restored or replay actions.
      </AppText>
      <AppText role="support" color="inkSecondary">
        Unsent drafts, credentials, internal prompts, AI consent and pending action instructions are
        excluded. The unencrypted file may still contain personal information you wrote in messages.
      </AppText>
      <ActionButton
        label={visiblePrepared ? 'Prepare a new transcript' : 'Preview conversation export'}
        variant="secondary"
        disabled={!services?.queries.readConversationExport || busy !== null}
        busy={busy === 'prepare'}
        onPress={() => void run('prepare')}
      />
      {!services?.queries.readConversationExport && (
        <AppText role="support">
          Conversation export is unavailable until this workspace is ready.
        </AppText>
      )}
      {error && (
        <Notice title="Export not completed" tone="error">
          {error}
        </Notice>
      )}
      {message && <Notice title="Conversation export">{message}</Notice>}
      {visiblePrepared && (
        <View style={styles.preview}>
          <AppText role="bodyStrong">Review this export</AppText>
          <AppText role="support">
            {visiblePrepared.snapshot.counts.messages} saved messages ·{' '}
            {visiblePrepared.snapshot.counts.recipeReferences} recipe references
          </AppText>
          <AppText role="support" color="inkSecondary">
            Snapshot prepared {visiblePrepared.snapshot.exportedAt}. Later messages are not added to
            this copy. Stored recipe IDs are preserved; historical recipe revisions are not recorded
            in this transcript.
          </AppText>
          <ActionButton
            label={showText ? 'Hide transcript preview' : 'Read transcript preview'}
            variant="quiet"
            onPress={() => setShowText(!showText)}
          />
          {showText && (
            <>
              {visiblePrepared.text.length > PREVIEW_CHARACTERS && (
                <AppText role="support">
                  Showing the first {PREVIEW_CHARACTERS.toLocaleString()} characters here. The file
                  and copy actions include the complete prepared transcript.
                </AppText>
              )}
              <TextInput
                accessibilityLabel="Conversation transcript preview"
                multiline
                editable={false}
                value={visiblePrepared.text.slice(0, PREVIEW_CHARACTERS)}
                style={styles.text}
              />
            </>
          )}
          <ActionButton
            label={Platform.OS === 'web' ? 'Download transcript' : 'Save or share transcript'}
            disabled={busy !== null}
            busy={busy === 'export'}
            onPress={() => void run('export')}
          />
          {Platform.OS === 'web' && (
            <ActionButton
              label="Copy transcript"
              variant="secondary"
              disabled={busy !== null}
              busy={busy === 'copy'}
              onPress={() => void run('copy')}
            />
          )}
          <ActionButton
            label="Close export preview"
            variant="quiet"
            disabled={busy !== null}
            onPress={() => {
              setPrepared(null);
              setShowText(false);
              setMessage(null);
              setError(null);
            }}
          />
        </View>
      )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    preview: {
      gap: t.space.md,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    text: {
      color: t.color.ink,
      backgroundColor: t.color.canvas,
      padding: t.space.md,
      borderRadius: t.radius.control,
      minHeight: 160,
      maxHeight: 280,
      textAlignVertical: 'top',
      fontSize: 14,
      lineHeight: 21,
    },
  });
