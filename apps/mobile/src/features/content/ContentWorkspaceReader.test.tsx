import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { ContentWorkspaceReader } from './ContentWorkspaceReader';
import type { ContentRecipeReader, ContentRecipeTarget } from './ContentRecipeReader';
import type {
  ContentUpdateIntent,
  ContentWorkspaceHost,
  ContentWorkspaceState,
} from './contentWorkspaceHost';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';

type ReaderProps = ComponentProps<typeof ContentRecipeReader>;
let mockReaderProps: ReaderProps | undefined;
const mockUnmount = jest.fn();
jest.mock('./ContentRecipeReader', () => ({
  ContentRecipeReader: (props: ReaderProps) => {
    mockReaderProps = props;
    const { Text } = jest.requireActual('react-native');
    jest.requireActual('react').useEffect(() => () => mockUnmount(props.scopeKey), []);
    return <Text testID="guarded-reader">Exact reader child</Text>;
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const target: ContentRecipeTarget = {
  kind: 'exact',
  ref: { recipeId: '90001', revisionId: 'retained-authored-1', contentFingerprint: 'a'.repeat(64) },
};
const onBack = jest.fn();

/** Controlled presentation port. Store verification, durable recovery and browser behavior are
 * independently tested; these cases establish only the consumer's forwarding and dispatch. */
function fixture(initial: ContentWorkspaceState['status'] = 'ready', opening = 'owner-opening') {
  const listeners = new Set<() => void>();
  let state: Readonly<ContentWorkspaceState> = Object.freeze({
    status: initial,
    scopeKey: `${opening}:1`,
    pending: null,
    cleanupPending: 0,
  });
  const forbidden = () =>
    jest.fn(async () => {
      throw new Error('This view must not dispatch a content mutation');
    });
  const content = {
    discover: forbidden(),
    readCurrent: forbidden(),
    readExact: forbidden(),
    readPhoto: forbidden(),
    readPhotos: forbidden(),
  };
  const commands = {
    reviewDirect: forbidden(),
    prepareDirect: forbidden(),
    execute: forbidden(),
    readReceipt: forbidden(),
    readDirectRecovery: forbidden(),
    acknowledgeDirectRecovery: forbidden(),
  };
  const delivery = {
    stage: forbidden(),
    readStage: forbidden(),
    discardStage: forbidden(),
    hydrate: forbidden(),
    review: forbidden(),
    activate: forbidden(),
  };
  const adoption = { readMealChoices: forbidden(), review: forbidden(), adopt: forbidden() };
  const clearHistory = {
    reviewClearHistory: forbidden(),
    clearHistory: forbidden(),
    readClearHistoryReceipt: forbidden(),
    resolveClearHistoryOperation: forbidden(),
  };
  const readerStore = { content, subscribe: jest.fn(() => () => undefined) };
  const notes = {
    readState: forbidden(),
    readRecipeNote: forbidden(),
    execute: forbidden(),
    readReceipt: forbidden(),
    resolveOperation: forbidden(),
    subscribe: jest.fn(() => () => undefined),
  };
  const manual = {
    readState: forbidden(),
    readManualShopping: forbidden(),
    execute: forbidden(),
    readReceipt: forbidden(),
    resolveOperation: forbidden(),
    subscribe: jest.fn(() => () => undefined),
  };
  const collections = {
    readCollections: forbidden(),
    readCollection: forbidden(),
    readRecipeMemberships: forbidden(),
    execute: forbidden(),
    reviewDeleteCollection: forbidden(),
    deleteCollection: forbidden(),
    readReceipt: forbidden(),
    resolveOperation: forbidden(),
    subscribe: jest.fn(() => () => undefined),
  };
  const sessions = {
    readSession: forbidden(),
    readResumeSession: forbidden(),
    saveSession: forbidden(),
    dismissSession: forbidden(),
    recover: forbidden(),
  };
  const cooked = {
    saveCooked: forbidden(),
    prepareCookedRecovery: forbidden(),
    readCookedRecovery: forbidden(),
    resolveCookedRecovery: forbidden(),
  };
  const host = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    content,
    commands,
    delivery,
    adoption,
    readerStore,
    notes,
    manual,
    collections,
    sessions,
    cooked,
    account: null,
    backup: { capture: forbidden(), inspect: forbidden() },
    restore: {
      review: forbidden(),
      prepare: forbidden(),
      execute: forbidden(),
      readReceipt: forbidden(),
      readArchive: forbidden(),
    },
    subscribeCooking: jest.fn(() => () => undefined),
    history: { readHistory: forbidden() },
    clearHistory,
    readInstallationId: forbidden(),
    queries: { readPlan: forbidden(), readShopping: forbidden(), readFavourites: forbidden() },
    onPhotoCleanupFailure: jest.fn((_resource: ContentPhotoResource) => undefined),
    retryPhotoCleanup: jest.fn(() => 0),
    close: jest.fn(async () => undefined),
    awaitClosed: jest.fn(async () => undefined),
    acknowledgeUpdate: jest.fn(async () => undefined),
    recoverUpdate: jest.fn(async () => null),
  } satisfies ContentWorkspaceHost;
  return {
    host,
    listeners,
    publish(status: ContentWorkspaceState['status'], pending: ContentUpdateIntent | null = null) {
      state = Object.freeze({
        ...state,
        status,
        pending,
        scopeKey: `${opening}:${state.scopeKey.split(':').at(-1)}:${status}`,
      });
      for (const listener of listeners) listener();
    },
    expectNoMutation() {
      for (const call of [
        ...Object.values(commands),
        ...Object.values(delivery),
        ...Object.values(adoption),
        ...Object.values(clearHistory),
        ...Object.values(notes),
        ...Object.values(manual),
        ...Object.values(collections),
        ...Object.values(sessions),
        ...Object.values(cooked),
        ...Object.values(host.backup),
        ...Object.values(host.restore),
      ])
        expect(call).not.toHaveBeenCalled();
    },
  };
}
function intent(kind: ContentUpdateIntent['kind']): ContentUpdateIntent {
  return {
    version: 1,
    kind,
    installationId: '10000000-0000-4000-8000-000000000001',
    ownerId: null,
    operationId: '10000000-0000-4000-8000-000000000002',
    fingerprint: 'b'.repeat(64),
  };
}
beforeEach(() => {
  mockReaderProps = undefined;
  jest.clearAllMocks();
});
afterEach(cleanup);

test('ready forwards the exact target, guarded reader store, scope and owned photo cleanup unchanged', () => {
  const f = fixture();
  const view = render(<ContentWorkspaceReader host={f.host} target={target} onBack={onBack} />);
  expect(view.getByTestId('guarded-reader')).toBeTruthy();
  expect(mockReaderProps?.target).toBe(target);
  expect(mockReaderProps?.store).toBe(f.host.readerStore);
  expect(mockReaderProps?.scopeKey).toBe(f.host.getSnapshot().scopeKey);
  expect(mockReaderProps?.onCleanupFailure).toBe(f.host.onPhotoCleanupFailure);
  expect(mockReaderProps?.onBack).toBe(onBack);
  const resource: ContentPhotoResource = {
    uri: 'blob:controlled-owned-resource',
    release: () => false,
  };
  mockReaderProps!.onCleanupFailure(resource);
  expect(f.host.onPhotoCleanupFailure).toHaveBeenCalledWith(resource);
  mockReaderProps!.onBack();
  expect(onBack).toHaveBeenCalledTimes(1);
  f.expectNoMutation();
});

test('updating, revoked and replacement-host status remove the old reader immediately', () => {
  const original = fixture();
  const replacement = fixture('updating', 'replacement-opening');
  const view = render(
    <ContentWorkspaceReader host={original.host} target={target} onBack={onBack} />,
  );
  act(() => original.publish('updating', intent('activation')));
  expect(view.queryByTestId('guarded-reader')).toBeNull();
  expect(view.getByText('Checking recipe content…')).toBeTruthy();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  act(() => original.publish('ready'));
  expect(view.getByTestId('guarded-reader')).toBeTruthy();
  view.rerender(<ContentWorkspaceReader host={replacement.host} target={target} onBack={onBack} />);
  expect(view.queryByTestId('guarded-reader')).toBeNull();
  expect(original.listeners.size).toBe(0);
  expect(mockUnmount).toHaveBeenCalledTimes(2);
  act(() => original.publish('ready'));
  expect(view.queryByTestId('guarded-reader')).toBeNull();
  act(() => replacement.publish('ready'));
  expect(mockReaderProps?.store).toBe(replacement.host.readerStore);
  expect(mockReaderProps?.scopeKey).toBe(replacement.host.getSnapshot().scopeKey);
  act(() => replacement.publish('revoked'));
  expect(view.queryByTestId('guarded-reader')).toBeNull();
  expect(view.getByText('This workspace is closed')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Continue' })).toBeNull();
  expect(mockUnmount).toHaveBeenCalledTimes(3);
  original.expectNoMutation();
  replacement.expectNoMutation();
});

test('recovery action checks the saved result only and never redispatches or acknowledges an unconfirmed update', async () => {
  const f = fixture('recovery_required');
  f.publish('recovery_required', intent('adoption'));
  const view = render(<ContentWorkspaceReader host={f.host} target={target} onBack={onBack} />);
  expect(view.queryByTestId('guarded-reader')).toBeNull();
  expect(view.getByText('Check the content update')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Continue' })).toBeNull();
  await act(async () => fireEvent.press(view.getByRole('button', { name: 'Check saved result' })));
  expect(f.host.recoverUpdate).toHaveBeenCalledTimes(1);
  expect(f.host.recoverUpdate).toHaveBeenCalledWith();
  expect(f.host.acknowledgeUpdate).not.toHaveBeenCalled();
  f.expectNoMutation();
});

test.each(['activation', 'adoption'] as const)(
  '%s result copy is accurate and Continue only acknowledges its saved result',
  async (kind) => {
    const f = fixture('result_ready');
    f.publish('result_ready', intent(kind));
    const view = render(<ContentWorkspaceReader host={f.host} target={target} onBack={onBack} />);
    expect(view.queryByTestId('guarded-reader')).toBeNull();
    expect(view.getByText('Recipe update verified')).toBeTruthy();
    if (kind === 'activation') {
      expect(
        view.getByText(
          'The release is verified on this device. Choosing whether to adopt it is a separate step. Your saved meal versions have not been replaced.',
        ),
      ).toBeTruthy();
      expect(view.queryByText(/Your reviewed recipe change is saved/)).toBeNull();
    } else {
      expect(
        view.getByText(
          'Your reviewed recipe change is saved. Continue to read the recipes in this workspace.',
        ),
      ).toBeTruthy();
      expect(view.queryByText(/Choosing whether to adopt it is a separate step/)).toBeNull();
    }
    expect(view.queryByRole('button', { name: 'Check saved result' })).toBeNull();
    f.host.acknowledgeUpdate.mockRejectedValueOnce(new Error('Controlled acknowledgement failure'));
    await act(async () => fireEvent.press(view.getByRole('button', { name: 'Continue' })));
    expect(view.getByText(/The saved result could not be acknowledged/)).toBeTruthy();
    await act(async () => fireEvent.press(view.getByRole('button', { name: 'Continue' })));
    expect(f.host.acknowledgeUpdate).toHaveBeenCalledTimes(2);
    expect(f.host.acknowledgeUpdate).toHaveBeenCalledWith();
    expect(f.host.recoverUpdate).not.toHaveBeenCalled();
    f.expectNoMutation();
  },
);
