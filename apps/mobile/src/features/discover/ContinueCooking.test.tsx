import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { catalogue, getRecipe } from '@cookmate/catalogue';
import type { CookingService, CookingSessionView } from '@cookmate/domain';
import { ContinueCooking } from './ContinueCooking';
import { Text } from 'react-native';

const mockPush = jest.fn();
let mockService: Pick<CookingService, 'readResumeSession' | 'subscribe'> | undefined;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ availability: { kind: 'ready', services: { cooking: mockService } } }),
}));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
const source = getRecipe('52839')!;
const identity = {
  recipeId: source.recipeId,
  catalogue: catalogue.identity,
  contentFingerprint: 'a'.repeat(64),
  readerVersion: 1 as const,
};
const view: CookingSessionView = {
  currentContent: identity,
  passageSequences: source.instructions.map((p) => p.sequence),
  session: {
    ...identity,
    sessionId: 'session',
    revision: 4,
    passageSequence: 2,
    state: 'active',
    updatedAt: '2026-09-30T00:00:00.000Z',
    lastOperationId: 'operation',
  },
  resume: 'matching',
};
const ready = (value: CookingSessionView | null) => ({
  kind: 'ready' as const,
  value,
  revision: 4,
});
const read = jest.fn<
  ReturnType<CookingService['readResumeSession']>,
  Parameters<CookingService['readResumeSession']>
>();
let notify: (() => void) | undefined;
const unsubscribe = jest.fn();
beforeEach(() => {
  read.mockReset().mockResolvedValue(ready(view));
  mockPush.mockClear();
  unsubscribe.mockClear();
  notify = undefined;
  mockService = {
    readResumeSession: read,
    subscribe: (listener) => {
      notify = () => listener({ recipeId: source.recipeId, historyChanged: false, revision: 5 });
      return unsubscribe;
    },
  };
});
afterEach(cleanup);

test('shows only real active progress and opens the exact recipe on an explicit tap', async () => {
  render(<ContinueCooking />);
  await act(async () => {});
  expect(screen.getByText(source.title)).toBeTruthy();
  expect(mockPush).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Continue cooking' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: { id: source.recipeId, cook: 'resume' },
  });
  read.mockResolvedValue(ready(null));
  await act(async () => notify?.());
  expect(screen.queryByRole('button', { name: 'Continue cooking' })).toBeNull();
});

test('disabled feature is silent and does not query storage', async () => {
  mockService = undefined;
  render(<ContinueCooking />);
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByText('CONTINUE COOKING')).toBeNull();
});

test('changed content invites review rather than claiming an exact resumable place', async () => {
  read.mockResolvedValue(ready({ ...view, resume: 'content_changed' }));
  render(<ContinueCooking />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Review cooking progress' })).toBeTruthy();
  expect(screen.queryByText('Your reading place is saved on this device.')).toBeNull();
});

test('an older result cannot resurrect progress after a newer read found none', async () => {
  let resolveOld:
    | ((result: Awaited<ReturnType<CookingService['readResumeSession']>>) => void)
    | undefined;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const rendered = render(<ContinueCooking />);
  read.mockResolvedValue(ready(null));
  await act(async () => notify?.());
  await act(async () => resolveOld?.(ready(view)));
  expect(screen.queryByText('CONTINUE COOKING')).toBeNull();
  rendered.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('storage failure is retryable and is never presented as a saved place', async () => {
  read.mockRejectedValueOnce(new Error('unavailable'));
  render(<ContinueCooking />);
  await act(async () => {});
  expect(screen.getByText('Couldn’t load your cooking progress')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Continue cooking' })).toBeNull();
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Retry cooking progress' })),
  );
  expect(screen.getByRole('button', { name: 'Continue cooking' })).toBeTruthy();
});

test('recent continuation waits for the existing resume read and never replaces active or failed progress', async () => {
  let resolve!: (value: Awaited<ReturnType<CookingService['readResumeSession']>>) => void;
  read.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<ContinueCooking fallback={<Text>Recently viewed fixture</Text>} />);
  expect(screen.queryByText('Recently viewed fixture')).toBeNull();
  await act(async () => resolve(ready(null)));
  expect(screen.getByText('Recently viewed fixture')).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(ready(view));
  await act(async () => notify?.());
  expect(screen.queryByText('Recently viewed fixture')).toBeNull();
  expect(screen.getByText(source.title)).toBeTruthy();
  read.mockRejectedValueOnce(new Error('unknown progress'));
  await act(async () => notify?.());
  expect(screen.queryByText('Recently viewed fixture')).toBeNull();
  expect(screen.getByText('Couldn’t load your cooking progress')).toBeTruthy();
});
