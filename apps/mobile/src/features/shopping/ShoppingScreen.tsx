import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  getPlanWeek,
  type Immutable,
  type ManualShoppingItem,
  type ShoppingGroup,
} from '@cookmate/domain';
import { ActionButton, Notice, SegmentControl, useControlStyles } from '../../components/Controls';
import { Page, usePageStyles } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { AppIcon, IconButton } from '../../components/Icon';
import { controlStateProps } from '../../components/controlStateProps';
import { focusTarget } from '../../components/focusTarget';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useActionFocus } from '../../hooks/useActionFocus';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';
import {
  useOrdinaryWorkspaceActions,
  useOrdinaryShoppingQuery,
} from '../content/useOrdinaryWorkspace';
import {
  shoppingPresentation,
  shoppingContentEntries,
  shoppingNotes,
  recipeReferenceKey,
} from './ordinaryShoppingModel';
import { QueryFeedback } from '../workspace/WorkspaceFeedback';
import { PersonalOperationFeedback } from '../personal/PersonalUI';
import {
  useManualShoppingPorts,
  useManualShoppingData,
  type ManualShoppingPorts,
} from '../personal/useManualShoppingPorts';
import { PurchaseRow } from './PurchaseRow';
import { ShoppingShare } from './ShoppingShare';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import type { ShoppingFilter } from './shoppingChecklist';
import { useStableShoppingChecklist } from './useStableShoppingChecklist';
import {
  ShoppingEvidenceSheets,
  sourceNoteSummaries,
  type ShoppingEvidence,
} from './ShoppingEvidenceSheets';

type ScreenProps = { header: ReactNode; weekDate?: string };
type ManualState = {
  items: readonly Immutable<ManualShoppingItem>[];
  ready: boolean;
  busy: boolean;
  complete: boolean;
  epoch: number | null;
  feedback: ReactNode;
  isCurrent(): boolean;
  toggle(item: Immutable<ManualShoppingItem>): void;
};

export function ShoppingScreen(props: ScreenProps) {
  const { scopeKey } = useOrdinaryWorkspaceActions();
  const ports = useManualShoppingPorts();
  return ports ? (
    <ShoppingWithManual key={ports.scopeKey} {...props} {...ports} />
  ) : (
    <ShoppingChecklist key={scopeKey} {...props} />
  );
}

function ShoppingWithManual({
  service,
  readInstallationId,
  isCurrent: scopeCurrent,
  mode,
  scopeKey: _scopeKey,
  ...props
}: ScreenProps & ManualShoppingPorts) {
  const { query, operation, isCurrent, ready } = useManualShoppingData({
    service,
    readInstallationId,
    isCurrent: scopeCurrent,
    mode,
  });
  const current = useRef({ query, ready });
  current.current = { query, ready };
  const [purchasePending, setPurchasePending] = useState(false);
  const purchaseOperationId = useRef<string | undefined>(undefined);
  const pendingPurchase = useRef<{ operationId: string; name: string; purchased: boolean } | null>(
    null,
  );
  useEffect(() => {
    const pending = pendingPurchase.current;
    const receipt = operation.receipt;
    if (
      !isCurrent() ||
      purchasePending ||
      operation.busy ||
      operation.error ||
      operation.storageError ||
      operation.references.length ||
      !pending ||
      !receipt ||
      receipt.operationId !== pending.operationId ||
      receipt.commandKind !== 'setManualPurchased' ||
      (receipt.outcome !== 'committed' && receipt.outcome !== 'no_op')
    )
      return;
    pendingPurchase.current = null;
    AccessibilityInfo.announceForAccessibility(
      `${pending.name} marked ${pending.purchased ? 'purchased' : 'still needed'}.`,
    );
  }, [
    operation.busy,
    operation.error,
    operation.storageError,
    operation.references,
    operation.receipt,
    purchasePending,
  ]);
  return (
    <ShoppingChecklist
      {...props}
      manual={{
        isCurrent,
        items: query.value?.items ?? [],
        ready,
        busy: query.loading || operation.busy,
        complete: !query.error && !!query.value,
        epoch: query.value?.epoch ?? null,
        feedback: (
          <>
            <PersonalOperationFeedback
              operation={operation}
              quietPurchase
              purchasePending={purchasePending}
              {...(purchaseOperationId.current
                ? { purchaseOperationId: purchaseOperationId.current }
                : {})}
            />
            {query.loading && !query.value && (
              <AppText role="support">Loading your own items…</AppText>
            )}
            {query.error && (
              <Notice title="Manual items need attention" tone="error">
                <AppText role="support">
                  The complete manual list could not be read. Recipe ingredients are still
                  available.
                </AppText>
                <ActionButton
                  label="Retry manual items"
                  variant="quiet"
                  onPress={() => void query.reload()}
                />
              </Notice>
            )}
          </>
        ),
        toggle(item) {
          if (
            !isCurrent() ||
            !current.current.ready ||
            current.current.query.value !== query.value ||
            !query.value ||
            !query.value.items.some((row) => row === item)
          )
            return;
          const epoch = query.value.epoch;
          setPurchasePending(true);
          void operation
            .perform((operationId) => {
              purchaseOperationId.current = operationId;
              pendingPurchase.current = {
                operationId,
                name: item.name ?? 'Item',
                purchased: !item.purchased,
              };
              return service.execute({
                kind: 'setManualPurchased',
                operationId,
                expectedEpoch: epoch,
                itemId: item.itemId,
                expectedRevision: item.revision,
                purchased: !item.purchased,
              });
            })
            .then((saved) => {
              if (!isCurrent()) return;
              if (saved) void query.reload();
              else purchaseOperationId.current = undefined;
            })
            .finally(() => {
              if (isCurrent()) setPurchasePending(false);
            });
        },
      }}
    />
  );
}

function IngredientGroup({
  group,
  disabled,
  onSources,
  onBeforeToggle,
}: {
  group: Immutable<ShoppingGroup>;
  disabled: boolean;
  onSources(restoreFocus: () => boolean): void;
  onBeforeToggle(): void;
}) {
  const styles = useThemedStyles(createStyles);
  const { actions } = useOrdinaryWorkspaceActions();
  const focus = useActionFocus();
  const sourceFocus = useRef<View>(null);
  return (
    <View style={styles.ingredientGroup}>
      <PurchaseRow
        focusRef={focus.ref}
        name={group.displayName}
        amount={group.quantityLabel}
        purchased={group.purchased}
        changed={group.changed}
        unavailable={disabled}
        accessory={
          <IconButton
            ref={sourceFocus}
            label={`Show sources for ${group.displayName}`}
            name="info"
            tone="quiet"
            iconSize={18}
            onPress={() => onSources(() => focusTarget(sourceFocus.current))}
          />
        }
        onToggle={() => {
          if (disabled) return;
          onBeforeToggle();
          void actions?.begin(
            { kind: 'setPurchased', groupKey: group.groupKey, purchased: !group.purchased },
            {
              observedDemandFingerprint: group.demandFingerprint,
              restoreFocus: focus.restoreFocus,
            },
          );
        }}
      />
      {group.contributions.some((entry) => entry.quantity.kind === 'review_source') && (
        <AppText role="support" color="caution" style={styles.amountWarning}>
          This amount needs recipe-source review.
        </AppText>
      )}
    </View>
  );
}

function ShoppingSearch({
  value,
  onChange,
  ownItems,
}: {
  value: string;
  onChange(value: string): void;
  ownItems: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const controls = useControlStyles();
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput>(null);
  return (
    <View style={[styles.search, focused && styles.searchFocused]}>
      <AppIcon name="search" size={18} color={t.color.inkSecondary} />
      <TextInput
        ref={input}
        accessibilityLabel="Find a shopping item"
        placeholder={ownItems ? 'Find an ingredient or your own item' : 'Find an ingredient'}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCorrect={false}
        returnKeyType="search"
        placeholderTextColor={t.color.inkSecondary}
        style={[controls.field, styles.searchField]}
      />
      {!!value && (
        <IconButton
          name="close"
          label="Clear shopping search"
          tone="quiet"
          onPress={() => {
            onChange('');
            input.current?.focus();
          }}
        />
      )}
    </View>
  );
}

function ShoppingChecklist({ header, weekDate, manual }: ScreenProps & { manual?: ManualState }) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();
  const router = useRouter();
  const { actions, clock, mode, scopeKey, restoreScreenFocus } = useOrdinaryWorkspaceActions();
  const { preferences } = usePlanningPreferences();
  const { availability } = useWorkspace();
  const contentRuntime = useOrdinaryContentRuntime();
  const personal =
    mode === 'bundled' && availability.kind === 'ready'
      ? availability.services.personal
      : undefined;
  const [evidence, setEvidence] = useState<ShoppingEvidence>(null);
  const noteFocus = useRef<View>(null);
  const scopeFocus = useRef<View>(null);
  const returnFocus = useRef<() => boolean>(() => false);
  const recipeReturnFocus = useRef<(() => boolean) | null>(null);
  useFocusEffect(
    useCallback(() => {
      const restore = recipeReturnFocus.current;
      if (!restore) return;
      const frame = requestAnimationFrame(() => {
        recipeReturnFocus.current = null;
        if (!restore()) restoreScreenFocus();
      });
      return () => cancelAnimationFrame(frame);
    }, [restoreScreenFocus]),
  );
  function openEvidence(next: ShoppingEvidence, restore: () => boolean) {
    returnFocus.current = restore;
    setEvidence(next);
  }
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ShoppingFilter>('all');
  const week = getPlanWeek(weekDate ?? clock.dateContext().localDate, preferences.weekStart);
  const sourceQuery = useOrdinaryShoppingQuery('shopping');
  const query = { state: shoppingPresentation(sourceQuery), retry: sourceQuery.retry };
  const contentEntries = shoppingContentEntries(sourceQuery);
  const snapshot = query.state.kind === 'ready' ? query.state.value : query.state.previous;
  const ready = query.state.kind === 'ready' && snapshot?.status === 'current';
  // A healthy reload keeps the last confirmed presentation; only a fresh read enables writes.
  const confirmedDisplay = query.state.kind !== 'failed' && snapshot?.status === 'current';
  const canChangeMeals = !!ready && !!actions && !actions.blocked;
  const outsideWeekCount =
    snapshot?.selectedOccurrences.filter(
      (meal) =>
        meal.placement.actualDate < week.startDate || meal.placement.actualDate > week.endDate,
    ).length ?? 0;
  const groups = snapshot?.groups ?? [];
  const manualItems = manual?.items ?? [];
  const total = groups.length + manualItems.length;
  const complete = confirmedDisplay && (!manual || manual.complete);
  const purchasedCount =
    groups.filter((group) => group.purchased).length +
    manualItems.filter((item) => item.purchased).length;
  const recipesWithNotes = useMemo(
    () => shoppingNotes(sourceQuery),
    [sourceQuery.mode, sourceQuery.state],
  );
  const noteCount = recipesWithNotes.reduce((count, recipe) => count + recipe.notes.length, 0);
  const checklist = useStableShoppingChecklist({
    groups,
    manual: manualItems,
    filter,
    search,
    owner:
      mode === 'content' ? scopeKey : availability.kind === 'ready' ? availability.services : null,
    manualEpoch: manual?.epoch ?? null,
  });
  const { rows } = checklist;
  return (
    <Page scroll={false}>
      <FlatList
        accessibilityState={{ busy: query.state.kind === 'loading' || !!manual?.busy }}
        data={rows}
        keyExtractor={(row) => row.key}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        // RN Web 0.21 blurs on any scroll for "on-drag", including focus/filtered-list scrolling.
        keyboardDismissMode={Platform.OS === 'web' ? 'none' : 'on-drag'}
        contentContainerStyle={[pageStyles.content, styles.listContent]}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {header}
            {!(query.state.kind === 'loading' && query.state.previous !== undefined) && (
              <QueryFeedback {...query} noun="shopping list" />
            )}
            {snapshot?.status === 'pending' && (
              <Notice title="Shopping list is updating">
                Your saved meals are retained. Purchase changes are unavailable until the list is
                current.
              </Notice>
            )}
            <View style={styles.headingRow}>
              <AppText role="section" accessibilityRole="header">
                Shopping
              </AppText>
              <View style={styles.toolbar}>
                {manual && (
                  <ActionButton
                    label="Add item"
                    accessibilityLabel="Add manual item"
                    variant="quiet"
                    style={styles.utility}
                    disabled={!manual.ready}
                    onPress={() => {
                      if (manual.isCurrent() && manual.ready)
                        router.push({ pathname: '/manual-shopping', params: { create: '1' } });
                    }}
                  />
                )}
                {snapshot &&
                  (mode === 'bundled' ? (
                    <ShoppingShare snapshot={snapshot} personal={personal} />
                  ) : contentRuntime &&
                    sourceQuery.mode === 'content' &&
                    sourceQuery.state.kind === 'ready' &&
                    sourceQuery.state.value.kind === 'current' ? (
                    <ShoppingShare
                      key={scopeKey}
                      snapshot={snapshot}
                      personal={contentRuntime.host.manual}
                      content={{
                        host: contentRuntime.host,
                        scopeKey: contentRuntime.host.getSnapshot().scopeKey,
                        revision: sourceQuery.state.revision,
                        value: sourceQuery.state.value,
                      }}
                    />
                  ) : null)}
              </View>
            </View>
            <ShoppingSearch
              ownItems={!!manual}
              value={search}
              onChange={(value) => {
                checklist.reset();
                setSearch(value);
              }}
            />
            <SegmentControl
              value={filter}
              onChange={(value) => {
                checklist.reset();
                setFilter(value);
              }}
              options={[
                {
                  value: 'to_buy',
                  label: complete ? `To buy ${total - purchasedCount}` : 'To buy',
                },
                {
                  value: 'purchased',
                  label: complete ? `Purchased ${purchasedCount}` : 'Purchased',
                },
                { value: 'all', label: complete ? `All ${total}` : 'All' },
              ]}
            />
            {filter !== 'all' && (
              <AppText role="support" color="inkSecondary">
                Changed items stay here. Tap {filter === 'to_buy' ? 'To buy' : 'Purchased'} again to
                refresh.
              </AppText>
            )}
            {snapshot && (
              <Pressable
                ref={scopeFocus}
                accessibilityRole="button"
                accessibilityLabel={`Show ${snapshot.selectedOccurrences.length} selected meal${snapshot.selectedOccurrences.length === 1 ? '' : 's'}`}
                {...controlStateProps({ expanded: evidence?.kind === 'scope' }, 'button')}
                onPress={() =>
                  openEvidence({ kind: 'scope' }, () => focusTarget(scopeFocus.current))
                }
                style={({ pressed }) => [styles.scopeControl, pressed && styles.pressed]}
              >
                <AppIcon name="calendar" size={18} color={t.color.brandText} />
                <AppText role="support" style={styles.flex}>
                  {snapshot.selectedOccurrences.length} meal
                  {snapshot.selectedOccurrences.length === 1 ? '' : 's'} selected
                  {outsideWeekCount > 0 ? ` · ${outsideWeekCount} outside this week` : ''}
                </AppText>
                <AppIcon name="chevronRight" size={17} color={t.color.inkSecondary} />
              </Pressable>
            )}
            {!!noteCount && (
              <Pressable
                ref={noteFocus}
                accessibilityRole="button"
                accessibilityLabel={`Read ${noteCount} recipe ${noteCount === 1 ? 'note' : 'notes'}`}
                {...controlStateProps({ expanded: evidence?.kind === 'notes' }, 'button')}
                onPress={() =>
                  openEvidence({ kind: 'notes' }, () => focusTarget(noteFocus.current))
                }
                style={({ pressed }) => [styles.notes, pressed && styles.pressed]}
              >
                <View style={styles.noteHeading}>
                  <AppIcon name="info" size={16} color={t.color.caution} />
                  <AppText role="label" color="caution" style={styles.flex}>
                    Check before shopping
                  </AppText>
                  <AppIcon name="chevronRight" size={17} color={t.color.caution} />
                </View>
                {recipesWithNotes.flatMap((recipe) =>
                  recipe.notes.map((note) => (
                    <AppText
                      key={`${recipe.contentRef ? recipeReferenceKey(recipe.contentRef) : recipe.recipeId}:${note.annotationId}`}
                      role="support"
                      color="caution"
                    >
                      {(mode === 'bundled' ? sourceNoteSummaries[note.annotationId] : undefined) ??
                        `${recipe.title}: ${note.note}`}
                    </AppText>
                  )),
                )}
              </Pressable>
            )}
            {manual?.feedback}
            {confirmedDisplay && !snapshot?.scope.occurrenceIds.length && (
              <Notice title="Choose meals to make your list">
                <AppText role="support">
                  Selections stay saved across weeks.
                  {manual ? ' Your own items remain separate.' : ''}
                </AppText>
                <ActionButton
                  label="Choose shopping meals"
                  variant="quiet"
                  disabled={!canChangeMeals}
                  onPress={() =>
                    router.push({ pathname: '/shopping-meals', params: { date: week.startDate } })
                  }
                />
              </Notice>
            )}
            {confirmedDisplay && !!snapshot?.scope.occurrenceIds.length && groups.length === 0 && (
              <Notice title="No ingredient rows are available">
                Review the source recipes for the selected meals.
              </Notice>
            )}
            {!!search.trim() && (
              <AppText role="support" color="inkSecondary" accessibilityLiveRegion="polite">
                {rows.length} matching {rows.length === 1 ? 'item' : 'items'}
                {!complete
                  ? manual && !manual.complete
                    ? ' in the loaded list · manual items not current'
                    : ' in the loaded list · latest state not confirmed'
                  : ''}
              </AppText>
            )}
          </View>
        }
        ListEmptyComponent={
          ready && total > 0 ? (
            <View style={styles.empty}>
              <AppText role="bodyStrong">
                {search.trim()
                  ? manual && !manual.complete
                    ? 'No matches in the loaded items'
                    : 'No matching items'
                  : !complete
                    ? 'No items in this loaded view'
                    : filter === 'to_buy'
                      ? 'Everything on this list is purchased'
                      : 'No purchased items yet'}
              </AppText>
              <AppText role="support" color="inkSecondary">
                {search.trim()
                  ? 'Try another ingredient name or clear the search.'
                  : !complete
                    ? 'Your own items are not current. Wait for the list to load or retry before relying on the total.'
                    : 'Switch the list view to see your other items.'}
              </AppText>
            </View>
          ) : null
        }
        renderItem={({ item, index }) =>
          item.kind === 'recipe' ? (
            <IngredientGroup
              group={item.group}
              disabled={!canChangeMeals}
              onBeforeToggle={() => checklist.retain(item)}
              onSources={(restore) =>
                openEvidence({ kind: 'ingredient', groupKey: item.group.groupKey }, restore)
              }
            />
          ) : (
            <View style={styles.ingredientGroup}>
              {(index === 0 || rows[index - 1]?.kind !== 'manual') && (
                <AppText role="label" color="inkSecondary" style={styles.manualHeading}>
                  Your own items · separate from recipes
                </AppText>
              )}
              <PurchaseRow
                name={item.item.name ?? 'Unavailable item'}
                amount={
                  [item.item.amountText, item.item.unitText].filter(Boolean).join(' ') ||
                  'Amount not specified'
                }
                purchased={item.item.purchased}
                changed={false}
                unavailable={!manual?.ready}
                onToggle={() => {
                  if (!manual?.ready || !manual.isCurrent()) return;
                  checklist.retain(item);
                  manual.toggle(item.item);
                }}
                accessory={
                  <IconButton
                    name="more"
                    label={`Edit manual item ${item.item.name}`}
                    tone="quiet"
                    disabled={!manual?.ready}
                    onPress={() => {
                      if (manual?.ready && manual.isCurrent())
                        router.push({
                          pathname: '/manual-shopping',
                          params: { item: item.item.itemId },
                        });
                    }}
                  />
                }
              />
            </View>
          )
        }
      />
      <ShoppingEvidenceSheets
        evidence={evidence}
        snapshot={snapshot}
        notes={recipesWithNotes}
        contentEntries={contentEntries}
        week={week}
        canChangeMeals={canChangeMeals}
        onClose={() => setEvidence(null)}
        onReturnFocus={() => {
          if (!returnFocus.current()) restoreScreenFocus();
        }}
        onRecipeNavigation={() => {
          // Arm only this source journey; ordinary tab returns must not move focus.
          recipeReturnFocus.current = returnFocus.current;
        }}
      />
    </Page>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    listContent: { gap: 0 },
    listHeader: { gap: t.space.xs, paddingBottom: t.space.sm },
    headingRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.xs,
    },
    toolbar: { flexDirection: 'row', alignItems: 'center', gap: t.space.xxs, flexWrap: 'wrap' },
    utility: { paddingHorizontal: t.space.sm },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: t.space.sm,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: t.radius.control,
      backgroundColor: t.color.surface,
    },
    searchField: {
      flex: 1,
      minWidth: 0,
      borderWidth: 0,
      paddingHorizontal: t.space.sm,
      backgroundColor: 'transparent',
      ...(Platform.OS === 'web' ? { outlineWidth: 0 } : {}),
    },
    searchFocused: {
      borderColor: t.color.focus,
      ...(Platform.OS === 'web'
        ? {
            outlineWidth: t.border.focus,
            outlineColor: t.color.focus,
            outlineStyle: 'solid' as const,
            outlineOffset: 2,
          }
        : {}),
    },
    scopeControl: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xs,
    },
    flex: { flex: 1, minWidth: 0 },
    notes: {
      gap: t.space.xxs,
      padding: t.space.sm,
      backgroundColor: t.color.cautionSurface,
      borderRadius: t.radius.small,
    },
    noteHeading: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    ingredientGroup: {
      backgroundColor: t.color.surface,
      paddingHorizontal: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    amountWarning: { paddingLeft: t.control.checkbox + t.space.sm, paddingBottom: t.space.sm },
    manualHeading: { paddingTop: t.space.md },
    empty: { gap: t.space.xs, paddingVertical: t.space.lg },
    pressed: { opacity: 0.7 },
  });
