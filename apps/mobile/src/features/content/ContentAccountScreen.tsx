import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActionButton, Notice } from '../../components/Controls';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { GuestAccountPanel } from '../account/AccountPanels';
import { AccountScopeReviewPanel } from '../account/AccountScopeReviewPanel';
import type { AccountProviderName } from '../account/authTypes';
import { useContentAccount, type ContentAccountContextValue } from './contentAccountContext';
import type { ContentAccountRuntimeSyncState } from './contentAccountRuntimeBackend';
import { ContentAccountReviewPanel } from './ContentAccountReviewPanel';

const noSubscription = () => () => {};
const noHost = () => null;

/** Also mounts before an ordinary workspace exists; never borrows legacy workspace services. */
export function ContentAccountScreen() {
  const context = useContentAccount();
  const view = useSyncExternalStore(
    context.root.view.subscribe,
    context.root.view.getSnapshot,
    context.root.view.getSnapshot,
  );
  const host = context.handle?.kind === 'content_workspace' ? context.handle.runtime.host : null;
  const hostState = useSyncExternalStore(
    host?.subscribe ?? noSubscription,
    host?.getSnapshot ?? noHost,
    host?.getSnapshot ?? noHost,
  );
  const ownerKey = `${context.state.workspaceKey}:${context.state.identity?.ownerId ?? 'signed-out'}:${view.viewGeneration}:${hostState?.scopeKey ?? 'bootstrap'}`;
  const props = {
    context,
    ownerKey,
    generation: view.viewGeneration,
    hostReady: !host || hostState?.status === 'ready',
  };
  return context.handle?.kind === 'account_bootstrap' ? (
    <StandaloneAccountBody key={ownerKey} {...props} />
  ) : (
    <RoutedAccountBody key={ownerKey} {...props} />
  );
}

interface AccountBodyProps {
  context: ContentAccountContextValue;
  ownerKey: string;
  generation: number;
  hostReady: boolean;
}
function StandaloneAccountBody(props: AccountBodyProps) {
  const focused = useRef(false);
  useEffect(() => {
    focused.current = true;
    return () => {
      focused.current = false;
    };
  }, []);
  return <AccountBody {...props} focused={focused} />;
}
function RoutedAccountBody(props: AccountBodyProps) {
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );
  return <AccountBody {...props} focused={focused} />;
}
function AccountBody({
  context,
  ownerKey,
  generation,
  hostReady,
  focused,
}: AccountBodyProps & { focused: RefObject<boolean> }) {
  const { root, state, handle, opening, reopen } = context;
  const runtime = root.runtime;
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [signOut, setSignOut] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const hostScope =
    handle?.kind === 'content_workspace' ? handle.runtime.host.getSnapshot().scopeKey : null;
  const scope = useRef({ root, ownerKey, handle, opening });
  scope.current = { root, ownerKey, handle, opening };
  const current = useCallback(() => {
    const live = runtime.getSnapshot();
    return (
      focused.current &&
      scope.current.root === root &&
      scope.current.ownerKey === ownerKey &&
      scope.current.handle === handle &&
      root.view.getSnapshot().viewGeneration === generation &&
      live.workspaceKey === state.workspaceKey &&
      live.identity?.ownerId === state.identity?.ownerId &&
      (handle?.kind !== 'content_workspace' ||
        handle.runtime.host.getSnapshot().scopeKey === hostScope)
    );
  }, [
    runtime,
    root,
    ownerKey,
    handle,
    generation,
    state.workspaceKey,
    state.identity?.ownerId,
    hostScope,
    focused,
  ]);
  const writable = () =>
    current() &&
    !scope.current.opening &&
    (handle?.kind !== 'content_workspace' ||
      handle.runtime.host.getSnapshot().status === 'ready') &&
    !runtime.getSnapshot().busy &&
    !runtime.getSnapshot().checkingSession;
  const busy = opening || !hostReady || state.busy || state.checkingSession;
  const syncing = state.sync.kind === 'working';
  const review = state.sync.kind === 'review' ? state.sync : null;
  const reviewCurrent = useCallback(
    () =>
      current() &&
      !scope.current.opening &&
      (handle?.kind !== 'content_workspace' ||
        handle.runtime.host.getSnapshot().status === 'ready') &&
      runtime.getSnapshot().sync === review,
    [current, handle, runtime, review],
  );
  const scopeReview =
    state.identity &&
    state.expandedScopeAvailable &&
    (state.scopeReview?.kind !== 'review' ||
      state.scopeReview.review.ownerId === state.identity.ownerId)
      ? state.scopeReview
      : null;
  const login = (provider: AccountProviderName) => {
    if (!writable()) return;
    context.startSignIn(provider);
  };
  const scopeAction = () => {
    if (writable() && !syncing) void runtime.reviewSyncScope();
  };
  const back = () => {
    if (current() && handle?.kind === 'content_workspace') router.replace('/');
  };
  return (
    <Page bottomInset>
      <View style={styles.header}>
        <AppText role="title" accessibilityRole="header">
          Account & sync
        </AppText>
        {handle?.kind === 'content_workspace' && (
          <ActionButton label="Back to CookMate" variant="quiet" onPress={back} />
        )}
      </View>
      {state.error && (
        <Notice title="Account needs attention" tone="error">
          {accountError(state.error)}
        </Notice>
      )}
      {context.signInRedirectFailed && (
        <Notice title="Sign-in could not be opened">
          Return to the sign-in choice when your browser is ready.
        </Notice>
      )}
      {!hostReady && (
        <Notice title="Workspace unavailable">
          Finish the workspace update or recovery before making account changes. A pending account
          save is not cancelled by this message.
        </Notice>
      )}
      {(state.earlierDeletions ?? []).map((request, index) => (
        <Notice key={request.operationId} title={`Earlier account deletion · Request ${index + 1}`}>
          <AppText>
            {request.status === 'deleted'
              ? 'The service confirmed deletion of this earlier account. Your current sign-in and local cooking have not changed.'
              : 'This earlier deletion is not confirmed. Checking its status does not send another deletion or switch accounts.'}
          </AppText>
          {request.status !== 'deleted' && (
            <ActionButton
              label={`Check earlier deletion request ${index + 1}`}
              variant="secondary"
              disabled={state.busy || state.checkingSession}
              onPress={() => {
                if (current() && !runtime.getSnapshot().busy)
                  void runtime.checkEarlierDeletion(request.ownerId);
              }}
            />
          )}
        </Notice>
      ))}
      {state.deletion ? (
        <View style={styles.panel}>
          <AppText role="section" accessibilityRole="header">
            {state.deletion.kind === 'deleted'
              ? 'Cloud account deleted'
              : 'Delete CookMate account?'}
          </AppText>
          <AppText>
            {state.deletion.kind === 'deleted'
              ? 'The account service confirmed deletion. Your local cooking copy remains on this device.'
              : 'This deletes your CookMate cloud account and its synchronized cooking data. Your local cooking copy stays on this device. It does not delete your Apple or Google account.'}
          </AppText>
          {state.deletion.kind === 'unconfirmed' && (
            <Notice title="Deletion is not confirmed">
              The request may have reached the service. Being signed out is not proof of deletion.
              Keep this record until its result can be checked.
            </Notice>
          )}
          {state.deletion.reason && (
            <Notice title="Account service response">{deletionError(state.deletion.reason)}</Notice>
          )}
          {(state.identity || state.deletion.kind === 'unconfirmed') &&
            state.deletion.kind !== 'deleted' &&
            state.deletion.kind !== 'working' && (
              <ActionButton
                label={
                  state.deletion.kind === 'review'
                    ? 'Delete my CookMate cloud account'
                    : 'Check deletion again'
                }
                busy={state.busy}
                disabled={state.busy || state.checkingSession}
                onPress={() => {
                  if (
                    !current() ||
                    runtime.getSnapshot().deletion !== state.deletion ||
                    runtime.getSnapshot().busy
                  )
                    return;
                  if (state.deletion?.kind === 'review') {
                    if (writable()) void runtime.confirmDeletion();
                  } else if (state.deletion?.kind === 'unconfirmed') void runtime.checkDeletion();
                  else if (writable()) void runtime.reviewDeletion();
                }}
              />
            )}
          {state.deletion.kind === 'unconfirmed' && state.identity && (
            <ActionButton
              label="Retry the same deletion request"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                if (writable() && runtime.getSnapshot().deletion === state.deletion)
                  void runtime.confirmDeletion();
              }}
            />
          )}
          {state.deletion.reason === 'recent_sign_in_required' && state.identity?.provider && (
            <ActionButton
              label={`Continue with ${state.identity.provider === 'apple' ? 'Apple' : 'Google'} to renew sign-in`}
              variant="secondary"
              disabled={busy}
              onPress={() => {
                if (state.identity?.provider) login(state.identity.provider);
              }}
            />
          )}
          {state.deletion.kind === 'unconfirmed' && !state.identity && (
            <>
              <AppText>
                Sign in to the same account to retry this request. Signing in does not send it
                automatically.
              </AppText>
              {root.configured ? (
                <>
                  <ActionButton
                    label="Continue with Apple to recover this request"
                    variant="secondary"
                    disabled={busy || !root.availability.apple}
                    onPress={() => login('apple')}
                  />
                  <ActionButton
                    label="Continue with Google to recover this request"
                    variant="secondary"
                    disabled={busy || !root.availability.google}
                    onPress={() => login('google')}
                  />
                </>
              ) : (
                <AppText>
                  Sign-in is not configured in this build. Keep this recovery record until the
                  account service is available.
                </AppText>
              )}
            </>
          )}
          {state.deletion.kind !== 'working' && state.deletion.kind !== 'unconfirmed' && (
            <ActionButton
              label={
                state.deletion.kind === 'deleted'
                  ? 'Continue with local cooking'
                  : 'Cancel deletion'
              }
              variant="secondary"
              disabled={state.busy}
              onPress={() => {
                if (current() && runtime.getSnapshot().deletion === state.deletion)
                  runtime.cancelDeletion();
              }}
            />
          )}
        </View>
      ) : scopeReview ? (
        scopeReview.kind === 'review' ? (
          <AccountScopeReviewPanel
            review={scopeReview.review}
            busy={busy || syncing}
            onApprove={(historyIncluded) => {
              if (writable() && runtime.getSnapshot().scopeReview === scopeReview && !syncing)
                void runtime.approveSyncScope(scopeReview.review, historyIncluded);
            }}
            onCancel={() => {
              if (writable() && runtime.getSnapshot().scopeReview === scopeReview)
                runtime.cancelSyncScopeReview();
            }}
          />
        ) : scopeReview.kind === 'loading' ? (
          <Notice title="Checking sync choices">
            Please wait while CookMate checks or records your choices. This does not confirm a cloud
            backup.
          </Notice>
        ) : (
          <View style={styles.panel}>
            <Notice title="Sync choices need attention" tone="caution">
              {syncError(scopeReview.reason)}
            </Notice>
            {![
              'operation_pending',
              'settings_pending',
              'account_changed',
              'different_data_owner',
            ].includes(scopeReview.reason) && (
              <ActionButton
                label="Review sync choices again"
                disabled={busy || syncing}
                onPress={scopeAction}
              />
            )}
            <ActionButton
              label="Back to account"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                if (writable()) runtime.cancelSyncScopeReview();
              }}
            />
          </View>
        )
      ) : signOut && state.identity ? (
        <View style={styles.panel}>
          <AppText role="section" accessibilityRole="header">
            Keep CookMate data on this device?
          </AppText>
          <AppText>
            A retained local copy stays accessible to anyone using this unlocked app. A different
            account gets a separate workspace.
          </AppText>
          <Notice title="Cloud and local data are separate">
            Signing out does not delete the cloud account. Removing its local copy deletes local
            plans, conversations, drafts, notes and history for this account. Changes not confirmed
            in the account may be lost. The original guest workspace is kept.
          </Notice>
          {handle?.kind === 'account_bootstrap' && (
            <Notice title="Finish the first account review">
              This copy is not yet bound to the account. Finish its review before keeping it for
              signed-out use, or explicitly remove this account copy and return to the retained
              guest workspace.
            </Notice>
          )}
          <ActionButton
            label="Keep on this device"
            disabled={busy || handle?.kind !== 'content_workspace'}
            onPress={() => {
              if (writable() && handle?.kind === 'content_workspace') void runtime.signOut(false);
            }}
          />
          <ActionButton
            label="Remove account data from this device"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              if (writable()) void runtime.signOut(true);
            }}
          />
          <ActionButton
            label="Cancel sign out"
            variant="quiet"
            disabled={state.busy}
            onPress={() => {
              if (current()) setSignOut(false);
            }}
          />
        </View>
      ) : review && (showReview || review.phase === 'reopen') ? (
        <ContentAccountReviewPanel
          review={review}
          ownerKey={ownerKey}
          busy={busy}
          isCurrent={reviewCurrent}
          {...(handle?.kind === 'content_workspace' && hostReady
            ? { readExact: handle.runtime.host.content.readExact }
            : {})}
          dispatch={(action) => {
            if (!reviewCurrent() || !writable()) return;
            void runtime.dispatch(action);
            if (action.kind === 'cancelReview') setShowReview(false);
          }}
          reopen={() => {
            if (reviewCurrent() && writable()) reopen();
          }}
        />
      ) : state.identity ? (
        <View style={styles.panel}>
          <View style={styles.copy}>
            <AppText role="section" accessibilityRole="header">
              {state.identity.displayName?.trim() || 'Your CookMate account'}
            </AppText>
            <AppText color="inkSecondary">{state.identity.email || 'Email not supplied'}</AppText>
          </View>
          <Notice title={syncTitle(state.sync)}>
            <AppText>{syncDetail(state.sync)}</AppText>
          </Notice>
          {state.sync.kind === 'review' ? (
            <ActionButton
              label="Review differences"
              disabled={busy}
              onPress={() => {
                if (writable() && runtime.getSnapshot().sync === state.sync) setShowReview(true);
              }}
            />
          ) : (
            <ActionButton
              label={syncing ? 'Syncing…' : 'Sync now'}
              disabled={busy || syncing || !root.rollout}
              onPress={() => {
                if (writable() && !syncing && root.rollout) void runtime.syncNow();
              }}
            />
          )}
          {state.expandedScopeAvailable && (
            <ActionButton
              label="Review sync choices"
              variant="secondary"
              disabled={busy || syncing}
              onPress={scopeAction}
            />
          )}
          {!root.rollout && (
            <Notice title="Sync unavailable in this build">
              Your local cooking copy remains separate. No account save is claimed.
            </Notice>
          )}
          <AppText role="support" color="inkSecondary">
            Personal cooking data needs its own review. Cooking history is optional. Signing in
            never grants AI sharing consent.
          </AppText>
          <ActionButton
            label="Sign out"
            variant="secondary"
            disabled={busy || syncing}
            onPress={() => {
              if (writable() && !syncing) setSignOut(true);
            }}
          />
          <ActionButton
            label="Delete CookMate account"
            variant="quiet"
            disabled={busy || syncing}
            onPress={() => {
              if (writable() && !syncing) void runtime.reviewDeletion();
            }}
          />
        </View>
      ) : (
        <>
          {state.workspace.kind === 'account' && (
            <Notice title="A local account copy is open">
              You are signed out. This account’s saved cooking stays on this device. Signing into a
              different account opens a separate workspace.
            </Notice>
          )}
          <GuestAccountPanel
            googleAvailable={root.availability.google}
            appleAvailable={root.availability.apple}
            busy={state.busy || state.checkingSession || opening}
            storageAvailable={handle?.kind === 'content_workspace' && hostReady}
            expandedScopeAvailable={root.rollout}
            availabilityNotice={
              !root.configured
                ? 'Sign-in and cloud sync are not configured in this build. Your current local workspace stays available; local saving and backups require available device storage.'
                : state.checkingSession
                  ? 'Checking the saved session. No account save is confirmed by this check.'
                  : null
            }
            onGoogle={() => login('google')}
            onApple={() => login('apple')}
            onContinueGuest={back}
            onLocalBackup={() => {
              if (writable() && handle?.kind === 'content_workspace')
                router.navigate({ pathname: '/settings', params: { section: 'backup' } });
            }}
          />
        </>
      )}
    </Page>
  );
}
function syncTitle(state: ContentAccountRuntimeSyncState) {
  switch (state.kind) {
    case 'working':
      return 'Sync in progress';
    case 'synced':
      return 'Synced';
    case 'review':
      return 'Needs review';
    case 'failed':
      return 'Sync needs attention';
    default:
      return 'Saved on this device';
  }
}
function syncDetail(state: ContentAccountRuntimeSyncState) {
  switch (state.kind) {
    case 'working':
      return 'CookMate is checking or applying supported changes. The overall sync is still in progress.';
    case 'synced':
      return state.at
        ? `Account data last saved: ${state.at}`
        : 'The reviewed account data matches this device. An account-save time was not supplied.';
    case 'review':
      return 'Review the current differences before continuing. A pending account operation is not cancelled by leaving this screen.';
    case 'failed':
      return `${syncError(state.reason)} ${state.pending ? 'An earlier operation still needs reconciliation. Do not assume it was cancelled.' : 'The latest account result is not confirmed.'}`;
    default:
      return 'The latest local changes have not yet been confirmed in your account.';
  }
}
function syncError(reason: string) {
  switch (reason) {
    case 'scope_review_required':
    case 'scope_changed':
      return 'Review which personal cooking data may join your account. Cooking history remains a separate choice.';
    case 'snapshot_upgrade_required':
      return 'This account snapshot needs a supported format transition before this workspace can sync. It has not been discarded or treated as empty.';
    case 'operation_pending':
    case 'settings_pending':
    case 'recovery_required':
      return 'An earlier cooking or sync change needs recovery before these choices can change.';
    case 'local_changed':
    case 'journal_changed':
    case 'needs_review':
    case 'stale_server_revision':
      return 'Cooking data changed. Check sync again to review the current versions.';
    case 'account_changed':
    case 'different_data_owner':
      return 'The account changed. Return to the current account before continuing.';
    case 'catalogue_mismatch':
    case 'history_content_mismatch':
      return 'The linked recipe versions could not be verified. Your saved local cooking has not been reset.';
    case 'too_large':
      return 'This data exceeds the supported sync size. Your local cooking remains available.';
    case 'sign_in_required':
    case 'recent_sign_in_required':
      return 'Renew sign-in before continuing account sync.';
    default:
      return 'CookMate could not confirm this account result. Check again when the service and local storage are available.';
  }
}
function accountError(reason: string) {
  if (reason === 'cancelled') return 'Sign-in was cancelled. Your local cooking is unchanged.';
  if (reason === 'not_configured') return 'Account sign-in is not configured in this build.';
  if (reason === 'session_expired')
    return 'Your sign-in needs to be renewed. Your local cooking has been kept.';
  if (reason === 'storage')
    return 'Account storage could not be confirmed. CookMate has not reset your saved work.';
  if (reason === 'account_changed')
    return 'The account changed during this action. Review the current account before trying again.';
  return 'The sign-in provider could not complete this request. Try again when available.';
}
function deletionError(reason: string) {
  if (reason === 'recent_sign_in_required')
    return 'Sign in again before deleting the cloud account. No successful deletion has been confirmed.';
  if (reason === 'needs_review')
    return 'Account data changed. Review the current cloud account before requesting deletion again.';
  if (reason === 'deletion_pending')
    return 'The service received the request but has not confirmed completion. Retrying uses the same request.';
  if (reason === 'deletion_capability_limit')
    return 'Keep the existing recovery record. Creating another request will not resolve this limit.';
  return 'CookMate could not confirm the deletion result. Your local copy remains available.';
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    header: { gap: t.space.sm, minWidth: 0 },
    panel: { gap: t.space.lg, minWidth: 0 },
    copy: { gap: t.space.xs, minWidth: 0 },
  });
