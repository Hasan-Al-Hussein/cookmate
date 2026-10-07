import prepared from '../generated/catalogue.json';
import { createCatalogue } from './catalogue';

export { createCatalogue, readonlyIds } from './catalogue';
export type { Catalogue, CatalogueRecipe, Immutable } from './catalogue';
export { catalogueProvenance, getRecipeProvenance, getRecipePhotoTreatment } from './provenance';
export type { RecipeProvenance, RecipePhotoTreatment } from './provenance';
export { getReviewedBundledInstructionRoles } from './instruction-roles';
export type { ReviewedInstructionRole } from './instruction-roles';

export const catalogue = createCatalogue(prepared);
export const catalogueBoundary = catalogue.boundary;
export const identity = catalogue.identity;
export const getRecipe = catalogue.getRecipe;
