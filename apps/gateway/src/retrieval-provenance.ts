import type { RecipeSearchResult, SearchCriteria } from '@cookmate/domain';
import { LIMITS } from './limits';

interface PacketProvenance {
  returnedRecipeIds: readonly string[];
  requiredFacts: readonly string[];
  packetCoverage: 'full_source_rows_for_returned_recipes';
  intentCoverage: 'unverified';
}
export interface SearchProvenance extends PacketProvenance {
  kind: 'search';
  origin: 'raw_message' | 'model_requested';
  criteria: SearchCriteria;
  searchRuleVersion: string;
  searchRuleFingerprint: string;
  indexedFields: readonly ['title', 'ingredient_name', 'cuisine', 'category'];
  strictMatchCount: number;
  spellingSuggestionCount: number;
  returnedFrom: 'strict_matches' | 'spelling_suggestions';
  resultSetFullyReturned: boolean;
}
export interface SelectionProvenance extends PacketProvenance {
  kind: 'selection';
  origin: 'selected_recipe' | 'ordered_reference' | 'explicit_recipes';
}
export type RetrievalProvenance = SearchProvenance | SelectionProvenance;

/** Preserve initial strict-only search and the existing follow-up spelling fallback. */
export function searchProvenance(
  result: RecipeSearchResult,
  origin: SearchProvenance['origin'],
  requiredFacts: readonly string[] = [],
): SearchProvenance {
  const returnedFrom =
    origin === 'model_requested' && result.matches.length === 0
      ? 'spelling_suggestions'
      : 'strict_matches';
  const matches = returnedFrom === 'strict_matches' ? result.matches : result.suggestions;
  const returnedRecipeIds = matches.slice(0, LIMITS.evidenceRecipes).map((match) => match.recipeId);
  return {
    kind: 'search',
    origin,
    criteria: {
      ...result.criteria,
      ...(result.criteria.ingredients ? { ingredients: [...result.criteria.ingredients] } : {}),
    },
    searchRuleVersion: result.ruleVersion,
    searchRuleFingerprint: result.ruleFingerprint,
    indexedFields: ['title', 'ingredient_name', 'cuisine', 'category'],
    strictMatchCount: result.matches.length,
    spellingSuggestionCount: result.suggestions.length,
    returnedFrom,
    returnedRecipeIds,
    resultSetFullyReturned: returnedRecipeIds.length === matches.length,
    requiredFacts: [...requiredFacts],
    packetCoverage: 'full_source_rows_for_returned_recipes',
    intentCoverage: 'unverified',
  };
}

export function selectionProvenance(
  origin: SelectionProvenance['origin'],
  returnedRecipeIds: readonly string[],
  requiredFacts: readonly string[] = [],
): SelectionProvenance {
  return {
    kind: 'selection',
    origin,
    returnedRecipeIds: [...returnedRecipeIds],
    requiredFacts: [...requiredFacts],
    packetCoverage: 'full_source_rows_for_returned_recipes',
    intentCoverage: 'unverified',
  };
}
