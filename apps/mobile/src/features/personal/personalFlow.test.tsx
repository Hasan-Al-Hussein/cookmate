import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { isValidElement } from 'react';
import { Modal } from 'react-native';
import type {
  Immutable,
  PersonalService,
  PersonalReceipt,
  PersonalChange,
  PersonalCommand,
  ManualShoppingItem,
  RepositoryResult,
} from '@cookmate/domain';
import { getRecipe } from '@cookmate/catalogue';
import { RecipePersonalEditor } from './RecipePersonalScreen';
import { CollectionDetails } from './CollectionScreen';
import { CollectionsList } from './CollectionsScreen';
import { ManualShoppingList } from './ManualShoppingScreen';
import { usePersonalOperations } from './usePersonalOperations';
import { sortSavedRecipes } from './sortSavedRecipes';

let mockId = 0;
const mockStorage = new Map<string, string>();
const mockNavigate = jest.fn();
const mockUnsaved = jest.fn();
const mockConfirm = jest.fn();
const mockFocusTarget = jest.fn((_target: unknown) => true);
jest.mock('../../components/focusTarget', () => ({
  focusTarget: (target: unknown) => mockFocusTarget(target),
}));
jest.mock('../../components/confirmAction', () => ({
  confirmAction: (...args: unknown[]) => mockConfirm(...args),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `d0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockNavigate, navigate: mockNavigate }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../../hooks/useUnsavedDraft', () => ({
  useUnsavedDraft: (...args: unknown[]) => mockUnsaved(...args),
}));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '53262': 1 } }));
jest.mock('./personalReferenceStorage', () => {
  const { createPersonalReferenceStore } =
    jest.requireActual<typeof import('./personalReferences')>('./personalReferences');
  return {
    personalReferenceStore: createPersonalReferenceStore({
      read: async (key) => mockStorage.get(key) ?? null,
      write: async (key, value) => {
        mockStorage.set(key, value);
      },
    }),
  };
});
const recipe = getRecipe('53262')!;
const installation = 'a0000000-0000-4000-8000-000000000001';
const collectionId = 'b0000000-0000-4000-8000-000000000001';
const timestamp = '2026-09-30T10:00:00.000Z';
const collection = {
  collectionId,
  name: 'Weeknight ideas',
  deleted: false,
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  memberCount: 1,
};
const member = {
  collectionId,
  recipeId: recipe.recipeId,
  present: true,
  revision: 3,
  updatedAt: timestamp,
};
const note = {
  noteId: 'c0000000-0000-4000-8000-000000000001',
  recipeId: recipe.recipeId,
  text: 'My private note',
  deleted: false,
  revision: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const manual: Immutable<ManualShoppingItem> = {
  kind: 'manual',
  itemId: 'e0000000-0000-4000-8000-000000000001',
  name: 'Bread',
  amountText: null,
  unitText: null,
  category: 'pantry',
  purchased: true,
  deleted: false,
  revision: 5,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.failed',
  retry: 'never' as const,
};
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 6 });
const identity = async () => ready(installation);
function port<T extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<T>, Parameters<T>>();
}
let service: jest.Mocked<PersonalService>;
const receipts = new Map<string, Immutable<PersonalReceipt>>();
const listeners = new Set<(change: PersonalChange) => void>();
function receipt(
  operationId: string,
  commandKind: PersonalCommand['kind'] | 'deleteCollection' | null,
  outcome: PersonalReceipt['outcome'] = 'committed',
  entityId: string | null = null,
): Immutable<PersonalReceipt> {
  return {
    operationId,
    commandKind,
    outcome,
    entityId,
    revision: 6,
    epoch: 1,
    committedAt: timestamp,
    affectedMemberships: 0,
  };
}
function commandReceipt(command: PersonalCommand): Immutable<PersonalReceipt> {
  const entityId =
    'noteId' in command
      ? command.noteId
      : 'collectionId' in command
        ? command.collectionId
        : command.itemId;
  return receipt(command.operationId, command.kind, 'committed', entityId);
}
function loseAcknowledgementOnce() {
  service.execute.mockImplementationOnce(async (command) => {
    receipts.set(command.operationId, commandReceipt(command));
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
}
async function checkReceipt() {
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Check personal change receipt' }));
  await screen.findByText('Local change saved');
}
beforeEach(() => {
  mockId = 0;
  mockStorage.clear();
  mockNavigate.mockClear();
  mockUnsaved.mockClear();
  mockConfirm.mockClear();
  mockFocusTarget.mockClear();
  receipts.clear();
  listeners.clear();
  service = {
    readRecipePersonal: port<PersonalService['readRecipePersonal']>().mockResolvedValue(
      ready({ epoch: 1, note, memberships: [member] }),
    ),
    readCollections: port<PersonalService['readCollections']>().mockResolvedValue(
      ready({ epoch: 1, items: [collection] }),
    ),
    readCollection: port<PersonalService['readCollection']>().mockResolvedValue(
      ready({ epoch: 1, collection, items: [member], nextCursor: null }),
    ),
    readManualShopping: port<PersonalService['readManualShopping']>().mockResolvedValue(
      ready({ epoch: 1, items: [manual], nextCursor: null, total: 1 }),
    ),
    execute: port<PersonalService['execute']>().mockImplementation(async (command) => {
      const result = commandReceipt(command);
      receipts.set(command.operationId, result);
      return ready(result);
    }),
    reviewDeleteCollection: port<PersonalService['reviewDeleteCollection']>().mockResolvedValue(
      ready({
        reviewId: 'review',
        collectionId,
        name: collection.name,
        expectedRevision: collection.revision,
        epoch: 1,
        affectedRecipeIds: [recipe.recipeId],
      }),
    ),
    deleteCollection: port<PersonalService['deleteCollection']>().mockImplementation(
      async (review, operationId) =>
        ready(receipt(operationId, 'deleteCollection', 'committed', review.collectionId)),
    ),
    readReceipt: port<PersonalService['readReceipt']>().mockImplementation(async (id) =>
      ready(receipts.get(id) ?? null),
    ),
    resolveOperation: port<PersonalService['resolveOperation']>().mockImplementation(async (id) =>
      ready(receipts.get(id) ?? receipt(id, null, 'cancelled')),
    ),
    subscribe: port<PersonalService['subscribe']>().mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
});
afterEach(cleanup);
test('private note preserves exact text and enforces Unicode length before explicit save', async () => {
  render(
    <RecipePersonalEditor
      service={service}
      readInstallationId={identity}
      recipeId={recipe.recipeId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit private note' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit private note' }));
  expect(screen.queryByText(/\/4000 characters/)).toBeNull();
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), '🍲'.repeat(4000));
  expect(screen.getByText('4000/4000 characters')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save private note' })).not.toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), `${'🍲'.repeat(4000)}x`);
  expect(screen.getByRole('button', { name: 'Save private note' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), '  أقل ملح — private  ');
  expect(mockUnsaved).toHaveBeenLastCalledWith(true, 'Discard private note changes?');
  expect(service.execute).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save private note' }));
  await screen.findByText('Local change saved');
  expect(service.execute.mock.calls[0]?.[0]).toMatchObject({
    kind: 'saveNote',
    noteId: note.noteId,
    expectedRevision: 4,
    expectedEpoch: 1,
    recipeId: recipe.recipeId,
    text: '  أقل ملح — private  ',
  });
});

test('cancelling a changed private note asks before discarding and leaves saved text untouched', async () => {
  render(
    <RecipePersonalEditor
      service={service}
      readInstallationId={identity}
      recipeId={recipe.recipeId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit private note' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit private note' }));
  fireEvent.changeText(screen.getByLabelText('Private recipe note'), 'Keep this unfinished idea');
  fireEvent.press(screen.getByRole('button', { name: 'Cancel note changes' }));
  expect(mockConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Discard private note changes?',
      cancelLabel: 'Keep editing',
    }),
  );
  expect(screen.getByDisplayValue('Keep this unfinished idea')).toBeTruthy();
  expect(service.execute).not.toHaveBeenCalled();
  act(() => mockConfirm.mock.calls[0]![0].onConfirm());
  expect(screen.queryByLabelText('Private recipe note')).toBeNull();
  expect(screen.getByText(note.text)).toBeTruthy();
  expect(service.execute).not.toHaveBeenCalled();
});

test('saved personal content updates from service notifications without routine refresh controls', async () => {
  render(
    <RecipePersonalEditor
      service={service}
      readInstallationId={identity}
      recipeId={recipe.recipeId}
    />,
  );
  await screen.findByText(note.text);
  expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
  service.readRecipePersonal.mockResolvedValue(
    ready({
      epoch: 1,
      note: { ...note, revision: 5, text: 'Confirmed newer note' },
      memberships: [],
    }),
  );
  act(() => {
    for (const listener of listeners)
      listener({ revision: 7, notes: true, collections: true, manualShopping: false });
  });
  await screen.findByText('Confirmed newer note');
  expect(screen.queryByText(note.text)).toBeNull();
  expect(screen.getByRole('button', { name: 'Add to Weeknight ideas' })).not.toBeSelected();
  expect(service.execute).not.toHaveBeenCalled();
});

test('collections offer retry only after a failed read and show the empty creation task after recovery', async () => {
  service.readCollections.mockResolvedValue({ kind: 'failed', error: failure });
  render(<CollectionsList service={service} readInstallationId={identity} />);
  await screen.findByText('Collections need attention');
  expect(screen.getByRole('button', { name: 'Retry collections' })).toBeEnabled();
  service.readCollections.mockResolvedValue(ready({ epoch: 1, items: [] }));
  fireEvent.press(screen.getByRole('button', { name: 'Retry collections' }));
  await screen.findByText('Make room for your favourites.');
  expect(screen.queryByRole('button', { name: /Refresh|Retry collections/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled();
  expect(service.execute).not.toHaveBeenCalled();
});

test('a failed private-note save retains the exact draft and its navigation guard', async () => {
  service.execute.mockResolvedValueOnce({ kind: 'failed', error: failure });
  render(
    <RecipePersonalEditor
      service={service}
      readInstallationId={identity}
      recipeId={recipe.recipeId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit private note' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit private note' }));
  fireEvent.changeText(
    screen.getByLabelText('Private recipe note'),
    '  My unsaved note\nSecond line  ',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Save private note' }));
  await screen.findByText('Change needs attention');
  expect(screen.getByDisplayValue('  My unsaved note\nSecond line  ')).toBeTruthy();
  expect(mockUnsaved).toHaveBeenLastCalledWith(true, 'Discard private note changes?');
  expect(service.execute).toHaveBeenCalledTimes(1);
});

test('direct manual create opens the item task and cancellation preserves its draft until confirmed', async () => {
  render(<ManualShoppingList service={service} readInstallationId={identity} initialCreate />);
  await screen.findByLabelText('Item name');
  expect(screen.getByRole('button', { name: 'Add manual item' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Extra lemons');
  fireEvent.press(screen.getByRole('button', { name: 'Cancel manual item changes' }));
  expect(mockConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Discard manual shopping changes?',
      cancelLabel: 'Keep editing',
    }),
  );
  expect(screen.getByDisplayValue('Extra lemons')).toBeTruthy();
  expect(service.execute).not.toHaveBeenCalled();
  act(() => mockConfirm.mock.calls[0]![0].onConfirm());
  expect(screen.queryByLabelText('Item name')).toBeNull();
  expect(screen.getByRole('button', { name: 'Add manual item' })).toBeTruthy();
  expect(service.execute).not.toHaveBeenCalled();
});

test.each(['Add manual item', 'Edit Bread'])(
  'manual editor restores %s focus only after the modal dismisses',
  async (label) => {
    function textOf(node: unknown): string {
      if (typeof node === 'string') return node;
      if (Array.isArray(node)) return node.map(textOf).join('');
      return isValidElement<{ children?: unknown }>(node) ? textOf(node.props.children) : '';
    }
    render(<ManualShoppingList service={service} readInstallationId={identity} />);
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
    fireEvent.press(screen.getByRole('button', { name: label }));
    await screen.findByLabelText('Item name');
    const modal = screen.UNSAFE_getByType(Modal);
    mockFocusTarget.mockClear();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel manual item changes' }));
    expect(modal.props.visible).toBe(false);
    expect(mockFocusTarget).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: label })).toBeDisabled();
    fireEvent(modal, 'dismiss');
    await waitFor(() => expect(mockFocusTarget).toHaveBeenCalledTimes(1));
    const target = mockFocusTarget.mock.calls[0]![0] as { props?: { children?: unknown } } | null;
    expect(textOf(target?.props?.children)).toBe(label);
    expect(screen.getByRole('button', { name: label })).toBeEnabled();
    expect(service.execute).not.toHaveBeenCalled();
  },
);

test('direct manual editing finds an item beyond the displayed twenty and saves its exact identity', async () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    ...manual,
    itemId: `e0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `Extra item ${index + 1}`,
    revision: index + 5,
  }));
  const target = items[24]!;
  service.readManualShopping.mockResolvedValue(
    ready({ epoch: 7, items, nextCursor: null, total: items.length }),
  );
  render(
    <ManualShoppingList
      service={service}
      readInstallationId={identity}
      initialItem={target.itemId}
    />,
  );
  await screen.findByDisplayValue(target.name);
  fireEvent.changeText(screen.getByLabelText('Amount · optional'), '2');
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await screen.findByText('Local change saved');
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(service.execute.mock.calls[0]![0]).toMatchObject({
    kind: 'editManualItem',
    itemId: target.itemId,
    expectedRevision: target.revision,
    expectedEpoch: 7,
    fields: { name: target.name, amountText: '2' },
  });
});
test('membership removal uses its own revisions and never unsaves a favourite', async () => {
  render(
    <RecipePersonalEditor
      service={service}
      readInstallationId={identity}
      recipeId={recipe.recipeId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Remove from Weeknight ideas' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Remove from Weeknight ideas' }));
  await screen.findByText('Local change saved');
  expect(service.execute.mock.calls[0]?.[0]).toMatchObject({
    kind: 'setCollectionMembership',
    expectedCollectionRevision: 2,
    expectedRevision: 3,
    present: false,
  });
  expect(service.execute).toHaveBeenCalledTimes(1);
});
test('delete collection reviews exact affected members and cancellation does not write', async () => {
  render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Review deleting collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review deleting collection' }));
  await screen.findByText('Delete “Weeknight ideas”?');
  expect(screen.getByText(/exactly 1 memberships/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Keep collection' }));
  expect(service.deleteCollection).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Review deleting collection' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Confirm delete collection' }));
  await screen.findByText('Local change saved');
  const reviewed = await service.reviewDeleteCollection.mock.results[1]!.value;
  if (reviewed.kind !== 'ready') throw new Error('Expected review');
  expect(service.deleteCollection.mock.calls[0]?.[0]).toBe(reviewed.value);
});
test('new collection name is bounded and creates only on Save', async () => {
  render(<CollectionsList service={service} readInstallationId={identity} />);
  await screen.findByText('Weeknight ideas');
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'x'.repeat(81));
  expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Weekend cooking');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create collection' })).not.toBeDisabled(),
  );
  expect(service.execute).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Create collection' }));
  await screen.findByText('Local change saved');
  expect(service.execute.mock.calls[0]?.[0]).toMatchObject({
    kind: 'createCollection',
    name: 'Weekend cooking',
    expectedEpoch: 1,
  });
});
test('manual category change preserves purchase explanation and keeps unknown quantities null', async () => {
  render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit Bread' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit Bread' }));
  fireEvent.press(screen.getByRole('radio', { name: 'Other' }));
  expect(screen.getByText('Purchase mark stays checked')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await screen.findByText('Local change saved');
  expect(service.execute.mock.calls[0]?.[0]).toMatchObject({
    kind: 'editManualItem',
    expectedRevision: 5,
    fields: { name: 'Bread', amountText: null, unitText: null, category: 'other' },
  });
});
test('changing a manual amount explains its isolated purchased reset before saving', async () => {
  render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit Bread' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit Bread' }));
  fireEvent.changeText(screen.getByLabelText('Amount · optional'), 'two large');
  expect(screen.getByText('This item will return to To buy')).toBeTruthy();
  expect(service.execute).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel manual item changes' }));
  expect(service.execute).not.toHaveBeenCalled();
});
test('an uncertain personal operation survives remount and resolves without replaying private input', async () => {
  service.execute.mockImplementationOnce(async (command) => ({
    kind: 'uncertain',
    operationId: command.operationId,
    error: failure,
  }));
  const first = renderHook(() => usePersonalOperations(service, identity));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  await act(async () => {
    await first.result.current.perform((operationId) =>
      service.execute({
        kind: 'saveNote',
        operationId,
        expectedEpoch: 1,
        noteId: note.noteId,
        recipeId: recipe.recipeId,
        expectedRevision: 4,
        text: 'Never persist my private draft',
      }),
    );
  });
  const id = service.execute.mock.calls[0]?.[0].operationId;
  if (!id) throw new Error('Expected dispatched operation');
  expect([...mockStorage.values()].join('')).toContain(id);
  expect([...mockStorage.values()].join('')).not.toContain('Never persist my private draft');
  first.unmount();
  const next = renderHook(() => usePersonalOperations(service, identity));
  await waitFor(() => expect(next.result.current.references).toHaveLength(1));
  expect(next.result.current.ready).toBe(false);
  await act(async () => next.result.current.recover(id, false));
  expect(next.result.current.references).toHaveLength(1);
  await act(async () => next.result.current.recover(id, true));
  await waitFor(() => expect(next.result.current.ready).toBe(true));
  expect(next.result.current.receipt?.outcome).toBe('cancelled');
  expect(service.execute).toHaveBeenCalledTimes(1);
});
test('an unsupported recovery version blocks mutation without overwriting existing metadata', async () => {
  const text = JSON.stringify({ schemaVersion: 9, installationId: installation, operations: [] });
  mockStorage.set(`cookmate.personal-recovery.${installation}`, text);
  const hook = renderHook(() => usePersonalOperations(service, identity));
  await waitFor(() => expect(hook.result.current.storageError).not.toBeNull());
  const dispatch = jest.fn();
  await act(async () => {
    await hook.result.current.perform(dispatch);
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(mockStorage.get(`cookmate.personal-recovery.${installation}`)).toBe(text);
});
test('saved sorting uses persisted dates and exact catalogue titles without changing records', () => {
  const entries = [
    { recipeId: '53262', savedAt: '2026-09-29T08:00:00.000Z', revision: 1 },
    { recipeId: '52928', savedAt: '2026-09-30T08:00:00.000Z', revision: 2 },
  ];
  expect(sortSavedRecipes(entries, 'recent').map((row) => row.recipeId)).toEqual([
    '52928',
    '53262',
  ]);
  const expected = [...entries].sort((a, b) =>
    (getRecipe(a.recipeId)?.title ?? a.recipeId).localeCompare(
      getRecipe(b.recipeId)?.title ?? b.recipeId,
    ),
  );
  expect(sortSavedRecipes(entries, 'alphabetical')).toEqual(expected);
  expect(entries[0]?.recipeId).toBe('53262');
});

test('a recovered collection creation finishes its matching draft without another creation', async () => {
  loseAcknowledgementOnce();
  render(<CollectionsList service={service} readInstallationId={identity} />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Weekend cooking');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Create collection' }));
  await checkReceipt();
  await waitFor(() => expect(screen.getByLabelText('Collection name')).toHaveProp('value', ''));
  expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Create collection' }));
  expect(service.execute).toHaveBeenCalledTimes(1);
});

test('matching collection recovery preserves a newer draft and rotates its entity identity', async () => {
  loseAcknowledgementOnce();
  render(<CollectionsList service={service} readInstallationId={identity} />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'First collection');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Create collection' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'A different draft');
  await checkReceipt();
  expect(screen.getByLabelText('Collection name')).toHaveProp('value', 'A different draft');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Create collection' }));
  await waitFor(() => expect(service.execute).toHaveBeenCalledTimes(2));
  const first = service.execute.mock.calls[0]![0];
  const second = service.execute.mock.calls[1]![0];
  if (first.kind !== 'createCollection' || second.kind !== 'createCollection')
    throw new Error('Expected create commands');
  expect(second.collectionId).not.toBe(first.collectionId);
  expect(second.name).toBe('A different draft');
});

test('a receipt recovered after remount cannot clear an unrelated collection draft', async () => {
  loseAcknowledgementOnce();
  const first = render(<CollectionsList service={service} readInstallationId={identity} />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Submitted before closing');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Create collection' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  first.unmount();
  render(<CollectionsList service={service} readInstallationId={identity} />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'New private draft');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled();
  await checkReceipt();
  expect(screen.getByLabelText('Collection name')).toHaveProp('value', 'New private draft');
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect([...mockStorage.values()].join('')).not.toContain('New private draft');
});

test('a recovered manual creation closes only the submitted form and cannot duplicate its item', async () => {
  loseAcknowledgementOnce();
  render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Apples');
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await checkReceipt();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save manual item' })).toBeNull(),
  );
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(service.execute.mock.calls[0]?.[0]).toMatchObject({
    kind: 'addManualItem',
    fields: { name: 'Apples' },
  });
});

test('recovered manual creation preserves newer content as a separate deliberate draft', async () => {
  loseAcknowledgementOnce();
  render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Apples');
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Pears');
  await checkReceipt();
  expect(screen.getByLabelText('Item name')).toHaveProp('value', 'Pears');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save manual item' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await waitFor(() => expect(service.execute).toHaveBeenCalledTimes(2));
  const first = service.execute.mock.calls[0]![0];
  const second = service.execute.mock.calls[1]![0];
  if (first.kind !== 'addManualItem' || second.kind !== 'addManualItem')
    throw new Error('Expected manual additions');
  expect(second.itemId).not.toBe(first.itemId);
  expect(second.fields.name).toBe('Pears');
});

test('manual recovery after remount blocks new additions and never replays an old draft', async () => {
  loseAcknowledgementOnce();
  const first = render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Apples');
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  first.unmount();
  render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  expect(screen.getByRole('button', { name: 'Add manual item' })).toBeDisabled();
  expect(screen.queryByLabelText('Item name')).toBeNull();
  await checkReceipt();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).not.toBeDisabled(),
  );
  expect(service.execute).toHaveBeenCalledTimes(1);
});

test('cancelled manual request retains its entity draft and requires a fresh explicit review', async () => {
  service.execute.mockImplementationOnce(async (command) => ({
    kind: 'uncertain',
    operationId: command.operationId,
    error: failure,
  }));
  render(<ManualShoppingList service={service} readInstallationId={identity} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Apples');
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Resolve unconfirmed personal change' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Resolve unconfirmed personal change' }));
  await screen.findByText('Earlier request cancelled');
  expect(screen.getByLabelText('Item name')).toHaveProp('value', 'Apples');
  expect(screen.getByRole('button', { name: 'Save manual item' })).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Use current list for this draft' }),
    ).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Use current list for this draft' }));
  fireEvent.press(screen.getByRole('button', { name: 'Save manual item' }));
  await waitFor(() => expect(service.execute).toHaveBeenCalledTimes(2));
  const first = service.execute.mock.calls[0]![0];
  const second = service.execute.mock.calls[1]![0];
  if (first.kind !== 'addManualItem' || second.kind !== 'addManualItem')
    throw new Error('Expected manual additions');
  expect(first.itemId).toBe(second.itemId);
  expect(first.operationId).not.toBe(second.operationId);
});

test('confirmed collection deletion replaces stale content after fresh list absence despite failed detail read', async () => {
  service.deleteCollection.mockImplementationOnce(async (review, operationId) => {
    service.readCollection.mockResolvedValue({ kind: 'failed', error: failure });
    service.readCollections.mockResolvedValue(ready({ epoch: 1, items: [] }));
    return ready(receipt(operationId, 'deleteCollection', 'committed', review.collectionId));
  });
  render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Review deleting collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review deleting collection' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Confirm delete collection' }));
  await screen.findByText('Collection deleted');
  expect(screen.queryByText('Weeknight ideas')).toBeNull();
  expect(screen.queryByText(recipe.title)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rename collection' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review deleting collection' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Return to collections' }));
  expect(mockNavigate).toHaveBeenCalledWith('/collections');
});

test('recovering a deletion receipt does not treat an unreadable current route as proof of absence', async () => {
  service.deleteCollection.mockImplementationOnce(async (review, operationId) => {
    receipts.set(
      operationId,
      receipt(operationId, 'deleteCollection', 'committed', review.collectionId),
    );
    return { kind: 'uncertain', operationId, error: failure };
  });
  const first = render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Review deleting collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review deleting collection' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Confirm delete collection' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  first.unmount();
  service.readCollection.mockResolvedValue({ kind: 'failed', error: failure });
  render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await checkReceipt();
  await screen.findByText('Collection unavailable');
  expect(screen.queryByText('Collection deleted')).toBeNull();
  expect(screen.getByText(/The receipt confirms an earlier deletion only/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Rename collection' })).toBeNull();
  service.readCollection.mockResolvedValue(
    ready({
      epoch: 2,
      collection: { ...collection, revision: 10 },
      items: [member],
      nextCursor: null,
    }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Retry collection' }));
  await screen.findByText('Weeknight ideas');
  expect(screen.queryByText('Collection deleted')).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Rename collection' })).not.toBeDisabled(),
  );
  expect(service.deleteCollection).toHaveBeenCalledTimes(1);
});

test('failed collection refresh disables stale mutations but preserves a rename draft', async () => {
  render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Rename collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Rename collection' }));
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'My retained rename');
  service.readCollection.mockResolvedValue({ kind: 'failed', error: failure });
  act(() => {
    for (const listener of listeners)
      listener({ revision: 7, collections: true, notes: false, manualShopping: false });
  });
  await screen.findByText('Collection unavailable');
  expect(screen.getByLabelText('Collection name')).toHaveProp('value', 'My retained rename');
  expect(screen.getByRole('button', { name: 'Save collection name' })).toBeDisabled();
  expect(
    screen.getByRole('button', { name: `Remove ${recipe.title} from collection` }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review deleting collection' })).toBeDisabled();
  expect(service.execute).not.toHaveBeenCalled();
});

test('an old deletion receipt cannot hide the same collection restored in a newer epoch', async () => {
  service.deleteCollection.mockImplementationOnce(async (review, operationId) => {
    receipts.set(
      operationId,
      receipt(operationId, 'deleteCollection', 'committed', review.collectionId),
    );
    return { kind: 'uncertain', operationId, error: failure };
  });
  const first = render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Review deleting collection' })).not.toBeDisabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Review deleting collection' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Confirm delete collection' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check personal change receipt' }),
    ).not.toBeDisabled(),
  );
  first.unmount();
  service.readCollection.mockResolvedValue(
    ready({
      epoch: 2,
      collection: { ...collection, revision: 10 },
      items: [member],
      nextCursor: null,
    }),
  );
  render(
    <CollectionDetails
      service={service}
      readInstallationId={identity}
      collectionId={collectionId}
    />,
  );
  await checkReceipt();
  expect(screen.queryByText('Collection deleted')).toBeNull();
  expect(screen.getByText('Weeknight ideas')).toBeTruthy();
  expect(screen.getByText(recipe.title)).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Rename collection' })).not.toBeDisabled(),
  );
  expect(service.deleteCollection).toHaveBeenCalledTimes(1);
});
