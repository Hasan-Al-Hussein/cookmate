import type {
  AccountConflictValue,
  AccountCollection,
  AccountMergeConflict,
  AccountSnapshot,
  AccountSyncState,
} from '@cookmate/account-sync';
import { getRecipe } from '@cookmate/catalogue';
import { useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { BrandMark } from '../../components/BrandMark';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { preferenceLabels } from '../assistant/assistantCopy';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import type { AccountIdentity } from './authTypes';
import { ProviderSignInButton } from './ProviderSignInButton';
import type {
  AccountPurchaseDescription,
  AccountPurchaseDescriptions,
} from './accountPurchaseDescriptions';
export type {
  AccountPurchaseDescription,
  AccountPurchaseDescriptions,
} from './accountPurchaseDescriptions';

export interface GuestAccountPanelProps {
  googleAvailable: boolean;
  appleAvailable: boolean;
  availabilityNotice: string | null;
  busy: boolean;
  storageAvailable?: boolean;
  expandedScopeAvailable?: boolean;
  onGoogle(): void;
  onApple(): void;
  onContinueGuest(): void;
  onLocalBackup(): void;
}

/** Panels own presentation only. The account screen owns scrolling, focus and runtime actions. */
export function GuestAccountPanel(props: GuestAccountPanelProps) {
  const styles = useThemedStyles(createStyles);
  const [details, setDetails] = useState(false);
  return (
    <View style={styles.panel}>
      <View style={styles.brand}>
        <BrandMark />
      </View>
      <View style={styles.copy}>
        <AppText role="label" color="brand">
          GUEST
        </AppText>
        <AppText role="title" accessibilityRole="header">
          Keep your cooking with you
        </AppText>
        <AppText>
          {props.storageAvailable === false
            ? 'Saved cooking could not be loaded. You can still browse recipes while local storage needs recovery.'
            : 'Your cooking is saved on this device. Browse, save favourites and plan meals without an account.'}
        </AppText>
      </View>
      {props.availabilityNotice && (
        <Notice title="Account availability">{props.availabilityNotice}</Notice>
      )}
      {props.busy && (
        <AppText accessibilityLiveRegion="polite">Connecting to your account…</AppText>
      )}
      <View style={styles.copy}>
        <ProviderSignInButton
          provider="apple"
          label="Continue with Apple"
          disabled={props.busy || !props.appleAvailable || props.storageAvailable === false}
          onPress={props.onApple}
        />
        {!props.appleAvailable && (
          <AppText role="support" color="inkSecondary">
            Apple sign-in is unavailable in this app environment.
          </AppText>
        )}
        <ProviderSignInButton
          provider="google"
          label="Continue with Google"
          disabled={props.busy || !props.googleAvailable || props.storageAvailable === false}
          onPress={props.onGoogle}
        />
        {!props.googleAvailable && (
          <AppText role="support" color="inkSecondary">
            Google sign-in is unavailable in this app environment.
          </AppText>
        )}
        <ActionButton
          label="Back to CookMate"
          disabled={props.busy}
          onPress={props.onContinueGuest}
        />
      </View>
      <View style={styles.section}>
        <AppText role="section" accessibilityRole="header">
          Data on this device
        </AppText>
        <AppText role="support" color="inkSecondary">
          Device loss or cleared app data can remove your local copy. A private backup is separate
          from account sync.
        </AppText>
        <ActionButton
          label="Local backup"
          variant="secondary"
          disabled={props.busy || props.storageAvailable === false}
          onPress={props.onLocalBackup}
        />
        <AppText role="support" color="inkSecondary">
          {props.expandedScopeAvailable
            ? 'Signing in never grants AI sharing consent. Personal cooking data needs a separate sync review; cooking history is optional.'
            : 'Signing in never grants AI sharing consent. Your private conversations and notes stay separate from sync.'}
        </AppText>
        <ActionButton
          label={details ? 'Hide account data details' : 'What would an account sync?'}
          variant="quiet"
          accessibilityState={{ expanded: details }}
          disabled={props.busy}
          onPress={() => setDetails((value) => !value)}
        />
        <AnimatedDisclosure expanded={details} style={styles.copy}>
          <AppText role="support">
            Account sync supports favourites, dated meals, shopping selections and compatible
            purchase checks, saved cooking preferences, profile name and app appearance preferences.
            Your existing guest data is kept for review before migration. Only confirmed account
            saves can be restored on another device.
          </AppText>
          {props.expandedScopeAvailable && (
            <AppText role="support">
              A separate review can include private recipe notes, collections and manual shopping
              items. Cooking history starts off unless you choose to include it. This shares only
              with your own account, not a household.
            </AppText>
          )}
          {props.expandedScopeAvailable ? (
            <AppText role="support" color="inkSecondary">
              Conversations, drafts, credentials and AI sharing consent stay outside account sync.
            </AppText>
          ) : (
            <PrivacyCopy />
          )}
        </AnimatedDisclosure>
      </View>
    </View>
  );
}

export interface SignedInAccountPanelProps {
  identity: AccountIdentity;
  syncState: AccountSyncState;
  busy?: boolean;
  expandedScopeAvailable?: boolean;
  scopeButtonRef?: Ref<View>;
  scopeReviewButtonRef?: Ref<View>;
  onReviewScope?(entry: 'status' | 'settings'): void;
  onSync(): void;
  onReview(): void;
  onSignOut(): void;
  onDelete(): void;
}

export function SignedInAccountPanel({
  identity,
  syncState,
  busy: accountBusy = false,
  expandedScopeAvailable = false,
  scopeButtonRef,
  scopeReviewButtonRef,
  onReviewScope,
  onSync,
  onReview,
  onSignOut,
  onDelete,
}: SignedInAccountPanelProps) {
  const styles = useThemedStyles(createStyles);
  const name = identity.displayName?.trim() || 'Your CookMate account';
  const initials = identity.displayName
    ?.trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0])
    .join('');
  const syncing = syncState.kind === 'working';
  const busy = accountBusy || syncing;
  const needsScope =
    syncState.kind === 'failed' &&
    ['scope_review_required', 'scope_changed'].includes(syncState.reason);
  const scopeAction =
    needsScope && !syncState.pending && expandedScopeAvailable ? onReviewScope : undefined;
  const statusAction = scopeAction
    ? { label: 'Review sync choices', onPress: () => scopeAction('status') }
    : syncState.kind === 'review'
      ? { label: 'Review differences', onPress: onReview }
      : { label: syncing ? 'Syncing…' : 'Sync now', onPress: onSync };
  const status = syncPresentation(syncState);
  return (
    <View style={styles.panel}>
      <View style={styles.identity}>
        {initials ? (
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.initials}
          >
            <AppText role="section" color="brand">
              {initials.toLocaleUpperCase()}
            </AppText>
          </View>
        ) : null}
        <View style={styles.identityCopy}>
          <AppText role="title" accessibilityRole="header">
            {name}
          </AppText>
          <AppText color="inkSecondary">{identity.email || 'Email not supplied'}</AppText>
          {identity.provider && (
            <AppText role="support" color="inkSecondary">
              {identity.provider === 'apple' ? 'Connected with Apple' : 'Connected with Google'}
            </AppText>
          )}
        </View>
      </View>
      <View
        accessibilityLiveRegion="polite"
        style={[styles.status, syncState.kind === 'synced' && styles.synced]}
      >
        <AppText
          role="bodyStrong"
          color={
            syncState.kind === 'synced' ? 'success' : syncState.kind === 'failed' ? 'error' : 'ink'
          }
        >
          {status.title}
        </AppText>
        <AppText role="support">{status.detail}</AppText>
      </View>
      {/* Keep this focus destination mounted while the coordinator changes its action. */}
      <ActionButton
        ref={scopeReviewButtonRef}
        label={statusAction.label}
        busy={syncing}
        disabled={busy}
        onPress={statusAction.onPress}
      />
      <View style={styles.section}>
        <AppText role="section" accessibilityRole="header">
          Account & sync
        </AppText>
        <AppText>
          Sync includes favourites, dated meal plans, supported shopping state, saved preferences,
          display name and app appearance preferences.
        </AppText>
        <AppText role="support" color="inkSecondary">
          Only confirmed account saves can be restored on another device. Shopping checks are kept
          only when their ingredient demand still matches.
        </AppText>
        {expandedScopeAvailable ? (
          <>
            <AppText role="support" color="inkSecondary">
              Your reviewed sync choices can also include personal notes, collections and manual
              items. Cooking history is optional. These stay private to your account; household
              sharing and AI consent are separate.
            </AppText>
            <AppText role="support" color="inkSecondary">
              Assistant conversations, drafts and credentials are excluded from cooking-data sync.
            </AppText>
            {onReviewScope && (
              <ActionButton
                ref={scopeButtonRef}
                label="Sync choices"
                variant="secondary"
                disabled={busy}
                onPress={() => onReviewScope('settings')}
              />
            )}
          </>
        ) : (
          <PrivacyCopy />
        )}
      </View>
      <View style={styles.section}>
        <AppText role="section" accessibilityRole="header">
          Data on this device
        </AppText>
        <AppText role="support" color="inkSecondary">
          Signing out, deleting your cloud account and removing device data are separate choices.
          Review what stays on this device before confirming either account action.
        </AppText>
        <ActionButton label="Sign out" variant="secondary" disabled={busy} onPress={onSignOut} />
        <ActionButton label="Delete account" variant="quiet" disabled={busy} onPress={onDelete} />
      </View>
    </View>
  );
}

function PrivacyCopy({ expanded = false }: { expanded?: boolean } = {}) {
  return (
    <AppText role="support" color="inkSecondary">
      {expanded
        ? 'Private notes, collections and manual items participate in this reviewed scope. Cooking history follows your inclusion choice. Assistant conversations and drafts stay separate. '
        : 'Assistant conversations, drafts, personal notes and cooking history stay separate from account sync. '}
      Signing in does not grant AI sharing consent. API keys, laptop pairing credentials and secure
      tokens are not included in cooking-data sync.
    </AppText>
  );
}

function syncPresentation(state: AccountSyncState): { title: string; detail: string } {
  switch (state.kind) {
    case 'local':
      return {
        title: 'Saved on this device',
        detail: 'The latest local changes have not yet been confirmed in your account.',
      };
    case 'working':
      return {
        title: 'Sync in progress',
        detail:
          'CookMate is checking, saving or applying supported changes. The overall sync is still in progress.',
      };
    case 'review':
      return {
        title: 'Needs review',
        detail: state.recovering
          ? 'Review local changes alongside the pending sync result before continuing. Leaving this review does not undo a completed server save.'
          : 'Choose how this device and your account should be combined before continuing.',
      };
    case 'synced': {
      const date = state.at ? new Date(state.at) : null;
      const at =
        date && Number.isFinite(date.getTime())
          ? date.toLocaleString('en', {
              timeZone: 'UTC',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              timeZoneName: 'short',
            })
          : null;
      return {
        title: 'Synced',
        detail: at
          ? `Account data last saved: ${at}`
          : 'Your account matches this device. An account-save time was not supplied.',
      };
    }
    case 'failed':
      return {
        title: 'Couldn’t sync',
        detail: `${syncFailureCopy(state.reason)} ${state.pending ? 'A sync operation still needs reconciliation; do not assume it was cancelled.' : 'The latest account result is not confirmed.'}`,
      };
  }
}

function syncFailureCopy(reason: string): string {
  switch (reason) {
    case 'scope_review_required':
      return 'Review which personal cooking data may join your private account before syncing.';
    case 'scope_changed':
      return 'Your sync choices changed. Review the current choices before continuing.';
    case 'history_content_mismatch':
      return 'CookMate could not verify the recipe content linked to this cooking history. Your local work has been kept.';
    case 'snapshot_upgrade_required':
      return 'This account uses a newer sync format. Update CookMate before syncing again.';
    case 'sign_in_required':
    case 'recent_sign_in_required':
      return 'Sign in again to continue account sync.';
    case 'account_changed':
    case 'different_data_owner':
      return 'The account changed. Return to the account screen before continuing.';
    case 'sync_rate_limited':
      return 'The account service has asked CookMate to wait. Try syncing again later.';
    case 'needs_review':
    case 'initial_review_required':
    case 'local_changed':
    case 'journal_changed':
    case 'stale_server_revision':
      return 'Cooking data changed during sync. Sync again to review the current differences.';
    case 'store_busy':
    case 'active_actions':
    case 'recovery_required':
      return 'Finish or review the current cooking action before syncing again.';
    case 'catalogue_mismatch':
    case 'unknown_recipe':
      return 'The account and this app need a compatible recipe catalogue before data can be combined.';
    case 'deletion_pending':
    case 'deletion_not_confirmed':
      return 'Account deletion still needs confirmation. Review the account’s deletion status before syncing.';
    case 'stored_data_invalid':
    case 'stored_data_needs_review':
    case 'invalid_response':
      return 'CookMate could not verify the saved data. It has not reset your workspace.';
    case 'cancelled':
      return 'Waiting for sync stopped. Any completed server save still needs to be checked.';
    default:
      return 'The sync result could not be confirmed. Check your connection and try again when available.';
  }
}

export interface AccountMergePanelProps {
  review: Extract<AccountSyncState, { kind: 'review' }>;
  purchaseDescriptions?: AccountPurchaseDescriptions;
  onSelect(choice: 'merge' | 'account'): void;
  onResolve(conflictId: string, choice: 'local' | 'account'): void;
  onConfirm(): void;
  onCancel(): void;
}

export function AccountMergePanel({
  review,
  purchaseDescriptions,
  onSelect,
  onResolve,
  onConfirm,
  onCancel,
}: AccountMergePanelProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.panel}>
      <View style={styles.copy}>
        <AppText role="label" color="brand">
          ACCOUNT & BACKUP
        </AppText>
        <AppText role="title" accessibilityRole="header">
          {review.recovering
            ? 'Review changes during sync'
            : review.initial
              ? 'Keep your cooking with you'
              : 'Review sync differences'}
        </AppText>
        <AppText>
          {review.recovering
            ? 'Cooking data changed while a sync operation was in progress. Compare this device with the pending account version. A server save may already have completed.'
            : 'Compare the cooking data saved on this device with your account, then choose what to keep.'}
        </AppText>
      </View>
      <View style={styles.comparison}>
        <SnapshotSummary title="This device" snapshot={review.local} />
        {review.account ? (
          <SnapshotSummary
            title={review.recovering ? 'Pending account version' : 'Account'}
            snapshot={review.account}
          />
        ) : (
          <Notice title="No account backup yet">
            Your account has no cooking-data snapshot. Confirm to add this device’s supported data.
          </Notice>
        )}
      </View>
      {!review.recovering && (
        <View style={styles.copy}>
          <ActionButton
            label="Add this device’s data to my account"
            variant={review.choice === 'merge' ? 'primary' : 'secondary'}
            accessibilityRole="radio"
            accessibilityState={{ checked: review.choice === 'merge' }}
            onPress={() => {
              if (review.choice !== 'merge') onSelect('merge');
            }}
          />
          <ActionButton
            label={
              review.local.schemaVersion === 2
                ? 'Prefer account versions'
                : 'Use account data instead'
            }
            variant={review.choice === 'account' ? 'primary' : 'secondary'}
            accessibilityRole="radio"
            accessibilityState={{ checked: review.choice === 'account' }}
            disabled={!review.account}
            onPress={() => {
              if (review.choice !== 'account') onSelect('account');
            }}
          />
          {review.choice === 'account' && (
            <Notice title="Replace supported data on this device" tone="caution">
              This choice replaces this device’s favourites, meal plan, shopping state, saved
              preferences, profile and app preferences with the account version. Device-only changes
              in those collections will not be added to the account.
            </Notice>
          )}
          {review.choice === 'account' && review.local.schemaVersion === 2 && (
            <Notice title="Personal data in this choice" tone="caution">
              <AppText>
                Account values take priority for matching personal records. Device-only notes,
                collections, memberships and manual items are kept and included in this sync.
                Removed items that differ need a separate choice.
              </AppText>
              <AppText role="support">
                {review.local.cookingHistory
                  ? 'Cooking history combines events and known removals from both copies.'
                  : 'Cooking history on this device stays unchanged. Existing account history is kept.'}
              </AppText>
            </Notice>
          )}
        </View>
      )}
      {review.initial && (
        <AppText role="support" color="inkSecondary">
          Your first confirmed account import keeps a local recovery copy of its guest cooking data
          and settings. That copy does not include later edits and is not a separate cloud backup.
        </AppText>
      )}
      <View style={styles.section}>
        <AppText role="section" accessibilityRole="header">
          {review.conflicts.length
            ? `${review.conflicts.length} ${review.conflicts.length === 1 ? 'difference needs' : 'differences need'} your choice`
            : 'Ready for your review'}
        </AppText>
        {review.conflicts.map((conflict, index) => (
          <ConflictComparison
            key={conflict.id}
            conflict={conflict}
            position={index + 1}
            descriptions={purchaseDescriptions?.[conflict.id]}
            localCollections={
              review.local.schemaVersion === 2 ? review.local.personal.collections : []
            }
            accountCollections={
              review.account?.schemaVersion === 2 ? review.account.personal.collections : []
            }
            onResolve={onResolve}
          />
        ))}
        {!review.conflicts.length && (
          <AppText>
            {review.canConfirm
              ? 'No unresolved differences remain. Confirm to continue with the selected data choice.'
              : 'This comparison cannot be confirmed yet. Return to the account screen and check the current sync state.'}
          </AppText>
        )}
      </View>
      <AppText role="support" color="inkSecondary">
        Shopping purchases are checked against the resulting ingredients. A changed ingredient
        demand may need to be checked again.
      </AppText>
      <PrivacyCopy expanded={review.local.schemaVersion === 2} />
      <ActionButton
        label={
          review.recovering
            ? 'Confirm reviewed changes'
            : review.choice === 'account'
              ? 'Confirm use of account data'
              : 'Confirm merge & sync'
        }
        disabled={!review.canConfirm}
        onPress={onConfirm}
      />
      <ActionButton
        label={review.recovering ? 'Return to account' : 'Not now'}
        variant="quiet"
        onPress={onCancel}
      />
      {review.recovering && (
        <AppText role="support" color="inkSecondary">
          Returning to your account leaves this review. It does not cancel or undo the pending sync
          operation.
        </AppText>
      )}
    </View>
  );
}

function SnapshotSummary({ title, snapshot }: { title: string; snapshot: AccountSnapshot }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.summary}>
      <AppText role="bodyStrong">{title}</AppText>
      <AppText role="support">
        {snapshot.favourites.length} favourites · {snapshot.plan.length} planned meals
      </AppText>
      <AppText role="support">
        {snapshot.shopping.selectedOccurrenceIds.length} meals selected for shopping ·{' '}
        {snapshot.preferences.length} saved preferences
      </AppText>
      {snapshot.schemaVersion === 2 && (
        <>
          <AppText role="support">
            {snapshot.personal.notes.filter((item) => !item.deleted).length} private notes ·{' '}
            {snapshot.personal.collections.filter((item) => !item.deleted).length} collections ·{' '}
            {snapshot.personal.memberships.filter((item) => item.present).length} memberships ·{' '}
            {snapshot.personal.manualItems.filter((item) => !item.deleted).length} manual items
          </AppText>
          <AppText role="support" color="inkSecondary">
            {snapshot.cookingHistory
              ? `${snapshot.cookingHistory.entries.length} cooking-history entries included in this copy`
              : 'Cooking history excluded from this copy'}
          </AppText>
        </>
      )}
      <AppText
        role="support"
        color="inkSecondary"
      >{`Theme: ${settingValue('appPreferences/theme', snapshot.appPreferences.theme)} · Motion: ${settingValue('appPreferences/motion', snapshot.appPreferences.motion)} · Language: ${settingValue('appPreferences/locale', snapshot.appPreferences.locale)}`}</AppText>
      <AppText
        role="support"
        color="inkSecondary"
      >{`Display name: ${snapshot.profile.displayName ?? 'Not supplied'}`}</AppText>
    </View>
  );
}

function conflictTitle(conflict: AccountMergeConflict) {
  switch (conflict.kind) {
    case 'occurrence_edit':
      return 'Planned meal changed';
    case 'slot_collision':
      return 'Meals use the same date and slot';
    case 'preference_edit':
    case 'preference_collision':
      return 'Saved preference changed';
    case 'purchase_state':
      return 'Shopping purchase state';
    case 'note_edit':
      return 'Private recipe note changed';
    case 'collection_edit':
      return 'Collection changed';
    case 'collection_subtree':
      return 'Collection and its recipes changed';
    case 'membership_edit':
      return 'Collection membership changed';
    case 'manual_item_edit':
      return 'Manual shopping item changed';
    case 'delete_edit':
      return conflict.path.startsWith('plan/')
        ? 'Planned meal removed or changed'
        : conflict.path.startsWith('preferences/')
          ? 'Saved preference removed or changed'
          : conflict.path.startsWith('personal/notes/')
            ? 'Private recipe note removed or changed'
            : conflict.path.startsWith('personal/collections/')
              ? 'Collection removed or changed'
              : conflict.path.startsWith('personal/memberships/')
                ? 'Collection membership removed or changed'
                : conflict.path.startsWith('personal/manualItems/')
                  ? 'Manual shopping item removed or changed'
                  : 'Shopping mark removed or changed';
    case 'setting':
      return settingLabels[conflict.path] ?? 'Account setting';
  }
}
const settingLabels: Readonly<Record<string, string>> = {
  'appPreferences/theme': 'Appearance',
  'appPreferences/motion': 'Motion',
  'appPreferences/locale': 'Language',
  'profile/displayName': 'Display name',
};

function settingValue(path: string, value: string): string {
  if (path === 'profile/displayName') return value;
  const names: Readonly<Record<string, string>> = {
    system: 'Follow system',
    light: 'Light',
    dark: 'Dark',
    reduced: 'Reduced',
    en: 'English',
    ar: 'Arabic',
  };
  return names[value] ?? value;
}

function ConflictComparison({
  conflict,
  position,
  descriptions,
  localCollections,
  accountCollections,
  onResolve,
}: {
  conflict: AccountMergeConflict;
  position: number;
  descriptions: AccountPurchaseDescriptions[string] | undefined;
  localCollections: readonly AccountCollection[];
  accountCollections: readonly AccountCollection[];
  onResolve: AccountMergePanelProps['onResolve'];
}) {
  const styles = useThemedStyles(createStyles);
  const purchase =
    conflict.kind === 'purchase_state' || conflict.path.startsWith('shopping/purchaseMarks/');
  const identified =
    !purchase ||
    ((conflict.local === null || !!descriptions?.local?.name.trim()) &&
      (conflict.account === null || !!descriptions?.account?.name.trim()));
  return (
    <View style={styles.conflict}>
      <AppText
        role="bodyStrong"
        accessibilityRole="header"
      >{`${position}. ${conflictTitle(conflict)}`}</AppText>
      <View style={styles.comparison}>
        <View style={styles.version}>
          <AppText role="label" color="brand">
            This device
          </AppText>
          <ConflictValue
            value={conflict.local}
            path={conflict.path}
            description={descriptions?.local}
            collections={localCollections}
          />
        </View>
        <View style={styles.version}>
          <AppText role="label" color="brand">
            Account
          </AppText>
          <ConflictValue
            value={conflict.account}
            path={conflict.path}
            description={descriptions?.account}
            collections={accountCollections}
          />
        </View>
      </View>
      {!identified && (
        <Notice title="Shopping item details unavailable" tone="caution">
          CookMate cannot identify this ingredient for review yet. These choices are unavailable
          until its validated item details are loaded.
        </Notice>
      )}
      <ActionButton
        label="Keep this device"
        accessibilityLabel={`Keep this device for difference ${position}`}
        variant="secondary"
        disabled={!identified}
        onPress={() => onResolve(conflict.id, 'local')}
      />
      <ActionButton
        label="Keep account version"
        accessibilityLabel={`Keep account version for difference ${position}`}
        variant="secondary"
        disabled={!identified}
        onPress={() => onResolve(conflict.id, 'account')}
      />
    </View>
  );
}

function ConflictValue({
  value,
  path,
  description,
  collections = [],
}: {
  value: AccountConflictValue;
  path: string;
  description: AccountPurchaseDescription | undefined;
  collections?: readonly AccountCollection[];
}) {
  const styles = useThemedStyles(createStyles);
  if (value === null || (Array.isArray(value) && value.length === 0))
    return (
      <AppText>
        {path.startsWith('plan/')
          ? 'No planned meal'
          : path.startsWith('preferences/')
            ? 'No saved preference'
            : path.startsWith('shopping/')
              ? 'No purchase mark'
              : 'Not supplied'}
      </AppText>
    );
  if (typeof value === 'string') return <AppText>{settingValue(path, value)}</AppText>;
  if (typeof value === 'boolean') return <AppText>{value ? 'Yes' : 'No'}</AppText>;
  if (Array.isArray(value))
    return (
      <View style={styles.copy}>
        {value.map((item, index) => (
          <ConflictValue
            key={index}
            value={item}
            path={path}
            description={undefined}
            collections={collections}
          />
        ))}
      </View>
    );
  if ('collection' in value)
    return (
      <View style={styles.copy}>
        <ConflictValue value={value.collection} path={path} description={undefined} />
        {value.memberships.map((member) => (
          <ConflictValue
            key={member.recipeId}
            value={member}
            path={path}
            description={undefined}
            collections={[value.collection]}
          />
        ))}
      </View>
    );
  if ('noteId' in value)
    return (
      <View style={styles.copy}>
        <AppText role="bodyStrong">
          {getRecipe(value.recipeId)?.title ?? `Unavailable recipe (${value.recipeId})`}
        </AppText>
        <AppText>{value.deleted ? 'Private note removed' : value.text}</AppText>
      </View>
    );
  if ('present' in value)
    return (
      <View style={styles.copy}>
        <AppText role="bodyStrong">
          {collections.find((collection) => collection.collectionId === value.collectionId)?.name ??
            'Removed or unavailable collection'}
        </AppText>
        <AppText>
          {getRecipe(value.recipeId)?.title ?? `Unavailable recipe (${value.recipeId})`}
        </AppText>
        <AppText role="support">
          {value.present ? 'In this collection' : 'Removed from this collection'}
        </AppText>
      </View>
    );
  if ('collectionId' in value)
    return <AppText>{value.deleted ? 'Collection removed' : value.name}</AppText>;
  if ('itemId' in value)
    return (
      <View style={styles.copy}>
        <AppText role="bodyStrong">{value.deleted ? 'Manual item removed' : value.name}</AppText>
        {!value.deleted && (
          <>
            <AppText>
              {[value.amountText, value.unitText]
                .filter((part) => part !== null && part !== '')
                .join(' ') || 'Amount not supplied'}
            </AppText>
            <AppText role="support">{value.purchased ? 'Purchased' : 'Not purchased'}</AppText>
          </>
        )}
      </View>
    );
  if ('placement' in value)
    return (
      <View style={styles.copy}>
        <AppText role="bodyStrong">
          {getRecipe(value.recipeId)?.title ?? `Unavailable recipe (${value.recipeId})`}
        </AppText>
        <AppText role="support">{`${formatPlanDate(value.placement.actualDate)} · ${mealLabel(value.placement.mealKey)}`}</AppText>
      </View>
    );
  if ('preferenceId' in value)
    return (
      <View style={styles.copy}>
        <AppText role="support" color="inkSecondary">
          {preferenceLabels[value.type]}
        </AppText>
        <AppText>{value.value}</AppText>
      </View>
    );
  return (
    <View style={styles.copy}>
      <AppText role="bodyStrong">{description?.name || 'Item name unavailable'}</AppText>
      {description?.quantity && <AppText role="support">{description.quantity}</AppText>}
      <AppText>{value.purchased ? 'Purchased' : 'Not purchased'}</AppText>
      <AppText role="support">
        {value.changed ? 'Ingredients changed since review' : 'No ingredient change marked'}
      </AppText>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    panel: { gap: t.space.lg, minWidth: 0 },
    copy: { gap: t.space.xs, minWidth: 0 },
    brand: {
      width: t.control.minimumTarget,
      height: t.control.minimumTarget,
      borderRadius: t.radius.small,
      backgroundColor: t.color.brand,
      alignItems: 'center',
      justifyContent: 'center',
    },
    identity: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md, alignItems: 'center' },
    identityCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: t.space.xxs },
    initials: {
      minWidth: t.control.minimumTarget,
      minHeight: t.control.minimumTarget,
      padding: t.space.sm,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.selection,
      alignItems: 'center',
      justifyContent: 'center',
    },
    section: {
      gap: t.space.sm,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      paddingTop: t.space.lg,
    },
    status: {
      gap: t.space.xs,
      padding: t.space.md,
      borderRadius: t.radius.small,
      backgroundColor: t.color.surfaceMuted,
    },
    synced: { backgroundColor: t.color.successSurface },
    comparison: { gap: t.space.sm },
    summary: {
      gap: t.space.xs,
      padding: t.space.md,
      backgroundColor: t.color.surfaceMuted,
      borderRadius: t.radius.small,
    },
    conflict: {
      gap: t.space.sm,
      paddingVertical: t.space.md,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    version: {
      gap: t.space.xs,
      paddingLeft: t.space.md,
      borderLeftWidth: 2,
      borderLeftColor: t.color.divider,
    },
  });
