import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { COOKING_NOTE_MAX_CHARACTERS, isSupportedPlanDate } from '@cookmate/domain';
import type {
  CookedReceipt,
  CookMateQueries,
  CookingService,
  CookingSession,
  CookingSessionView,
  Immutable,
  SaveCookedInput,
} from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { formatPlanDate, type RuntimeClock } from '../workspace/runtimeClock';
import { useCookingReferences } from './useCookingReferences';
import { CookingEntryForm } from './CookingEntryForm';

export function CookingCompletion({
  visible,
  service,
  readInstallationId,
  sessionView,
  title,
  clock,
  onCancel,
  onCompleted,
}: {
  visible: boolean;
  service: CookingService;
  readInstallationId: CookMateQueries['readInstallationId'];
  sessionView: Immutable<CookingSessionView>;
  title: string;
  clock: RuntimeClock;
  onCancel: () => void;
  onCompleted: (session: Immutable<CookingSession> | null) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const recovery = useCookingReferences(
    readInstallationId,
    'cooked',
    sessionView.currentContent.recipeId,
  );
  const [date, setDate] = useState(() => clock.dateContext().localDate);
  const [note, setNote] = useState('');
  const [epoch, setEpoch] = useState<number | null>(null);
  const [reviewedSession, setReviewedSession] = useState(sessionView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ eventId: string } | null>(null);
  const [receipt, setReceipt] = useState<Immutable<CookedReceipt> | null>(null);
  const terminalReceipt = useRef<Immutable<CookedReceipt> | null>(null);
  const historyChanges = useRef(0);
  const visibleNow = useRef(visible);
  visibleNow.current = visible;
  const mounted = useRef(true);
  const running = useRef(false);
  const heading = useRef<View>(null);
  const headingFocused = useRef(false);
  useEffect(() => {
    if (!visible) headingFocused.current = false;
  }, [visible]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () =>
      service.subscribe((change) => {
        if (!change.historyChanged) return;
        historyChanges.current++;
        if (terminalReceipt.current) {
          terminalReceipt.current = null;
          setReceipt(null);
          setNote('');
          setEpoch(null);
          setError(
            'Cooking history changed. Review its current state before adding another entry.',
          );
        }
      }),
    [service],
  );
  async function prepareReview() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setEpoch(null);
    try {
      const [result, currentSession] = await Promise.all([
        service.readHistory({ limit: 1 }),
        service.readSession(sessionView.currentContent.recipeId),
      ]);
      if (!mounted.current) return;
      if (
        result.kind === 'ready' &&
        currentSession.kind === 'ready' &&
        currentSession.value.resume !== 'content_changed'
      ) {
        setEpoch(result.value.historyEpoch);
        setReviewedSession(currentSession.value);
      } else setError('Cooking history could not be read. Nothing has been marked cooked.');
    } catch {
      if (mounted.current) setError('Cooking history could not be read. Try reviewing again.');
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!visible && terminalReceipt.current) {
      terminalReceipt.current = null;
      setReceipt(null);
      setNote('');
      setEpoch(null);
    }
    if (visible && !pending) {
      terminalReceipt.current = null;
      setReceipt(null);
      setDate(clock.dateContext().localDate);
      void prepareReview();
    }
  }, [visible, service]);
  const today = clock.dateContext().localDate;
  const noteLength = Array.from(note).length;
  const validDate = isSupportedPlanDate(date) && date <= today;
  async function accept(
    initial: Immutable<CookedReceipt>,
    expectedId: string,
    verifiedAt?: number,
  ) {
    let value = initial;
    if (value.kind === 'saved' && verifiedAt === undefined) {
      verifiedAt = historyChanges.current;
      const proof = await service.readCookedReceipt(expectedId);
      if (!mounted.current) return;
      if (proof.kind !== 'ready' || !proof.value) {
        setPending({ eventId: expectedId });
        setError(
          'The saved entry could not be rechecked. Keep its reference and check the receipt before another entry.',
        );
        return;
      }
      value = proof.value;
    }
    const id = value.kind === 'saved' ? value.event.eventId : value.eventId;
    if (
      id !== expectedId ||
      (value.kind === 'saved' && value.event.recipeId !== sessionView.currentContent.recipeId)
    ) {
      setError('The receipt identifies another recipe. No cooking success is claimed.');
      return;
    }
    if (value.kind === 'saved' && verifiedAt !== historyChanges.current) {
      setPending({ eventId: expectedId });
      setReceipt(null);
      setNote('');
      setError(
        'History changed while this receipt was checked. Check again before showing its private note.',
      );
      return;
    }
    terminalReceipt.current = visibleNow.current ? value : null;
    setReceipt(visibleNow.current ? value : null);
    setPending(null);
    setNote('');
    setError(null);
    if (value.kind === 'saved') onCompleted(value.closedSession);
    await recovery.release(expectedId, 'receipt');
  }
  async function save() {
    if (
      running.current ||
      pending ||
      receipt ||
      !recovery.ready ||
      recovery.references.length ||
      epoch === null ||
      !validDate ||
      noteLength > COOKING_NOTE_MAX_CHARACTERS
    )
      return;
    const input: Immutable<SaveCookedInput> = Object.freeze({
      eventId: Crypto.randomUUID(),
      recipeId: reviewedSession.currentContent.recipeId,
      contentFingerprint: reviewedSession.currentContent.contentFingerprint,
      readerVersion: 1,
      expectedHistoryEpoch: epoch,
      cookedOn: date,
      timeZone: clock.dateContext().timeZone,
      note: note || null,
      ...(reviewedSession.session?.state === 'active'
        ? {
            session: {
              sessionId: reviewedSession.session.sessionId,
              expectedRevision: reviewedSession.session.revision,
            },
          }
        : {}),
    });
    running.current = true;
    setBusy(true);
    setError(null);
    setPending({ eventId: input.eventId });
    try {
      const recorded = await recovery.remember(input.eventId);
      if (!recorded || !mounted.current || !visibleNow.current) {
        await recovery.release(input.eventId, 'not_dispatched');
        if (mounted.current) setPending(null);
        return;
      }
      const result = await service.saveCooked(input);
      if (result.kind === 'failed') await recovery.release(input.eventId, 'definite_failure');
      if (!mounted.current) return;
      if (result.kind === 'ready') await accept(result.value, input.eventId);
      else if (result.kind === 'failed') {
        setPending(null);
        setEpoch(null);
        setError(
          'This cooking entry was not saved. The history or saved reading session may have changed. Review the current state before trying again.',
        );
      } else
        setError(
          'The save result is uncertain. Check its receipt instead of marking the recipe cooked again.',
        );
    } catch {
      if (mounted.current)
        setError('The save result is uncertain. Check its receipt; no automatic retry will run.');
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function check(operationId: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const verifiedAt = historyChanges.current;
      const result = await service.readCookedReceipt(operationId);
      if (!mounted.current) return;
      if (result.kind === 'ready' && result.value) {
        const id =
          result.value.kind === 'saved' ? result.value.event.eventId : result.value.eventId;
        if (id === operationId) await accept(result.value, operationId, verifiedAt);
        else setError('The receipt does not match this cooking entry. No success is claimed.');
      } else
        setError(
          'No saved receipt could be confirmed. The entry has not been repeated. Check history before creating another entry.',
        );
    } catch {
      if (mounted.current)
        setError(
          'The receipt could not be checked. Keep the event ID; no entry has been repeated.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function resolve(operationId: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const verifiedAt = historyChanges.current;
      const result = await service.resolveCookedOperation(operationId);
      if (!mounted.current) return;
      if (result.kind === 'ready') await accept(result.value, operationId, verifiedAt);
      else
        setError(
          'The earlier change could not be resolved. Its reference is retained; no new cooking entry was created.',
        );
    } catch {
      if (mounted.current)
        setError(
          'The resolution result is unconfirmed. Keep the operation reference and check again.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function newEntry() {
    if (running.current || recovery.references.length) return;
    terminalReceipt.current = null;
    setReceipt(null);
    setNote('');
    setDate(today);
    void prepareReview();
  }
  if (!visible) return null;
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View
        ref={heading}
        accessible
        accessibilityRole="header"
        accessibilityLabel="Cooking entry review"
        onLayout={() => {
          if (visible && !headingFocused.current && focusTarget(heading.current))
            headingFocused.current = true;
        }}
      >
        <AppText role="section">I cooked this</AppText>
      </View>
      <AppText role="bodyStrong">{title}</AppText>
      <AppText>
        Save one private cooking-history entry. This does not change planned meals, shopping checks
        or ingredients.
      </AppText>
      <Notice title="Stored only in this workspace">
        Cooking history and this note stay local. In an expanded backup, include cooking history
        explicitly to copy them. Reading progress is not backed up. Clearing app or browser storage
        can remove local data; backup files and restore archives remain separate copies.
      </Notice>
      {receipt ? (
        <Notice
          title={
            receipt.kind === 'saved'
              ? 'Cooking entry saved'
              : receipt.kind === 'cancelled'
                ? 'Unconfirmed cooking change cancelled'
                : 'This entry was cleared'
          }
        >
          {receipt.kind === 'saved' ? (
            <>
              <AppText>
                {receipt.event.recipeTitle} · {formatPlanDate(receipt.event.cookedOn)}
              </AppText>
              {!!receipt.event.note && <AppText selectable>{receipt.event.note}</AppText>}
            </>
          ) : receipt.kind === 'cancelled' ? (
            <AppText>
              No cooking entry was saved for this operation. The old request is cancelled and cannot
              create a late duplicate.
            </AppText>
          ) : (
            <AppText>
              The receipt confirms this entry belonged to history that was later cleared. It has not
              been recreated.
            </AppText>
          )}
          <ActionButton
            label="Start a new cooking entry"
            variant="quiet"
            disabled={busy || !!recovery.references.length}
            onPress={newEntry}
          />
        </Notice>
      ) : pending ? (
        <View style={styles.section}>
          <AppText role="support" selectable>
            Event ID: {pending.eventId}
          </AppText>
          <ActionButton
            label="Check cooking receipt"
            disabled={busy}
            onPress={() => void check(pending.eventId)}
          />
          <AppText role="support">
            Resolve the earlier change to show an existing receipt or cancel its unsaved request.
            This will not create another cooking entry.
          </AppText>
          <ActionButton
            label="Resolve unconfirmed cooking change"
            variant="secondary"
            disabled={busy}
            onPress={() => void resolve(pending.eventId)}
          />
        </View>
      ) : recovery.references.length ? (
        <Notice title="Check an earlier cooking entry" tone="caution">
          A saved operation reference needs receipt verification before another entry is created for
          this recipe. It will not be replayed.
        </Notice>
      ) : (
        <CookingEntryForm
          date={date}
          note={note}
          today={today}
          validDate={validDate}
          busy={busy}
          ready={recovery.ready}
          reviewed={epoch !== null}
          onDate={setDate}
          onNote={setNote}
          onRefresh={() => void prepareReview()}
          onSave={() => void save()}
        />
      )}
      {recovery.error && (
        <Notice title="Cooking recovery needs attention" tone="error">
          {recovery.error}
        </Notice>
      )}
      {!recovery.ready && !recovery.error && (
        <AppText role="support">Loading cooking recovery references…</AppText>
      )}
      {recovery.references
        .filter((reference) => reference.operationId !== pending?.eventId)
        .map((reference) => (
          <View key={reference.operationId} style={styles.section}>
            <AppText role="support" selectable>
              Event ID: {reference.operationId}
            </AppText>
            <ActionButton
              label="Check earlier cooking receipt"
              disabled={busy}
              variant="secondary"
              onPress={() => void check(reference.operationId)}
            />
            <AppText role="support">
              Resolution shows a saved result or cancels an unsaved old request. It does not repeat
              the cooking entry.
            </AppText>
            <ActionButton
              label="Resolve unconfirmed cooking change"
              variant="secondary"
              disabled={busy}
              onPress={() => void resolve(reference.operationId)}
            />
          </View>
        ))}
      {error && (
        <Notice title="Cooking history needs attention" tone="error">
          {error}
        </Notice>
      )}
      {busy && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Checking your cooking history…
        </AppText>
      )}
      <ActionButton
        label={receipt || pending ? 'Return to recipe instructions' : 'Cancel cooking entry'}
        variant="quiet"
        disabled={busy}
        onPress={onCancel}
      />
    </ScrollView>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    content: { padding: t.space.gutter, paddingBottom: t.space.xl, gap: t.space.md },
    section: { gap: t.space.sm },
  });
