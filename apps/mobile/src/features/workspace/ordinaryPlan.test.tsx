import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Modal } from 'react-native';
import { catalogue, getRecipe, type Immutable } from '@cookmate/catalogue';
import { createRecipeSearch } from '@cookmate/domain';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type {
  ContentPlanOccurrence,
  ContentPlanSnapshot,
} from '../../data/contentWorkspaceQueries';
import { ActionButton } from '../../components/Controls';
import { OrdinaryCatalogueProvider } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import type { ContentRecipePhoto } from '../content/ContentRecipePhoto';
import { PlanScreen } from './PlanScreen';
import PlanEditorScreen from './PlanEditorScreen';
import { ExactRecipePhoto } from './ExactRecipePhoto';
import type { QueryState } from './WorkspaceProvider';

let mockParams: Record<string, string> = {};
let mockScope = 'owner:head1';
let mockPlan: QueryState<ContentPlanSnapshot>;
const mockPush = jest.fn(),
  mockBegin = jest.fn();
const mockActions = { begin: mockBegin, blocked: false, restoreAfterRemoval: jest.fn() };
let mockPhoto: ComponentProps<typeof ContentRecipePhoto> | undefined;
const mockQueries: Array<{ key: string; start: string; end: string }> = [];
jest.mock('../content/useOrdinaryWorkspace', () => ({
  useOrdinaryWorkspaceActions: () => ({
    mode: 'content',
    scopeKey: mockScope,
    actions: mockActions,
    actionState: { kind: 'idle' },
    clock: { dateContext: () => ({ localDate: '2026-09-30' }) },
    restoreScreenFocus: jest.fn(),
    registerFocusFallback: () => () => undefined,
  }),
  useOrdinaryPlanQuery: (key: string, start: string, end: string) => {
    mockQueries.push({ key, start, end });
    return {
      mode: 'content',
      retry: jest.fn(),
      state:
        mockPlan.kind === 'ready'
          ? {
              ...mockPlan,
              value: {
                ...mockPlan.value,
                startDate: start,
                endDate: end,
                occurrences: mockPlan.value.occurrences.filter(
                  (entry) =>
                    entry.occurrence.placement.actualDate >= start &&
                    entry.occurrence.placement.actualDate <= end,
                ),
              },
            }
          : mockPlan,
    };
  },
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    push: mockPush,
    navigate: mockPush,
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
  }),
  useNavigation: () => ({ dispatch: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
jest.mock('./WorkspaceFeedback', () => ({
  WorkspaceFeedback: () => null,
  QueryFeedback: () => null,
}));
jest.mock('../shopping/ShoppingScreen', () => ({ ShoppingScreen: () => null }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../content/ContentRecipePhoto', () => ({
  ContentRecipePhoto: (props: ComponentProps<typeof ContentRecipePhoto>) => {
    mockPhoto = props;
    const { Text } = jest.requireActual('react-native');
    return <Text>{`Exact image: ${props.recipe.title}`}</Text>;
  },
}));

let packaged: Immutable<ReadingRecipe>;
beforeAll(async () => {
  packaged = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockScope = 'owner:head1';
  mockParams = {};
  mockPhoto = undefined;
  mockQueries.length = 0;
  mockActions.blocked = false;
  mockPlan = {
    kind: 'ready',
    revision: 1,
    value: {
      startDate: '2026-09-28',
      endDate: '2026-10-04',
      occurrences: [],
      shoppingScope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
    },
  };
});
afterEach(async () => {
  cleanup();
  await act(async () => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

// Controlled presentation ports. Signature/media verification remains in the real host suites.
function recipe(
  id = '90001',
  title = 'Current adopted supper',
  revisionId = 'current',
): Immutable<ReadingRecipe> {
  return {
    ...packaged,
    recipeId: id,
    title,
    contentRef: {
      recipeId: id,
      revisionId,
      contentFingerprint: (revisionId === 'old' ? 'b' : 'c').repeat(64),
    },
    contentKind: 'authored',
    media: [],
    retainedSources: [],
    annotations: [],
    videoUrl: null,
    ingredients: [],
    instructions: [],
    provenance: {
      kind: 'authored',
      authorId: 'Fixture author',
      createdAt: '2026-10-01T00:00:00.000Z',
      changeSummary: 'Presentation fixture',
      basedOn: null,
      credits: [],
    },
  };
}
function ready(
  recipes: readonly Immutable<ReadingRecipe>[],
  scopeKey = mockScope,
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
    current: (id) => recipes.find((entry) => entry.recipeId === id),
  };
}
function fixture(recipes = [recipe()], exact = recipes[0]!) {
  let state = ready(recipes);
  const listeners = new Set<() => void>();
  const reader = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: jest.fn(),
    close: jest.fn(),
    readCurrent: jest.fn(
      async (): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'current',
        recipe: recipes[0]!,
      }),
    ),
    readSavedIdentity: async () => ({ kind: 'missing' as const }),
    readExact: jest.fn(
      async (_ref: RecipeContentRef): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'historical',
        recipe: exact,
      }),
    ),
    readPhoto: jest.fn(async () => {
      throw new Error('No photo bytes in presentation fixture');
    }),
    onPhotoCleanupFailure: jest.fn(),
  } satisfies OrdinaryCatalogueController;
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
function meal(
  saved = recipe('90001', 'Saved original supper', 'old'),
  readable = true,
): ContentPlanOccurrence {
  return {
    occurrence: {
      occurrenceId: 'saved-meal',
      recipeId: saved.recipeId,
      revision: 1,
      createdAt: '2026-09-30T00:00:00Z',
      updatedAt: '2026-09-30T00:00:00Z',
      placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
    },
    contentRef: saved.contentRef,
    content: readable
      ? { kind: 'readable', state: 'historical', title: saved.title, photoAssetId: null }
      : { kind: 'unavailable', reason: 'withdrawn' },
  };
}
function setMeals(...occurrences: ContentPlanOccurrence[]) {
  mockPlan = {
    kind: 'ready',
    revision: 1,
    value: {
      startDate: '2026-09-28',
      endDate: '2026-10-04',
      occurrences,
      shoppingScope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
    },
  };
}
function editParams(saved = meal()) {
  mockParams = {
    recipeId: saved.occurrence.recipeId,
    occurrenceId: saved.occurrence.occurrenceId,
    date: saved.occurrence.placement.actualDate,
    meal: saved.occurrence.placement.mealKey,
    contentRef: JSON.stringify(saved.contentRef),
  };
}
function mount(f: ReturnType<typeof fixture>, editor = false) {
  return render(
    <OrdinaryCatalogueProvider controller={f.reader}>
      {editor ? <PlanEditorScreen /> : <PlanScreen />}
    </OrdinaryCatalogueProvider>,
  );
}

test('the ordinary plan opens the saved exact reference and shows its historical title/photo', async () => {
  const old = recipe('52839', 'Exact older dinner', 'old'),
    saved = meal(old),
    f = fixture([recipe('52839', 'Newer same-ID dinner')], old);
  setMeals(saved);
  const view = mount(f);
  await waitFor(() => expect(view.getByText(`Exact image: ${old.title}`)).toBeTruthy());
  expect(view.queryByText('Newer same-ID dinner')).toBeNull();
  expect(view.queryByText(getRecipe('52839')!.title)).toBeNull();
  fireEvent.press(view.getByRole('button', { name: old.title }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: { id: old.recipeId, contentRef: expect.any(String) },
  });
  expect(JSON.parse(mockPush.mock.calls[0]![0].params.contentRef)).toEqual(old.contentRef);
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
  fireEvent.press(view.getByRole('button', { name: /Meal options for Dinner/ }));
  fireEvent.press(view.getByRole('button', { name: 'Edit dinner' }));
  fireEvent(view.UNSAFE_getByType(Modal), 'dismiss');
  expect(JSON.parse(mockPush.mock.calls.at(-1)![0].params.contentRef)).toEqual(old.contentRef);
});

test('unavailable saved content retains the dated meal without substituting the bundled same-ID body', () => {
  const old = recipe('52839', 'Hidden historical title', 'old'),
    f = fixture([recipe('52839')]);
  setMeals(meal(old, false));
  const view = mount(f);
  expect(view.getByRole('button', { name: 'Saved recipe unavailable' })).toBeDisabled();
  expect(view.queryByText(getRecipe('52839')!.title)).toBeNull();
  expect(view.queryByText('Hidden historical title')).toBeNull();
  expect(f.reader.readExact).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: /Meal options for Dinner/ })).toBeEnabled();
});

test('a pending meal-menu action cannot navigate after its scope retires', () => {
  const f = fixture();
  setMeals(meal());
  const view = mount(f);
  fireEvent.press(view.getByRole('button', { name: /Meal options for Dinner/ }));
  fireEvent.press(view.getByRole('button', { name: 'Edit dinner' }));
  const dismiss = view.UNSAFE_getByType(Modal).props.onDismiss;
  mockScope = 'owner:head2';
  mockPlan = { kind: 'loading' };
  view.rerender(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <PlanScreen />
    </OrdinaryCatalogueProvider>,
  );
  act(() => dismiss());
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('moving a saved meal keeps its full older pin and blocks the same-ID newer picker version', async () => {
  const old = recipe('90001', 'Original saved supper', 'old'),
    saved = meal(old),
    current = recipe(),
    other = recipe('90002', 'Other current dish'),
    f = fixture([current, other], old);
  setMeals(saved);
  editParams(saved);
  const view = mount(f, true);
  await waitFor(() => expect(view.getByText(`Exact image: ${old.title}`)).toBeTruthy());
  expect(view.getByText(old.title)).toBeTruthy();
  expect(view.queryByText(current.title)).toBeNull();
  fireEvent.press(view.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.changeText(view.getByLabelText('Meal date in YYYY-MM-DD format'), '2026-10-02');
  fireEvent.press(view.getByRole('button', { name: 'Change recipe' }));
  expect(
    view.getByRole('button', { name: `${current.title} · ${current.cuisine}` }),
  ).toBeDisabled();
  fireEvent.press(view.getByRole('button', { name: 'Cancel' }));
  fireEvent.press(view.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    {
      kind: 'placeRecipe',
      recipeId: old.recipeId,
      occurrenceId: 'saved-meal',
      placement: { actualDate: '2026-10-02', mealKey: 'dinner' },
    },
    expect.objectContaining({ confirm: true }),
  );
  expect(
    mockQueries.some((item) => item.key.startsWith('meal-source:') && item.start === '2026-09-30'),
  ).toBe(true);
  expect(
    mockQueries.some(
      (item) => item.key.startsWith('meal-destination:') && item.start === '2026-10-02',
    ),
  ).toBe(true);
});

test('a distinct adopted-only recipe can replace the draft without a command until review', async () => {
  const old = recipe('90001', 'Saved old', 'old'),
    other = recipe('90002', 'Sumac autumn stew'),
    saved = meal(old),
    f = fixture([recipe(), other], old);
  setMeals(saved);
  editParams(saved);
  const view = mount(f, true);
  await waitFor(() => expect(view.getByText(`Exact image: ${old.title}`)).toBeTruthy());
  fireEvent.press(view.getByRole('button', { name: 'Change recipe' }));
  fireEvent.changeText(view.getByLabelText('Find a recipe for this meal'), 'Sumac autumn');
  fireEvent.press(view.getByRole('button', { name: `${other.title} · ${other.cuisine}` }));
  expect(view.getByText(other.title)).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(view.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin.mock.calls[0]![0]).toMatchObject({
    recipeId: '90002',
    occurrenceId: 'saved-meal',
  });
});

test('a new same-ID choice cannot silently replace an occupied older pin', () => {
  const saved = meal(),
    current = recipe(),
    f = fixture([current]);
  setMeals(saved);
  mockParams = {
    recipeId: current.recipeId,
    contentRef: JSON.stringify(current.contentRef),
    date: '2026-09-30',
    meal: 'dinner',
  };
  const view = mount(f, true);
  expect(view.getByText('A different version is already planned')).toBeTruthy();
  expect(view.getByText(/Dinner already has Saved original supper/)).toBeTruthy();
  expect(view.getByRole('button', { name: 'Review replacement' })).toBeDisabled();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('a stale exact editor route blocks review until an explicit fresh current choice', () => {
  const current = recipe(),
    f = fixture([current]);
  mockParams = {
    recipeId: current.recipeId,
    contentRef: JSON.stringify({ ...current.contentRef, revisionId: 'earlier' }),
    date: '2026-09-30',
  };
  const view = mount(f, true);
  expect(view.getByText('Recipe version changed')).toBeTruthy();
  expect(view.getByRole('button', { name: 'Review meal' })).toBeDisabled();
  fireEvent.press(view.getByRole('button', { name: 'Change recipe' }));
  fireEvent.press(view.getByRole('button', { name: `${current.title} · ${current.cuisine}` }));
  expect(view.queryByText('Recipe version changed')).toBeNull();
  expect(view.getByRole('button', { name: 'Review meal' })).toBeEnabled();
});

test('a changed saved pin refuses edit and never displays the current same-ID version', () => {
  const saved = meal(),
    f = fixture();
  setMeals({ ...saved, contentRef: { ...saved.contentRef, revisionId: 'changed' } });
  editParams(saved);
  const view = mount(f, true);
  expect(view.getByText('Saved meal changed')).toBeTruthy();
  expect(view.queryByText(recipe().title)).toBeNull();
  expect(view.getByRole('button', { name: 'Review meal' })).toBeDisabled();
  expect(f.reader.readExact).not.toHaveBeenCalled();
});

test('retained review and picker callbacks are inert after catalogue revocation without a bundled fallback', () => {
  const current = recipe('52839'),
    f = fixture([current]);
  mockParams = { recipeId: current.recipeId, date: '2026-09-30' };
  const view = mount(f, true);
  const submit = view
    .UNSAFE_getAllByType(ActionButton)
    .find((item) => item.props.label === 'Review meal')!.props.onPress;
  fireEvent.press(view.getByRole('button', { name: 'Change recipe' }));
  let pickerRow = view.getByRole('button', { name: `${current.title} · ${current.cuisine}` });
  while (typeof pickerRow.props.onPress !== 'function' && pickerRow.parent)
    pickerRow = pickerRow.parent;
  const pick = pickerRow.props.onPress;
  expect(typeof pick).toBe('function');
  f.set({ kind: 'unavailable', reason: 'revoked', scopeKey: mockScope });
  act(() => {
    submit();
    pick();
  });
  expect(mockBegin).not.toHaveBeenCalled();
  expect(view.queryByText(getRecipe('52839')!.title)).toBeNull();
  expect(view.queryByLabelText('Find a recipe for this meal')).toBeNull();
  expect(view.getByText('Recipes unavailable')).toBeTruthy();
  f.set(ready([current]));
  expect(view.queryByLabelText('Find a recipe for this meal')).toBeNull();
});

test('exact thumbnail ignores late retired results and blocks photo reads while retaining cleanup ownership', async () => {
  const old = recipe('90001', 'Older photo', 'old'),
    next = recipe('90002', 'New photo'),
    f = fixture([next], old);
  const view = render(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <ExactRecipePhoto contentRef={old.contentRef} />
    </OrdinaryCatalogueProvider>,
  );
  await waitFor(() => expect(mockPhoto?.recipe.title).toBe(old.title));
  const previous = mockPhoto!;
  let resolve!: (lookup: ReadingLookup) => void;
  f.reader.readExact.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  view.rerender(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <ExactRecipePhoto contentRef={next.contentRef} />
    </OrdinaryCatalogueProvider>,
  );
  expect(view.queryByText(`Exact image: ${old.title}`)).toBeNull();
  await expect(previous.content.readPhoto(old.contentRef, 'image')).rejects.toThrow();
  f.set({ kind: 'closed', scopeKey: mockScope });
  await act(async () => resolve({ kind: 'readable', state: 'historical', recipe: next }));
  expect(view.queryByText(`Exact image: ${next.title}`)).toBeNull();
  const resource = { uri: 'fixture:owned', release: () => false };
  previous.onCleanupFailure(resource);
  expect(f.reader.onPhotoCleanupFailure).toHaveBeenCalledWith(resource);
  expect(f.reader.readPhoto).not.toHaveBeenCalled();
});
