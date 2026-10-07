import { catalogue } from '@cookmate/catalogue';
import type { Immutable } from '@cookmate/catalogue';
import { createContentReader } from '@cookmate/catalogue/content';
import type {
  EffectiveContentSnapshot,
  ReadingRecipe,
  RecipeContentRef,
  ReviewedMetadata,
  RetainedSourceNotice,
} from '@cookmate/catalogue/content';
import { createRecipeSearch, normalizeSearchText } from '@cookmate/domain';
import type { SearchCriteria, RecipeSearchResult } from '@cookmate/domain';
import type {
  AssistantTurnRequest,
  CatalogueBoundary,
  CatalogueIdentity,
  SourceReference,
} from '@cookmate/contracts';
import { gatewayError } from './errors';
import { LIMITS } from './limits';
import { searchProvenance, selectionProvenance } from './retrieval-provenance';

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

type EvidenceRecipe = Immutable<
  Pick<
    ReadingRecipe,
    'recipeId' | 'title' | 'category' | 'cuisine' | 'ingredients' | 'instructions' | 'annotations'
  > & {
    contentRef?: RecipeContentRef;
    contentKind?: 'imported' | 'authored';
    metadata?: ReviewedMetadata;
    retainedSources?: RetainedSourceNotice[];
  }
>;
interface EvidenceCatalogue {
  identity: Readonly<CatalogueIdentity>;
  recipes: readonly EvidenceRecipe[];
  boundary: CatalogueBoundary;
  getRecipe(recipeId: string): EvidenceRecipe | undefined;
}

export function createEvidenceBuilder(source: EvidenceCatalogue = catalogue) {
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
        ...(recipe.contentRef
          ? { contentRef: recipe.contentRef, contentKind: recipe.contentKind }
          : {}),
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
        // Ancestor warnings are not annotations of a newly authored passage. A recipe-level
        // citation supports the fact that the retained warning remains unresolved.
        retainedOriginalWarnings: (recipe.retainedSources ?? [])
          .filter((notice) => notice.disposition === 'inherited_unresolved')
          .flatMap((notice) =>
            notice.document.recipe.annotations.map((annotation) => ({
              originalContentRef: notice.ref,
              originalAnnotationId: annotation.annotationId,
              disposition: notice.disposition,
              kind: annotation.kind,
              note: annotation.note,
              evidence: annotation.evidence,
              source: { recipeId: id, section: 'recipe' } as SourceReference,
            })),
          ),
        ...(recipe.metadata ? { reviewedMetadata: recipe.metadata } : {}),
        unavailableMetadata: [
          'verified_total_duration',
          ...(recipe.metadata?.servings.value == null ? ['servings'] : []),
          ...(recipe.metadata?.nutrition.value == null ? ['nutrition'] : []),
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
        selection: selectionProvenance('selected_recipe', [selected]),
      };
    const result = retrieve({ query: request.message.text });
    const selection = searchProvenance(result, 'raw_message');
    return {
      packet: packet(selection.returnedRecipeIds),
      selection,
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
/** Same retrieval/validation path, composed only after host verification and adoption. */
export function createContentEvidenceBuilder(snapshot: EffectiveContentSnapshot) {
  return createEvidenceBuilder(createContentReader(snapshot));
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
        ...recipe.retainedOriginalWarnings.map((item) => item.source),
      ])
      .map(sourceKey),
  );
}
