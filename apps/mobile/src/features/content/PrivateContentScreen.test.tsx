import type { ComponentProps } from 'react';
import { Platform, Text } from 'react-native';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { PrivateContentScreen } from './PrivateContentScreen';
import { ActionButton } from '../../components/Controls';
import {
  createPrivateContentOpener,
  PrivateContentCleanupError,
  type PrivateContentRuntime,
} from './privateContentRuntime';
import type {
  ContentAdoptionMealChoice,
  ContentAdoptionMealChoices,
  ContentAdoptionMealChoicesRequest,
  ContentAdoptionRequest,
  ContentAdoptionReview,
} from '../../data/contentAdoption';
import type { OverlayEntry } from '@cookmate/catalogue/content';
import type { ContentWorkspaceReader } from './ContentWorkspaceReader';
import type {
  ContentUpdateIntent,
  ContentWorkspaceHost,
  ContentWorkspaceState,
} from './contentWorkspaceHost';

// These are presentation/lifetime tests. Real Ed25519 runs in the Node transport and signed bridge suites.
jest.mock('@cookmate/catalogue/content-trust', () => ({ createContentTrustVerifier: jest.fn() }));

let mockReaderProps: ComponentProps<typeof ContentWorkspaceReader> | undefined;
jest.mock('./ContentWorkspaceReader', () => ({
  ContentWorkspaceReader: (props: ComponentProps<typeof ContentWorkspaceReader>) => {
    mockReaderProps = props;
    const { Text } = jest.requireActual('react-native');
    return <Text testID="actual-reader-mount">Verified reader boundary</Text>;
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const head = { releaseId: 'published-1', sequence: 1, fingerprint: 'a'.repeat(64) };
const stage = {
  stageId: 'stage-1',
  stageEpoch: 2,
  packageFingerprint: 'b'.repeat(64),
  publicationCount: 1,
  mediaBytes: 256,
};
const release = {
  ...stage,
  head,
  expectedHead: null,
  highWater: 0,
  manifest: { entries: [] as OverlayEntry[] },
  retainedRefCount: 1,
};
const adoption: ContentAdoptionReview = {
  operationId: '10000000-0000-4000-8000-000000000003',
  installationId: '10000000-0000-4000-8000-000000000001',
  ownerId: null,
  requestFingerprint: 'c'.repeat(64),
  previousHead: null,
  candidateHead: head,
  expectedStoreRevision: 1,
  expectedAdoptionRevision: 0,
  changes: [],
  preservedPlanCount: 1,
  unresolvedHistoryOrSessionCount: 0,
  withdrawnRefs: [],
  shopping: { selectedOccurrences: 1, rebuilt: false, groups: [], notices: [] },
};
function mealChoice(index = 0): ContentAdoptionMealChoice {
  return {
    occurrence: {
      occurrenceId: `10000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      recipeId: '90001',
      placement: {
        actualDate: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`,
        mealKey: 'dinner',
      },
      revision: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z',
    },
    current: {
      contentRef: { recipeId: '90001', revisionId: 'saved-1', contentFingerprint: '1'.repeat(64) },
      title: `Original meal ${index}`,
      state: 'readable',
    },
    target: {
      contentRef: {
        recipeId: '90001',
        revisionId: 'proposed-2',
        contentFingerprint: '2'.repeat(64),
      },
      title: 'New recipe with 200g salt',
    },
  };
}
function mealChoices(offset = 0, total = 1): ContentAdoptionMealChoices {
  return {
    candidateHead: head,
    contextFingerprint: 'd'.repeat(64),
    total,
    offset,
    items: Array.from({ length: Math.min(20, total - offset) }, (_, index) =>
      mealChoice(offset + index),
    ),
    nextOffset: offset + 20 < total ? offset + 20 : null,
  };
}
function intent(kind: ContentUpdateIntent['kind']): ContentUpdateIntent {
  return {
    version: 1,
    kind,
    installationId: adoption.installationId,
    ownerId: null,
    operationId: adoption.operationId,
    fingerprint: stage.packageFingerprint,
  };
}

/** Deliberately controlled presentation ports. These tests prove UI sequencing/lifetime only;
 * signatures, SQLite persistence, media, owner authority and real browser rendering are separate. */
function fixture(initial: ContentWorkspaceState['status'] = 'ready') {
  let sequence = 0;
  let state: Readonly<ContentWorkspaceState> = {
    status: initial,
    scopeKey: 'private:0',
    cleanupPending: 0,
    pending: initial === 'ready' ? null : intent('activation'),
  };
  const listeners = new Set<() => void>();
  function publish(
    status: ContentWorkspaceState['status'],
    kind: ContentUpdateIntent['kind'] = 'activation',
  ) {
    state = {
      ...state,
      status,
      scopeKey: `private:${++sequence}`,
      pending: status === 'ready' ? null : intent(kind),
    };
    listeners.forEach((listener) => listener());
  }
  const unexpected = jest.fn(async () => {
    throw new Error('Unexpected presentation operation');
  });
  const port = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    content: {
      discover: jest.fn(async () => ({
        head: null,
        value: [
          { recipeId: '90001', title: 'Actual verified recipe title with original spelling' },
        ],
      })),
      readCurrent: unexpected,
      readExact: unexpected,
      readPhoto: unexpected,
      readPhotos: unexpected,
    },
    delivery: {
      stage: jest.fn(async () => stage),
      review: jest.fn(async () => release),
      discardStage: jest.fn(async () => undefined),
      readStage: jest.fn(async (): Promise<typeof stage | null> => null),
      hydrate: jest.fn(async () => ({ kind: 'active', head, highWater: 1 })),
      activate: jest.fn(async () => {
        publish('result_ready');
        return { status: 'activated_in_content_store', head };
      }),
    },
    adoption: {
      readMealChoices: jest.fn(
        async (_input: ContentAdoptionMealChoicesRequest): Promise<ContentAdoptionMealChoices> =>
          mealChoices(),
      ),
      review: jest.fn(
        async (_input: ContentAdoptionRequest, _fence?: string): Promise<ContentAdoptionReview> =>
          adoption,
      ),
      adopt: jest.fn(async (_review: ContentAdoptionReview) => {
        publish('result_ready', 'adoption');
        return { status: 'adopted_in_cooking_store', head };
      }),
    },
    acknowledgeUpdate: jest.fn(async () => {
      publish('ready');
    }),
    recoverUpdate: jest.fn(async () => {
      publish('result_ready');
      return { head };
    }),
    retryPhotoCleanup: jest.fn(() => 0),
  };
  // Only fields consumed by this presentation are populated; no authority is inferred from this cast.
  const host = port as unknown as ContentWorkspaceHost;
  const fetchRelease = jest.fn(
    async (): ReturnType<PrivateContentRuntime['fetchRelease']> => ({
      stageId: stage.stageId,
      envelope: {},
      publications: [],
      media: [],
    }),
  );
  const close = jest.fn(async (): Promise<void> => undefined);
  const runtime: PrivateContentRuntime = {
    storageScope: { installationId: '10000000-0000-4000-8000-000000000001', ownerId: null },
    host,
    fetchRelease,
    close,
  };
  const open = jest.fn(async () => runtime);
  return { runtime, open, close, port, publish, fetchRelease, listeners };
}
const exit = jest.fn();
beforeEach(() => {
  mockReaderProps = undefined;
  jest.clearAllMocks();
});
afterEach(cleanup);
async function ready(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.getByText('Recipes in this workspace')).toBeTruthy());
}
async function click(view: ReturnType<typeof render>, label: string) {
  await act(async () => fireEvent.press(view.getByRole('button', { name: label })));
}

test('opens real discovery and forwards a current target to the existing reader without changing content', async () => {
  const f = fixture();
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Actual verified recipe title with original spelling');
  expect(view.getByTestId('actual-reader-mount')).toBeTruthy();
  expect(view.getByText('Private content review workspace')).toBeTruthy();
  expect(mockReaderProps?.host).toBe(f.runtime.host);
  expect(mockReaderProps?.target).toEqual({ kind: 'current', recipeId: '90001' });
  act(() => mockReaderProps!.onBack());
  expect(view.getByText('Recipes in this workspace')).toBeTruthy();
  expect(f.fetchRelease).not.toHaveBeenCalled();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
});

test('ordinary routes borrow the opened runtime and keep its close-before-open ownership', async () => {
  const f = fixture();
  const borrowed = jest.fn((runtime: PrivateContentRuntime) => {
    expect(runtime).toBe(f.runtime);
    return <Text>Ordinary application routes</Text>;
  });
  const view = render(
    <PrivateContentScreen open={f.open} onExit={exit} renderWorkspace={borrowed} />,
  );
  await waitFor(() => expect(view.getByText('Ordinary application routes')).toBeTruthy());
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.port.content.discover).not.toHaveBeenCalled();
  expect(f.fetchRelease).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
});

test('fetches and stages only, then requires separate activation, acknowledgement and adoption reviews', async () => {
  const f = fixture();
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Fetch release for review');
  expect(f.port.delivery.stage).toHaveBeenCalledWith(await f.fetchRelease.mock.results[0]!.value);
  expect(f.port.delivery.review).toHaveBeenCalledWith(stage.stageId);
  expect(view.getByText(/New withdrawal restrictions apply immediately/)).toBeTruthy();
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
  expect(f.port.adoption.review).not.toHaveBeenCalled();
  await click(view, 'Activate verified release');
  expect(f.port.delivery.activate).toHaveBeenCalledWith(release);
  expect(view.getByText(/Adoption is a separate review/)).toBeTruthy();
  expect(f.port.acknowledgeUpdate).not.toHaveBeenCalled();
  await click(view, 'Continue');
  await ready(view);
  expect(f.port.adoption.review).not.toHaveBeenCalled();
  await click(view, 'Review adoption of verified release');
  expect(f.port.adoption.review).toHaveBeenCalledWith({ candidateHead: head });
  expect(view.getByText(/1 saved meal versions retained/)).toBeTruthy();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  await click(view, 'Adopt reviewed release');
  expect(f.port.adoption.adopt).toHaveBeenCalledWith(adoption);
  expect(view.getByText(/reviewed adoption is saved/)).toBeTruthy();
  await click(view, 'Continue');
  await ready(view);
  expect(f.port.acknowledgeUpdate).toHaveBeenCalledTimes(2);
});

test('discard uses the exact stage epoch and cancelling adoption makes the old confirm callback inert', async () => {
  const f = fixture();
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Fetch release for review');
  await click(view, 'Discard staged release');
  expect(f.port.delivery.discardStage).toHaveBeenCalledWith(
    stage.stageId,
    stage.packageFingerprint,
    stage.stageEpoch,
  );
  await click(view, 'Review adoption of verified release');
  const retained = view
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Adopt reviewed release')!.props.onPress;
  await click(view, 'Cancel adoption review');
  await act(async () => retained());
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
});

test('saved meal selections page20, preserve by default, and require exact fenced Shopping consequences before adoption', async () => {
  const f = fixture();
  f.port.adoption.readMealChoices.mockImplementation(async (input) =>
    mealChoices(input.offset ?? 0, 41),
  );
  let issued: ContentAdoptionReview | undefined;
  f.port.adoption.review.mockImplementation(async (input) => {
    issued = {
      ...adoption,
      previousHead: head,
      changes: [...(input.changes ?? [])],
      preservedPlanCount: 40,
      shopping: {
        selectedOccurrences: 1,
        rebuilt: true,
        groups: [
          {
            groupKey: 'salt',
            displayName: 'Salt',
            previousQuantity: '100g',
            quantity: '200g',
            previousPurchased: true,
            purchased: false,
            changed: true,
          },
        ],
        notices: [],
      },
    };
    return issued;
  });
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Choose saved meal versions');
  expect(view.getAllByRole('checkbox')).toHaveLength(20);
  expect(
    view.getAllByRole('checkbox').every((item) => item.props.accessibilityState.checked === false),
  ).toBe(true);
  expect(view.getByText('Saved: Original meal 0')).toBeTruthy();
  expect(view.queryByText('Saved: Original meal 20')).toBeNull();
  fireEvent.press(view.getAllByRole('checkbox')[0]!);
  expect(f.port.adoption.review).not.toHaveBeenCalled();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  await click(view, 'More saved meals');
  expect(f.port.adoption.readMealChoices).toHaveBeenLastCalledWith({
    candidateHead: head,
    offset: 20,
    expectedContextFingerprint: 'd'.repeat(64),
  });
  expect(view.getAllByRole('checkbox')).toHaveLength(20);
  await click(view, 'More saved meals');
  expect(view.getAllByRole('checkbox')).toHaveLength(1);
  expect(view.getByText('Showing 41–41 of 41 saved meals')).toBeTruthy();
  await click(view, 'Review selected meal changes');
  const choice = mealChoice();
  expect(f.port.adoption.review).toHaveBeenLastCalledWith(
    {
      candidateHead: head,
      changes: [
        {
          occurrenceId: choice.occurrence.occurrenceId,
          expectedRef: choice.current.contentRef,
          targetRef: choice.target!.contentRef,
        },
      ],
    },
    'd'.repeat(64),
  );
  expect(view.getByText('Before: 100g')).toBeTruthy();
  expect(view.getByText('After: 200g')).toBeTruthy();
  expect(view.getByText('Purchase mark: checked → unchecked')).toBeTruthy();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  await click(view, 'Adopt reviewed release');
  expect(f.port.adoption.adopt.mock.calls[0]?.[0]).toBe(issued);
});

test('unavailable and unchanged saved meals stay visible without selectable replacement or substituted title', async () => {
  const f = fixture();
  const unavailable = mealChoice();
  unavailable.current.title = null;
  unavailable.current.state = 'unavailable';
  unavailable.target = null;
  f.port.adoption.readMealChoices.mockResolvedValue({ ...mealChoices(), items: [unavailable] });
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Choose saved meal versions');
  expect(view.getByText('Saved: Saved recipe content unavailable')).toBeTruthy();
  expect(view.queryByText(/New recipe with/)).toBeNull();
  expect(view.queryByRole('checkbox')).toBeNull();
  expect(view.getByRole('button', { name: 'Review selected meal changes' })).toBeDisabled();
  await click(view, 'Cancel meal selection');
  expect(f.port.adoption.review).not.toHaveBeenCalled();
});

test('stale next page retires selections and retained controls without adopting', async () => {
  const f = fixture();
  f.port.adoption.readMealChoices
    .mockResolvedValueOnce(mealChoices(0, 41))
    .mockRejectedValueOnce(new Error('review_changed'));
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Choose saved meal versions');
  fireEvent.press(view.getAllByRole('checkbox')[0]!);
  const retained = view
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Review selected meal changes')!.props.onPress;
  await click(view, 'More saved meals');
  expect(view.getByText('Saved meals changed or could not be checked')).toBeTruthy();
  await act(async () => retained());
  expect(f.port.adoption.review).not.toHaveBeenCalled();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  await click(view, 'Cancel meal selection');
});

test('late meal choices and retained selection callbacks retire on owner or update scope changes', async () => {
  const f = fixture();
  const pending = deferred<ContentAdoptionMealChoices>();
  f.port.adoption.readMealChoices.mockImplementation(() => pending.promise);
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  fireEvent.press(view.getByRole('button', { name: 'Choose saved meal versions' }));
  await waitFor(() => expect(f.port.adoption.readMealChoices).toHaveBeenCalledTimes(1));
  act(() => f.publish('updating'));
  await act(async () => pending.resolve(mealChoices()));
  expect(view.queryByText('Saved: Original meal 0')).toBeNull();
  expect(f.port.adoption.review).not.toHaveBeenCalled();
  act(() => f.publish('ready'));
  await ready(view);
  f.port.adoption.readMealChoices.mockResolvedValue(mealChoices());
  await click(view, 'Choose saved meal versions');
  const retained = view
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.accessibilityRole === 'checkbox')!.props.onPress;
  act(() => f.publish('updating'));
  await act(async () => retained());
  expect(f.port.adoption.review).not.toHaveBeenCalled();
});

test('unexpected selected-set changes cannot reach the adoption confirmation', async () => {
  const f = fixture();
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Choose saved meal versions');
  fireEvent.press(view.getAllByRole('checkbox')[0]!);
  await click(view, 'Review selected meal changes');
  expect(view.getByText('Saved meals changed or could not be checked')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Adopt reviewed release' })).toBeNull();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
});

test('web meal checkbox Space toggles once without scrolling, while repeat and Enter leave fallback state alone', async () => {
  const nativeOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    const f = fixture();
    const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
    await ready(view);
    await click(view, 'Choose saved meal versions');
    const preventDefault = jest.fn();
    function press(key: string, repeat = false) {
      fireEvent(view.getByRole('checkbox'), 'keyDown', { key, repeat, preventDefault });
    }
    press(' ');
    expect(view.getByRole('checkbox')).toBeChecked();
    press(' ', true);
    expect(view.getByRole('checkbox')).toBeChecked();
    press('Enter');
    expect(view.getByRole('checkbox')).toBeChecked();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    press('Spacebar');
    expect(view.getByRole('checkbox')).not.toBeChecked();
    expect(preventDefault).toHaveBeenCalledTimes(3);
    fireEvent.press(view.getByRole('checkbox'));
    expect(view.getByRole('checkbox')).toBeChecked();
    expect(f.port.adoption.review).not.toHaveBeenCalled();
    expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  } finally {
    cleanup();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: nativeOS });
  }
});

test('retained web keyboard handlers cannot toggle while busy, after a page changes, or after scope retirement', async () => {
  const nativeOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    const f = fixture();
    const next = deferred<ContentAdoptionMealChoices>();
    f.port.adoption.readMealChoices
      .mockResolvedValueOnce(mealChoices(0, 41))
      .mockImplementationOnce(() => next.promise);
    const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
    await ready(view);
    await click(view, 'Choose saved meal versions');
    fireEvent(view.getAllByRole('checkbox')[0]!, 'keyDown', {
      key: ' ',
      repeat: false,
      preventDefault: jest.fn(),
    });
    const oldKeyDown = view
      .UNSAFE_getAllByType(ActionButton)
      .find((button) => button.props.accessibilityRole === 'checkbox')!.props.onKeyDown;
    fireEvent.press(view.getByRole('button', { name: 'More saved meals' }));
    await waitFor(() => expect(f.port.adoption.readMealChoices).toHaveBeenCalledTimes(2));
    expect(view.getAllByRole('checkbox')[0]!).toBeDisabled();
    await act(async () =>
      oldKeyDown({ key: 'Spacebar', repeat: false, preventDefault: jest.fn() }),
    );
    expect(view.getByText(/1 selected \(maximum 1000\)/)).toBeTruthy();
    await act(async () => next.resolve(mealChoices(20, 41)));
    await act(async () => oldKeyDown({ key: ' ', repeat: false, preventDefault: jest.fn() }));
    expect(view.getByText(/1 selected \(maximum 1000\)/)).toBeTruthy();
    expect(
      view.getAllByRole('checkbox').every((item) => !item.props.accessibilityState.checked),
    ).toBe(true);
    const retiredKeyDown = view
      .UNSAFE_getAllByType(ActionButton)
      .find((button) => button.props.accessibilityRole === 'checkbox')!.props.onKeyDown;
    act(() => f.publish('updating'));
    await act(async () => retiredKeyDown({ key: ' ', repeat: false, preventDefault: jest.fn() }));
    expect(view.queryByRole('checkbox')).toBeNull();
    expect(f.port.adoption.review).not.toHaveBeenCalled();
    expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  } finally {
    cleanup();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: nativeOS });
  }
});

test('reopening recovery checks the original receipt without fetching or resending', async () => {
  const f = fixture('recovery_required');
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await waitFor(() => expect(view.getByText('Check the saved update')).toBeTruthy());
  await click(view, 'Check saved result');
  expect(f.port.recoverUpdate).toHaveBeenCalledTimes(1);
  expect(f.fetchRelease).not.toHaveBeenCalled();
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
  expect(f.port.content.discover).not.toHaveBeenCalled();
  await click(view, 'Continue');
  await ready(view);
});

test('a release fetch resolving after Exit cannot stage bytes; exit waits for close', async () => {
  const f = fixture();
  const fetched = deferred<Awaited<ReturnType<PrivateContentRuntime['fetchRelease']>>>();
  f.fetchRelease.mockImplementation(() => fetched.promise);
  const closed = deferred<void>();
  f.close.mockImplementation(() => closed.promise);
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  fireEvent.press(view.getByRole('button', { name: 'Fetch release for review' }));
  await click(view, 'Exit private workspace');
  expect(exit).not.toHaveBeenCalled();
  await act(async () =>
    fetched.resolve({ stageId: 'late', envelope: {}, publications: [], media: [] }),
  );
  expect(f.port.delivery.stage).not.toHaveBeenCalled();
  await act(async () => closed.resolve());
  expect(exit).toHaveBeenCalledTimes(1);
});

test('a replaced opening drains late runtime close before opening its replacement', async () => {
  const first = fixture(),
    next = fixture();
  const pending = deferred<PrivateContentRuntime>(),
    closed = deferred<void>();
  first.open.mockImplementation(() => pending.promise);
  first.close.mockImplementation(() => closed.promise);
  const view = render(<PrivateContentScreen open={first.open} onExit={exit} />);
  await waitFor(() => expect(first.open).toHaveBeenCalledTimes(1));
  view.rerender(<PrivateContentScreen open={next.open} onExit={exit} />);
  await act(async () => pending.resolve(first.runtime));
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(next.open).not.toHaveBeenCalled();
  await act(async () => closed.resolve());
  await ready(view);
  expect(next.open).toHaveBeenCalledTimes(1);
  expect(first.port.content.discover).not.toHaveBeenCalled();
});

test('opening failure is visible and retry is explicit', async () => {
  const f = fixture();
  f.open.mockRejectedValueOnce(new Error('Unconfigured or incompatible workspace'));
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await waitFor(() => expect(view.getByText('Workspace could not open')).toBeTruthy());
  expect(f.open).toHaveBeenCalledTimes(1);
  await click(view, 'Try opening again');
  await ready(view);
  expect(f.open).toHaveBeenCalledTimes(2);
});

test('real sticky close failure blocks another opening and never offers a false cleanup retry or exit', async () => {
  const f = fixture(),
    replacement = fixture();
  f.close.mockRejectedValue(new Error('Close failed'));
  const open = createPrivateContentOpener(f.open);
  const view = render(<PrivateContentScreen open={open} onExit={exit} />);
  await ready(view);
  await click(view, 'Exit private workspace');
  expect(view.getByText('Workspace cleanup is unconfirmed')).toBeTruthy();
  expect(exit).not.toHaveBeenCalled();
  expect(view.queryByText('Recipes in this workspace')).toBeNull();
  expect(view.queryByRole('button', { name: 'Retry closing' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Exit private workspace' })).toBeNull();
  expect(view.getByText(/Reload this private review page/)).toBeTruthy();
  view.rerender(<PrivateContentScreen open={replacement.open} onExit={exit} />);
  await waitFor(() => expect(view.getByText('Workspace cleanup is unconfirmed')).toBeTruthy());
  expect(replacement.open).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('unmount closes a runtime that resolves late and never reads its recipes', async () => {
  const f = fixture();
  const pending = deferred<PrivateContentRuntime>();
  f.open.mockImplementation(() => pending.promise);
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => pending.resolve(f.runtime));
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.port.content.discover).not.toHaveBeenCalled();
});

test('owner revocation suppresses a late discovery result and all update controls', async () => {
  const f = fixture();
  const pending = deferred<Awaited<ReturnType<typeof f.port.content.discover>>>();
  f.port.content.discover.mockImplementation(() => pending.promise);
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  act(() => f.publish('revoked'));
  await act(async () =>
    pending.resolve({ head: null, value: [{ recipeId: '90001', title: 'Late old-scope title' }] }),
  );
  expect(view.queryByText('Late old-scope title')).toBeNull();
  expect(view.getByText('Private workspace closed')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Fetch release for review' })).toBeNull();
});

test('failed stage verification remains inspectable and can be discarded without activation', async () => {
  const f = fixture();
  f.port.delivery.review.mockRejectedValueOnce(new Error('Signature or retained reference failed'));
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Fetch release for review');
  expect(view.getByText('Staged release needs review')).toBeTruthy();
  expect(view.getByText('Review unavailable')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Activate verified release' })).toBeNull();
  await click(view, 'Discard staged release');
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
});

test('discovery renders a bounded page without truncating recipe titles', async () => {
  const f = fixture();
  f.port.content.discover.mockResolvedValue({
    head: null,
    value: Array.from({ length: 21 }, (_, index) => ({
      recipeId: String(90001 + index),
      title: `Original full recipe title ${index + 1}`,
    })),
  });
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await waitFor(() => expect(view.getByText('Original full recipe title 20')).toBeTruthy());
  expect(view.queryByText('Original full recipe title 21')).toBeNull();
  await click(view, 'More recipes');
  expect(view.getByText('Original full recipe title 21')).toBeTruthy();
  expect(view.queryByText('Original full recipe title 1')).toBeNull();
  await click(view, 'Previous recipes');
  expect(view.getByText('Original full recipe title 1')).toBeTruthy();
});

test('a retained stage is loaded on reopen and can be reviewed or discarded without fetching again', async () => {
  const f = fixture();
  f.port.delivery.readStage.mockResolvedValue(stage);
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await waitFor(() => expect(view.getByText('Staged release needs review')).toBeTruthy());
  expect(f.port.delivery.readStage).toHaveBeenCalledWith();
  expect(view.queryByRole('button', { name: 'Fetch release for review' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Review adoption of verified release' })).toBeNull();
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
  await click(view, 'Review staged release');
  expect(f.port.delivery.review).toHaveBeenCalledWith(stage.stageId);
  expect(view.getByRole('button', { name: 'Activate verified release' })).toBeTruthy();
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
  await click(view, 'Discard staged release');
  expect(f.port.delivery.discardStage).toHaveBeenCalledWith(
    stage.stageId,
    stage.packageFingerprint,
    stage.stageEpoch,
  );
  expect(f.fetchRelease).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Fetch release for review' })).toBeTruthy();
});

test('pending or failed stage inspection blocks fetch and adoption until an explicit successful retry', async () => {
  const f = fixture();
  const pending = deferred<typeof stage | null>();
  f.port.delivery.readStage
    .mockImplementationOnce(() => pending.promise)
    .mockRejectedValueOnce(new Error('Stage unavailable'));
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await waitFor(() => expect(f.port.delivery.readStage).toHaveBeenCalledTimes(1));
  expect(view.getByText('Checking staged release…')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Fetch release for review' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Review adoption of verified release' })).toBeNull();
  await act(async () => pending.resolve(null));
  expect(view.getByRole('button', { name: 'Fetch release for review' })).toBeTruthy();
  act(() => f.publish('ready'));
  await waitFor(() => expect(view.getByText('Saved release review unavailable')).toBeTruthy());
  expect(view.queryByRole('button', { name: 'Fetch release for review' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Review adoption of verified release' })).toBeNull();
  await click(view, 'Retry saved stage check');
  expect(view.getByRole('button', { name: 'Fetch release for review' })).toBeTruthy();
  expect(f.fetchRelease).not.toHaveBeenCalled();
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
});

test('Exit and unmount revoke an opened runtime synchronously before close acknowledgement', async () => {
  const f = fixture(),
    next = fixture();
  const pending = deferred<void>();
  f.close.mockImplementation(() => pending.promise);
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  fireEvent.press(view.getByRole('button', { name: 'Exit private workspace' }));
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(exit).not.toHaveBeenCalled();
  await act(async () => pending.resolve());
  const second = render(<PrivateContentScreen open={next.open} onExit={exit} />);
  await ready(second);
  second.unmount();
  expect(next.close).toHaveBeenCalledTimes(1);
});

test('an actual cleanup error before returning a runtime stays blocked with the real sticky opener', async () => {
  const failure = new PrivateContentCleanupError([
    new Error('Opening failed'),
    new Error('A SQL handle did not close'),
  ]);
  const source = jest.fn(async (): Promise<PrivateContentRuntime> => {
    throw failure;
  });
  const open = createPrivateContentOpener(source);
  const view = render(<PrivateContentScreen open={open} onExit={exit} />);
  await waitFor(() => expect(view.getByText('Workspace cleanup is unconfirmed')).toBeTruthy());
  expect(view.queryByRole('button', { name: 'Try opening again' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Exit private workspace' })).toBeNull();
  expect(view.getByText(/No successful close or exit is being claimed/)).toBeTruthy();
  await expect(open()).rejects.toBe(failure);
  expect(source).toHaveBeenCalledTimes(1);
  expect(exit).not.toHaveBeenCalled();
});

test('release review exposes exact cumulative identities, archive and withdrawal reasons across bounded pages', async () => {
  const f = fixture();
  const entries: OverlayEntry[] = Array.from({ length: 20 }, (_, index) => ({
    state: 'current',
    ref: {
      recipeId: String(90001 + index),
      revisionId: `r${index}`,
      contentFingerprint: 'e'.repeat(64),
    },
    publicationFingerprint: null,
  }));
  entries[0] = {
    state: 'archived',
    ref: { recipeId: '90001', revisionId: 'retained-original', contentFingerprint: 'd'.repeat(64) },
    publicationFingerprint: null,
    reason: 'Archived for the reviewed seasonal schedule.',
  };
  entries.push({
    state: 'withdrawn',
    recipeId: '91000',
    reason: 'Permission withdrawn. Original wording is unavailable.',
  });
  f.port.delivery.review.mockResolvedValue({ ...release, manifest: { entries } });
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Fetch release for review');
  expect(view.getByText('Recipe 90001 · revision retained-original')).toBeTruthy();
  expect(view.getByText('Archived for the reviewed seasonal schedule.')).toBeTruthy();
  expect(view.getByText(`Content fingerprint: ${'d'.repeat(64)}`)).toBeTruthy();
  expect(view.queryByText('Recipe 91000')).toBeNull();
  await click(view, 'More release entries');
  expect(view.getByText('Recipe 91000')).toBeTruthy();
  expect(view.getByText('Permission withdrawn. Original wording is unavailable.')).toBeTruthy();
  expect(f.port.delivery.activate).not.toHaveBeenCalled();
});

test('adoption review exposes raw before/after demand, purchase effects, exact withdrawals and full source evidence', async () => {
  const f = fixture();
  const contentRef = {
    recipeId: '90001',
    revisionId: 'original-revision',
    contentFingerprint: 'd'.repeat(64),
  };
  f.port.adoption.review.mockResolvedValue({
    ...adoption,
    withdrawnRefs: [contentRef],
    shopping: {
      selectedOccurrences: 1,
      rebuilt: true,
      groups: [
        {
          groupKey: 'butter',
          displayName: 'Butter (original name)',
          previousQuantity: '  1/2 cup',
          quantity: '  3/4 cup',
          previousPurchased: true,
          purchased: false,
          changed: true,
        },
      ],
      notices: [
        {
          occurrenceId: '10000000-0000-4000-8000-000000000010',
          contentRef,
          disposition: 'inherited_unresolved',
          annotations: [
            {
              annotationId: 'source-note-1',
              recipeId: '90001',
              kind: 'source_gap',
              note: 'Original first line.\nSecond source line is not omitted.',
              ruleVersion: 'original',
              evidence: [{ sheet: 'Instructions', row: 12, column: 'C' }],
            },
          ],
        },
      ],
    },
  });
  const view = render(<PrivateContentScreen open={f.open} onExit={exit} />);
  await ready(view);
  await click(view, 'Review adoption of verified release');
  expect(view.getByText('Butter (original name)')).toBeTruthy();
  expect(view.getByText('Before:   1/2 cup', { normalizer: (text) => text })).toBeTruthy();
  expect(view.getByText('After:   3/4 cup', { normalizer: (text) => text })).toBeTruthy();
  expect(view.getByText('Purchase mark: checked → unchecked')).toBeTruthy();
  expect(view.getAllByText('Recipe 90001 · revision original-revision')).toHaveLength(2);
  expect(
    view.getByText('Original first line.\nSecond source line is not omitted.', {
      normalizer: (text) => text,
    }),
  ).toBeTruthy();
  expect(view.getByText('Instructions, row 12, column C')).toBeTruthy();
  expect(f.port.adoption.adopt).not.toHaveBeenCalled();
});
