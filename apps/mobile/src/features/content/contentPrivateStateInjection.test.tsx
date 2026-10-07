import { type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import { ContentPrivateStateContext, createContentPrivateState } from './contentPrivateState';
import {
  useManualShoppingData,
  type ManualShoppingService,
} from '../personal/useManualShoppingPorts';
import { useCollectionData, type CollectionService } from '../personal/useCollectionPorts';
import { useContentSessionOperations } from '../cooking/useContentCookingProgress';
import type { ContentCookingReaderHost } from '../cooking/contentCookingPorts';
import type { ContentCookingReference } from '../cooking/contentCookingReferences';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '680c0000-0000-4000-8000-000000000003' }));
jest.mock('../personal/PersonalUI', () => ({ usePersonalPorts: () => null }));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ workspaceKey: 'unused' }),
}));

const installationId = '680a0000-0000-4000-8000-000000000001';
const ownerA = '680b0000-0000-4000-8000-000000000001',
  ownerB = '680b0000-0000-4000-8000-000000000002';
const priorOperation = '680c0000-0000-4000-8000-000000000001';
const timestamp = '2026-10-02T00:00:00.000Z';
const ready = <T,>(value: T) => ({ kind: 'ready' as const, value, revision: 1 });
const readInstallationId = async () => ready(installationId);
const unavailable = async (): Promise<never> => {
  throw new Error('Unused mutation must not dispatch');
};
const subscribe = () => () => undefined;
const isCurrent = () => true;
const noop = async () => undefined;
const error = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.uncertain',
  retry: 'never' as const,
};
function fixture() {
  const rows = new Map<string, string>();
  const storage = {
    async read(key: string) {
      return rows.get(key) ?? null;
    },
    async write(key: string, text: string) {
      rows.set(key, text);
    },
  };
  const a = createContentPrivateState({ installationId, ownerId: ownerA }, storage),
    b = createContentPrivateState({ installationId, ownerId: ownerB }, storage);
  let bundle = a;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ContentPrivateStateContext.Provider value={bundle}>
      {children}
    </ContentPrivateStateContext.Provider>
  );
  return {
    rows,
    a,
    b,
    wrapper,
    selectB() {
      bundle = b;
    },
  };
}
afterEach(cleanup);

test.each(['manual', 'collections'] as const)(
  '%s UI hook reads only the provided owner and retires its retained callback when the bundle changes',
  async (family) => {
    const f = fixture();
    await f.a.references[family].remember(installationId, priorOperation);
    const manual: ManualShoppingService = {
      readManualShopping: async () => ready({ epoch: 0, items: [], nextCursor: null, total: 0 }),
      readReceipt: async () => ready(null),
      resolveOperation: unavailable,
      execute: unavailable,
      subscribe,
    };
    const collections: CollectionService = {
      readCollections: async () => ready({ epoch: 0, items: [] }),
      readCollection: unavailable,
      reviewDeleteCollection: unavailable,
      deleteCollection: unavailable,
      readReceipt: async () => ready(null),
      resolveOperation: unavailable,
      execute: unavailable,
      subscribe,
    };
    const useData =
      family === 'manual'
        ? () => {
            const { operation, ready } = useManualShoppingData({
              service: manual,
              readInstallationId,
              mode: 'content',
              isCurrent,
            });
            return { operation, ready };
          }
        : () => {
            const { operation, ready } = useCollectionData(
              { service: collections, readInstallationId, mode: 'content', isCurrent },
              collections.readCollections,
            );
            return { operation, ready };
          };
    const { result, rerender } = renderHook(useData, { wrapper: f.wrapper });
    await waitFor(() =>
      expect(result.current.operation.references.map((row) => row.operationId)).toEqual([
        priorOperation,
      ]),
    );
    const oldPerform = result.current.operation.perform;
    f.selectB();
    rerender({});
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.operation.references).toEqual([]);
    const dispatch = jest.fn(async (operationId: string) => ({
      kind: 'uncertain' as const,
      operationId,
      error,
    }));
    await act(async () => {
      expect(await oldPerform(dispatch)).toBe(false);
    });
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.operation.perform(dispatch)).toBe(false);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (await f.a.references[family].load(installationId)).map((row) => row.operationId),
    ).toEqual([priorOperation]);
    expect(
      (await f.b.references[family].load(installationId)).map((row) => row.operationId),
    ).toEqual(['680c0000-0000-4000-8000-000000000003']);
    expect([...f.rows.keys()].every((key) => key.startsWith('cookmate.content-private.'))).toBe(
      true,
    );
  },
);

test('body-independent cooking recovery follows the provided owner without replaying another owner session', async () => {
  const f = fixture();
  const record: ContentCookingReference = {
    kind: 'session',
    createdAt: timestamp,
    request: {
      kind: 'dismiss',
      input: {
        operationId: priorOperation,
        recipeId: '52819',
        sessionId: '680d0000-0000-4000-8000-000000000001',
        expectedRevision: 1,
      },
    },
  };
  await f.a.references.cooking.remember(installationId, record);
  const recover = jest.fn(async () => ready(null));
  const host: ContentCookingReaderHost = {
    getSnapshot: () => ({
      status: 'ready',
      scopeKey: 'controlled-scope',
      pending: null,
      cleanupPending: 0,
    }),
    subscribe,
    readInstallationId,
    subscribeCooking: subscribe,
    sessions: {
      readSession: unavailable,
      saveSession: unavailable,
      dismissSession: unavailable,
      recover,
    },
    cooked: {
      saveCooked: unavailable,
      prepareCookedRecovery: unavailable,
      readCookedRecovery: unavailable,
      resolveCookedRecovery: unavailable,
    },
    history: { readHistory: unavailable },
  };
  const { result, rerender } = renderHook(
    () => useContentSessionOperations(host, isCurrent, noop),
    { wrapper: f.wrapper },
  );
  await waitFor(() => expect(result.current.recovery.records).toEqual([record]));
  const check = result.current.check;
  f.selectB();
  rerender({});
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    await check(record);
  });
  expect(recover).not.toHaveBeenCalled();
  expect(result.current.recovery.records).toEqual([]);
  expect(await f.a.references.cooking.load(installationId)).toEqual([record]);
  expect(await f.b.references.cooking.load(installationId)).toEqual([]);
});
