import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import type { ContractError } from '@cookmate/contracts';
import type { ChangedCollection, CookMateServices, RepositoryResult } from '@cookmate/domain';
import type {
  LocalCookMateServices,
  LocalStoreInitializationResult,
} from '../../data/localServices';
import { DirectActionController, type ActionState } from './directActionController';
import { runtimeClock, type RuntimeClock } from './runtimeClock';
import { DirectRecoveryController, type RecoveryState } from './directRecoveryController';
import type { AssistantRuntime } from '../assistant/assistantRuntime';

type Availability =
  | { kind: 'opening' }
  | { kind: 'failed'; error: ContractError }
  | { kind: 'ready'; services: LocalCookMateServices };
interface Workspace {
  workspaceKey: string;
  assistant: AssistantRuntime | null;
  availability: Availability;
  clock: RuntimeClock;
  revisions: Readonly<Record<ChangedCollection, number>>;
  refreshVersion: number;
  refresh(): void;
  retryOpen(): void;
  actions: DirectActionController | null;
  actionState: ActionState;
  recovery: DirectRecoveryController | null;
  recoveryState: RecoveryState;
  registerFocusFallback(focus: () => void): () => void;
  restoreScreenFocus(): void;
}
const openError: ContractError = {
  code: 'storage_failure',
  messageKey: 'storage.open_failed',
  retry: 'after_correction',
};
const cleanupError: ContractError = {
  code: 'storage_failure',
  messageKey: 'storage.cleanup_failed',
  retry: 'never',
};
const initialRevisions = { favourites: 0, plan: 0, shopping: 0, preferences: 0, conversation: 0 };
const Context = createContext<Workspace>({
  workspaceKey: 'guest',
  assistant: null,
  availability: { kind: 'failed', error: openError },
  clock: runtimeClock,
  revisions: initialRevisions,
  refreshVersion: 0,
  refresh: () => undefined,
  retryOpen: () => undefined,
  actions: null,
  actionState: { kind: 'idle' },
  recovery: null,
  recoveryState: { kind: 'loading' },
  registerFocusFallback: () => () => undefined,
  restoreScreenFocus: () => undefined,
});

export function WorkspaceProvider({
  children,
  openStore,
  createAssistant,
  workspaceKey = 'guest',
  clock = runtimeClock,
}: {
  children: ReactNode;
  openStore: () => Promise<LocalStoreInitializationResult>;
  /** Changing owner reuses this provider's close-before-open barrier. Never key-remount it. */
  workspaceKey?: string;
  createAssistant?: (services: CookMateServices) => AssistantRuntime;
  clock?: RuntimeClock;
}) {
  const [availability, setAvailability] = useState<Availability>({ kind: 'opening' });
  const [openedWorkspaceKey, setOpenedWorkspaceKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revisions, setRevisions] = useState(initialRevisions);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [actions, setActions] = useState<DirectActionController | null>(null);
  const [assistant, setAssistant] = useState<AssistantRuntime | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' });
  const [recovery, setRecovery] = useState<DirectRecoveryController | null>(null);
  const [recoveryState, setRecoveryState] = useState<RecoveryState>({ kind: 'loading' });
  const screenFocus = useRef<(() => void) | null>(null);
  const registerFocusFallback = useCallback((focus: () => void) => {
    screenFocus.current = focus;
    return () => {
      if (screenFocus.current === focus) screenFocus.current = null;
    };
  }, []);
  const restoreScreenFocus = useCallback(() => screenFocus.current?.(), []);
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
  const lifecycle = useRef(Promise.resolve());
  useEffect(() => {
    // Capture factories from this committed owner, before awaiting the prior close.
    // A speculative render for another owner must not change an in-flight opener.
    const openAttempt = openStore;
    const createAttemptAssistant = createAssistant;
    let active = true;
    let detached = false;
    let cleanupFailed = false;
    let services: LocalCookMateServices | undefined;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeAction: (() => void) | undefined;
    let unsubscribeRecovery: (() => void) | undefined;
    let assistantRuntime: AssistantRuntime | undefined;
    let unsubscribeAssistant: (() => void) | undefined;
    let retireController: (() => void) | undefined;
    const clearWorkspace = () => {
      setActions(null);
      setAssistant(null);
      setRecovery(null);
      setActionState({ kind: 'idle' });
      setRecoveryState({ kind: 'loading' });
    };
    const fail = (error: ContractError) => {
      if (!active) return;
      clearWorkspace();
      setAvailability({ kind: 'failed', error });
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      const releases = [
        retireController,
        () => assistantRuntime?.invalidate(),
        unsubscribe,
        unsubscribeAction,
        unsubscribeRecovery,
        unsubscribeAssistant,
      ];
      retireController =
        unsubscribe =
        unsubscribeAction =
        unsubscribeRecovery =
        unsubscribeAssistant =
          undefined;
      for (const releaseResource of releases) {
        try {
          releaseResource?.();
        } catch {
          cleanupFailed = true;
        }
      }
    };
    setAvailability({ kind: 'opening' });
    setOpenedWorkspaceKey(null);
    clearWorkspace();
    let release!: () => void;
    const disposed = new Promise<void>((resolve) => {
      release = resolve;
    });
    lifecycle.current = lifecycle.current.then(async () => {
      if (!active) return;
      try {
        const result = await openAttempt();
        if (result.kind === 'failed') {
          if (active) setAvailability(result);
          return;
        }
        // Own a late result too, so finally closes it even after this attempt retired.
        services = result.services;
        if (!active) return;
        assistantRuntime = createAttemptAssistant?.(services);
        const controller = new DirectActionController(
          services,
          refresh,
          () => screenFocus.current,
          (command) => {
            if (command.command.kind === 'clearConversation') assistantRuntime?.invalidate();
          },
          () => assistantRuntime?.checkMutationFreshness() ?? Promise.resolve(undefined),
          () => {
            void assistantRuntime?.recovery.check();
          },
        );
        retireController = () => controller.holdForAssistant(true);
        const recoveryController = new DirectRecoveryController(services, controller);
        assistantRuntime?.setMutationGate(() => active && !detached && !controller.blocked);
        controller.holdForAssistant(assistantRuntime?.mutationsHeld ?? false);
        unsubscribeAssistant = assistantRuntime?.subscribe(() => {
          if (!active || detached) return;
          controller.holdForAssistant(assistantRuntime?.mutationsHeld ?? false);
        });
        unsubscribeRecovery = recoveryController.subscribe(() => {
          if (active && !detached) setRecoveryState(recoveryController.state);
        });
        unsubscribeAction = controller.subscribe(() => {
          if (active && !detached) setActionState(controller.state);
        });
        unsubscribe = services.queries.subscribe((change) => {
          if (!active || detached) return;
          setRevisions((previous) => {
            const next = { ...previous };
            change.collections.forEach((collection) => {
              next[collection] += 1;
            });
            return next;
          });
        });
        assistantRuntime?.start();
        setRecovery(recoveryController);
        setRecoveryState(recoveryController.state);
        setActions(controller);
        setActionState({ kind: 'idle' });
        setOpenedWorkspaceKey(workspaceKey);
        setAvailability({ kind: 'ready', services });
        setAssistant(assistantRuntime ?? null);
        void recoveryController.check();
        await disposed;
      } catch {
        fail(openError);
      } finally {
        detach();
        try {
          await assistantRuntime?.dispose();
        } catch {
          cleanupFailed = true;
        }
        try {
          await services?.close();
        } catch {
          cleanupFailed = true;
        }
        if (cleanupFailed) throw cleanupError;
      }
    });
    // Observe rejection without clearing the barrier: unconfirmed cleanup forbids reopening.
    void lifecycle.current.catch(() => fail(cleanupError));
    return () => {
      active = false;
      detach();
      release();
    };
  }, [attempt, refresh, workspaceKey]);
  useEffect(() => {
    if (actionState.kind === 'receipt') actions?.restoreAfterRemoval();
  }, [actionState, actions]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh();
        void assistant?.refreshForForeground();
      }
    });
    return () => subscription.remove();
  }, [refresh, assistant]);
  const value = useMemo(
    () => ({
      workspaceKey,
      availability:
        availability.kind === 'ready' && openedWorkspaceKey !== workspaceKey
          ? { kind: 'opening' as const }
          : availability,
      assistant: openedWorkspaceKey === workspaceKey ? assistant : null,
      clock,
      revisions,
      refreshVersion,
      refresh,
      retryOpen: () => {
        if (availability.kind === 'failed' && availability.error.retry !== 'never')
          setAttempt((value) => value + 1);
      },
      actions: openedWorkspaceKey === workspaceKey ? actions : null,
      actionState: openedWorkspaceKey === workspaceKey ? actionState : { kind: 'idle' as const },
      recovery: openedWorkspaceKey === workspaceKey ? recovery : null,
      recoveryState:
        openedWorkspaceKey === workspaceKey ? recoveryState : { kind: 'loading' as const },
      registerFocusFallback,
      restoreScreenFocus,
    }),
    [
      availability,
      openedWorkspaceKey,
      workspaceKey,
      assistant,
      clock,
      revisions,
      refreshVersion,
      refresh,
      actions,
      actionState,
      recovery,
      recoveryState,
      registerFocusFallback,
      restoreScreenFocus,
    ],
  );
  return (
    <Context.Provider value={value}>
      <Fragment key={workspaceKey}>{children}</Fragment>
    </Context.Provider>
  );
}

export const useWorkspace = () => useContext(Context);

export type QueryState<T> =
  | { kind: 'loading'; previous?: T }
  | { kind: 'ready'; value: T; revision: number }
  | { kind: 'failed'; error: ContractError; previous?: T };

export function useWorkspaceQuery<T>(
  key: string,
  collections: readonly ChangedCollection[],
  read: (services: CookMateServices) => Promise<RepositoryResult<T>>,
  enabled = true,
) {
  const { availability, revisions, refreshVersion, retryOpen } = useWorkspace();
  const [state, setState] = useState<QueryState<T>>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const stateKey = useRef(key);
  const revisionKey = collections.map((collection) => revisions[collection]).join(':');
  useEffect(() => {
    let active = true;
    const keyChanged = stateKey.current !== key;
    stateKey.current = key;
    if (!enabled) {
      setState({ kind: 'loading' });
      return;
    }
    if (availability.kind !== 'ready') {
      setState(
        availability.kind === 'opening'
          ? { kind: 'loading' }
          : { kind: 'failed', error: availability.error },
      );
      return;
    }
    setState((previous) => ({
      kind: 'loading',
      ...(!keyChanged && previous.kind === 'ready'
        ? { previous: previous.value }
        : !keyChanged && previous.kind !== 'ready' && previous.previous !== undefined
          ? { previous: previous.previous }
          : {}),
    }));
    void readRef
      .current(availability.services)
      .then((result) => {
        if (!active) return;
        setState((previous) =>
          result.kind === 'ready'
            ? result
            : {
                kind: 'failed',
                error: result.error,
                ...(previous.kind === 'loading' && previous.previous !== undefined
                  ? { previous: previous.previous }
                  : {}),
              },
        );
      })
      .catch(() => {
        if (active) setState({ kind: 'failed', error: openError });
      });
    return () => {
      active = false;
    };
  }, [availability, key, revisionKey, refreshVersion, retry, enabled]);
  return {
    state: enabled && stateKey.current === key ? state : { kind: 'loading' as const },
    retry: () => {
      if (availability.kind === 'failed') retryOpen();
      else if (availability.kind === 'ready') setRetry((value) => value + 1);
    },
  };
}
