import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { isValidElement, type ComponentProps } from 'react';
import { catalogue, getRecipe, type Immutable } from '@cookmate/catalogue';
import { createRecipeSearch } from '@cookmate/domain';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import RecipeDetailsScreen from '../recipes/RecipeDetailsScreen';
import { RecipePersonalEntry } from '../personal/RecipePersonalEntry';
import { ActionButton } from '../../components/Controls';
import { OrdinaryCatalogueProvider } from './OrdinaryCatalogue';
import type { OrdinaryCatalogueController, OrdinaryCatalogueState } from './ordinaryCatalogueState';
import type { ContentRecipeReaderViewProps } from './ContentRecipeReaderView';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';
import { RecentlyViewedProvider } from '../recently-viewed/RecentlyViewedProvider';
import {
  createRecentlyViewedController,
  encodeRecentlyViewed,
} from '../recently-viewed/recentlyViewed';
import {
  ContentCookingReader,
  type ContentCookingReaderProps,
} from '../cooking/ContentCookingReader';

let mockParams: { id: string; contentRef?: unknown; section?: string; cook?: string };
let mockRuntime: { host: object } | null = null;
jest.mock('./ordinaryContentRuntimeContext', () => ({
  useOrdinaryContentRuntime: () => mockRuntime,
}));
let mockView: ContentRecipeReaderViewProps | undefined;
const mockPush = jest.fn();
const mockBack = jest.fn(),
  mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => true,
    push: mockPush,
  }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('./ContentRecipeReaderView', () => ({
  ContentRecipeReaderView: (props: ContentRecipeReaderViewProps) => {
    mockView = props;
    const { Text } = jest.requireActual('react-native');
    return (
      <Text>
        {props.lookup.kind === 'readable' ? props.lookup.recipe.title : props.lookup.kind}
      </Text>
    );
  },
}));
jest.mock('./ContentRecipePhoto', () => ({ ContentRecipePhoto: () => null }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '52839': 1 } }));

let original: Immutable<ReadingRecipe>;
type PhotoResult = Awaited<ReturnType<OrdinaryCatalogueController['readPhoto']>>;
beforeAll(async () => {
  // Controlled presentation ports; actual signature/media authority is tested by the host lane.
  original = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
beforeEach(() => {
  mockRuntime = null;
  mockParams = { id: '90001' };
  mockView = undefined;
  mockBack.mockClear();
  mockPush.mockClear();
  mockReplace.mockClear();
});

test('exact cooking resumes its route and hands Watch to the reader only after dismissal', async () => {
  mockRuntime = { host: {} };
  const recipe = authored(),
    f = fixture(recipe),
    watch = jest.fn();
  mockParams = {
    id: recipe.recipeId,
    contentRef: JSON.stringify(recipe.contentRef),
    cook: 'resume',
  };
  const view = mounted(f);
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  const parts = {
    recipe,
    ingredients: null,
    ingredientNotes: null,
    sourceNotes: null,
    fullInstructions: null,
    renderSection: () => null,
    sectionRoles: [],
    sourceNoteCount: 0,
    onWatch: watch,
  };
  const cooking = () => {
    const element = mockView!.renderCooking!(parts);
    if (!isValidElement<ContentCookingReaderProps>(element))
      throw new Error('Expected cooking reader');
    expect(element.type).toBe(ContentCookingReader);
    return element.props;
  };
  expect(mockView?.initialSection).toBe('instructions');
  expect(cooking().visible).toBe(true);
  expect(cooking().recipe.contentRef).toEqual(recipe.contentRef);
  act(() => cooking().onWatch!());
  expect(cooking().visible).toBe(false);
  expect(watch).not.toHaveBeenCalled();
  act(() => cooking().onDismiss());
  expect(watch).toHaveBeenCalledTimes(1);
  const retained = cooking();
  act(() => f.set({ kind: 'unavailable', reason: 'revoked', scopeKey: 'retired' }));
  act(() => {
    retained.onWatch?.();
    retained.onDismiss();
    retained.onResumeRecipe(recipe.contentRef);
  });
  expect(watch).toHaveBeenCalledTimes(1);
  expect(mockReplace).not.toHaveBeenCalled();
});

test('a pending cooking Watch action is cancelled if the recipe route retires before dismissal', async () => {
  mockRuntime = { host: {} };
  const recipe = authored(),
    f = fixture(recipe),
    watch = jest.fn();
  mockParams.cook = 'resume';
  const view = mounted(f);
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  const element = mockView!.renderCooking!({
    recipe,
    ingredients: null,
    ingredientNotes: null,
    sourceNotes: null,
    fullInstructions: null,
    renderSection: () => null,
    sectionRoles: [],
    sourceNoteCount: 0,
    onWatch: watch,
  });
  if (!isValidElement<ContentCookingReaderProps>(element)) throw new Error('Expected reader');
  act(() => element.props.onWatch!());
  view.unmount();
  act(() => element.props.onDismiss());
  expect(watch).not.toHaveBeenCalled();
});
afterEach(cleanup);

function authored(id = '90001', title = 'Adopted sumac supper'): Immutable<ReadingRecipe> {
  return {
    ...original,
    recipeId: id,
    title,
    contentRef: {
      recipeId: id,
      revisionId: 'ordinary-detail-fixture',
      contentFingerprint: 'b'.repeat(64),
    },
    contentKind: 'authored',
    description: 'Actual reader presentation fixture.',
    media: [],
    retainedSources: [],
    annotations: [],
    videoUrl: null,
    ingredients: [
      { recipeId: id, position: 1, rawName: 'Sumac', rawMeasure: '  ½ tsp  ', source: null },
    ],
    instructions: [
      {
        recipeId: id,
        sequence: 1,
        rawText: 'Keep this original paragraph.',
        presentation: 'passage',
        source: null,
      },
    ],
    provenance: {
      kind: 'authored',
      authorId: 'Fixture author',
      createdAt: '2026-10-01T00:00:00.000Z',
      changeSummary: 'Presentation only.',
      basedOn: null,
      credits: [],
    },
  };
}
function ready(recipe = authored(), scopeKey = 'owner1:head1'): OrdinaryCatalogueState {
  const search = createRecipeSearch({ identity: catalogue.identity, recipes: [recipe] });
  return {
    kind: 'ready',
    scopeKey,
    mode: 'content',
    photoMode: 'verified',
    identity: catalogue.identity,
    recipes: [recipe],
    facets: search.facets,
    search: search.search,
    current: (id) => (id === recipe.recipeId ? recipe : undefined),
  };
}
function fixture(recipe = authored()) {
  let state = ready(recipe);
  const listeners = new Set<() => void>();
  const reader = {
    getSnapshot: () => state,
    subscribe(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    retry: jest.fn(),
    readCurrent: jest.fn(
      async (_id: string): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'current',
        recipe,
      }),
    ),
    readSavedIdentity: async () => ({ kind: 'missing' as const }),
    readExact: jest.fn(
      async (_ref: RecipeContentRef): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'historical',
        recipe,
      }),
    ),
    readPhoto: jest.fn(
      async (
        _ref: RecipeContentRef,
        _assetId: string,
        _signal?: AbortSignal,
      ): Promise<PhotoResult> => {
        throw new Error('Photo fixture has no byte port');
      },
    ),
    onPhotoCleanupFailure: jest.fn(),
    close: jest.fn(),
  } satisfies OrdinaryCatalogueController;
  return {
    reader,
    set(next: OrdinaryCatalogueState) {
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      });
    },
  };
}
function mounted(f: ReturnType<typeof fixture>) {
  return render(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <RecipeDetailsScreen />
    </OrdinaryCatalogueProvider>,
  );
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function photoResult(recipe: Immutable<ReadingRecipe>): PhotoResult {
  // Controlled presentation response; no verified image or signature claim.
  return {
    installationId: '11111111-1111-4111-8111-111111111111',
    ownerId: null,
    head: null,
    adoptionRevision: 0,
    identity: catalogue.identity,
    value: {
      contentRef: recipe.contentRef,
      assetId: `sha256:${'e'.repeat(64)}`,
      sha256: 'e'.repeat(64),
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: new Uint8Array([1]),
    },
  };
}

test('ordinary Details forwards the exact photo AbortSignal to its catalogue controller', async () => {
  const recipe = authored(),
    f = fixture(recipe),
    response = photoResult(recipe);
  f.reader.readPhoto.mockResolvedValue(response);
  const view = mounted(f);
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  const request = new AbortController();
  await expect(
    mockView!.readPhoto(recipe.contentRef, response.value.assetId, request.signal),
  ).resolves.toBe(response);
  expect(f.reader.readPhoto).toHaveBeenCalledWith(
    recipe.contentRef,
    response.value.assetId,
    request.signal,
  );
  expect(f.reader.readPhoto.mock.calls[0]![2]).toBe(request.signal);
});

test.each(['aborted', 'unmounted'] as const)(
  'ordinary Details discards a pending photo when %s',
  async (retirement) => {
    const recipe = authored(),
      f = fixture(recipe),
      response = photoResult(recipe);
    const late = deferred<PhotoResult>(),
      request = new AbortController();
    const abortError = new Error('Controlled catalogue request aborted');
    f.reader.readPhoto.mockImplementation(
      (_ref, _assetId, signal) =>
        new Promise((resolve, reject) => {
          // The controller owns cancellation; this rejects only if the wrapper forwards the signal.
          const abort = () => reject(abortError);
          signal?.addEventListener('abort', abort, { once: true });
          void late.promise.then((value) => {
            signal?.removeEventListener('abort', abort);
            resolve(value);
          });
        }),
    );
    const view = mounted(f);
    await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
    const escaped = jest.fn();
    const pending = mockView!.readPhoto(recipe.contentRef, response.value.assetId, request.signal);
    const outcome = pending.then(escaped, (error: unknown) => error);
    expect(f.reader.readPhoto.mock.calls[0]![2]).toBe(request.signal);
    if (retirement === 'aborted') request.abort();
    else view.unmount();
    await act(async () => {
      late.resolve(response);
      await outcome;
    });
    expect(escaped).not.toHaveBeenCalled();
    if (retirement === 'aborted') expect(await outcome).toBe(abortError);
    else expect(await outcome).toEqual(new Error('Recipe workspace changed'));
  },
);

test.each(['absent', 'bundled'] as const)(
  'the %s adapter keeps existing full bundled workflow and Source route',
  (mode) => {
    mockParams = { id: '52839', section: 'source' };
    const f = fixture();
    if (mode === 'bundled') {
      const state = ready();
      if (state.kind !== 'ready') throw new Error('Fixture must be ready');
      f.set({ ...state, mode: 'bundled', photoMode: 'bundled' });
    }
    const view = mode === 'absent' ? render(<RecipeDetailsScreen />) : mounted(f);
    expect(view.getByText(getRecipe('52839')!.title)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Add to plan' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Ask about this recipe' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Source' })).toBeSelected();
    expect(mockView).toBeUndefined();
    expect(f.reader.readCurrent).not.toHaveBeenCalled();
  },
);

test('a validated matching bundled exact route retains the full existing recipe workflow', () => {
  const f = fixture(original),
    state = ready(original);
  if (state.kind !== 'ready') throw new Error('Expected ready fixture');
  f.set({ ...state, mode: 'bundled', photoMode: 'bundled' });
  mockParams = {
    id: original.recipeId,
    contentRef: JSON.stringify(original.contentRef),
    section: 'source',
  };
  const view = mounted(f);
  expect(view.getByText(original.title)).toBeTruthy();
  expect(view.getByRole('button', { name: 'Add to plan' })).toBeTruthy();
  expect(view.getByRole('tab', { name: 'Source' })).toBeSelected();
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
});

test('a retained bundled snapshot cannot authorize exact fallback once its current getter retires', () => {
  const f = fixture(original),
    state = ready(original);
  if (state.kind !== 'ready') throw new Error('Expected ready fixture');
  let retired = false;
  f.set({
    ...state,
    mode: 'bundled',
    photoMode: 'bundled',
    current: (id) => {
      if (retired) throw new Error('retired');
      return id === original.recipeId ? original : undefined;
    },
  });
  mockParams = { id: original.recipeId, contentRef: JSON.stringify(original.contentRef) };
  const view = mounted(f);
  expect(view.getByText(original.title)).toBeTruthy();
  retired = true;
  view.rerender(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <RecipeDetailsScreen />
    </OrdinaryCatalogueProvider>,
  );
  expect(view.queryByText(original.title)).toBeNull();
  expect(view.getByText('Saved recipe version unavailable')).toBeTruthy();
});

test.each(['content', 'bundled'] as const)(
  'a focused %s recipe body records only its exact reference',
  async (mode) => {
    const recipe = mode === 'bundled' ? original : authored(),
      f = fixture(recipe);
    if (mode === 'bundled') {
      const state = ready(original);
      if (state.kind !== 'ready') throw new Error('Expected ready fixture');
      f.set({ ...state, mode: 'bundled', photoMode: 'bundled' });
    }
    mockParams = { id: recipe.recipeId };
    let stored = encodeRecentlyViewed({ enabled: true, entries: [] });
    const recent = createRecentlyViewedController(
      {
        read: async () => stored,
        write: async (value) => {
          stored = value;
        },
      },
      { now: () => 1000 },
    );
    const view = render(
      <RecentlyViewedProvider controller={recent}>
        <OrdinaryCatalogueProvider controller={f.reader}>
          <RecipeDetailsScreen />
        </OrdinaryCatalogueProvider>
      </RecentlyViewedProvider>,
    );
    await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
    await waitFor(() => expect(recent.getSnapshot().entries).toHaveLength(1));
    expect(JSON.parse(stored)).toEqual({
      schemaVersion: 1,
      enabled: true,
      entries: [{ ref: recipe.contentRef, openedAt: 1000 }],
    });
    expect(stored).not.toContain(recipe.title);
    recent.dispose();
  },
);

test('normal current recipe routing reads adopted-only IDs and forwards Source without legacy actions', async () => {
  const recipe = authored(),
    f = fixture(recipe);
  mockParams.section = 'source';
  const view = mounted(f);
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  expect(f.reader.readCurrent).toHaveBeenCalledWith(recipe.recipeId);
  expect(f.reader.readExact).not.toHaveBeenCalled();
  expect(mockView?.initialSection).toBe('source');
  expect(mockView?.onPlan).toBeDefined();
  const noteEntry = mockView?.personalControl;
  if (!isValidElement<ComponentProps<typeof RecipePersonalEntry>>(noteEntry))
    throw new Error('Expected the ordinary private note entry');
  expect(noteEntry.type).toBe(RecipePersonalEntry);
  expect(noteEntry.props.recipeId).toBe(recipe.recipeId);
  expect(noteEntry.props.contentRef).toEqual(recipe.contentRef);
  expect(noteEntry.props.isCurrent?.()).toBe(true);
  const plan = mockView!.onPlan!;
  act(() => plan(recipe.contentRef));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/plan-edit',
    params: {
      recipeId: recipe.recipeId,
      contentRef: JSON.stringify(recipe.contentRef, Object.keys(recipe.contentRef).sort()),
    },
  });
  mockPush.mockClear();
  act(() => f.set({ kind: 'unavailable', reason: 'revoked', scopeKey: 'retired' }));
  expect(noteEntry.props.isCurrent?.()).toBe(false);
  act(() => plan(recipe.contentRef));
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockView?.onCleanupFailure).toBe(f.reader.onPhotoCleanupFailure);
  expect(view.queryByText('Add to plan')).toBeNull();
  expect(view.queryByText('Ask about this recipe')).toBeNull();
  // Retired reading callbacks cannot navigate the replacement owner.
  act(() => mockView!.onBack());
  expect(mockBack).not.toHaveBeenCalled();
});

test('an exact historical reference uses only readExact through failure and explicit retry', async () => {
  const recipe = authored(),
    f = fixture(recipe);
  mockParams.contentRef = JSON.stringify(recipe.contentRef);
  mockParams.section = 'instructions';
  f.reader.readExact.mockRejectedValueOnce(new Error('Unavailable'));
  const view = mounted(f);
  await waitFor(() => expect(view.getByText('Saved recipe version unavailable')).toBeTruthy());
  fireEvent.press(view.getByText('Try again'));
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  expect(f.reader.readExact).toHaveBeenNthCalledWith(1, recipe.contentRef);
  expect(f.reader.readExact).toHaveBeenNthCalledWith(2, recipe.contentRef);
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
  expect(mockView?.lookup).toEqual({ kind: 'readable', state: 'historical', recipe });
  expect(mockView?.initialSection).toBe('instructions');
});

test.each([
  '{',
  'x'.repeat(1025),
  [],
  JSON.stringify({ recipeId: '90002', revisionId: 'ref', contentFingerprint: 'a'.repeat(64) }),
  JSON.stringify({ recipeId: '90001', revisionId: 'ref', contentFingerprint: 'invalid' }),
  JSON.stringify({
    recipeId: '90001',
    revisionId: 'ref',
    contentFingerprint: 'a'.repeat(64),
    extra: true,
  }),
])('invalid exact route %p performs no current or exact read', (contentRef) => {
  const f = fixture();
  mockParams.contentRef = contentRef;
  const view = mounted(f);
  expect(view.getByText('Saved recipe version unavailable')).toBeTruthy();
  expect(f.reader.readExact).not.toHaveBeenCalled();
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
});

test.each(['absent', 'bundled'] as const)(
  'an explicit exact route never falls back with %s adapter',
  (mode) => {
    const f = fixture();
    mockParams = {
      id: '52839',
      contentRef: JSON.stringify({ ...original.contentRef, recipeId: '52839' }),
    };
    const state = ready();
    if (state.kind !== 'ready') throw new Error('Fixture must be ready');
    f.set({ ...state, mode: 'bundled', photoMode: 'bundled' });
    const view = mode === 'absent' ? render(<RecipeDetailsScreen />) : mounted(f);
    expect(view.getByText('Saved recipe version unavailable')).toBeTruthy();
    expect(view.queryByText(getRecipe('52839')!.title)).toBeNull();
    expect(f.reader.readExact).not.toHaveBeenCalled();
  },
);

test.each<OrdinaryCatalogueState>([
  { kind: 'loading', scopeKey: 'opening' },
  { kind: 'failed', scopeKey: 'failed' },
  { kind: 'unavailable', reason: 'revoked', scopeKey: 'retired' },
  { kind: 'closed', scopeKey: 'closed' },
])('configured $kind source never reveals a packaged same-ID recipe', (state) => {
  const f = fixture();
  mockParams.id = '52839';
  f.set(state);
  const view = mounted(f);
  expect(view.queryByText(getRecipe('52839')!.title)).toBeNull();
  expect(view.queryByText('Add to plan')).toBeNull();
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
});

test('late target result is discarded after route changes within the same owner', async () => {
  const f = fixture(),
    old = deferred<ReadingLookup>(),
    next = authored('90002', 'New target recipe');
  f.reader.readCurrent
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ kind: 'readable', state: 'current', recipe: next });
  const view = mounted(f);
  await waitFor(() => expect(f.reader.readCurrent).toHaveBeenCalledWith('90001'));
  mockParams = { id: '90002' };
  view.rerender(
    <OrdinaryCatalogueProvider controller={f.reader}>
      <RecipeDetailsScreen />
    </OrdinaryCatalogueProvider>,
  );
  await waitFor(() => expect(view.getByText(next.title)).toBeTruthy());
  await act(async () => old.resolve({ kind: 'readable', state: 'current', recipe: authored() }));
  expect(view.queryByText(authored().title)).toBeNull();
});

test('revocation removes reading immediately; late owner results and retained actions cannot escape', async () => {
  const f = fixture(),
    recipe = authored(),
    view = mounted(f);
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  const previous = mockView!;
  f.set({ kind: 'unavailable', reason: 'revoked', scopeKey: 'owner1:revoked' });
  expect(view.queryByText(recipe.title)).toBeNull();
  act(() => previous.onBack());
  expect(mockBack).not.toHaveBeenCalled();
  await expect(previous.readPhoto(recipe.contentRef, 'fixture-photo')).rejects.toThrow(
    'workspace changed',
  );
  expect(f.reader.readPhoto).not.toHaveBeenCalled();
  const resource: ContentPhotoResource = { uri: 'fixture:cleanup-only', release: () => false };
  previous.onCleanupFailure(resource);
  expect(f.reader.onPhotoCleanupFailure).toHaveBeenCalledWith(resource);
  const late = deferred<ReadingLookup>();
  f.reader.readCurrent.mockReturnValueOnce(late.promise);
  f.set(ready(recipe, 'owner2:head1'));
  await waitFor(() => expect(f.reader.readCurrent).toHaveBeenCalledTimes(2));
  f.set({ kind: 'loading', scopeKey: 'owner2:head2' });
  await act(async () => late.resolve({ kind: 'readable', state: 'current', recipe }));
  expect(view.queryByText(recipe.title)).toBeNull();
  f.reader.readCurrent.mockResolvedValue({
    kind: 'readable',
    state: 'current',
    recipe: { ...recipe, title: 'Newly adopted title' },
  });
  f.set(ready(recipe, 'owner2:head2'));
  await waitFor(() => expect(view.getByText('Newly adopted title')).toBeTruthy());
});

test('a changed controller with the same scope cannot reuse the prior reading or photo callback', async () => {
  const old = fixture(),
    next = fixture(authored('90001', 'Other controller')),
    pending = deferred<ReadingLookup>();
  const view = mounted(old);
  await waitFor(() => expect(view.getByText(authored().title)).toBeTruthy());
  const previous = mockView!;
  next.reader.readCurrent.mockReturnValueOnce(pending.promise);
  view.rerender(
    <OrdinaryCatalogueProvider controller={next.reader}>
      <RecipeDetailsScreen />
    </OrdinaryCatalogueProvider>,
  );
  expect(view.queryByText(authored().title)).toBeNull();
  await expect(previous.readPhoto(authored().contentRef, 'fixture')).rejects.toThrow();
  expect(old.reader.readPhoto).not.toHaveBeenCalled();
  await act(async () =>
    pending.resolve({
      kind: 'readable',
      state: 'current',
      recipe: authored('90001', 'Other controller'),
    }),
  );
  await waitFor(() => expect(view.getByText('Other controller')).toBeTruthy());
});

test('retained adapter retry is inert after its screen unmounts', () => {
  const f = fixture();
  f.set({ kind: 'failed', scopeKey: 'owner1:failed' });
  const view = mounted(f);
  const retry = view
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Try again')!.props.onPress;
  view.unmount();
  act(() => retry());
  expect(f.reader.retry).not.toHaveBeenCalled();
});

test('the shared verified presentation opens the requested Source tab without activating video', () => {
  const { ContentRecipeReaderView } = jest.requireActual<
    typeof import('./ContentRecipeReaderView')
  >('./ContentRecipeReaderView');
  const recipe = authored();
  const view = render(
    <ContentRecipeReaderView
      lookup={{ kind: 'readable', state: 'current', recipe }}
      scopeKey="source-fixture"
      initialSection="source"
      readPhoto={async () => {
        throw new Error('Unused');
      }}
      onBack={jest.fn()}
      onCleanupFailure={jest.fn()}
    />,
  );
  expect(view.getByRole('tab', { name: 'Source' })).toBeSelected();
  expect(view.getByText('Authored by Fixture author')).toBeTruthy();
  expect(view.queryByText(recipe.ingredients[0]!.rawMeasure!)).toBeNull();
});
