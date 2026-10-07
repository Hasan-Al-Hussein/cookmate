import type { CatalogueIdentity } from '@cookmate/contracts';
import reviewed from '../reviewed-instruction-roles.json';
import type { CatalogueRecipe } from './catalogue';

export interface ReviewedInstructionRole {
  readonly sequence: number;
  readonly role: 'introduction' | 'procedure';
}

/** Only the exact packaged revision is covered; published revisions need their own review. */
export function getReviewedBundledInstructionRoles(
  recipe: CatalogueRecipe,
  currentCatalogue: CatalogueIdentity,
): readonly ReviewedInstructionRole[] {
  if (
    currentCatalogue.version !== reviewed.catalogue.version ||
    currentCatalogue.fingerprint !== reviewed.catalogue.fingerprint ||
    `bundled:${currentCatalogue.fingerprint}` !== reviewed.revisionId
  )
    return [];
  const matches = reviewed.recipes.filter((entry) => entry.recipeId === recipe.recipeId);
  if (matches.length !== 1) return [];
  const entries = matches[0]!.passages;
  // An incomplete or stale mapping stays neutral, including its procedural numbering.
  if (
    entries.length !== recipe.instructions.length ||
    new Set(entries.map((entry) => entry.sequence)).size !== entries.length ||
    !entries.every((entry, index) => {
      const passage = recipe.instructions[index];
      return (
        (entry.role === 'introduction' || entry.role === 'procedure') &&
        passage?.recipeId === recipe.recipeId &&
        passage.sequence === entry.sequence &&
        passage.presentation === 'passage' &&
        passage.rawText === entry.rawText &&
        passage.source.sheet === entry.source.sheet &&
        passage.source.row === entry.source.row &&
        passage.source.column === entry.source.column
      );
    })
  )
    return [];
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        sequence: entry.sequence,
        role: entry.role as ReviewedInstructionRole['role'],
      }),
    ),
  );
}
