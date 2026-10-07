import type { CatalogueIdentity, SourceReference } from '@cookmate/contracts';
import searchIdentity from './generated/search-identity.json';

export type Immutable<T> = T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T;

export interface SearchCriteria {
  query?: string;
  category?: string;
  cuisine?: string;
  /** Exact source ingredient labels, combined with AND; not a completeness/safety claim. */
  ingredients?: readonly string[];
}

export interface SearchReason {
  field: 'title' | 'ingredient' | 'cuisine' | 'category';
  queryToken: string;
  sourceText: string;
  source: SourceReference;
  interpretation: 'source_match' | 'cuisine_alias' | 'possible_spelling';
}

export interface RecipeSearchMatch {
  recipeId: string;
  score: number;
  reasons: readonly SearchReason[];
}

export interface RecipeSearchResult {
  catalogue: Readonly<CatalogueIdentity>;
  ruleVersion: string;
  ruleFingerprint: string;
  criteria: Readonly<SearchCriteria>;
  matches: readonly RecipeSearchMatch[];
  /** Separate possible matches. Never use one as an automatically resolved action target. */
  suggestions: readonly RecipeSearchMatch[];
}

export const SEARCH_RULE_VERSION = 'source-search-v1';
export const SEARCH_RULE_FINGERPRINT = searchIdentity.fingerprint;
/** Maximum raw UTF-16 length for query/category/cuisine criteria, before normalization. */
export const SEARCH_QUERY_MAX_LENGTH = 4000;

// Reviewed language aliases only. They never alter original cuisine labels or quantity identity.
export const CUISINE_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  argentina: Object.freeze(['argentine', 'argentinian']),
  france: Object.freeze(['french']),
  india: Object.freeze(['indian']),
  netherlands: Object.freeze(['dutch']),
  norway: Object.freeze(['norwegian']),
  slovakia: Object.freeze(['slovak']),
  'united states': Object.freeze(['american', 'usa']),
  venezuela: Object.freeze(['venezuelan']),
});

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

interface SearchField {
  field: SearchReason['field'];
  raw: string;
  normalized: string;
  source: SourceReference;
  alias: boolean;
}

interface IndexedRecipe {
  recipeId: string;
  sourceOrder: number;
  title: string;
  category: string;
  cuisine: string;
  ingredients: ReadonlySet<string>;
  fields: readonly SearchField[];
}

const WEIGHT = { title: 100, ingredient: 40, cuisine: 30, category: 20 } as const;

function validateCriteria(criteria: SearchCriteria): void {
  const allowed = new Set(['query', 'category', 'cuisine', 'ingredients']);
  if (
    criteria === null ||
    typeof criteria !== 'object' ||
    Object.keys(criteria).some((key) => !allowed.has(key))
  )
    throw new Error('Unsupported search criteria');
  for (const key of ['query', 'category', 'cuisine'] as const) {
    if (
      criteria[key] !== undefined &&
      (typeof criteria[key] !== 'string' || criteria[key].length > SEARCH_QUERY_MAX_LENGTH)
    )
      throw new Error(`Invalid search ${key}`);
  }
  if (
    criteria.ingredients !== undefined &&
    (!Array.isArray(criteria.ingredients) ||
      criteria.ingredients.some(
        (item) => typeof item !== 'string' || !normalizeSearchText(item) || item.length > 512,
      ))
  )
    throw new Error('Invalid ingredient filters');
}

function fieldMatches(field: SearchField, token: string): boolean {
  if (token.length < 2) return field.normalized.split(' ').includes(token);
  return field.field === 'title'
    ? field.normalized.includes(token)
    : field.normalized.split(' ').some((word) => word.startsWith(token));
}

// Bounded optimal-string-alignment distance also recognizes adjacent transpositions.
function possibleSpelling(left: string, right: string): boolean {
  if (left.length < 4) return false;
  const bound = left.length >= 8 ? 2 : 1;
  if (Math.abs(left.length - right.length) > bound) return false;
  let priorPrior: number[] | undefined;
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      let distance = Math.min(
        (prior[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (prior[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      )
        distance = Math.min(distance, (priorPrior?.[column - 2] ?? 0) + 1);
      current.push(distance);
    }
    priorPrior = prior;
    prior = current;
  }
  return (prior[right.length] ?? Infinity) <= bound;
}

function matchRecipe(
  recipe: IndexedRecipe,
  tokens: readonly string[],
  query: string,
  approximate: boolean,
): RecipeSearchMatch | null {
  const reasons: SearchReason[] = [];
  let score =
    recipe.title === query && query ? 1000 : query && recipe.title.includes(query) ? 300 : 0;
  for (const token of tokens) {
    let field = recipe.fields.find((candidate) => fieldMatches(candidate, token));
    let interpretation: SearchReason['interpretation'] = field?.alias
      ? 'cuisine_alias'
      : 'source_match';
    if (!field && approximate) {
      field = recipe.fields.find((candidate) =>
        candidate.normalized.split(' ').some((word) => possibleSpelling(token, word)),
      );
      interpretation = 'possible_spelling';
    }
    if (!field) return null;
    score += interpretation === 'possible_spelling' ? 1 : field.alias ? 10 : WEIGHT[field.field];
    reasons.push({
      field: field.field,
      queryToken: token,
      sourceText: field.raw,
      source: { ...field.source },
      interpretation,
    });
  }
  return { recipeId: recipe.recipeId, score, reasons };
}

/** Search needs source labels, not an invented workbook locator for authored content. */
export interface SearchableRecipe {
  recipeId: string;
  title: string;
  category: string;
  cuisine: string;
  ingredients: readonly { position: number; rawName: string }[];
}
export function createRecipeSearch(source: {
  identity: CatalogueIdentity;
  recipes: readonly Immutable<SearchableRecipe>[];
}) {
  const identity = Object.freeze({ ...source.identity });
  const index: IndexedRecipe[] = source.recipes.map((recipe, sourceOrder) => {
    const reference: SourceReference = { recipeId: recipe.recipeId, section: 'recipe' };
    const fields: SearchField[] = [
      {
        field: 'title',
        raw: recipe.title,
        normalized: normalizeSearchText(recipe.title),
        source: reference,
        alias: false,
      },
      ...recipe.ingredients.map(
        (entry): SearchField => ({
          field: 'ingredient',
          raw: entry.rawName,
          normalized: normalizeSearchText(entry.rawName),
          source: { recipeId: recipe.recipeId, section: 'ingredient', position: entry.position },
          alias: false,
        }),
      ),
      {
        field: 'cuisine',
        raw: recipe.cuisine,
        normalized: normalizeSearchText(recipe.cuisine),
        source: reference,
        alias: false,
      },
      {
        field: 'category',
        raw: recipe.category,
        normalized: normalizeSearchText(recipe.category),
        source: reference,
        alias: false,
      },
      ...(CUISINE_ALIASES[normalizeSearchText(recipe.cuisine)] ?? []).map(
        (alias): SearchField => ({
          field: 'cuisine',
          raw: recipe.cuisine,
          normalized: alias,
          source: reference,
          alias: true,
        }),
      ),
    ];
    return {
      recipeId: recipe.recipeId,
      sourceOrder,
      title: normalizeSearchText(recipe.title),
      category: normalizeSearchText(recipe.category),
      cuisine: normalizeSearchText(recipe.cuisine),
      ingredients: new Set(recipe.ingredients.map((entry) => normalizeSearchText(entry.rawName))),
      fields,
    };
  });
  const categories = [...new Set(source.recipes.map((recipe) => recipe.category))];
  const cuisines = [...new Set(source.recipes.map((recipe) => recipe.cuisine))];
  const ingredientLabels = new Map<string, string>();
  source.recipes.forEach((recipe) =>
    recipe.ingredients.forEach((entry) => {
      const key = normalizeSearchText(entry.rawName);
      if (!ingredientLabels.has(key)) ingredientLabels.set(key, entry.rawName);
    }),
  );
  const compare = (left: string, right: string) =>
    normalizeSearchText(left) < normalizeSearchText(right)
      ? -1
      : normalizeSearchText(left) > normalizeSearchText(right)
        ? 1
        : 0;
  const facets = Object.freeze({
    categories: Object.freeze(categories.sort(compare)),
    cuisines: Object.freeze(cuisines.sort(compare)),
    ingredients: Object.freeze([...ingredientLabels.values()].sort(compare)),
  });

  function search(criteria: SearchCriteria = {}): RecipeSearchResult {
    validateCriteria(criteria);
    const query = normalizeSearchText(criteria.query ?? '');
    const tokens = query ? [...new Set(query.split(' '))] : [];
    const category = normalizeSearchText(criteria.category ?? '');
    const cuisine = normalizeSearchText(criteria.cuisine ?? '');
    const ingredients = (criteria.ingredients ?? []).map(normalizeSearchText);
    const eligible = index.filter(
      (recipe) =>
        (!category || recipe.category === category) &&
        (!cuisine || recipe.cuisine === cuisine) &&
        ingredients.every((ingredient) => recipe.ingredients.has(ingredient)),
    );
    const rank = (approximate: boolean) =>
      eligible
        .map((recipe) => ({
          match: matchRecipe(recipe, tokens, query, approximate),
          sourceOrder: recipe.sourceOrder,
        }))
        .filter(
          (item): item is { match: RecipeSearchMatch; sourceOrder: number } => item.match !== null,
        )
        .sort(
          (left, right) =>
            right.match.score - left.match.score || left.sourceOrder - right.sourceOrder,
        )
        .map((item) => item.match);
    const matches = rank(false);
    return {
      catalogue: identity,
      ruleVersion: SEARCH_RULE_VERSION,
      ruleFingerprint: SEARCH_RULE_FINGERPRINT,
      criteria: {
        ...criteria,
        ...(criteria.ingredients ? { ingredients: [...criteria.ingredients] } : {}),
      },
      matches,
      suggestions: matches.length === 0 && tokens.length > 0 ? rank(true) : [],
    };
  }

  return Object.freeze({
    search,
    facets,
    identity,
    ruleVersion: SEARCH_RULE_VERSION,
    ruleFingerprint: SEARCH_RULE_FINGERPRINT,
  });
}
