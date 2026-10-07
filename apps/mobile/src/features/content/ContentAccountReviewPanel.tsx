import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Immutable } from '@cookmate/domain';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type { AccountContentSnapshot } from '../../../../../packages/account-sync/src/contentSnapshot';
import type { AccountContentConflictValue } from '../../../../../packages/account-sync/src/contentMerge';
import type { ContentSyncRemovalChoices } from '../../../../../packages/account-sync/src/contentCoordinator';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import type {
  AccountPurchaseDescription,
  AccountPurchaseDescriptions,
} from '../account/accountPurchaseDescriptions';
import { preferenceLabels } from '../assistant/assistantCopy';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import {
  buildContentAccountPurchaseDescriptions,
  type ContentAccountPurchaseDescriptionOptions,
} from './contentAccountPurchaseDescriptions';
import type {
  ContentAccountRuntimeAction,
  ContentAccountRuntimeSyncState,
} from './contentAccountRuntimeBackend';

type Review = Extract<ContentAccountRuntimeSyncState, { kind: 'review' }>;
export interface ContentAccountReviewPanelProps {
  review: Review;
  ownerKey: string;
  busy?: boolean;
  readExact?: ContentAccountPurchaseDescriptionOptions['readExact'];
  /** Includes owner, focused screen, exact issued review and host lifetime. */
  isCurrent(): boolean;
  dispatch(action: ContentAccountRuntimeAction): void;
  reopen(): void;
}
const PAGE_SIZE = 10;
const ReviewAccess = createContext<() => boolean>(() => false);
const reviewKeys = new WeakMap<object, number>();
let sequence = 0;
function keyFor(review: Review) {
  let key = reviewKeys.get(review);
  if (key === undefined) {
    key = ++sequence;
    reviewKeys.set(review, key);
  }
  return key;
}

/** Choices belong to this exact issued comparison, never another review of the same operation. */
export function ContentAccountReviewPanel(props: ContentAccountReviewPanelProps) {
  return <ReviewBody key={`${props.ownerKey}:${keyFor(props.review)}`} {...props} />;
}

function ReviewBody({
  review,
  busy = false,
  readExact,
  isCurrent,
  dispatch,
  reopen,
}: ContentAccountReviewPanelProps) {
  const styles = useThemedStyles(createStyles);
  const heading = useRef<View>(null);
  const mounted = useRef(true);
  const [page, setPage] = useState(0);
  const [removalPage, setRemovalPage] = useState(0);
  const [choices, setChoices] = useState<ContentSyncRemovalChoices>({});
  const [descriptions, setDescriptions] = useState<AccountPurchaseDescriptions>({});
  const issued = review.phase === 'push' || review.phase === 'apply' ? review.review : null;
  useEffect(() => {
    mounted.current = true;
    const frame = requestAnimationFrame(() => focusTarget(heading.current));
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!issued || !readExact || !isCurrent()) return;
    void buildContentAccountPurchaseDescriptions(issued, {
      readExact: async (ref) => {
        if (!active || !isCurrent()) throw new Error('Account review changed.');
        const value = await readExact(ref);
        if (!active || !isCurrent()) throw new Error('Account review changed.');
        return value;
      },
      sha256: nativeCommandPlatform.sha256,
    }).then(
      (value) => {
        if (active && isCurrent()) setDescriptions(value);
      },
      () => {
        // Unverified ingredient choices remain disabled; no bundled substitute.
      },
    );
    return () => {
      active = false;
    };
  }, [issued, readExact, isCurrent]);
  const active = () => mounted.current && !busy && isCurrent();
  const send = (action: ContentAccountRuntimeAction) => {
    if (active()) dispatch(action);
  };
  const conflicts = issued?.merge.status === 'needs_review' ? issued.merge.conflicts : [];
  const removals = issued?.removalReview?.conflicts ?? [];
  const complete = removals.every((item) => choices[item.id] !== undefined);
  return (
    <ReviewAccess.Provider value={active}>
      <View style={styles.panel}>
        <View ref={heading} accessible accessibilityRole="header">
          <AppText role="title">
            {review.phase === 'reopen'
              ? 'Continue with your account workspace'
              : review.phase === 'apply'
                ? 'Review changes during sync'
                : 'Review account cooking data'}
          </AppText>
        </View>
        {review.phase === 'reopen' ? (
          <>
            <AppText>
              Your reviewed change is saved on this device. Reopen this workspace to continue
              checking its account result.
            </AppText>
            <Notice title="Sync is not complete">
              This step does not confirm a cloud save. Your original guest workspace is kept.
            </Notice>
            <ActionButton
              label="Reopen account workspace"
              disabled={busy}
              onPress={() => {
                if (active()) reopen();
              }}
            />
          </>
        ) : (
          <>
            <AppText>
              {review.phase === 'apply'
                ? 'An account save may already have completed. Compare the current local changes before applying the pending result.'
                : 'Choose what to keep from this device and your private account. Exact recipe versions stay with their planned meals.'}
            </AppText>
            {review.phase === 'pull' ? (
              <>
                <SnapshotSummary title="Account version" snapshot={review.snapshot} />
                <Notice title="Use account data on this device" tone="caution">
                  This replaces supported local cooking data with the account version. Account
                  history is applied only within your approved history scope. Review this choice
                  before continuing.
                </Notice>
                <ActionButton
                  label="Review a merge instead"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => send({ kind: 'select', choice: 'merge' })}
                />
              </>
            ) : (
              issued && (
                <>
                  <SnapshotSummary title="This device" snapshot={issued.comparison.local} />
                  {issued.comparison.account ? (
                    <SnapshotSummary title="Account" snapshot={issued.comparison.account} />
                  ) : (
                    <Notice title="No account backup yet">
                      Confirming starts a reviewed account save of this device’s supported data.
                    </Notice>
                  )}
                  {review.phase === 'push' && issued.comparison.account && (
                    <ActionButton
                      label="Use account data instead"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => send({ kind: 'select', choice: 'account' })}
                    />
                  )}
                  {issued.merge.status === 'incompatible_catalogue' && (
                    <Notice title="Recipe versions need attention" tone="caution">
                      These copies cannot be combined by this app. Return to your account without
                      confirming.
                    </Notice>
                  )}
                  {!!conflicts.length && (
                    <View style={styles.section}>
                      <AppText role="section" accessibilityRole="header">
                        {conflicts.length} differences need a choice
                      </AppText>
                      {conflicts
                        .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                        .map((conflict, index) => {
                          const position = page * PAGE_SIZE + index + 1;
                          const purchase =
                            conflict.kind === 'purchase_state' ||
                            conflict.path.startsWith('shopping/purchaseMarks/');
                          const names = descriptions[conflict.id];
                          const identifiable =
                            !purchase ||
                            ((!conflict.local || !!names?.local?.name.trim()) &&
                              (!conflict.account || !!names?.account?.name.trim()));
                          return (
                            <View key={conflict.id} style={styles.section}>
                              <AppText role="bodyStrong">
                                Difference {position} · {conflictLabel(conflict.kind)}
                              </AppText>
                              <Version
                                title="This device"
                                value={conflict.local}
                                snapshot={issued.comparison.local}
                                description={names?.local}
                              />
                              <Version
                                title="Account"
                                value={conflict.account}
                                snapshot={issued.comparison.account}
                                description={names?.account}
                              />
                              {!identifiable && (
                                <Notice title="Ingredient could not be verified">
                                  This purchase choice needs the exact recipe ingredients. Return
                                  when they are available; no recipe version has been substituted.
                                </Notice>
                              )}
                              <ActionButton
                                label="Keep this device"
                                accessibilityLabel={`Difference ${position}: keep this device`}
                                disabled={busy || !identifiable}
                                onPress={() =>
                                  send({ kind: 'resolve', id: conflict.id, choice: 'local' })
                                }
                              />
                              <ActionButton
                                label="Keep account version"
                                accessibilityLabel={`Difference ${position}: keep account version`}
                                variant="secondary"
                                disabled={busy || !identifiable}
                                onPress={() =>
                                  send({ kind: 'resolve', id: conflict.id, choice: 'account' })
                                }
                              />
                            </View>
                          );
                        })}
                      <Pages
                        count={conflicts.length}
                        page={page}
                        label="differences"
                        disabled={busy}
                        onPage={(next) => {
                          if (active()) setPage(next);
                        }}
                      />
                    </View>
                  )}
                  {!!removals.length && (
                    <View style={styles.section}>
                      <AppText role="section" accessibilityRole="header">
                        {removals.length} previously removed choices
                      </AppText>
                      <AppText>
                        Choose separately whether to keep each local removal or save the displayed
                        account version.
                      </AppText>
                      {removals
                        .slice(removalPage * PAGE_SIZE, (removalPage + 1) * PAGE_SIZE)
                        .map((item, index) => {
                          const position = removalPage * PAGE_SIZE + index + 1;
                          return (
                            <View key={item.id} style={styles.section}>
                              <AppText role="bodyStrong">
                                Removal {position} ·{' '}
                                {item.kind === 'favourite'
                                  ? `Favourite: recipe ${item.incoming.recipeId}`
                                  : `${preferenceLabels[item.incoming.type]}: ${item.incoming.value}`}
                              </AppText>
                              <AppText>
                                {item.current.kind === 'live'
                                  ? `Current on this device: ${item.current.row.value}`
                                  : item.current.kind === 'removed'
                                    ? 'Removed from favourites on this device.'
                                    : 'No current local preference with this identity.'}
                              </AppText>
                              {item.reasons.some(
                                (reason) => reason === 'exactPreferenceRemoval',
                              ) && (
                                <AppText role="support">
                                  A matching preference was previously removed.
                                </AppText>
                              )}
                              {item.reasons.some(
                                (reason) => reason === 'unidentifiedPreferenceRemoval',
                              ) && (
                                <AppText role="support">
                                  A preference removal was recorded, but the removed value cannot be
                                  identified.
                                </AppText>
                              )}
                              {item.reasons.some(
                                (reason) => reason === 'retainedRestoreArchive',
                              ) && (
                                <AppText role="support">
                                  A retained restore archive means this incoming preference needs a
                                  fresh choice. It does not identify a deleted value.
                                </AppText>
                              )}
                              {(['keep_local', 'save_account_version'] as const).map((choice) => (
                                <ActionButton
                                  key={choice}
                                  label={
                                    choice === 'keep_local'
                                      ? 'Keep local choice'
                                      : 'Save displayed account version'
                                  }
                                  accessibilityLabel={`Removal ${position}: ${choice === 'keep_local' ? 'keep local choice' : 'save displayed account version'}`}
                                  accessibilityRole="radio"
                                  accessibilityState={{ checked: choices[item.id] === choice }}
                                  variant={choices[item.id] === choice ? 'primary' : 'secondary'}
                                  disabled={busy}
                                  onPress={() => {
                                    if (active())
                                      setChoices((current) => ({ ...current, [item.id]: choice }));
                                  }}
                                />
                              ))}
                            </View>
                          );
                        })}
                      <Pages
                        count={removals.length}
                        page={removalPage}
                        label="removals"
                        disabled={busy}
                        onPage={(next) => {
                          if (active()) setRemovalPage(next);
                        }}
                      />
                    </View>
                  )}
                </>
              )
            )}
            {review.initial && (
              <AppText role="support" color="inkSecondary">
                The first reviewed account import keeps a local recovery copy of the guest data used
                for that review. It is not a separate cloud backup.
              </AppText>
            )}
            <AppText role="support" color="inkSecondary">
              Purchase checks are matched to the resulting ingredient demand. Conversations, drafts,
              credentials and AI sharing consent stay outside this sync. Cooking history follows
              your approved scope.
            </AppText>
            <ActionButton
              label={
                review.phase === 'pull' ? 'Confirm use of account data' : 'Confirm reviewed changes'
              }
              disabled={busy || !review.canConfirm || !complete}
              onPress={() => {
                if (complete && review.canConfirm)
                  send({ kind: 'confirm', ...(removals.length ? { removals: choices } : {}) });
              }}
            />
            <ActionButton
              label="Return to account"
              variant="quiet"
              disabled={busy}
              onPress={() => send({ kind: 'cancelReview' })}
            />
            <AppText role="support" color="inkSecondary">
              Returning leaves this review. It does not cancel or undo a completed account save.
            </AppText>
          </>
        )}
      </View>
    </ReviewAccess.Provider>
  );
}

function SnapshotSummary({
  title,
  snapshot,
}: {
  title: string;
  snapshot: Immutable<AccountContentSnapshot>;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.summary}>
      <AppText role="bodyStrong">{title}</AppText>
      <AppText role="support">
        {snapshot.favourites.length} favourites · {snapshot.plan.length} planned meals
      </AppText>
      <AppText role="support">
        {snapshot.shopping.selectedOccurrenceIds.length} meals selected for shopping ·{' '}
        {snapshot.preferences.length} saved preferences
      </AppText>
      <AppText role="support">
        {snapshot.personal.notes.filter((item) => !item.deleted).length} notes ·{' '}
        {snapshot.personal.collections.filter((item) => !item.deleted).length} collections ·{' '}
        {snapshot.personal.manualItems.filter((item) => !item.deleted).length} manual items
      </AppText>
      <AppText role="support">
        {snapshot.cookingHistory
          ? `${snapshot.cookingHistory.entries.length} cooking entries in this snapshot`
          : 'Cooking history is absent from this snapshot'}
      </AppText>
    </View>
  );
}
function Pages({
  count,
  page,
  label,
  disabled,
  onPage,
}: {
  count: number;
  page: number;
  label: string;
  disabled: boolean;
  onPage(page: number): void;
}) {
  if (count <= PAGE_SIZE) return null;
  return (
    <View style={{ gap: 8 }}>
      <AppText role="support" accessibilityLiveRegion="polite">
        Showing {page * PAGE_SIZE + 1}–{Math.min(count, (page + 1) * PAGE_SIZE)} of {count} {label}
      </AppText>
      <ActionButton
        label={`Previous ${label}`}
        variant="quiet"
        disabled={disabled || page === 0}
        onPress={() => onPage(page - 1)}
      />
      <ActionButton
        label={`Next ${label}`}
        variant="quiet"
        disabled={disabled || (page + 1) * PAGE_SIZE >= count}
        onPress={() => onPage(page + 1)}
      />
    </View>
  );
}
function Version({
  title,
  value,
  snapshot,
  description,
}: {
  title: string;
  value: Immutable<AccountContentConflictValue>;
  snapshot: Immutable<AccountContentSnapshot> | null;
  description?: AccountPurchaseDescription | undefined;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.version}>
      <AppText role="bodyStrong">{title}</AppText>
      <Value value={value} snapshot={snapshot} description={description} />
    </View>
  );
}
function Value({
  value,
  snapshot,
  description,
}: {
  value: Immutable<AccountContentConflictValue>;
  snapshot: Immutable<AccountContentSnapshot> | null;
  description?: AccountPurchaseDescription | undefined;
}) {
  if (value === null) return <AppText>Removed or absent in this copy.</AppText>;
  if (typeof value === 'string' || typeof value === 'boolean')
    return <AppText>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}</AppText>;
  if ('length' in value) return <ValueList values={value} snapshot={snapshot} />;
  if ('contentRef' in value)
    return (
      <>
        <AppText>
          Recipe {value.recipeId} · exact version {value.contentRef.revisionId}
        </AppText>
        <ExactReference contentRef={value.contentRef} />
        <AppText>
          {formatPlanDate(value.placement.actualDate)} · {mealLabel(value.placement.mealKey)}
        </AppText>
      </>
    );
  if ('preferenceId' in value)
    return (
      <AppText>
        {preferenceLabels[value.type]}: {value.value}
      </AppText>
    );
  if ('groupKey' in value)
    return (
      <>
        <AppText>
          {description?.name ?? 'Unverified ingredient'}
          {description?.quantity ? ` · ${description.quantity}` : ''}
        </AppText>
        <AppText>
          {value.purchased ? 'Purchased' : 'Not purchased'}
          {value.changed ? ' · demand changed' : ''}
        </AppText>
      </>
    );
  if ('noteId' in value)
    return (
      <>
        <AppText>Private note for recipe {value.recipeId}</AppText>
        <AppText>{value.deleted ? 'Note removed.' : value.text}</AppText>
      </>
    );
  if ('collection' in value)
    return (
      <>
        <Value value={value.collection} snapshot={snapshot} />
        <AppText role="support">{value.memberships.length} membership records</AppText>
        <ValueList values={value.memberships} snapshot={snapshot} />
      </>
    );
  if ('itemId' in value)
    return (
      <AppText>
        {value.deleted
          ? 'Manual item removed.'
          : `${value.name} · ${[value.amountText, value.unitText].filter(Boolean).join(' ')} · ${value.purchased ? 'Purchased' : 'Not purchased'}`}
      </AppText>
    );
  if ('recipeId' in value)
    return (
      <AppText>
        {snapshot?.personal.collections.find((item) => item.collectionId === value.collectionId)
          ?.name ?? 'Collection'}{' '}
        · recipe {value.recipeId} · {value.present ? 'Included' : 'Removed'}
      </AppText>
    );
  return <AppText>{value.deleted ? 'Collection removed.' : value.name}</AppText>;
}
function ValueList({
  values,
  snapshot,
}: {
  values: readonly Immutable<AccountContentConflictValue>[];
  snapshot: Immutable<AccountContentSnapshot> | null;
}) {
  const [page, setPage] = useState(0);
  const current = useContext(ReviewAccess);
  return (
    <View style={{ gap: 8 }}>
      {values.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((value, index) => (
        <Value key={index} value={value} snapshot={snapshot} />
      ))}
      <Pages
        count={values.length}
        page={page}
        label="items"
        disabled={false}
        onPage={(next) => {
          if (current()) setPage(next);
        }}
      />
    </View>
  );
}
function ExactReference({ contentRef }: { contentRef: Immutable<RecipeContentRef> }) {
  const [expanded, setExpanded] = useState(false);
  const current = useContext(ReviewAccess);
  return (
    <>
      <ActionButton
        label={expanded ? 'Hide exact reference' : 'Show exact reference'}
        variant="quiet"
        accessibilityState={{ expanded }}
        onPress={() => {
          if (current()) setExpanded((value) => !value);
        }}
      />
      {expanded && (
        <AppText role="support" selectable>
          Content fingerprint: {contentRef.contentFingerprint}
        </AppText>
      )}
    </>
  );
}
function conflictLabel(kind: string) {
  switch (kind) {
    case 'occurrence_edit':
    case 'slot_collision':
      return 'Planned meal';
    case 'preference_edit':
    case 'preference_collision':
      return 'Cooking preference';
    case 'purchase_state':
      return 'Shopping purchase';
    case 'note_edit':
      return 'Private recipe note';
    case 'collection_edit':
    case 'collection_subtree':
      return 'Collection';
    case 'membership_edit':
      return 'Collection membership';
    case 'manual_item_edit':
      return 'Manual shopping item';
    case 'setting':
      return 'Account setting';
    default:
      return 'Removal or changed item';
  }
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    panel: { gap: t.space.lg, minWidth: 0 },
    section: {
      gap: t.space.sm,
      paddingTop: t.space.md,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
    },
    summary: {
      gap: t.space.xs,
      padding: t.space.md,
      borderRadius: t.radius.small,
      backgroundColor: t.color.surfaceMuted,
    },
    version: {
      gap: t.space.xs,
      paddingLeft: t.space.md,
      borderLeftWidth: 2,
      borderLeftColor: t.color.divider,
    },
  });
