import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  canonicalContentJson,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import type { RuntimeClock } from '../workspace/runtimeClock';
import { ContentCookingCompletion } from './ContentCookingCompletion';
import { ContentCookingRecovery } from './ContentCookingRecovery';
import { CookingReaderPresentation } from './CookingReaderPresentation';
import type { ContentCookingReaderHost } from './contentCookingPorts';
import { instructionSections } from './instructionSections';
import { useContentCookingProgress } from './useContentCookingProgress';
import { useContentCookingScope } from './useContentCookingScope';

export interface ContentCookingReaderProps {
  host: ContentCookingReaderHost;
  scopeKey: string;
  recipe: Immutable<ReadingRecipe>;
  clock: RuntimeClock;
  visible: boolean;
  onClose(): void;
  onDismiss(): void;
  onWatch?: () => void;
  onResumeRecipe(ref: RecipeContentRef): void;
  ingredients: ReactNode;
  ingredientNotes: ReactNode;
  sourceNotes: ReactNode;
  sourceNoteCount: number;
  fullInstructions: ReactNode;
  renderSection(passages: readonly Immutable<ReadingRecipe>['instructions'][number][]): ReactNode;
  sectionRoles?: readonly ('introduction' | 'procedure' | null)[];
}
export function ContentCookingReader(props: ContentCookingReaderProps) {
  const state = useSyncExternalStore(
    props.host.subscribe,
    props.host.getSnapshot,
    props.host.getSnapshot,
  );
  return state.status === 'ready' && state.scopeKey === props.scopeKey ? (
    <ExactReader key={canonicalContentJson([props.scopeKey, props.recipe.contentRef])} {...props} />
  ) : null;
}
function ExactReader({
  host,
  scopeKey,
  recipe,
  clock,
  visible,
  onClose,
  onDismiss,
  onWatch,
  onResumeRecipe,
  renderSection,
  sectionRoles,
  ...parts
}: ContentCookingReaderProps) {
  const pageCurrent = useContentCookingScope(host, scopeKey),
    isCurrent = useContentCookingScope(host, scopeKey, visible);
  const sections = useMemo(() => instructionSections(recipe), [recipe]);
  const [position, setPosition] = useState(0);
  const progress = useContentCookingProgress({
    host,
    recipe,
    sections,
    visible,
    isCurrent,
    onPosition: setPosition,
  });
  const saved = progress.view?.session;
  const feedback = (
    <>
      {progress.loading && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Loading saved reading position…
        </AppText>
      )}
      {progress.operation.busy && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Checking saved reading position…
        </AppText>
      )}
      {progress.different && (
        <Notice title="Saved progress belongs to another reading version" tone="caution">
          <AppText>
            The saved passage has not been applied to the displayed recipe. Resume its exact version
            when available, or explicitly restart this displayed version. Neither action marks it
            cooked.
          </AppText>
          {saved?.readerVersion === 2 &&
            progress.view?.resume === 'exact' &&
            progress.view.recipe && (
              <ActionButton
                label="Resume saved recipe version"
                variant="secondary"
                disabled={!progress.operation.ready}
                onPress={() => {
                  if (isCurrent()) onResumeRecipe(saved.contentRef);
                }}
              />
            )}
          <ActionButton
            label="Restart with displayed recipe"
            disabled={!progress.operation.ready || progress.loading}
            onPress={() => {
              if (isCurrent()) progress.restart();
            }}
          />
          {saved?.readerVersion === 2 && (
            <ActionButton
              label="Dismiss saved cooking progress"
              variant="quiet"
              disabled={!progress.operation.ready || progress.loading}
              onPress={() => {
                if (isCurrent()) progress.dismiss();
              }}
            />
          )}
        </Notice>
      )}
      {progress.error && (
        <Notice title="Reading progress needs attention" tone="caution">
          {progress.error}
          <ActionButton
            label="Reload saved reading position"
            variant="quiet"
            disabled={progress.operation.busy || progress.loading}
            onPress={() => {
              if (isCurrent()) void progress.reload();
            }}
          />
        </Notice>
      )}
      <ContentCookingRecovery
        host={host}
        operations={progress.operation}
        isCurrent={isCurrent}
        onConfirmed={progress.reload}
      />
    </>
  );
  return (
    <CookingReaderPresentation
      {...parts}
      title={recipe.title}
      visible={visible}
      onClose={() => {
        if (isCurrent()) onClose();
      }}
      onDismiss={() => {
        if (pageCurrent()) onDismiss();
      }}
      {...(onWatch
        ? {
            onWatch: () => {
              if (isCurrent()) onWatch();
            },
          }
        : {})}
      sections={sections.map((section, index) => ({
        content: renderSection(section),
        role: sectionRoles?.[index] ?? null,
      }))}
      position={position}
      passageDescription="Recipe passages in their supplied order. Original quantities are unchanged."
      onMove={(next) => {
        if (!isCurrent() || !progress.move(next)) return false;
        setPosition(next);
        return true;
      }}
      progress={{
        ready: progress.ready,
        saving: progress.operation.busy,
        hasActiveSession: progress.hasActiveSession,
        feedback,
        onRestart: () => {
          if (isCurrent()) progress.restart();
        },
        onDismiss: () => {
          if (isCurrent()) progress.dismiss();
        },
      }}
      completion={(finishing, onCancel) => (
        <ContentCookingCompletion
          host={host}
          scopeKey={scopeKey}
          recipe={recipe}
          clock={clock}
          visible={visible && finishing}
          isCurrent={isCurrent}
          onCancel={() => {
            if (isCurrent()) onCancel();
          }}
          onCompleted={progress.reload}
        />
      )}
    />
  );
}
