import type {
  CatalogueBoundary,
  CatalogueIdentity,
  Recipe,
  SourceReference,
} from '@cookmate/contracts';
import { validateRecipe } from '@cookmate/contracts';

export type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: Immutable<T[Key]> }
    : T;

export type CatalogueRecipe = Immutable<Recipe>;

export interface Catalogue {
  readonly identity: Readonly<CatalogueIdentity>;
  readonly recipes: readonly CatalogueRecipe[];
  readonly boundary: CatalogueBoundary;
  getRecipe(recipeId: string): CatalogueRecipe | undefined;
}

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Exposing a normal Set would let JavaScript callers mutate a validation boundary.
export function readonlyIds(ids: Set<string>): ReadonlySet<string> {
  // Bind only Set reads. Binding inherited Object helpers such as __defineGetter__
  // would let a caller install an accessor that exposes the backing Set.
  const reads = new Map<PropertyKey, unknown>();
  for (const key of [
    'has',
    'entries',
    'keys',
    'values',
    Symbol.iterator,
    'union',
    'intersection',
    'difference',
    'symmetricDifference',
    'isSubsetOf',
    'isSupersetOf',
    'isDisjointFrom',
  ]) {
    const method: unknown = Reflect.get(Set.prototype, key);
    if (typeof method === 'function') reads.set(key, method.bind(ids));
  }
  const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
  const each = Set.prototype.forEach.bind(ids);
  const view = new Proxy(ids, {
    get(_target, key) {
      if (key === 'size') return size.call(ids);
      if (key === Symbol.toStringTag) return 'Set';
      if (key === 'valueOf') return () => view;
      if (key === 'forEach') {
        return (
          callback: (value: string, key: string, set: ReadonlySet<string>) => void,
          thisArg?: unknown,
        ) => each((id) => callback.call(thisArg, id, id, view));
      }
      return reads.get(key);
    },
    has: (_target, key) =>
      key === 'size' ||
      key === Symbol.toStringTag ||
      key === 'valueOf' ||
      key === 'forEach' ||
      reads.has(key),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  });
  return view;
}

export function createCatalogue(input: {
  identity: CatalogueIdentity;
  recipes: unknown[];
}): Catalogue {
  if (!input.identity.version || !/^[0-9a-f]{64}$/.test(input.identity.fingerprint)) {
    throw new Error('Invalid prepared catalogue identity');
  }
  const recipes = new Map<string, CatalogueRecipe>();
  for (const candidate of input.recipes) {
    if (!validateRecipe(candidate)) throw new Error('Invalid prepared recipe');
    if (recipes.has(candidate.recipeId))
      throw new Error(`Duplicate recipe ID: ${candidate.recipeId}`);
    for (const [index, entry] of candidate.ingredients.entries()) {
      if (entry.recipeId !== candidate.recipeId || entry.position !== index + 1) {
        throw new Error(`Invalid ingredient ownership or order: ${candidate.recipeId}`);
      }
    }
    for (const [index, passage] of candidate.instructions.entries()) {
      if (passage.recipeId !== candidate.recipeId || passage.sequence !== index + 1) {
        throw new Error(`Invalid instruction ownership or order: ${candidate.recipeId}`);
      }
    }
    const annotationIds = new Set<string>();
    for (const annotation of candidate.annotations) {
      if (
        annotation.recipeId !== candidate.recipeId ||
        annotationIds.has(annotation.annotationId)
      ) {
        throw new Error(`Invalid annotation ownership or identity: ${candidate.recipeId}`);
      }
      annotationIds.add(annotation.annotationId);
    }
    // Caller-owned mutable objects must not become a second way to change source data.
    // Validated recipes contain only JSON values; this also works in native JS runtimes.
    recipes.set(candidate.recipeId, freeze(JSON.parse(JSON.stringify(candidate)) as Recipe));
  }
  const identity = Object.freeze({ ...input.identity });
  const boundary: CatalogueBoundary = Object.freeze({
    identity,
    recipeIds: readonlyIds(new Set(recipes.keys())),
    hasSource(reference: SourceReference): boolean {
      if (reference === null || typeof reference !== 'object') return false;
      const recipe = recipes.get(reference.recipeId);
      if (!recipe) return false;
      switch (reference.section) {
        case 'recipe':
          return hasExactKeys(reference, ['recipeId', 'section']);
        case 'ingredient':
          return (
            hasExactKeys(reference, ['recipeId', 'section', 'position']) &&
            Number.isSafeInteger(reference.position) &&
            recipe.ingredients.some((entry) => entry.position === reference.position)
          );
        case 'instruction':
          return (
            hasExactKeys(reference, ['recipeId', 'section', 'position']) &&
            Number.isSafeInteger(reference.position) &&
            recipe.instructions.some((passage) => passage.sequence === reference.position)
          );
        case 'annotation':
          return (
            hasExactKeys(reference, ['recipeId', 'section', 'annotationId']) &&
            recipe.annotations.some(
              (annotation) => annotation.annotationId === reference.annotationId,
            )
          );
        default:
          return false;
      }
    },
  });
  return Object.freeze({
    identity,
    recipes: Object.freeze([...recipes.values()]),
    boundary,
    getRecipe: (recipeId: string) => recipes.get(recipeId),
  });
}
