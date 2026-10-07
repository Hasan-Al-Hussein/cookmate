import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { catalogue } from '@cookmate/catalogue';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import {
  createRecipeSearch,
  type CookingService,
  type Immutable,
  type RepositoryResult,
} from '@cookmate/domain';
import type { ContentCookingHistoryPage } from '../../data/contentCookingHistoryRead';
import type { ContentCookingStoreChange } from '../../data/contentCookingStore';
import { OrdinaryCatalogueProvider } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import type { ContentWorkspaceState } from '../content/contentWorkspaceHost';
import { ActionButton } from '../../components/Controls';
import { ContentCookingHistory, type ContentHistoryHost } from './ContentCookingHistory';

const mockPush = jest.fn();
const mockReferenceValues = new Map<string, string>();
let mockId = 0;
let mockWriteGate: Promise<void> | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockPush }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('./cookingReferenceStorage', () => {
  const { createCookingReferenceStore } =
    jest.requireActual<typeof import('./cookingReferences')>('./cookingReferences');
  return {
    cookingReferenceStore: createCookingReferenceStore({
      read: async (key) => mockReferenceValues.get(key) ?? null,
      write: async (key, value) => {
        if (mockWriteGate) await mockWriteGate;
        mockReferenceValues.set(key, value);
      },
    }),
  };
});
jest.mock('../content/ContentRecipePhoto', () => ({
  ContentRecipePhoto: (props: { assetId?: string | null }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`Verified exact photo: ${props.assetId}`}</Text>;
  },
}));
const installation = 'e0000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-01T08:00:00.000Z';
const referenceKey = `cookmate.cooking-recovery.${installation}`;
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.failure',
  retry: 'never' as const,
};
const ready = <Value,>(value: Value): RepositoryResult<Value> => ({
  kind: 'ready',
  value,
  revision: 4,
});
const port = <Fn extends (...args: never[]) => unknown>() =>
  jest.fn<ReturnType<Fn>, Parameters<Fn>>();
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let packaged: Immutable<ReadingRecipe>;
beforeAll(async () => {
  packaged = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockId = 0;
  mockWriteGate = null;
  mockReferenceValues.clear();
});
afterEach(cleanup);
function row(index = 1, recipeId = packaged.recipeId): ContentCookingHistoryPage['items'][number] {
  const contentRef = { ...packaged.contentRef, recipeId, revisionId: `history-${index}` };
  return {
    entry: {
      readerVersion: 2,
      recipeId,
      contentRef,
      eventId: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      recipeTitle: `Recorded meal ${index}`,
      photoAssetId: null,
      cookedOn: '2026-09-30',
      timeZone: 'Asia/Dubai',
      recordedAt: timestamp,
      note: `Private note ${index}`,
      historyEpoch: 3,
      revision: 4,
    },
    pin: { kind: 'exact', ref: contentRef },
    source: 'local',
  };
}
/** Controlled presentation ports; signed-content, SQL and durable host behavior have separate tests. */
function fixture(items: ContentCookingHistoryPage['items'] = [row()]) {
  const current: Immutable<ReadingRecipe> = {
    ...packaged,
    title: 'Current verified meal',
    contentRef: { ...packaged.contentRef, revisionId: 'current-version' },
  };
  const search = createRecipeSearch({ identity: catalogue.identity, recipes: [current] });
  const catalogueState: OrdinaryCatalogueState = {
    kind: 'ready',
    scopeKey: 'catalogue:ready',
    mode: 'content',
    photoMode: 'verified',
    identity: catalogue.identity,
    recipes: [current],
    facets: search.facets,
    search: search.search,
    current: (id) => (id === current.recipeId ? current : undefined),
  };
  const reader = {
    getSnapshot: () => catalogueState,
    subscribe: () => () => undefined,
    retry: jest.fn(),
    close: jest.fn(),
    readCurrent: jest.fn(
      async (id: string): Promise<ReadingLookup> =>
        id === current.recipeId
          ? { kind: 'readable', state: 'current', recipe: current }
          : { kind: 'missing' },
    ),
    readSavedIdentity: async () => ({ kind: 'missing' as const }),
    readExact: jest.fn(
      async (ref: RecipeContentRef): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'historical',
        recipe: {
          ...packaged,
          recipeId: ref.recipeId,
          contentRef: ref,
          title: 'Exact saved recipe',
        },
      }),
    ),
    readPhoto: jest.fn(async () => {
      throw new Error('No photo bytes in presentation fixture');
    }),
    onPhotoCleanupFailure: jest.fn(),
  } satisfies OrdinaryCatalogueController;
  let state: ContentWorkspaceState = {
    status: 'ready',
    scopeKey: 'owner:opening1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>(),
    changes = new Set<(change: ContentCookingStoreChange) => void>();
  const page: ContentCookingHistoryPage = {
    items,
    historyRevision: 4,
    historyEpoch: 3,
    nextCursor: null,
  };
  const review = {
    reviewId: 'fixture-review',
    expectedHistoryRevision: 4,
    historyEpoch: 3,
    count: items.length,
  };
  const clearHistory = {
    reviewClearHistory: port<CookingService['reviewClearHistory']>().mockResolvedValue(
      ready(review),
    ),
    clearHistory: port<CookingService['clearHistory']>().mockImplementation(
      async (_review, operationId) => ({ kind: 'uncertain', operationId, error: failure }),
    ),
    readClearHistoryReceipt: port<CookingService['readClearHistoryReceipt']>().mockResolvedValue(
      ready(null),
    ),
    resolveClearHistoryOperation: port<
      CookingService['resolveClearHistoryOperation']
    >().mockImplementation(async (operationId) =>
      ready({
        operationId,
        outcome: 'cancelled',
        clearedCount: 0,
        previousHistoryEpoch: 3,
        historyEpoch: 3,
        historyRevision: 4,
        committedAt: timestamp,
      }),
    ),
  };
  const host = {
    history: {
      readHistory: port<ContentHistoryHost['history']['readHistory']>().mockResolvedValue(
        ready(page),
      ),
    },
    clearHistory,
    readInstallationId: port<ContentHistoryHost['readInstallationId']>().mockResolvedValue({
      kind: 'ready',
      value: installation,
      revision: 4,
    }),
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readerStore: {
      subscribe(listener: (change: ContentCookingStoreChange) => void) {
        changes.add(listener);
        return () => {
          changes.delete(listener);
        };
      },
    },
  } satisfies ContentHistoryHost;
  return {
    host,
    reader,
    current,
    page,
    review,
    publish(status: ContentWorkspaceState['status'], scopeKey = state.scopeKey) {
      act(() => {
        state = { ...state, status, scopeKey };
        for (const listener of listeners) listener();
      });
    },
    historyChanged() {
      act(() => {
        for (const listener of changes)
          listener({
            kind: 'cooking',
            value: { recipeId: null, historyChanged: true, revision: 5 },
          });
      });
    },
  };
}
function mount(f: ReturnType<typeof fixture>) {
  return render(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <ContentCookingHistory host={f.host} />
    </OrdinaryCatalogueProvider>,
  );
}
async function reviewClear() {
  fireEvent.press(await screen.findByRole('button', { name: 'History options' }));
  const button = screen.getByRole('button', { name: 'Review clearing cooking history' });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.press(button);
  await screen.findByText('Clear cooking history?');
}
function callback(label: string): () => void {
  const control = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((value) => value.props.label === label);
  if (!control) throw new Error(`Missing ${label}`);
  return control.props.onPress;
}
test('mixed exact, unresolved and withdrawn rows preserve recorded titles/notes and never substitute bundled navigation', async () => {
  const first = row(),
    unresolved = row(2, '90002'),
    withdrawn = row(3, '90003');
  if (first.entry.readerVersion !== 2) throw new Error('Exact fixture required');
  const secondary = {
    ...packaged.media[0]!,
    photoKey: 'secondary-photo',
    assetId: `sha256:${'b'.repeat(64)}`,
    sha256: 'b'.repeat(64),
  };
  first.entry.photoAssetId = secondary.assetId;
  unresolved.entry = {
    readerVersion: 1,
    recipeId: '90002',
    catalogue: catalogue.identity,
    contentFingerprint: 'b'.repeat(64),
    eventId: unresolved.entry.eventId,
    recipeTitle: unresolved.entry.recipeTitle,
    photoKey: 'unavailable',
    cookedOn: unresolved.entry.cookedOn,
    timeZone: unresolved.entry.timeZone,
    recordedAt: unresolved.entry.recordedAt,
    note: unresolved.entry.note,
    historyEpoch: 3,
    revision: 4,
    origin: 'backup',
  };
  unresolved.pin = { kind: 'unresolved', reason: 'content_mismatch' };
  unresolved.source = 'backup';
  withdrawn.source = 'account';
  const f = fixture([first, unresolved, withdrawn]);
  f.reader.readExact.mockImplementation(async (ref) =>
    ref.recipeId === '90003'
      ? { kind: 'withdrawn', recipeId: ref.recipeId, reason: 'Fixture withdrawal' }
      : {
          kind: 'readable',
          state: 'historical',
          recipe: {
            ...packaged,
            media: [secondary, ...packaged.media],
            contentRef: ref,
            title: 'Exact saved recipe',
          },
        },
  );
  mount(f);
  await screen.findByText('Private note 3');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'View recipe Recorded meal 1' })).not.toBeDisabled(),
  );
  expect(screen.getByRole('button', { name: 'View recipe Recorded meal 2' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'View recipe Recorded meal 3' })).toBeDisabled();
  expect(screen.getByText(/exact recipe version.*could not be established/)).toBeTruthy();
  expect(screen.getByText('Saved account history')).toBeTruthy();
  expect(screen.getAllByText(`Verified exact photo: ${secondary.assetId}`)).toHaveLength(1);
  expect(screen.queryByText(packaged.title)).toBeNull();
  expect(f.reader.readExact).not.toHaveBeenCalledWith(
    expect.objectContaining({ recipeId: '90002' }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'View recipe Recorded meal 1' }));
  await waitFor(() =>
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/recipe/[id]',
      params: {
        id: first.entry.recipeId,
        contentRef: expect.any(String),
      },
    }),
  );
  expect(JSON.parse(mockPush.mock.calls[0]![0].params.contentRef)).toEqual(
    first.pin.kind === 'exact' ? first.pin.ref : null,
  );
  fireEvent.press(
    await screen.findByRole('button', { name: 'Plan current version of Recorded meal 1' }),
  );
  await waitFor(() =>
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/plan-edit',
      params: { recipeId: first.entry.recipeId, contentRef: expect.any(String) },
    }),
  );
  expect(JSON.parse(mockPush.mock.calls[1]![0].params.contentRef)).toEqual(f.current.contentRef);
});
test('owner/update retirement clears notes and blocks retained navigation and clear callbacks before dispatch', async () => {
  const f = fixture();
  mount(f);
  await screen.findByText('Private note 1');
  await reviewClear();
  const clear = callback('Confirm clear cooking history');
  const view = callback('View recipe');
  f.publish('updating');
  expect(screen.queryByText('Private note 1')).toBeNull();
  await act(async () => {
    clear();
    view();
  });
  expect(f.host.clearHistory.clearHistory).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  f.host.history.readHistory.mockResolvedValue(ready({ ...f.page, items: [row(4)] }));
  f.publish('ready', 'owner:opening2');
  await screen.findByText('Private note 4');
  expect(screen.queryByText('Private note 1')).toBeNull();
});
test('an exact legacy entry selects its recorded secondary photo key instead of the current primary', async () => {
  const item = row();
  const secondary = {
    ...packaged.media[0]!,
    photoKey: 'recorded-legacy-secondary',
    assetId: `sha256:${'c'.repeat(64)}`,
    sha256: 'c'.repeat(64),
  };
  item.entry = {
    readerVersion: 1,
    recipeId: item.entry.recipeId,
    catalogue: catalogue.identity,
    contentFingerprint: 'd'.repeat(64),
    eventId: item.entry.eventId,
    recipeTitle: item.entry.recipeTitle,
    photoKey: secondary.photoKey,
    cookedOn: item.entry.cookedOn,
    timeZone: item.entry.timeZone,
    recordedAt: item.entry.recordedAt,
    note: item.entry.note,
    historyEpoch: 3,
    revision: 4,
  };
  const f = fixture([item]);
  f.reader.readExact.mockImplementation(async (ref) => ({
    kind: 'readable',
    state: 'historical',
    recipe: { ...packaged, contentRef: ref, media: [secondary, ...packaged.media] },
  }));
  mount(f);
  await screen.findByText(`Verified exact photo: ${secondary.assetId}`);
  expect(screen.queryByText('Recorded photo unavailable')).toBeNull();
});
test('a late history page after host retirement cannot expose old private notes', async () => {
  const f = fixture(),
    pending = deferred<Awaited<ReturnType<ContentHistoryHost['history']['readHistory']>>>();
  f.host.history.readHistory.mockReturnValue(pending.promise);
  mount(f);
  await waitFor(() => expect(f.host.history.readHistory).toHaveBeenCalledTimes(1));
  f.publish('revoked');
  await act(async () => pending.resolve(ready(f.page)));
  expect(screen.queryByText('Private note 1')).toBeNull();
});
test('without a catalogue provider, recorded history stays visible without recipe or photo authority', async () => {
  const f = fixture();
  render(<ContentCookingHistory host={f.host} />);
  await screen.findByText('Private note 1');
  expect(screen.getByText('Recorded meal 1')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'View recipe Recorded meal 1' })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Plan current version of Recorded meal 1' }),
  ).toBeNull();
  expect(screen.getByText('Recorded photo unavailable')).toBeTruthy();
  await act(async () => callback('View recipe')());
  expect(mockPush).not.toHaveBeenCalled();
  expect(f.reader.readExact).not.toHaveBeenCalled();
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
  expect(f.reader.readPhoto).not.toHaveBeenCalled();
});
test('pagination refuses changed history epochs and notifications remove stale notes while reloading', async () => {
  const f = fixture();
  f.host.history.readHistory
    .mockResolvedValueOnce(ready({ ...f.page, nextCursor: 'older' }))
    .mockResolvedValueOnce(ready({ ...f.page, historyEpoch: 4, items: [row(2)] }));
  mount(f);
  fireEvent.press(await screen.findByRole('button', { name: 'Load earlier cooking entries' }));
  await screen.findByText(/History changed while loading more entries/);
  expect(screen.queryByText('Private note 2')).toBeNull();
  const pending = deferred<Awaited<ReturnType<ContentHistoryHost['history']['readHistory']>>>();
  f.host.history.readHistory.mockReturnValueOnce(pending.promise);
  f.historyChanged();
  expect(screen.queryByText('Private note 1')).toBeNull();
  await act(async () => pending.resolve(ready({ ...f.page, items: [] })));
  expect(screen.getByText('Your cooking history')).toBeTruthy();
});
test('uncertain clear keeps only metadata, survives remount and resolves without another clear', async () => {
  const f = fixture(),
    mounted = mount(f);
  await screen.findByText('Private note 1');
  await reviewClear();
  fireEvent.press(screen.getByRole('button', { name: 'Confirm clear cooking history' }));
  await screen.findByText(/clear-history result is uncertain/);
  const retained = mockReferenceValues.get(referenceKey)!;
  expect(retained).toContain('clear_history');
  expect(retained).not.toContain('Private note');
  expect(retained).not.toContain('Recorded meal');
  expect(f.host.clearHistory.clearHistory.mock.calls[0]?.[0]).toBe(f.review);
  mounted.unmount();
  mount(f);
  fireEvent.press(await screen.findByRole('button', { name: 'Resolve unconfirmed history clear' }));
  await screen.findByText('Unconfirmed history clear cancelled');
  expect(f.host.clearHistory.clearHistory).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Private note 1')).toBeTruthy();
  expect(JSON.parse(mockReferenceValues.get(referenceKey)!).operations).toEqual([]);
});
test('revocation during reference persistence prevents clear dispatch and retains metadata for inspection', async () => {
  const f = fixture();
  mount(f);
  await screen.findByText('Private note 1');
  await reviewClear();
  const gate = deferred<void>();
  mockWriteGate = gate.promise;
  fireEvent.press(screen.getByRole('button', { name: 'Confirm clear cooking history' }));
  f.publish('revoked');
  await act(async () => gate.resolve());
  expect(f.host.clearHistory.clearHistory).not.toHaveBeenCalled();
  expect(mockReferenceValues.get(referenceKey)).toContain('clear_history');
  expect(screen.queryByText('Private note 1')).toBeNull();
});
test('retirement after clear dispatch hides private rows without claiming no clear and retains its operation reference', async () => {
  const f = fixture();
  const pending = deferred<Awaited<ReturnType<CookingService['clearHistory']>>>();
  f.host.clearHistory.clearHistory.mockReturnValueOnce(pending.promise);
  mount(f);
  await screen.findByText('Private note 1');
  await reviewClear();
  fireEvent.press(screen.getByRole('button', { name: 'Confirm clear cooking history' }));
  await waitFor(() => expect(f.host.clearHistory.clearHistory).toHaveBeenCalledTimes(1));
  const operationId = f.host.clearHistory.clearHistory.mock.calls[0]![1];
  f.publish('revoked');
  expect(screen.queryByText('Private note 1')).toBeNull();
  expect(screen.queryByText(/history has not been cleared/i)).toBeNull();
  expect(screen.getByText(/check any pending change/)).toBeTruthy();
  await act(async () =>
    pending.resolve(
      ready({
        operationId,
        outcome: 'cleared',
        clearedCount: 1,
        previousHistoryEpoch: 3,
        historyEpoch: 4,
        historyRevision: 5,
        committedAt: timestamp,
      }),
    ),
  );
  expect(screen.queryByText('Cooking history cleared')).toBeNull();
  expect(mockReferenceValues.get(referenceKey)).toContain(operationId);
  expect(f.host.clearHistory.clearHistory).toHaveBeenCalledTimes(1);
});
test('discarded clear review cannot be submitted through a retained callback; cooked ID-only recovery stays hidden', async () => {
  mockReferenceValues.set(
    referenceKey,
    JSON.stringify({
      schemaVersion: 1,
      installationId: installation,
      operations: [
        {
          operationId: 'c0000000-0000-4000-8000-000000000001',
          kind: 'cooked',
          recipeId: packaged.recipeId,
          createdAt: timestamp,
        },
      ],
    }),
  );
  const f = fixture();
  mount(f);
  await screen.findByText('Private note 1');
  await reviewClear();
  const submit = callback('Confirm clear cooking history');
  fireEvent.press(screen.getByRole('button', { name: 'Keep cooking history' }));
  await act(async () => submit());
  expect(f.host.clearHistory.clearHistory).not.toHaveBeenCalled();
  expect(screen.queryByText('Unconfirmed cooking entry')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check saved cooking entry' })).toBeNull();
});
