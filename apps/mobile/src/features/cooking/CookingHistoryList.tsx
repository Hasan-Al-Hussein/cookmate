import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { getRecipe } from '@cookmate/catalogue';
import type {
  ClearCookingHistoryReceipt,
  ClearCookingHistoryReview,
  CookMateQueries,
  CookingService,
  Immutable,
  RepositoryResult,
} from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { IconButton } from '../../components/Icon';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { formatPlanDate } from '../workspace/runtimeClock';
import { useCookingReferences } from './useCookingReferences';
import type { CookingReferenceStore } from './cookingReferences';

interface HistoryPage<Item> {
  items: readonly Item[];
  historyRevision: number;
  historyEpoch: number;
  nextCursor: string | null;
}
export type CookingHistoryListService<Item> = Pick<
  CookingService,
  | 'reviewClearHistory'
  | 'clearHistory'
  | 'readClearHistoryReceipt'
  | 'resolveClearHistoryOperation'
  | 'subscribe'
> & {
  readHistory(input?: {
    limit?: number;
    cursor?: string;
  }): Promise<RepositoryResult<HistoryPage<Item>>>;
};
const alwaysCurrent = () => true;

/** One pagination/clear/recovery engine; exact content rows never become legacy CookingService data. */
export function CookingHistoryList<Item>({
  service,
  readInstallationId,
  renderItem,
  itemKey,
  cookedRecovery,
  isCurrent = alwaysCurrent,
  emptyContent,
  privacyDetails,
  references,
}: {
  service: CookingHistoryListService<Item>;
  readInstallationId: CookMateQueries['readInstallationId'];
  renderItem(item: Item): ReactNode;
  itemKey(item: Item): string;
  cookedRecovery?: Pick<CookingService, 'readCookedReceipt' | 'resolveCookedOperation'>;
  isCurrent?: () => boolean;
  emptyContent: ReactNode;
  privacyDetails: ReactNode;
  references?: CookingReferenceStore;
}) {
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const recovery = useCookingReferences(readInstallationId, 'clear_history', null, references);
  const [page, setPage] = useState<HistoryPage<Item> | null>(null);
  const [items, setItems] = useState<readonly Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Immutable<ClearCookingHistoryReview> | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Immutable<ClearCookingHistoryReceipt> | null>(null);
  const [changed, setChanged] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const active = useRef(false);
  const running = useRef(false);
  const generation = useRef(0);
  const taskSequence = useRef(0);
  const historyGeneration = useRef(0);
  const latest = useRef({ isCurrent, review, pendingId, service });
  latest.current = { isCurrent, review, pendingId, service };
  function dismissReview() {
    latest.current.review = null;
    setReview(null);
  }
  const currentPage = useRef<HistoryPage<Item> | null>(null);

  async function task(work: (current: () => boolean) => Promise<void>) {
    if (
      !active.current ||
      running.current ||
      latest.current.service !== service ||
      !latest.current.isCurrent()
    )
      return;
    running.current = true;
    setBusy(true);
    setError(null);
    const ownTask = ++taskSequence.current;
    const ownGeneration = generation.current;
    const current = () =>
      active.current &&
      generation.current === ownGeneration &&
      latest.current.service === service &&
      latest.current.isCurrent();
    try {
      await work(current);
    } catch {
      if (current())
        setError('Cooking history could not be checked. No successful change is claimed.');
    } finally {
      if (taskSequence.current === ownTask) {
        running.current = false;
        if (current()) setBusy(false);
      }
    }
  }
  async function readPage(current: () => boolean, cursor?: string) {
    const historyAtRead = historyGeneration.current;
    const result = await service.readHistory({ limit: 20, ...(cursor ? { cursor } : {}) });
    if (!current()) return;
    if (historyAtRead !== historyGeneration.current) {
      setChanged(true);
      setError('History changed while loading. Refresh to read its current entries.');
      return;
    }
    if (result.kind === 'failed') {
      setError('Cooking history could not be loaded. Your saved entries have not been cleared.');
      return;
    }
    if (
      cursor &&
      currentPage.current &&
      (result.value.historyRevision !== currentPage.current.historyRevision ||
        result.value.historyEpoch !== currentPage.current.historyEpoch)
    ) {
      setChanged(true);
      setError('History changed while loading more entries. Refresh the list before continuing.');
      return;
    }
    currentPage.current = result.value;
    setPage(result.value);
    setItems((previous) => (cursor ? [...previous, ...result.value.items] : result.value.items));
    setChanged(false);
  }
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      generation.current++;
      taskSequence.current++;
      running.current = false;
      setBusy(false);
      dismissReview();
      setOptionsOpen(false);
      setReceipt(null);
      setRecoveryMessage(null);
      setError(null);
      setChanged(false);
      setPage(null);
      setItems([]);
      currentPage.current = null;
      void task((current) => readPage(current));
      const unsubscribe = service.subscribe((change) => {
        if (!active.current || !latest.current.isCurrent() || !change.historyChanged) return;
        historyGeneration.current++;
        // Removed notes must not remain visible until a later manual refresh.
        setItems([]);
        setPage(null);
        currentPage.current = null;
        setChanged(true);
        dismissReview();
        if (!running.current) void task((current) => readPage(current));
      });
      return () => {
        active.current = false;
        generation.current++;
        taskSequence.current++;
        running.current = false;
        unsubscribe();
        setItems([]);
        setPage(null);
        dismissReview();
      };
    }, [service]),
  );

  function reviewClear() {
    void task(async (current) => {
      const result = await service.reviewClearHistory();
      if (!current()) return;
      if (result.kind === 'failed') {
        setError(
          'The current history could not be reviewed for clearing. No entries were removed.',
        );
        return;
      }
      latest.current.review = result.value;
      setReview(result.value);
      setReceipt(null);
    });
  }
  async function acceptClear(value: Immutable<ClearCookingHistoryReceipt>, current: () => boolean) {
    if (!current()) return;
    setReceipt(value);
    setPendingId(null);
    dismissReview();
    if (value.outcome === 'cleared') {
      setItems([]);
      setPage(null);
      currentPage.current = null;
      setChanged(true);
    }
    if (current()) await recovery.release(value.operationId, 'receipt');
  }
  function clear() {
    void task(async (current) => {
      if (
        !review ||
        review !== latest.current.review ||
        latest.current.pendingId ||
        !recovery.ready ||
        recovery.references.length
      )
        return;
      const operationId = Crypto.randomUUID();
      setPendingId(operationId);
      try {
        const recorded = await recovery.remember(operationId);
        if (!recorded || !current()) {
          if (current()) await recovery.release(operationId, 'not_dispatched');
          if (current()) setPendingId(null);
          return;
        }
        const result = await service.clearHistory(review, operationId);
        if (current() && result.kind === 'failed')
          await recovery.release(operationId, 'definite_failure');
        if (!current()) return;
        if (result.kind === 'ready' && result.value.operationId === operationId) {
          await acceptClear(result.value, current);
          if (current()) await readPage(current);
        } else if (result.kind === 'failed') {
          setPendingId(null);
          dismissReview();
          setError(
            'History was not cleared. It may have changed; review the current entries before confirming again.',
          );
        } else {
          dismissReview();
          setError(
            'The clear-history result is uncertain. Check its receipt instead of repeating it.',
          );
        }
      } catch {
        if (current()) {
          dismissReview();
          setError('The clear-history result is uncertain. No automatic retry will run.');
        }
      }
    });
  }
  function checkClear(operationId: string, mode: 'check' | 'resolve' = 'check') {
    void task(async (current) => {
      const result =
        mode === 'resolve'
          ? await service.resolveClearHistoryOperation(operationId)
          : await service.readClearHistoryReceipt(operationId);
      if (!current()) return;
      if (result.kind === 'ready' && result.value?.operationId === operationId) {
        await acceptClear(result.value, current);
        if (current()) await readPage(current);
      } else
        setError(
          mode === 'resolve'
            ? 'The history-clear operation could not be resolved. Its reference is retained; no new clear request was sent.'
            : 'No clear-history receipt could be confirmed. The operation has not been repeated. Keep its ID and inspect the current history.',
        );
    });
  }
  function checkCookingEntry(operationId: string, mode: 'check' | 'resolve' = 'check') {
    void task(async (current) => {
      if (!cookedRecovery) return;
      const result =
        mode === 'resolve'
          ? await cookedRecovery.resolveCookedOperation(operationId)
          : await cookedRecovery.readCookedReceipt(operationId);
      if (!current()) return;
      const receiptId =
        result.kind === 'ready' && result.value
          ? result.value.kind === 'saved'
            ? result.value.event.eventId
            : result.value.eventId
          : null;
      if (result.kind !== 'ready' || !result.value || receiptId !== operationId) {
        setError(
          'This cooking entry has no confirmed receipt yet. Its reference is retained, and it has not been repeated.',
        );
        return;
      }
      setRecoveryMessage(
        result.value.kind === 'saved'
          ? `Saved cooking entry confirmed: ${result.value.event.recipeTitle}.`
          : result.value.kind === 'cancelled'
            ? 'The unsaved cooking request is cancelled. It cannot create a late entry, and no cooking entry was added.'
            : 'This cooking entry belonged to history that was later cleared. It has not been recreated.',
      );
      if (current()) await recovery.release(operationId, 'receipt');
      if (current()) await readPage(current);
    });
  }

  return (
    <View style={styles.section}>
      {items.length > 0 && (
        <View style={styles.row}>
          <AppText role="support" color="inkSecondary" style={styles.text}>
            Meals you marked cooked, with your private notes.
          </AppText>
          <IconButton
            name="more"
            label="History options"
            accessibilityState={{ expanded: optionsOpen }}
            onPress={() => setOptionsOpen((open) => !open)}
          />
        </View>
      )}
      {optionsOpen && !review && !pendingId && items.length > 0 && (
        <ActionButton
          label="Review clearing cooking history"
          variant="quiet"
          disabled={busy || !recovery.ready || !!recovery.references.length || changed}
          onPress={reviewClear}
        />
      )}
      {busy && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Checking cooking history…
        </AppText>
      )}
      {error && (
        <Notice title="History needs attention" tone="error">
          {error}
        </Notice>
      )}
      {receipt && (
        <Notice
          title={
            receipt.outcome === 'cleared'
              ? 'Cooking history cleared'
              : 'Unconfirmed history clear cancelled'
          }
        >
          {receipt.outcome === 'cleared' ? (
            <AppText>
              {receipt.clearedCount} entries removed at{' '}
              {new Date(receipt.committedAt).toLocaleString()}.
            </AppText>
          ) : (
            <AppText>
              No cooking entries were removed by this operation. The old request is cancelled and
              cannot clear history later.
            </AppText>
          )}
          <AppText role="support">
            This receipt records that operation. Later cooking entries are separate.
          </AppText>
        </Notice>
      )}
      {pendingId && (
        <Notice title="Check before repeating" tone="caution">
          <AppText role="support" selectable>
            Operation ID: {pendingId}
          </AppText>
          <ActionButton
            label="Check history clear receipt"
            disabled={busy}
            onPress={() => checkClear(pendingId)}
          />
          <AppText role="support">
            Resolve to show an existing receipt or cancel the unsaved old request. Resolution does
            not start a new history clear.
          </AppText>
          <ActionButton
            label="Resolve unconfirmed history clear"
            variant="secondary"
            disabled={busy}
            onPress={() => checkClear(pendingId, 'resolve')}
          />
        </Notice>
      )}
      {review && (
        <View style={styles.review}>
          <AppText role="section">Clear cooking history?</AppText>
          <AppText>
            This removes {review.count} cooking entries and their private notes from this workspace.
            Favourites, reading progress, meal plans and shopping checks stay unchanged.
          </AppText>
          <AppText role="support">
            Opaque operation identifiers remain to stop old requests from recreating cleared
            entries. Retained restore archives and files you previously saved elsewhere are not
            deleted; they may still contain this history and its private notes.
          </AppText>
          <ActionButton
            label="Confirm clear cooking history"
            disabled={
              busy ||
              !recovery.ready ||
              !!pendingId ||
              !!recovery.references.length ||
              review.count === 0
            }
            onPress={clear}
          />
          <ActionButton
            label="Keep cooking history"
            variant="quiet"
            disabled={busy}
            onPress={dismissReview}
          />
        </View>
      )}
      {recovery.error && (
        <Notice title="Cooking recovery needs attention" tone="error">
          {recovery.error}
        </Notice>
      )}
      {recoveryMessage && (
        <AppText role="support" accessibilityLiveRegion="polite">
          {recoveryMessage}
        </AppText>
      )}
      {cookedRecovery &&
        recovery.allReferences
          .filter((reference) => reference.kind === 'cooked')
          .map((reference) => (
            <View key={reference.operationId} style={styles.review}>
              <AppText role="bodyStrong">
                Unconfirmed cooking entry
                {reference.recipeId && getRecipe(reference.recipeId)
                  ? ` · ${getRecipe(reference.recipeId)!.title}`
                  : ''}
              </AppText>
              <AppText role="support" selectable>
                Event ID: {reference.operationId}
              </AppText>
              <ActionButton
                label="Check saved cooking entry"
                variant="secondary"
                disabled={busy}
                onPress={() => checkCookingEntry(reference.operationId)}
              />
              <AppText role="support">
                Resolution shows an existing receipt or cancels the unsaved request. It does not
                create another cooking entry.
              </AppText>
              <ActionButton
                label="Resolve unconfirmed cooking change"
                variant="secondary"
                disabled={busy}
                onPress={() => checkCookingEntry(reference.operationId, 'resolve')}
              />
            </View>
          ))}
      {recovery.references
        .filter((reference) => reference.operationId !== pendingId)
        .map((reference) => (
          <View key={reference.operationId} style={styles.section}>
            <AppText role="support" selectable>
              Unresolved history-clear operation: {reference.operationId}
            </AppText>
            <ActionButton
              label="Check earlier history clear receipt"
              variant="secondary"
              disabled={busy}
              onPress={() => checkClear(reference.operationId)}
            />
            <AppText role="support">
              Resolution shows an existing receipt or cancels the unsaved request. It does not start
              a new history clear.
            </AppText>
            <ActionButton
              label="Resolve unconfirmed history clear"
              variant="secondary"
              disabled={busy}
              onPress={() => checkClear(reference.operationId, 'resolve')}
            />
          </View>
        ))}
      {items.map((entry) => (
        <View key={itemKey(entry)}>{renderItem(entry)}</View>
      ))}
      {page && !items.length && !busy && !error && (
        <View style={styles.review}>
          {emptyContent}
          <ActionButton
            label="Explore recipes"
            onPress={() => {
              if (active.current && latest.current.isCurrent()) router.navigate('/');
            }}
          />
        </View>
      )}
      {page?.nextCursor && !changed && (
        <ActionButton
          label="Load earlier cooking entries"
          variant="secondary"
          disabled={busy}
          onPress={() => void task((current) => readPage(current, page.nextCursor ?? undefined))}
        />
      )}
      {(error || changed) && (
        <ActionButton
          label="Retry cooking history"
          variant="quiet"
          disabled={busy}
          onPress={() => void task((current) => readPage(current))}
        />
      )}
      <ActionButton
        label="Privacy & storage details"
        variant="quiet"
        accessibilityState={{ expanded: privacyOpen }}
        onPress={() => setPrivacyOpen((open) => !open)}
      />
      {privacyOpen && (
        <AppText role="support" color="inkSecondary">
          {privacyDetails}
        </AppText>
      )}
    </View>
  );
}

export function CookingHistoryEntryFrame({
  title,
  cookedOn,
  note,
  origin,
  photo,
  children,
}: {
  title: string;
  cookedOn: string;
  note: string | null;
  origin?: 'backup' | 'account';
  photo: ReactNode;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.entry}>
      <View style={styles.row}>
        <View style={styles.photo}>{photo}</View>
        <View style={styles.text}>
          <AppText role="section">{title}</AppText>
          <AppText role="support">Cooked {formatPlanDate(cookedOn)}</AppText>
          {origin === 'backup' && (
            <AppText role="support">Imported from backup · local history record</AppText>
          )}
          {origin === 'account' && <AppText role="support">Saved account history</AppText>}
        </View>
      </View>
      {!!note && (
        <View style={styles.section}>
          <AppText role="label">Private note</AppText>
          <AppText selectable>{note}</AppText>
        </View>
      )}
      {children}
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    row: { flexDirection: 'row', gap: t.space.md, alignItems: 'center' },
    text: { flex: 1, gap: t.space.xs },
    photo: { width: 88 },
    entry: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      borderWidth: 1,
      borderColor: t.color.divider,
      padding: t.space.md,
      gap: t.space.md,
    },
    review: {
      backgroundColor: t.color.surfaceMuted,
      borderRadius: t.radius.card,
      padding: t.space.md,
      gap: t.space.md,
    },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  });
