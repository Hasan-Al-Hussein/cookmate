import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  CookMateQueries,
  Immutable,
  PersonalCommand,
  PersonalMutationResult,
  PersonalReceipt,
  PersonalService,
  RepositoryResult,
} from '@cookmate/domain';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { usePersonalPorts } from './PersonalUI';
import { usePersonalOperations } from './usePersonalOperations';
import { usePersonalQuery } from './usePersonalQuery';
import { collectionReferenceStore } from './collectionReferenceStorage';
import { useOptionalContentPrivateState } from '../content/contentPrivateState';

export type CollectionCommand = Extract<
  PersonalCommand,
  { kind: 'createCollection' | 'renameCollection' | 'setCollectionMembership' }
>;
export type CollectionService = Pick<
  PersonalService,
  | 'readCollections'
  | 'readCollection'
  | 'reviewDeleteCollection'
  | 'deleteCollection'
  | 'readReceipt'
  | 'resolveOperation'
  | 'subscribe'
> & {
  execute(command: Immutable<CollectionCommand>): Promise<PersonalMutationResult>;
};
export interface CollectionPorts {
  service: CollectionService;
  readInstallationId: CookMateQueries['readInstallationId'];
  mode: 'bundled' | 'content';
  scopeKey: string;
  isCurrent(): boolean;
}
export type CollectionDataPorts = Pick<CollectionPorts, 'service' | 'readInstallationId'> &
  Partial<Pick<CollectionPorts, 'mode' | 'isCurrent'>>;
const alwaysCurrent = () => true;
const emptySnapshot = () => null;
const noSubscribe = () => () => undefined;
const acceptsCollectionReceipt = (receipt: Immutable<PersonalReceipt>) =>
  ['createCollection', 'renameCollection', 'setCollectionMembership', 'deleteCollection'].includes(
    receipt.commandKind ?? '',
  ) ||
  (receipt.commandKind === null && receipt.outcome === 'cancelled');

/** Collections borrow their own capability; notes and manual recovery stay separate. */
export function useCollectionPorts(): CollectionPorts | null {
  const runtime = useOrdinaryContentRuntime(),
    legacy = usePersonalPorts(),
    workspace = useWorkspace();
  const host = runtime?.host;
  const state = useSyncExternalStore(
    host?.subscribe ?? noSubscribe,
    host?.getSnapshot ?? emptySnapshot,
    host?.getSnapshot ?? emptySnapshot,
  );
  const owner = useRef({ host, generation: 0 });
  if (owner.current.host !== host)
    owner.current = { host, generation: owner.current.generation + 1 };
  const scopeKey = host
    ? `${owner.current.generation}:${state?.scopeKey ?? 'unavailable'}`
    : workspace.workspaceKey;
  const service = host?.collections ?? legacy?.service;
  const mounted = useRef(true),
    latest = useRef({ host, scopeKey, service });
  latest.current = { host, scopeKey, service };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(() => {
    if (
      !mounted.current ||
      latest.current.host !== host ||
      latest.current.scopeKey !== scopeKey ||
      latest.current.service !== service
    )
      return false;
    if (host) {
      const now = host.getSnapshot();
      return now.status === 'ready' && `${owner.current.generation}:${now.scopeKey}` === scopeKey;
    }
    return !!service;
  }, [host, scopeKey, service]);
  if (host)
    return state?.status === 'ready'
      ? {
          service: host.collections,
          readInstallationId: host.readInstallationId,
          mode: 'content',
          scopeKey,
          isCurrent,
        }
      : null;
  return legacy ? { ...legacy, mode: 'bundled', scopeKey, isCurrent } : null;
}

export function useCollectionData<T>(
  {
    service,
    readInstallationId,
    isCurrent: scopeCurrent = alwaysCurrent,
    mode = 'bundled',
  }: CollectionDataPorts,
  read: (cursor?: string) => Promise<RepositoryResult<T>>,
  append?: (previous: T, next: T) => T,
) {
  const mounted = useRef(true),
    latest = useRef({ service, scopeCurrent });
  latest.current = { service, scopeCurrent };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      latest.current.service === service &&
      latest.current.scopeCurrent === scopeCurrent &&
      scopeCurrent(),
    [service, scopeCurrent],
  );
  const query = usePersonalQuery(service, read, 'collections', append, isCurrent);
  const privateState = useOptionalContentPrivateState();
  const operation = usePersonalOperations(service, readInstallationId, {
    isCurrent,
    ...(mode === 'content'
      ? {
          referenceStore: privateState?.references.collections ?? collectionReferenceStore,
          acceptsReceipt: acceptsCollectionReceipt,
        }
      : {}),
  });
  const [refreshed, setRefreshed] = useState<Immutable<PersonalReceipt> | null>(null);
  const awaiting = useRef<{ receipt: Immutable<PersonalReceipt>; previous: T | null } | null>(null);
  const current = useRef({ query, operation });
  current.current = { query, operation };
  useEffect(() => {
    const receipt = operation.receipt;
    if (!receipt || !isCurrent()) return;
    awaiting.current = { receipt, previous: current.current.query.value };
    void current.current.query.refresh().then((value) => {
      if (value && isCurrent() && current.current.operation.receipt === receipt)
        setRefreshed(receipt);
    });
  }, [operation.receipt, isCurrent]);
  useEffect(() => {
    const pending = awaiting.current;
    if (
      pending &&
      pending.receipt === operation.receipt &&
      isCurrent() &&
      !query.loading &&
      !query.error &&
      query.value &&
      query.value !== pending.previous
    ) {
      awaiting.current = null;
      setRefreshed(pending.receipt);
    }
  }, [operation.receipt, query.value, query.loading, query.error, isCurrent]);
  return {
    query,
    operation,
    isCurrent,
    ready:
      operation.ready &&
      !query.loading &&
      !query.error &&
      !!query.value &&
      (!operation.receipt || operation.receipt === refreshed),
  };
}
