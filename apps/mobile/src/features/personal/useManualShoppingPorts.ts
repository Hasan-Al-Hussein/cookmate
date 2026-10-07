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
} from '@cookmate/domain';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { readCompleteManualShopping } from '../shopping/readShoppingShareManual';
import { usePersonalPorts } from './PersonalUI';
import { usePersonalQuery } from './usePersonalQuery';
import { usePersonalOperations } from './usePersonalOperations';
import { manualReferenceStore } from './manualReferenceStorage';
import { useOptionalContentPrivateState } from '../content/contentPrivateState';

export type ManualCommand = Extract<
  PersonalCommand,
  { kind: 'addManualItem' | 'editManualItem' | 'setManualPurchased' | 'deleteManualItem' }
>;
export type ManualShoppingService = Pick<
  PersonalService,
  'readManualShopping' | 'readReceipt' | 'resolveOperation' | 'subscribe'
> & {
  execute(command: Immutable<ManualCommand>): Promise<PersonalMutationResult>;
};
export interface ManualShoppingPorts {
  service: ManualShoppingService;
  readInstallationId: CookMateQueries['readInstallationId'];
  scopeKey: string;
  mode: 'bundled' | 'content';
  isCurrent(): boolean;
}
export type ManualShoppingDataPorts = Pick<ManualShoppingPorts, 'service' | 'readInstallationId'> &
  Partial<Pick<ManualShoppingPorts, 'isCurrent' | 'mode'>>;
const alwaysCurrent = () => true;
const emptySnapshot = () => null;
const noSubscribe = () => () => undefined;
const acceptsManualReceipt = (receipt: Immutable<PersonalReceipt>) =>
  ['addManualItem', 'editManualItem', 'setManualPurchased', 'deleteManualItem'].includes(
    receipt.commandKind ?? '',
  ) ||
  (receipt.commandKind === null && receipt.outcome === 'cancelled');
/** A separate capability: it cannot make notes/collections available by association. */
export function useManualShoppingPorts(): ManualShoppingPorts | null {
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
  const mounted = useRef(true);
  const latest = useRef({ host, scopeKey, service: legacy?.service });
  latest.current = { host, scopeKey, service: legacy?.service };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const service = host?.manual ?? legacy?.service;
  const isCurrent = useCallback(() => {
    if (!mounted.current || latest.current.host !== host || latest.current.scopeKey !== scopeKey)
      return false;
    if (host) {
      const now = host.getSnapshot();
      return now.status === 'ready' && `${owner.current.generation}:${now.scopeKey}` === scopeKey;
    }
    return !!service && latest.current.service === service;
  }, [host, scopeKey, service]);
  if (host)
    return state?.status === 'ready'
      ? {
          service: host.manual,
          readInstallationId: host.readInstallationId,
          mode: 'content',
          scopeKey,
          isCurrent,
        }
      : null;
  return legacy ? { ...legacy, mode: 'bundled', scopeKey, isCurrent } : null;
}
/** Shared reads/recovery for the full form and the inline checklist. */
export function useManualShoppingData({
  service,
  readInstallationId,
  isCurrent: scopeCurrent = alwaysCurrent,
  mode = 'bundled',
}: ManualShoppingDataPorts) {
  const mounted = useRef(true),
    latest = useRef({ service, readInstallationId, scopeCurrent });
  latest.current = { service, readInstallationId, scopeCurrent };
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
      latest.current.readInstallationId === readInstallationId &&
      latest.current.scopeCurrent === scopeCurrent &&
      scopeCurrent(),
    [service, readInstallationId, scopeCurrent],
  );
  const read = useCallback(() => readCompleteManualShopping(service), [service]);
  const query = usePersonalQuery(service, read, 'manualShopping', undefined, isCurrent);
  const privateState = useOptionalContentPrivateState();
  const operation = usePersonalOperations(service, readInstallationId, {
    isCurrent,
    ...(mode === 'content'
      ? {
          referenceStore: privateState?.references.manual ?? manualReferenceStore,
          acceptsReceipt: acceptsManualReceipt,
        }
      : {}),
  });
  const [refreshedReceipt, setRefreshedReceipt] = useState<Immutable<PersonalReceipt> | null>(null);
  const current = useRef({ query, operation });
  current.current = { query, operation };
  const refreshing = useRef<{
    receipt: Immutable<PersonalReceipt> | null;
    promise: Promise<void>;
  } | null>(null);
  const awaitingReceipt = useRef<{
    receipt: Immutable<PersonalReceipt>;
    previousValue: typeof query.value;
  } | null>(null);
  function reload(): Promise<void> {
    if (!isCurrent()) return Promise.resolve();
    const receipt = current.current.operation.receipt;
    if (refreshing.current?.receipt === receipt) return refreshing.current.promise;
    if (receipt) awaitingReceipt.current = { receipt, previousValue: current.current.query.value };
    const promise = (async () => {
      const page = await current.current.query.refresh();
      if (page && isCurrent() && current.current.operation.receipt === receipt)
        setRefreshedReceipt(receipt);
    })();
    const request = { receipt, promise };
    refreshing.current = request;
    void promise.finally(() => {
      if (refreshing.current === request) refreshing.current = null;
    });
    return promise;
  }
  useEffect(() => {
    if (operation.receipt && isCurrent()) void reload();
  }, [operation.receipt, isCurrent]);
  useEffect(() => {
    const awaited = awaitingReceipt.current;
    // A subscription may supersede refresh(). Its newer successful page still
    // establishes current rows; the old request must not strand the receipt gate.
    if (
      awaited &&
      awaited.receipt === operation.receipt &&
      isCurrent() &&
      !query.loading &&
      !query.error &&
      query.value &&
      query.value !== awaited.previousValue
    ) {
      awaitingReceipt.current = null;
      setRefreshedReceipt(awaited.receipt);
    }
  }, [operation.receipt, query.loading, query.error, query.value, isCurrent]);
  const receiptCurrent = !operation.receipt || refreshedReceipt === operation.receipt;

  return {
    query: { ...query, reload },
    operation,
    isCurrent,
    ready: operation.ready && !query.loading && !query.error && !!query.value && receiptCurrent,
    sourceReady: !query.loading && !query.error && !!query.value && receiptCurrent,
  };
}
