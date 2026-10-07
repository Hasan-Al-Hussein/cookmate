import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StrictMode } from 'react';
import { Text } from 'react-native';
import { createBundledContentReader, type ReadingRecipe } from '@cookmate/catalogue/content';
import type { CookingChange, Immutable } from '@cookmate/domain';
import { ActionButton } from '../../components/Controls';
import type { ContentCookingSession } from '../../data/contentCookingRecords';
import type { ContentCookedReceipt } from '../../data/contentCookingHistoryRecords';
import type { ContentCookingSessionView } from '../../data/contentCookingSessions';
import type { ContentWorkspaceState } from '../content/contentWorkspaceHost';
import type { CookingReaderPresentationProps } from './CookingReaderPresentation';
import type { ContentCookingReaderHost } from './contentCookingPorts';
import { ContentCookingReader } from './ContentCookingReader';
import { ContentCookingCompletion } from './ContentCookingCompletion';
import {
  ContentCookingPendingRecovery,
  ContentCookingSessionRecovery,
} from './ContentCookingSessionRecovery';
import { contentCookingReferenceStore } from './contentCookingReferenceStorage';

const mockValues = new Map<string, string>();
let mockAfterWrite: (() => void) | undefined;
let mockId = 0;
let mockPresentation: CookingReaderPresentationProps | undefined;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('./contentCookingReferenceStorage', () => ({
  contentCookingReferenceStore: jest
    .requireActual<typeof import('./contentCookingReferences')>('./contentCookingReferences')
    .createContentCookingReferenceStore({
      read: async (key: string) => mockValues.get(key) ?? null,
      write: async (key: string, value: string) => {
        mockValues.set(key, value);
        mockAfterWrite?.();
      },
    }),
}));
jest.mock('./CookingReaderPresentation', () => ({
  CookingReaderPresentation: (props: CookingReaderPresentationProps) => {
    const { View, Text } = jest.requireActual('react-native');
    mockPresentation = props;
    return (
      <View>
        {props.progress?.feedback}
        <Text>{props.sections[props.position]?.content}</Text>
      </View>
    );
  },
}));
jest.mock('../../components/focusTarget', () => ({ focusTarget: () => true }));
const installation = 'b0000000-0000-4000-8000-000000000001',
  timestamp = '2026-10-01T12:00:00.000Z';
const clock = {
  now: () => timestamp,
  dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
};
const ready = <T,>(value: T) => ({ kind: 'ready' as const, value, revision: 3 });
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.unavailable',
  retry: 'never' as const,
};
const uncertain = (operationId: string) => ({
  kind: 'uncertain' as const,
  operationId,
  error: failure,
});
function port<F extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<F>, Parameters<F>>();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let recipe: Immutable<ReadingRecipe>;
beforeAll(async () => {
  const bundled = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes.find(
    (value) => value.recipeId === '52819',
  )!;
  recipe = {
    ...bundled,
    contentRef: {
      ...bundled.contentRef,
      revisionId: 'exact-authored-reading',
      contentFingerprint: 'b'.repeat(64),
    },
    contentKind: 'authored',
    title: 'Exact authored dinner',
    instructions: [
      {
        recipeId: bundled.recipeId,
        sequence: 7,
        rawText: 'A supplied heading',
        presentation: 'heading',
        source: null,
      },
      {
        recipeId: bundled.recipeId,
        sequence: 11,
        rawText: 'An exact raw passage.',
        presentation: 'passage',
        source: null,
      },
      {
        recipeId: bundled.recipeId,
        sequence: 17,
        rawText: 'A second supplied heading',
        presentation: 'heading',
        source: null,
      },
      {
        recipeId: bundled.recipeId,
        sequence: 19,
        rawText: 'The next exact passage.',
        presentation: 'passage',
        source: null,
      },
    ],
    provenance: {
      kind: 'authored',
      authorId: 'Fixture',
      createdAt: timestamp,
      changeSummary: 'Fixture',
      basedOn: null,
      credits: [],
    },
    retainedSources: [],
  };
});
beforeEach(() => {
  mockValues.clear();
  mockAfterWrite = undefined;
  mockId = 0;
  mockPresentation = undefined;
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
function fixture() {
  let state: Readonly<ContentWorkspaceState> = {
    status: 'ready',
    scopeKey: 'fixture-owner:1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>(),
    cooking = new Set<(change: CookingChange) => void>();
  let session: Immutable<ContentCookingSession> | null = null;
  const receipts = new Map<string, Immutable<ContentCookedReceipt>>();
  const view = (): Immutable<ContentCookingSessionView> => ({
    session,
    pin: session ? { kind: 'exact', ref: session.contentRef } : null,
    recipe,
    resume: session?.state === 'active' ? 'exact' : 'none',
  });
  const sessions = {
    readSession: port<ContentCookingReaderHost['sessions']['readSession']>().mockImplementation(
      async () => ready(view()),
    ),
    saveSession: port<ContentCookingReaderHost['sessions']['saveSession']>().mockImplementation(
      async (input) => {
        session = {
          readerVersion: 2,
          recipeId: input.contentRef.recipeId,
          contentRef: input.contentRef,
          sessionId: input.sessionId,
          revision: (session?.revision ?? 0) + 1,
          passageSequence: input.passageSequence,
          state: 'active',
          updatedAt: timestamp,
          lastOperationId: input.operationId,
        };
        return ready({
          formatVersion: 1,
          kind: 'saved',
          operationId: input.operationId,
          requestFingerprint: 'c'.repeat(64),
          session,
          storeRevision: 3,
        });
      },
    ),
    dismissSession: port<
      ContentCookingReaderHost['sessions']['dismissSession']
    >().mockImplementation(async (input) => {
      if (!session) throw new Error('No fixture session');
      session = {
        ...session,
        state: 'dismissed',
        revision: session.revision + 1,
        lastOperationId: input.operationId,
      };
      return ready({
        formatVersion: 1,
        kind: 'dismissed',
        operationId: input.operationId,
        requestFingerprint: 'c'.repeat(64),
        session,
        storeRevision: 3,
      });
    }),
    recover: port<ContentCookingReaderHost['sessions']['recover']>().mockResolvedValue(ready(null)),
  };
  const cooked = {
    prepareCookedRecovery: port<
      ContentCookingReaderHost['cooked']['prepareCookedRecovery']
    >().mockImplementation(async (input) =>
      ready({
        formatVersion: 1,
        eventId: input.eventId,
        requestFingerprint: 'c'.repeat(64),
        contentRef: input.contentRef,
        expectedHistoryEpoch: input.expectedHistoryEpoch,
        session: input.session ?? null,
      }),
    ),
    saveCooked: port<ContentCookingReaderHost['cooked']['saveCooked']>().mockImplementation(
      async (input) => {
        const receipt: ContentCookedReceipt = {
          kind: 'saved',
          event: {
            readerVersion: 2,
            recipeId: input.contentRef.recipeId,
            contentRef: input.contentRef,
            eventId: input.eventId,
            recipeTitle: recipe.title,
            photoAssetId: null,
            cookedOn: input.cookedOn,
            timeZone: input.timeZone,
            recordedAt: timestamp,
            note: input.note ?? null,
            historyEpoch: input.expectedHistoryEpoch,
            revision: 3,
          },
          closedSession: null,
        };
        receipts.set(input.eventId, receipt);
        return ready(receipt);
      },
    ),
    readCookedRecovery: port<
      ContentCookingReaderHost['cooked']['readCookedRecovery']
    >().mockImplementation(async (ref) => ready(receipts.get(ref.eventId) ?? null)),
    resolveCookedRecovery: port<
      ContentCookingReaderHost['cooked']['resolveCookedRecovery']
    >().mockImplementation(async (ref) => {
      const receipt: Immutable<ContentCookedReceipt> = receipts.get(ref.eventId) ?? {
        kind: 'cancelled',
        eventId: ref.eventId,
        historyEpoch: ref.expectedHistoryEpoch,
      };
      receipts.set(ref.eventId, receipt);
      return ready(receipt);
    }),
  };
  const host: ContentCookingReaderHost = {
    sessions,
    cooked,
    history: {
      readHistory: port<ContentCookingReaderHost['history']['readHistory']>().mockResolvedValue(
        ready({ items: [], historyEpoch: 2, historyRevision: 3, nextCursor: null }),
      ),
    },
    readInstallationId: jest.fn(async () => ready(installation)),
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCooking: (listener) => {
      cooking.add(listener);
      return () => cooking.delete(listener);
    },
  };
  return {
    host,
    sessions,
    cooked,
    receipts,
    view,
    setSession: (value: Immutable<ContentCookingSession>) => {
      session = value;
    },
    retire: () => {
      state = { ...state, status: 'revoked', scopeKey: 'fixture-owner:2' };
      for (const listener of listeners) listener();
    },
    notifyHistory: () => {
      for (const listener of cooking)
        listener({ recipeId: recipe.recipeId, historyChanged: true, revision: 4 });
    },
  };
}
function saved(overrides: Partial<ContentCookingSession> = {}): ContentCookingSession {
  return {
    readerVersion: 2,
    recipeId: recipe.recipeId,
    contentRef: recipe.contentRef,
    sessionId: 'd0000000-0000-4000-8000-000000000001',
    revision: 2,
    passageSequence: 19,
    state: 'active',
    updatedAt: timestamp,
    lastOperationId: 'e0000000-0000-4000-8000-000000000001',
    ...overrides,
  };
}
function reader(f: ReturnType<typeof fixture>) {
  const resume = jest.fn();
  const result = render(
    <ContentCookingReader
      host={f.host}
      scopeKey="fixture-owner:1"
      recipe={recipe}
      clock={clock}
      visible
      onClose={() => undefined}
      onDismiss={() => undefined}
      onResumeRecipe={resume}
      ingredients={<Text>Raw amounts</Text>}
      ingredientNotes={null}
      sourceNotes={null}
      sourceNoteCount={0}
      fullInstructions={<Text>All original passages</Text>}
      renderSection={(passages) => <Text>{passages.map((p) => p.rawText).join('\n')}</Text>}
    />,
  );
  return { ...result, resume };
}
function completion(f: ReturnType<typeof fixture>) {
  const onCompleted = jest.fn(async () => undefined);
  const current = () => f.host.getSnapshot().status === 'ready';
  const result = render(
    <ContentCookingCompletion
      host={f.host}
      scopeKey="fixture-owner:1"
      recipe={recipe}
      clock={clock}
      visible
      isCurrent={current}
      onCancel={() => undefined}
      onCompleted={onCompleted}
    />,
  );
  return { ...result, onCompleted };
}

test('exact saved passage resumes using original sequences without inventing authored procedure roles', async () => {
  const f = fixture();
  f.setSession(saved());
  reader(f);
  await waitFor(() => expect(mockPresentation?.progress?.ready).toBe(true));
  expect(mockPresentation?.position).toBe(1);
  expect(mockPresentation?.sections.map((section) => section.role)).toEqual([null, null]);
  act(() => {
    mockPresentation!.onMove(0);
  });
  await waitFor(() => expect(f.sessions.saveSession).toHaveBeenCalledTimes(1));
  expect(f.sessions.saveSession.mock.calls[0]![0]).toMatchObject({
    contentRef: recipe.contentRef,
    passageSequence: 7,
    expectedRevision: 2,
  });
});
test('different saved version requires explicit resume or restart and never silently moves its anchor', async () => {
  const f = fixture(),
    ref = { ...recipe.contentRef, revisionId: 'older-exact', contentFingerprint: 'd'.repeat(64) };
  f.setSession(saved({ contentRef: ref }));
  const ui = reader(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Resume saved recipe version' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  expect(mockPresentation?.progress?.ready).toBe(false);
  fireEvent.press(screen.getByRole('button', { name: 'Resume saved recipe version' }));
  expect(ui.resume).toHaveBeenCalledWith(ref);
  expect(f.sessions.saveSession).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Restart with displayed recipe' }));
  await waitFor(() => expect(f.sessions.saveSession).toHaveBeenCalledTimes(1));
  expect(f.sessions.saveSession.mock.calls[0]![0]).toMatchObject({
    contentRef: recipe.contentRef,
    expectedRevision: 2,
    passageSequence: 7,
  });
  expect(f.sessions.saveSession.mock.calls[0]![0].sessionId).not.toBe(saved().sessionId);
});
test('uncertain reading save keeps original metadata through remount and deliberate retry uses the same request', async () => {
  const f = fixture();
  f.sessions.saveSession.mockImplementationOnce(async (input) => uncertain(input.operationId));
  const ui = reader(f);
  await waitFor(() => expect(mockPresentation?.progress?.ready).toBe(true));
  act(() => {
    mockPresentation!.onMove(1);
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry this same request' })).toBeTruthy(),
  );
  const original = f.sessions.saveSession.mock.calls[0]![0];
  ui.unmount();
  reader(f);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check saved reading position' })).toBeTruthy(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Check saved reading position' }));
  await waitFor(() => expect(f.sessions.recover).toHaveBeenCalled());
  expect(f.sessions.saveSession).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Retry this same request' }));
  await waitFor(() => expect(f.sessions.saveSession).toHaveBeenCalledTimes(2));
  expect(f.sessions.saveSession.mock.calls[1]![0]).toEqual(original);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retry this same request' })).toBeNull(),
  );
});
test('body-free v2 dismissal works without a recipe while retained callbacks retire with scope', async () => {
  const f = fixture();
  f.setSession(saved());
  const view = { ...f.view(), recipe: null, resume: 'unavailable' as const };
  render(<ContentCookingSessionRecovery host={f.host} scopeKey="fixture-owner:1" view={view} />);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Dismiss saved cooking progress' }).props
        .accessibilityState.disabled,
    ).toBe(false),
  );
  const callback = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Dismiss saved cooking progress')!.props.onPress;
  act(() => f.retire());
  await act(async () => callback());
  expect(f.sessions.dismissSession).not.toHaveBeenCalled();
});
test('body-free v2 dismissal sends only the actual session baseline', async () => {
  const f = fixture();
  f.setSession(saved());
  render(
    <ContentCookingSessionRecovery
      host={f.host}
      scopeKey="fixture-owner:1"
      view={{ ...f.view(), recipe: null, resume: 'unavailable' }}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Dismiss saved cooking progress' }).props
        .accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Dismiss saved cooking progress' }));
  await waitFor(() => expect(f.sessions.dismissSession).toHaveBeenCalledTimes(1));
  expect(f.sessions.dismissSession.mock.calls[0]![0]).toMatchObject({
    recipeId: recipe.recipeId,
    sessionId: saved().sessionId,
    expectedRevision: 2,
  });
});
test('completion keeps raw note in explicit save only and durable recovery metadata excludes it', async () => {
  const f = fixture();
  f.cooked.saveCooked.mockImplementationOnce(async (input) => uncertain(input.eventId));
  completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  fireEvent.changeText(
    screen.getByLabelText('Private cooking note'),
    '  Private exact draft\nsecond line  ',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() => expect(f.cooked.saveCooked).toHaveBeenCalled());
  expect(f.cooked.saveCooked.mock.calls[0]![0]).toMatchObject({
    note: '  Private exact draft\nsecond line  ',
    contentRef: recipe.contentRef,
    expectedHistoryEpoch: 2,
  });
  expect([...mockValues.values()].join('')).not.toContain('Private exact draft');
  expect(await contentCookingReferenceStore.load(installation)).toHaveLength(1);
});
test('lost cooked acknowledgement recovers after remount without replaying the private request', async () => {
  const f = fixture();
  const original = f.cooked.saveCooked.getMockImplementation()!;
  f.cooked.saveCooked.mockImplementationOnce(async (input) => {
    await original(input);
    return uncertain(input.eventId);
  });
  let ui = completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  fireEvent.changeText(screen.getByLabelText('Private cooking note'), 'Original private note');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check cooking receipt' })).toBeTruthy(),
  );
  ui.unmount();
  ui = completion(f);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check cooking receipt' })).toBeTruthy(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Check cooking receipt' }));
  await waitFor(() => expect(screen.getByText('Cooking entry saved')).toBeTruthy());
  expect(screen.getByText('Original private note')).toBeTruthy();
  expect(f.cooked.saveCooked).toHaveBeenCalledTimes(1);
  expect(await contentCookingReferenceStore.load(installation)).toEqual([]);
});
test('resolution cancels an uncommitted cooked descriptor without recreating its lost note', async () => {
  const f = fixture();
  f.cooked.saveCooked.mockImplementationOnce(async (input) => uncertain(input.eventId));
  const ui = completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Resolve unconfirmed cooking change' })).toBeTruthy(),
  );
  ui.unmount();
  completion(f);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Resolve unconfirmed cooking change' })).toBeTruthy(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Resolve unconfirmed cooking change' }));
  await waitFor(() =>
    expect(screen.getByText('Unconfirmed cooking change cancelled')).toBeTruthy(),
  );
  expect(f.cooked.saveCooked).toHaveBeenCalledTimes(1);
  expect(f.cooked.resolveCookedRecovery).toHaveBeenCalledTimes(1);
});
test('retirement after durable remember suppresses dispatch and preserves the original recovery reference', async () => {
  const f = fixture();
  completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  mockAfterWrite = () => f.retire();
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() => expect(mockValues.size).toBe(1));
  await act(async () => undefined);
  expect(f.cooked.saveCooked).not.toHaveBeenCalled();
  expect(await contentCookingReferenceStore.load(installation)).toHaveLength(1);
});
test('owner retirement during save never displays a saved or unsaved assurance', async () => {
  const f = fixture();
  const pending = deferred<Awaited<ReturnType<ContentCookingReaderHost['cooked']['saveCooked']>>>();
  f.cooked.saveCooked.mockReturnValue(pending.promise);
  completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  fireEvent.changeText(screen.getByLabelText('Private cooking note'), 'Retired private note');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() => expect(f.cooked.saveCooked).toHaveBeenCalled());
  act(() => f.retire());
  await act(async () => pending.resolve(uncertain(f.cooked.saveCooked.mock.calls[0]![0].eventId)));
  expect(screen.queryByText('Cooking entry saved')).toBeNull();
  expect(screen.queryByText(/not saved/)).toBeNull();
  expect(await contentCookingReferenceStore.load(installation)).toHaveLength(1);
});
test('private draft remains when preparation rejects and no command is dispatched', async () => {
  const f = fixture();
  f.cooked.prepareCookedRecovery.mockResolvedValue({ kind: 'failed', error: failure });
  completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  fireEvent.changeText(screen.getByLabelText('Private cooking note'), 'Keep this draft');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() => expect(screen.getByText(/Your draft is kept/)).toBeTruthy());
  expect(screen.getByLabelText('Private cooking note').props.value).toBe('Keep this draft');
  expect(f.cooked.saveCooked).not.toHaveBeenCalled();
});
test('reopened cooked metadata stays recoverable without an active session or available recipe body', async () => {
  const f = fixture();
  const input = {
    eventId: 'f0000000-0000-4000-8000-000000000001',
    contentRef: recipe.contentRef,
    expectedHistoryEpoch: 2,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    note: 'Private receipt must not appear on Discover',
  };
  await f.cooked.saveCooked(input);
  const prepared = await f.cooked.prepareCookedRecovery(input);
  if (prepared.kind !== 'ready') throw new Error('Fixture preparation failed');
  await contentCookingReferenceStore.remember(installation, {
    kind: 'cooked',
    createdAt: timestamp,
    reference: prepared.value,
  });
  f.sessions.readSession.mockResolvedValue(
    ready({ session: null, pin: null, recipe: null, resume: 'unavailable' }),
  );
  render(<ContentCookingPendingRecovery host={f.host} scopeKey="fixture-owner:1" />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check cooking receipt' })).toBeTruthy(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Check cooking receipt' }));
  await waitFor(() => expect(screen.getByText('The cooking entry was confirmed.')).toBeTruthy());
  expect(screen.queryByText(input.note)).toBeNull();
  expect(f.sessions.readSession).not.toHaveBeenCalled();
  expect(f.cooked.saveCooked).toHaveBeenCalledTimes(1);
  expect(await contentCookingReferenceStore.load(installation)).toEqual([]);
});
test('history changes during receipt verification retain recovery and never show an old private note', async () => {
  const f = fixture();
  const proof =
    deferred<Awaited<ReturnType<ContentCookingReaderHost['cooked']['readCookedRecovery']>>>();
  f.cooked.readCookedRecovery.mockReturnValueOnce(proof.promise);
  completion(f);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm I cooked this' }).props.accessibilityState
        .disabled,
    ).toBe(false),
  );
  fireEvent.changeText(
    screen.getByLabelText('Private cooking note'),
    'Do not reveal stale private note',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Confirm I cooked this' }));
  await waitFor(() => expect(f.cooked.readCookedRecovery).toHaveBeenCalledTimes(1));
  const id = f.cooked.saveCooked.mock.calls[0]![0].eventId;
  act(() => f.notifyHistory());
  await act(async () => proof.resolve(ready(f.receipts.get(id)!)));
  expect(screen.queryByText('Do not reveal stale private note')).toBeNull();
  expect(screen.queryByText('Cooking entry saved')).toBeNull();
  expect(await contentCookingReferenceStore.load(installation)).toHaveLength(1);
});
test('StrictMode effect replay leaves metadata hydration and exact dismiss usable', async () => {
  const f = fixture();
  f.setSession(saved());
  render(
    <StrictMode>
      <ContentCookingSessionRecovery host={f.host} scopeKey="fixture-owner:1" view={f.view()} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Dismiss saved cooking progress' }).props
        .accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Dismiss saved cooking progress' }));
  await waitFor(() => expect(f.sessions.dismissSession).toHaveBeenCalledTimes(1));
});
