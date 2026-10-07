import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { catalogue } from '@cookmate/catalogue';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
} from '@cookmate/catalogue/content';
import {
  createRecipeSearch,
  type Immutable,
  type PersonalChange,
  type PersonalReceipt,
  type RecipeNote,
  type RepositoryResult,
} from '@cookmate/domain';
import { ActionButton } from '../../components/Controls';
import type { ContentWorkspaceState } from '../content/contentWorkspaceHost';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import {
  ContentRecipeNote,
  parseRecipeNoteTarget,
  type ContentNoteHost,
} from './ContentRecipeNote';
import RecipePersonalScreen from './RecipePersonalScreen';
import { RecipePersonalEntry } from './RecipePersonalEntry';
import { usePersonalPorts } from './PersonalUI';

jest.mock('./RecipeCollectionMemberships', () => ({ ContentRecipeMemberships: () => null }));

const mockPush = jest.fn(),
  mockConfirm = jest.fn();
const mockStorage = new Map<string, string>();
let mockId = 0;
let mockWriteGate: Promise<void> | null = null;
let mockRuntime: { host: ContentNoteHost } | null = null;
let mockParams: { id: string; contentRef?: string } = { id: '53262' };
let mockCatalogue: { state: OrdinaryCatalogueState; reader: OrdinaryCatalogueController } | null =
  null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock('../../hooks/useUnsavedDraft', () => ({ useUnsavedDraft: jest.fn() }));
jest.mock('../../components/confirmAction', () => ({
  confirmAction: (value: unknown) => mockConfirm(value),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../content/ordinaryContentRuntimeContext', () => ({
  useOrdinaryContentRuntime: () => mockRuntime,
}));
jest.mock('../content/OrdinaryCatalogue', () => ({
  useOptionalOrdinaryCatalogue: () => mockCatalogue,
}));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    availability: { kind: 'ready', services: { personal: {} } },
    registerFocusFallback: () => () => undefined,
  }),
}));
jest.mock('../content/ContentRecipePhoto', () => ({
  ContentRecipePhoto: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Verified recipe photo</Text>;
  },
}));
jest.mock('./contentNoteReferenceStorage', () => {
  const { createPersonalReferenceStore } =
    jest.requireActual<typeof import('./personalReferences')>('./personalReferences');
  return {
    contentNoteReferenceStore: createPersonalReferenceStore({
      read: async (key) => mockStorage.get(`content-notes:${key}`) ?? null,
      write: async (key, value) => {
        if (mockWriteGate) await mockWriteGate;
        mockStorage.set(`content-notes:${key}`, value);
      },
    }),
  };
});
const installation = 'e0000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-01T08:00:00.000Z';
const recoveryKey = `content-notes:cookmate.personal-recovery.${installation}`;
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', revision: 4, value });
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.failure',
  retry: 'never' as const,
};
const port = <Fn extends (...args: never[]) => unknown>() =>
  jest.fn<ReturnType<Fn>, Parameters<Fn>>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
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
  mockStorage.clear();
  mockId = 0;
  mockWriteGate = null;
  mockRuntime = null;
  mockCatalogue = null;
});
afterEach(cleanup);
/** Controlled presentation ports; these tests make no SQL/signature/browser acceptance claim. */
function fixture(initialText: string | null = 'Original private note') {
  let note: Immutable<RecipeNote> | null =
    initialText === null
      ? null
      : {
          noteId: 'b0000000-0000-4000-8000-000000000001',
          recipeId: packaged.recipeId,
          text: initialText,
          deleted: false,
          revision: 4,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
  const recipe: Immutable<ReadingRecipe> = {
    ...packaged,
    title: 'Verified revised recipe',
    contentRef: { ...packaged.contentRef, revisionId: 'reviewed-revision' },
  };
  const search = createRecipeSearch({ identity: catalogue.identity, recipes: [recipe] });
  const catalogueState: OrdinaryCatalogueState = {
    kind: 'ready',
    mode: 'content',
    photoMode: 'verified',
    scopeKey: 'catalogue:1',
    identity: catalogue.identity,
    recipes: [recipe],
    facets: search.facets,
    search: search.search,
    current: (id) => (id === recipe.recipeId ? recipe : undefined),
  };
  const reader = {
    getSnapshot: () => catalogueState,
    subscribe: () => () => undefined,
    retry: jest.fn(),
    close: jest.fn(),
    readCurrent: jest.fn(
      async (): Promise<ReadingLookup> => ({ kind: 'readable', state: 'current', recipe }),
    ),
    readSavedIdentity: async () => ({ kind: 'missing' as const }),
    readExact: jest.fn(
      async (): Promise<ReadingLookup> => ({ kind: 'readable', state: 'historical', recipe }),
    ),
    readPhoto: jest.fn(async () => {
      throw new Error('No media in UI fixture');
    }),
    onPhotoCleanupFailure: jest.fn(),
  } satisfies OrdinaryCatalogueController;
  mockCatalogue = { state: catalogueState, reader };
  let state: ContentWorkspaceState = {
    status: 'ready',
    scopeKey: 'owner:1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>(),
    changes = new Set<(change: PersonalChange) => void>();
  const receipts = new Map<string, Immutable<PersonalReceipt>>();
  const notes = {
    readState: port<ContentNoteHost['notes']['readState']>(),
    readRecipeNote: port<ContentNoteHost['notes']['readRecipeNote']>(),
    execute: port<ContentNoteHost['notes']['execute']>(),
    readReceipt: port<ContentNoteHost['notes']['readReceipt']>(),
    resolveOperation: port<ContentNoteHost['notes']['resolveOperation']>(),
    subscribe: (listener: (change: PersonalChange) => void) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
  } satisfies ContentNoteHost['notes'];
  notes.readState.mockImplementation(async () => ready({ revision: 4, epoch: 1 }));
  notes.readRecipeNote.mockImplementation(async () => ready({ epoch: 1, note }));
  notes.readReceipt.mockImplementation(async (id) => ready(receipts.get(id) ?? null));
  notes.resolveOperation.mockImplementation(async (id) =>
    ready(
      receipts.get(id) ?? {
        operationId: id,
        commandKind: null,
        outcome: 'cancelled',
        entityId: null,
        revision: 4,
        epoch: 1,
        committedAt: timestamp,
        affectedMemberships: 0,
      },
    ),
  );
  const commit = (command: Parameters<ContentNoteHost['notes']['execute']>[0], notify = true) => {
    note =
      command.kind === 'saveNote'
        ? {
            noteId: command.noteId,
            recipeId: command.recipeId,
            text: command.text,
            deleted: false,
            revision: 5,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
        : null;
    const receipt: Immutable<PersonalReceipt> = {
      operationId: command.operationId,
      commandKind: command.kind,
      outcome: 'committed',
      entityId: command.noteId,
      revision: 5,
      epoch: 1,
      committedAt: timestamp,
      affectedMemberships: 0,
    };
    receipts.set(command.operationId, receipt);
    if (notify)
      for (const listener of changes)
        listener({ revision: 5, notes: true, collections: false, manualShopping: false });
    return ready(receipt);
  };
  notes.execute.mockImplementation(async (command) => commit(command));
  const host = {
    notes,
    readInstallationId: port<ContentNoteHost['readInstallationId']>(),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies ContentNoteHost;
  host.readInstallationId.mockResolvedValue({ kind: 'ready', revision: 4, value: installation });
  mockRuntime = { host };
  const target = { recipeId: recipe.recipeId, contentRef: recipe.contentRef };
  mockParams = { id: recipe.recipeId, contentRef: JSON.stringify(recipe.contentRef) };
  return {
    host,
    notes,
    reader,
    recipe,
    target,
    commit,
    receipts,
    render: () => render(<ContentRecipeNote host={host} target={target} />),
    retire: () => {
      state = { status: 'revoked', scopeKey: 'owner:2', pending: null, cleanupPending: 0 };
      listeners.forEach((listener) => listener());
    },
    resume: () => {
      state = { status: 'ready', scopeKey: 'owner:3', pending: null, cleanupPending: 0 };
      listeners.forEach((listener) => listener());
    },
  };
}
async function edit(text: string) {
  fireEvent.press(await screen.findByText('Edit private note'));
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), text);
  await waitFor(() => expect(screen.getByText('Save private note')).toBeTruthy());
}
function callback(label: string) {
  return screen.UNSAFE_getAllByType(ActionButton).find((node) => node.props.label === label)!.props
    .onPress as () => void;
}
function storedRefs() {
  return JSON.parse(mockStorage.get(recoveryKey) ?? '{"operations":[]}').operations as {
    operationId: string;
  }[];
}

test('shares raw note add/edit/delete flow, reopens saved state, and never activates collections', async () => {
  const f = fixture(null),
    view = f.render();
  await screen.findByText('Verified revised recipe');
  await waitFor(() => expect(screen.getByText('Add private note')).toBeEnabled());
  fireEvent.press(screen.getByText('Add private note'));
  const raw = '  Exact private words\nsecond line  ';
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), raw);
  fireEvent.press(screen.getByText('Save private note'));
  await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(1));
  await screen.findByText(raw);
  expect(f.notes.execute.mock.calls[0]![0]).toMatchObject({
    kind: 'saveNote',
    recipeId: f.recipe.recipeId,
    text: raw,
  });
  expect(screen.queryByText('Collections')).toBeNull();
  const ports = renderHook(() => usePersonalPorts());
  expect(ports.result.current).toBeNull();
  ports.unmount();
  view.unmount();
  f.render();
  await screen.findByText(raw);
  await edit('Edited private note');
  fireEvent.press(screen.getByText('Save private note'));
  await screen.findByText('Edited private note');
  fireEvent.press(screen.getByText('Delete private note'));
  fireEvent.press(screen.getByText('Confirm delete private note'));
  await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(3));
  await screen.findByText('Add private note');
  expect(storedRefs()).toHaveLength(0);
});

test('existing note stays editable when exact recipe is withdrawn; no current fallback', async () => {
  const f = fixture();
  f.reader.readExact.mockResolvedValue({
    kind: 'withdrawn',
    recipeId: f.recipe.recipeId,
    reason: 'Withdrawn in the controlled reader fixture',
  });
  f.render();
  await screen.findByText('Original private note');
  await edit('Still private');
  fireEvent.press(screen.getByText('Save private note'));
  await screen.findByText('Still private');
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
  expect(screen.queryByText('Verified revised recipe')).toBeNull();
});

test('unavailable source grants no new note and malformed exact routes never query notes', async () => {
  const f = fixture(null);
  f.reader.readExact.mockResolvedValue({ kind: 'missing' });
  const view = f.render();
  await waitFor(() => expect(screen.getByText('Add private note')).toBeDisabled());
  view.unmount();
  f.notes.readRecipeNote.mockClear();
  mockParams = { id: f.recipe.recipeId, contentRef: '{bad' };
  render(<RecipePersonalScreen />);
  expect(screen.getByText('Recipe reference unavailable')).toBeTruthy();
  expect(f.notes.readRecipeNote).not.toHaveBeenCalled();
  expect(
    parseRecipeNoteTarget(
      f.recipe.recipeId,
      JSON.stringify({ ...f.recipe.contentRef, recipeId: '999' }),
    ),
  ).toBeNull();
});

test('scope retirement before reference write finishes retains opaque metadata and never dispatches', async () => {
  const f = fixture();
  f.render();
  await edit('Never dispatch this text');
  const save = callback('Save private note');
  const gate = deferred<void>();
  mockWriteGate = gate.promise;
  act(() => save());
  await act(async () => {
    f.retire();
    gate.resolve();
    await gate.promise;
  });
  await waitFor(() => expect(storedRefs()).toHaveLength(1));
  expect(f.notes.execute).not.toHaveBeenCalled();
  expect(screen.queryByText('Original private note')).toBeNull();
  await act(async () => save());
  expect(f.notes.execute).not.toHaveBeenCalled();
  expect(mockStorage.get(recoveryKey)).not.toContain('Never dispatch');
});

test('scope retirement after dispatch hides private draft and preserves unconfirmed operation without false outcome', async () => {
  const f = fixture(),
    gate = deferred<Awaited<ReturnType<ContentNoteHost['notes']['execute']>>>();
  f.notes.execute.mockImplementation(async () => gate.promise);
  f.render();
  await edit('Pending private draft');
  fireEvent.press(screen.getByText('Save private note'));
  await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(1));
  const command = f.notes.execute.mock.calls[0]![0];
  await act(async () => {
    f.retire();
    gate.resolve(f.commit(command));
    await gate.promise;
  });
  expect(storedRefs()).toHaveLength(1);
  expect(screen.queryByText('Local change saved')).toBeNull();
  expect(screen.queryByDisplayValue('Pending private draft')).toBeNull();
  expect(screen.queryByText(/has not been saved|has not been cleared/)).toBeNull();
});

test('lost acknowledgement remount checks original receipt without replay; other personal references are isolated', async () => {
  const f = fixture();
  const foreign = 'f0000000-0000-4000-8000-000000000001';
  mockStorage.set(
    `cookmate.personal-recovery.${installation}`,
    JSON.stringify({
      schemaVersion: 1,
      installationId: installation,
      operations: [{ operationId: foreign, createdAt: timestamp }],
    }),
  );
  f.notes.execute.mockImplementationOnce(async (command) => {
    f.commit(command);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  const view = f.render();
  await edit('Lost receipt note');
  fireEvent.press(screen.getByText('Save private note'));
  await screen.findByText('Unconfirmed personal change');
  await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(1));
  const op = f.notes.execute.mock.calls[0]![0].operationId;
  view.unmount();
  f.render();
  await screen.findByText('Unconfirmed personal change');
  fireEvent.press(screen.getByText('Check personal change receipt'));
  await screen.findByText('Local change saved');
  expect(f.notes.readReceipt).toHaveBeenCalledWith(op);
  expect(f.notes.execute).toHaveBeenCalledTimes(1);
  expect(storedRefs()).toHaveLength(0);
  expect(mockStorage.get(`cookmate.personal-recovery.${installation}`)).toContain(foreign);
});

test('unrelated terminal receipt cannot release note reference or announce success', async () => {
  const f = fixture();
  const op = 'f0000000-0000-4000-8000-000000000002';
  mockStorage.set(
    recoveryKey,
    JSON.stringify({
      schemaVersion: 1,
      installationId: installation,
      operations: [{ operationId: op, createdAt: timestamp }],
    }),
  );
  f.notes.readReceipt.mockResolvedValue(
    ready({
      operationId: op,
      commandKind: 'addManualItem',
      outcome: 'committed',
      entityId: null,
      revision: 4,
      epoch: 1,
      committedAt: timestamp,
      affectedMemberships: 0,
    }),
  );
  f.render();
  await screen.findByText('Unconfirmed personal change');
  fireEvent.press(screen.getByText('Check personal change receipt'));
  await screen.findByText('The receipt does not match this operation. No success is claimed.');
  expect(storedRefs()).toHaveLength(1);
  expect(screen.queryByText('Local change saved')).toBeNull();
});

test('discarded form callback cannot submit and reopening starts from saved note', async () => {
  const f = fixture();
  f.render();
  await edit('Discard me');
  const retained = callback('Save private note');
  fireEvent.press(screen.getByText('Cancel note changes'));
  act(() => mockConfirm.mock.calls[0]![0].onConfirm());
  await act(async () => retained());
  expect(f.notes.execute).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Edit private note'));
  expect(screen.getByLabelText('Private recipe note').props.value).toBe('Original private note');
});

test('entry navigation keeps the exact ref and retained callback retires with scope', async () => {
  const f = fixture();
  render(<RecipePersonalEntry recipeId={f.recipe.recipeId} contentRef={f.recipe.contentRef} />);
  const press = callback('Private note & collections');
  act(() => press());
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe-personal/[id]',
    params: { id: f.recipe.recipeId, contentRef: expect.any(String) },
  });
  const pushed = mockPush.mock.calls[0]![0];
  expect(JSON.parse(pushed.params.contentRef)).toEqual(f.recipe.contentRef);
  act(() => f.retire());
  act(() => press());
  expect(mockPush).toHaveBeenCalledTimes(1);
});

test('new ready scope remounts from saved data and late read cannot restore retired private text', async () => {
  const f = fixture(),
    gate = deferred<Awaited<ReturnType<ContentNoteHost['notes']['readRecipeNote']>>>();
  f.notes.readRecipeNote.mockImplementationOnce(async () => gate.promise);
  f.render();
  await waitFor(() => expect(f.notes.readRecipeNote).toHaveBeenCalledTimes(1));
  await act(async () => {
    f.retire();
    gate.resolve(
      ready({
        epoch: 1,
        note: {
          noteId: 'b0000000-0000-4000-8000-000000000001',
          recipeId: f.recipe.recipeId,
          text: 'Retired secret',
          deleted: false,
          revision: 4,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }),
    );
    await gate.promise;
  });
  expect(screen.queryByText('Retired secret')).toBeNull();
  act(() => f.resume());
  await screen.findByText('Original private note');
  expect(screen.queryByText('Retired secret')).toBeNull();
});

test('unchanged route rerender keeps an in-flight save and returns to editable saved state', async () => {
  const f = fixture(),
    gate = deferred<Awaited<ReturnType<ContentNoteHost['notes']['execute']>>>();
  f.notes.execute.mockImplementation(async () => gate.promise);
  const view = render(<RecipePersonalScreen />);
  await edit('Same route pending note');
  fireEvent.press(screen.getByText('Save private note'));
  await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(1));
  view.rerender(<RecipePersonalScreen />);
  await act(async () => {
    gate.resolve(f.commit(f.notes.execute.mock.calls[0]![0]));
    await gate.promise;
  });
  await screen.findByText('Same route pending note');
  await waitFor(() => expect(screen.getByText('Edit private note')).toBeEnabled());
  expect(storedRefs()).toHaveLength(0);
});

test.each([false, true])(
  'same-mounted recovered save refreshes its baseline and preserves newer draft=%s',
  async (newer) => {
    const f = fixture(null);
    f.notes.execute.mockImplementationOnce(async (command) => {
      f.commit(command, false);
      return { kind: 'uncertain', operationId: command.operationId, error: failure };
    });
    f.render();
    await screen.findByText('Verified revised recipe');
    await waitFor(() => expect(screen.getByText('Add private note')).toBeEnabled());
    fireEvent.press(screen.getByText('Add private note'));
    fireEvent.changeText(screen.getByLabelText('Private recipe note'), 'Submitted raw note');
    fireEvent.press(screen.getByText('Save private note'));
    await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Check personal change receipt')).toBeEnabled());
    if (newer)
      fireEvent.changeText(screen.getByLabelText('Private recipe note'), 'Newer unsaved draft');
    fireEvent.press(screen.getByText('Check personal change receipt'));
    await screen.findByText('Local change saved');
    if (newer) {
      await waitFor(() => expect(screen.getByText('Save private note')).toBeEnabled());
      expect(screen.getByLabelText('Private recipe note').props.value).toBe('Newer unsaved draft');
    } else {
      await screen.findByText('Edit private note');
      await edit('Next deliberate edit');
    }
    fireEvent.press(screen.getByText('Save private note'));
    await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(2));
    expect(f.notes.execute.mock.calls[1]![0]).toMatchObject({
      kind: 'saveNote',
      noteId: f.notes.execute.mock.calls[0]![0].noteId,
      expectedRevision: 5,
      text: newer ? 'Newer unsaved draft' : 'Next deliberate edit',
    });
  },
);

test('same-mounted recovery retains newer draft but does not approve a different current saved revision', async () => {
  const f = fixture();
  f.notes.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  f.render();
  await edit('Submitted note');
  fireEvent.press(screen.getByText('Save private note'));
  await waitFor(() => expect(f.notes.execute).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByText('Check personal change receipt')).toBeEnabled());
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), 'Newer draft kept');
  const first = f.notes.execute.mock.calls[0]![0];
  f.notes.readRecipeNote.mockResolvedValue(
    ready({
      epoch: 1,
      note: {
        noteId: first.noteId,
        recipeId: f.recipe.recipeId,
        text: 'Different current note',
        deleted: false,
        revision: 6,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
  );
  fireEvent.press(screen.getByText('Check personal change receipt'));
  await screen.findByText('Saved note changed');
  expect(screen.getByLabelText('Private recipe note').props.value).toBe('Newer draft kept');
  expect(screen.getByText('Save private note')).toBeDisabled();
  await act(async () => callback('Save private note')());
  expect(f.notes.execute).toHaveBeenCalledTimes(1);
});
