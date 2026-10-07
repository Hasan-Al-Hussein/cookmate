import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { Text } from 'react-native';
import { getRecipe, catalogue } from '@cookmate/catalogue';
import type {
  CookingService,
  CookingSession,
  CookingSessionView,
  CookingHistoryEntry,
  CookingHistoryPage,
  CookedReceipt,
  Immutable,
  RepositoryResult,
  ClearCookingHistoryReview,
  ClearCookingHistoryReceipt,
} from '@cookmate/domain';
import { CookingReader } from '../recipes/CookingReader';
import { CookingCompletion } from './CookingCompletion';
import { CookingHistory } from './CookingHistoryScreen';
import { instructionSections } from './instructionSections';
import { useCookingProgress } from './useCookingProgress';

const mockPush = jest.fn();
const mockWorkspace = jest.fn();
const mockReferenceValues = new Map<string, string>();
const mockFocusLabels: string[] = [];
let mockId = 0;
jest.mock('../../components/focusTarget', () => ({
  focusTarget: (target: { props?: { accessibilityLabel?: string } } | null) => {
    if (!target) return false;
    mockFocusLabels.push(target.props?.accessibilityLabel ?? 'Unnamed focus target');
    return true;
  },
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockPush }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '53262': 1 } }));
jest.mock('./cookingReferenceStorage', () => {
  const { createCookingReferenceStore } =
    jest.requireActual<typeof import('./cookingReferences')>('./cookingReferences');
  return {
    cookingReferenceStore: createCookingReferenceStore({
      read: async (key) => mockReferenceValues.get(key) ?? null,
      write: async (key, value) => {
        mockReferenceValues.set(key, value);
      },
    }),
  };
});
jest.mock('./KeepAwakeControl', () => ({ KeepAwakeControl: () => null }));

const recipe = getRecipe('53262')!;
const sections = instructionSections(recipe);
const timestamp = '2026-09-30T08:00:00.000Z';
const content = {
  recipeId: recipe.recipeId,
  catalogue: catalogue.identity,
  contentFingerprint: 'a'.repeat(64),
  readerVersion: 1 as const,
};
const session: Immutable<CookingSession> = {
  ...content,
  sessionId: 'b0000000-0000-4000-8000-000000000001',
  revision: 2,
  passageSequence: sections[1]![0]!.sequence,
  state: 'active',
  updatedAt: timestamp,
  lastOperationId: 'c0000000-0000-4000-8000-000000000001',
};
const view: Immutable<CookingSessionView> = {
  currentContent: content,
  session,
  resume: 'matching',
  passageSequences: recipe.instructions.map((passage) => passage.sequence),
};
const entry: Immutable<CookingHistoryEntry> = {
  ...content,
  eventId: 'd0000000-0000-4000-8000-000000000001',
  recipeTitle: recipe.title,
  photoKey: recipe.photoKey,
  cookedOn: '2026-09-29',
  timeZone: 'Asia/Dubai',
  recordedAt: timestamp,
  note: 'Private fixture note',
  historyEpoch: 3,
  revision: 4,
};
const history: Immutable<CookingHistoryPage> = {
  items: [entry],
  historyRevision: 4,
  historyEpoch: 3,
  nextCursor: null,
};
const clearReview: Immutable<ClearCookingHistoryReview> = Object.freeze({
  reviewId: 'review',
  expectedHistoryRevision: 4,
  historyEpoch: 3,
  count: 1,
});
const clock = {
  now: () => timestamp,
  dateContext: () => ({ localDate: '2026-09-30', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
};
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 4 });
const readIdentity = async () => ready('e0000000-0000-4000-8000-000000000001');
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.failure',
  retry: 'never' as const,
};
function port<T extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<T>, Parameters<T>>();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let service: jest.Mocked<CookingService>;
const savedReceipts = new Map<string, Immutable<CookedReceipt>>();
const historyListeners = new Set<Parameters<CookingService['subscribe']>[0]>();
beforeEach(() => {
  mockId = 0;
  mockPush.mockClear();
  mockReferenceValues.clear();
  mockFocusLabels.length = 0;
  savedReceipts.clear();
  historyListeners.clear();
  service = {
    readResumeSession: port<CookingService['readResumeSession']>().mockResolvedValue(ready(view)),
    readSession: port<CookingService['readSession']>().mockResolvedValue(ready(view)),
    saveSession: port<CookingService['saveSession']>().mockImplementation(async (input) =>
      ready({
        ...session,
        sessionId: input.sessionId,
        passageSequence: input.passageSequence,
        revision: (input.expectedRevision ?? 0) + 1,
        lastOperationId: input.operationId,
      }),
    ),
    dismissSession: port<CookingService['dismissSession']>().mockImplementation(async (input) =>
      ready({
        ...session,
        state: 'dismissed',
        revision: input.expectedRevision + 1,
        lastOperationId: input.operationId,
      }),
    ),
    readHistory: port<CookingService['readHistory']>().mockResolvedValue(ready(history)),
    saveCooked: port<CookingService['saveCooked']>().mockImplementation(async (input) => {
      const receipt: Immutable<CookedReceipt> = {
        kind: 'saved',
        event: {
          ...entry,
          eventId: input.eventId,
          cookedOn: input.cookedOn,
          note: input.note ?? null,
        },
        closedSession: { ...session, state: 'completed', revision: 3 },
      };
      savedReceipts.set(input.eventId, receipt);
      return ready(receipt);
    }),
    readCookedReceipt: port<CookingService['readCookedReceipt']>().mockImplementation(async (id) =>
      ready(savedReceipts.get(id) ?? null),
    ),
    resolveCookedOperation: port<CookingService['resolveCookedOperation']>().mockImplementation(
      async (id) =>
        ready<Immutable<CookedReceipt>>(
          savedReceipts.get(id) ?? { kind: 'cancelled', eventId: id, historyEpoch: 3 },
        ),
    ),
    reviewClearHistory: port<CookingService['reviewClearHistory']>().mockResolvedValue(
      ready(clearReview),
    ),
    clearHistory: port<CookingService['clearHistory']>().mockImplementation(
      async (_review, operationId) => {
        service.readHistory.mockResolvedValue(
          ready({ ...history, historyEpoch: 4, historyRevision: 5, items: [] }),
        );
        return ready<Immutable<ClearCookingHistoryReceipt>>({
          operationId,
          outcome: 'cleared',
          clearedCount: 1,
          previousHistoryEpoch: 3,
          historyEpoch: 4,
          historyRevision: 5,
          committedAt: timestamp,
        });
      },
    ),
    readClearHistoryReceipt: port<CookingService['readClearHistoryReceipt']>().mockResolvedValue(
      ready(null),
    ),
    resolveClearHistoryOperation: port<
      CookingService['resolveClearHistoryOperation']
    >().mockImplementation(async (operationId) =>
      ready<Immutable<ClearCookingHistoryReceipt>>({
        operationId,
        outcome: 'cancelled',
        clearedCount: 0,
        previousHistoryEpoch: 3,
        historyEpoch: 3,
        historyRevision: 4,
        committedAt: timestamp,
      }),
    ),
    subscribe: port<CookingService['subscribe']>().mockImplementation((listener) => {
      historyListeners.add(listener);
      return () => {
        historyListeners.delete(listener);
      };
    }),
  };
  mockWorkspace.mockReturnValue({
    availability: {
      kind: 'ready',
      services: { cooking: service, queries: { readInstallationId: readIdentity } },
    },
    clock,
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
function reader() {
  return render(
    <CookingReader
      recipe={recipe}
      visible
      onClose={jest.fn()}
      onDismiss={jest.fn()}
      ingredients={<Text>Exact original ingredients</Text>}
      ingredientNotes={<Text>Original ingredient notes</Text>}
      sourceNotes={<Text>Original source notes</Text>}
      fullInstructions={<Text>Full original text</Text>}
    />,
  );
}
function completion(visible = true) {
  return (
    <CookingCompletion
      visible={visible}
      service={service}
      readInstallationId={readIdentity}
      sessionView={view}
      title={recipe.title}
      clock={clock}
      onCancel={jest.fn()}
      onCompleted={jest.fn()}
    />
  );
}
async function confirmCooked(note?: string) {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  if (note !== undefined) fireEvent.changeText(screen.getByLabelText('Private cooking note'), note);
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
}
async function showHistoryOptions() {
  const options = await screen.findByRole('button', { name: 'History options' });
  if (!options.props.accessibilityState?.expanded) fireEvent.press(options);
}
function publishHistoryChange() {
  for (const listener of historyListeners)
    listener({ recipeId: null, historyChanged: true, revision: 5 });
}

test('a matching saved session can deliberately restart without creating cooking history', async () => {
  reader();
  await screen.findByText('Section 2 of 3');
  fireEvent.press(screen.getByRole('button', { name: 'Reading options' }));
  fireEvent.press(screen.getByRole('button', { name: 'Restart cooking from the beginning' }));
  await screen.findByText('Section 1 of 3');
  expect(service.saveSession).toHaveBeenCalledTimes(1);
  expect(service.saveSession.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: session.revision,
    passageSequence: sections[0]![0]!.sequence,
  });
  expect(service.saveSession.mock.calls[0]?.[0].sessionId).not.toBe(session.sessionId);
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('restart blocks overlapping section navigation until its saved session is known', async () => {
  const write = deferred<Awaited<ReturnType<CookingService['saveSession']>>>();
  service.saveSession.mockReturnValueOnce(write.promise);
  reader();
  await screen.findByText('Section 2 of 3');
  fireEvent.press(screen.getByRole('button', { name: 'Reading options' }));
  fireEvent.press(screen.getByRole('button', { name: 'Restart cooking from the beginning' }));
  expect(screen.getByRole('button', { name: 'Next section' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  expect(service.saveSession).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Section 2 of 3')).toBeTruthy();
  const input = service.saveSession.mock.calls[0]![0];
  await act(async () =>
    write.resolve(
      ready({
        ...session,
        sessionId: input.sessionId,
        passageSequence: input.passageSequence,
        revision: 3,
        lastOperationId: input.operationId,
      }),
    ),
  );
  expect(screen.getByText('Section 1 of 3')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Next section' })).not.toBeDisabled();
});

test('a historical completion receipt reloads the current newer reading session', async () => {
  const hook = renderHook(() =>
    useCookingProgress({
      service,
      recipeId: recipe.recipeId,
      sections,
      visible: true,
      onPosition: mockPush,
    }),
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const newerSession = {
    ...session,
    sessionId: 'b0000000-0000-4000-8000-000000000002',
    revision: 8,
  };
  service.readSession.mockResolvedValue(ready({ ...view, session: newerSession }));
  await act(async () =>
    hook.result.current.acceptCompleted({ ...session, state: 'completed', revision: 3 }),
  );
  await waitFor(() => expect(hook.result.current.view?.session).toEqual(newerSession));
  act(() => {
    hook.result.current.move(2);
  });
  await waitFor(() => expect(service.saveSession).toHaveBeenCalledTimes(1));
  expect(service.saveSession.mock.calls[0]![0]).toMatchObject({
    sessionId: newerSession.sessionId,
    expectedRevision: 8,
  });
});

test('a matching saved session can be dismissed while leaving history untouched', async () => {
  reader();
  await screen.findByText('Section 2 of 3');
  fireEvent.press(screen.getByRole('button', { name: 'Reading options' }));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Dismiss saved cooking progress' }));
  });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Dismiss saved cooking progress' })).toBeNull(),
  );
  expect(service.dismissSession).toHaveBeenCalledTimes(1);
  expect(service.dismissSession.mock.calls[0]?.[0]).toMatchObject({
    recipeId: recipe.recipeId,
    sessionId: session.sessionId,
    expectedRevision: session.revision,
  });
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('early cooking entry is deliberate through Reading options and cancellation preserves the passage', async () => {
  reader();
  await screen.findByText('Section 2 of 3');
  expect(screen.queryByRole('button', { name: 'I cooked this' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Finish cooking' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Reading options' }).props.accessibilityState.expanded,
  ).toBe(false);
  fireEvent.press(screen.getByRole('button', { name: 'Reading options' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'I cooked this' })).toBeEnabled());
  fireEvent.press(screen.getByRole('button', { name: 'I cooked this' }));
  await screen.findByRole('button', { name: 'Confirm I cooked this' });
  expect(service.saveCooked).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel cooking entry' }));
  expect(screen.getByText('Section 2 of 3')).toBeTruthy();
  expect(service.saveSession).not.toHaveBeenCalled();
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('the final original section offers Finish cooking without logging before confirmation', async () => {
  reader();
  await screen.findByText('Section 2 of 3');
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  await screen.findByText('Section 3 of 3');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Finish cooking' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Next section' })).toBeNull();
  for (const passage of sections[2]!) expect(screen.getByText(passage.rawText)).toBeTruthy();
  expect(service.saveCooked).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Finish cooking' }));
  await screen.findByRole('button', { name: 'Confirm I cooked this' });
  expect(service.saveCooked).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel cooking entry' }));
  expect(screen.getByText('Section 3 of 3')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Finish cooking' })).toBeTruthy();
  expect(service.saveSession).toHaveBeenCalledTimes(1);
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test.each(['early', 'finish'] as const)(
  'completion focus moves from the %s trigger to the review, then back on cancellation',
  async (origin) => {
    reader();
    await screen.findByText('Section 2 of 3');
    const triggerLabel = origin === 'finish' ? 'Finish cooking' : 'I cooked this';
    if (origin === 'finish') {
      fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
      await screen.findByText('Section 3 of 3');
    } else fireEvent.press(screen.getByRole('button', { name: 'Reading options' }));
    await waitFor(() => expect(screen.getByRole('button', { name: triggerLabel })).toBeEnabled());
    mockFocusLabels.length = 0;
    fireEvent.press(screen.getByRole('button', { name: triggerLabel }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel cooking entry' })).toBeEnabled(),
    );
    const reviewHeading = screen.getByRole('header', { name: 'Cooking entry review' });
    fireEvent(reviewHeading, 'layout');
    expect(mockFocusLabels).toEqual(['Cooking entry review']);
    fireEvent.changeText(screen.getByLabelText('Private cooking note'), 'Retained private draft');
    fireEvent(reviewHeading, 'layout');
    expect(mockFocusLabels).toEqual(['Cooking entry review']);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel cooking entry' }));
    fireEvent(screen.getByRole('button', { name: triggerLabel }), 'layout');
    await waitFor(() => expect(mockFocusLabels).toEqual(['Cooking entry review', triggerLabel]));
    expect(
      screen.getByText(origin === 'finish' ? 'Section 3 of 3' : 'Section 2 of 3'),
    ).toBeTruthy();
    expect(service.saveCooked).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: triggerLabel }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel cooking entry' })).toBeEnabled(),
    );
    fireEvent(screen.getByRole('header', { name: 'Cooking entry review' }), 'layout');
    expect(mockFocusLabels).toEqual(['Cooking entry review', triggerLabel, 'Cooking entry review']);
    expect(screen.getByLabelText('Private cooking note').props.value).toBe(
      'Retained private draft',
    );
    expect(service.saveCooked).not.toHaveBeenCalled();
  },
);

test('reopening a completed form reviews current state and allows a deliberate second cooking entry', async () => {
  const rendered = render(completion());
  await confirmCooked('Only the first entry has this note');
  await screen.findByText('Cooking entry saved');
  service.readSession.mockResolvedValue(
    ready({ ...view, session: { ...session, state: 'completed', revision: 3 }, resume: 'none' }),
  );
  rendered.rerender(completion(false));
  rendered.rerender(completion(true));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  expect(screen.queryByText('Cooking entry saved')).toBeNull();
  expect(screen.getByLabelText('Private cooking note')).toHaveProp('value', '');
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
  await confirmCooked();
  await screen.findByText('Cooking entry saved');
  const firstId = service.saveCooked.mock.calls[0]?.[0].eventId;
  const second = service.saveCooked.mock.calls[1]?.[0];
  expect(second?.eventId).not.toBe(firstId);
  expect(second?.note).toBeNull();
  expect(second?.session).toBeUndefined();
});

test('history clearing invalidates a visible saved receipt and its private note before reopen', async () => {
  const rendered = render(completion());
  await confirmCooked('Private note to remove from the visible receipt');
  await screen.findByText('Cooking entry saved');
  expect(screen.getByText('Private note to remove from the visible receipt')).toBeTruthy();
  service.readHistory.mockResolvedValue(
    ready({ ...history, items: [], historyEpoch: 4, historyRevision: 5 }),
  );
  act(publishHistoryChange);
  expect(screen.queryByText('Private note to remove from the visible receipt')).toBeNull();
  expect(screen.queryByText('Cooking entry saved')).toBeNull();
  rendered.rerender(completion(false));
  rendered.rerender(completion(true));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  expect(screen.getByLabelText('Private cooking note')).toHaveProp('value', '');
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
});

test('durable cancellation resolves an absent cooked receipt and permits a new deliberate save after remount', async () => {
  service.saveCooked.mockImplementationOnce(async (input) => ({
    kind: 'uncertain',
    operationId: input.eventId,
    error: failure,
  }));
  const first = render(completion());
  await confirmCooked();
  await screen.findByText(/save result is uncertain/);
  const oldId = service.saveCooked.mock.calls[0]?.[0].eventId;
  first.unmount();
  render(completion());
  fireEvent.press(await screen.findByRole('button', { name: 'Check earlier cooking receipt' }));
  await screen.findByText(/No saved receipt could be confirmed/);
  fireEvent.press(screen.getByRole('button', { name: 'Resolve unconfirmed cooking change' }));
  await screen.findByText('Unconfirmed cooking change cancelled');
  expect(service.resolveCookedOperation).toHaveBeenCalledWith(oldId);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start a new cooking entry' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Start a new cooking entry' }));
  await confirmCooked();
  await screen.findByText('Cooking entry saved');
  expect(service.saveCooked).toHaveBeenCalledTimes(2);
  expect(service.saveCooked.mock.calls[1]?.[0].eventId).not.toBe(oldId);
  expect(service.saveSession).not.toHaveBeenCalled();
});

test('uncertain resolution retains the operation reference and blocks another cooked confirmation', async () => {
  service.saveCooked.mockImplementationOnce(async (input) => ({
    kind: 'uncertain',
    operationId: input.eventId,
    error: failure,
  }));
  service.resolveCookedOperation.mockImplementation(async (id) => ({
    kind: 'uncertain',
    operationId: id,
    error: failure,
  }));
  render(completion());
  await confirmCooked();
  await screen.findByText(/save result is uncertain/);
  fireEvent.press(screen.getByRole('button', { name: 'Resolve unconfirmed cooking change' }));
  await screen.findByText(/earlier change could not be resolved/);
  const oldId = service.saveCooked.mock.calls[0]?.[0].eventId;
  expect([...mockReferenceValues.values()].join('')).toContain(oldId);
  expect(screen.queryByRole('button', { name: 'Confirm I cooked this' })).toBeNull();
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
});

test('durable cancellation of an uncertain clear preserves entries and enables a fresh review', async () => {
  service.clearHistory.mockImplementationOnce(async (_review, operationId) => ({
    kind: 'uncertain',
    operationId,
    error: failure,
  }));
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText(entry.recipeTitle);
  await showHistoryOptions();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review clearing cooking history' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review clearing cooking history' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Confirm clear cooking history' }));
  await screen.findByText(/clear-history result is uncertain/);
  fireEvent.press(screen.getByRole('button', { name: 'Resolve unconfirmed history clear' }));
  await screen.findByText('Unconfirmed history clear cancelled');
  expect(screen.queryByText('Cooking history cleared')).toBeNull();
  expect(screen.getByText(entry.note!)).toBeTruthy();
  await showHistoryOptions();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review clearing cooking history' }),
    ).not.toBeDisabled(),
  );
  expect(service.clearHistory).toHaveBeenCalledTimes(1);
});

test('a late pre-clear history page cannot put removed private notes back on screen', async () => {
  const pageRead = deferred<Awaited<ReturnType<CookingService['readHistory']>>>();
  service.readHistory.mockReturnValueOnce(pageRead.promise);
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  act(publishHistoryChange);
  await act(async () => pageRead.resolve(ready(history)));
  expect(screen.queryByText(entry.note!)).toBeNull();
  expect(
    screen.getByText('History changed while loading. Refresh to read its current entries.'),
  ).toBeTruthy();
});

test('reader resumes the original saved passage without marking cooked or saving on open', async () => {
  reader();
  await screen.findByText('Section 2 of 3');
  expect(service.saveSession).not.toHaveBeenCalled();
  expect(service.saveCooked).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      recipe.instructions.find((passage) => passage.sequence === session.passageSequence)!.rawText,
    ),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  await waitFor(() => expect(service.saveSession).toHaveBeenCalledTimes(1));
  expect(service.saveSession.mock.calls[0]?.[0]).toMatchObject({
    recipeId: recipe.recipeId,
    sessionId: session.sessionId,
    expectedRevision: 2,
    passageSequence: sections[2]![0]!.sequence,
    contentFingerprint: content.contentFingerprint,
  });
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('changed source requires a deliberate restart or dismissal, never automatic progress replacement', async () => {
  service.readSession.mockResolvedValue(ready({ ...view, resume: 'content_changed' }));
  reader();
  await screen.findByText('The recipe has changed');
  expect(service.saveSession).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Next section' })).toBeDisabled();
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Restart with current recipe' }));
  });
  await waitFor(() => expect(screen.queryByText('The recipe has changed')).toBeNull());
  expect(service.saveSession.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: session.revision,
    passageSequence: sections[0]![0]!.sequence,
  });
  expect(service.saveSession.mock.calls[0]?.[0].sessionId).not.toBe(session.sessionId);
  expect(screen.getByText('Section 1 of 3')).toBeTruthy();
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('rapid section navigation coalesces the pending position and uses the committed revision', async () => {
  const firstSave = deferred<Awaited<ReturnType<CookingService['saveSession']>>>();
  service.saveSession.mockReturnValueOnce(firstSave.promise);
  service.readSession.mockResolvedValue(ready({ ...view, session: null, resume: 'none' }));
  const hook = renderHook(() =>
    useCookingProgress({
      service,
      recipeId: recipe.recipeId,
      sections,
      visible: true,
      onPosition: mockPush,
    }),
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => {
    hook.result.current.move(1);
    hook.result.current.move(0);
    hook.result.current.move(2);
  });
  expect(service.saveSession).toHaveBeenCalledTimes(1);
  const firstInput = service.saveSession.mock.calls[0]?.[0];
  if (!firstInput) throw new Error('Expected first progress write');
  await act(async () =>
    firstSave.resolve(
      ready({
        ...session,
        sessionId: firstInput.sessionId,
        passageSequence: firstInput.passageSequence,
        revision: 8,
        lastOperationId: firstInput.operationId,
      }),
    ),
  );
  await waitFor(() => expect(service.saveSession).toHaveBeenCalledTimes(2));
  expect(service.saveSession.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 8,
    passageSequence: sections[2]![0]!.sequence,
  });
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('marking cooked reviews the date and exact private note before one explicit save', async () => {
  const completed = jest.fn();
  render(
    <CookingCompletion
      visible
      service={service}
      readInstallationId={readIdentity}
      sessionView={view}
      title={recipe.title}
      clock={clock}
      onCancel={jest.fn()}
      onCompleted={completed}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  expect(service.saveCooked).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Cooked on date'), '2026-10-01');
  expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Cooked on date'), '2026-09-29');
  fireEvent.changeText(
    screen.getByLabelText('Private cooking note'),
    '  Exact private note: أقل ملح  ',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await screen.findByText('Cooking entry saved');
  expect(service.saveCooked.mock.calls[0]?.[0]).toMatchObject({
    recipeId: recipe.recipeId,
    expectedHistoryEpoch: 3,
    cookedOn: '2026-09-29',
    timeZone: 'Asia/Dubai',
    note: '  Exact private note: أقل ملح  ',
    session: { sessionId: session.sessionId, expectedRevision: 2 },
  });
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
});

test('uncertain cooking entries query proof and never repeat an absent receipt', async () => {
  service.saveCooked.mockImplementation(async (input) => ({
    kind: 'uncertain',
    operationId: input.eventId,
    error: failure,
  }));
  render(
    <CookingCompletion
      visible
      service={service}
      readInstallationId={readIdentity}
      sessionView={view}
      title={recipe.title}
      clock={clock}
      onCancel={jest.fn()}
      onCompleted={jest.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await screen.findByText(/save result is uncertain/);
  expect(screen.queryByText('Cooking entry saved')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Check cooking receipt' }));
  await screen.findByText(/No saved receipt could be confirmed/);
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
  expect(service.readCookedReceipt).toHaveBeenCalledWith(
    service.saveCooked.mock.calls[0]?.[0].eventId,
  );
});

test('history preserves recorded content and Plan again only opens a prefilled editor', async () => {
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText(entry.recipeTitle);
  expect(screen.getByText(entry.note!)).toBeTruthy();
  expect(screen.getByLabelText(`Supplied photo of ${entry.recipeTitle}`)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: `Plan ${entry.recipeTitle} again` }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/plan-edit',
    params: { recipeId: entry.recipeId },
  });
  expect(service.saveCooked).not.toHaveBeenCalled();
  expect(service.saveSession).not.toHaveBeenCalled();
});

test('empty history leads to recipes without routine refresh or meaningless clear controls', async () => {
  service.readHistory.mockResolvedValue(ready({ ...history, items: [] }));
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText('Cook something worth remembering.');
  expect(
    screen.queryByRole('button', {
      name: /Refresh|Retry cooking history|History options|Review clearing cooking history/,
    }),
  ).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Explore recipes' }));
  expect(mockPush).toHaveBeenCalledWith('/');
  expect(service.saveCooked).not.toHaveBeenCalled();
  expect(service.clearHistory).not.toHaveBeenCalled();
});

test('a failed history read exposes retry and removes it after current entries load', async () => {
  service.readHistory.mockResolvedValueOnce({ kind: 'failed', error: failure });
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText('History needs attention');
  fireEvent.press(screen.getByRole('button', { name: 'Retry cooking history' }));
  await screen.findByText(entry.recipeTitle);
  expect(screen.queryByRole('button', { name: 'Retry cooking history' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review clearing cooking history' })).toBeNull();
  expect(service.clearHistory).not.toHaveBeenCalled();
});

test('imported history is labelled as data and clearing discloses retained private archives', async () => {
  service.readHistory.mockResolvedValue(
    ready({ ...history, items: [{ ...entry, origin: 'backup' }] }),
  );
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText('Imported from backup · local history record');
  expect(screen.getByText(entry.note!)).toBeTruthy();
  expect(screen.queryByText(/only when you explicitly select them for that export/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Privacy & storage details' }));
  expect(screen.getByText(/only when you explicitly select them for that export/)).toBeTruthy();
  await showHistoryOptions();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review clearing cooking history' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review clearing cooking history' }));
  await screen.findByText('Clear cooking history?');
  expect(
    screen.getByText(
      /Retained restore archives and files you previously saved elsewhere are not deleted/,
    ),
  ).toBeTruthy();
  expect(service.clearHistory).not.toHaveBeenCalled();
});

test('clear history uses the exact review only after final confirmation; cancellation changes nothing', async () => {
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText(entry.recipeTitle);
  await showHistoryOptions();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review clearing cooking history' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review clearing cooking history' }));
  await screen.findByText('Clear cooking history?');
  expect(service.clearHistory).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Keep cooking history' }));
  expect(service.clearHistory).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Review clearing cooking history' }));
  await screen.findByText('Clear cooking history?');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm clear cooking history' }));
  await screen.findByText('Cooking history cleared');
  expect(service.clearHistory.mock.calls[0]?.[0]).toBe(clearReview);
  expect(screen.queryByText(entry.note!)).toBeNull();
  expect(service.dismissSession).not.toHaveBeenCalled();
});

test('an uncertain clear keeps its operation ID and checks the receipt without another clear', async () => {
  service.clearHistory.mockImplementation(async (_review, operationId) => ({
    kind: 'uncertain',
    operationId,
    error: failure,
  }));
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText(entry.recipeTitle);
  await showHistoryOptions();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review clearing cooking history' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review clearing cooking history' }));
  await screen.findByText('Clear cooking history?');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm clear cooking history' }));
  await screen.findByText(/clear-history result is uncertain/);
  fireEvent.press(screen.getByRole('button', { name: 'Check history clear receipt' }));
  await screen.findByText(/No clear-history receipt could be confirmed/);
  expect(service.clearHistory).toHaveBeenCalledTimes(1);
  const id = service.clearHistory.mock.calls[0]?.[1];
  if (!id) throw new Error('Expected clear operation');
  const result: Immutable<ClearCookingHistoryReceipt> = {
    operationId: id,
    outcome: 'cleared',
    clearedCount: 1,
    previousHistoryEpoch: 3,
    historyEpoch: 4,
    historyRevision: 5,
    committedAt: timestamp,
  };
  service.readClearHistoryReceipt.mockResolvedValue(ready(result));
  fireEvent.press(screen.getByRole('button', { name: 'Check history clear receipt' }));
  await screen.findByText('Cooking history cleared');
  expect(service.clearHistory).toHaveBeenCalledTimes(1);
});

test('reopening after an uncertain cooked save recovers only the saved ID and blocks a duplicate confirmation', async () => {
  service.saveCooked.mockImplementation(async (input) => ({
    kind: 'uncertain',
    operationId: input.eventId,
    error: failure,
  }));
  const first = render(
    <CookingCompletion
      visible
      service={service}
      readInstallationId={readIdentity}
      sessionView={view}
      title={recipe.title}
      clock={clock}
      onCancel={jest.fn()}
      onCompleted={jest.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  fireEvent.changeText(
    screen.getByLabelText('Private cooking note'),
    'Do not persist this unsaved private draft',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await screen.findByText(/save result is uncertain/);
  const id = service.saveCooked.mock.calls[0]?.[0].eventId;
  if (!id) throw new Error('Expected event ID');
  const retained = [...mockReferenceValues.values()].join('');
  expect(retained).toContain(id);
  expect(retained).not.toContain('Do not persist this unsaved private draft');
  first.unmount();
  render(
    <CookingCompletion
      visible
      service={service}
      readInstallationId={readIdentity}
      sessionView={view}
      title={recipe.title}
      clock={clock}
      onCancel={jest.fn()}
      onCompleted={jest.fn()}
    />,
  );
  const recoveryButton = await screen.findByRole('button', {
    name: 'Check earlier cooking receipt',
  });
  expect(screen.queryByRole('button', { name: 'Confirm I cooked this' })).toBeNull();
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
  service.readCookedReceipt.mockResolvedValue(
    ready({ kind: 'saved', event: { ...entry, eventId: id }, closedSession: null }),
  );
  fireEvent.press(recoveryButton);
  await screen.findByText('Cooking entry saved');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Check earlier cooking receipt' })).toBeNull(),
  );
  expect(service.saveCooked).toHaveBeenCalledTimes(1);
});

test('reopening after an uncertain clear exposes receipt lookup and disables another clear', async () => {
  service.clearHistory.mockImplementation(async (_review, operationId) => ({
    kind: 'uncertain',
    operationId,
    error: failure,
  }));
  const first = render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByText(entry.recipeTitle);
  await showHistoryOptions();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review clearing cooking history' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review clearing cooking history' }));
  await screen.findByText('Clear cooking history?');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm clear cooking history' }));
  await screen.findByText(/clear-history result is uncertain/);
  first.unmount();
  render(<CookingHistory service={service} readInstallationId={readIdentity} />);
  await screen.findByRole('button', { name: 'Check earlier history clear receipt' });
  await showHistoryOptions();
  expect(screen.getByRole('button', { name: 'Review clearing cooking history' })).toBeDisabled();
  expect(service.clearHistory).toHaveBeenCalledTimes(1);
});

test('Unicode note length is bounded without treating emoji as two user characters', async () => {
  render(
    <CookingCompletion
      visible
      service={service}
      readInstallationId={readIdentity}
      sessionView={view}
      title={recipe.title}
      clock={clock}
      onCancel={jest.fn()}
      onCompleted={jest.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled(),
  );
  fireEvent.changeText(screen.getByLabelText('Private cooking note'), '🍲'.repeat(2000));
  expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).not.toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Private cooking note'), `${'🍲'.repeat(2000)}x`);
  expect(screen.getByRole('button', { name: 'Confirm I cooked this' })).toBeDisabled();
  expect(service.saveCooked).not.toHaveBeenCalled();
});

test('an unresolved reading-position write blocks subsequent writes until a deliberate state check', async () => {
  service.saveSession.mockImplementation(async (input) => ({
    kind: 'uncertain',
    operationId: input.operationId,
    error: failure,
  }));
  const hook = renderHook(() =>
    useCookingProgress({
      service,
      recipeId: recipe.recipeId,
      sections,
      visible: true,
      onPosition: mockPush,
    }),
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => hook.result.current.move(2));
  await waitFor(() => expect(hook.result.current.uncertain).not.toBeNull());
  act(() => hook.result.current.move(0));
  expect(service.saveSession).toHaveBeenCalledTimes(1);
  await act(async () => hook.result.current.reload());
  expect(service.readSession).toHaveBeenCalledTimes(2);
  expect(hook.result.current.error).toContain('earlier save could not be verified');
  expect(service.saveSession).toHaveBeenCalledTimes(1);
});
