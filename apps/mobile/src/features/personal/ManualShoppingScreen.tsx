import { useEffect, useRef, useState, type Ref } from 'react';
import { ScrollView, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import {
  manualShoppingCategories,
  personalLimits,
  type Immutable,
  type ManualShoppingCategory,
  type ManualShoppingFields,
  type ManualShoppingItem,
  type ManualShoppingPage,
} from '@cookmate/domain';
import { Page, PageHeader } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { FocusedSheet } from '../../components/FocusedSheet';
import { confirmAction } from '../../components/confirmAction';
import { focusTarget } from '../../components/focusTarget';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { PurchaseRow } from '../shopping/PurchaseRow';
import { useUnsavedDraft } from '../../hooks/useUnsavedDraft';
import {
  PersonalOperationFeedback,
  PersonalPrivacy,
  PersonalUnavailable,
  usePersonalStyles,
  validPersonalText,
} from './PersonalUI';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { usePersonalOperations } from './usePersonalOperations';
import { usePersonalSubmission } from './usePersonalSubmission';
import {
  useManualShoppingPorts,
  useManualShoppingData,
  type ManualShoppingDataPorts,
  type ManualShoppingService,
} from './useManualShoppingPorts';

const alwaysCurrent = () => true;
const categories: Record<ManualShoppingCategory, string> = {
  produce: 'Produce',
  dairy: 'Dairy',
  meat_fish: 'Meat & fish',
  pantry: 'Pantry',
  other: 'Other',
};
export default function ManualShoppingScreen() {
  const ports = useManualShoppingPorts();
  const content = useOrdinaryContentRuntime();
  const params = useLocalSearchParams<{ create?: string; item?: string }>();
  return (
    <Page bottomInset>
      <PageHeader back title="Your own shopping items" />
      {ports ? (
        <ManualShoppingList
          key={ports.scopeKey}
          {...ports}
          initialCreate={params.create === '1'}
          initialItem={typeof params.item === 'string' ? params.item : undefined}
        />
      ) : content ? (
        <Notice title="Manual shopping is unavailable">
          Return after this workspace finishes its update or recovery to check saved items and any
          pending change.
        </Notice>
      ) : (
        <PersonalUnavailable />
      )}
    </Page>
  );
}
type Editing = { item: Immutable<ManualShoppingItem> | null; epoch: number };
export function ManualShoppingList({
  service,
  readInstallationId,
  initialCreate = false,
  initialItem,
  isCurrent: scopeCurrent,
  mode,
}: ManualShoppingDataPorts & { initialCreate?: boolean; initialItem?: string | undefined }) {
  const styles = usePersonalStyles();
  const [revealedCount, setRevealedCount] = useState(20);
  const { query, operation, ready, sourceReady, isCurrent } = useManualShoppingData({
    service,
    readInstallationId,
    ...(scopeCurrent ? { isCurrent: scopeCurrent } : {}),
    ...(mode ? { mode } : {}),
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const addTarget = useRef<View>(null);
  const editTargets = useRef(new Map<string, View>());
  const returnItem = useRef<string | null>(null);
  const focusFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );
  function openEditor(next: Editing) {
    if (!isCurrent() || !latest.current.ready) return;
    returnItem.current = next.item?.itemId ?? null;
    setEditing(next);
    setEditorVisible(true);
  }
  function finishDismissal() {
    if (!isCurrent()) return;
    setEditing(null);
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (!isCurrent()) return;
      const target = returnItem.current ? editTargets.current.get(returnItem.current) : null;
      focusTarget(target ?? addTarget.current);
    });
  }
  const [deleting, setDeleting] = useState<{
    item: Immutable<ManualShoppingItem>;
    epoch: number;
  } | null>(null);
  const deletingOperation = useRef<{
    operationId: string;
    target: NonNullable<typeof deleting>;
  } | null>(null);
  useEffect(() => {
    const pending = deletingOperation.current,
      receipt = operation.receipt;
    if (!isCurrent() || !pending || !receipt || receipt.operationId !== pending.operationId) return;
    const cancelled =
      receipt.outcome === 'cancelled' &&
      (receipt.commandKind === null || receipt.commandKind === 'deleteManualItem');
    const saved =
      receipt.commandKind === 'deleteManualItem' &&
      receipt.entityId === pending.target.item.itemId &&
      (receipt.outcome === 'committed' || receipt.outcome === 'no_op');
    if (!cancelled && !saved) return;
    deletingOperation.current = null;
    setDeleting((current) => (current === pending.target ? null : current));
  }, [operation.receipt, isCurrent]);
  const latest = useRef({ ready, query, editing, deleting });
  latest.current = { ready, query, editing, deleting };
  const initialHandled = useRef(false);
  useEffect(() => {
    if (!isCurrent() || initialHandled.current || !ready || !query.value) return;
    initialHandled.current = true;
    if (initialCreate && query.value.total < personalLimits.manualItems)
      openEditor({ item: null, epoch: query.value.epoch });
    else if (initialItem) {
      const item = query.value.items.find((entry) => entry.itemId === initialItem);
      if (item) openEditor({ item, epoch: query.value.epoch });
    }
  }, [ready, query.value, initialCreate, initialItem]);
  async function toggle(item: Immutable<ManualShoppingItem>) {
    const current = latest.current;
    const epoch = current.query.value?.epoch;
    if (
      !isCurrent() ||
      !current.ready ||
      current.editing ||
      current.deleting ||
      epoch === undefined ||
      !current.query.value?.items.some((row) => row === item)
    )
      return;
    const saved = await operation.perform((operationId) =>
      service.execute({
        kind: 'setManualPurchased',
        operationId,
        expectedEpoch: epoch,
        itemId: item.itemId,
        expectedRevision: item.revision,
        purchased: !item.purchased,
      }),
    );
    if (saved && isCurrent()) await query.reload();
  }
  async function remove() {
    if (!isCurrent() || !latest.current.ready || !deleting || latest.current.deleting !== deleting)
      return;
    const saved = await operation.perform((operationId) => {
      deletingOperation.current = { operationId, target: deleting };
      return service.execute({
        kind: 'deleteManualItem',
        operationId,
        expectedEpoch: deleting.epoch,
        itemId: deleting.item.itemId,
        expectedRevision: deleting.item.revision,
      });
    });
    if (saved && isCurrent()) {
      setDeleting(null);
      await query.reload();
    }
  }
  return (
    <View style={styles.section}>
      <AppText role="support" color="inkSecondary">
        Household extras stay separate when selected meals change.
      </AppText>
      {!editorVisible && <PersonalOperationFeedback operation={operation} />}
      {query.loading && <AppText role="support">Loading manual items…</AppText>}
      {query.error && (
        <Notice title="Manual list needs attention" tone="error">
          <AppText>{query.error}</AppText>
          <ActionButton
            label="Retry manual items"
            variant="quiet"
            onPress={() => void query.reload()}
          />
        </Notice>
      )}
      {editing && (
        <ManualItemForm
          key={editing.item?.itemId ?? 'new'}
          {...editing}
          service={service}
          operation={operation}
          currentPage={query.value}
          sourceReady={sourceReady}
          isCurrent={isCurrent}
          visible={editorVisible}
          onDismiss={finishDismissal}
          onRefresh={() => {
            if (isCurrent()) void query.reload();
          }}
          onCancel={() => {
            if (isCurrent()) setEditorVisible(false);
          }}
          onSaved={() => {
            if (!isCurrent()) return;
            setEditorVisible(false);
            void query.reload();
          }}
        />
      )}
      <ActionButton
        ref={addTarget}
        label="Add manual item"
        disabled={
          !ready ||
          !query.value ||
          !!editing ||
          !!deleting ||
          query.value.total >= personalLimits.manualItems
        }
        onPress={() => {
          if (
            isCurrent() &&
            latest.current.ready &&
            latest.current.query.value === query.value &&
            query.value
          )
            openEditor({ item: null, epoch: query.value.epoch });
        }}
      />
      {query.value && (
        <AppText role="support">
          Showing {Math.min(revealedCount, query.value.items.length)} of {query.value.total} manual
          items. Their order stays stable when checked.
        </AppText>
      )}
      {query.value?.items.slice(0, revealedCount).map((item) => (
        <View key={item.itemId} style={styles.card}>
          <PurchaseRow
            name={item.name ?? 'Unavailable item'}
            amount={
              [item.amountText, item.unitText].filter(Boolean).join(' ') || 'Amount not specified'
            }
            purchased={item.purchased}
            changed={false}
            unavailable={!ready || !!editing || !!deleting}
            onToggle={() => void toggle(item)}
          />
          <AppText role="support">
            {item.category ? categories[item.category] : 'Other'} · Manual item
          </AppText>
          <View style={styles.actions}>
            <ActionButton
              ref={(target) => {
                if (target) editTargets.current.set(item.itemId, target);
                else editTargets.current.delete(item.itemId);
              }}
              label={`Edit ${item.name}`}
              variant="quiet"
              disabled={!ready || !!editing || !!deleting}
              onPress={() => {
                if (
                  isCurrent() &&
                  latest.current.ready &&
                  latest.current.query.value === query.value &&
                  query.value
                )
                  openEditor({ item, epoch: query.value.epoch });
              }}
            />
            <ActionButton
              label={`Delete ${item.name}`}
              variant="quiet"
              disabled={!ready || !!editing || !!deleting}
              onPress={() => {
                if (
                  isCurrent() &&
                  latest.current.ready &&
                  latest.current.query.value === query.value &&
                  query.value
                )
                  setDeleting({ item, epoch: query.value.epoch });
              }}
            />
          </View>
        </View>
      ))}
      {query.value?.total === 0 && (
        <AppText>
          Your own list is empty. Add an item above; it will remain separate from recipe
          ingredients.
        </AppText>
      )}
      {deleting && (
        <Notice title={`Delete ${deleting.item.name}?`}>
          <AppText>
            Only this manual item will be removed. Calculated ingredient groups and their purchase
            marks remain.
          </AppText>
          <ActionButton
            label="Confirm delete manual item"
            disabled={!ready || !query.value}
            onPress={() => void remove()}
          />
          <ActionButton
            label="Keep manual item"
            variant="quiet"
            disabled={operation.busy}
            onPress={() => {
              if (isCurrent() && !operation.busy) setDeleting(null);
            }}
          />
        </Notice>
      )}
      {query.value && revealedCount < query.value.items.length && (
        <ActionButton
          label="Load more manual items"
          variant="secondary"
          disabled={query.loading || operation.busy || !!editing}
          onPress={() => {
            if (!isCurrent()) return;
            setRevealedCount((value) => value + 20);
          }}
        />
      )}
      {mode === 'content' ? (
        <AppText role="support" color="inkSecondary">
          Your own items are private to this workspace. They stay separate from recipe ingredients
          and are not automatically sent to the assistant.
        </AppText>
      ) : (
        <PersonalPrivacy />
      )}
    </View>
  );
}
function fieldsFor(item: Immutable<ManualShoppingItem> | null): ManualShoppingFields {
  return {
    name: item?.name ?? '',
    amountText: item?.amountText ?? '',
    unitText: item?.unitText ?? '',
    category: item?.category ?? 'other',
  };
}
export function ManualItemForm({
  item,
  epoch,
  service,
  operation,
  currentPage,
  sourceReady,
  onRefresh,
  onCancel,
  onSaved,
  visible,
  onDismiss,
  isCurrent = alwaysCurrent,
}: Editing & {
  service: Pick<ManualShoppingService, 'execute'>;
  isCurrent?: () => boolean;
  operation: ReturnType<typeof usePersonalOperations>;
  currentPage: Immutable<ManualShoppingPage> | null;
  sourceReady: boolean;
  onRefresh(): void;
  onCancel(): void;
  onSaved(): void;
  visible: boolean;
  onDismiss(): void;
}) {
  const styles = usePersonalStyles();
  const formStyles = useThemedStyles(createFormStyles);
  const { width, enlarged } = useNativeLayout();
  const stackAmounts = enlarged || width < 360;
  const nameInput = useRef<TextInput>(null);
  const [baseline, setBaseline] = useState(() => fieldsFor(item));
  const [fields, setFields] = useState(() => fieldsFor(item));
  const [revision, setRevision] = useState(item?.revision ?? null);
  const [expectedEpoch, setExpectedEpoch] = useState(epoch);
  const [baselinePurchased, setBaselinePurchased] = useState(item?.purchased ?? false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [itemId, setItemId] = useState(() => item?.itemId ?? Crypto.randomUUID());
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const latest = useRef({
    service,
    item,
    visible,
    isCurrent,
    fields,
    operation,
    currentPage,
    sourceReady,
  });
  latest.current = {
    service,
    item,
    visible,
    isCurrent,
    fields,
    operation,
    currentPage,
    sourceReady,
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () =>
    mounted.current &&
    latest.current.service === service &&
    latest.current.item === item &&
    latest.current.visible &&
    latest.current.isCurrent === isCurrent &&
    isCurrent();
  const submission = usePersonalSubmission(
    operation.receipt,
    JSON.stringify(fields),
    (unchanged) => {
      if (!active()) return;
      if (unchanged) onSaved();
      else if (!item) {
        setItemId(Crypto.randomUUID());
        setDraftMessage(
          'Your earlier item was saved. Your newer changes are kept as a separate draft.',
        );
      } else {
        setReviewRequired(true);
        setDraftMessage(
          'The submitted edit was saved. Your newer changes are still a draft. Review the current saved item before another save.',
        );
        onRefresh();
      }
    },
    () => {
      if (!active()) return;
      setReviewRequired(true);
      setDraftMessage(
        'The earlier request was cancelled. Your draft is kept. Review the current saved state before a new save.',
      );
      onRefresh();
    },
  );
  const currentItem = item ? currentPage?.items.find((row) => row.itemId === item.itemId) : null;
  const sourceChanged =
    !!currentPage &&
    (currentPage.epoch !== expectedEpoch || (!!item && currentItem?.revision !== revision));
  const needsReview = reviewRequired || sourceChanged;
  const dirty =
    fields.name !== baseline.name ||
    fields.amountText !== baseline.amountText ||
    fields.unitText !== baseline.unitText ||
    fields.category !== baseline.category;
  useUnsavedDraft(visible && dirty, 'Discard manual shopping changes?');
  function requestCancel() {
    if (!active() || latest.current.operation.busy) return;
    if (!dirty) return onCancel();
    confirmAction({
      title: 'Discard manual shopping changes?',
      message: 'Your unsaved item changes will be discarded. Saved shopping items are unchanged.',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard changes',
      destructive: true,
      onConfirm: () => {
        if (active() && !latest.current.operation.busy) onCancel();
      },
    });
  }
  const contentChanged =
    fields.name !== baseline.name ||
    fields.amountText !== baseline.amountText ||
    fields.unitText !== baseline.unitText;
  const valid =
    validPersonalText(fields.name, personalLimits.itemNameCharacters) &&
    validPersonalText(fields.amountText ?? '', personalLimits.amountCharacters, true) &&
    validPersonalText(fields.unitText ?? '', personalLimits.unitCharacters, true);
  async function save() {
    const normalized = {
      ...fields,
      amountText: fields.amountText || null,
      unitText: fields.unitText || null,
    };
    if (
      !active() ||
      latest.current.fields !== fields ||
      latest.current.currentPage !== currentPage ||
      !latest.current.operation.ready ||
      !sourceReady ||
      !latest.current.sourceReady ||
      needsReview ||
      !valid ||
      !dirty
    )
      return;
    await operation.perform((operationId) => {
      submission.bind(operationId, itemId, item ? 'editManualItem' : 'addManualItem');
      return service.execute(
        item
          ? {
              kind: 'editManualItem',
              operationId,
              expectedEpoch,
              itemId: item.itemId,
              expectedRevision: revision!,
              fields: normalized,
            }
          : {
              kind: 'addManualItem',
              operationId,
              expectedEpoch,
              itemId,
              fields: normalized,
            },
      );
    });
  }
  return (
    <FocusedSheet
      visible={visible}
      onDismiss={() => {
        if (mounted.current && isCurrent()) onDismiss();
      }}
      title={item ? 'Edit your item' : 'Add your item'}
      onClose={requestCancel}
      closeLabel="Cancel"
      scroll={false}
      onShow={() => {
        if (active()) nameInput.current?.focus();
      }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={formStyles.body}
        style={formStyles.scroll}
      >
        <PersonalOperationFeedback operation={operation} />
        <ManualField
          label="Item name"
          inputRef={nameInput}
          value={fields.name}
          onChangeText={(name) => {
            if (active() && !latest.current.operation.busy)
              setFields((current) => ({ ...current, name }));
          }}
          limit={personalLimits.itemNameCharacters}
          editable={!operation.busy}
        />
        <View style={[formStyles.amounts, stackAmounts && formStyles.stacked]}>
          <ManualField
            grow={!stackAmounts}
            label="Amount · optional"
            value={fields.amountText ?? ''}
            onChangeText={(amountText) => {
              if (active() && !latest.current.operation.busy)
                setFields((current) => ({ ...current, amountText }));
            }}
            limit={personalLimits.amountCharacters}
            editable={!operation.busy}
          />
          <ManualField
            grow={!stackAmounts}
            label="Unit · optional"
            value={fields.unitText ?? ''}
            onChangeText={(unitText) => {
              if (active() && !latest.current.operation.busy)
                setFields((current) => ({ ...current, unitText }));
            }}
            limit={personalLimits.unitCharacters}
            editable={!operation.busy}
          />
        </View>
        <AppText role="support" color="inkSecondary">
          Amount and unit are optional text. Nothing is converted or guessed.
        </AppText>
        <AppText role="label">Category · optional</AppText>
        <View style={styles.actions}>
          {manualShoppingCategories.map((category) => (
            <ActionButton
              key={category}
              label={categories[category]}
              accessibilityRole="radio"
              accessibilityState={{ checked: fields.category === category }}
              variant={fields.category === category ? 'secondary' : 'quiet'}
              disabled={operation.busy}
              onPress={() => {
                if (active() && !latest.current.operation.busy)
                  setFields((current) => ({ ...current, category }));
              }}
            />
          ))}
        </View>
        {baselinePurchased && !needsReview && (
          <Notice
            title={
              contentChanged ? 'This item will return to To buy' : 'Purchase mark stays checked'
            }
          >
            {contentChanged
              ? 'Changing the name, amount or unit clears only this manual item’s purchased mark. Recipe ingredient marks stay unchanged.'
              : 'A category-only change preserves this manual item’s purchased mark.'}
          </Notice>
        )}
        {needsReview && (
          <Notice title="Review the current saved state">
            <AppText>
              {item
                ? currentItem
                  ? `Current item: ${currentItem.name}; ${[currentItem.amountText, currentItem.unitText].filter(Boolean).join(' ') || 'amount not specified'}; ${currentItem.purchased ? 'Purchased' : 'To buy'}. Your draft stays above.`
                  : 'This item is no longer in the loaded list. Cancel this editor to review the list; it will not be recreated automatically.'
                : 'This is a new manual item. Review the refreshed list below before saving your retained draft.'}
            </AppText>
            <ActionButton
              label="Use current list for this draft"
              variant="secondary"
              disabled={
                !sourceReady || !operation.ready || !currentPage || (!!item && !currentItem)
              }
              onPress={() => {
                if (
                  !active() ||
                  latest.current.currentPage !== currentPage ||
                  !latest.current.sourceReady ||
                  !latest.current.operation.ready ||
                  !currentPage ||
                  (item && !currentItem)
                )
                  return;
                if (currentItem) {
                  setBaseline(fieldsFor(currentItem));
                  setBaselinePurchased(currentItem.purchased);
                  setRevision(currentItem.revision);
                }
                setExpectedEpoch(currentPage.epoch);
                setReviewRequired(false);
              }}
            />
          </Notice>
        )}
        {draftMessage && <AppText role="support">{draftMessage}</AppText>}
      </ScrollView>
      <View style={formStyles.footer}>
        <ActionButton
          label="Save manual item"
          disabled={!operation.ready || !sourceReady || needsReview || !valid || !dirty}
          onPress={() => void save()}
        />
        <ActionButton
          label="Cancel manual item changes"
          variant="quiet"
          disabled={operation.busy}
          onPress={requestCancel}
        />
      </View>
    </FocusedSheet>
  );
}

function ManualField({
  label,
  limit,
  inputRef,
  grow = false,
  ...props
}: TextInputProps & {
  label: string;
  limit: number;
  inputRef?: Ref<TextInput>;
  grow?: boolean;
}) {
  const t = useTheme();
  const controls = useControlStyles();
  const styles = useThemedStyles(createFormStyles);
  const length = Array.from(props.value ?? '').length;
  return (
    <View style={[styles.field, grow && styles.growingField]}>
      <AppText role="label">{label}</AppText>
      <TextInput
        {...props}
        ref={inputRef}
        accessibilityLabel={label}
        maxLength={limit * 2}
        placeholderTextColor={t.color.inkSecondary}
        style={controls.field}
      />
      {length > limit * 0.8 && (
        <AppText role="support" color={length > limit ? 'error' : 'inkSecondary'}>
          {length}/{limit} characters
        </AppText>
      )}
    </View>
  );
}

const createFormStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    scroll: { flex: 1, minHeight: 0 },
    body: { padding: t.space.gutter, gap: t.space.md },
    footer: {
      paddingHorizontal: t.space.gutter,
      paddingVertical: t.space.sm,
      gap: t.space.xs,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      backgroundColor: t.color.canvas,
    },
    amounts: { flexDirection: 'row', gap: t.space.sm },
    stacked: { flexDirection: 'column' },
    field: { minWidth: 0, gap: t.space.xs },
    growingField: { flex: 1 },
  });
