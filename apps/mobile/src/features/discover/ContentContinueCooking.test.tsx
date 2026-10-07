import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  createBundledContentReader,
  canonicalContentJson,
  type ReadingRecipe,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import type { ContentCookingSessionView } from '../../data/contentCookingSessions';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
import { ContentContinueCooking } from './ContentContinueCooking';
import type { ContentCookingSessionRecoveryProps } from '../cooking/ContentCookingSessionRecovery';
import { Text } from 'react-native';

let mockRuntime: { host: object } | null;
let mockRecovery: ContentCookingSessionRecoveryProps | undefined;
const mockPush = jest.fn();
jest.mock('../content/ordinaryContentRuntimeContext', () => ({
  useOrdinaryContentRuntime: () => mockRuntime,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../content/ContentRecipePhoto', () => ({ ContentRecipePhoto: () => null }));
jest.mock('../cooking/ContentCookingSessionRecovery', () => ({
  ContentCookingSessionRecovery: (props: ContentCookingSessionRecoveryProps) => {
    mockRecovery = props;
    return null;
  },
}));
let recipe: Immutable<ReadingRecipe>;
beforeAll(async () => {
  recipe = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
beforeEach(() => {
  mockPush.mockClear();
  mockRecovery = undefined;
  mockRuntime = null;
});
afterEach(cleanup);
function fixture() {
  let state: { status: string; scopeKey: string } = { status: 'ready', scopeKey: 'owner1:head1' };
  const listeners = new Set<() => void>();
  let changed: (() => void) | undefined;
  const view: ContentCookingSessionView = {
    session: {
      readerVersion: 2,
      recipeId: recipe.recipeId,
      contentRef: recipe.contentRef,
      sessionId: '10000000-0000-4000-8000-000000000001',
      revision: 1,
      passageSequence: recipe.instructions[0]!.sequence,
      state: 'active',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastOperationId: '10000000-0000-4000-8000-000000000002',
    },
    pin: null,
    recipe,
    resume: 'exact',
  };
  const read = jest
    .fn<ReturnType<ContentWorkspaceHost['sessions']['readResumeSession']>, []>()
    .mockResolvedValue({ kind: 'ready', value: view, revision: 1 });
  const host = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    subscribeCooking: (fn: () => void) => {
      changed = fn;
      return () => {
        changed = undefined;
      };
    },
    sessions: { readResumeSession: read },
    content: {},
    onPhotoCleanupFailure: jest.fn(),
  };
  mockRuntime = { host };
  return {
    host,
    view,
    read,
    change: () => changed?.(),
    retire: () =>
      act(() => {
        state = { status: 'revoked', scopeKey: 'retired' };
        for (const fn of listeners) fn();
      }),
  };
}
test('Continue opens the full saved reference, and never routes late after retirement', async () => {
  const f = fixture(),
    screen = render(<ContentContinueCooking />);
  await waitFor(() => expect(screen.getByText(recipe.title)).toBeTruthy());
  const button = screen.getByRole('button', { name: 'Continue cooking' });
  fireEvent.press(button);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: {
      id: recipe.recipeId,
      contentRef: canonicalContentJson(recipe.contentRef, 1024),
      cook: 'resume',
    },
  });
  expect(mockRecovery?.view).toEqual(f.view);
  const current = mockRecovery!.isCurrent!;
  f.retire();
  expect(current()).toBe(false);
  expect(screen.queryByText(recipe.title)).toBeNull();
});
test('pending recovery stays mounted without an active session or a readable body', async () => {
  const f = fixture();
  f.read.mockResolvedValue({ kind: 'ready', value: null, revision: 1 });
  const screen = render(<ContentContinueCooking />);
  await waitFor(() => expect(f.read).toHaveBeenCalled());
  expect(mockRecovery?.host).toBe(f.host);
  expect(mockRecovery?.view).toBeNull();
  expect(screen.queryByText('CONTINUE COOKING')).toBeNull();
  f.read.mockResolvedValue({
    kind: 'ready',
    value: { ...f.view, recipe: null, resume: 'unavailable' },
    revision: 2,
  });
  await act(async () => f.change());
  expect(screen.getByText('Saved cooking progress')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Continue cooking' })).toBeNull();
  expect(mockRecovery?.view?.resume).toBe('unavailable');
});
test('late resume result cannot disclose the retired owner', async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<typeof f.read>>) => void;
  f.read.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const screen = render(<ContentContinueCooking />);
  await waitFor(() => expect(f.read).toHaveBeenCalled());
  f.retire();
  await act(async () => resolve({ kind: 'ready', value: f.view, revision: 1 }));
  expect(screen.queryByText(recipe.title)).toBeNull();
});
test('failed resume read keeps recovery and a retry instead of claiming empty progress', async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error('Unavailable'));
  const screen = render(<ContentContinueCooking />);
  await waitFor(() => expect(screen.getByText('Couldn’t load your cooking progress')).toBeTruthy());
  expect(mockRecovery?.view).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Retry cooking progress' }));
  await waitFor(() => expect(screen.getByText(recipe.title)).toBeTruthy());
});

test('recent fallback waits for no active session, preserves recovery, and never replaces an unavailable saved session', async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<typeof f.read>>) => void;
  f.read.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const screen = render(<ContentContinueCooking fallback={<Text>Recently viewed fixture</Text>} />);
  expect(screen.queryByText('Recently viewed fixture')).toBeNull();
  await act(async () => resolve({ kind: 'ready', value: null, revision: 1 }));
  expect(screen.getByText('Recently viewed fixture')).toBeTruthy();
  expect(mockRecovery?.host).toBe(f.host);
  expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValue({
    kind: 'ready',
    value: { ...f.view, recipe: null, resume: 'unavailable' },
    revision: 2,
  });
  await act(async () => f.change());
  expect(screen.getByText('Saved cooking progress')).toBeTruthy();
  expect(screen.queryByText('Recently viewed fixture')).toBeNull();
  f.read.mockRejectedValueOnce(new Error('unknown progress'));
  await act(async () => f.change());
  expect(screen.queryByText('Recently viewed fixture')).toBeNull();
});
