import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Platform, View } from 'react-native';
import type { Immutable } from '@cookmate/catalogue';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type {
  ContentAdoptionMealChoice,
  ContentAdoptionMealChoices,
  ContentAdoptionReview,
} from '../../data/contentAdoption';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useTheme } from '../../design/ThemeProvider';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import type { ContentWorkspaceHost } from './contentWorkspaceHost';

// Matches the adoption service's bounded change set; the backend enforces this independently.
const SELECTION_LIMIT = 1000;
function sameRef(a: Immutable<RecipeContentRef>, b: Immutable<RecipeContentRef>) {
  return (
    a.recipeId === b.recipeId &&
    a.revisionId === b.revisionId &&
    a.contentFingerprint === b.contentFingerprint
  );
}
export function adoptionMatchesMealChoices(
  review: Immutable<ContentAdoptionReview>,
  choices: readonly Immutable<ContentAdoptionMealChoice>[],
) {
  return (
    review.changes.length === choices.length &&
    review.changes.every((change, index) => {
      const choice = choices[index];
      return (
        !!choice?.target &&
        change.occurrenceId === choice.occurrence.occurrenceId &&
        sameRef(change.expectedRef, choice.current.contentRef) &&
        sameRef(change.targetRef, choice.target.contentRef)
      );
    })
  );
}

export function ContentAdoptionMealChooser({
  host,
  initial,
  isCurrent,
  onCancel,
  onReviewed,
}: {
  host: Pick<ContentWorkspaceHost, 'adoption'>;
  initial: Immutable<ContentAdoptionMealChoices>;
  isCurrent(): boolean;
  onCancel(): void;
  onReviewed(
    review: Immutable<ContentAdoptionReview>,
    choices: readonly Immutable<ContentAdoptionMealChoice>[],
  ): void;
}) {
  const t = useTheme();
  const [page, setPage] = useState(initial);
  const [selected, setSelected] = useState<readonly Immutable<ContentAdoptionMealChoice>[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true),
    working = useRef(false),
    invalid = useRef(false);
  const shown = useRef({ page, selected });
  shown.current = { page, selected };
  const live = useRef(isCurrent);
  live.current = isCurrent;
  function current() {
    return active.current && live.current();
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function perform(work: () => Promise<void>) {
    if (!current() || working.current || invalid.current) return;
    working.current = true;
    setBusy(true);
    try {
      await work();
    } catch {
      if (current()) {
        invalid.current = true;
        setFailed(true);
      }
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  }
  function load(offset: number) {
    if (shown.current.page !== page) return;
    void perform(async () => {
      const next = await host.adoption.readMealChoices({
        candidateHead: initial.candidateHead,
        offset,
        expectedContextFingerprint: initial.contextFingerprint,
      });
      if (!current()) return;
      if (next.contextFingerprint !== initial.contextFingerprint)
        throw new Error('Meal choices changed');
      setPage(next);
    });
  }
  return (
    <Notice title="Choose saved meal versions">
      <AppText>
        Saved meals keep their exact versions by default. Selecting a meal only prepares a new
        consequence review.
      </AppText>
      <AppText role="support">
        {selected.length} selected (maximum {SELECTION_LIMIT}). Release{' '}
        {initial.candidateHead.releaseId}, sequence {initial.candidateHead.sequence}.
      </AppText>
      {failed ? (
        <Notice title="Saved meals changed or could not be checked" tone="caution">
          <AppText>
            Close this selection and reopen it to review current meals. Nothing is adopted by these
            selections.
          </AppText>
        </Notice>
      ) : (
        <>
          {page.total === 0 ? (
            <AppText>No saved meals are available to change.</AppText>
          ) : (
            <AppText role="support">
              Showing {page.offset + 1}–{page.offset + page.items.length} of {page.total} saved
              meals
            </AppText>
          )}
          {page.items.map((choice) => {
            const id = choice.occurrence.occurrenceId;
            const checked = selected.some((item) => item.occurrence.occurrenceId === id);
            const disabled = busy || (!checked && selected.length >= SELECTION_LIMIT);
            function toggle() {
              if (
                !current() ||
                disabled ||
                working.current ||
                invalid.current ||
                shown.current.page !== page ||
                shown.current.selected !== selected
              )
                return;
              const next = checked
                ? selected.filter((item) => item.occurrence.occurrenceId !== id)
                : [...selected, choice];
              shown.current.selected = next;
              setSelected(next);
            }
            const label = `${formatPlanDate(choice.occurrence.placement.actualDate)} · ${mealLabel(choice.occurrence.placement.mealKey)}`;
            return (
              <View key={id} style={{ gap: t.space.xs, minWidth: 0 }}>
                <AppText role="bodyStrong">{label}</AppText>
                <AppText>
                  Saved: {choice.current.title ?? 'Saved recipe content unavailable'}
                </AppText>
                <AppText role="support" style={{ flexShrink: 1, maxWidth: '100%' }}>
                  Saved revision: {choice.current.contentRef.revisionId}
                </AppText>
                {choice.target ? (
                  <>
                    <AppText>Proposed: {choice.target.title}</AppText>
                    <AppText role="support" style={{ flexShrink: 1, maxWidth: '100%' }}>
                      Proposed revision: {choice.target.contentRef.revisionId}
                    </AppText>
                    <ActionButton
                      label={`Use proposed version for ${label}`}
                      variant={checked ? 'primary' : 'secondary'}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      disabled={disabled}
                      onPress={toggle}
                      {...(Platform.OS === 'web'
                        ? {
                            // RN Web handles Enter, but Space needs a fallback for checkbox roles.
                            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
                              if (event.key !== ' ' && event.key !== 'Spacebar') return;
                              event.preventDefault();
                              if (!event.repeat) toggle();
                            },
                          }
                        : {})}
                    />
                  </>
                ) : (
                  <AppText role="support">
                    Keep this saved version. No different current version is available for
                    selection.
                  </AppText>
                )}
              </View>
            );
          })}
          {page.offset > 0 && (
            <ActionButton
              label="Previous saved meals"
              variant="quiet"
              disabled={busy}
              onPress={() => load(Math.max(0, page.offset - 20))}
            />
          )}
          {page.nextOffset !== null && (
            <ActionButton
              label="More saved meals"
              variant="quiet"
              disabled={busy}
              onPress={() => load(page.nextOffset!)}
            />
          )}
          <ActionButton
            label="Review selected meal changes"
            busy={busy}
            disabled={selected.length === 0}
            onPress={() => {
              if (shown.current.selected !== selected || shown.current.page !== page) return;
              void perform(async () => {
                const changes = selected.map((choice) => {
                  if (!choice.target) throw new Error('Missing proposed version');
                  return {
                    occurrenceId: choice.occurrence.occurrenceId,
                    expectedRef: choice.current.contentRef,
                    targetRef: choice.target.contentRef,
                  };
                });
                const review = await host.adoption.review(
                  { candidateHead: initial.candidateHead, changes },
                  initial.contextFingerprint,
                );
                if (!current()) return;
                if (!adoptionMatchesMealChoices(review, selected))
                  throw new Error('Unexpected meal changes');
                onReviewed(review, selected);
              });
            }}
          />
        </>
      )}
      <ActionButton
        label="Cancel meal selection"
        variant="secondary"
        disabled={busy}
        onPress={() => {
          if (!current() || working.current) return;
          active.current = false;
          onCancel();
        }}
      />
    </Notice>
  );
}
