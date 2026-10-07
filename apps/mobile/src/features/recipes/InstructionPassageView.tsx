import {
  catalogue,
  getReviewedBundledInstructionRoles,
  type CatalogueRecipe,
} from '@cookmate/catalogue';
import { StyleSheet, View } from 'react-native';
import { Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import {
  getPassageSourceNotes,
  getUnplacedInstructionNotes,
  getInstructionNotesNeedingMappingReview,
  type SourceInstruction,
} from './instructionSourceNotes';

function SourceNotes({
  notes,
  mappingReviewIds = [],
}: {
  notes: CatalogueRecipe['annotations'];
  mappingReviewIds?: readonly string[];
}) {
  if (!notes.length) return null;
  return (
    <Notice title="Recipe source notes" tone="caution">
      {notes.map((note) => (
        <View key={note.annotationId}>
          <AppText role="support">{note.note}</AppText>
          {mappingReviewIds.includes(note.annotationId) && (
            <AppText role="support">
              Passage association needs editorial review. This note is kept here in full.
            </AppText>
          )}
        </View>
      ))}
    </Notice>
  );
}

export function UnplacedInstructionNotes({ recipe }: { recipe: CatalogueRecipe }) {
  return (
    <SourceNotes
      notes={getUnplacedInstructionNotes(recipe)}
      mappingReviewIds={getInstructionNotesNeedingMappingReview(recipe).map(
        (note) => note.annotationId,
      )}
    />
  );
}

export function InstructionPassageView({
  recipe,
  passage,
  large = false,
  showRoleLabel = true,
}: {
  recipe: CatalogueRecipe;
  passage: SourceInstruction;
  large?: boolean;
  showRoleLabel?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const roles = showRoleLabel ? getReviewedBundledInstructionRoles(recipe, catalogue.identity) : [];
  const role = recipe.instructions.includes(passage)
    ? roles.find((entry) => entry.sequence === passage.sequence)?.role
    : undefined;
  const procedural = roles.filter((entry) => entry.role === 'procedure');
  const procedureIndex = procedural.findIndex((entry) => entry.sequence === passage.sequence);
  return (
    <View style={styles.passage}>
      {role && (
        <AppText role="bodyStrong" accessibilityRole="header">
          {role === 'introduction'
            ? 'About this recipe'
            : `Cooking passage ${procedureIndex + 1} of ${procedural.length}`}
        </AppText>
      )}
      <SourceNotes notes={getPassageSourceNotes(recipe, passage)} />
      <AppText
        role={passage.presentation === 'heading' ? 'bodyStrong' : 'body'}
        accessibilityRole={passage.presentation === 'heading' ? 'header' : 'text'}
        style={[
          styles.text,
          passage.presentation === 'heading' && styles.heading,
          large && styles.large,
        ]}
      >
        {passage.rawText}
      </AppText>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    passage: { gap: t.space.sm },
    text: { fontSize: 17, lineHeight: 26 },
    heading: { fontSize: 18, lineHeight: 27, paddingTop: t.space.xs },
    large: { fontSize: 22, lineHeight: 34 },
  });
