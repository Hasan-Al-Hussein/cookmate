import prepared from '../generated/provenance.json';

export interface RecipeProvenance {
  readonly recipeId: string;
  readonly source: { readonly sheet: 'Recipes'; readonly row: number };
  readonly originalImageUrl: string;
  readonly fetchedUtc: string;
  readonly declaredIngredientEntries: number;
}

export interface RecipePhotoTreatment {
  readonly recipeId: string;
  readonly preserveFullFrame: boolean;
  readonly warningAnnotationId: string | null;
  readonly creditAnnotationId: string | null;
}

const photoTreatments = new Map<string, RecipePhotoTreatment>(
  prepared.assets.map(({ recipeId }) => [
    recipeId,
    Object.freeze({
      recipeId,
      preserveFullFrame: false,
      warningAnnotationId: null,
      creditAnnotationId: null,
      ...prepared.photoTreatment.exceptions.find((treatment) => treatment.recipeId === recipeId),
    }),
  ]),
);

const sources = new Map<string, RecipeProvenance>(
  prepared.recipeSources.map((source) => [
    source.recipeId,
    Object.freeze({
      ...source,
      source: Object.freeze({ sheet: 'Recipes' as const, row: source.source.row }),
    }),
  ]),
);

export const catalogueProvenance = Object.freeze({
  ruleVersion: prepared.ruleVersion,
  sourceHashes: Object.freeze({ ...prepared.sourceHashes }),
  sourceRecordsSha256: prepared.sourceRecordsSha256,
  recipeSources: Object.freeze([...sources.values()]),
  assets: Object.freeze(prepared.assets.map((asset) => Object.freeze({ ...asset }))),
  photoTreatmentRuleVersion: prepared.photoTreatment.ruleVersion,
  photoTreatments: Object.freeze([...photoTreatments.values()]),
});

export const getRecipeProvenance = (recipeId: string): RecipeProvenance | undefined =>
  sources.get(recipeId);

/** Presentation flags identify reviewed exceptions; they do not establish photo authenticity or rights. */
export const getRecipePhotoTreatment = (recipeId: string): RecipePhotoTreatment | undefined =>
  photoTreatments.get(recipeId);
