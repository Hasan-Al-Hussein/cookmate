import { StrictMode, useEffect, useState } from 'react';
import { AppState, Linking, Modal, Platform, type AppStateStatus } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { catalogue, getRecipe } from '@cookmate/catalogue';
import type {
  CommandResult,
  DateContext,
  LocalCommand,
  OperationReceipt,
  PlanOccurrence,
} from '@cookmate/contracts';
import type {
  CookMateServices,
  DirectActionReview,
  Favourite,
  Immutable,
  RepositoryResult,
  StoreChange,
} from '@cookmate/domain';
import { DirectActionController } from './directActionController';
import { WorkspaceProvider, useWorkspace, useWorkspaceQuery } from './WorkspaceProvider';
import { FavouriteButton, FavouritesProvider } from './FavouritesState';
import { FavouritesScreen } from './FavouritesScreen';
import { AppText } from '../../components/Typography';
import { formatPlanDate } from './runtimeClock';
import ShoppingSelectionScreen from '../shopping/ShoppingSelectionScreen';
import PlanEditorScreen from './PlanEditorScreen';
import { ActionConfirmation, QueryFeedback, WorkspaceFeedback } from './WorkspaceFeedback';
import { DirectRecoveryController } from './directRecoveryController';
import { useActionFocus } from '../../hooks/useActionFocus';
import { ActionButton } from '../../components/Controls';
import RecipeDetailsScreen from '../recipes/RecipeDetailsScreen';
import type { AssistantRuntime } from '../assistant/assistantRuntime';
import { PlanScreen } from './PlanScreen';

const mockParams: Record<string, string> = {};
const mockRouter = {
  push: jest.fn(),
  navigate: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: () => true,
};
const mockPreventRemove = jest.fn();
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (...args: unknown[]) => mockPreventRemove(...args),
}));

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ dispatch: jest.fn() }),
  useRouter: () => mockRouter,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  cleanup();
  jest.useRealTimers();
});
beforeEach(() => {
  jest.useFakeTimers();
  Object.keys(mockParams).forEach((key) => delete mockParams[key]);
});

const input = { kind: 'setFavourite', recipeId: '52839', saved: true } as const;
const review: Immutable<DirectActionReview> = Object.freeze({
  guard: { kind: 'none' as const },
  input,
  payload: input,
  consequences: { kind: 'favourite' as const, recipeId: input.recipeId, saved: true },
});
const command: Immutable<LocalCommand> = Object.freeze({
  schemaVersion: 2,
  operationId: 'ui-test-operation',
  userIntentId: 'ui-test-intent',
  intentRevision: 1,
  payloadFingerprint: 'a'.repeat(64),
  command: input,
});
const receipt: OperationReceipt = {
  schemaVersion: 1,
  operationId: command.operationId,
  userIntentId: command.userIntentId,
  payloadFingerprint: command.payloadFingerprint,
  outcome: 'committed',
  committedAt: '2026-09-28T04:30:00Z',
  effects: [{ kind: 'favourite', entityId: input.recipeId, revision: 1, saved: true }],
  shoppingProjection: 'unchanged',
};
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 1 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function serviceFixture() {
  const listeners = new Set<(change: StoreChange) => void>();
  const unsubscribe = jest.fn((listener: (change: StoreChange) => void) =>
    listeners.delete(listener),
  );
  const subscribe = jest.fn((listener: (change: StoreChange) => void) => {
    listeners.add(listener);
    return () => {
      unsubscribe(listener);
    };
  });
  const readPlan = jest
    .fn<
      ReturnType<CookMateServices['queries']['readPlan']>,
      Parameters<CookMateServices['queries']['readPlan']>
    >()
    .mockImplementation(async (startDate, endDate) =>
      ready({
        startDate,
        endDate,
        occurrences: [],
        shoppingScope: { scopeId: 'test-scope', revision: 0, occurrenceIds: [] },
      }),
    );
  const readFavourites = jest
    .fn<ReturnType<CookMateServices['queries']['readFavourites']>, []>()
    .mockResolvedValue(ready([]));
  const reviewDirect = jest
    .fn<
      ReturnType<CookMateServices['commands']['reviewDirect']>,
      Parameters<CookMateServices['commands']['reviewDirect']>
    >()
    .mockResolvedValue(ready(review));
  const prepareDirect = jest
    .fn<
      ReturnType<CookMateServices['commands']['prepareDirect']>,
      Parameters<CookMateServices['commands']['prepareDirect']>
    >()
    .mockResolvedValue(ready(command));
  const execute = jest
    .fn<Promise<CommandResult>, [Immutable<LocalCommand>]>()
    .mockResolvedValue({ kind: 'receipt', receipt });
  const readReceipt = jest
    .fn<ReturnType<CookMateServices['queries']['readReceipt']>, [string]>()
    .mockResolvedValue(ready(null));
  const close = jest.fn<Promise<void>, []>().mockResolvedValue();
  const services: CookMateServices = {
    queries: {
      catalogue: catalogue.identity,
      readInstallationId: async () => ready('test-installation'),
      readRecipe: async (id) => ready(catalogue.getRecipe(id) ?? null),
      readFavourites,
      readPlan,
      readShopping: async () =>
        ready({
          scope: { scopeId: 'test-scope', revision: 0, occurrenceIds: [] },
          selectedOccurrences: [],
          status: 'current',
          projectionRevision: 0,
          groups: [],
        }),
      readPreferences: async () => ready({ revision: 0, lastRemovalRevision: null, items: [] }),
      readPortableBackup: async () => ({
        kind: 'failed',
        error: {
          code: 'storage_failure',
          messageKey: 'backup.fixture_unavailable',
          retry: 'never',
        },
      }),
      readReceipt,
      readDirectRecovery: async () => ready({ entries: [], nextAfterSequence: null }),
      subscribeRecoveryInvalidation: () => () => undefined,
      subscribe,
    },
    commands: {
      reviewDirect,
      prepareDirect,
      execute,
      acknowledgeDirectRecovery: async () => ready(null),
    },
    assistant: () => {
      throw new Error('Assistant is outside this local UI test fixture');
    },
    close,
  };
  return {
    services,
    readFavourites,
    reviewDirect,
    prepareDirect,
    execute,
    readReceipt,
    close,
    readPlan,
    subscribe,
    unsubscribe,
    listenerCount: () => listeners.size,
    notify: (change: StoreChange) => listeners.forEach((listener) => listener(change)),
  };
}

function assistantLifecycleFixture() {
  const listeners = new Set<() => void>();
  const unsubscribe = jest.fn((listener: () => void) => listeners.delete(listener));
  const methods = {
    mutationsHeld: false,
    getSnapshot: () => null,
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        unsubscribe(listener);
      };
    }),
    setMutationGate: jest.fn(),
    start: jest.fn(),
    invalidate: jest.fn(),
    dispose: jest.fn<Promise<void>, []>().mockResolvedValue(),
    refreshForForeground: jest.fn<Promise<void>, []>().mockResolvedValue(),
    recovery: { check: jest.fn() },
  };
  // Only the Provider-facing runtime port is exercised; no provider/connection is constructed.
  return {
    ...methods,
    runtime: methods as unknown as AssistantRuntime,
    unsubscribe,
    listenerCount: () => listeners.size,
  };
}

function WorkspaceLifecycleProbe({ onAvailability }: { onAvailability?: (kind: string) => void }) {
  const state = useWorkspace();
  useEffect(() => {
    onAvailability?.(state.availability.kind);
  }, [onAvailability, state.availability]);
  return (
    <>
      <AppText>{`${state.availability.kind}:${state.actions ? 'actions' : 'none'}:${state.assistant ? 'assistant' : 'none'}:${state.recovery ? 'recovery' : 'none'}`}</AppText>
      <AppText>{`${state.actionState.kind}:${state.recoveryState.kind}`}</AppText>
      <AppText>{`Plan revision: ${state.revisions.plan}`}</AppText>
      {state.availability.kind === 'failed' && (
        <AppText>{state.availability.error.messageKey}</AppText>
      )}
      <ActionButton label="Retry workspace" onPress={state.retryOpen} />
    </>
  );
}

function WorkspaceQueryFeedbackProbe() {
  const { state, retry } = useWorkspaceQuery('feedback-plan', ['plan'], (services) =>
    services.queries.readPlan('2026-09-28', '2026-10-04'),
  );
  return <QueryFeedback state={state} retry={retry} noun="meal plan" />;
}

test.each([
  ['ios', 'Close and reopen CookMate to let it check your saved workspace again.'],
  ['web', 'Reload this page to let CookMate check your saved workspace again.'],
] as const)(
  'workspace feedback offers a %s restart after failed cleanup without retrying',
  async (platform, guidance) => {
    const surface = jest.replaceProperty(Platform, 'OS', platform);
    const f = serviceFixture();
    f.close.mockRejectedValue(new Error('Injected uncertain close'));
    const openStore = jest.fn(async () => ({ kind: 'ready' as const, services: f.services }));
    const onAvailability = jest.fn();
    try {
      render(
        <WorkspaceProvider
          openStore={openStore}
          createAssistant={() => {
            throw new Error('Injected factory failure');
          }}
        >
          <WorkspaceFeedback />
          <WorkspaceQueryFeedbackProbe />
          <WorkspaceLifecycleProbe onAvailability={onAvailability} />
        </WorkspaceProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('storage.cleanup_failed')).toBeTruthy();
      expect(screen.getByText(guidance)).toBeTruthy();
      expect(
        screen.getByText('Recipes remain available. Your saved data is still unconfirmed.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry device storage' })).toBeNull();
      expect(screen.getByText('Couldn’t load meal plan')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry loading meal plan' })).toBeNull();
      onAvailability.mockClear();
      fireEvent.press(screen.getByRole('button', { name: 'Retry workspace' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(onAvailability).not.toHaveBeenCalled();
      expect(openStore).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.reviewDirect).not.toHaveBeenCalled();
      expect(f.prepareDirect).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      cleanup();
      surface.restore();
    }
  },
);

test.each(['Retry device storage', 'Retry loading meal plan'] as const)(
  'workspace feedback recovers ordinary open failure through %s',
  async (retryLabel) => {
    const f = serviceFixture();
    const openStore = jest
      .fn()
      .mockResolvedValueOnce({
        kind: 'failed',
        error: {
          code: 'storage_failure',
          messageKey: 'storage.open_failed',
          retry: 'after_correction',
        },
      })
      .mockResolvedValue({ kind: 'ready', services: f.services });
    const view = render(
      <WorkspaceProvider openStore={openStore}>
        <WorkspaceFeedback />
        <WorkspaceQueryFeedbackProbe />
        <WorkspaceLifecycleProbe />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Device storage is unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry loading meal plan' })).toBeTruthy();
    expect(openStore).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByRole('button', { name: retryLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(openStore).toHaveBeenCalledTimes(2);
    expect(f.readPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByText('ready:actions:none:recovery')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry device storage' })).toBeNull();
    expect(f.reviewDirect).not.toHaveBeenCalled();
    expect(f.prepareDirect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.close).toHaveBeenCalledTimes(1);
  },
);

test('workspace feedback retries a failed query without reopening ready storage', async () => {
  const f = serviceFixture();
  f.readPlan.mockResolvedValueOnce({
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'test.read_failed', retry: 'after_correction' },
  });
  const openStore = jest.fn(async () => ({ kind: 'ready' as const, services: f.services }));
  const view = render(
    <WorkspaceProvider openStore={openStore}>
      <WorkspaceFeedback />
      <WorkspaceQueryFeedbackProbe />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.readPlan).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Retry loading meal plan' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.readPlan).toHaveBeenCalledTimes(2);
  expect(openStore).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Couldn’t load meal plan')).toBeNull();
  expect(f.reviewDirect).not.toHaveBeenCalled();
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('workspace feedback refuses direct retryOpen for a nonretryable open failure', async () => {
  const onAvailability = jest.fn();
  const openStore = jest.fn().mockResolvedValue({
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'storage.open_failed', retry: 'never' },
  });
  render(
    <WorkspaceProvider openStore={openStore}>
      <WorkspaceFeedback />
      <WorkspaceLifecycleProbe onAvailability={onAvailability} />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  onAvailability.mockClear();
  fireEvent.press(screen.getByRole('button', { name: 'Retry workspace' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(openStore).toHaveBeenCalledTimes(1);
  expect(onAvailability).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Retry device storage' })).toBeNull();
});

test.each(['factory', 'assistant subscription', 'store subscription', 'start'] as const)(
  'workspace lifecycle releases %s failure before retrying an open',
  async (fault) => {
    const first = serviceFixture();
    const next = serviceFixture();
    const assistant = assistantLifecycleFixture();
    const nextAssistant = assistantLifecycleFixture();
    const closing = deferred<void>();
    first.close.mockReturnValue(closing.promise);
    const fail = () => {
      throw new Error(`Injected ${fault} failure`);
    };
    if (fault === 'assistant subscription') assistant.subscribe.mockImplementationOnce(fail);
    if (fault === 'store subscription') first.subscribe.mockImplementationOnce(fail);
    if (fault === 'start') assistant.start.mockImplementationOnce(fail);
    const createAssistant = jest
      .fn()
      .mockImplementationOnce(fault === 'factory' ? fail : () => assistant.runtime)
      .mockReturnValue(nextAssistant.runtime);
    const openStore = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'ready', services: first.services })
      .mockResolvedValue({ kind: 'ready', services: next.services });
    const view = render(
      <WorkspaceProvider openStore={openStore} createAssistant={createAssistant}>
        <WorkspaceLifecycleProbe />
      </WorkspaceProvider>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(screen.getByText('failed:none:none:none')).toBeTruthy();
      expect(screen.getByText('idle:loading')).toBeTruthy();
      expect(first.listenerCount()).toBe(0);
      expect(assistant.listenerCount()).toBe(0);
      expect(assistant.dispose).toHaveBeenCalledTimes(fault === 'factory' ? 0 : 1);
      expect(assistant.unsubscribe).toHaveBeenCalledTimes(
        ['store subscription', 'start'].includes(fault) ? 1 : 0,
      );
      expect(first.unsubscribe).toHaveBeenCalledTimes(fault === 'start' ? 1 : 0);
      await act(async () => {
        assistant.subscribe.mock.calls[0]?.[0]();
        first.subscribe.mock.calls[0]?.[0]({ revision: 2, collections: ['plan'] });
      });
      expect(screen.getByText('failed:none:none:none')).toBeTruthy();
      expect(screen.getByText('Plan revision: 0')).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: 'Retry workspace' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(openStore).toHaveBeenCalledTimes(1);
      await act(async () => {
        closing.resolve();
      });
      expect(openStore).toHaveBeenCalledTimes(2);
      expect(screen.getByText('ready:actions:assistant:recovery')).toBeTruthy();
      await act(async () => {
        assistant.subscribe.mock.calls[0]?.[0]();
        first.subscribe.mock.calls[0]?.[0]({ revision: 3, collections: ['plan'] });
      });
      expect(screen.getByText('ready:actions:assistant:recovery')).toBeTruthy();
      expect(screen.getByText('Plan revision: 0')).toBeTruthy();
      expect(first.execute).not.toHaveBeenCalled();
      expect(next.execute).not.toHaveBeenCalled();
      view.unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(next.close).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        closing.resolve();
      });
      cleanup();
    }
  },
);

test('workspace lifecycle still closes the store after assistant disposal rejects', async () => {
  const f = serviceFixture();
  const assistant = assistantLifecycleFixture();
  assistant.dispose.mockRejectedValue(new Error('Injected dispose failure'));
  const view = render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      createAssistant={() => assistant.runtime}
    >
      <WorkspaceLifecycleProbe />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  view.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(assistant.dispose).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.listenerCount()).toBe(0);
  expect(assistant.listenerCount()).toBe(0);
  expect(f.execute).not.toHaveBeenCalled();
});

test('workspace lifecycle waits for disposal, then close, before retrying', async () => {
  const first = serviceFixture();
  const next = serviceFixture();
  const assistant = assistantLifecycleFixture();
  const disposing = deferred<void>();
  const closing = deferred<void>();
  const events: string[] = [];
  assistant.start.mockImplementationOnce(() => {
    throw new Error('Injected start failure');
  });
  assistant.dispose.mockImplementation(() => {
    events.push('dispose');
    return disposing.promise;
  });
  first.close.mockImplementation(() => {
    events.push('close');
    return closing.promise;
  });
  const openStore = jest
    .fn()
    .mockResolvedValueOnce({ kind: 'ready', services: first.services })
    .mockImplementation(async () => {
      events.push('open');
      return { kind: 'ready', services: next.services };
    });
  const createAssistant = jest
    .fn()
    .mockReturnValueOnce(assistant.runtime)
    .mockReturnValue(assistantLifecycleFixture().runtime);
  const view = render(
    <WorkspaceProvider openStore={openStore} createAssistant={createAssistant}>
      <WorkspaceLifecycleProbe />
    </WorkspaceProvider>,
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('failed:none:none:none')).toBeTruthy();
    expect(events).toEqual(['dispose']);
    fireEvent.press(screen.getByRole('button', { name: 'Retry workspace' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(openStore).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    await act(async () => {
      disposing.resolve();
    });
    expect(events).toEqual(['dispose', 'close']);
    expect(openStore).toHaveBeenCalledTimes(1);
    await act(async () => {
      closing.resolve();
    });
    expect(events).toEqual(['dispose', 'close', 'open']);
    expect(screen.getByText('ready:actions:assistant:recovery')).toBeTruthy();
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(assistant.dispose).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(next.close).toHaveBeenCalledTimes(1);
    expect(first.execute).not.toHaveBeenCalled();
    expect(next.execute).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      disposing.resolve();
      closing.resolve();
    });
    cleanup();
  }
});

test.each(['invalidate', 'unsubscribe'] as const)(
  'workspace lifecycle continues all releases after %s throws',
  async (fault) => {
    const f = serviceFixture();
    const assistant = assistantLifecycleFixture();
    const fail = () => {
      throw new Error(`Injected ${fault} failure`);
    };
    if (fault === 'invalidate') assistant.invalidate.mockImplementationOnce(fail);
    if (fault === 'unsubscribe') f.unsubscribe.mockImplementationOnce(fail);
    const view = render(
      <WorkspaceProvider
        openStore={async () => ({ kind: 'ready', services: f.services })}
        createAssistant={() => assistant.runtime}
      >
        <WorkspaceLifecycleProbe />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(assistant.invalidate).toHaveBeenCalledTimes(1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(assistant.unsubscribe).toHaveBeenCalledTimes(1);
    expect(assistant.dispose).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(assistant.listenerCount()).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  },
);

test.each(['dispose', 'close', 'invalidate', 'unsubscribe'] as const)(
  'workspace lifecycle does not reopen after queued %s cleanup is unconfirmed',
  async (fault) => {
    const f = serviceFixture();
    const assistant = assistantLifecycleFixture();
    const finishing = deferred<void>();
    assistant.start.mockImplementationOnce(() => {
      throw new Error('Injected start failure');
    });
    if (fault === 'dispose') assistant.dispose.mockReturnValue(finishing.promise);
    else f.close.mockReturnValue(finishing.promise);
    const failDetach = () => {
      throw new Error(`Injected ${fault} failure`);
    };
    if (fault === 'invalidate') assistant.invalidate.mockImplementationOnce(failDetach);
    if (fault === 'unsubscribe') f.unsubscribe.mockImplementationOnce(failDetach);
    const openStore = jest.fn(async () => ({ kind: 'ready' as const, services: f.services }));
    const view = render(
      <WorkspaceProvider openStore={openStore} createAssistant={() => assistant.runtime}>
        <WorkspaceLifecycleProbe />
      </WorkspaceProvider>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('failed:none:none:none')).toBeTruthy();
      expect(assistant.dispose).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(fault === 'dispose' ? 0 : 1);
      fireEvent.press(screen.getByRole('button', { name: 'Retry workspace' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(openStore).toHaveBeenCalledTimes(1);
      expect(screen.getByText('opening:none:none:none')).toBeTruthy();
      await act(async () => {
        if (fault === 'dispose' || fault === 'close')
          finishing.reject(new Error(`Injected uncertain ${fault}`));
        else finishing.resolve();
      });
      expect(screen.getByText('storage.cleanup_failed')).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: 'Retry workspace' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(openStore).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(assistant.dispose).toHaveBeenCalledTimes(1);
      expect(screen.getByText('failed:none:none:none')).toBeTruthy();
      expect(screen.getByText('storage.cleanup_failed')).toBeTruthy();
      expect(f.execute).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      await act(async () => {
        finishing.resolve();
      });
      cleanup();
    }
  },
);

test('workspace lifecycle closes a store that arrives after unmount without starting Assistant', async () => {
  const f = serviceFixture();
  const opening = deferred<{ kind: 'ready'; services: CookMateServices }>();
  const createAssistant = jest.fn();
  const view = render(
    <WorkspaceProvider openStore={() => opening.promise} createAssistant={createAssistant}>
      <AppText>Pending workspace</AppText>
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  view.unmount();
  await act(async () => {
    opening.resolve({ kind: 'ready', services: f.services });
  });
  expect(createAssistant).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.execute).not.toHaveBeenCalled();
});

test('workspace foreground refresh retains the viewed week until This week uses the changed clock', async () => {
  const callbacks = new Set<(state: AppStateStatus) => void>();
  const originalAddEventListener = AppState.addEventListener;
  AppState.addEventListener = jest.fn((_event, callback) => {
    callbacks.add(callback);
    return {
      remove: () => {
        callbacks.delete(callback);
      },
    };
  });
  const f = serviceFixture();
  const assistant = assistantLifecycleFixture();
  let dateContext: DateContext = {
    localDate: '2026-09-28',
    timeZone: 'Asia/Dubai',
    utcOffsetMinutes: 240,
  };
  const clock = { now: () => '2026-09-28T04:00:00Z', dateContext: () => dateContext };
  const openStore = jest.fn(async () => ({ kind: 'ready' as const, services: f.services }));
  try {
    const view = render(
      <WorkspaceProvider
        openStore={openStore}
        createAssistant={() => assistant.runtime}
        clock={clock}
      >
        <PlanScreen />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(callbacks.size).toBe(1);
    expect(f.readPlan).toHaveBeenCalledTimes(1);
    expect(f.readPlan).toHaveBeenLastCalledWith('2026-09-28', '2026-10-04');
    await act(async () => {
      callbacks.forEach((callback) => callback('inactive'));
      callbacks.forEach((callback) => callback('background'));
    });
    dateContext = { localDate: '2026-10-05', timeZone: 'Europe/London', utcOffsetMinutes: 60 };
    expect(f.readPlan).toHaveBeenCalledTimes(1);
    expect(assistant.refreshForForeground).not.toHaveBeenCalled();
    await act(async () => {
      callbacks.forEach((callback) => callback('active'));
    });
    expect(f.readPlan).toHaveBeenCalledTimes(2);
    expect(f.readPlan).toHaveBeenLastCalledWith('2026-09-28', '2026-10-04');
    expect(assistant.refreshForForeground).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Mon 28 Sep – Sunday 4 October 2026')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: /^Today$/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.readPlan).toHaveBeenCalledTimes(3);
    expect(f.readPlan).toHaveBeenLastCalledWith('2026-10-05', '2026-10-11');
    expect(screen.getByText('Mon 5 Oct – Sunday 11 October 2026')).toBeTruthy();
    expect(openStore).toHaveBeenCalledTimes(1);
    expect(assistant.refreshForForeground).toHaveBeenCalledTimes(1);
    expect(f.reviewDirect).not.toHaveBeenCalled();
    expect(f.prepareDirect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(callbacks.size).toBe(0);
  } finally {
    cleanup();
    AppState.addEventListener = originalAddEventListener;
  }
});

test('failed source opening retains the saved recipe and permits only a deliberate retry', async () => {
  const recipe = getRecipe('53076')!;
  mockParams.id = recipe.recipeId;
  const f = serviceFixture();
  f.readFavourites.mockResolvedValue(
    ready([{ recipeId: recipe.recipeId, revision: 1, savedAt: receipt.committedAt }]),
  );
  // Every external-open call stays mocked, including an unexpected extra retry.
  const open = jest
    .spyOn(Linking, 'openURL')
    .mockResolvedValue(true)
    .mockRejectedValueOnce(new Error('Injected external source failure'));
  const expectRecipeAvailable = () => {
    expect(screen.getByRole('header', { name: recipe.title })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Source' })).toBeSelected();
    expect(
      screen.getByRole('button', { name: 'Recipe collection, TheMealDB, opens external site' }),
    ).toBeEnabled();
    expect(screen.getByText('Original publisher link not supplied.')).toBeTruthy();
    const saved = screen.getByRole('button', { name: `Unsave ${recipe.title}` });
    expect(saved).toBeEnabled();
    expect(saved).toBeSelected();
  };
  const expectNoSideEffects = () => {
    expect(f.reviewDirect).not.toHaveBeenCalled();
    expect(f.prepareDirect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
  };
  try {
    render(
      <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
        <FavouritesProvider>
          <RecipeDetailsScreen />
        </FavouritesProvider>
      </WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.press(screen.getByRole('tab', { name: 'Source' }));
    expectRecipeAvailable();
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(
        screen.getByRole('button', { name: 'Recipe collection, TheMealDB, opens external site' }),
      );
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenNthCalledWith(1, recipe.recipePage);
    expect(screen.getByText('Couldn’t open this source')).toBeTruthy();
    expect(
      screen.getByText(
        'Your recipe is still available here. Check your connection and try opening the link again.',
      ),
    ).toBeTruthy();
    expectRecipeAvailable();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(open).toHaveBeenCalledTimes(1);
    expectNoSideEffects();
    await act(async () => {
      fireEvent.press(
        screen.getByRole('button', { name: 'Recipe collection, TheMealDB, opens external site' }),
      );
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(2, recipe.recipePage);
    expect(screen.queryByText('Couldn’t open this source')).toBeNull();
    expectRecipeAvailable();
    expectNoSideEffects();
    fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
    expect(screen.getByText('Make and enjoy')).toBeTruthy();
  } finally {
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    cleanup();
    open.mockRestore();
  }
});

test('cancelled review never registers or dispatches a command; rapid confirm uses exact reviewed object once', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  await controller.begin(input, { confirm: true });
  expect(f.prepareDirect).not.toHaveBeenCalled();
  controller.cancelReview();
  await controller.confirm();
  expect(f.execute).not.toHaveBeenCalled();
  await controller.begin(input, { confirm: true });
  await Promise.all([controller.confirm(), controller.confirm()]);
  expect(f.prepareDirect).toHaveBeenCalledTimes(1);
  expect(f.prepareDirect.mock.calls[0]![0]).toBe(review);
  expect(f.execute.mock.calls[0]![0]).toBe(command);
  expect(controller.state.kind).toBe('receipt');
});

function ClearReviewTrigger() {
  const { actions } = useWorkspace();
  return (
    <ActionButton
      label="Review saved conversation"
      onPress={() => void actions?.begin({ kind: 'clearConversation' }, { confirm: true })}
    />
  );
}

test.each([
  { title: 'empty', draft: 0, pending: 0, anything: false },
  { title: 'draft only', draft: 3, pending: 0, anything: true },
  { title: 'unverified proposals', draft: 0, pending: null, anything: true },
])(
  'clear review uses authoritative $title scope without treating zero messages as empty',
  async ({ draft, pending, anything }) => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    const f = serviceFixture();
    const reviewed: Immutable<DirectActionReview> = {
      guard: { kind: 'none' },
      input: { kind: 'clearConversation' },
      payload: {
        kind: 'clearConversation',
        conversationId: 'chat',
        expectedGeneration: 0,
        expectedScopeFingerprint: 'b'.repeat(64),
      },
      consequences: {
        kind: 'conversation_clear',
        conversationId: 'chat',
        generation: 0,
        messageCount: 0,
        scope: {
          draftCharacterCount: draft,
          referenceSetCount: 0,
          contextItemCount: 0,
          pendingProposalCount: pending,
          outstandingRequestCount: 0,
          hasAnythingToClear: anything,
        },
      },
    };
    f.reviewDirect.mockResolvedValue(ready(reviewed));
    try {
      render(
        <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
          <ClearReviewTrigger />
          <ActionConfirmation />
        </WorkspaceProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.press(screen.getByRole('button', { name: 'Review saved conversation' }));
      await act(async () => {
        await Promise.resolve();
      });
      const confirm = screen.getByRole('button', { name: /^Clear conversation$/ });
      if (anything) expect(confirm).toBeEnabled();
      else {
        expect(confirm).toBeDisabled();
        fireEvent.press(confirm);
        expect(f.prepareDirect).not.toHaveBeenCalled();
      }
      expect(screen.getByText('Your draft in this browser tab stays.')).toBeTruthy();
      if (pending === null) {
        expect(screen.getByText('Pending proposal count could not be verified')).toBeTruthy();
        expect(screen.queryByText('0 pending proposal groups')).toBeNull();
      }
      fireEvent.press(screen.getByRole('button', { name: /^Cancel$/ }));
      expect(f.prepareDirect).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      platform.restore();
    }
  },
);

test('confirmed clear invalidates the assistant immediately before dispatch, while cancelled clear does neither', async () => {
  const f = serviceFixture();
  const order: string[] = [];
  const clearReview: Immutable<DirectActionReview> = {
    guard: { kind: 'none' },
    input: { kind: 'clearConversation' },
    payload: { kind: 'clearConversation', conversationId: 'chat', expectedGeneration: 0 },
    consequences: {
      kind: 'conversation_clear',
      conversationId: 'chat',
      generation: 0,
      messageCount: 2,
      scope: {
        draftCharacterCount: 0,
        referenceSetCount: 0,
        contextItemCount: 0,
        pendingProposalCount: 0,
        outstandingRequestCount: 0,
        hasAnythingToClear: true,
      },
    },
  };
  const clearCommand: Immutable<LocalCommand> = { ...command, command: clearReview.payload };
  f.reviewDirect.mockResolvedValue(ready(clearReview));
  f.prepareDirect.mockResolvedValue(ready(clearCommand));
  f.execute.mockImplementation(async () => {
    order.push('dispatch');
    return { kind: 'receipt', receipt };
  });
  const controller = new DirectActionController(
    f.services,
    jest.fn(),
    () => null,
    (value) => {
      expect(value).toBe(clearCommand);
      order.push('invalidate');
    },
  );
  await controller.begin({ kind: 'clearConversation' }, { confirm: true });
  controller.cancelReview();
  expect(order).toEqual([]);
  await controller.begin({ kind: 'clearConversation' }, { confirm: true });
  await controller.confirm();
  expect(order).toEqual(['invalidate', 'dispatch']);
});

test('assistant hold blocks direct new/retry mutations but never blocks receipt reconciliation', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  controller.holdForAssistant(true);
  await controller.begin(input);
  expect(f.reviewDirect).not.toHaveBeenCalled();
  controller.holdForAssistant(false);
  f.execute.mockResolvedValueOnce({ kind: 'uncertain', operationId: command.operationId });
  await controller.begin(input);
  controller.holdForAssistant(true);
  await controller.reconcile();
  expect(f.readReceipt).toHaveBeenCalledWith(command.operationId);
  await controller.retryUncertain();
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test('confirmed direct mutation reserves before freshness and stops before prepare on a newly found blocker', async () => {
  const f = serviceFixture();
  const checking = deferred<import('@cookmate/contracts').ContractError | undefined>();
  const preflight = jest.fn(() => checking.promise);
  const finished = jest.fn();
  const controller = new DirectActionController(
    f.services,
    jest.fn(),
    () => null,
    () => undefined,
    preflight,
    finished,
  );
  await controller.begin(input, { confirm: true });
  expect(preflight).not.toHaveBeenCalled();
  const confirm = controller.confirm();
  expect(controller.blocked).toBe(true);
  expect(f.prepareDirect).not.toHaveBeenCalled();
  await controller.confirm();
  expect(preflight).toHaveBeenCalledTimes(1);
  checking.resolve({
    code: 'already_pending',
    messageKey: 'ui.resolve_earlier_change',
    retry: 'reconcile',
  });
  await confirm;
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(controller.state.kind).toBe('failed');
  expect(finished).toHaveBeenCalledTimes(1);
});

test('owned direct prepare-through-execute does not gate itself again after its write invalidates recovery', async () => {
  const f = serviceFixture();
  const preflight = jest.fn(async () => undefined);
  const controller = new DirectActionController(
    f.services,
    jest.fn(),
    () => null,
    () => undefined,
    preflight,
  );
  f.prepareDirect.mockImplementation(async () => {
    controller.holdForAssistant(true);
    return ready(command);
  });
  await controller.begin(input);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(controller.state.kind).toBe('receipt');
});

test('eligible uncertain retry probes without self-blocking and preserves uncertainty when freshness fails', async () => {
  const f = serviceFixture();
  const preflight = jest
    .fn<Promise<import('@cookmate/contracts').ContractError | undefined>, []>()
    .mockResolvedValue(undefined);
  const controller = new DirectActionController(
    f.services,
    jest.fn(),
    () => null,
    () => undefined,
    preflight,
  );
  f.execute.mockResolvedValueOnce({ kind: 'uncertain', operationId: command.operationId });
  await controller.begin(input);
  await controller.reconcile();
  preflight.mockResolvedValueOnce({
    code: 'storage_failure',
    messageKey: 'test.freshness',
    retry: 'reconcile',
  });
  await controller.retryUncertain();
  expect(controller.state.kind).toBe('uncertain');
  expect(f.execute).toHaveBeenCalledTimes(1);
  await controller.retryUncertain();
  expect(preflight).toHaveBeenCalledTimes(3);
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.execute.mock.calls[1]![0]).toBe(command);
});

test('a preference editor baseline change prevents preparation and preserves the newer saved set', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  f.reviewDirect.mockResolvedValue(
    ready({
      guard: { kind: 'none' },
      input: {
        kind: 'savePreference',
        preferenceId: 'p',
        type: 'cuisine',
        explicitValue: 'Italian',
      },
      payload: {
        kind: 'savePreference',
        preferenceId: 'p',
        type: 'cuisine',
        explicitValue: 'Italian',
        expectedPreferenceRevision: 3,
      },
      consequences: {
        kind: 'preference',
        before: { revision: 3, lastRemovalRevision: null, items: [] },
      },
    }),
  );
  await controller.begin(
    { kind: 'savePreference', preferenceId: 'p', type: 'cuisine', explicitValue: 'Italian' },
    { observedPreferenceRevision: 2 },
  );
  expect(controller.state.kind).toBe('failed');
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
test('rapid Save taps cannot create another command while review is pending', async () => {
  const f = serviceFixture();
  const pending = deferred<RepositoryResult<Immutable<DirectActionReview>>>();
  f.reviewDirect.mockReturnValueOnce(pending.promise);
  const controller = new DirectActionController(f.services, jest.fn());
  const first = controller.begin(input);
  await controller.begin(input);
  expect(f.reviewDirect).toHaveBeenCalledTimes(1);
  pending.resolve(ready(review));
  await first;
  expect(f.execute).toHaveBeenCalledTimes(1);
});
test('uncertain result requires receipt lookup and retries only the identical frozen command on explicit request', async () => {
  const f = serviceFixture();
  const refresh = jest.fn();
  const controller = new DirectActionController(f.services, refresh);
  f.execute.mockResolvedValueOnce({ kind: 'uncertain', operationId: command.operationId });
  await controller.begin(input);
  expect(controller.state.kind).toBe('uncertain');
  expect(refresh).not.toHaveBeenCalled();
  await controller.retryUncertain();
  expect(f.execute).toHaveBeenCalledTimes(1);
  await controller.begin({ ...input, saved: false });
  expect(f.reviewDirect).toHaveBeenCalledTimes(1);
  await controller.reconcile();
  expect(f.readReceipt).toHaveBeenCalledWith(command.operationId);
  expect(f.execute).toHaveBeenCalledTimes(1);
  await controller.retryUncertain();
  expect(f.execute.mock.calls[1]![0]).toBe(command);
  expect(f.prepareDirect).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});
test('a real saved receipt resolves uncertainty without replay, while mismatched receipt stays unconfirmed', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  f.execute.mockResolvedValueOnce({
    kind: 'receipt',
    receipt: { ...receipt, operationId: 'unrelated-operation' },
  });
  await controller.begin(input);
  expect(controller.state.kind).toBe('uncertain');
  f.readReceipt.mockResolvedValueOnce(ready(receipt));
  await controller.reconcile();
  expect(controller.state.kind).toBe('receipt');
  expect(f.execute).toHaveBeenCalledTimes(1);
});
test('stale failure renews review and requires another confirmation instead of replaying the command', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  f.execute.mockResolvedValueOnce({
    kind: 'failed',
    operationId: command.operationId,
    error: { code: 'stale_target', messageKey: 'test.stale', retry: 'after_correction' },
  });
  await controller.begin(input);
  await controller.retry();
  expect(controller.state.kind).toBe('confirmation');
  expect(f.reviewDirect).toHaveBeenCalledTimes(2);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
test('changed purchase demand forces confirmation even when an ordinary checkbox press could commit directly', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  const purchase = { kind: 'setPurchased', groupKey: 'ingredient', purchased: true } as const;
  f.reviewDirect.mockResolvedValueOnce(
    ready({
      guard: { kind: 'none' },
      input: purchase,
      payload: {
        ...purchase,
        scopeId: 'test-scope',
        expectedDemandFingerprint: 'b'.repeat(64),
        expectedRevision: 2,
      },
      consequences: {
        kind: 'purchase',
        groupKey: 'ingredient',
        displayName: 'Flour',
        quantityLabel: '600 g',
        purchased: true,
      },
    }),
  );
  await controller.begin(purchase, { observedDemandFingerprint: 'a'.repeat(64) });
  expect(controller.state.kind).toBe('confirmation');
  expect(f.prepareDirect).not.toHaveBeenCalled();
});
test('favourite heart stays unchanged until committed notification/read and remains saved during a slow refresh', async () => {
  const f = serviceFixture();
  const pending = deferred<CommandResult>();
  f.execute.mockReturnValueOnce(pending.promise);
  render(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <FavouritesProvider>
        <FavouriteButton recipeId={input.recipeId} title="Chilli prawn linguine" />
      </FavouritesProvider>
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const save = screen.getByRole('button', { name: 'Save Chilli prawn linguine' });
  fireEvent.press(save);
  await act(async () => {
    await Promise.resolve();
  });
  expect(save).toBeDisabled();
  expect(screen.queryByText('Saved · Unsave recipe')).toBeNull();
  const favourites: readonly Immutable<Favourite>[] = [
    { recipeId: input.recipeId, revision: 1, savedAt: receipt.committedAt },
  ];
  f.readFavourites.mockResolvedValue(ready(favourites));
  await act(async () => {
    f.notify({ revision: 1, collections: ['favourites'] });
    pending.resolve({ kind: 'receipt', receipt });
  });
  expect(screen.getByRole('button', { name: 'Unsave Chilli prawn linguine' })).toBeEnabled();
  const slowRead = deferred<RepositoryResult<readonly Immutable<Favourite>[]>>();
  f.readFavourites.mockReturnValueOnce(slowRead.promise);
  await act(async () => {
    f.notify({ revision: 2, collections: ['favourites'] });
  });
  expect(screen.getByText('Saved · Unsave recipe')).toBeTruthy();
  expect(screen.getByRole('button')).toBeDisabled();
});
test('failed or slow favourites read never renders the successful empty-state prompt', async () => {
  const f = serviceFixture();
  const pending = deferred<RepositoryResult<readonly Immutable<Favourite>[]>>();
  f.readFavourites.mockReturnValueOnce(pending.promise);
  render(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <FavouritesProvider>
        <FavouritesScreen />
      </FavouritesProvider>
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText('Keep your next good idea here.')).toBeNull();
  await act(async () =>
    pending.resolve({
      kind: 'failed',
      error: {
        code: 'storage_failure',
        messageKey: 'test.read_failure',
        retry: 'after_correction',
      },
    }),
  );
  expect(screen.getByText('Couldn’t load favourites')).toBeTruthy();
  expect(screen.queryByText('Keep your next good idea here.')).toBeNull();
});
test('saved search never includes unsaved catalogue matches and preserves its query through unsaving', async () => {
  const f = serviceFixture();
  const favourite = { recipeId: '52839', revision: 1, savedAt: receipt.committedAt };
  f.readFavourites.mockResolvedValue(ready([favourite]));
  render(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <FavouritesProvider>
        <FavouritesScreen />
      </FavouritesProvider>
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('button', { name: 'Search saved recipes' }));
  fireEvent.changeText(screen.getByLabelText('Search saved recipes'), 'Alfredo');
  expect(screen.getByText('No saved recipes match')).toBeTruthy();
  expect(screen.queryByText('Fettuccine Alfredo')).toBeNull();
  expect(f.execute).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Search saved recipes'), 'prawn');
  expect(screen.getAllByText('Chilli prawn linguine').length).toBeGreaterThan(0);
  fireEvent.press(screen.getByRole('button', { name: 'Plan this recipe' }));
  expect(mockRouter.push).toHaveBeenLastCalledWith({
    pathname: '/plan-edit',
    params: { recipeId: '52839' },
  });
  f.readFavourites.mockResolvedValue(ready([]));
  await act(async () => {
    f.notify({ collections: ['favourites'], revision: 2 });
  });
  expect(screen.getByLabelText('Search saved recipes').props.value).toBe('prawn');
  expect(screen.getByText('Keep your next good idea here.')).toBeTruthy();
  expect(screen.queryByText('No saved recipes match')).toBeNull();
});
test('larger saved collections expose search immediately and retain unavailable references', async () => {
  const f = serviceFixture();
  const favourites = [
    ...catalogue.recipes
      .slice(0, 6)
      .map((recipe) => ({ recipeId: recipe.recipeId, revision: 1, savedAt: receipt.committedAt })),
    { recipeId: 'missing', revision: 1, savedAt: receipt.committedAt },
  ];
  f.readFavourites.mockResolvedValue(ready(favourites));
  render(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <FavouritesProvider>
        <FavouritesScreen />
      </FavouritesProvider>
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByLabelText('Search saved recipes')).toBeTruthy();
  expect(screen.getByText('A saved recipe is unavailable')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search saved recipes'), 'zzzznomatch');
  expect(screen.getByText('No saved recipes match')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Clear saved search' }));
  expect(screen.getAllByText(catalogue.recipes[0]!.title).length).toBeGreaterThan(0);
  expect(screen.getByText('A saved recipe is unavailable')).toBeTruthy();
});
test('changing query key does not label a previous week snapshot as the newly selected week', async () => {
  const f = serviceFixture();
  const second = deferred<RepositoryResult<string>>();
  function Probe({ date }: { date: string }) {
    const { state } = useWorkspaceQuery(date, ['plan'], async () =>
      date === '2026-09-28' ? ready(date) : second.promise,
    );
    return (
      <AppText>{state.kind === 'ready' ? state.value : (state.previous ?? 'Loading')}</AppText>
    );
  }
  const view = render(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <Probe date="2026-09-28" />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText('2026-09-28')).toBeTruthy();
  view.rerender(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <Probe date="2026-10-05" />
    </WorkspaceProvider>,
  );
  expect(screen.queryByText('2026-09-28')).toBeNull();
  expect(screen.getByText('Loading')).toBeTruthy();
});
test('root provider closes the owned store and avoids duplicate StrictMode opens', async () => {
  const f = serviceFixture();
  const openStore = jest.fn(async () => ({ kind: 'ready' as const, services: f.services }));
  const view = render(
    <StrictMode>
      <WorkspaceProvider openStore={openStore}>
        <AppText>Workspace</AppText>
      </WorkspaceProvider>
    </StrictMode>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(openStore).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.close).toHaveBeenCalledTimes(1);
});
test('date display uses the date-only calendar across leap years and supported boundaries', () => {
  expect(formatPlanDate('2028-02-29')).toBe('Tuesday 29 February 2028');
  expect(formatPlanDate('1900-01-01')).toBe('Monday 1 January 1900');
  expect(formatPlanDate('2100-12-31')).toBe('Friday 31 December 2100');
});

test('owner transition drains the old store and remounts private child state before opening the next', async () => {
  const a = serviceFixture(),
    b = serviceFixture();
  const closed = deferred<void>();
  a.close.mockImplementation(() => closed.promise);
  const openA = jest.fn(async () => ({ kind: 'ready' as const, services: a.services }));
  const openB = jest.fn(async () => ({ kind: 'ready' as const, services: b.services }));
  function PrivateProbe() {
    const workspace = useWorkspace();
    const [privateDraft] = useState(`private ${workspace.workspaceKey}`);
    return (
      <AppText>{`${privateDraft} ${workspace.availability.kind} ${workspace.actions ? 'actions' : 'held'}`}</AppText>
    );
  }
  const view = render(
    <WorkspaceProvider workspaceKey="account:a" openStore={openA}>
      <PrivateProbe />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText('private account:a ready actions')).toBeTruthy();
  view.rerender(
    <WorkspaceProvider workspaceKey="account:b" openStore={openB}>
      <PrivateProbe />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText(/private account:a/)).toBeNull();
  expect(screen.getByText('private account:b opening held')).toBeTruthy();
  expect(a.close).toHaveBeenCalledTimes(1);
  expect(openB).not.toHaveBeenCalled();
  await act(async () => {
    closed.resolve();
    await Promise.resolve();
  });
  expect(openB).toHaveBeenCalledTimes(1);
  expect(screen.getByText('private account:b ready actions')).toBeTruthy();
});

const testClock = {
  now: () => receipt.committedAt,
  dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
};
const mealA: PlanOccurrence = {
  occurrenceId: 'meal-a',
  recipeId: '52839',
  placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
  revision: 1,
  createdAt: receipt.committedAt,
  updatedAt: receipt.committedAt,
};
const mealB: PlanOccurrence = {
  ...mealA,
  occurrenceId: 'meal-b',
  recipeId: '53064',
  placement: { actualDate: '2026-10-05', mealKey: 'lunch' },
};
const noShoppingEffects = {
  added: [],
  removed: [],
  demandChanged: [],
  unchanged: [],
  checkedMarksRequiringReview: 0,
  checkedMarksRemoved: 0,
};
function selectionReview(revision: number): Immutable<DirectActionReview> {
  return {
    guard: { kind: 'shopping_selection', planRevision: 1, shoppingScopeRevision: revision },
    input: { kind: 'setShoppingSelection', occurrenceIds: [mealA.occurrenceId] },
    payload: {
      kind: 'setShoppingSelection',
      occurrenceIds: [mealA.occurrenceId],
      expectedShoppingScopeRevision: revision,
    },
    consequences: {
      kind: 'shopping_selection',
      before: { scopeId: 'test-scope', revision, occurrenceIds: [mealA.occurrenceId] },
      afterOccurrenceIds: [mealA.occurrenceId],
      afterOccurrences: [mealA],
      shoppingEffects: noShoppingEffects,
    },
  };
}
function ShoppingReviewTrigger() {
  const { actions } = useWorkspace();
  return (
    <ActionButton
      label="Review shopping fixture"
      onPress={() =>
        void actions?.begin(
          { kind: 'setShoppingSelection', occurrenceIds: [] },
          { confirm: true, observedSelectionRevision: 1 },
        )
      }
    />
  );
}

test.each(['changed', 'unchanged', 'legacy'] as const)(
  'shopping review presents authoritative %s ingredient consequences without committing on cancel',
  async (kind) => {
    const f = serviceFixture();
    let reviewed = JSON.parse(JSON.stringify(selectionReview(1))) as DirectActionReview;
    if (reviewed.consequences.kind !== 'shopping_selection') throw new Error('Wrong test fixture');
    const facts = reviewed.consequences;
    if (kind === 'legacy') Reflect.deleteProperty(facts, 'shoppingEffects');
    if (kind === 'changed') {
      const state = { quantityLabel: '1 cup', purchased: true, changed: false };
      reviewed = {
        ...reviewed,
        consequences: {
          ...facts,
          shoppingEffects: {
            added: [
              {
                groupKey: 'a',
                displayName: 'New ingredient',
                before: null,
                after: { ...state, purchased: false },
              },
            ],
            removed: [
              { groupKey: 'b', displayName: 'Removed ingredient', before: state, after: null },
            ],
            demandChanged: [
              {
                groupKey: 'c',
                displayName: 'Changed ingredient',
                before: state,
                after: { quantityLabel: '2 cups', purchased: false, changed: true },
              },
            ],
            unchanged: [],
            checkedMarksRequiringReview: 1,
            checkedMarksRemoved: 1,
          },
        },
      };
    }
    f.reviewDirect.mockResolvedValue(ready(reviewed));
    render(
      <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
        <ShoppingReviewTrigger />
        <ActionConfirmation />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.press(screen.getByRole('button', { name: 'Review shopping fixture' }));
    await act(async () => {
      await Promise.resolve();
    });
    const confirm = screen.getByRole('button', { name: 'Update shopping list' });
    if (kind === 'legacy') {
      expect(confirm).toBeDisabled();
      expect(screen.getByText('Review the current shopping list again')).toBeTruthy();
    } else {
      expect(confirm).toBeEnabled();
      expect(
        screen.getByText('Your manually added items stay separate and are kept.'),
      ).toBeTruthy();
      if (kind === 'changed') {
        expect(screen.getByText('1 added · 1 removed · 1 changed')).toBeTruthy();
        expect(screen.getByText('Check changed ingredients again')).toBeTruthy();
        expect(screen.getByText(/If added again, they will be unchecked/)).toBeTruthy();
        fireEvent.press(screen.getByRole('button', { name: 'Review ingredient changes' }));
        expect(screen.getByText('Changed ingredient · Changed')).toBeTruthy();
        expect(screen.getByText('After: 2 cups')).toBeTruthy();
        expect(
          screen.getByText('Purchased mark will reset. Check this ingredient again.'),
        ).toBeTruthy();
        expect(
          screen.getByText('Previously purchased. If added again, this will be unchecked.'),
        ).toBeTruthy();
      } else
        expect(
          screen.getByText('Ingredient quantities and purchase marks stay as they are.'),
        ).toBeTruthy();
    }
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(f.prepareDirect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
test('selection transient review failure retains its observed draft revision through fresh retry', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  const selected = selectionReview(3);
  f.reviewDirect
    .mockResolvedValueOnce({
      kind: 'failed',
      error: { code: 'busy', messageKey: 'test.busy', retry: 'after_delay' },
    })
    .mockResolvedValueOnce(ready(selected));
  await controller.begin(selected.input, { confirm: true, observedSelectionRevision: 3 });
  await controller.retry();
  expect(controller.state.kind).toBe('confirmation');
  expect(f.prepareDirect).not.toHaveBeenCalled();
});
test('selection retry rejects a changed saved scope without preparing an old draft', async () => {
  const f = serviceFixture();
  const refresh = jest.fn();
  const controller = new DirectActionController(f.services, refresh);
  const selected = selectionReview(3);
  f.reviewDirect
    .mockResolvedValueOnce({
      kind: 'failed',
      error: { code: 'busy', messageKey: 'test.busy', retry: 'after_delay' },
    })
    .mockResolvedValueOnce(ready(selectionReview(4)));
  await controller.begin(selected.input, { confirm: true, observedSelectionRevision: 3 });
  await controller.retry();
  expect(controller.state).toMatchObject({
    kind: 'failed',
    error: { messageKey: 'ui.selection_draft_changed', retry: 'never' },
  });
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(1);
});
test('shopping draft retains selections across weeks and blocks an outdated draft until explicitly reloaded', async () => {
  const f = serviceFixture();
  let scopeRevision = 1;
  let selected = [mealA];
  jest.spyOn(f.services.queries, 'readPlan').mockImplementation(async (startDate, endDate) =>
    ready({
      startDate,
      endDate,
      occurrences: startDate === '2026-09-28' ? [mealA] : [mealB],
      shoppingScope: {
        scopeId: 'test-scope',
        revision: scopeRevision,
        occurrenceIds: selected.map((meal) => meal.occurrenceId),
      },
    }),
  );
  jest.spyOn(f.services.queries, 'readShopping').mockImplementation(async () =>
    ready({
      scope: {
        scopeId: 'test-scope',
        revision: scopeRevision,
        occurrenceIds: selected.map((meal) => meal.occurrenceId),
      },
      selectedOccurrences: selected,
      groups: [],
      status: 'current',
      projectionRevision: scopeRevision,
    }),
  );
  render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      clock={testClock}
    >
      <ShoppingSelectionScreen />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('button', { name: 'Review 1 selected meal' })).toBeEnabled();
  fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('checkbox', { name: /Chilli prawn linguine/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Fettuccine Alfredo/ })).not.toBeChecked();
  scopeRevision = 2;
  selected = [mealA, mealB];
  await act(async () => {
    f.notify({ revision: 2, collections: ['shopping'] });
  });
  expect(screen.getByText('Saved shopping selections changed')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review 1 selected meal' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Replace draft with saved selections' }));
  expect(screen.getByRole('button', { name: 'Review 2 selected meals' })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: /Fettuccine Alfredo/ })).toBeChecked();
  expect(f.prepareDirect).not.toHaveBeenCalled();
});
test('full meal edit reviews one atomic command, names vacated and replaced shopping consequences, and guards dirty navigation', async () => {
  const f = serviceFixture();
  Object.assign(mockParams, {
    occurrenceId: mealA.occurrenceId,
    recipeId: mealA.recipeId,
    date: mealA.placement.actualDate,
    meal: mealA.placement.mealKey,
  });
  const payload = {
    kind: 'movePlanReplacing',
    occurrenceId: mealA.occurrenceId,
    expectedRevision: 1,
    destinationOccurrenceId: mealB.occurrenceId,
    expectedDestinationRevision: 1,
    expectedShoppingScopeRevision: 1,
    recipeId: mealB.recipeId,
    placement: mealB.placement,
  } as const;
  const reviewed: Immutable<DirectActionReview> = {
    guard: { kind: 'none' },
    input: {
      kind: 'placeRecipe',
      occurrenceId: mealA.occurrenceId,
      recipeId: mealB.recipeId,
      placement: mealB.placement,
    },
    payload,
    consequences: {
      kind: 'plan',
      source: mealA,
      destination: mealB,
      resultRecipeId: mealB.recipeId,
      resultPlacement: mealB.placement,
      sourceSelected: false,
      destinationSelected: true,
      resultSelected: false,
      shoppingScope: { scopeId: 'test-scope', revision: 1, occurrenceIds: [mealB.occurrenceId] },
    },
  };
  const prepared: Immutable<LocalCommand> = { ...command, command: payload };
  f.reviewDirect.mockResolvedValue(ready(reviewed));
  f.prepareDirect.mockResolvedValue(ready(prepared));
  render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      clock={testClock}
    >
      <PlanEditorScreen />
      <ActionConfirmation />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.changeText(
    screen.getByLabelText('Meal date in YYYY-MM-DD format'),
    mealB.placement.actualDate,
  );
  fireEvent.press(screen.getByRole('tab', { name: 'Lunch' }));
  fireEvent.press(screen.getByRole('button', { name: 'Change recipe' }));
  const recipePicker = screen
    .UNSAFE_getAllByType(Modal)
    .find((node) => node.props.accessibilityLabel === 'Choose a recipe')!;
  fireEvent(recipePicker, 'show');
  fireEvent.changeText(screen.getByLabelText('Find a recipe for this meal'), 'Fettuccine Alfredo');
  fireEvent.press(screen.getByRole('button', { name: /Fettuccine Alfredo ·/ }));
  fireEvent(recipePicker, 'dismiss');
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('button', { name: /Review (meal|replacement)/ }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.reviewDirect.mock.calls[0]![0]).toEqual(reviewed.input);
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(screen.getByText(/The original slot becomes empty/)).toBeTruthy();
  expect(screen.getByText(/The replaced destination meal is removed from shopping/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Replace lunch' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.prepareDirect.mock.calls[0]![0]).toBe(reviewed);
  expect(f.execute.mock.calls[0]![0]).toBe(prepared);
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  fireEvent.press(screen.getByRole('button', { name: 'Dismiss confirmation' }));
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  fireEvent.changeText(
    screen.getByLabelText('Meal date in YYYY-MM-DD format'),
    mealA.placement.actualDate,
  );
  fireEvent.press(screen.getByRole('tab', { name: 'Dinner' }));
  fireEvent.press(screen.getByRole('button', { name: 'Change recipe' }));
  fireEvent(recipePicker, 'show');
  fireEvent.changeText(
    screen.getByLabelText('Find a recipe for this meal'),
    'Chilli prawn linguine',
  );
  fireEvent.press(screen.getByRole('button', { name: /Chilli prawn linguine ·/ }));
  fireEvent(recipePicker, 'dismiss');
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
});
test('confirmation dismissal calls the saved invoker focus callback without executing a cancelled review', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  const focus = jest.fn();
  await controller.begin(input, { confirm: true, restoreFocus: focus });
  controller.cancelReview();
  controller.restoreReviewFocus();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(f.execute).not.toHaveBeenCalled();
});
test('restored unresolved outcome holds new writes; actual result must be handled before release and never replays', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  const recovery = new DirectRecoveryController(f.services, controller);
  const entry = {
    sequence: 1,
    operationId: 'prior-operation',
    userIntentId: 'prior-intent',
    commandKind: 'setFavourite' as const,
    phase: 'reconciling' as const,
    outcome: 'unresolved' as const,
    receipt: null,
  };
  const read = jest
    .spyOn(f.services.queries, 'readDirectRecovery')
    .mockResolvedValueOnce(ready({ entries: [entry], nextAfterSequence: null }));
  const acknowledge = jest.spyOn(f.services.commands, 'acknowledgeDirectRecovery');
  await recovery.check();
  await controller.begin(input);
  await recovery.dismiss(entry.operationId);
  expect(controller.blocked).toBe(true);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(f.reviewDirect).not.toHaveBeenCalled();
  read
    .mockResolvedValueOnce(
      ready({
        entries: [
          {
            ...entry,
            outcome: 'receipt',
            receipt: {
              ...receipt,
              operationId: entry.operationId,
              userIntentId: entry.userIntentId,
            },
          },
        ],
        nextAfterSequence: null,
      }),
    )
    .mockResolvedValueOnce(ready({ entries: [], nextAfterSequence: null }));
  await recovery.check();
  expect(controller.blocked).toBe(true);
  await recovery.dismiss(entry.operationId);
  expect(acknowledge).toHaveBeenCalledWith(entry.operationId);
  expect(controller.blocked).toBe(false);
  expect(f.execute).not.toHaveBeenCalled();
});
test('failed recovery read is never treated as an empty recovered workspace', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  const recovery = new DirectRecoveryController(f.services, controller);
  jest.spyOn(f.services.queries, 'readDirectRecovery').mockResolvedValueOnce({
    kind: 'failed',
    error: {
      code: 'storage_failure',
      messageKey: 'test.recovery_failed',
      retry: 'after_correction',
    },
  });
  await recovery.check();
  expect(recovery.state.kind).toBe('failed');
  expect(controller.blocked).toBe(true);
  await controller.begin(input);
  expect(f.execute).not.toHaveBeenCalled();
});

test('a saved shopping draft gets a local committed baseline and subsequent edits are guarded while its receipt remains', async () => {
  const f = serviceFixture();
  let selected = [mealA];
  let revision = 1;
  jest.spyOn(f.services.queries, 'readPlan').mockImplementation(async (startDate, endDate) =>
    ready({
      startDate,
      endDate,
      occurrences: [mealA, { ...mealB, placement: { actualDate: '2026-09-29', mealKey: 'lunch' } }],
      shoppingScope: {
        scopeId: 'test-scope',
        revision,
        occurrenceIds: selected.map((entry) => entry.occurrenceId),
      },
    }),
  );
  jest.spyOn(f.services.queries, 'readShopping').mockImplementation(async () =>
    ready({
      scope: {
        scopeId: 'test-scope',
        revision,
        occurrenceIds: selected.map((entry) => entry.occurrenceId),
      },
      selectedOccurrences: selected,
      groups: [],
      status: 'current',
      projectionRevision: revision,
    }),
  );
  const after = [mealA.occurrenceId, mealB.occurrenceId];
  const reviewed: Immutable<DirectActionReview> = {
    ...selectionReview(1),
    input: { kind: 'setShoppingSelection', occurrenceIds: after },
    payload: {
      kind: 'setShoppingSelection',
      expectedShoppingScopeRevision: 1,
      occurrenceIds: after,
    },
    consequences: {
      kind: 'shopping_selection',
      before: { scopeId: 'test-scope', revision: 1, occurrenceIds: [mealA.occurrenceId] },
      afterOccurrenceIds: after,
      afterOccurrences: [mealA, mealB],
      shoppingEffects: noShoppingEffects,
    },
  };
  f.reviewDirect.mockResolvedValue(ready(reviewed));
  f.execute.mockImplementationOnce(async () => {
    selected = [mealA, mealB];
    revision = 2;
    f.notify({ revision, collections: ['shopping'] });
    return {
      kind: 'receipt',
      receipt: {
        ...receipt,
        effects: [{ kind: 'shopping_selection', entityId: 'test-scope', revision }],
      },
    };
  });
  render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      clock={testClock}
    >
      <ShoppingSelectionScreen />
      <ActionConfirmation />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('checkbox', { name: /Fettuccine Alfredo/ }));
  fireEvent.press(screen.getByRole('button', { name: 'Review 2 selected meals' }));
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('button', { name: 'Update shopping list' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText('Saved shopping selections changed')).toBeNull();
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  fireEvent.press(screen.getByRole('checkbox', { name: /Fettuccine Alfredo/ }));
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
  fireEvent.press(screen.getByRole('button', { name: 'Dismiss confirmation' }));
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
});
test('a draft-only meal absent from its freshly read week is marked changed and cannot be submitted from cache', async () => {
  const f = serviceFixture();
  let records = [mealA];
  jest.spyOn(f.services.queries, 'readPlan').mockImplementation(async (startDate, endDate) =>
    ready({
      startDate,
      endDate,
      occurrences: records,
      shoppingScope: { scopeId: 'test-scope', revision: 0, occurrenceIds: [] },
    }),
  );
  render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      clock={testClock}
    >
      <ShoppingSelectionScreen />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('checkbox', { name: /Chilli prawn linguine/ }));
  records = [];
  await act(async () => {
    f.notify({ revision: 2, collections: ['plan'] });
  });
  expect(screen.getByText('A draft meal changed or moved')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review 1 selected meal' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: /Remove changed draft meal:/ }));
  expect(screen.getByRole('button', { name: 'Review 0 selected meals' })).toBeEnabled();
  expect(f.reviewDirect).not.toHaveBeenCalled();
});
test('a disappearing confirmation invoker falls back to the surviving screen focus callback', async () => {
  const f = serviceFixture();
  const fallback = jest.fn();
  function Probe() {
    const focus = useActionFocus();
    const { registerFocusFallback } = useWorkspace();
    const [visible, setVisible] = useState(true);
    useEffect(() => registerFocusFallback(fallback), [registerFocusFallback]);
    return (
      <>
        {visible && (
          <ActionButton ref={focus.ref} label="Invoker" onPress={() => setVisible(false)} />
        )}
        <ActionButton label="Restore focus" onPress={() => focus.restoreFocus()} />
      </>
    );
  }
  render(
    <WorkspaceProvider openStore={async () => ({ kind: 'ready', services: f.services })}>
      <Probe />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('button', { name: 'Invoker' }));
  fireEvent.press(screen.getByRole('button', { name: 'Restore focus' }));
  expect(fallback).toHaveBeenCalledTimes(1);
});
test('a recovery receipt with mismatched identity is held as unresolved and cannot be dismissed', async () => {
  const f = serviceFixture();
  const controller = new DirectActionController(f.services, jest.fn());
  const recovery = new DirectRecoveryController(f.services, controller);
  const acknowledge = jest.spyOn(f.services.commands, 'acknowledgeDirectRecovery');
  jest.spyOn(f.services.queries, 'readDirectRecovery').mockResolvedValueOnce(
    ready({
      entries: [
        {
          sequence: 1,
          operationId: 'other-operation',
          userIntentId: receipt.userIntentId,
          commandKind: 'setFavourite',
          phase: 'settled',
          outcome: 'receipt',
          receipt,
        },
      ],
      nextAfterSequence: null,
    }),
  );
  await recovery.check();
  await recovery.dismiss('other-operation');
  expect(controller.blocked).toBe(true);
  expect(acknowledge).not.toHaveBeenCalled();
});

test('post-removal focus waits for an actual receipt and missing invoker, runs once, and does not follow the user to another screen', async () => {
  const f = serviceFixture();
  const firstScope = () => undefined;
  let scope = firstScope;
  const controller = new DirectActionController(f.services, jest.fn(), () => scope);
  let missing = false;
  const focus = jest.fn((onlyIfMissing?: boolean) => !onlyIfMissing || missing);
  const pending = deferred<CommandResult>();
  f.execute.mockReturnValueOnce(pending.promise);
  const saving = controller.begin(
    { ...input, saved: false },
    { restoreFocus: focus, restoreAfterCommitRemoval: true },
  );
  await Promise.resolve();
  await Promise.resolve();
  controller.restoreAfterRemoval();
  expect(focus).not.toHaveBeenCalled();
  pending.resolve({ kind: 'receipt', receipt });
  await saving;
  controller.restoreAfterRemoval();
  expect(focus).toHaveBeenLastCalledWith(true);
  missing = true;
  scope = () => undefined;
  controller.restoreAfterRemoval();
  expect(focus).toHaveBeenCalledTimes(1);
  scope = firstScope;
  controller.restoreAfterRemoval(focus);
  controller.restoreAfterRemoval(focus);
  expect(focus).toHaveBeenCalledTimes(2);
});

test('selected-day and full-week browsing keep actual meal dates distinct without issuing writes', async () => {
  const f = serviceFixture();
  const tuesdayMeal: PlanOccurrence = {
    ...mealB,
    placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
  };
  f.readPlan.mockImplementation(async (startDate, endDate) =>
    ready({
      startDate,
      endDate,
      occurrences: [mealA, tuesdayMeal],
      shoppingScope: { scopeId: 'test-scope', revision: 1, occurrenceIds: [mealA.occurrenceId] },
    }),
  );
  render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      clock={testClock}
    >
      <PlanScreen />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });

  const monday = 'Monday 28 September 2026';
  const tuesday = 'Tuesday 29 September 2026';
  const wednesday = 'Wednesday 30 September 2026';
  const mondayRecipe = getRecipe(mealA.recipeId)!.title;
  const tuesdayRecipe = getRecipe(tuesdayMeal.recipeId)!.title;
  expect(screen.getByRole('button', { name: `${monday}, today, 1 planned meal` })).toBeSelected();
  expect(screen.getByRole('header', { name: monday })).toBeTruthy();
  expect(screen.queryByRole('header', { name: tuesday })).toBeNull();
  expect(screen.getByRole('button', { name: mondayRecipe })).toBeTruthy();
  expect(screen.queryByRole('button', { name: tuesdayRecipe })).toBeNull();
  expect(screen.getByText('Included in shopping')).toBeTruthy();

  fireEvent.press(screen.getByRole('button', { name: `${tuesday}, 1 planned meal` }));
  expect(screen.getByRole('button', { name: `${tuesday}, 1 planned meal` })).toBeSelected();
  expect(
    screen.getByRole('button', { name: `${monday}, today, 1 planned meal` }),
  ).not.toBeSelected();
  expect(screen.getByRole('header', { name: tuesday })).toBeTruthy();
  expect(screen.queryByRole('header', { name: monday })).toBeNull();
  expect(screen.getByRole('button', { name: tuesdayRecipe })).toBeTruthy();
  expect(screen.queryByRole('button', { name: mondayRecipe })).toBeNull();
  expect(screen.getByText('Not included')).toBeTruthy();

  fireEvent.press(screen.getByRole('button', { name: 'View full week' }));
  expect(screen.getByRole('header', { name: monday })).toBeTruthy();
  expect(screen.getByRole('header', { name: tuesday })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: mondayRecipe })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: tuesdayRecipe })).toHaveLength(1);
  expect(screen.getByRole('button', { name: `Meal options for Dinner on ${monday}` })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: `Meal options for Dinner on ${tuesday}` }),
  ).toBeTruthy();

  fireEvent.press(screen.getByRole('button', { name: wednesday }));
  fireEvent.press(screen.getByRole('button', { name: 'View selected day' }));
  expect(screen.getByRole('button', { name: wednesday })).toBeSelected();
  expect(screen.getByRole('header', { name: wednesday })).toBeTruthy();
  expect(screen.queryByRole('button', { name: mondayRecipe })).toBeNull();
  expect(screen.queryByRole('button', { name: tuesdayRecipe })).toBeNull();
  expect(screen.getByRole('button', { name: 'Plan dinner' })).toBeEnabled();
  expect(screen.queryByText('This week is open')).toBeNull();

  fireEvent.press(screen.getByRole('button', { name: `${monday}, today, 1 planned meal` }));
  expect(screen.getByRole('button', { name: mondayRecipe })).toBeTruthy();
  expect(screen.getByText('Included in shopping')).toBeTruthy();
  expect(f.reviewDirect).not.toHaveBeenCalled();
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});

test('full-week meal options reveal Edit and Remove for the chosen dated occurrence without saving', async () => {
  const f = serviceFixture();
  const tuesdayMeal: PlanOccurrence = {
    ...mealB,
    placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
  };
  f.readPlan.mockImplementation(async (startDate, endDate) =>
    ready({
      startDate,
      endDate,
      occurrences: [mealA, tuesdayMeal],
      shoppingScope: { scopeId: 'test-scope', revision: 1, occurrenceIds: [mealA.occurrenceId] },
    }),
  );
  render(
    <WorkspaceProvider
      openStore={async () => ({ kind: 'ready', services: f.services })}
      clock={testClock}
    >
      <PlanScreen />
    </WorkspaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByRole('button', { name: 'View full week' }));
  expect(screen.queryByRole('button', { name: 'Edit dinner' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove dinner' })).toBeNull();

  const tuesdayOptions = 'Meal options for Dinner on Tuesday 29 September 2026';
  fireEvent.press(screen.getByRole('button', { name: tuesdayOptions }));
  expect(screen.getByRole('button', { name: 'Edit dinner' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Remove dinner' })).toBeEnabled();
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(f.reviewDirect).not.toHaveBeenCalled();

  fireEvent.press(screen.getByRole('button', { name: 'Edit dinner' }));
  fireEvent(screen.UNSAFE_getByType(Modal), 'dismiss');
  expect(mockRouter.push).toHaveBeenCalledTimes(1);
  expect(mockRouter.push).toHaveBeenCalledWith({
    pathname: '/plan-edit',
    params: {
      occurrenceId: tuesdayMeal.occurrenceId,
      recipeId: tuesdayMeal.recipeId,
      date: '2026-09-29',
      meal: 'dinner',
    },
  });
  expect(screen.queryByRole('button', { name: 'Edit dinner' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove dinner' })).toBeNull();

  fireEvent.press(screen.getByRole('button', { name: tuesdayOptions }));
  expect(screen.getByRole('button', { name: 'Remove dinner' })).toBeEnabled();
  fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  fireEvent(screen.UNSAFE_getByType(Modal), 'dismiss');
  expect(screen.queryByRole('button', { name: 'Remove dinner' })).toBeNull();
  expect(f.reviewDirect).not.toHaveBeenCalled();
  expect(f.prepareDirect).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
