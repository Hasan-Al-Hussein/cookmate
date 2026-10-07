import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View } from 'react-native';
import type { Immutable } from '@cookmate/catalogue';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type {
  ContentAdoptionMealChoice,
  ContentAdoptionMealChoices,
  ContentAdoptionReview,
} from '../../data/contentAdoption';
import type { ContentReleaseReview, ContentReleaseStage } from '../../data/contentReleaseStore';
import { ActionButton, Notice } from '../../components/Controls';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { useTheme } from '../../design/ThemeProvider';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { ContentWorkspaceReader } from './ContentWorkspaceReader';
import {
  ContentAdoptionMealChooser,
  adoptionMatchesMealChoices,
} from './ContentAdoptionMealChooser';
import type { ContentWorkspaceHost } from './contentWorkspaceHost';
import { PrivateContentCleanupError, type PrivateContentRuntime } from './privateContentRuntime';

type Props = {
  open(): Promise<PrivateContentRuntime>;
  onExit(): void;
  renderWorkspace?(runtime: PrivateContentRuntime, exit: () => void): ReactNode;
};
type Opening =
  | { kind: 'opening' | 'closing' }
  | { kind: 'failed' | 'cleanup_blocked' }
  | { kind: 'ready'; runtime: PrivateContentRuntime; opener: Props['open'] };
const PAGE_SIZE = 20;

/** Opens only the configured private runtime; ordinary workspace services never enter this view. */
export function PrivateContentScreen({ open, onExit, renderWorkspace }: Props) {
  const [state, setState] = useState<Opening>({ kind: 'opening' });
  const [attempt, setAttempt] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const owned = useRef(new Set<PrivateContentRuntime>());
  const generation = useRef(0);
  const mounted = useRef(false);
  const exiting = useRef(false);
  const unconfirmedCleanup = useRef<PrivateContentCleanupError | null>(null);

  async function closeOwned() {
    const errors: unknown[] = [];
    for (const runtime of owned.current) {
      try {
        await runtime.close();
        owned.current.delete(runtime);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) unconfirmedCleanup.current = new PrivateContentCleanupError(errors);
    if (unconfirmedCleanup.current) throw unconfirmedCleanup.current;
  }
  function retireOwned() {
    // Revoke an already-open runtime now, before a retained UI callback can run.
    // The queue still drains a pending opening and any runtime it returns late.
    const closing = closeOwned();
    void closing.catch(() => undefined);
    const retired = queue.current
      .catch(() => undefined)
      .then(() => closing)
      .then(closeOwned);
    queue.current = retired;
    return retired;
  }
  useEffect(() => {
    mounted.current = true;
    exiting.current = false;
    const ticket = ++generation.current;
    const current = () => mounted.current && generation.current === ticket;
    setState({ kind: 'opening' });
    // Even a cancelled opening must finish and close before another opening can start.
    const work = queue.current
      .catch(() => undefined)
      .then(async () => {
        await closeOwned();
        if (!current()) return;
        let runtime: PrivateContentRuntime;
        try {
          runtime = await open();
        } catch (error) {
          if (error instanceof PrivateContentCleanupError) unconfirmedCleanup.current = error;
          throw error;
        }
        owned.current.add(runtime);
        if (!current()) {
          await closeOwned();
          return;
        }
        setState({ kind: 'ready', runtime, opener: open });
      });
    queue.current = work;
    void work.catch(() => {
      if (current()) setState({ kind: unconfirmedCleanup.current ? 'cleanup_blocked' : 'failed' });
    });
    return () => {
      mounted.current = false;
      generation.current++;
      retireOwned();
      // The opener also owns retirement failures across a complete React unmount.
      void queue.current.catch(() => undefined);
    };
  }, [open, attempt]);

  function exit() {
    if (unconfirmedCleanup.current) {
      setState({ kind: 'cleanup_blocked' });
      return;
    }
    if (exiting.current) return;
    exiting.current = true;
    const ticket = ++generation.current;
    setState({ kind: 'closing' });
    const work = retireOwned();
    void work.then(
      () => {
        if (mounted.current && generation.current === ticket) onExit();
      },
      () => {
        if (mounted.current && generation.current === ticket) {
          exiting.current = false;
          setState({ kind: 'cleanup_blocked' });
        }
      },
    );
  }
  if (state.kind === 'ready' && state.opener === open)
    return renderWorkspace ? (
      renderWorkspace(state.runtime, exit)
    ) : (
      <BorrowedContentUpdates runtime={state.runtime} onExit={exit} />
    );
  return (
    <Page bottomInset>
      <AppText role="title">Private content review workspace</AppText>
      <Notice
        title={
          state.kind === 'cleanup_blocked'
            ? 'Workspace cleanup is unconfirmed'
            : state.kind === 'failed'
              ? 'Workspace could not open'
              : state.kind === 'closing'
                ? 'Closing private workspace…'
                : 'Opening private workspace…'
        }
        tone={state.kind === 'failed' || state.kind === 'cleanup_blocked' ? 'caution' : 'neutral'}
      >
        <AppText>
          {state.kind === 'cleanup_blocked'
            ? 'Some private resources could not be closed. Reload this private review page before trying again. No successful close or exit is being claimed, and another workspace will not open here.'
            : 'This separate workspace does not migrate or replace your usual saved cooking.'}
        </AppText>
      </Notice>
      {state.kind === 'failed' && (
        <ActionButton label="Try opening again" onPress={() => setAttempt((value) => value + 1)} />
      )}
      {state.kind !== 'cleanup_blocked' && (
        <ActionButton
          label="Exit private workspace"
          variant="secondary"
          busy={state.kind === 'closing'}
          onPress={exit}
        />
      )}
    </Page>
  );
}

export function BorrowedContentUpdates({
  runtime,
  onExit,
}: {
  runtime: PrivateContentRuntime;
  onExit(): void;
}) {
  const host = runtime.host;
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function recoverOrAcknowledge() {
    if (working.current || !active.current) return;
    const current = host.getSnapshot();
    if (current.status !== state.status || current.pending !== state.pending) return;
    working.current = true;
    setBusy(true);
    setError(false);
    try {
      if (current.status === 'recovery_required') await host.recoverUpdate();
      else if (current.status === 'result_ready') await host.acknowledgeUpdate();
    } catch {
      if (active.current) setError(true);
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }
  if (state.status === 'ready')
    return (
      <ReadyWorkspace
        key={state.scopeKey}
        runtime={runtime}
        scopeKey={state.scopeKey}
        onExit={onExit}
      />
    );
  return (
    <Page bottomInset>
      <AppText role="title">Private content review workspace</AppText>
      <Notice
        title={
          state.status === 'result_ready'
            ? 'Saved update verified'
            : state.status === 'recovery_required'
              ? 'Check the saved update'
              : state.status === 'updating'
                ? 'Checking recipe content…'
                : 'Private workspace closed'
        }
      >
        <AppText>
          {state.status === 'result_ready'
            ? state.pending?.kind === 'activation'
              ? 'The release is verified in the content store. Adoption is a separate review; saved meal versions have not been replaced.'
              : 'The reviewed adoption is saved. Continue to read the adopted recipes.'
            : state.status === 'recovery_required'
              ? 'Check the original saved receipt. This does not resend or repeat the update.'
              : 'Recipe reading is unavailable until the workspace is ready.'}
        </AppText>
      </Notice>
      {(state.status === 'result_ready' || state.status === 'recovery_required') && (
        <ActionButton
          label={state.status === 'result_ready' ? 'Continue' : 'Check saved result'}
          busy={busy}
          onPress={() => void recoverOrAcknowledge()}
        />
      )}
      {error && (
        <AppText role="support">
          The saved result could not be confirmed. Its recovery identity is retained.
        </AppText>
      )}
      <ActionButton label="Exit private workspace" variant="secondary" onPress={onExit} />
    </Page>
  );
}

type Discovery = Awaited<ReturnType<ContentWorkspaceHost['content']['discover']>>;
function ReviewList<T>({
  label,
  items,
  renderItem,
}: {
  label: string;
  items: readonly T[];
  renderItem(item: T): ReactNode;
}) {
  const [page, setPage] = useState(0);
  const t = useTheme();
  if (!items.length) return null;
  return (
    <View style={{ gap: t.space.sm }}>
      <AppText role="bodyStrong">{label}</AppText>
      <AppText role="support">
        Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, items.length)} of{' '}
        {items.length}
      </AppText>
      {items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => (
        <View key={page * PAGE_SIZE + index} style={{ gap: t.space.xxs }}>
          {renderItem(item)}
        </View>
      ))}
      {page > 0 && (
        <ActionButton
          label={`Previous ${label.toLowerCase()}`}
          variant="quiet"
          onPress={() => setPage((value) => value - 1)}
        />
      )}
      {(page + 1) * PAGE_SIZE < items.length && (
        <ActionButton
          label={`More ${label.toLowerCase()}`}
          variant="quiet"
          onPress={() => setPage((value) => value + 1)}
        />
      )}
    </View>
  );
}
function ExactIdentity({ contentRef }: { contentRef: Immutable<RecipeContentRef> }) {
  return (
    <>
      <AppText style={{ flexShrink: 1, maxWidth: '100%' }}>
        Recipe {contentRef.recipeId} · revision {contentRef.revisionId}
      </AppText>
      <AppText role="support" style={{ flexShrink: 1, maxWidth: '100%' }}>
        Content fingerprint: {contentRef.contentFingerprint}
      </AppText>
    </>
  );
}
function ReadyWorkspace({
  runtime,
  scopeKey,
  onExit,
}: {
  runtime: PrivateContentRuntime;
  scopeKey: string;
  onExit(): void;
}) {
  const host = runtime.host;
  const t = useTheme();
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [stage, setStage] = useState<Immutable<ContentReleaseStage> | null>(null);
  const [stageInspected, setStageInspected] = useState(false);
  const [stageReadFailed, setStageReadFailed] = useState(false);
  const [stageReadAttempt, setStageReadAttempt] = useState(0);
  const [release, setRelease] = useState<Immutable<ContentReleaseReview> | null>(null);
  const [adoption, setAdoption] = useState<Immutable<ContentAdoptionReview> | null>(null);
  const [mealPage, setMealPage] = useState<Immutable<ContentAdoptionMealChoices> | null>(null);
  const [reviewedMeals, setReviewedMeals] = useState<
    readonly Immutable<ContentAdoptionMealChoice>[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true),
    working = useRef(false);
  const shown = useRef({ release, adoption, mealPage });
  shown.current = { release, adoption, mealPage };
  function current() {
    const state = host.getSnapshot();
    return active.current && state.status === 'ready' && state.scopeKey === scopeKey;
  }
  function check() {
    if (!current()) throw new Error('Private workspace changed');
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setDiscovery(null);
    setDiscoveryFailed(false);
    void host.content.discover().then(
      (result) => {
        if (live && current()) setDiscovery(result);
      },
      () => {
        if (live && current()) setDiscoveryFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [host, loadAttempt]);
  useEffect(() => {
    let live = true;
    setStageInspected(false);
    setStageReadFailed(false);
    void host.delivery.readStage().then(
      (retained) => {
        if (live && current()) {
          setStage(retained);
          setStageInspected(true);
        }
      },
      () => {
        if (live && current()) setStageReadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [host, stageReadAttempt]);
  async function perform(work: () => Promise<void>) {
    if (working.current || !current()) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      if (current())
        setError(
          'This step could not be completed. No adoption is assumed; review again or check saved recovery.',
        );
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  }
  async function fetchAndReview() {
    const input = await runtime.fetchRelease();
    check();
    const saved = await host.delivery.stage(input);
    check();
    setStage(saved);
    const reviewed = await host.delivery.review(saved.stageId);
    check();
    setRelease(reviewed);
  }
  if (selected !== null)
    return (
      <View style={{ flex: 1 }}>
        <AppText role="support" style={{ padding: t.space.sm }}>
          Private content review workspace
        </AppText>
        <ContentWorkspaceReader
          host={host}
          target={{ kind: 'current', recipeId: selected }}
          onBack={() => setSelected(null)}
        />
      </View>
    );
  const recipes = discovery?.value ?? [];
  const affectedGroups =
    adoption?.shopping.groups.filter(
      (group) =>
        group.changed ||
        group.previousQuantity !== group.quantity ||
        group.previousPurchased !== group.purchased,
    ) ?? [];
  return (
    <Page bottomInset>
      <View style={{ gap: t.space.md }}>
        <AppText role="title">Private content review workspace</AppText>
        <AppText role="support">
          Separate prepared workspace. Your usual saved cooking is unchanged. This is not cloud sync
          or native-device acceptance.
        </AppText>
        <ActionButton label="Exit private workspace" variant="quiet" onPress={onExit} />
        {host.getSnapshot().cleanupPending > 0 && (
          <Notice title="Photo cleanup needs another attempt" tone="caution">
            <ActionButton
              label="Retry photo cleanup"
              variant="secondary"
              onPress={() => host.retryPhotoCleanup()}
            />
          </Notice>
        )}
        {error && (
          <Notice title="Review unavailable" tone="caution">
            <AppText>{error}</AppText>
          </Notice>
        )}
        <AppText role="section">Recipe content updates</AppText>
        {!stageInspected && (
          <Notice
            title={
              stageReadFailed ? 'Saved release review unavailable' : 'Checking staged release…'
            }
            tone={stageReadFailed ? 'caution' : 'neutral'}
          >
            <AppText>
              New fetch and adoption stay unavailable until the saved stage has been checked. No
              release is activated by this check.
            </AppText>
            {stageReadFailed && (
              <ActionButton
                label="Retry saved stage check"
                variant="secondary"
                onPress={() => setStageReadAttempt((value) => value + 1)}
              />
            )}
          </Notice>
        )}
        {stageInspected && !stage && !adoption && !mealPage && (
          <ActionButton
            label="Fetch release for review"
            busy={busy}
            onPress={() => void perform(fetchAndReview)}
          />
        )}
        {stage && (
          <Notice title={release ? 'Review verified release' : 'Staged release needs review'}>
            <AppText>
              {stage.publicationCount} new publications; {stage.mediaBytes} media bytes.
            </AppText>
            {release && (
              <>
                <AppText>
                  Release {release.head.releaseId}, sequence {release.head.sequence}.{' '}
                  {release.retainedRefCount} saved references checked.
                </AppText>
                <AppText>
                  {release.manifest.entries.filter((entry) => entry.state === 'archived').length}{' '}
                  archived entries;{' '}
                  {release.manifest.entries.filter((entry) => entry.state === 'withdrawn').length}{' '}
                  withdrawn entries.
                </AppText>
                <AppText>
                  Activation verifies the cache without replacing saved meal versions. New
                  withdrawal restrictions apply immediately, before adoption.
                </AppText>
                <ReviewList
                  key={release.packageFingerprint}
                  label="Release entries"
                  items={release.manifest.entries}
                  renderItem={(entry) => (
                    <>
                      <AppText role="bodyStrong">
                        {entry.state === 'current'
                          ? 'Current'
                          : entry.state === 'archived'
                            ? 'Archived'
                            : 'Withdrawn'}
                      </AppText>
                      {entry.state === 'withdrawn' ? (
                        <AppText>Recipe {entry.recipeId}</AppText>
                      ) : (
                        <ExactIdentity contentRef={entry.ref} />
                      )}
                      {entry.state !== 'current' && <AppText>{entry.reason}</AppText>}
                    </>
                  )}
                />
                <ActionButton
                  label="Activate verified release"
                  busy={busy}
                  onPress={() =>
                    void perform(async () => {
                      if (shown.current.release !== release) return;
                      await host.delivery.activate(release);
                    })
                  }
                />
              </>
            )}
            {!release && (
              <ActionButton
                label="Review staged release"
                busy={busy}
                onPress={() =>
                  void perform(async () => {
                    const reviewed = await host.delivery.review(stage.stageId);
                    check();
                    setRelease(reviewed);
                  })
                }
              />
            )}
            <ActionButton
              label="Discard staged release"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void perform(async () => {
                  await host.delivery.discardStage(
                    stage.stageId,
                    stage.packageFingerprint,
                    stage.stageEpoch,
                  );
                  check();
                  setRelease(null);
                  setStage(null);
                })
              }
            />
          </Notice>
        )}
        {stageInspected && !stage && !adoption && !mealPage && (
          <ActionButton
            label="Review adoption of verified release"
            variant="secondary"
            busy={busy}
            onPress={() =>
              void perform(async () => {
                if (shown.current.mealPage || shown.current.adoption) return;
                const latest = await host.delivery.hydrate();
                check();
                if (!latest.head) {
                  setError('There is no verified release to adopt.');
                  return;
                }
                const reviewed = await host.adoption.review({ candidateHead: latest.head });
                check();
                if (!adoptionMatchesMealChoices(reviewed, []))
                  throw new Error('Unexpected meal changes');
                setReviewedMeals([]);
                setAdoption(reviewed);
              })
            }
          />
        )}
        {stageInspected && !stage && !adoption && !mealPage && (
          <ActionButton
            label="Choose saved meal versions"
            variant="secondary"
            busy={busy}
            onPress={() =>
              void perform(async () => {
                if (shown.current.mealPage || shown.current.adoption) return;
                const latest = await host.delivery.hydrate();
                check();
                if (!latest.head) {
                  setError('There is no verified release to compare with saved meals.');
                  return;
                }
                const choices = await host.adoption.readMealChoices({ candidateHead: latest.head });
                check();
                setMealPage(choices);
              })
            }
          />
        )}
        {mealPage && (
          <ContentAdoptionMealChooser
            key={mealPage.contextFingerprint}
            host={host}
            initial={mealPage}
            isCurrent={() => current() && shown.current.mealPage === mealPage}
            onCancel={() => {
              if (!current() || shown.current.mealPage !== mealPage) return;
              shown.current.mealPage = null;
              setMealPage(null);
            }}
            onReviewed={(review, choices) => {
              if (!current() || shown.current.mealPage !== mealPage) return;
              shown.current.mealPage = null;
              setMealPage(null);
              setReviewedMeals(choices);
              setAdoption(review);
            }}
          />
        )}
        {adoption && (
          <Notice title="Review recipe adoption">
            <AppText>
              Release {adoption.candidateHead.releaseId}, sequence {adoption.candidateHead.sequence}
              .
            </AppText>
            <AppText>
              {adoption.preservedPlanCount} saved meal versions retained.{' '}
              {adoption.changes.length === 0
                ? 'No existing occurrence is changed by this review.'
                : `${adoption.changes.length} selected saved meals will use the explicitly reviewed versions below.`}
            </AppText>
            <ReviewList
              key={`meals:${adoption.requestFingerprint}`}
              label="Selected meal versions"
              items={reviewedMeals}
              renderItem={(choice) => (
                <>
                  <AppText role="bodyStrong">
                    {formatPlanDate(choice.occurrence.placement.actualDate)} ·{' '}
                    {mealLabel(choice.occurrence.placement.mealKey)}
                  </AppText>
                  <AppText>
                    Before: {choice.current.title ?? 'Saved recipe content unavailable'}
                  </AppText>
                  <ExactIdentity contentRef={choice.current.contentRef} />
                  <AppText>After: {choice.target?.title}</AppText>
                  {choice.target && <ExactIdentity contentRef={choice.target.contentRef} />}
                </>
              )}
            />
            <AppText>
              {adoption.unresolvedHistoryOrSessionCount} unresolved historical records;{' '}
              {adoption.withdrawnRefs.length} retained versions unavailable because of withdrawal.
            </AppText>
            <AppText>
              {adoption.shopping.selectedOccurrences} Shopping meals. {affectedGroups.length}{' '}
              affected groups;{' '}
              {
                adoption.shopping.groups.filter(
                  (group) => group.previousPurchased !== group.purchased,
                ).length
              }{' '}
              purchase marks change. {adoption.shopping.notices.length} source notices.
            </AppText>
            <ReviewList
              key={`withdrawn:${adoption.requestFingerprint}`}
              label="Unavailable saved versions"
              items={adoption.withdrawnRefs}
              renderItem={(ref) => <ExactIdentity contentRef={ref} />}
            />
            <ReviewList
              key={`groups:${adoption.requestFingerprint}`}
              label="Affected Shopping groups"
              items={affectedGroups}
              renderItem={(group) => (
                <>
                  <AppText role="bodyStrong">{group.displayName}</AppText>
                  <AppText>Before: {group.previousQuantity ?? 'Not on the active list'}</AppText>
                  <AppText>After: {group.quantity ?? 'Not on the active list'}</AppText>
                  <AppText>
                    Purchase mark: {group.previousPurchased ? 'checked' : 'unchecked'} →{' '}
                    {group.purchased ? 'checked' : 'unchecked'}
                  </AppText>
                </>
              )}
            />
            <ReviewList
              key={`notices:${adoption.requestFingerprint}`}
              label="Source notices"
              items={adoption.shopping.notices}
              renderItem={(notice) => (
                <>
                  <AppText>
                    Meal {notice.occurrenceId} ·{' '}
                    {notice.disposition === 'inherited_unresolved'
                      ? 'Unresolved inherited source notes'
                      : 'Exact revision source notes'}
                  </AppText>
                  <ExactIdentity contentRef={notice.contentRef} />
                  <ReviewList
                    label={`Annotations for meal ${notice.occurrenceId}`}
                    items={notice.annotations}
                    renderItem={(annotation) => (
                      <>
                        <AppText>{annotation.note}</AppText>
                        {annotation.evidence.map((location, index) => (
                          <AppText key={index} role="support">
                            {location.sheet}, row {location.row}
                            {location.column ? `, column ${location.column}` : ''}
                          </AppText>
                        ))}
                      </>
                    )}
                  />
                </>
              )}
            />
            <AppText>
              Adoption changes current discovery. Only the selected Plan meals change version. Other
              Plan, history and reading references stay pinned; withdrawn bodies remain unavailable.
            </AppText>
            <ActionButton
              label="Adopt reviewed release"
              busy={busy}
              disabled={!adoptionMatchesMealChoices(adoption, reviewedMeals)}
              onPress={() =>
                void perform(async () => {
                  if (
                    shown.current.adoption !== adoption ||
                    !adoptionMatchesMealChoices(adoption, reviewedMeals)
                  )
                    return;
                  await host.adoption.adopt(adoption);
                })
              }
            />
            <ActionButton
              label="Cancel adoption review"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                if (!current() || working.current || shown.current.adoption !== adoption) return;
                shown.current.adoption = null;
                setAdoption(null);
                setReviewedMeals([]);
              }}
            />
          </Notice>
        )}
        <AppText role="section">Recipes in this workspace</AppText>
        {discovery && (
          <AppText role="support">
            {discovery.head ? `Adopted release ${discovery.head.releaseId}` : 'Packaged baseline'} ·{' '}
            {recipes.length} recipes
          </AppText>
        )}
        {!discovery && (
          <AppText>
            {discoveryFailed
              ? 'Recipe discovery could not be verified.'
              : 'Reading verified recipes…'}
          </AppText>
        )}
        {discoveryFailed && (
          <ActionButton
            label="Retry recipe discovery"
            variant="secondary"
            onPress={() => setLoadAttempt((value) => value + 1)}
          />
        )}
        {discovery && recipes.length === 0 && (
          <AppText>No current recipes are available in this workspace.</AppText>
        )}
        {recipes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((recipe) => (
          <ActionButton
            key={recipe.recipeId}
            label={recipe.title}
            variant="secondary"
            disabled={busy || !!stage || !!adoption || !!mealPage}
            onPress={() => {
              if (current()) setSelected(recipe.recipeId);
            }}
          />
        ))}
        {page > 0 && (
          <ActionButton
            label="Previous recipes"
            variant="quiet"
            onPress={() => setPage((value) => value - 1)}
          />
        )}
        {(page + 1) * PAGE_SIZE < recipes.length && (
          <ActionButton
            label="More recipes"
            variant="quiet"
            onPress={() => setPage((value) => value + 1)}
          />
        )}
      </View>
    </Page>
  );
}
