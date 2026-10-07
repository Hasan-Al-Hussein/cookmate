import { AssistantEntryProvider } from './assistant/AssistantEntryState';
import {
  act,
  cleanup,
  fireEvent,
  render as renderNative,
  screen,
  within,
} from '@testing-library/react-native';
import { Linking } from 'react-native';
import { catalogue, getRecipe } from '@cookmate/catalogue';
import { recipeColumns } from '../hooks/useNativeLayout';
import { RecipePhoto } from '../components/RecipePhoto';
import { AppText } from '../components/Typography';
import RecipeDetailsScreen, {
  RecipeIngredients,
  RecipeInstructions,
  RecipeAnnotations,
} from './recipes/RecipeDetailsScreen';
import { DiscoverProvider, recipeSearch } from './discover/DiscoverState';
import DiscoverScreen from './discover/DiscoverScreen';
import { FilterSheet } from './discover/FilterSheet';
import { PurchaseRow } from './shopping/PurchaseRow';
import AssistantScreen from './assistant/AssistantScreen';
import InterfaceProofScreen from './proofs/InterfaceProofScreen';

function render(ui: Parameters<typeof renderNative>[0]) {
  return renderNative(ui, { wrapper: AssistantEntryProvider });
}

const mockPush = jest.fn();
const mockParams: { id?: string; recipeId?: string; section?: string } = {};
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
  useRouter: () => ({
    push: mockPush,
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
    setParams: jest.fn(),
  }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({
  recipePhotoAssets: { '52839': 1, '53064': 2, '52835': 3 },
}));

jest.mock('@cookmate/domain', () => {
  const actual = jest.requireActual('@cookmate/domain');
  return {
    ...actual,
    createRecipeSearch: (source: unknown) => {
      const service = actual.createRecipeSearch(source);
      return { ...service, search: jest.fn(service.search) };
    },
  };
});

async function renderDiscover() {
  render(
    <DiscoverProvider>
      <DiscoverScreen />
    </DiscoverProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  delete mockParams.id;
  delete mockParams.recipeId;
  delete mockParams.section;
});

afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  cleanup();
  jest.useRealTimers();
});

test('grid reflows at the agreed width and text-scale boundaries', () => {
  expect(recipeColumns(360, 1)).toBe(1);
  expect(recipeColumns(379, 1)).toBe(1);
  expect(recipeColumns(380, 1)).toBe(2);
  expect(recipeColumns(390, 1)).toBe(2);
  expect(recipeColumns(430, 1.16)).toBe(1);
  expect(recipeColumns(390, 2)).toBe(1);
});

test('missing source quantities remain explicit, and ingredient reading has no purchase controls', () => {
  const recipe = catalogue.recipes.find((item) =>
    item.ingredients.some((entry) => !entry.rawMeasure),
  );
  if (!recipe) throw new Error('Expected source fixture with missing quantity');
  render(<RecipeIngredients recipe={recipe} />);
  expect(screen.getAllByText('Amount not supplied').length).toBeGreaterThan(0);
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
});

test('repeated ingredient source rows remain separate', () => {
  const recipe = catalogue.recipes.find(
    (item) =>
      new Set(item.ingredients.map((entry) => entry.rawName)).size < item.ingredients.length,
  );
  if (!recipe) throw new Error('Expected repeated source ingredients');
  render(<RecipeIngredients recipe={recipe} />);
  const counts = new Map<string, number>();
  recipe.ingredients.forEach((entry) =>
    counts.set(entry.rawName, (counts.get(entry.rawName) ?? 0) + 1),
  );
  for (const [name, count] of counts) expect(screen.getAllByText(name)).toHaveLength(count);
});

test('source instruction headings keep their semantics and literal source text', () => {
  const recipe = getRecipe('53150')!;
  render(<RecipeInstructions recipe={recipe} />);
  recipe.instructions.forEach((passage) => expect(screen.getByText(passage.rawText)).toBeTruthy());
  expect(screen.getAllByRole('header')).toHaveLength(
    recipe.instructions.filter((passage) => passage.presentation === 'heading').length,
  );
});

test('unknown recipe IDs show unavailable, never a title substitute', () => {
  mockParams.id = 'not-a-recipe';
  render(<RecipeDetailsScreen />);
  expect(screen.getByText('Recipe unavailable')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add to plan' })).toBeNull();
});

test('Bread omelette preserves minimal instructions and the reviewed source limitation', () => {
  mockParams.id = '53076';
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  expect(screen.getByText('Make and enjoy')).toBeTruthy();
  const note = getRecipe('53076')!.annotations.find((item) => item.kind === 'limited_instructions');
  expect(note).toBeDefined();
  expect(screen.getByText(note!.note)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add to plan' })).toBeDisabled();
});

test('source links open only after deliberate press and missing links remain absent', () => {
  mockParams.id = '53076';
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true);
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Source' }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText('Original publisher link not supplied.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Recipe video ↗' })).toBeNull();
  fireEvent.press(
    screen.getByRole('button', { name: 'Recipe collection, TheMealDB, opens external site' }),
  );
  expect(open).toHaveBeenCalledWith(getRecipe('53076')!.recipePage);
  open.mockRestore();
});

test('Source disclosure retains detailed notes and explicit source-note entry reveals them', () => {
  const recipe = getRecipe('52982')!;
  mockParams.id = recipe.recipeId;
  const view = render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Source' }));
  expect(
    screen.getByRole('button', { name: 'About this source' }).props.accessibilityState.expanded,
  ).toBe(false);
  for (const annotation of recipe.annotations)
    expect(screen.queryByText(annotation.note)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'About this source' }));
  for (const annotation of recipe.annotations)
    expect(screen.getByText(annotation.note)).toBeTruthy();
  view.unmount();
  mockParams.section = 'source';
  render(<RecipeDetailsScreen />);
  expect(
    screen.getByRole('button', { name: 'About this source' }).props.accessibilityState.expanded,
  ).toBe(true);
  for (const annotation of recipe.annotations)
    expect(screen.getByText(annotation.note)).toBeTruthy();
});

test('a failed image preserves its named recipe and stable fallback', () => {
  render(<RecipePhoto recipeId="52839" title="Chilli prawn linguine" />);
  fireEvent(screen.getByLabelText('Supplied photo of Chilli prawn linguine'), 'error');
  expect(screen.getByText('Photo unavailable')).toBeTruthy();
  expect(screen.getByText('Chilli prawn linguine')).toBeTruthy();
});

test('a failed photo does not suppress a different recipe in the reused frame', () => {
  const view = render(<RecipePhoto recipeId="52839" title="Chilli prawn linguine" />);
  fireEvent(screen.getByLabelText('Supplied photo of Chilli prawn linguine'), 'error');
  expect(screen.getByText('Photo unavailable')).toBeTruthy();
  view.rerender(<RecipePhoto recipeId="53064" title="Fettuccine Alfredo" />);
  expect(screen.getByLabelText('Supplied photo of Fettuccine Alfredo')).toBeTruthy();
  expect(screen.queryByText('Photo unavailable')).toBeNull();
});

test('a failed photo recovers when its source changes for the same recipe', () => {
  const assets = jest.requireMock('@cookmate/catalogue/photos').recipePhotoAssets;
  const previous = assets['52839'];
  try {
    const view = render(<RecipePhoto recipeId="52839" title="Chilli prawn linguine" />);
    fireEvent(screen.getByLabelText('Supplied photo of Chilli prawn linguine'), 'error');
    assets['52839'] = 4;
    view.rerender(<RecipePhoto recipeId="52839" title="Chilli prawn linguine" />);
    expect(screen.getByLabelText('Supplied photo of Chilli prawn linguine').props.source).toBe(4);
    expect(screen.queryByText('Photo unavailable')).toBeNull();
  } finally {
    assets['52839'] = previous;
  }
});

test('source guidance stays in Instructions while workbook locators appear only in Source', () => {
  const recipe = getRecipe('53076')!;
  const note = recipe.annotations.find((item) => item.kind === 'limited_instructions')!;
  const view = render(<RecipeAnnotations recipe={recipe} section="instructions" />);
  expect(screen.getByText(note.note)).toBeTruthy();
  expect(screen.queryByText('Instructions D149')).toBeNull();
  view.rerender(<RecipeAnnotations recipe={recipe} section="source" />);
  expect(screen.getByText(note.note)).toBeTruthy();
  expect(screen.queryByText('Instructions D149')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Show worksheet references' }));
  expect(screen.getByText('Instructions D149')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Hide worksheet references' }));
  expect(screen.queryByText('Instructions D149')).toBeNull();
  expect(screen.getByText(note.note)).toBeTruthy();
});

test.each(['ingredients', 'instructions'] as const)(
  'approved v2 conflict text stays in context for %s and opens the existing Source tab',
  (section) => {
    const recipe = getRecipe('52982')!;
    const note = recipe.annotations.find(
      (item) => item.annotationId === '52982-ingredient-method-conflict',
    );
    if (!note) throw new Error('This test requires the approved real v2 catalogue annotation.');
    expect(note.note).toBe(
      'The ingredient list and method conflict: the list gives 320g spaghetti, 6 egg yolks and 150g bacon; the method gives 350g spaghetti, 3 whole eggs and 100g pancetta, and also uses parmesan, garlic and butter absent from the list. Review the source before cooking or relying on the shopping list; neither version has been silently selected or verified as complete.',
    );
    mockParams.id = recipe.recipeId;
    render(<RecipeDetailsScreen />);
    if (section === 'instructions')
      fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
    expect(screen.getAllByText('Recipe source notes')).toHaveLength(
      section === 'ingredients' ? 1 : 5,
    );
    expect(screen.getAllByText(note.note)).toHaveLength(section === 'ingredients' ? 1 : 5);
    const text = screen.UNSAFE_getAllByType(AppText);
    const firstBody =
      section === 'ingredients' ? recipe.ingredients[0].rawName : recipe.instructions[3]!.rawText;
    const noticeIndex = text.findIndex((node) => node.props.children === note.note);
    const bodyIndex = text.findIndex((node) => node.props.children === firstBody);
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(bodyIndex).toBeGreaterThan(noticeIndex);
    if (section === 'instructions') {
      const introductionIndex = text.findIndex(
        (node) => node.props.children === recipe.instructions[1]!.rawText,
      );
      expect(noticeIndex).toBeGreaterThan(introductionIndex);
    }
    fireEvent.press(
      screen.getByRole('button', {
        name:
          section === 'ingredients'
            ? 'View source notes'
            : `All recipe source notes (${recipe.annotations.length})`,
      }),
    );
    expect(screen.getByRole('tab', { name: 'Source' }).props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.queryByText('Recipe source notes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View source notes' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Show worksheet references' }));
    for (const annotation of recipe.annotations) {
      expect(screen.getAllByText(annotation.note)).toHaveLength(1);
      const locators = annotation.evidence
        .map((locator) => `${locator.sheet} ${locator.column ?? 'row '}${locator.row}`)
        .join(' · ');
      expect(screen.getByText(locators)).toBeTruthy();
    }
  },
);

test.each(['ingredients', 'instructions'] as const)(
  'the alternative-garnish note keeps its generic source heading and exact meaning in %s',
  (section) => {
    const recipe = getRecipe('52835')!;
    const note = recipe.annotations.find(
      (item) => item.annotationId === '52835-alternative-garnish',
    )!;
    render(<RecipeAnnotations recipe={recipe} section={section} />);
    expect(screen.getByText('Recipe source notes')).toBeTruthy();
    expect(screen.getAllByText(note.note)).toHaveLength(1);
    expect(note.note).toBe(
      'The instructions offer chives or parsley as alternatives for the garnish. Parsley is listed; chives is not. This does not require buying both.',
    );
    expect(screen.queryByText('Ingredient conflict')).toBeNull();
    expect(screen.queryByText('Instructions D331 · Ingredients D519')).toBeNull();
  },
);

test.each(['53389', '53318'])(
  'approved v2 photo-only annotation for %s stays on the photo/Source paths',
  (recipeId) => {
    const recipe = getRecipe(recipeId)!;
    const note = recipe.annotations.find(
      (item) => item.annotationId === `${recipeId}-photo-uncertainty`,
    );
    if (!note) throw new Error('This test requires the approved real v2 photo annotation.');
    const view = render(<RecipeAnnotations recipe={recipe} section="ingredients" />);
    expect(screen.queryByText('Recipe source notes')).toBeNull();
    expect(screen.queryByText(note.note)).toBeNull();
    view.rerender(<RecipeAnnotations recipe={recipe} section="instructions" />);
    expect(screen.queryByText('Recipe source notes')).toBeNull();
    expect(screen.queryByText(note.note)).toBeNull();
    view.rerender(<RecipeAnnotations recipe={recipe} section="source" />);
    expect(screen.getAllByText(note.note)).toHaveLength(1);
  },
);

test('filter actions stay outside virtual choices and apply an early ingredient without reaching the end', async () => {
  const apply = jest.fn();
  render(
    <FilterSheet
      visible
      criteria={{ query: 'rice' }}
      onApply={apply}
      onClose={jest.fn()}
      onDismiss={jest.fn()}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('tab', { name: 'Ingredients' }));
  const available = screen.getAllByRole('checkbox');
  expect(available.length).toBeLessThan(recipeSearch.facets.ingredients.length);
  const ingredient = recipeSearch.facets.ingredients[0]!;
  fireEvent.press(available[0]!);
  const ingredientInput = screen.getByLabelText('Find an ingredient filter');
  fireEvent.changeText(ingredientInput, 'pepper');
  expect(screen.getByLabelText('Find an ingredient filter')).toBe(ingredientInput);
  expect(screen.getByDisplayValue('pepper')).toBeTruthy();
  expect(
    within(screen.getByTestId('filter-choices')).queryByRole('button', { name: 'Apply filters' }),
  ).toBeNull();
  fireEvent.press(
    within(screen.getByTestId('filter-actions')).getByRole('button', { name: 'Apply filters' }),
  );
  expect(apply).toHaveBeenLastCalledWith({ query: 'rice', ingredients: [ingredient] });
  fireEvent.press(screen.getByRole('button', { name: 'Reset filters' }));
  expect(apply).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
  expect(apply).toHaveBeenLastCalledWith({ query: 'rice' });
});

test('search collapses the introduction and retains both distinct Alfredo identities', async () => {
  await renderDiscover();
  expect(screen.getByText(/Find your/)).toBeTruthy();
  fireEvent.changeText(
    screen.getByLabelText('Search recipes by dish, ingredient or cuisine'),
    'alfredo',
  );
  expect(screen.queryByText(/Find your/)).toBeNull();
  const first = screen.getByRole('button', { name: 'Open Fettuccine Alfredo, Italian' });
  const second = screen.getByRole('button', { name: 'Open Fettucine alfredo, Italian' });
  fireEvent.press(first);
  fireEvent.press(second);
  expect(mockPush).toHaveBeenNthCalledWith(1, {
    pathname: '/recipe/[id]',
    params: { id: '53064' },
  });
  expect(mockPush).toHaveBeenNthCalledWith(2, {
    pathname: '/recipe/[id]',
    params: { id: '52835' },
  });
  expect(screen.getByDisplayValue('alfredo')).toBeTruthy();
});

test('filter Cancel discards its draft and Apply commits visible criteria', async () => {
  await renderDiscover();
  fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
  fireEvent.press(screen.getByRole('radio', { name: /Seafood/ }));
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Remove category filter: Seafood' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
  expect(screen.getByRole('radio', { name: /Seafood/ })).not.toBeChecked();
  fireEvent.press(screen.getByRole('radio', { name: /Seafood/ }));
  fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
  expect(screen.getByRole('button', { name: 'Remove category filter: Seafood' })).toBeTruthy();
  expect(screen.queryByText(/Find your/)).toBeNull();
});

test('overlong search keeps its text and explains recovery without a false zero-result count', async () => {
  await renderDiscover();
  const query = 'a'.repeat(4001);
  fireEvent.changeText(
    screen.getByLabelText('Search recipes by dish, ingredient or cuisine'),
    query,
  );
  expect(screen.getByDisplayValue(query)).toBeTruthy();
  expect(screen.getByText(/Search supports up to 4,000 characters/)).toBeTruthy();
  expect(screen.queryByText('0 recipes')).toBeNull();
  expect(screen.queryByText('No recipes match these filters.')).toBeNull();
});

test('an unexpected short-query failure keeps the input and offers scoped retry', async () => {
  await renderDiscover();
  jest.mocked(recipeSearch.search).mockImplementationOnce(() => {
    throw new Error('Injected query failure');
  });
  fireEvent.changeText(
    screen.getByLabelText('Search recipes by dish, ingredient or cuisine'),
    'rice',
  );
  expect(screen.getByDisplayValue('rice')).toBeTruthy();
  expect(screen.getByText('Your search is still here. Try the search again.')).toBeTruthy();
  expect(screen.queryByText(/Search supports up to/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Retry search' }));
  expect(screen.queryByText('Couldn’t search recipes')).toBeNull();
});

test('outdated shopping presentation prevents purchase edits while retaining truthful state', () => {
  const toggle = jest.fn();
  render(
    <PurchaseRow
      name="Salt"
      amount="Amount not supplied"
      purchased={false}
      changed
      unavailable
      onToggle={toggle}
    />,
  );
  const checkbox = screen.getByRole('checkbox');
  fireEvent.press(checkbox);
  expect(checkbox).toBeDisabled();
  expect(checkbox).not.toBeChecked();
  expect(toggle).not.toHaveBeenCalled();
  expect(screen.getByText('Changed — review')).toBeTruthy();
});

test('entering Assistant with recipe context does not send or fabricate a conversation', () => {
  mockParams.recipeId = '52839';
  render(<AssistantScreen />);
  expect(screen.getByText('Recipe: Chilli prawn linguine')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(screen.getByText('Opening your conversation…')).toBeTruthy();
});

test('hypothetical states are visibly isolated and updating examples disable every row', () => {
  render(<InterfaceProofScreen />);
  expect(screen.getByText('Examples only · no saved changes')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Show updating-list example' }));
  screen.getAllByRole('checkbox').forEach((control) => expect(control).toBeDisabled());
});
