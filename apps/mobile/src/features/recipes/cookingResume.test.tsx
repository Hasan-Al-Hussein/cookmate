import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import RecipeDetailsScreen from './RecipeDetailsScreen';

let mockParams: { id: string; cook?: string } = { id: '52839' };
let mockEnabled = true;
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: () => true,
  setParams: jest.fn((params: { cook?: string }) => {
    mockParams = { ...mockParams, ...params };
  }),
};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../workspace/WorkspaceFeedback', () => ({ WorkspaceFeedback: () => null }));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    availability: { kind: 'ready', services: { cooking: mockEnabled ? {} : undefined } },
    actions: null,
    registerFocusFallback: () => () => undefined,
  }),
}));
jest.mock('./CookingReader', () => {
  const { Button, View } = jest.requireActual('react-native');
  return {
    CookingReader: ({ visible, onClose }: { visible: boolean; onClose: () => void }) =>
      visible ? (
        <View testID="resume-reader">
          <Button title="Close resumed reader" onPress={onClose} />
        </View>
      ) : null,
  };
});
jest.mock('./video/RecipeVideoPlayer', () => {
  const { View } = jest.requireActual('react-native');
  return { RecipeVideoPlayer: () => <View testID="resume-video" /> };
});
beforeEach(() => {
  mockParams = { id: '52839' };
  mockEnabled = true;
  mockRouter.setParams.mockClear();
});
afterEach(cleanup);

test('resume request uses the existing reader, consumes the request and does not reopen after closing', () => {
  mockParams.cook = 'resume';
  const view = render(<RecipeDetailsScreen />);
  expect(screen.getByTestId('resume-reader')).toBeTruthy();
  expect(mockRouter.setParams).toHaveBeenCalledWith({ cook: '', section: '' });
  expect(screen.queryByTestId('resume-video')).toBeNull();
  fireEvent.press(screen.getByText('Close resumed reader'));
  view.rerender(<RecipeDetailsScreen />);
  expect(screen.queryByTestId('resume-reader')).toBeNull();
});

test('resume cannot activate unsupported cooking storage and preserves the ordinary recipe view', () => {
  mockEnabled = false;
  mockParams.cook = 'resume';
  render(<RecipeDetailsScreen />);
  expect(screen.queryByTestId('resume-reader')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Ingredients' })).toBeSelected();
  expect(mockRouter.setParams).not.toHaveBeenCalled();
});

test('a resume request stops an already mounted video before showing the reader', () => {
  const view = render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  expect(screen.getByTestId('resume-video')).toBeTruthy();
  mockParams = { ...mockParams, cook: 'resume' };
  view.rerender(<RecipeDetailsScreen />);
  expect(screen.getByTestId('resume-reader')).toBeTruthy();
  expect(screen.queryByTestId('resume-video')).toBeNull();
});
