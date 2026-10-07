import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ActionButton, Notice } from '../../components/Controls';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import type {
  PrivateContentController,
  PrivateContentPreparation,
} from './privateContentController';
import { PrivateContentCleanupError } from './privateContentRuntime';
import { PrivateContentScreen } from './PrivateContentScreen';

/** Operator-only entry. Neither rendering nor opening a reader creates/migrates cooking data. */
type EntryProps =
  | {
      controller: PrivateContentController;
      renderWorkspace?: ComponentProps<typeof PrivateContentScreen>['renderWorkspace'];
      renderOpened?: never;
    }
  | {
      controller: Pick<PrivateContentController, 'prepare'>;
      renderOpened(): ReactNode;
      renderWorkspace?: never;
    };
export function PrivateContentEntry(props: EntryProps) {
  const { controller, renderWorkspace } = props;
  const [entered, setEntered] = useState(false);
  const [scope, setScope] = useState(controller);
  const [state, setState] = useState<
    'idle' | 'preparing' | 'failed' | 'cleanup_blocked' | 'prepared'
  >('idle');
  const [result, setResult] = useState<PrivateContentPreparation>();
  const live = useRef(false),
    working = useRef(false),
    blocked = useRef(false),
    enteredNow = useRef(false);
  const currentController = useRef(controller),
    generation = useRef(0);
  currentController.current = controller;
  useEffect(() => {
    live.current = true;
    generation.current++;
    working.current = false;
    blocked.current = false;
    enteredNow.current = false;
    setScope(controller);
    setEntered(false);
    setState('idle');
    setResult(undefined);
    return () => {
      live.current = false;
      generation.current++;
    };
  }, [controller]);
  async function prepare() {
    if (
      !live.current ||
      currentController.current !== controller ||
      enteredNow.current ||
      working.current ||
      blocked.current
    )
      return;
    const ticket = generation.current;
    const current = () =>
      live.current && currentController.current === controller && generation.current === ticket;
    working.current = true;
    setState('preparing');
    try {
      const prepared = await controller.prepare();
      if (current()) {
        setResult(prepared);
        setState('prepared');
      }
    } catch (error) {
      if (current()) {
        if (error instanceof PrivateContentCleanupError) blocked.current = true;
        setState(blocked.current ? 'cleanup_blocked' : 'failed');
      }
    } finally {
      if (current()) working.current = false;
    }
  }
  if (scope !== controller) return null;
  if (entered && props.renderOpened) return props.renderOpened();
  if (entered && 'open' in controller)
    return (
      <PrivateContentScreen
        open={controller.open}
        {...(renderWorkspace ? { renderWorkspace } : {})}
        onExit={() => {
          if (live.current && currentController.current === controller) {
            enteredNow.current = false;
            setEntered(false);
          }
        }}
      />
    );
  return (
    <Page bottomInset>
      <AppText role="title">Private recipe review</AppText>
      <Notice title="Separate review workspace">
        <AppText>
          This uses the configured review database only. It does not open, replace or reset your
          usual CookMate data.
        </AppText>
      </Notice>
      <AppText>
        For first use, prepare a new workspace with the original recipe collection. Previously
        prepared review workspaces can be reopened. Recipe updates are fetched, reviewed and adopted
        separately.
      </AppText>
      {state === 'prepared' && (
        <Notice
          title={
            result?.kind === 'already_prepared'
              ? 'Existing review workspace verified'
              : 'Review workspace prepared'
          }
        >
          <AppText>
            {result?.resumed
              ? 'Interrupted preparation was safely resumed. You can now open this review workspace.'
              : 'You can now open this review workspace. No published recipe update has been adopted.'}
          </AppText>
        </Notice>
      )}
      {state === 'failed' && (
        <Notice title="Preparation could not finish" tone="caution">
          <AppText>
            The configured database must be new or belong to this preparation. Existing unmarked or
            account-owned data is refused. Check the private configuration before retrying; no reset
            is offered.
          </AppText>
        </Notice>
      )}
      {state === 'cleanup_blocked' && (
        <Notice title="Workspace cleanup is unconfirmed" tone="caution">
          <AppText>
            Reload this private review page before trying again. Preparation or opening cannot
            safely continue in this document.
          </AppText>
        </Notice>
      )}
      <ActionButton
        label="Open prepared review workspace"
        disabled={state === 'preparing' || state === 'cleanup_blocked'}
        onPress={() => {
          if (
            live.current &&
            currentController.current === controller &&
            !working.current &&
            !blocked.current &&
            !enteredNow.current
          ) {
            enteredNow.current = true;
            setEntered(true);
          }
        }}
      />
      <ActionButton
        label="Prepare new review workspace"
        variant="secondary"
        busy={state === 'preparing'}
        disabled={state === 'cleanup_blocked'}
        onPress={prepare}
      />
    </Page>
  );
}
