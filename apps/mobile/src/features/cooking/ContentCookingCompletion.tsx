import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { canonicalContentJson, type ReadingRecipe } from '@cookmate/catalogue/content';
import { COOKING_NOTE_MAX_CHARACTERS, isSupportedPlanDate, type Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import {
  validateContentCookedRecoveryReference,
  type ContentCookedReceipt,
  type SaveContentCookedInput,
} from '../../data/contentCookingHistoryRecords';
import { freezeResult } from '../../data/query';
import { formatPlanDate, type RuntimeClock } from '../workspace/runtimeClock';
import { CookingEntryForm } from './CookingEntryForm';
import { ContentCookingRecovery } from './ContentCookingRecovery';
import type { ContentCookingReaderHost } from './contentCookingPorts';
import type { ContentCookingReference } from './contentCookingReferences';
import { useContentSessionOperations } from './useContentCookingProgress';
import { useContentCookingScope } from './useContentCookingScope';

const same = (a: unknown, b: unknown) => canonicalContentJson(a) === canonicalContentJson(b);
export function ContentCookingCompletion({
  host,
  scopeKey,
  recipe,
  clock,
  visible,
  isCurrent: parentCurrent,
  onCancel,
  onCompleted,
}: {
  host: ContentCookingReaderHost;
  scopeKey: string;
  recipe: Immutable<ReadingRecipe>;
  clock: RuntimeClock;
  visible: boolean;
  isCurrent(): boolean;
  onCancel(): void;
  onCompleted(): Promise<void>;
}) {
  useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const styles = useThemedStyles(createStyles),
    isCurrent = useContentCookingScope(host, scopeKey, visible, parentCurrent);
  const [date, setDate] = useState(() => clock.dateContext().localDate),
    [note, setNote] = useState('');
  const [review, setReview] = useState<{
    epoch: number;
    session: SaveContentCookedInput['session'];
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [receipt, setReceipt] = useState<Immutable<ContentCookedReceipt> | null>(null);
  const running = useRef(false),
    historyGeneration = useRef(0),
    heading = useRef<View>(null),
    focused = useRef(false);
  const draft = useRef(note);
  draft.current = note;
  const latest = useRef({ onCompleted });
  latest.current = { onCompleted };
  const confirmed = useCallback(async () => {
    if (isCurrent()) await latest.current.onCompleted();
  }, [isCurrent]);
  const operations = useContentSessionOperations(host, isCurrent, confirmed);
  const liveOperations = useRef(operations);
  liveOperations.current = operations;
  useEffect(
    () =>
      host.subscribeCooking((change) => {
        if (!change.historyChanged) return;
        historyGeneration.current++;
        if (isCurrent()) {
          setReceipt(null);
          setReview(null);
        }
      }),
    [host, isCurrent],
  );
  const prepare = useCallback(async () => {
    if (!isCurrent() || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      const generation = historyGeneration.current;
      const history = await host.history.readHistory({ limit: 1 });
      if (!isCurrent()) return;
      const current = await host.sessions.readSession(recipe.recipeId);
      if (!isCurrent()) return;
      if (
        history.kind !== 'ready' ||
        current.kind !== 'ready' ||
        generation !== historyGeneration.current
      )
        throw new Error('Changed review');
      const session = current.value.session;
      if (
        session?.state === 'active' &&
        (session.readerVersion !== 2 || !same(session.contentRef, recipe.contentRef))
      )
        throw new Error('Other saved version');
      setReview({
        epoch: history.value.historyEpoch,
        session:
          session?.state === 'active'
            ? { sessionId: session.sessionId, expectedRevision: session.revision }
            : undefined,
      });
    } catch {
      if (isCurrent())
        setError(
          'Cooking history or the saved reading version could not be reviewed. Your draft is kept; review the current state before confirming.',
        );
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  }, [host, recipe, isCurrent]);
  useEffect(() => {
    focused.current = false;
    if (visible) {
      setReceipt(null);
      void prepare();
    }
  }, [visible, prepare]);
  const today = clock.dateContext().localDate,
    validDate = isSupportedPlanDate(date) && date <= today;
  async function accept(
    _receipt: Immutable<ContentCookedReceipt>,
    record: Immutable<ContentCookingReference>,
  ): Promise<boolean> {
    if (!isCurrent() || record.kind !== 'cooked') return false;
    const generation = historyGeneration.current;
    const proof = await host.cooked.readCookedRecovery(record.reference);
    if (!isCurrent()) return false;
    if (proof.kind !== 'ready' || !proof.value || generation !== historyGeneration.current) {
      setError(
        'The result could not be rechecked against current history. Its reference and your draft are retained.',
      );
      return false;
    }
    const value = proof.value,
      id = value.kind === 'saved' ? value.event.eventId : value.eventId;
    if (
      id !== record.reference.eventId ||
      (value.kind === 'saved' && !same(value.event.contentRef, record.reference.contentRef))
    )
      throw new Error('Receipt mismatch');
    // An earlier recipe's metadata can be resolved here without exposing its private note.
    if (same(record.reference.contentRef, recipe.contentRef)) setReceipt(value);
    setReview(null);
    setError(null);
    return true;
  }
  async function save() {
    if (
      !isCurrent() ||
      running.current ||
      !review ||
      !liveOperations.current.ready ||
      receipt ||
      !validDate ||
      Array.from(note).length > COOKING_NOTE_MAX_CHARACTERS
    )
      return;
    const submitted = note;
    const input = freezeResult<SaveContentCookedInput>({
      eventId: Crypto.randomUUID(),
      contentRef: recipe.contentRef,
      expectedHistoryEpoch: review.epoch,
      cookedOn: date,
      timeZone: clock.dateContext().timeZone,
      note: submitted || null,
      ...(review.session ? { session: review.session } : {}),
    });
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const prepared = await host.cooked.prepareCookedRecovery(input);
      if (!isCurrent()) return;
      if (
        prepared.kind !== 'ready' ||
        !validateContentCookedRecoveryReference(prepared.value) ||
        prepared.value.eventId !== input.eventId ||
        !same(prepared.value.contentRef, input.contentRef) ||
        prepared.value.expectedHistoryEpoch !== input.expectedHistoryEpoch ||
        !same(prepared.value.session, input.session ?? null)
      )
        throw new Error('Recovery preparation failed');
      const record = freezeResult<ContentCookingReference>({
        kind: 'cooked',
        createdAt: clock.now(),
        reference: prepared.value,
      });
      if (!(await liveOperations.current.recovery.remember(record)) || !isCurrent()) return;
      const result = await host.cooked.saveCooked(input);
      if (!isCurrent()) return;
      if (result.kind === 'ready') {
        if (!(await accept(result.value, record)) || !isCurrent()) return;
        await liveOperations.current.recovery.release(record);
        if (!isCurrent()) return;
        if (draft.current === submitted) setNote('');
        await confirmed();
      } else if (result.kind === 'failed') {
        await liveOperations.current.recovery.release(record);
        if (!isCurrent()) return;
        setReview(null);
        setError(
          'This request was rejected. Your draft is kept; review the current history and reading state before another confirmation.',
        );
      } else
        setError(
          'The save result is unconfirmed. Check or resolve the original request; no automatic retry will run.',
        );
    } catch {
      if (isCurrent())
        setError(
          'The cooking result could not be confirmed. Your draft is kept. Check any retained operation reference before another entry.',
        );
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  if (!visible || !isCurrent()) return null;
  const pending = operations.recovery.records.length > 0;
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View
        ref={heading}
        accessible
        accessibilityRole="header"
        accessibilityLabel="Cooking entry review"
        onLayout={() => {
          if (isCurrent() && !focused.current && focusTarget(heading.current))
            focused.current = true;
        }}
      >
        <AppText role="section">I cooked this</AppText>
      </View>
      <AppText role="bodyStrong">{recipe.title}</AppText>
      <AppText>
        Save one private cooking-history entry for this exact recipe version. This does not change
        planned meals, shopping checks or ingredients.
      </AppText>
      <Notice title="Stored only in this workspace">
        Cooking history and this note stay local. Compatible backups include history only when
        explicitly selected. Reading progress is separate and is not exported. Clearing app or
        browser storage can remove local data; backup files and restore archives remain separate
        copies.
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
          ) : (
            <AppText>
              {receipt.kind === 'cancelled'
                ? 'No cooking entry was saved for this operation. Its old request cannot create a late duplicate.'
                : 'This entry belonged to history that was later cleared. It has not been recreated.'}
            </AppText>
          )}
          <ActionButton
            label="Start a new cooking entry"
            variant="quiet"
            disabled={busy || pending}
            onPress={() => {
              if (!isCurrent() || running.current || liveOperations.current.recovery.records.length)
                return;
              setReceipt(null);
              setDate(today);
              void prepare();
            }}
          />
        </Notice>
      ) : (
        !pending && (
          <CookingEntryForm
            date={date}
            note={note}
            today={today}
            validDate={validDate}
            busy={busy}
            ready={operations.ready}
            reviewed={review !== null}
            onDate={(value) => {
              if (isCurrent() && !running.current) setDate(value);
            }}
            onNote={(value) => {
              if (isCurrent() && !running.current) setNote(value);
            }}
            onRefresh={() => void prepare()}
            onSave={() => void save()}
          />
        )
      )}
      <ContentCookingRecovery
        host={host}
        operations={operations}
        isCurrent={isCurrent}
        onConfirmed={confirmed}
        onCookedReceipt={accept}
      />
      {error && (
        <Notice title="Cooking history needs attention" tone="caution">
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
        onPress={() => {
          if (isCurrent() && !running.current) onCancel();
        }}
      />
    </ScrollView>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    content: { padding: t.space.gutter, paddingBottom: t.space.xl, gap: t.space.md },
  });
