import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { catalogue, getRecipe } from '@cookmate/catalogue';
import { createRecipeSearch, type SearchCriteria } from '@cookmate/domain';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import type { OrdinaryRecipe } from '../../components/OrdinaryRecipePhoto';

export const recipeSearch = createRecipeSearch(catalogue);
const legacyRecipes: readonly OrdinaryRecipe[] = catalogue.recipes;
const legacySource = {
  recipes: legacyRecipes,
  facets: recipeSearch.facets,
  search: recipeSearch.search,
  current: getRecipe,
  mode: 'bundled' as const,
  scopeKey: 'legacy-bundled',
};
/** Only an absent provider uses the legacy catalogue; a present provider owns availability. */
export function useDiscoverCatalogue() {
  const context = useOptionalOrdinaryCatalogue();
  if (!context) return { status: 'ready' as const, ready: legacySource, retry: undefined };
  const { state, reader } = context;
  if (state.kind !== 'ready') return { status: state.kind, ready: null, retry: reader?.retry };
  try {
    const recipes: readonly OrdinaryRecipe[] = state.recipes;
    return {
      status: 'ready' as const,
      ready: {
        recipes,
        facets: {
          categories: state.facets.categories,
          cuisines: state.facets.cuisines,
          ingredients: state.facets.ingredients,
        },
        search: state.search,
        current: state.current,
        mode: state.mode,
        scopeKey: state.scopeKey,
      },
      retry: reader?.retry,
    };
  } catch {
    return { status: 'unavailable' as const, ready: null, retry: reader?.retry };
  }
}
interface DiscoverState {
  criteria: SearchCriteria;
  setCriteria: (criteria: SearchCriteria) => void;
  scrollOffset: { current: number };
  setScrollOffset: (offset: number) => void;
}
const Context = createContext<DiscoverState | null>(null);

export function DiscoverProvider({ children }: { children: ReactNode }) {
  const [criteria, setCriteria] = useState<SearchCriteria>({});
  const scrollOffset = useRef(0);
  const setScrollOffset = (offset: number) => {
    scrollOffset.current = offset;
  };
  return (
    <Context.Provider value={{ criteria, setCriteria, scrollOffset, setScrollOffset }}>
      {children}
    </Context.Provider>
  );
}

export function useDiscoverState() {
  const state = useContext(Context);
  if (!state) throw new Error('DiscoverProvider is missing');
  return state;
}
