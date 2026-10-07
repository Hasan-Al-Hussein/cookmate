import { catalogue } from '@cookmate/catalogue';
import type { Catalogue } from '@cookmate/catalogue';
import { createRecipeSearch, normalizeSearchText } from '@cookmate/domain';
import type { SearchCriteria, RecipeSearchResult } from '@cookmate/domain';
import type { AssistantTurnRequest, SourceReference } from '@cookmate/contracts';
import { gatewayError } from './errors';
import { LIMITS } from './limits';

export function sourceKey(source: SourceReference): string {
  switch (source.section) {
    case 'recipe':
      return `${source.recipeId}:recipe`;
    case 'ingredient':
      return `${source.recipeId}:ingredient:${source.position}`;
    case 'instruction':
      return `${source.recipeId}:instruction:${source.position}`;
    case 'annotation':
      return `${source.recipeId}:annotation:${source.annotationId}`;
  }
}

export function createEvidenceBuilder(source: Catalogue = catalogue) {
  const search = createRecipeSearch(source);
  function packet(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (unique.length > LIMITS.evidenceRecipes)
      throw gatewayError('too_large', 413, 'after_correction');
    return unique.map((id) => {
      const recipe = source.getRecipe(id);
      if (!recipe) throw gatewayError('unknown_recipe');
      // Preserve every ingredient, instruction (including headings) and reviewed warning.
      // Photos, external URLs and workbook-wide records are not provider inputs.
      return {
        recipeId: recipe.recipeId,
        title: recipe.title,
        category: recipe.category,
        cuisine: recipe.cuisine,
        source: { recipeId: id, section: 'recipe' } as SourceReference,
        ingredients: recipe.ingredients.map((entry) => ({
          rawName: entry.rawName,
          rawMeasure: entry.rawMeasure,
          locator: entry.source,
          source: {
            recipeId: id,
            section: 'ingredient',
            position: entry.position,
          } as SourceReference,
        })),
        instructions: recipe.instructions.map((passage) => ({
          rawText: passage.rawText,
          presentation: passage.presentation,
          locator: passage.source,
          source: {
            recipeId: id,
            section: 'instruction',
            position: passage.sequence,
          } as SourceReference,
        })),
        annotations: recipe.annotations.map((annotation) => ({
          kind: annotation.kind,
          note: annotation.note,
          evidence: annotation.evidence,
          source: {
            recipeId: id,
            section: 'annotation',
            annotationId: annotation.annotationId,
          } as SourceReference,
        })),
        unavailableMetadata: [
          'verified_total_duration',
          'servings',
          'nutrition',
          'rating',
          'allergy_safety',
        ],
      };
    });
  }
  function retrieve(criteria: SearchCriteria): RecipeSearchResult {
    return search.search(criteria);
  }
  function initial(request: AssistantTurnRequest) {
    const selected = request.context.selectedRecipeId;
    if (selected)
      return {
        packet: packet([selected]),
        selection: {
          query: { selectedRecipeId: selected },
          totalMatches: 1,
          approximate: false,
          returnedRecipeIds: [selected],
          selection: 'selected_recipe' as const,
          complete: true,
        },
      };
    const result = retrieve({ query: request.message.text });
    const ids = result.matches.slice(0, LIMITS.evidenceRecipes).map((item) => item.recipeId);
    return {
      packet: packet(ids),
      selection: {
        query: result.criteria,
        totalMatches: result.matches.length,
        approximate: false,
        returnedRecipeIds: ids,
        selection: 'search' as const,
        complete: ids.length === result.matches.length,
      },
    };
  }
  function namedRecipeIds(text: string): string[] {
    const normalized = ` ${normalizeSearchText(text)} `;
    return source.recipes
      .filter((recipe) => normalized.includes(` ${normalizeSearchText(recipe.title)} `))
      .map((recipe) => recipe.recipeId);
  }
  return {
    packet,
    retrieve,
    initial,
    namedRecipeIds,
    identity: source.identity,
    boundary: source.boundary,
  };
}
export type EvidencePacket = ReturnType<ReturnType<typeof createEvidenceBuilder>['packet']>;

export function evidenceSourceKeys(packet: EvidencePacket): ReadonlySet<string> {
  return new Set(
    packet
      .flatMap((recipe) => [
        recipe.source,
        ...recipe.ingredients.map((item) => item.source),
        ...recipe.instructions.map((item) => item.source),
        ...recipe.annotations.map((item) => item.source),
      ])
      .map(sourceKey),
  );
}
