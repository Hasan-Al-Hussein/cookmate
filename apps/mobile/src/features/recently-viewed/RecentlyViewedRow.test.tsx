import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  createBundledContentReader,
  canonicalContentJson,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { catalogue, type Immutable } from '@cookmate/catalogue';
import { createRecipeSearch } from '@cookmate/domain';
import { OrdinaryCatalogueProvider } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import { RecentlyViewedRow } from './RecentlyViewedRow';
import { RecentlyViewedProvider } from './RecentlyViewedProvider';
import {
  createRecentlyViewedController,
  encodeRecentlyViewed,
  type RecentlyViewedController,
} from './recentlyViewed';

const mockPush = jest.fn(),
  mockPhoto = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../content/ContentRecipePhoto', () => ({
  ContentRecipePhoto: (props: unknown) => {
    mockPhoto(props);
    return null;
  },
}));
jest.mock('../../components/RecipePhoto', () => ({
  RecipePhoto: (props: unknown) => {
    mockPhoto(props);
    return null;
  },
}));
let recipes: readonly Immutable<ReadingRecipe>[];
const controllers: RecentlyViewedController[] = [];
beforeAll(async () => {
  recipes = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes.slice(0, 4);
});
afterEach(() => {
  cleanup();
  controllers.splice(0).forEach((controller) => controller.dispose());
  jest.clearAllMocks();
});
function fixture() {
  const search = createRecipeSearch({ identity: catalogue.identity, recipes });
  let state: OrdinaryCatalogueState = {
    kind: 'ready',
    scopeKey: 'owner1:head1',
    mode: 'content',
    photoMode: 'verified',
    identity: catalogue.identity,
    recipes,
    facets: search.facets,
    search: search.search,
    current: (id) => recipes.find((recipe) => recipe.recipeId === id),
  };
  const listeners = new Set<() => void>();
  const readExact = jest.fn(async (ref: RecipeContentRef): Promise<ReadingLookup> => {
    const recipe = recipes.find((entry) => entry.recipeId === ref.recipeId);
    return recipe ? { kind: 'readable', state: 'current', recipe } : { kind: 'missing' };
  });
  const reader = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    readExact,
    readCurrent: jest.fn(async (): Promise<ReadingLookup> => ({ kind: 'missing' })),
    readSavedIdentity: async (): Promise<ReadingLookup> => ({ kind: 'missing' }),
    readPhoto: jest.fn<
      ReturnType<OrdinaryCatalogueController['readPhoto']>,
      Parameters<OrdinaryCatalogueController['readPhoto']>
    >(async () => {
      throw new Error('Not requested by this presentation fixture');
    }),
    onPhotoCleanupFailure: jest.fn(),
    retry: jest.fn(),
    close: jest.fn(),
  } satisfies OrdinaryCatalogueController;
  let text = encodeRecentlyViewed({
    enabled: true,
    entries: recipes.map((recipe, index) => ({ ref: recipe.contentRef, openedAt: 1000 - index })),
  });
  const recent = createRecentlyViewedController(
    {
      read: async () => text,
      write: async (value) => {
        text = value;
      },
    },
    { now: () => 1000 },
  );
  controllers.push(recent);
  const tree = (
    <RecentlyViewedProvider controller={recent}>
      <OrdinaryCatalogueProvider controller={reader}>
        <RecentlyViewedRow />
      </OrdinaryCatalogueProvider>
    </RecentlyViewedProvider>
  );
  return {
    recent,
    reader,
    tree,
    retire: () =>
      act(() => {
        state = { kind: 'unavailable', scopeKey: 'retired', reason: 'revoked' };
        listeners.forEach((listener) => listener());
      }),
  };
}

test('Discover continuation resolves at most three exact versions and never writes an opening from its own reads', async () => {
  const f = fixture(),
    view = render(f.tree);
  await waitFor(() => expect(f.reader.readExact).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(view.getByText(recipes[0]!.title)).toBeTruthy());
  expect(view.queryByText(recipes[3]!.title)).toBeNull();
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
  const before = f.recent.getSnapshot().entries;
  fireEvent.press(view.getByRole('button', { name: `Open recently viewed ${recipes[0]!.title}` }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: {
      id: recipes[0]!.recipeId,
      contentRef: canonicalContentJson(recipes[0]!.contentRef, 1024),
    },
  });
  expect(f.recent.getSnapshot().entries).toEqual(before);
});

test('archived exact versions remain readable while withdrawn and missing versions never use old photos or current fallback', async () => {
  const f = fixture();
  f.reader.readExact.mockImplementation(async (ref) =>
    ref.recipeId === recipes[0]!.recipeId
      ? { kind: 'readable', state: 'archived', recipe: recipes[0]! }
      : ref.recipeId === recipes[1]!.recipeId
        ? { kind: 'withdrawn', recipeId: ref.recipeId }
        : { kind: 'missing' },
  );
  const view = render(f.tree);
  await waitFor(() => expect(view.getByText('Archived recipe')).toBeTruthy());
  expect(view.getByText('A recently viewed recipe has been withdrawn.')).toBeTruthy();
  expect(view.getByText('A recently viewed recipe version is unavailable.')).toBeTruthy();
  expect(view.queryByText(recipes[1]!.title)).toBeNull();
  expect(
    mockPhoto.mock.calls.every(([props]) => props.recipe?.recipeId === recipes[0]!.recipeId),
  ).toBe(true);
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
});

test('retired navigation cannot open the previous owner', async () => {
  const f = fixture(),
    view = render(f.tree);
  await waitFor(() => expect(view.getByText(recipes[0]!.title)).toBeTruthy());
  const open = view.getByRole('button', { name: `Open recently viewed ${recipes[0]!.title}` }).props
    .onPress;
  f.retire();
  act(() => open());
  expect(mockPush).not.toHaveBeenCalled();
  expect(view.queryByText(recipes[0]!.title)).toBeNull();
  expect(
    view.getByText(/cannot be checked while the recipe collection is unavailable/),
  ).toBeTruthy();
});

test('an exact read completed after retirement cannot reveal its old title or photo', async () => {
  const f = fixture();
  let finish: (value: ReadingLookup) => void = () => {
    throw new Error('Read not started');
  };
  f.reader.readExact.mockImplementation(
    () =>
      new Promise<ReadingLookup>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(f.tree);
  await waitFor(() => expect(f.reader.readExact).toHaveBeenCalledTimes(3));
  f.retire();
  await act(async () => {
    finish({ kind: 'readable', state: 'current', recipe: recipes[2]! });
  });
  expect(view.queryByText(recipes[2]!.title)).toBeNull();
  expect(mockPhoto).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

test('clearing recent history removes its row without touching the catalogue or cooking data', async () => {
  const f = fixture(),
    view = render(f.tree);
  await waitFor(() => expect(view.getByText(recipes[0]!.title)).toBeTruthy());
  await act(async () => {
    await f.recent.clear();
  });
  expect(view.queryByText('Recently viewed')).toBeNull();
  expect(f.reader.close).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});
