import { useEffect, useRef, useState } from 'react';
import { getRecipe } from '@cookmate/catalogue';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import {
  buildAccountPurchaseDescriptions,
  type AccountPurchaseDescriptions,
} from './accountPurchaseDescriptions';
import type { AccountSyncState } from '@cookmate/account-sync';
import { useRouter } from 'expo-router';
import { Platform, View, type ScrollView } from 'react-native';
import { ActionButton, Notice } from '../../components/Controls';
import { Page, PageHeader } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { useAccount } from './accountContext';
import { AccountMergePanel, GuestAccountPanel, SignedInAccountPanel } from './AccountPanels';
import { AccountScopeReviewPanel } from './AccountScopeReviewPanel';
import type { AccountProviderName } from './authTypes';

export default function AccountScreen() {
  const router = useRouter();
  const { runtime, state, availability: providers, configured } = useAccount();
  const { availability, retryOpen } = useWorkspace();
  const [review, setReview] = useState(false);
  const [signOut, setSignOut] = useState(false);
  const [descriptions, setDescriptions] = useState<{
    review: Extract<AccountSyncState, { kind: 'review' }>;
    workspaceKey: string;
    values: AccountPurchaseDescriptions;
  } | null>(null);
  const scopeButton = useRef<View>(null);
  const scopeReviewButton = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const accountOffset = useRef(0);
  const scopeEntry = useRef<{
    ownerKey: string;
    source: 'status' | 'settings';
    offset: number;
  } | null>(null);
  const ownerKey = `${state.workspaceKey}:${state.identity?.ownerId ?? 'signed-out'}`;
  const scopeReview =
    state.expandedScopeAvailable &&
    state.identity &&
    (state.scopeReview?.kind !== 'review' ||
      state.scopeReview.review.ownerId === state.identity.ownerId)
      ? state.scopeReview
      : null;
  const priorScope = useRef({ ownerKey, open: !!scopeReview });
  useEffect(() => {
    setReview(false);
    setSignOut(false);
    setDescriptions(null);
    scopeEntry.current = null;
    accountOffset.current = 0;
  }, [ownerKey]);
  useEffect(() => {
    const restore =
      priorScope.current.ownerKey === ownerKey && priorScope.current.open && !scopeReview;
    priorScope.current = { ownerKey, open: !!scopeReview };
    const entry = scopeEntry.current?.ownerKey === ownerKey ? scopeEntry.current : null;
    if (!scopeReview && !restore) return;
    const frame = requestAnimationFrame(() => {
      scroll.current?.scrollTo({ y: scopeReview ? 0 : (entry?.offset ?? 0), animated: false });
      if (restore) {
        const target = entry?.source === 'status' ? scopeReviewButton.current : scopeButton.current;
        focusTarget(target ?? scopeButton.current);
        scopeEntry.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ownerKey, scopeReview]);
  useEffect(() => {
    if (state.sync.kind !== 'review') return;
    const currentReview = state.sync;
    const workspaceKey = state.workspaceKey;
    let active = true;
    void buildAccountPurchaseDescriptions(currentReview, {
      readRecipe: getRecipe,
      sha256: nativeCommandPlatform.sha256,
    }).then((values) => {
      if (active) setDescriptions({ review: currentReview, workspaceKey, values });
    });
    return () => {
      active = false;
    };
  }, [state.sync, state.workspaceKey]);
  const busy = state.busy || state.checkingSession || availability.kind !== 'ready';
  const login = (provider: AccountProviderName) => {
    void runtime.signIn(provider, Platform.OS === 'web').then((url) => {
      if (url && Platform.OS === 'web') window.location.assign(url);
    });
  };
  return (
    <Page
      bottomInset
      scrollRef={scroll}
      onScroll={({ nativeEvent }) => {
        if (!scopeReview) accountOffset.current = nativeEvent.contentOffset.y;
      }}
    >
      <PageHeader back title="Account & sync" />
      {state.error && (
        <Notice title="Account needs attention" tone="error">
          {authCopy(state.error)}
        </Notice>
      )}
      {availability.kind === 'failed' && (
        <Notice title="Your local work needs recovery" tone="error">
          <AppText>
            CookMate has not reset your saved data. Account changes wait until local storage is
            ready.
          </AppText>
          {availability.error.retry !== 'never' && (
            <ActionButton label="Retry local storage" onPress={retryOpen} />
          )}
        </Notice>
      )}
      {(state.earlierDeletions ?? []).map((request, index) => (
        <Notice key={request.operationId} title={`Earlier account deletion · Request ${index + 1}`}>
          <AppText>
            {request.status === 'deleted'
              ? 'The service confirmed this earlier account was deleted. Your current sign-in and local cooking have not changed.'
              : request.status === 'pending'
                ? 'The service still has this earlier deletion request pending. Checking its status does not send another deletion or change your current account.'
                : 'A deletion request from an earlier account has not been confirmed. You can check it without switching accounts or removing local cooking data.'}
          </AppText>
          {request.status !== 'deleted' && (
            <ActionButton
              label={`Check earlier deletion request ${index + 1}`}
              variant="secondary"
              disabled={state.busy || state.checkingSession}
              onPress={() => {
                void runtime.checkEarlierDeletion(request.ownerId);
              }}
            />
          )}
        </Notice>
      ))}
      {state.deletion ? (
        <View style={{ gap: 16 }}>
          <AppText role="title">
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
              The request may have reached the account service. A signed-out session is not proof of
              deletion. Keep this record until the service can confirm the result.
            </Notice>
          )}
          {state.deletion.reason && (
            <Notice title="Account service response">{deletionCopy(state.deletion.reason)}</Notice>
          )}
          {(state.identity || state.deletion.kind === 'unconfirmed') &&
            state.deletion.kind !== 'deleted' && (
              <ActionButton
                label={
                  state.deletion.kind === 'review'
                    ? 'Delete my CookMate cloud account'
                    : 'Check deletion again'
                }
                busy={state.busy}
                disabled={
                  state.deletion.kind === 'unconfirmed' ? state.busy || state.checkingSession : busy
                }
                onPress={() => {
                  if (state.deletion?.kind === 'review') void runtime.confirmDeletion();
                  else if (state.deletion?.kind === 'unconfirmed') void runtime.checkDeletion();
                  else void runtime.reviewDeletion();
                }}
              />
            )}
          {state.deletion.kind === 'unconfirmed' && state.identity && (
            <ActionButton
              label="Retry the same deletion request"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                void runtime.confirmDeletion();
              }}
            />
          )}
          {state.deletion.reason === 'recent_sign_in_required' && state.identity?.provider && (
            <ActionButton
              label={`Continue with ${state.identity.provider === 'apple' ? 'Apple' : 'Google'} to renew sign-in`}
              variant="secondary"
              disabled={busy}
              onPress={() => login(state.identity!.provider!)}
            />
          )}
          {state.deletion.kind === 'unconfirmed' && !state.identity && (
            <View style={{ gap: 12 }}>
              <AppText>
                Sign in to the same CookMate account to retry this request. Signing in does not send
                it automatically.
              </AppText>
              {configured ? (
                <>
                  <ActionButton
                    label="Continue with Apple to recover this request"
                    variant="secondary"
                    disabled={busy || !providers.apple}
                    onPress={() => login('apple')}
                  />
                  <ActionButton
                    label="Continue with Google to recover this request"
                    variant="secondary"
                    disabled={busy || !providers.google}
                    onPress={() => login('google')}
                  />
                </>
              ) : (
                <AppText>
                  Account sign-in is not configured in this build. Keep this recovery record until
                  the account service is available.
                </AppText>
              )}
            </View>
          )}
          {state.deletion.kind !== 'working' && state.deletion.kind !== 'unconfirmed' && (
            <ActionButton
              label={state.deletion.kind === 'deleted' ? 'Continue with local cooking' : 'Cancel'}
              variant="secondary"
              onPress={runtime.cancelDeletion}
            />
          )}
        </View>
      ) : scopeReview ? (
        scopeReview.kind === 'review' ? (
          <AccountScopeReviewPanel
            review={scopeReview.review}
            busy={busy || state.sync.kind === 'working'}
            onApprove={(historyIncluded) => {
              // scopeReview is this render's immutable issued review, never the runtime's latest one.
              void runtime.approveSyncScope(scopeReview.review, historyIncluded);
            }}
            onCancel={runtime.cancelSyncScopeReview}
          />
        ) : scopeReview.kind === 'loading' ? (
          <View accessibilityLiveRegion="polite" style={{ gap: 12 }}>
            <AppText role="section" accessibilityRole="header">
              Checking sync choices…
            </AppText>
            <AppText>
              Please wait while CookMate checks or records your choices. This does not confirm a
              cloud backup.
            </AppText>
          </View>
        ) : (
          <View style={{ gap: 16 }}>
            <Notice title="Sync choices need attention" tone="error">
              {scopeFailureCopy(scopeReview.reason)}
            </Notice>
            {![
              'operation_pending',
              'settings_pending',
              'account_changed',
              'different_data_owner',
              'web_restart_required',
            ].includes(scopeReview.reason) && (
              <ActionButton
                label="Review sync choices again"
                disabled={busy}
                onPress={() => {
                  void runtime.reviewSyncScope();
                }}
              />
            )}
            <ActionButton
              label="Back to account"
              variant="secondary"
              disabled={busy}
              onPress={runtime.cancelSyncScopeReview}
            />
          </View>
        )
      ) : signOut && state.identity ? (
        <View style={{ gap: 16 }}>
          <AppText role="title">Keep CookMate data on this device?</AppText>
          <AppText>
            Keeping a local copy lets you continue cooking offline. Anyone using this unlocked app
            can access that copy. Another account gets a separate workspace.
          </AppText>
          <Notice title="Cloud and local data are separate">
            Signing out does not delete your cloud account. Removing this device’s account data
            deletes its local plans, conversations, drafts, notes and cooking history. Any changes
            not confirmed in your account may be lost. The original guest workspace is kept.
          </Notice>
          <ActionButton
            label="Keep on this device"
            disabled={busy}
            onPress={() => {
              void runtime.signOut(false).then(() => setSignOut(false));
            }}
          />
          <ActionButton
            label="Remove account data from this device"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              void runtime.signOut(true).then(() => setSignOut(false));
            }}
          />
          <ActionButton
            label="Cancel"
            variant="quiet"
            disabled={state.busy}
            onPress={() => setSignOut(false)}
          />
        </View>
      ) : review && state.sync.kind === 'review' ? (
        <AccountMergePanel
          review={state.sync}
          {...(descriptions?.review === state.sync &&
          descriptions.workspaceKey === state.workspaceKey
            ? { purchaseDescriptions: descriptions.values }
            : {})}
          onSelect={runtime.select}
          onResolve={runtime.resolve}
          onConfirm={runtime.confirm}
          onCancel={() => {
            runtime.cancelReview();
            setReview(false);
          }}
        />
      ) : state.identity ? (
        <SignedInAccountPanel
          key={ownerKey}
          identity={state.identity}
          syncState={state.sync}
          busy={busy}
          expandedScopeAvailable={state.expandedScopeAvailable === true}
          scopeButtonRef={scopeButton}
          scopeReviewButtonRef={scopeReviewButton}
          onReviewScope={(source) => {
            scopeEntry.current = { ownerKey, source, offset: accountOffset.current };
            void runtime.reviewSyncScope();
          }}
          onSync={runtime.syncNow}
          onReview={() => setReview(true)}
          onSignOut={() => setSignOut(true)}
          onDelete={() => {
            void runtime.reviewDeletion();
          }}
        />
      ) : (
        <>
          {state.workspace.kind === 'account' && (
            <Notice title="A local account copy is open">
              You are signed out. This account’s saved cooking remains available on this device.
              Signing into a different account will open a separate workspace.
            </Notice>
          )}
          <GuestAccountPanel
            key={ownerKey}
            googleAvailable={providers.google}
            appleAvailable={providers.apple}
            busy={state.busy || state.checkingSession}
            storageAvailable={availability.kind === 'ready'}
            expandedScopeAvailable={state.expandedScopeAvailable === true}
            availabilityNotice={
              !configured
                ? 'Sign-in and cloud sync are not configured in this build. Your current local workspace stays available; local saving and backups require available device storage.'
                : state.checkingSession
                  ? 'Checking the saved session. Your local cooking remains available.'
                  : null
            }
            onGoogle={() => login('google')}
            onApple={() => login('apple')}
            onContinueGuest={() => router.replace('/')}
            onLocalBackup={() =>
              router.navigate({ pathname: '/settings', params: { section: 'backup' } })
            }
          />
        </>
      )}
    </Page>
  );
}

function scopeFailureCopy(reason: string): string {
  switch (reason) {
    case 'local_changed':
      return 'Your saved cooking changed after this review. Review the current counts and choose again.';
    case 'scope_changed':
    case 'scope_review_required':
      return 'These sync choices need a fresh review. Nothing in this message confirms a cloud save.';
    case 'operation_pending':
      return 'An earlier sync must finish or recover before its data choices can change. Return to your account to check that sync first.';
    case 'settings_pending':
      return 'Settings from an earlier sync still need to be applied. Return to your account to finish that sync, then review your choices again.';
    case 'account_changed':
    case 'different_data_owner':
      return 'The signed-in account changed. Return to the current account before reviewing its sync choices.';
    case 'web_restart_required':
      return 'Local storage needs the preview to reload before these choices can be checked. Your saved work has not been reset.';
    case 'too_large':
      return 'This data is larger than the supported sync size. Your local cooking remains available; these choices have not been confirmed.';
    default:
      return 'CookMate could not confirm these choices. Your local work has been kept. Try a fresh review when storage is ready.';
  }
}

function authCopy(reason: string) {
  switch (reason) {
    case 'cancelled':
      return 'Sign-in was cancelled. Your local cooking is unchanged.';
    case 'network':
      return 'CookMate could not reach the sign-in service. Your local cooking is still available.';
    case 'session_expired':
      return 'Your sign-in needs to be renewed. Your local cooking has been kept.';
    case 'unsupported':
      return 'This sign-in method is unavailable in this app environment.';
    case 'not_configured':
      return 'Account sign-in is not configured in this build.';
    case 'account_changed':
      return 'The account changed during this action. Review the current account before trying again.';
    case 'storage':
      return 'Account storage could not be confirmed. CookMate has not reset or replaced your saved work.';
    default:
      return 'The sign-in provider could not complete this request. Try again when available.';
  }
}
function deletionCopy(reason: string) {
  if (reason === 'deletion_pending')
    return 'The service has received this deletion request but has not confirmed completion. You can retry the same request after signing in again.';
  if (reason === 'deletion_capability_limit')
    return 'This deletion already has the maximum number of recovery records. Keep the existing record; retrying with new records will not resolve this limit.';
  if (reason === 'recent_sign_in_required')
    return 'Sign in again before deleting the cloud account. No successful deletion has been confirmed.';
  if (reason === 'needs_review')
    return 'Account data changed. Review the current cloud account before requesting deletion again.';
  return 'CookMate could not confirm the deletion result. Your local copy remains available.';
}
