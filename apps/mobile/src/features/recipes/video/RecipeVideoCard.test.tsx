import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import type { RecipeVideoPlayerProps } from './videoModel';
import { RecipeVideoCard } from './RecipeVideoCard';

let mockPlayer: RecipeVideoPlayerProps | undefined;
const mockUnmount = jest.fn();
let mockBlur: (() => void) | undefined;
jest.mock('./RecipeVideoPlayer', () => ({
  RecipeVideoPlayer: (props: RecipeVideoPlayerProps) => {
    mockPlayer = props;
    jest.requireActual('react').useEffect(() => () => mockUnmount(), []);
    const { View } = jest.requireActual('react-native');
    return <View testID="real-player-mounted" />;
  },
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => () => void) => {
    jest.requireActual('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '52839': 1, '53230': 2 } }));
const recipe = getRecipe('52839')!;
const onOpen = jest.fn();
beforeEach(() => {
  jest.useFakeTimers();
  mockPlayer = undefined;
  mockUnmount.mockClear();
  onOpen.mockClear();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
const tap = () =>
  fireEvent.press(screen.getByRole('button', { name: `Watch recipe video for ${recipe.title}` }));

test('compact instructions preview expands only on tap and returns after hiding the real player', () => {
  render(<RecipeVideoCard recipe={recipe} onOpenSource={onOpen} compact />);
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
  expect(screen.queryByText('Recipe video')).toBeNull();
  expect(screen.getByText('YouTube · Internet required')).toBeTruthy();
  tap();
  expect(mockPlayer!.videoId).toBe('SC17Mc70Db0');
  expect(screen.getAllByTestId('real-player-mounted')).toHaveLength(1);
  fireEvent.press(screen.getByRole('button', { name: 'Hide video' }));
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: `Watch recipe video for ${recipe.title}` }),
  ).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
});

test('does not mount any provider player until a deliberate tap; source identity is exact', () => {
  const view = render(<RecipeVideoCard recipe={recipe} onOpenSource={onOpen} />);
  expect(mockPlayer).toBeUndefined();
  expect(onOpen).not.toHaveBeenCalled();
  tap();
  expect(mockPlayer!.videoId).toBe('SC17Mc70Db0');
  expect(screen.getByText('Loading video…')).toBeTruthy();
  expect(screen.queryByText('Playing')).toBeNull();
  act(() => mockPlayer!.onStatus('playing'));
  expect(screen.getByText('Playing')).toBeTruthy();
  view.rerender(<RecipeVideoCard recipe={recipe} onOpenSource={onOpen} />);
  expect(mockUnmount).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Open on YouTube ↗' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(recipe.videoUrl);
});
test('bounded loading fails without automatic retry and supports a deliberate retry', () => {
  render(<RecipeVideoCard recipe={recipe} onOpenSource={onOpen} />);
  tap();
  act(() => jest.advanceTimersByTime(25000));
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
  expect(screen.getByText(/The video could not load/)).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(60000));
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Retry video' }));
  expect(screen.getByTestId('real-player-mounted')).toBeTruthy();
});
test('ready is not playing and unavailable/configuration errors are honest', () => {
  render(<RecipeVideoCard recipe={recipe} onOpenSource={onOpen} />);
  tap();
  act(() => mockPlayer!.onStatus('ready'));
  act(() => jest.advanceTimersByTime(30000));
  expect(screen.getByTestId('real-player-mounted')).toBeTruthy();
  expect(screen.queryByText('Playing')).toBeNull();
  act(() => mockPlayer!.onError('configuration'));
  expect(screen.getByText(/could not verify this player/)).toBeTruthy();
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Retry video' }));
  act(() => mockPlayer!.onError('unavailable'));
  expect(screen.getByText('This video cannot play here. Open it on YouTube instead.')).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
  act(() => mockBlur!());
  expect(screen.getByRole('button', { name: 'Open on YouTube ↗' })).toBeTruthy();
  expect(screen.queryByText('Watch recipe video')).toBeNull();
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
});
test('route blur and background tear down the player without automatic resume', () => {
  let background: ((state: AppStateStatus) => void) | undefined;
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, callback) => {
    background = callback as typeof background;
    return { remove };
  });
  const view = render(<RecipeVideoCard recipe={recipe} onOpenSource={onOpen} />);
  tap();
  act(() => mockBlur!());
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
  tap();
  act(() => background!('background'));
  act(() => background!('active'));
  expect(screen.queryByTestId('real-player-mounted')).toBeNull();
  view.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});
test('no-video and unsafe links stay local; an unsupported safe provider has an external fallback', () => {
  const view = render(
    <RecipeVideoCard recipe={{ ...recipe, videoUrl: null }} onOpenSource={onOpen} />,
  );
  expect(screen.getByText('No video supplied for this recipe.')).toBeTruthy();
  view.rerender(
    <RecipeVideoCard
      recipe={{ ...recipe, videoUrl: 'javascript:alert(1)' }}
      onOpenSource={onOpen}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(
    <RecipeVideoCard
      recipe={{ ...recipe, videoUrl: 'https://publisher.test/video' }}
      onOpenSource={onOpen}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Open video source ↗' }));
  expect(onOpen).toHaveBeenCalledWith('https://publisher.test/video');
  expect(mockPlayer).toBeUndefined();
});

test('exact-content mode suppresses bundled photo and treatment while preserving the supplied player and manual link', () => {
  const supplied = {
    recipeId: '53230',
    title: 'Exact supplied title',
    videoUrl: 'https://www.youtube.com/watch?v=C5n1fN8TGHs',
  };
  const view = render(<RecipeVideoCard recipe={supplied} compact onOpenSource={onOpen} />);
  expect(screen.getByLabelText(/Recipe photograph/)).toBeTruthy();
  expect(screen.getByText('Photo needs review')).toBeTruthy();
  view.rerender(
    <RecipeVideoCard recipe={supplied} compact useBundledPhoto={false} onOpenSource={onOpen} />,
  );
  expect(screen.queryByLabelText(/Recipe photograph/)).toBeNull();
  expect(screen.queryByText(/Photo needs review/)).toBeNull();
  fireEvent.press(
    screen.getByRole('button', { name: 'Watch recipe video for Exact supplied title' }),
  );
  expect(mockPlayer?.videoId).toBe('C5n1fN8TGHs');
  fireEvent.press(screen.getByRole('button', { name: 'Open on YouTube ↗' }));
  expect(onOpen).toHaveBeenLastCalledWith(supplied.videoUrl);
  view.rerender(
    <RecipeVideoCard
      recipe={{ ...supplied, videoUrl: 'https://publisher.test/exact-video' }}
      useBundledPhoto={false}
      onOpenSource={onOpen}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Open video source ↗' }));
  expect(onOpen).toHaveBeenLastCalledWith('https://publisher.test/exact-video');
});
