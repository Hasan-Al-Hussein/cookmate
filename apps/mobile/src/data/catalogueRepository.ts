import { validateRecipe } from '@cookmate/contracts';
import type {
  IngredientEntry,
  InstructionPassage,
  QualityAnnotation,
  Recipe,
  SourceLocator,
} from '@cookmate/contracts';
import type { Immutable, RepositoryResult } from '@cookmate/domain';
import { readSnapshot } from './query';
import { StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';

interface IngredientRow {
  recipeId: string;
  position: number;
  rawName: string;
  rawMeasure: string | null;
  row: number;
  column: string;
}
interface InstructionRow {
  recipeId: string;
  sequence: number;
  rawText: string;
  presentation: 'heading' | 'passage';
  row: number;
  column: string;
}
interface EvidenceRow {
  annotationId: string;
  sheet: SourceLocator['sheet'];
  row: number;
  column: string | null;
}

export async function readRecipeInSnapshot(
  session: SqlSession,
  recipeId: string,
): Promise<Recipe | null> {
  const row = (
    await session.all<Omit<Recipe, 'ingredients' | 'instructions' | 'annotations'>>(
      'SELECT recipe_id AS recipeId, title, category, cuisine, raw_tags AS rawTags, photo_key AS photoKey, recipe_page AS recipePage, original_source_url AS originalSourceUrl, video_url AS videoUrl FROM recipe WHERE recipe_id = ?',
      [recipeId],
    )
  )[0];
  if (!row) return null;
  const ingredientRows = await session.all<IngredientRow>(
    'SELECT recipe_id AS recipeId, position, raw_name AS rawName, raw_measure AS rawMeasure, source_row AS row, source_column AS column FROM ingredient_entry WHERE recipe_id = ? ORDER BY position',
    [recipeId],
  );
  const instructionRows = await session.all<InstructionRow>(
    'SELECT recipe_id AS recipeId, sequence, raw_text AS rawText, presentation, source_row AS row, source_column AS column FROM instruction_passage WHERE recipe_id = ? ORDER BY sequence',
    [recipeId],
  );
  const annotations = await session.all<Omit<QualityAnnotation, 'evidence'>>(
    'SELECT recipe_id AS recipeId, annotation_id AS annotationId, kind, note, rule_version AS ruleVersion FROM quality_annotation WHERE recipe_id = ? ORDER BY ordinal',
    [recipeId],
  );
  const evidence = await session.all<EvidenceRow>(
    'SELECT annotation_id AS annotationId, sheet, source_row AS row, source_column AS column FROM annotation_evidence WHERE recipe_id = ? ORDER BY annotation_id, ordinal',
    [recipeId],
  );
  const ingredients: IngredientEntry[] = ingredientRows.map(
    ({ row: sourceRow, column, ...entry }) => ({
      ...entry,
      source: { sheet: 'Ingredients', row: sourceRow, column },
    }),
  );
  const instructions: InstructionPassage[] = instructionRows.map(
    ({ row: sourceRow, column, ...entry }) => ({
      ...entry,
      source: { sheet: 'Instructions', row: sourceRow, column },
    }),
  );
  const recipe = {
    ...row,
    ingredients,
    instructions,
    annotations: annotations.map((annotation) => ({
      ...annotation,
      evidence: evidence
        .filter((item) => item.annotationId === annotation.annotationId)
        .map(({ annotationId: _annotationId, column, ...locator }) => ({
          ...locator,
          ...(column === null ? {} : { column }),
        })),
    })),
  };
  if (
    !validateRecipe(recipe) ||
    recipe.ingredients.some((entry, index) => entry.position !== index + 1) ||
    recipe.instructions.some((entry, index) => entry.sequence !== index + 1)
  )
    throw new StorageFault('storage_failure', 'Stored recipe is invalid');
  return recipe;
}

/** Reader transactions share one queue, preventing concurrent snapshot BEGIN/COMMIT interleaving. */
export function createCatalogueRepository(reader: SerializedReader) {
  return Object.freeze({
    async readRecipe(recipeId: string): Promise<RepositoryResult<Immutable<Recipe> | null>> {
      return readSnapshot(reader, (session) => readRecipeInSnapshot(session, recipeId));
    },
  });
}
