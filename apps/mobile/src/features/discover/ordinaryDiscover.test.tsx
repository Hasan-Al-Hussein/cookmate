import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { catalogue, getRecipe, type Immutable } from '@cookmate/catalogue';
import { createBundledContentReader, type ReadingRecipe } from '@cookmate/catalogue/content';
import { createRecipeSearch } from '@cookmate/domain';
import { OrdinaryCatalogueProvider } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import type { ContentRecipePhoto } from '../content/ContentRecipePhoto';
import { AssistantEntryProvider } from '../assistant/AssistantEntryState';
import { DiscoverProvider } from './DiscoverState';
import DiscoverScreen from './DiscoverScreen';
import { DiscoverHero } from './DiscoverHero';
import { OrdinaryRecipePhoto } from '../../components/OrdinaryRecipePhoto';
import { pickRecipeId } from './RecipePick';
import { ActionButton } from '../../components/Controls';

const mockPush = jest.fn();
const mockPhotos: ComponentProps<typeof ContentRecipePhoto>[] = [];
jest.mock('../content/ContentRecipePhoto', () => ({
  ContentRecipePhoto: (props: ComponentProps<typeof ContentRecipePhoto>) => {
    mockPhotos.push(props);
    const { View } = jest.requireActual('react-native');
    return <View testID={`verified-photo-${props.recipe.recipeId}`} />;
  },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: jest.fn() }),
  useFocusEffect: () => undefined,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '52839': 1 } }));
jest.mock('./ContinueCooking', () => ({
  ContinueCooking: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Legacy bundled continue cooking boundary</Text>;
  },
}));

let original: Immutable<ReadingRecipe>;
beforeAll(async () => {
  // Presentation fixtures only; source signature/media validation has separate host tests.
  original = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
afterEach(() => {
  cleanup();
  mockPhotos.length = 0;
  mockPush.mockClear();
});
function authored(id = '90001', title = 'Published sumac supper'): Immutable<ReadingRecipe> {
  return {
    ...original,
    recipeId: id,
    title,
    category: 'Reviewed supper',
    cuisine: 'Published region',
    contentRef: {
      recipeId: id,
      revisionId: 'reviewed-discover-fixture',
      contentFingerprint: 'b'.repeat(64),
    },
    contentKind: 'authored',
    description: 'Presentation fixture.',
    media: [],
    retainedSources: [],
    annotations: [],
    ingredients: [
      { recipeId: id, position: 1, rawName: 'Sumac', rawMeasure: '  ½ tsp  ', source: null },
    ],
    instructions: [
      {
        recipeId: id,
        sequence: 1,
        rawText: 'Original authored paragraph.',
        presentation: 'passage',
        source: null,
      },
    ],
    provenance: {
      kind: 'authored',
      authorId: 'Fixture author',
      createdAt: '2026-10-01T00:00:00.000Z',
      changeSummary: 'Presentation only.',
      basedOn: null,
      credits: [],
    },
  };
}
function ready(
  recipes: readonly Immutable<ReadingRecipe>[],
  scopeKey = 'content:1',
): OrdinaryCatalogueState {
  const search = createRecipeSearch({ identity: catalogue.identity, recipes });
  return {
    kind: 'ready',
    scopeKey,
    mode: 'content',
    photoMode: 'verified',
    identity: catalogue.identity,
    recipes,
    facets: search.facets,
    search: search.search,
    current: (id) => recipes.find((recipe) => recipe.recipeId === id),
  };
}
function controller(initial: OrdinaryCatalogueState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const reader: OrdinaryCatalogueController = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: jest.fn(),
    readCurrent: async () => ({ kind: 'missing' }),
    readSavedIdentity: async () => ({ kind: 'missing' as const }),
    readExact: async () => ({ kind: 'missing' }),
    readPhoto: jest.fn(async () => {
      throw new Error('The mocked photo component must not request bytes');
    }),
    onPhotoCleanupFailure: jest.fn(),
    close() {},
  };
  return {
    reader,
    set(next: OrdinaryCatalogueState) {
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      });
    },
  };
}
function discover(reader?: OrdinaryCatalogueController) {
  const content = (
    <DiscoverProvider>
      <AssistantEntryProvider>
        <DiscoverScreen />
      </AssistantEntryProvider>
    </DiscoverProvider>
  );
  return render(
    reader ? (
      <OrdinaryCatalogueProvider controller={reader}>{content}</OrdinaryCatalogueProvider>
    ) : (
      content
    ),
  );
}

test('unchanged standalone Discover retains its bundled catalogue and credits', () => {
  const view = discover();
  expect(
    view.getByText('Recipes and supplied photographs from TheMealDB collection.'),
  ).toBeTruthy();
  expect(view.getByText(`${catalogue.recipes.length} recipes`)).toBeTruthy();
  expect(view.getByText('Legacy bundled continue cooking boundary')).toBeTruthy();
  expect(
    view.getByRole('button', { name: `Open ${getRecipe('52839')!.title}, featured recipe` }),
  ).toBeTruthy();
});

test('ordinary Discover searches and picks authored current identities absent from the bundled catalogue', () => {
  const recipe = authored(),
    source = controller(ready([recipe]));
  expect(getRecipe(recipe.recipeId)).toBeUndefined();
  const view = discover(source.reader);
  expect(view.queryByText('Legacy bundled continue cooking boundary')).toBeNull();
  expect(
    view.getByRole('button', { name: `Open ${recipe.title}, ${recipe.cuisine}` }),
  ).toBeTruthy();
  expect(
    view.queryByText('Recipes and supplied photographs from TheMealDB collection.'),
  ).toBeNull();
  fireEvent.changeText(
    view.getByLabelText('Search recipes by dish, ingredient or cuisine'),
    'sumac',
  );
  fireEvent.press(view.getByRole('button', { name: 'Pick a recipe' }));
  expect(view.getByText('The only recipe matching these criteria.')).toBeTruthy();
  fireEvent.press(view.getByRole('button', { name: 'View picked recipe' }));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/recipe/[id]',
    params: { id: recipe.recipeId },
  });
  expect(pickRecipeId([recipe.recipeId])).toBe(recipe.recipeId);
  expect(
    mockPhotos.some(
      (photo) =>
        photo.recipe === recipe &&
        photo.content === source.reader &&
        photo.scopeKey === 'content:1' &&
        photo.onCleanupFailure === source.reader.onPhotoCleanupFailure,
    ),
  ).toBe(true);
});

test('adoption replaces title/search data and revocation immediately removes previous cards and photos', () => {
  const source = controller(ready([authored()]));
  const view = discover(source.reader);
  fireEvent.changeText(
    view.getByLabelText('Search recipes by dish, ingredient or cuisine'),
    'saffron',
  );
  expect(view.getByText('No recipes match these filters.')).toBeTruthy();
  const updated = authored('90001', 'Updated saffron supper');
  source.set(ready([updated], 'content:2'));
  expect(
    view.getByRole('button', { name: `Open ${updated.title}, ${updated.cuisine}` }),
  ).toBeTruthy();
  source.set({ kind: 'unavailable', scopeKey: 'content:3', reason: 'revoked' });
  expect(view.getByText('Recipes are unavailable')).toBeTruthy();
  expect(view.queryByTestId('verified-photo-90001')).toBeNull();
  expect(
    view.queryByRole('button', { name: `Open ${updated.title}, ${updated.cuisine}` }),
  ).toBeNull();
  expect(view.queryByText('No recipes match these filters.')).toBeNull();
});

test.each(['loading', 'failed', 'closed'] as const)(
  'a present %s catalogue never substitutes packaged recipes',
  (kind) => {
    const source = controller({ kind, scopeKey: 'pending' });
    const view = discover(source.reader);
    expect(
      view.queryByRole('button', { name: `Open ${getRecipe('52839')!.title}, featured recipe` }),
    ).toBeNull();
    expect(view.queryByText(`${catalogue.recipes.length} recipes`)).toBeNull();
    expect(
      view.getByRole('button', { name: 'Pick a recipe' }).props.accessibilityState.disabled,
    ).toBe(true);
    if (kind === 'failed') {
      fireEvent.press(view.getByRole('button', { name: 'Retry recipe catalogue' }));
      expect(source.reader.retry).toHaveBeenCalledTimes(1);
    }
  },
);

test('filters use the adopted facets instead of supplied baseline labels', () => {
  const source = controller(ready([authored()]));
  const view = discover(source.reader);
  fireEvent.press(view.getByRole('button', { name: 'Filters' }));
  expect(view.getByRole('radio', { name: 'Reviewed supper' })).toBeTruthy();
  expect(view.queryByRole('radio', { name: 'Pasta' })).toBeNull();
  fireEvent.press(view.getByRole('tab', { name: 'Cuisine' }));
  expect(view.getByRole('radio', { name: 'Published region' })).toBeTruthy();
  fireEvent.press(view.getByRole('tab', { name: 'Ingredients' }));
  expect(view.getByRole('checkbox', { name: 'Sumac' })).toBeTruthy();
});

test.each(['loading', 'unavailable', 'ready'] as const)(
  'an open filter sheet closes on catalogue %s and cannot apply or reopen for a new scope',
  (kind) => {
    const source = controller(ready([authored()]));
    const view = discover(source.reader);
    fireEvent.press(view.getByRole('button', { name: 'Filters' }));
    fireEvent.press(view.getByRole('radio', { name: 'Reviewed supper' }));
    const retainedApply = view
      .UNSAFE_getAllByType(ActionButton)
      .find((button) => button.props.label === 'Apply filters')!.props.onPress;
    source.set(
      kind === 'ready'
        ? ready([authored()], 'content:2')
        : kind === 'loading'
          ? { kind, scopeKey: 'content:2' }
          : { kind, scopeKey: 'content:2', reason: 'revoked' },
    );
    if (kind !== 'ready')
      expect(
        view.getByText(kind === 'loading' ? 'Loading recipes…' : 'Recipes are unavailable'),
      ).toBeTruthy();
    source.set(ready([authored()], 'content:3'));
    act(() => {
      retainedApply();
    });
    expect(view.getByRole('button', { name: 'Filters' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Apply filters' })).toBeNull();
    expect(
      view.queryByRole('button', { name: 'Remove category filter: Reviewed supper' }),
    ).toBeNull();
    expect(view.getByText('1 recipe')).toBeTruthy();
  },
);

test('hero resolves its exact current featured version and removes an archived entry instead of showing the old asset', () => {
  const recipe = authored('52839', 'Reviewed featured title'),
    source = controller(ready([recipe]));
  const view = render(
    <OrdinaryCatalogueProvider controller={source.reader}>
      <DiscoverHero expanded />
    </OrdinaryCatalogueProvider>,
  );
  expect(view.getByRole('button', { name: `Open ${recipe.title}, featured recipe` })).toBeTruthy();
  expect(view.getByTestId('verified-photo-52839', { includeHiddenElements: true })).toBeTruthy();
  source.set(ready([], 'content:2'));
  expect(view.queryByTestId('verified-photo-52839', { includeHiddenElements: true })).toBeNull();
  expect(view.queryByRole('button', { name: /featured recipe/ })).toBeNull();
});

test('a stale card cannot use the photo from a different current revision', () => {
  const old = authored(),
    changed = { ...old, contentRef: { ...old.contentRef, revisionId: 'replacement' } };
  const source = controller(ready([changed]));
  const view = render(
    <OrdinaryCatalogueProvider controller={source.reader}>
      <OrdinaryRecipePhoto recipe={old} />
    </OrdinaryCatalogueProvider>,
  );
  expect(view.queryByTestId('verified-photo-90001')).toBeNull();
  expect(view.getByLabelText(`Photo unavailable for ${old.title}`)).toBeTruthy();
});
