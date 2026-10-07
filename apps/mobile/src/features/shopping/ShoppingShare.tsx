import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
import type { ContentShoppingSnapshot } from '../../data/contentWorkspaceQueries';
import type {
  Immutable,
  ManualShoppingItem,
  PersonalService,
  ShoppingSnapshot,
} from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { FocusedSheet } from '../../components/FocusedSheet';
import { focusTarget } from '../../components/focusTarget';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { getRecipeSourceNotices } from '../recipes/sourceNotices';
import { createShoppingShareTransfer } from './shoppingShareTransfer';
import { readCompleteManualShopping } from './readShoppingShareManual';
import {
  formatShoppingShare,
  formatContentShoppingShare,
  ShoppingShareError,
  type ShoppingShareTransfer,
} from './shoppingShareText';

export type ShoppingSharePersonal = Pick<PersonalService, 'readManualShopping' | 'subscribe'>;
export interface ContentShoppingShareContext {
  host: Pick<ContentWorkspaceHost, 'getSnapshot' | 'subscribe'> & {
    queries: Pick<ContentWorkspaceHost['queries'], 'readShopping'>;
    manual: ShoppingSharePersonal & Pick<ContentWorkspaceHost['manual'], 'readState'>;
  };
  scopeKey: string;
  revision: number;
  value: Immutable<Extract<ContentShoppingSnapshot, { kind: 'current' }>>;
}
const noSubscribe = () => () => undefined;
const emptySnapshot = () => null;
const selectionIdentity = (value: ContentShoppingShareContext['value']) =>
  canonicalContentJson(
    value.selected.map(({ occurrence, contentRef }) => ({ occurrence, contentRef })),
    2 * 1024 * 1024,
  );
const sameContent = (
  left: ContentShoppingShareContext | undefined,
  right: ContentShoppingShareContext | undefined,
) =>
  left === right ||
  (!!left &&
    !!right &&
    left.host === right.host &&
    left.scopeKey === right.scopeKey &&
    left.revision === right.revision &&
    left.value === right.value);

export function ShoppingShare({
  snapshot,
  personal,
  content,
  createTransfer = createShoppingShareTransfer,
}: {
  snapshot: Immutable<ShoppingSnapshot>;
  personal?: ShoppingSharePersonal | undefined;
  content?: ContentShoppingShareContext;
  createTransfer?: () => ShoppingShareTransfer;
}) {
  const styles = useThemedStyles(createStyles);
  const [preview, setPreview] = useState<{
    text: string;
    snapshot: Immutable<ShoppingSnapshot>;
    personal: ShoppingSharePersonal | undefined;
    manualGeneration: number;
    content: ContentShoppingShareContext | undefined;
    manual: {
      revision: number;
      epoch: number;
      items: readonly Immutable<ManualShoppingItem>[];
    } | null;
  } | null>(null);
  const [invalidated, setInvalidated] = useState<typeof preview>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualGeneration, setManualGeneration] = useState(0);
  const generation = useRef(0);
  const latest = useRef({ snapshot, personal, content, preview, createTransfer });
  latest.current = { snapshot, personal, content, preview, createTransfer };
  useSyncExternalStore(
    content?.host.subscribe ?? noSubscribe,
    content?.host.getSnapshot ?? emptySnapshot,
    content?.host.getSnapshot ?? emptySnapshot,
  );
  const active = useRef(true);
  const running = useRef(false);
  const request = useRef(0);
  const owner = useRef({ host: content?.host, scopeKey: content?.scopeKey });
  const transfer = useRef<ShoppingShareTransfer | null>(null);
  const trigger = useRef<View>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      transfer.current?.dispose();
      transfer.current = null;
    };
  }, []);
  useEffect(
    () =>
      personal?.subscribe((change) => {
        if (
          active.current &&
          scopeCurrent() &&
          latest.current.personal === personal &&
          change.manualShopping
        ) {
          generation.current++;
          setManualGeneration(generation.current);
        }
      }),
    [personal],
  );
  function scopeCurrent() {
    if (!active.current) return false;
    if (!content) return latest.current.content === undefined;
    if (
      latest.current.content?.host !== content.host ||
      latest.current.content.scopeKey !== content.scopeKey
    )
      return false;
    try {
      const state = content.host.getSnapshot();
      return state.status === 'ready' && state.scopeKey === content.scopeKey;
    } catch {
      return false;
    }
  }
  function assertCurrent() {
    if (
      !scopeCurrent() ||
      latest.current.snapshot !== snapshot ||
      latest.current.personal !== personal ||
      !sameContent(latest.current.content, content)
    )
      throw new ShoppingShareError('not_current');
  }
  useEffect(() => {
    if (owner.current.host === content?.host && owner.current.scopeKey === content?.scopeKey)
      return;
    owner.current = { host: content?.host, scopeKey: content?.scopeKey };
    request.current++;
    running.current = false;
    setBusy(false);
    setPreview(null);
    setInvalidated(null);
    setError(null);
    setMessage(null);
    transfer.current?.dispose();
    transfer.current = null;
  }, [content?.host, content?.scopeKey]);
  const stale =
    preview !== null &&
    (invalidated === preview ||
      preview.snapshot !== snapshot ||
      preview.personal !== personal ||
      !sameContent(preview.content, content) ||
      preview.manualGeneration !== manualGeneration);
  const shareTooLarge = content?.value.share.kind === 'unavailable';
  function textFor(manualItems: readonly Immutable<ManualShoppingItem>[]) {
    if (content) return formatContentShoppingShare(content.value, manualItems);
    return formatShoppingShare(
      snapshot,
      (recipeId) => {
        const recipe = getRecipe(recipeId);
        return recipe
          ? {
              title: recipe.title,
              sourceNotes: getRecipeSourceNotices(recipe).map((note) => note.note),
              recipePage: recipe.recipePage,
              originalSourceUrl: recipe.originalSourceUrl,
            }
          : null;
      },
      manualItems,
    );
  }
  async function verifyContent(text: string, manual: NonNullable<typeof preview>['manual']) {
    assertCurrent();
    if (!content) return;
    if (!manual || manual.revision !== content.revision || personal !== content.host.manual)
      throw new ShoppingShareError('not_current');
    const readShopping = content.host.queries.readShopping;
    const readManualState = content.host.manual.readState;
    const result = await readShopping();
    assertCurrent();
    if (
      result.kind !== 'ready' ||
      result.revision !== content.revision ||
      result.value.kind !== 'current' ||
      selectionIdentity(result.value) !== selectionIdentity(content.value) ||
      formatContentShoppingShare(result.value, manual.items) !== text
    )
      throw new ShoppingShareError('not_current');
    const state = await readManualState();
    assertCurrent();
    if (
      state.kind !== 'ready' ||
      state.revision !== content.revision ||
      state.value.epoch !== manual.epoch
    )
      throw new ShoppingShareError('not_current');
  }
  async function review() {
    if (running.current || !scopeCurrent()) return;
    const requestId = ++request.current;
    running.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const before = generation.current;
    try {
      assertCurrent();
      const page = personal ? await readCompleteManualShopping(personal, assertCurrent) : null;
      assertCurrent();
      if (before !== generation.current) throw new ShoppingShareError('not_current');
      const manual = page
        ? { revision: page.revision, epoch: page.value.epoch, items: page.value.items }
        : null;
      const text = textFor(manual?.items ?? []);
      if (content) await verifyContent(text, manual);
      assertCurrent();
      if (before !== generation.current) throw new ShoppingShareError('not_current');
      setPreview({ text, snapshot, personal, content, manual, manualGeneration: before });
      setInvalidated(null);
    } catch (failure) {
      if (!scopeCurrent()) return;
      setPreview(null);
      setError(
        failure instanceof ShoppingShareError && failure.reason === 'too_large'
          ? 'This complete list is too large to share here (128 KiB maximum). Nothing was shortened or sent. Review the list in CookMate.'
          : 'The complete shopping list is not ready. Let it finish updating, then try again. Nothing was sent.',
      );
    } finally {
      if (request.current === requestId) {
        running.current = false;
        if (scopeCurrent()) setBusy(false);
      }
    }
  }
  async function share() {
    if (
      !preview ||
      stale ||
      latest.current.preview !== preview ||
      preview.manualGeneration !== generation.current ||
      snapshot.status !== 'current' ||
      running.current
    )
      return;
    try {
      assertCurrent();
    } catch {
      return;
    }
    const requestId = ++request.current;
    running.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    let dispatched = false;
    const factory = createTransfer;
    try {
      if (content) await verifyContent(preview.text, preview.manual);
      assertCurrent();
      if (
        latest.current.preview !== preview ||
        preview.manualGeneration !== generation.current ||
        latest.current.createTransfer !== factory
      )
        throw new ShoppingShareError('not_current');
      const owned = transfer.current ?? factory();
      transfer.current = owned;
      assertCurrent();
      dispatched = true;
      const result = await owned.share(preview.text);
      assertCurrent();
      if (latest.current.preview !== preview) return;
      setMessage(
        result === 'download_requested'
          ? 'Download requested. Check your browser’s downloads to confirm the text file was saved.'
          : result === 'cancelled'
            ? 'Sharing cancelled. Your shopping list is unchanged.'
            : 'The share sheet has closed. CookMate cannot confirm delivery; check the destination you chose.',
      );
    } catch {
      if (!scopeCurrent()) return;
      if (!dispatched) {
        setInvalidated(preview);
        setError(
          'The list changed or could not be checked. Refresh and review the complete preview before sharing. Nothing was sent.',
        );
      } else
        setError(
          Platform.OS === 'web'
            ? 'CookMate could not confirm the download outcome. Check your browser’s downloads before trying again.'
            : 'CookMate could not confirm the sharing outcome. Check the destination you chose before trying again.',
        );
    } finally {
      if (request.current === requestId) {
        running.current = false;
        if (scopeCurrent()) setBusy(false);
      }
    }
  }
  function close() {
    if (running.current || !scopeCurrent() || latest.current.preview !== preview) return;
    setPreview(null);
    setInvalidated(null);
    setError(null);
    setMessage(null);
  }
  const samePreviewOwner = preview?.content
    ? preview.content.host === content?.host && preview.content.scopeKey === content?.scopeKey
    : content === undefined;
  const visiblePreview = scopeCurrent() && samePreviewOwner ? preview : null;
  const feedback = (
    <>
      {error && (
        <View accessibilityLiveRegion="polite">
          <Notice title="Sharing needs attention" tone="error">
            {error}
          </Notice>
        </View>
      )}
      {message && (
        <AppText role="support" accessibilityLiveRegion="polite">
          {message}
        </AppText>
      )}
    </>
  );
  return (
    <View style={styles.section}>
      <ActionButton
        ref={trigger}
        label="Share list"
        variant="quiet"
        disabled={snapshot.status !== 'current' || shareTooLarge || !scopeCurrent()}
        busy={busy}
        onPress={() => void review()}
      />
      <FocusedSheet
        visible={visiblePreview !== null}
        title="Review your shopping list"
        onClose={close}
        onDismiss={() => {
          if (scopeCurrent()) focusTarget(trigger.current);
        }}
        closeLabel="Close preview"
      >
        {visiblePreview && (
          <View style={styles.preview}>
            <AppText role="support" color="inkSecondary">
              Includes every selected meal across weeks, exact displayed amounts, purchased marks,
              source notes and recipe credits.
              {personal ? ' Includes your manual shopping items in a separate section.' : ''} This
              readable text is not a restorable backup.
            </AppText>
            <AppText role="support" color="inkSecondary">
              Your meal dates and choices are personal.{' '}
              {Platform.OS === 'web'
                ? 'The next button downloads a text file; it does not send it to anyone.'
                : 'The next button opens your device’s share sheet. You choose the destination.'}
            </AppText>
            {stale && (
              <Notice title="Your list has changed" tone="caution">
                Refresh the preview to review the latest amounts and purchased status before
                sharing.
              </Notice>
            )}
            <ScrollView
              style={styles.content}
              nestedScrollEnabled
              accessibilityLabel="Shopping text preview"
            >
              <AppText selectable>{visiblePreview.text}</AppText>
            </ScrollView>
            {stale ? (
              <ActionButton
                label="Refresh preview"
                variant="secondary"
                disabled={busy}
                onPress={() => void review()}
              />
            ) : (
              <ActionButton
                label={Platform.OS === 'web' ? 'Download text file' : 'Open share sheet'}
                variant="secondary"
                busy={busy}
                disabled={snapshot.status !== 'current' || shareTooLarge || !scopeCurrent()}
                onPress={() => void share()}
              />
            )}
            {feedback}
          </View>
        )}
      </FocusedSheet>
      {shareTooLarge && (
        <Notice title="Complete sharing is unavailable">
          The recipe credits for this complete list exceed the supported size. Nothing has been
          shortened or sent.
        </Notice>
      )}
      {!visiblePreview && scopeCurrent() && feedback}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.sm },
    preview: {
      gap: t.space.sm,
    },
    content: {
      maxHeight: 320,
      padding: t.space.sm,
      backgroundColor: t.color.canvas,
      borderRadius: t.radius.small,
    },
  });
