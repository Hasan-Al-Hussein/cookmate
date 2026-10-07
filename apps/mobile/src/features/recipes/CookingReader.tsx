import { useMemo, useState, type ReactNode } from 'react';
import {
  catalogue,
  getReviewedBundledInstructionRoles,
  type CatalogueRecipe,
} from '@cookmate/catalogue';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { instructionSections } from '../cooking/instructionSections';
import { useCookingProgress } from '../cooking/useCookingProgress';
import { CookingCompletion } from '../cooking/CookingCompletion';
import { CookingReaderPresentation } from '../cooking/CookingReaderPresentation';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { InstructionPassageView, UnplacedInstructionNotes } from './InstructionPassageView';
const readingPositions = new Map<string, number>();
type CookingReaderProps = {
  recipe: CatalogueRecipe;
  visible: boolean;
  onClose(): void;
  onDismiss(): void;
  onWatch?: () => void;
  ingredients: ReactNode;
  ingredientNotes: ReactNode;
  sourceNotes: ReactNode;
  fullInstructions: ReactNode;
};
export function CookingReader(props: CookingReaderProps) {
  return <RecipeReader key={props.recipe.recipeId} {...props} />;
}
function RecipeReader({ recipe, ...props }: CookingReaderProps) {
  const sections = useMemo(() => instructionSections(recipe), [recipe]);
  const roles = useMemo(
    () => getReviewedBundledInstructionRoles(recipe, catalogue.identity),
    [recipe],
  );
  const [position, setPosition] = useState(() =>
    Math.min(readingPositions.get(recipe.recipeId) ?? 0, Math.max(0, sections.length - 1)),
  );
  const { availability, clock } = useWorkspace();
  const service = availability.kind === 'ready' ? availability.services.cooking : undefined;
  const progress = useCookingProgress({
    service,
    recipeId: recipe.recipeId,
    sections,
    visible: props.visible,
    onPosition: setPosition,
  });
  const feedback = (
    <>
      {progress.loading && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Loading saved reading position…
        </AppText>
      )}
      {progress.saving && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Saving reading position…
        </AppText>
      )}
      {progress.changed && (
        <Notice title="The recipe has changed" tone="caution">
          <AppText>
            The saved section belongs to different recipe content. Read the current source before
            choosing whether to restart or discard the old progress.
          </AppText>
          <ActionButton
            label="Restart with current recipe"
            disabled={progress.saving || progress.loading || !!progress.uncertain}
            onPress={() => void progress.restart()}
          />
          <ActionButton
            label="Dismiss saved cooking progress"
            variant="quiet"
            disabled={progress.saving || progress.loading || !!progress.uncertain}
            onPress={() => void progress.dismiss()}
          />
        </Notice>
      )}
      {progress.error && (
        <Notice title="Reading progress needs attention" tone="caution">
          <AppText>{progress.error}</AppText>
          {progress.uncertain && (
            <AppText role="support" selectable>
              Operation ID: {progress.uncertain}
            </AppText>
          )}
          <ActionButton
            label={
              progress.uncertain ? 'Check saved reading position' : 'Reload saved reading position'
            }
            variant="quiet"
            disabled={progress.saving || progress.loading}
            onPress={() => void progress.reload()}
          />
        </Notice>
      )}
    </>
  );
  return (
    <CookingReaderPresentation
      {...props}
      title={recipe.title}
      sourceNoteCount={recipe.annotations.length}
      position={position}
      sections={sections.map((section) => {
        const role = roles.find((entry) => entry.sequence === section[0]?.sequence)?.role;
        return {
          role:
            role &&
            section.every((passage) =>
              roles.some((entry) => entry.sequence === passage.sequence && entry.role === role),
            )
              ? role
              : null,
          content: (
            <>
              <UnplacedInstructionNotes recipe={recipe} />
              {section.map((passage) => (
                <InstructionPassageView
                  key={passage.sequence}
                  recipe={recipe}
                  passage={passage}
                  showRoleLabel={false}
                  large
                />
              ))}
            </>
          ),
        };
      })}
      onMove={(next) => {
        if (service && !progress.move(next)) return false;
        readingPositions.set(recipe.recipeId, next);
        setPosition(next);
        return true;
      }}
      {...(service
        ? {
            progress: {
              ready: progress.ready,
              saving: progress.saving,
              hasActiveSession: !progress.changed && progress.view?.session?.state === 'active',
              feedback,
              onRestart: () => void progress.restart(),
              onDismiss: () => void progress.dismiss(),
            },
          }
        : {})}
      {...(service && progress.view && availability.kind === 'ready'
        ? {
            completion: (visible: boolean, onCancel: () => void) => (
              <CookingCompletion
                visible={visible}
                service={service}
                readInstallationId={availability.services.queries.readInstallationId}
                sessionView={progress.view!}
                title={recipe.title}
                clock={clock}
                onCancel={onCancel}
                onCompleted={progress.acceptCompleted}
              />
            ),
          }
        : {})}
    />
  );
}
