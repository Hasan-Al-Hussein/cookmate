import type {
  CatalogueBoundary,
  QualityAnnotation,
  SourceLocator,
  SourceReference,
} from '@cookmate/contracts';
import { readonlyIds, type Immutable } from '../catalogue';
import { canonicalContentJson, freezeContent, requireContent } from './canonical';
import { createBundledContentSnapshot } from './bundled';
import { validateRecipeContentRef } from './validation';
import type {
  ContentLookup,
  EffectiveContentSnapshot,
  ReadableRecipeView,
  RetainedSourceNotice,
  PublishedRecipeTranslation,
} from './overlay-types';
import type {
  AuthoredRecipe,
  ContentHash,
  MediaReference,
  RecipeContentDocument,
  RecipeContentRef,
  ReviewedMetadata,
} from './types';

/** Reading projection, deliberately not the imported Recipe/workbook contract. */
export interface ReadingRecipe extends Omit<AuthoredRecipe, 'ingredients' | 'instructions'> {
  contentRef: RecipeContentRef;
  contentKind: RecipeContentDocument['kind'];
  metadata: ReviewedMetadata;
  media: MediaReference[];
  ingredients: {
    recipeId: string;
    position: number;
    rawName: string;
    rawMeasure: string | null;
    source: SourceLocator | null;
  }[];
  instructions: {
    recipeId: string;
    sequence: number;
    rawText: string;
    presentation: 'heading' | 'passage';
    source: SourceLocator | null;
  }[];
  /** Only annotations of this exact document; ancestor warnings are kept separately. */
  annotations: QualityAnnotation[];
  retainedSources: RetainedSourceNotice[];
  provenance: RecipeContentDocument['provenance'];
  /** Verified parallel text only. Quantities, locators and original row roles remain above. */
  translations?: PublishedRecipeTranslation[];
}
export type ReadingLookup =
  | {
      kind: 'readable';
      recipe: Immutable<ReadingRecipe>;
      state: 'current' | 'archived' | 'historical';
    }
  | Exclude<ContentLookup, { kind: 'readable' }>;

function project(view: Immutable<ReadableRecipeView>): Immutable<ReadingRecipe> {
  const { document, ref } = view.revision;
  const common = {
    ...document.recipe,
    contentRef: ref,
    contentKind: document.kind,
    metadata: document.metadata,
    media: document.media,
    retainedSources: view.retainedSources,
    provenance: document.provenance,
    translations: view.publication?.formatVersion === 3 ? view.publication.translations : [],
  };
  if (document.kind === 'imported')
    return freezeContent({
      ...common,
      description: null,
      ingredients: document.recipe.ingredients,
      instructions: document.recipe.instructions,
      annotations: document.recipe.annotations,
    });
  return freezeContent({
    ...common,
    description: document.recipe.description,
    ingredients: document.recipe.ingredients.map((entry) => ({
      ...entry,
      recipeId: ref.recipeId,
      source: null,
    })),
    instructions: document.recipe.instructions.map((passage) => ({
      ...passage,
      recipeId: ref.recipeId,
      source: null,
    })),
    annotations: [],
  });
}

/** Host-only projection of an independently verified lookup, without inventing a snapshot. */
export function projectContentLookup(value: ContentLookup): ReadingLookup {
  return value.kind === 'readable'
    ? Object.freeze({ kind: 'readable', recipe: project(value.value), state: value.state })
    : value;
}

const exactKeys = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Host composition only: obtain the snapshot from verification/hydration, never JSON assertions. */
export function createContentReader(snapshot: EffectiveContentSnapshot) {
  return createReadingProjection(snapshot);
}

/** The installed catalogue is its own baseline; no release signature or adoption is asserted. */
export async function createBundledContentReader(sha256: ContentHash) {
  const baseline = await createBundledContentSnapshot(sha256);
  const views: Immutable<ReadableRecipeView>[] = baseline.revisions.map((revision) => {
    requireContent(revision.document.kind === 'imported', 'bundled_reader_source');
    return freezeContent({
      origin: 'packaged_baseline' as const,
      revision,
      publication: null,
      retainedSources: [
        { ref: revision.ref, document: revision.document, disposition: 'original' as const },
      ],
    });
  });
  const current = new Map(views.map((view) => [view.revision.ref.recipeId, view]));
  const exact = new Map(views.map((view) => [canonicalContentJson(view.revision.ref), view]));
  const missing: ContentLookup = Object.freeze({ kind: 'missing' });
  const readable = (value: Immutable<ReadableRecipeView> | undefined): ContentLookup =>
    value ? Object.freeze({ kind: 'readable', value, state: 'current' }) : missing;
  return createReadingProjection({
    identity: baseline.catalogue,
    discoverable: views,
    lookupCurrent: (recipeId) => readable(current.get(recipeId)),
    lookupExact: (ref) =>
      validateRecipeContentRef(ref) ? readable(exact.get(canonicalContentJson(ref))) : missing,
  });
}

function createReadingProjection(
  snapshot: Pick<
    EffectiveContentSnapshot,
    'identity' | 'discoverable' | 'lookupCurrent' | 'lookupExact'
  >,
) {
  const cache = new Map<string, Immutable<ReadingRecipe>>();
  function read(value: ContentLookup): ReadingLookup {
    if (value.kind !== 'readable') return value;
    const key = canonicalContentJson(value.value.revision.ref);
    let recipe = cache.get(key);
    if (!recipe) {
      recipe = project(value.value);
      cache.set(key, recipe);
    }
    return Object.freeze({ kind: 'readable', recipe, state: value.state });
  }
  const recipes = Object.freeze(
    snapshot.discoverable.map((view) => {
      const recipe = project(view);
      cache.set(canonicalContentJson(recipe.contentRef), recipe);
      return recipe;
    }),
  );
  const discoverable = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));
  const boundary: CatalogueBoundary = Object.freeze({
    identity: snapshot.identity,
    recipeIds: readonlyIds(new Set(discoverable.keys())),
    hasSource(source: SourceReference) {
      if (!source || typeof source !== 'object') return false;
      const recipe = discoverable.get(source.recipeId);
      if (!recipe) return false;
      switch (source.section) {
        case 'recipe':
          return exactKeys(source, ['recipeId', 'section']);
        case 'ingredient':
          return (
            exactKeys(source, ['recipeId', 'section', 'position']) &&
            Number.isSafeInteger(source.position) &&
            recipe.ingredients.some((entry) => entry.position === source.position)
          );
        case 'instruction':
          return (
            exactKeys(source, ['recipeId', 'section', 'position']) &&
            Number.isSafeInteger(source.position) &&
            recipe.instructions.some((passage) => passage.sequence === source.position)
          );
        case 'annotation':
          return (
            exactKeys(source, ['recipeId', 'section', 'annotationId']) &&
            recipe.annotations.some((note) => note.annotationId === source.annotationId)
          );
        default:
          return false;
      }
    },
  });
  return Object.freeze({
    identity: snapshot.identity,
    boundary,
    recipes,
    /** Current discovery only. Historical callers must use their full saved reference. */
    getRecipe: (recipeId: string) => discoverable.get(recipeId),
    lookupCurrent: (recipeId: string) => read(snapshot.lookupCurrent(recipeId)),
    lookupExact: (ref: RecipeContentRef) => read(snapshot.lookupExact(ref)),
  });
}
