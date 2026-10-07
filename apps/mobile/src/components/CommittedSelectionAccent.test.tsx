import { Animated, Text } from 'react-native';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { CommittedSelectionAccent } from './CommittedSelectionAccent';
import { PurchaseRow } from '../features/shopping/PurchaseRow';
import { FavouriteButton, FavouritesProvider } from '../features/workspace/FavouritesState';
import { motionTokens } from '../design/motion';

let mockReduced = false;
let mockSaved = false;
let mockReady = true;
let mockFailed = false;
let mockHasPrevious = true;
const mockBegin = jest.fn();
const mockActions = { begin: mockBegin, blocked: false, restoreAfterRemoval: jest.fn() };
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));
jest.mock('../features/workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ actions: mockActions, restoreScreenFocus: jest.fn() }),
  useWorkspaceQuery: () => ({
    state: mockReady
      ? { kind: 'ready', value: mockSaved ? [{ recipeId: '52839' }] : [] }
      : {
          kind: mockFailed ? 'failed' : 'loading',
          ...(mockHasPrevious ? { previous: mockSaved ? [{ recipeId: '52839' }] : [] } : {}),
        },
    retry: jest.fn(),
  }),
}));

beforeEach(() => {
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  mockBegin.mockClear();
  mockReduced = false;
  mockSaved = false;
  mockReady = true;
  mockFailed = false;
  mockHasPrevious = true;
  mockActions.blocked = false;
});

test('purchase feedback waits for committed state and preserves the exact amount and action', () => {
  const toggle = jest.fn();
  const content = (purchased: boolean) => (
    <PurchaseRow
      name="Salt"
      amount="2 1/2 tsp"
      purchased={purchased}
      changed={false}
      onToggle={toggle}
    />
  );
  const view = render(content(false));
  fireEvent.press(screen.getByRole('checkbox', { name: 'Purchased Salt, 2 1/2 tsp' }));
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(Animated.timing).not.toHaveBeenCalled();
  // A failed or pending command leaves the authoritative prop unchanged.
  view.rerender(content(false));
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender(content(true));
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByText('2 1/2 tsp')).toBeTruthy();
  expect(Animated.timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: motionTokens.duration.micro, isInteraction: false }),
  );
  expect(toggle).toHaveBeenCalledTimes(1);
  view.rerender(content(false));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
});

test('compact favourite feedback follows the saved query and never starts from the save command', () => {
  const content = () => (
    <FavouritesProvider>
      <FavouriteButton recipeId="52839" title="Chilli prawn linguine" compact />
    </FavouritesProvider>
  );
  const view = render(content());
  fireEvent.press(screen.getByRole('button', { name: 'Save Chilli prawn linguine' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setFavourite', recipeId: '52839', saved: true },
    expect.objectContaining({ restoreFocus: expect.any(Function) }),
  );
  expect(screen.getByRole('button')).not.toBeSelected();
  expect(Animated.timing).not.toHaveBeenCalled();
  mockSaved = true;
  view.rerender(content());
  expect(screen.getByRole('button', { name: 'Unsave Chilli prawn linguine' })).toBeSelected();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
});

test('unavailable favourite state cannot celebrate a stale selection or replay on recovery', () => {
  const content = () => (
    <FavouritesProvider>
      <FavouriteButton recipeId="52839" title="Chilli prawn linguine" compact />
    </FavouritesProvider>
  );
  const view = render(content());
  mockReady = false;
  mockSaved = true;
  view.rerender(content());
  expect(screen.getByRole('button')).toBeDisabled();
  expect(Animated.timing).not.toHaveBeenCalled();
  mockReady = true;
  view.rerender(content());
  expect(screen.getByRole('button')).not.toBeDisabled();
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('the first favourite snapshot reveals a restored saved recipe without a success accent', () => {
  mockReady = false;
  mockHasPrevious = false;
  const content = () => (
    <FavouritesProvider>
      <FavouriteButton recipeId="52839" title="Chilli prawn linguine" compact />
    </FavouritesProvider>
  );
  const view = render(content());
  expect(screen.getByRole('button')).toBeDisabled();
  expect(screen.getByRole('button')).not.toBeSelected();
  mockReady = true;
  mockSaved = true;
  view.rerender(content());
  expect(screen.getByRole('button', { name: 'Unsave Chilli prawn linguine' })).toBeSelected();
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('query recovery establishes a new favourite baseline without celebrating recovered data', () => {
  const content = () => (
    <FavouritesProvider>
      <FavouriteButton recipeId="52839" title="Chilli prawn linguine" compact />
    </FavouritesProvider>
  );
  const view = render(content());
  mockReady = false;
  mockFailed = true;
  view.rerender(content());
  expect(screen.getByRole('button')).toBeDisabled();
  // Retrying first exposes the retained snapshot while the recovery query is loading.
  mockFailed = false;
  view.rerender(content());
  mockReady = true;
  mockSaved = true;
  view.rerender(content());
  expect(screen.getByRole('button')).toBeSelected();
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('a real save retains its baseline through pending work and accents only the committed query', () => {
  const content = () => (
    <FavouritesProvider>
      <FavouriteButton recipeId="52839" title="Chilli prawn linguine" compact />
    </FavouritesProvider>
  );
  const view = render(content());
  fireEvent.press(screen.getByRole('button', { name: 'Save Chilli prawn linguine' }));
  mockActions.blocked = true;
  mockReady = false;
  view.rerender(content());
  expect(screen.getByRole('button')).toBeDisabled();
  expect(screen.getByRole('button')).not.toBeSelected();
  expect(Animated.timing).not.toHaveBeenCalled();
  mockReady = true;
  mockSaved = true;
  view.rerender(content());
  expect(screen.getByRole('button')).toBeSelected();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
  mockActions.blocked = false;
  view.rerender(content());
  expect(screen.getByRole('button')).not.toBeDisabled();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
  expect(mockBegin).toHaveBeenCalledTimes(1);
});

test('restored selections and selections made while unavailable are immediate', () => {
  const content = (selected: boolean, enabled = true) => (
    <CommittedSelectionAccent selected={selected} enabled={enabled}>
      <Text>{selected ? 'Selected' : 'Unselected'}</Text>
    </CommittedSelectionAccent>
  );
  const view = render(content(true));
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender(content(false));
  view.rerender(content(true, false));
  expect(screen.getByText('Selected')).toBeTruthy();
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender(content(true));
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('reduced or background policy interrupts an accent without replay and unmount stops it', () => {
  const content = (selected: boolean) => (
    <CommittedSelectionAccent selected={selected}>
      <Text>{selected ? 'Selected' : 'Unselected'}</Text>
    </CommittedSelectionAccent>
  );
  const view = render(content(false));
  view.rerender(content(true));
  const animate = jest.mocked(Animated.timing);
  const scale = animate.mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(scale, 'stopAnimation');
  const set = jest.spyOn(scale, 'setValue');
  mockReduced = true;
  view.rerender(content(true));
  expect(stop).toHaveBeenCalled();
  expect(set).toHaveBeenLastCalledWith(1);
  view.rerender(content(false));
  view.rerender(content(true));
  expect(animate).toHaveBeenCalledTimes(1);
  mockReduced = false;
  view.rerender(content(true));
  expect(animate).toHaveBeenCalledTimes(1);
  stop.mockClear();
  view.unmount();
  expect(stop).toHaveBeenCalled();
});
