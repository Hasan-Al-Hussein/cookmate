import { act, cleanup, render } from '@testing-library/react-native';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type { RecentlyViewedSnapshot } from './recentlyViewed';
import { useRecordRecentRecipe } from './useRecordRecentRecipe';

let mockFocused = false;
let mockFocus: (() => void | (() => void)) | undefined;
let mockBlur: (() => void) | undefined;
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(() => {
      mockFocus = callback;
      if (mockFocused) mockBlur = callback() || undefined;
      return () => {
        mockBlur?.();
        mockBlur = undefined;
        mockFocus = undefined;
      };
    }, [callback]),
}));
let mockSnapshot: RecentlyViewedSnapshot;
const mockRecord = jest.fn<Promise<boolean>, [RecipeContentRef, (() => boolean)?]>(
  async () => true,
);
jest.mock('./RecentlyViewedProvider', () => ({
  useRecentlyViewed: () => ({ ...mockSnapshot, recordOpen: mockRecord }),
}));
const ref = { recipeId: '52839', revisionId: 'bundled-one', contentFingerprint: 'a'.repeat(64) };
function Opened({
  body = ref,
  target = 'recipe-one',
  current = () => true,
}: {
  body?: RecipeContentRef | null;
  target?: string;
  current?: () => boolean;
}) {
  useRecordRecentRecipe({ visitKey: target, contentRef: body, isCurrent: current });
  return null;
}
beforeEach(() => {
  mockFocused = false;
  mockFocus = undefined;
  mockBlur = undefined;
  mockRecord.mockClear();
  mockSnapshot = { enabled: true, entries: [], hydrated: true, saving: false, error: null };
});
afterEach(cleanup);
const focus = () =>
  act(() => {
    mockFocused = true;
    mockBlur = mockFocus?.() || undefined;
  });
const blur = () =>
  act(() => {
    mockFocused = false;
    mockBlur?.();
    mockBlur = undefined;
  });

test('route preload does not record; a successful focused body records once across ordinary rerenders', async () => {
  const view = render(<Opened />);
  expect(mockRecord).not.toHaveBeenCalled();
  focus();
  await act(async () => {});
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(mockRecord.mock.calls[0]![0]).toEqual(ref);
  view.rerender(<Opened />);
  expect(mockRecord).toHaveBeenCalledTimes(1);
  blur();
  focus();
  expect(mockRecord).toHaveBeenCalledTimes(2);
});

test('preference hydration does not manufacture another focus visit', async () => {
  mockSnapshot = { ...mockSnapshot, hydrated: false, enabled: false };
  mockFocused = true;
  const view = render(<Opened />);
  expect(mockRecord).not.toHaveBeenCalled();
  mockSnapshot = { ...mockSnapshot, hydrated: true, enabled: true };
  view.rerender(<Opened />);
  await act(async () => {});
  expect(mockRecord).toHaveBeenCalledTimes(1);
  mockSnapshot = { ...mockSnapshot, saving: true };
  view.rerender(<Opened />);
  mockSnapshot = { ...mockSnapshot, saving: false };
  view.rerender(<Opened />);
  expect(mockRecord).toHaveBeenCalledTimes(1);
});

test('disabled collection is not retroactive when enabled during the same open visit', () => {
  mockSnapshot = { ...mockSnapshot, enabled: false };
  mockFocused = true;
  const view = render(<Opened />);
  mockSnapshot = { ...mockSnapshot, enabled: true };
  view.rerender(<Opened />);
  expect(mockRecord).not.toHaveBeenCalled();
  blur();
  focus();
  expect(mockRecord).toHaveBeenCalledTimes(1);
});

test('a late recipe body after blur or a retired owner cannot be recorded', () => {
  mockFocused = true;
  const view = render(<Opened body={null} />);
  blur();
  view.rerender(<Opened />);
  expect(mockRecord).not.toHaveBeenCalled();
  view.rerender(<Opened current={() => false} />);
  focus();
  expect(mockRecord).not.toHaveBeenCalled();
});

test('queued record admission rechecks focus, route and exact body at storage dispatch', () => {
  mockFocused = true;
  let current = true;
  const view = render(<Opened current={() => current} />);
  const guard = mockRecord.mock.calls[0]![1]!;
  expect(guard()).toBe(true);
  current = false;
  expect(guard()).toBe(false);
  current = true;
  view.rerender(<Opened body={{ ...ref, revisionId: 'different-version' }} />);
  expect(guard()).toBe(false);
  expect(mockRecord).toHaveBeenCalledTimes(1);
  blur();
  expect(guard()).toBe(false);
});
