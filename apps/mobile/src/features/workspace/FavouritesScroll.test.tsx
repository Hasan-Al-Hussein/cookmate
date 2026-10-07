import { FlatList, Platform } from 'react-native';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { FavouritesScreen } from './FavouritesScreen';

let mockColumns = 2;
jest.mock('../../hooks/useNativeLayout', () => ({
  useNativeLayout: () => ({ columns: mockColumns, enlarged: mockColumns === 1 }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }) }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('./FavouritesState', () => ({
  useFavourites: () => ({
    state: {
      kind: 'ready',
      value: require('@cookmate/catalogue')
        .catalogue.recipes.slice(0, 12)
        .map((recipe: { recipeId: string }) => ({
          recipeId: recipe.recipeId,
          revision: 1,
          savedAt: '2026-10-01T00:00:00Z',
        })),
    },
    retry: jest.fn(),
  }),
}));
jest.mock('./WorkspaceFeedback', () => ({
  WorkspaceFeedback: () => null,
  QueryFeedback: () => null,
}));
jest.mock('../../components/RecipeCard', () => {
  const { Text } = require('react-native');
  return { RecipeCard: ({ recipe }: { recipe: { title: string } }) => <Text>{recipe.title}</Text> };
});

test.each(['wheel', 'pointerDown', 'keyDown', 'touchStart'])(
  'web %s input replaces an unreachable restoration target with the user position',
  (input) => {
    jest.replaceProperty(Platform, 'OS', 'web');
    mockColumns = 1;
    const view = render(<FavouritesScreen />);
    fireEvent.scroll(screen.UNSAFE_getByType(FlatList), {
      nativeEvent: { contentOffset: { y: 1000 } },
    });
    mockColumns = 2;
    view.rerender(<FavouritesScreen />);
    const shorter = screen.UNSAFE_getByType(FlatList);
    fireEvent(shorter, 'layout', { nativeEvent: { layout: { height: 740 } } });
    fireEvent(shorter, 'contentSizeChange', 428, 900);
    fireEvent(shorter, input);
    fireEvent.scroll(shorter, { nativeEvent: { contentOffset: { y: 90 } } });
    mockColumns = 1;
    view.rerender(<FavouritesScreen />);
    const longer = screen.UNSAFE_getByType(FlatList);
    const restore = jest.spyOn(longer.instance, 'scrollToOffset');
    fireEvent(longer, 'contentSizeChange', 320, 2000);
    expect(restore).toHaveBeenCalledWith({ offset: 90, animated: false });
  },
);
jest.mock('../../components/Page', () => ({
  Page: require('react-native').View,
  PageHeader: () => null,
  usePageStyles: () => ({}),
}));
jest.mock('../personal/PersonalUI', () => ({ usePersonalPorts: () => null }));
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  mockColumns = 2;
});

test('a two-to-one column remount restores the scrolled position after new content measures', () => {
  const view = render(<FavouritesScreen />);
  const original = screen.UNSAFE_getByType(FlatList);
  const originalInstance = original.instance;
  fireEvent.scroll(original, { nativeEvent: { contentOffset: { y: 380 } } });
  mockColumns = 1;
  view.rerender(<FavouritesScreen />);
  const current = screen.UNSAFE_getByType(FlatList);
  expect(current.instance).not.toBe(originalInstance);
  const restore = jest.spyOn(current.instance, 'scrollToOffset');
  fireEvent(current, 'layout', { nativeEvent: { layout: { height: 740 } } });
  // A remount can report zero before content layout; it must not overwrite the saved offset.
  fireEvent.scroll(current, { nativeEvent: { contentOffset: { y: 0 } } });
  fireEvent(current, 'contentSizeChange', 320, 740);
  fireEvent(current, 'contentSizeChange', 320, 2000);
  expect(restore).toHaveBeenCalledWith({ offset: 380, animated: false });
});
