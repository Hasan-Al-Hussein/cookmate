import { StrictMode } from 'react';
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
  type ReadingRecipe,
  type ReadingLookup,
} from '@cookmate/catalogue/content';
import {
  createRecipeSearch,
  type Immutable,
  type PersonalChange,
  type PersonalReceipt,
  type PersonalCollectionSummary,
  type CollectionMembership,
} from '@cookmate/domain';
import type { ContentWorkspaceHost, ContentWorkspaceState } from '../content/contentWorkspaceHost';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import { ActionButton } from '../../components/Controls';
import CollectionsScreen from './CollectionsScreen';
import CollectionScreen from './CollectionScreen';
import { ContentRecipeMemberships } from './RecipeCollectionMemberships';
import { CollectionRecipeRow } from './CollectionRecipeRow';
import { usePersonalPorts } from './PersonalUI';

type CollectionHost = Pick<
  ContentWorkspaceHost,
  'collections' | 'readInstallationId' | 'getSnapshot' | 'subscribe'
>;
const mockPush = jest.fn(),
  mockStorage = new Map<string, string>();
let mockId = 0,
  mockRuntime: { host: CollectionHost } | null = null,
  mockParams = { id: '' };
let mockWriteGate: Promise<void> | null = null;
let mockCatalogue: { state: OrdinaryCatalogueState; reader: OrdinaryCatalogueController } | null =
  null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockPush }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock('../../hooks/useUnsavedDraft', () => ({ useUnsavedDraft: jest.fn() }));
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
    workspaceKey: 'legacy',
    availability: { kind: 'ready', services: {} },
    registerFocusFallback: () => () => undefined,
  }),
}));
jest.mock('../content/ContentRecipePhoto', () => ({
  ContentRecipePhoto: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Verified collection photo</Text>;
  },
}));
jest.mock('./collectionReferenceStorage', () => {
  const { createPersonalReferenceStore } =
    jest.requireActual<typeof import('./personalReferences')>('./personalReferences');
  return {
    collectionReferenceStore: createPersonalReferenceStore({
      read: async (key) => mockStorage.get(`content-collections:${key}`) ?? null,
      write: async (key, value) => {
        if (mockWriteGate) await mockWriteGate;
        mockStorage.set(`content-collections:${key}`, value);
      },
    }),
  };
});
const installation = 'e0000000-0000-4000-8000-000000000001',
  collectionId = 'b0000000-0000-4000-8000-000000000001',
  timestamp = '2026-10-01T08:00:00.000Z';
const recoveryKey = `content-collections:cookmate.personal-recovery.${installation}`;
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.failure',
  retry: 'never' as const,
};
const ready = <T,>(value: T, revision = 4) => ({ kind: 'ready' as const, revision, value });
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
  mockRuntime = null;
  mockCatalogue = null;
  mockWriteGate = null;
  mockParams = { id: collectionId };
});
afterEach(cleanup);
/** Controlled component ports only; SQLite, signatures and browser delivery are verified elsewhere. */
function fixture() {
  let revision = 4,
    epoch = 1;
  let collections: Immutable<PersonalCollectionSummary>[] = [
    {
      collectionId,
      name: 'Weeknight ideas',
      deleted: false,
      revision: 4,
      createdAt: timestamp,
      updatedAt: timestamp,
      memberCount: 1,
    },
  ];
  let members: Immutable<CollectionMembership>[] = [
    { collectionId, recipeId: packaged.recipeId, present: true, revision: 4, updatedAt: timestamp },
  ];
  const recipe: Immutable<ReadingRecipe> = {
    ...packaged,
    title: 'Exact archived collection recipe',
    contentRef: { ...packaged.contentRef, revisionId: 'reviewed-collection' },
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
    readCurrent: jest.fn(async (): Promise<ReadingLookup> => ({ kind: 'missing' })),
    readSavedIdentity: jest.fn(
      async (_id: string): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'archived',
        recipe,
      }),
    ),
    readExact: jest.fn(
      async (): Promise<ReadingLookup> => ({ kind: 'readable', state: 'historical', recipe }),
    ),
    readPhoto: jest.fn(async () => {
      throw new Error('Fixture photo');
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
    changes = new Set<(change: PersonalChange) => void>(),
    receipts = new Map<string, Immutable<PersonalReceipt>>();
  const service = {
    readCollections: port<CollectionHost['collections']['readCollections']>(),
    readCollection: port<CollectionHost['collections']['readCollection']>(),
    readRecipeMemberships: port<CollectionHost['collections']['readRecipeMemberships']>(),
    execute: port<CollectionHost['collections']['execute']>(),
    reviewDeleteCollection: port<CollectionHost['collections']['reviewDeleteCollection']>(),
    deleteCollection: port<CollectionHost['collections']['deleteCollection']>(),
    readReceipt: port<CollectionHost['collections']['readReceipt']>(),
    resolveOperation: port<CollectionHost['collections']['resolveOperation']>(),
    subscribe: (listener: (change: PersonalChange) => void) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
  } satisfies CollectionHost['collections'];
  const notify = () =>
    changes.forEach((listener) =>
      listener({ revision, collections: true, notes: false, manualShopping: false }),
    );
  service.readCollections.mockImplementation(async () =>
    ready({ epoch, items: [...collections] }, revision),
  );
  service.readCollection.mockImplementation(async (id) => {
    const collection = collections.find((row) => row.collectionId === id);
    return collection
      ? ready(
          {
            epoch,
            collection,
            items: members.filter((row) => row.collectionId === id && row.present),
            nextCursor: null,
          },
          revision,
        )
      : { kind: 'failed', error: failure };
  });
  service.readRecipeMemberships.mockImplementation(async (id) =>
    ready({ epoch, memberships: members.filter((row) => row.recipeId === id) }, revision),
  );
  service.reviewDeleteCollection.mockImplementation(async (id) => {
    const collection = collections.find((row) => row.collectionId === id)!;
    return ready(
      {
        reviewId: 'issued-review',
        collectionId: id,
        name: collection.name!,
        expectedRevision: collection.revision,
        epoch,
        affectedRecipeIds: members
          .filter((row) => row.collectionId === id && row.present)
          .map((row) => row.recipeId),
      },
      revision,
    );
  });
  service.readReceipt.mockImplementation(async (id) => ready(receipts.get(id) ?? null, revision));
  service.resolveOperation.mockImplementation(async (id) =>
    ready(
      receipts.get(id) ?? {
        operationId: id,
        commandKind: null,
        outcome: 'cancelled',
        entityId: null,
        revision,
        epoch,
        committedAt: timestamp,
        affectedMemberships: 0,
      },
      revision,
    ),
  );
  const receipt = (
    operationId: string,
    commandKind: PersonalReceipt['commandKind'],
    entityId: string,
    affectedMemberships = 0,
  ) => {
    const value: Immutable<PersonalReceipt> = {
      operationId,
      commandKind,
      entityId,
      outcome: 'committed',
      revision,
      epoch,
      committedAt: timestamp,
      affectedMemberships,
    };
    receipts.set(operationId, value);
    return ready(value, revision);
  };
  const commit = (
    command: Parameters<CollectionHost['collections']['execute']>[0],
    send = true,
  ) => {
    revision++;
    if (command.kind === 'createCollection')
      collections.push({
        collectionId: command.collectionId,
        name: command.name,
        deleted: false,
        revision,
        createdAt: timestamp,
        updatedAt: timestamp,
        memberCount: 0,
      });
    else if (command.kind === 'renameCollection')
      collections = collections.map((row) =>
        row.collectionId === command.collectionId ? { ...row, name: command.name, revision } : row,
      );
    else {
      members = members.filter(
        (row) => row.collectionId !== command.collectionId || row.recipeId !== command.recipeId,
      );
      members.push({
        collectionId: command.collectionId,
        recipeId: command.recipeId,
        present: command.present,
        revision,
        updatedAt: timestamp,
      });
      collections = collections.map((row) => ({
        ...row,
        memberCount: members.filter(
          (member) => member.collectionId === row.collectionId && member.present,
        ).length,
      }));
    }
    const result = receipt(command.operationId, command.kind, command.collectionId);
    if (send) notify();
    return result;
  };
  const deleteCommit = (
    review: Parameters<CollectionHost['collections']['deleteCollection']>[0],
    operationId: string,
    send = true,
  ) => {
    revision++;
    collections = collections.filter((row) => row.collectionId !== review.collectionId);
    members = members.filter((row) => row.collectionId !== review.collectionId);
    const result = receipt(
      operationId,
      'deleteCollection',
      review.collectionId,
      review.affectedRecipeIds.length,
    );
    if (send) notify();
    return result;
  };
  service.execute.mockImplementation(async (command) => commit(command));
  service.deleteCollection.mockImplementation(async (review, id) => deleteCommit(review, id));
  const host = {
    collections: service,
    readInstallationId: port<CollectionHost['readInstallationId']>(),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies CollectionHost;
  host.readInstallationId.mockResolvedValue(ready(installation));
  mockRuntime = { host };
  return {
    host,
    service,
    reader,
    recipe,
    receipts,
    commit,
    deleteCommit,
    notify,
    restore: () => {
      epoch++;
      collections = [
        {
          collectionId,
          name: 'Restored collection',
          deleted: false,
          revision: ++revision,
          createdAt: timestamp,
          updatedAt: timestamp,
          memberCount: 0,
        },
      ];
    },
    retire: () => {
      state = { status: 'revoked', scopeKey: 'owner:2', pending: null, cleanupPending: 0 };
      listeners.forEach((listener) => listener());
    },
  };
}
function refs() {
  return JSON.parse(mockStorage.get(recoveryKey) ?? '{"operations":[]}').operations as {
    operationId: string;
  }[];
}
function callback(label: string) {
  return screen.UNSAFE_getAllByType(ActionButton).find((node) => node.props.label === label)!.props
    .onPress as () => void;
}
async function press(label: string) {
  await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
  fireEvent.press(screen.getByRole('button', { name: label }));
}
async function recover() {
  await press('Check personal change receipt');
  await screen.findByText('Local change saved');
}
async function reviewDelete() {
  await press('Review deleting collection');
  await screen.findByRole('button', { name: 'Confirm delete collection' });
}

test('normal content collections create exact raw name, reopen list, and keep general personal ports absent', async () => {
  const f = fixture();
  const view = render(
    <StrictMode>
      <CollectionsScreen />
    </StrictMode>,
  );
  fireEvent.changeText(screen.getByLabelText('Collection name'), '  Weekend meals  ');
  await press('Create collection');
  await waitFor(() => expect(f.service.execute).toHaveBeenCalledTimes(1));
  await screen.findByText('  Weekend meals  ');
  expect(f.service.execute.mock.calls[0]![0]).toMatchObject({
    kind: 'createCollection',
    name: '  Weekend meals  ',
    expectedEpoch: 1,
  });
  const general = renderHook(() => usePersonalPorts());
  expect(general.result.current).toBeNull();
  general.unmount();
  view.unmount();
  render(<CollectionsScreen />);
  await screen.findByText('  Weekend meals  ');
  expect(refs()).toHaveLength(0);
});
test('archived member uses verified title/photo/full ref and unavailable member remains removable', async () => {
  const f = fixture(),
    view = render(<CollectionScreen />);
  await screen.findByText(f.recipe.title);
  await screen.findByText('Verified collection photo');
  await press(`View ${f.recipe.title}`);
  expect(JSON.parse(mockPush.mock.calls[0]![0].params.contentRef)).toEqual(f.recipe.contentRef);
  view.unmount();
  f.reader.readSavedIdentity.mockResolvedValue({
    kind: 'withdrawn',
    recipeId: f.recipe.recipeId,
    reason: 'Fixture withdrawn',
  });
  render(<CollectionScreen />);
  await screen.findByText(`Unavailable recipe · ${f.recipe.recipeId}`);
  expect(screen.queryByText(packaged.title)).toBeNull();
  await press(`Remove ${f.recipe.recipeId} from collection`);
  await waitFor(() => expect(f.service.execute).toHaveBeenCalledTimes(1));
  expect(f.service.execute.mock.calls[0]![0]).toMatchObject({
    kind: 'setCollectionMembership',
    present: false,
    expectedRevision: 4,
    expectedCollectionRevision: 4,
  });
});
test('recipe memberships use the narrow read, preserve removed revision, and never query a note', async () => {
  const f = fixture();
  render(<ContentRecipeMemberships recipeId={f.recipe.recipeId} />);
  await press('Remove from Weeknight ideas');
  await waitFor(() => expect(f.service.execute).toHaveBeenCalledTimes(1));
  await press('Add to Weeknight ideas');
  await waitFor(() => expect(f.service.execute).toHaveBeenCalledTimes(2));
  expect(f.service.execute.mock.calls[1]![0]).toMatchObject({
    kind: 'setCollectionMembership',
    present: true,
    expectedRevision: 5,
  });
  expect(f.service.readRecipeMemberships).toHaveBeenCalledWith(f.recipe.recipeId);
  expect('readRecipePersonal' in f.service).toBe(false);
});
test('delete review cancellation writes nothing; exact issued review plus fresh list absence proves completion', async () => {
  const f = fixture();
  render(<CollectionScreen />);
  await reviewDelete();
  await press('Keep collection');
  expect(f.service.deleteCollection).not.toHaveBeenCalled();
  await reviewDelete();
  const exact = await f.service.reviewDeleteCollection.mock.results.at(-1)!.value;
  await press('Confirm delete collection');
  await screen.findByText('Collection deleted');
  if (exact.kind !== 'ready') throw new Error('Expected issued review');
  expect(f.service.deleteCollection.mock.calls[0]![0]).toBe(exact.value);
  expect(screen.queryByText(f.recipe.title)).toBeNull();
  await press('Return to collections');
  expect(mockPush).toHaveBeenCalledWith('/collections');
});
test('same-mounted lost delete acknowledgement recovers once using list absence although detail read fails', async () => {
  const f = fixture();
  f.service.deleteCollection.mockImplementationOnce(async (review, id) => {
    f.deleteCommit(review, id, false);
    return { kind: 'uncertain', operationId: id, error: failure };
  });
  render(<CollectionScreen />);
  await reviewDelete();
  await press('Confirm delete collection');
  await recover();
  await screen.findByText('Collection deleted');
  expect(f.service.deleteCollection).toHaveBeenCalledTimes(1);
  expect(refs()).toHaveLength(0);
});
test('unreadable list cannot confirm absence and a restored same identity is not hidden by old receipt', async () => {
  const f = fixture();
  f.service.deleteCollection.mockImplementationOnce(async (review, id) => {
    f.deleteCommit(review, id, false);
    f.service.readCollections.mockResolvedValue({ kind: 'failed', error: failure });
    return { kind: 'uncertain', operationId: id, error: failure };
  });
  render(<CollectionScreen />);
  await reviewDelete();
  await press('Confirm delete collection');
  await recover();
  await screen.findByText('Collection unavailable');
  expect(screen.queryByText('Collection deleted')).toBeNull();
  f.restore();
  f.service.readCollections.mockResolvedValue(
    ready(
      {
        epoch: 2,
        items: [
          {
            collectionId,
            name: 'Restored collection',
            deleted: false,
            revision: 6,
            createdAt: timestamp,
            updatedAt: timestamp,
            memberCount: 0,
          },
        ],
      },
      6,
    ),
  );
  await press('Retry collection');
  await screen.findByText('Restored collection');
  expect(screen.queryByText('Collection deleted')).toBeNull();
});
test('same-mounted recovered rename retains newer draft and requires current revision review', async () => {
  const f = fixture();
  f.service.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  render(<CollectionScreen />);
  await press('Rename collection');
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Submitted name');
  await press('Save collection name');
  await waitFor(() => expect(screen.getByText('Check personal change receipt')).toBeEnabled());
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Newer name');
  await recover();
  await screen.findByText('Review the updated collection');
  expect(screen.getByLabelText('Collection name').props.value).toBe('Newer name');
  expect(screen.getByText('Save collection name')).toBeDisabled();
  await press('Use current collection for this rename');
  await press('Save collection name');
  await waitFor(() => expect(f.service.execute).toHaveBeenCalledTimes(2));
  expect(f.service.execute.mock.calls[1]![0]).toMatchObject({
    expectedRevision: 5,
    name: 'Newer name',
  });
});
test('retirement during recovery metadata write hides draft and blocks retained submit', async () => {
  const f = fixture();
  render(<CollectionsScreen />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Private retired name');
  await waitFor(() => expect(screen.getByText('Create collection')).toBeEnabled());
  const save = callback('Create collection'),
    gate = deferred<void>();
  mockWriteGate = gate.promise;
  act(() => save());
  await act(async () => {
    f.retire();
    gate.resolve();
    await gate.promise;
  });
  await waitFor(() => expect(refs()).toHaveLength(1));
  await act(async () => save());
  expect(f.service.execute).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue('Private retired name')).toBeNull();
  expect(mockStorage.get(recoveryKey)).not.toContain('Private retired');
});
test('retired delete review and navigation callbacks cannot mutate or navigate; late result stays hidden', async () => {
  const f = fixture(),
    gate = deferred<Awaited<ReturnType<CollectionHost['collections']['reviewDeleteCollection']>>>();
  f.service.reviewDeleteCollection.mockImplementationOnce(() => gate.promise);
  render(<CollectionScreen />);
  await screen.findByText(f.recipe.title);
  const view = callback(`View ${f.recipe.title}`);
  await press('Review deleting collection');
  act(() => f.retire());
  await act(async () =>
    gate.resolve(
      ready({
        reviewId: 'late',
        collectionId,
        name: 'Weeknight ideas',
        expectedRevision: 4,
        epoch: 1,
        affectedRecipeIds: [f.recipe.recipeId],
      }),
    ),
  );
  act(() => view());
  expect(mockPush).not.toHaveBeenCalled();
  expect(f.service.deleteCollection).not.toHaveBeenCalled();
  expect(screen.queryByText('Weeknight ideas')).toBeNull();
  expect(screen.queryByText('Confirm delete collection')).toBeNull();
});
test('collection recovery namespace never consumes note IDs or accepts unrelated terminal receipt', async () => {
  const f = fixture(),
    id = 'f0000000-0000-4000-8000-000000000001',
    raw = JSON.stringify({
      schemaVersion: 1,
      installationId: installation,
      operations: [{ operationId: id, createdAt: timestamp }],
    });
  mockStorage.set(`content-notes:cookmate.personal-recovery.${installation}`, raw);
  const view = render(<CollectionsScreen />);
  await screen.findByText('Weeknight ideas');
  expect(screen.queryByText('Unconfirmed personal change')).toBeNull();
  view.unmount();
  mockStorage.set(recoveryKey, raw);
  f.service.readReceipt.mockResolvedValue(
    ready({
      operationId: id,
      commandKind: 'saveNote',
      outcome: 'committed',
      entityId: null,
      revision: 4,
      epoch: 1,
      committedAt: timestamp,
      affectedMemberships: 0,
    }),
  );
  render(<CollectionsScreen />);
  await press('Check personal change receipt');
  await screen.findByText('The receipt does not match this operation. No success is claimed.');
  expect(refs()).toHaveLength(1);
});
test('stale pagination response never appends a different epoch or enables edits after failure', async () => {
  const f = fixture();
  f.service.readCollection.mockResolvedValueOnce(
    ready({
      epoch: 1,
      collection: {
        collectionId,
        name: 'Weeknight ideas',
        deleted: false,
        revision: 4,
        createdAt: timestamp,
        updatedAt: timestamp,
        memberCount: 2,
      },
      items: [
        {
          collectionId,
          recipeId: f.recipe.recipeId,
          present: true,
          revision: 4,
          updatedAt: timestamp,
        },
      ],
      nextCursor: 'original-cursor',
    }),
  );
  f.service.readCollection.mockResolvedValue({ kind: 'failed', error: failure });
  render(<CollectionScreen />);
  await press('Load more collection recipes');
  await screen.findByText('Collection unavailable');
  expect(f.service.readCollection).toHaveBeenLastCalledWith(collectionId, {
    limit: 20,
    cursor: 'original-cursor',
  });
  expect(screen.getByText('Rename collection')).toBeDisabled();
  expect(f.service.execute).not.toHaveBeenCalled();
});
test('reopened uncertain creation checks original receipt without replaying its private name', async () => {
  const f = fixture();
  f.service.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  const view = render(<CollectionsScreen />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Retained name');
  await press('Create collection');
  await waitFor(() => expect(refs()).toHaveLength(1));
  view.unmount();
  render(<CollectionsScreen />);
  await recover();
  await waitFor(() => expect(refs()).toHaveLength(0));
  await screen.findByText('Retained name');
  expect(f.service.execute).toHaveBeenCalledTimes(1);
  expect(mockStorage.get(recoveryKey)).not.toContain('Retained name');
});

test('a newer subscription read completes collection receipt reconciliation without repeating creation', async () => {
  const f = fixture();
  f.service.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  render(<CollectionsScreen />);
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Submitted collection');
  await press('Create collection');
  await waitFor(() => expect(screen.getByText('Check personal change receipt')).toBeEnabled());
  fireEvent.changeText(screen.getByLabelText('Collection name'), 'Newer collection draft');
  const gate = deferred<Awaited<ReturnType<CollectionHost['collections']['readCollections']>>>();
  const previousCalls = f.service.readCollections.mock.calls.length;
  f.service.readCollections.mockImplementationOnce(() => gate.promise);
  await press('Check personal change receipt');
  await waitFor(() =>
    expect(f.service.readCollections.mock.calls.length).toBeGreaterThan(previousCalls),
  );
  act(() => f.notify());
  await waitFor(() => expect(screen.getByText('Create collection')).toBeEnabled());
  expect(screen.getByLabelText('Collection name').props.value).toBe('Newer collection draft');
  await act(async () => gate.resolve(ready({ epoch: 1, items: [] })));
  await screen.findByText('Submitted collection');
  await press('Create collection');
  await waitFor(() => expect(f.service.execute).toHaveBeenCalledTimes(2));
  const first = f.service.execute.mock.calls[0]![0],
    second = f.service.execute.mock.calls[1]![0];
  expect(second.collectionId).not.toBe(first.collectionId);
});

test('large deletion reviews hydrate only one 20-member page and confirm the full issued review', async () => {
  const f = fixture();
  const affectedRecipeIds = Array.from({ length: 41 }, (_, index) => String(90000 + index));
  const review = {
    reviewId: 'issued-large-review',
    collectionId,
    name: 'Weeknight ideas',
    expectedRevision: 4,
    epoch: 1,
    affectedRecipeIds,
  };
  f.service.reviewDeleteCollection.mockResolvedValue(ready(review));
  f.reader.readSavedIdentity.mockResolvedValue({ kind: 'missing' });
  render(<CollectionScreen />);
  await waitFor(() => expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(1));
  f.reader.readSavedIdentity.mockClear();
  await reviewDelete();
  await screen.findByText('Members 1–20 of 41');
  expect(screen.getByText(/exactly 41 memberships/)).toBeTruthy();
  await waitFor(() => expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(20));
  const visible = () =>
    screen
      .UNSAFE_getAllByType(CollectionRecipeRow)
      .filter((row) => row.props.labelOnly)
      .map((row) => row.props.recipeId);
  expect(visible()).toEqual(affectedRecipeIds.slice(0, 20));
  const retainedNext = callback('Next affected members');
  await press('Next affected members');
  await screen.findByText('Members 21–40 of 41');
  await waitFor(() => expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(40));
  expect(visible()).toEqual(affectedRecipeIds.slice(20, 40));
  await press('Next affected members');
  await screen.findByText('Members 41–41 of 41');
  await waitFor(() => expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(41));
  expect(visible()).toEqual(affectedRecipeIds.slice(40));
  expect(screen.getByText('Next affected members')).toBeDisabled();
  await press('Previous affected members');
  await screen.findByText('Members 21–40 of 41');
  await waitFor(() => expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(61));
  await press('Keep collection');
  expect(visible()).toHaveLength(0);
  await reviewDelete();
  await screen.findByText('Members 1–20 of 41');
  await waitFor(() => expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(81));
  act(() => retainedNext());
  expect(screen.getByText('Members 1–20 of 41')).toBeTruthy();
  expect(f.reader.readSavedIdentity).toHaveBeenCalledTimes(81);
  await press('Confirm delete collection');
  await screen.findByText('Collection deleted');
  expect(f.service.deleteCollection.mock.calls[0]![0]).toBe(review);
  expect(f.service.deleteCollection.mock.calls[0]![0].affectedRecipeIds).toEqual(affectedRecipeIds);
});

test('a pending saved-identity lookup is loading rather than unavailable', async () => {
  const f = fixture();
  const pending = deferred<ReadingLookup>();
  f.reader.readSavedIdentity.mockReturnValueOnce(pending.promise);
  render(<CollectionScreen />);
  await screen.findByText('Loading saved recipe…');
  expect(screen.queryByText('Unavailable recipe · ' + packaged.recipeId)).toBeNull();
  await act(async () => pending.resolve({ kind: 'missing' }));
  await screen.findByText('Unavailable recipe · ' + packaged.recipeId);
});
