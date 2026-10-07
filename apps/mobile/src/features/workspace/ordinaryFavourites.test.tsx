import { act, cleanupAsync, fireEvent, render } from '@testing-library/react-native';
import type { ContentFavouriteEntry } from '../../data/contentWorkspaceQueries';
import type { QueryState } from './WorkspaceProvider';
import { FavouritesScreen } from './FavouritesScreen';
import { FavouritesProvider } from './FavouritesState';
import { contentFavouritesList } from './ordinaryFavouritesModel';
import { SavedRecipeRowFrame } from './SavedRecipeRow';
import { MotionPressable } from '../../components/MotionPressable';

const mockPush = jest.fn(),
  mockBegin = jest.fn(async () => undefined);
let mockScope = 'owner-a';
let mockState: QueryState<readonly ContentFavouriteEntry[]>;
const mockCatalogue = {
  state: { kind: 'ready', scopeKey: 'reader-a', identity: {} },
  reader: { getSnapshot: () => mockCatalogue.state },
};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../content/useOrdinaryWorkspace', () => ({
  useOrdinaryFavouritesQuery: () => ({ mode: 'content', state: mockState, retry: jest.fn() }),
  useOrdinaryWorkspaceActions: () => ({
    mode: 'content',
    scopeKey: mockScope,
    actions: { begin: mockBegin, blocked: false },
    registerFocusFallback: () => () => undefined,
  }),
}));
jest.mock('../content/OrdinaryCatalogue', () => ({
  useOptionalOrdinaryCatalogue: () => mockCatalogue,
}));
jest.mock('../../hooks/useActionFocus', () => ({
  useActionFocus: () => ({ ref: { current: null }, restoreFocus: jest.fn() }),
}));
jest.mock('../../hooks/useNativeLayout', () => ({
  useNativeLayout: () => ({ columns: 2, width: 428, enlarged: false, fontScale: 1 }),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('./WorkspaceFeedback', () => ({
  WorkspaceFeedback: () => null,
  QueryFeedback: () => null,
}));
jest.mock('../personal/PersonalUI', () => ({ usePersonalPorts: () => ({}) }));
jest.mock('./ExactRecipePhoto', () => ({ ExactRecipePhoto: () => null }));

function entry(
  id: string,
  title: string,
  state: 'current' | 'archived' = 'current',
): ContentFavouriteEntry {
  return {
    favourite: { recipeId: id, revision: 1, savedAt: `2026-10-01T00:00:00Z` },
    content: {
      kind: 'readable',
      state,
      title,
      cuisine: 'France',
      category: 'Soup',
      ingredientNames: ['Butter beans'],
      photoNeedsReview: false,
      contentRef: {
        recipeId: id,
        revisionId: `revision-${id}`,
        contentFingerprint: 'a'.repeat(64),
      },
    },
  };
}
const current = entry('99001', 'New authored supper');
const archived = entry('99002', 'Archived garden soup', 'archived');
const missing: ContentFavouriteEntry = {
  favourite: { recipeId: '99003', revision: 2, savedAt: '2026-09-30T00:00:00Z' },
  content: { kind: 'unavailable', reason: 'withdrawn' },
};
const App = () => (
  <FavouritesProvider>
    <FavouritesScreen />
  </FavouritesProvider>
);
beforeEach(() => {
  mockScope = 'owner-a';
  mockState = { kind: 'ready', value: [current, archived], revision: 1 };
});
afterEach(async () => {
  await cleanupAsync();
  jest.clearAllMocks();
});

test('authored and archived saved rows open the displayed exact version; only current can be planned', () => {
  const view = render(<App />);
  fireEvent.press(view.getByRole('button', { name: 'Open Archived garden soup, France' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: { id: '99002', contentRef: expect.any(String) },
  });
  expect(JSON.parse(mockPush.mock.calls[0]![0].params.contentRef)).toEqual(
    archived.content.kind === 'readable' && archived.content.contentRef,
  );
  expect(view.getAllByRole('button', { name: 'Plan this recipe' })).toHaveLength(1);
  expect(view.getByRole('button', { name: 'Your collections' })).toBeTruthy();
  fireEvent.press(view.getByRole('button', { name: 'Plan this recipe' }));
  expect(JSON.parse(mockPush.mock.calls[1]![0].params.contentRef)).toEqual(
    current.content.kind === 'readable' && current.content.contentRef,
  );
  fireEvent.press(view.getByRole('button', { name: 'Unsave Archived garden soup' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setFavourite', recipeId: '99002', saved: false },
    expect.any(Object),
  );
  expect(mockPush).toHaveBeenCalledTimes(2);
});

test('configured Collections entry opens its own route without changing favourites', () => {
  const view = render(<App />);
  fireEvent.press(view.getByRole('button', { name: 'Your collections' }));
  expect(mockPush).toHaveBeenCalledWith('/collections');
  expect(mockBegin).not.toHaveBeenCalled();
});

test('withdrawn saved rows remain counted and removable without opening a replacement recipe', () => {
  mockState = { kind: 'ready', value: [missing], revision: 2 };
  const view = render(<App />);
  expect(view.getByText('Saved recipe withdrawn')).toBeTruthy();
  expect(view.getByText(/1 saved recipe for/)).toBeTruthy();
  fireEvent.press(view.getByRole('button', { name: 'Unsave Recipe 99003' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setFavourite', recipeId: '99003', saved: false },
    expect.any(Object),
  );
  expect(mockPush).not.toHaveBeenCalled();
});

test('search uses saved authored ingredients and aliases; sorting retains unavailable identities', () => {
  expect(
    contentFavouritesList([missing, current, archived], 'alphabetical', '').map(
      (x) => x.favourite.recipeId,
    ),
  ).toEqual(['99002', '99001', '99003']);
  expect(
    contentFavouritesList([current, archived], 'recent', 'french butter').map(
      (x) => x.favourite.recipeId,
    ),
  ).toEqual(['99001', '99002']);
  expect(contentFavouritesList([missing], 'recent', '99003')).toEqual([missing]);
  expect(() => contentFavouritesList([current], 'recent', 'x'.repeat(4001))).toThrow(
    'Search is too long',
  );
});

test('owner change clears search and retained row navigation; pending rows cannot dispatch a save', async () => {
  const view = render(<App />);
  const priorOpen = view
    .UNSAFE_getAllByType(SavedRecipeRowFrame)
    .find((row) => row.props.title === 'New authored supper')!.props.onOpen;
  const priorSave = view
    .UNSAFE_getAllByType(MotionPressable)
    .find((button) => button.props.accessibilityLabel === 'Unsave New authored supper')!.props
    .onPress;
  fireEvent.press(view.getByRole('button', { name: 'Search saved recipes' }));
  fireEvent.changeText(view.getByLabelText('Search saved recipes'), 'new');
  mockScope = 'owner-b';
  mockState = { kind: 'ready', value: [archived], revision: 1 };
  view.rerender(<App />);
  await act(async () => {
    priorOpen();
    priorSave();
  });
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockBegin).not.toHaveBeenCalled();
  expect(view.queryByDisplayValue('new')).toBeNull();
  mockState = { kind: 'loading', previous: [archived] };
  view.rerender(<App />);
  expect(view.getByRole('button', { name: /Unsave Archived garden soup/ })).toBeDisabled();
});
