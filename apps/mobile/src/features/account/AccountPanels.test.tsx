import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type {
  AccountMergeConflict,
  AccountPlanOccurrence,
  AccountSnapshot,
  AccountSyncState,
} from '@cookmate/account-sync';
import { identity } from '@cookmate/catalogue';
import { createRef } from 'react';
import type { View } from 'react-native';
import { ActionButton } from '../../components/Controls';
import { AccountMergePanel, GuestAccountPanel, SignedInAccountPanel } from './AccountPanels';
import type {
  AccountMergePanelProps,
  GuestAccountPanelProps,
  SignedInAccountPanelProps,
} from './AccountPanels';

jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
afterEach(cleanup);

test('expanded account entry describes reviewed personal data while default retains core-only truth', () => {
  const input = guestProps();
  const view = render(<GuestAccountPanel {...input} />);
  expect(screen.getByText(/private conversations and notes stay separate from sync/)).toBeTruthy();
  view.rerender(<GuestAccountPanel {...input} expandedScopeAvailable />);
  expect(screen.queryByText(/private conversations and notes stay separate from sync/)).toBeNull();
  expect(screen.getByText(/Personal cooking data needs a separate sync review/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'What would an account sync?' }));
  expect(
    screen.getByText(/Cooking history starts off unless you choose to include it/),
  ).toBeTruthy();
});

test.each(['scope_review_required', 'scope_changed'])(
  'scope failure %s offers its review action and preserves current sync uncertainty',
  (reason) => {
    const input = signedProps({ kind: 'failed', reason, pending: false }),
      onReviewScope = jest.fn();
    render(
      <SignedInAccountPanel {...input} expandedScopeAvailable onReviewScope={onReviewScope} />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Review sync choices' }));
    expect(onReviewScope).toHaveBeenCalledTimes(1);
    expect(input.onSync).not.toHaveBeenCalled();
    expect(screen.queryByText('Synced')).toBeNull();
  },
);

test('expanded account actions obey runtime busy state as well as sync progress', () => {
  const input = signedProps({ kind: 'local' }),
    onReviewScope = jest.fn();
  render(
    <SignedInAccountPanel {...input} busy expandedScopeAvailable onReviewScope={onReviewScope} />,
  );
  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeDisabled();
    fireEvent.press(button);
  }
  expect(onReviewScope).not.toHaveBeenCalled();
  expect(input.onSync).not.toHaveBeenCalled();
});

test('the status action retains its focus position while changing label and authority', () => {
  const input = signedProps({ kind: 'local' });
  const scopeReviewButtonRef = createRef<View>();
  const onReviewScope = jest.fn();
  const props = { ...input, scopeReviewButtonRef, onReviewScope, expandedScopeAvailable: true };
  const view = render(<SignedInAccountPanel {...props} />);
  const statusButton = screen.getByRole('button', { name: 'Sync now' });
  fireEvent.press(statusButton);
  expect(input.onSync).toHaveBeenCalledTimes(1);
  for (const [syncState, label] of [
    [{ kind: 'failed', reason: 'scope_review_required', pending: false }, 'Review sync choices'],
    [mergeProps().review, 'Review differences'],
    [{ kind: 'local' }, 'Sync now'],
  ] as const) {
    view.rerender(<SignedInAccountPanel {...props} syncState={syncState} />);
    const currentButton = screen.getByRole('button', { name: label });
    expect(currentButton === statusButton).toBe(true);
    const control = screen
      .UNSAFE_getAllByType(ActionButton)
      .find((button) => button.props.label === label)!;
    expect(control.props.ref === scopeReviewButtonRef).toBe(true);
    fireEvent.press(currentButton);
  }
  expect(onReviewScope).toHaveBeenCalledTimes(1);
  expect(onReviewScope).toHaveBeenCalledWith('status');
  expect(input.onReview).toHaveBeenCalledTimes(1);
  expect(input.onSync).toHaveBeenCalledTimes(2);
});

function guestProps(): GuestAccountPanelProps {
  return {
    appleAvailable: false,
    googleAvailable: false,
    availabilityNotice: 'This preview has no configured account providers.',
    busy: false,
    onApple: jest.fn(),
    onGoogle: jest.fn(),
    onContinueGuest: jest.fn(),
    onLocalBackup: jest.fn(),
  };
}
function signedProps(syncState: AccountSyncState): SignedInAccountPanelProps {
  return {
    identity: {
      ownerId: 'owner-a',
      displayName: 'Example Cook',
      email: 'cook@example.test',
      provider: 'google',
    },
    syncState,
    onSync: jest.fn(),
    onReview: jest.fn(),
    onSignOut: jest.fn(),
    onDelete: jest.fn(),
  };
}
function snapshot(): AccountSnapshot {
  return {
    format: 'cookmate-account-snapshot',
    schemaVersion: 1,
    catalogue: identity,
    favourites: [],
    plan: [],
    shopping: { selectedOccurrenceIds: [], purchaseMarks: [] },
    preferences: [],
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: null },
  };
}
function meal(
  recipeId: string,
  occurrenceId: string,
  actualDate = '2026-09-30',
): AccountPlanOccurrence {
  return {
    occurrenceId,
    recipeId,
    placement: { actualDate, mealKey: 'dinner' },
    createdAt: '2026-09-28T00:00:00Z',
    updatedAt: '2026-09-30T00:00:00Z',
  };
}
function mergeProps(
  changes: Partial<AccountMergePanelProps['review']> = {},
): AccountMergePanelProps {
  return {
    review: {
      kind: 'review',
      initial: true,
      recovering: false,
      local: snapshot(),
      account: snapshot(),
      conflicts: [],
      choice: 'merge',
      canConfirm: true,
      ...changes,
    },
    onSelect: jest.fn(),
    onResolve: jest.fn(),
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };
}

test('expanded conflicts show exact private content and collection context without internal IDs', () => {
  const createdAt = '2026-10-01T00:00:00.000Z';
  const collection = {
    collectionId: 'private-collection-id',
    name: 'Weeknight ideas',
    deleted: false,
    createdAt,
    updatedAt: createdAt,
  };
  const membership = {
    collectionId: collection.collectionId,
    recipeId: '52819',
    present: true,
    updatedAt: createdAt,
  };
  const local: AccountSnapshot = {
    ...snapshot(),
    schemaVersion: 2,
    personal: { notes: [], collections: [collection], memberships: [membership], manualItems: [] },
  };
  const conflicts: AccountMergeConflict[] = [
    {
      id: 'private-note-conflict',
      kind: 'note_edit',
      path: 'personal/notes/52819',
      base: null,
      local: {
        noteId: 'private-note-id',
        recipeId: '52819',
        text: 'Keep my exact note.',
        deleted: false,
        createdAt,
        updatedAt: createdAt,
      },
      account: null,
    },
    {
      id: 'private-manual-conflict',
      kind: 'manual_item_edit',
      path: 'personal/manualItems/private-manual-id',
      base: null,
      local: {
        kind: 'manual',
        itemId: 'private-manual-id',
        name: 'Market lemons',
        amountText: 'about ½',
        unitText: 'bag',
        category: 'produce',
        purchased: true,
        deleted: false,
        createdAt,
        updatedAt: createdAt,
      },
      account: null,
    },
    {
      id: 'private-subtree-conflict',
      kind: 'collection_subtree',
      path: 'personal/collections/private-collection-id/subtree',
      base: null,
      local: { collection, memberships: [membership] },
      account: { ...collection, name: null, deleted: true },
    },
  ];
  render(<AccountMergePanel {...mergeProps({ local, conflicts, canConfirm: false })} />);
  expect(screen.getByText('Keep my exact note.')).toBeTruthy();
  expect(screen.getByText('Market lemons')).toBeTruthy();
  expect(screen.getByText('about ½ bag')).toBeTruthy();
  expect(screen.getAllByText('Weeknight ideas').length).toBeGreaterThan(0);
  expect(screen.getByText('In this collection')).toBeTruthy();
  expect(screen.getByText('Collection removed')).toBeTruthy();
  expect(screen.queryByText(/private-(note|manual|collection|subtree)/)).toBeNull();
});

test('preferring account versions explicitly discloses retained device-only personal uploads', () => {
  const local: AccountSnapshot = {
    ...snapshot(),
    schemaVersion: 2,
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
  };
  render(<AccountMergePanel {...mergeProps({ local, choice: 'account' })} />);
  expect(screen.getByRole('radio', { name: 'Prefer account versions' })).toBeTruthy();
  expect(
    screen.getByText(
      /Device-only notes, collections, memberships and manual items are kept and included in this sync/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Cooking history on this device stays unchanged. Existing account history is kept.',
    ),
  ).toBeTruthy();
});

test('unconfigured providers cannot dispatch, while guest and local backup remain usable', () => {
  const props = guestProps();
  render(<GuestAccountPanel {...props} />);
  for (const provider of ['Apple', 'Google']) {
    const button = screen.getByRole('button', { name: `Continue with ${provider}` });
    expect(button).toBeDisabled();
    fireEvent.press(button);
  }
  expect(props.onApple).not.toHaveBeenCalled();
  expect(props.onGoogle).not.toHaveBeenCalled();
  expect(screen.getByText(props.availabilityNotice!)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Back to CookMate' }));
  fireEvent.press(screen.getByRole('button', { name: 'Local backup' }));
  expect(props.onContinueGuest).toHaveBeenCalledTimes(1);
  expect(props.onLocalBackup).toHaveBeenCalledTimes(1);
});

test('provider availability and busy updates immediately guard every account-entry action', () => {
  const props = { ...guestProps(), googleAvailable: true, availabilityNotice: null };
  const view = render(<GuestAccountPanel {...props} />);
  fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(props.onGoogle).toHaveBeenCalledTimes(1);
  view.rerender(<GuestAccountPanel {...props} busy />);
  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeDisabled();
    fireEvent.press(button);
  }
  expect(props.onGoogle).toHaveBeenCalledTimes(1);
  expect(props.onContinueGuest).not.toHaveBeenCalled();
  expect(props.onLocalBackup).not.toHaveBeenCalled();
});

test('unavailable local storage does not pretend to connect or prevent browsing as guest', () => {
  const props = {
    ...guestProps(),
    appleAvailable: true,
    googleAvailable: true,
    storageAvailable: false,
  };
  render(<GuestAccountPanel {...props} />);
  expect(screen.queryByText('Connecting to your account…')).toBeNull();
  expect(screen.getByText(/Saved cooking could not be loaded/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Local backup' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Back to CookMate' }));
  expect(props.onContinueGuest).toHaveBeenCalledTimes(1);
});

test('nullable account identity does not fabricate a name, email or provider', () => {
  render(
    <SignedInAccountPanel
      {...signedProps({ kind: 'local' })}
      identity={{ ownerId: 'private-owner-id', displayName: null, email: null, provider: null }}
    />,
  );
  expect(screen.getByText('Your CookMate account')).toBeTruthy();
  expect(screen.getByText('Email not supplied')).toBeTruthy();
  expect(screen.queryByText(/Connected with/)).toBeNull();
  expect(screen.queryByText('private-owner-id')).toBeNull();
  expect(screen.getByText('Saved on this device')).toBeTruthy();
  expect(screen.queryByText('Synced')).toBeNull();
});

test('sync transitions use supplied state, block working actions and dispatch review separately', () => {
  const props = signedProps({ kind: 'local' });
  const view = render(<SignedInAccountPanel {...props} />);
  fireEvent.press(screen.getByRole('button', { name: 'Sync now' }));
  expect(props.onSync).toHaveBeenCalledTimes(1);
  view.rerender(<SignedInAccountPanel {...props} syncState={{ kind: 'working' }} />);
  expect(screen.getByText('Sync in progress')).toBeTruthy();
  expect(screen.queryByText('Synced')).toBeNull();
  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeDisabled();
    fireEvent.press(button);
  }
  expect(props.onSync).toHaveBeenCalledTimes(1);
  expect(props.onDelete).not.toHaveBeenCalled();
  expect(props.onSignOut).not.toHaveBeenCalled();
  view.rerender(<SignedInAccountPanel {...props} syncState={mergeProps().review} />);
  expect(screen.getByText('Needs review')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Review differences' }));
  expect(props.onReview).toHaveBeenCalledTimes(1);
});

test('confirmed sync uses the supplied receipt time and never invents a missing timestamp', () => {
  const props = signedProps({ kind: 'synced', at: '2026-09-30T17:45:19Z' });
  const view = render(<SignedInAccountPanel {...props} />);
  expect(screen.getByText('Synced')).toBeTruthy();
  expect(screen.getByText(/Account data last saved:/).props.children).toContain('2026');
  expect(screen.getByText(/Account data last saved:/).props.children).toMatch(/17:45:19|05:45:19/);
  view.rerender(<SignedInAccountPanel {...props} syncState={{ kind: 'synced', at: null }} />);
  expect(screen.getByText(/An account-save time was not supplied/)).toBeTruthy();
  expect(screen.queryByText(/Account data last saved:/)).toBeNull();
  view.rerender(<SignedInAccountPanel {...props} syncState={{ kind: 'synced', at: 'invalid' }} />);
  expect(screen.queryByText(/Invalid Date/)).toBeNull();
});

test.each([true, false])(
  'failed sync keeps uncertainty without displaying raw reasons (pending=%s)',
  (pending) => {
    render(
      <SignedInAccountPanel
        {...signedProps({ kind: 'failed', reason: 'private unexpected diagnostic', pending })}
      />,
    );
    expect(screen.getByText('Couldn’t sync')).toBeTruthy();
    expect(screen.queryByText('Synced')).toBeNull();
    expect(screen.queryByText(/private unexpected diagnostic/)).toBeNull();
    expect(
      screen.getByText(
        pending ? /still needs reconciliation/ : /latest account result is not confirmed/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Nothing was saved/)).toBeNull();
  },
);

test('sign-out and deletion only invoke their separate review callbacks', () => {
  const props = signedProps({ kind: 'local' });
  render(<SignedInAccountPanel {...props} />);
  fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
  expect(props.onSignOut).toHaveBeenCalledTimes(1);
  expect(props.onDelete).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Delete account' }));
  expect(props.onDelete).toHaveBeenCalledTimes(1);
  expect(props.onSync).not.toHaveBeenCalled();
});

test('an empty account cannot replace guest data and confirmation is never automatic', () => {
  const props = mergeProps({ account: null });
  render(<AccountMergePanel {...props} />);
  expect(screen.getByText('No account backup yet')).toBeTruthy();
  expect(
    screen.getByText(/first confirmed account import keeps a local recovery copy/),
  ).toBeTruthy();
  const accountChoice = screen.getByRole('radio', { name: 'Use account data instead' });
  expect(accountChoice).toBeDisabled();
  fireEvent.press(accountChoice);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onConfirm).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Confirm merge & sync' }));
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
});

test('account replacement is explicit, controlled and explains the supported local data it replaces', () => {
  const props = mergeProps();
  const view = render(<AccountMergePanel {...props} />);
  fireEvent.press(screen.getByRole('radio', { name: 'Add this device’s data to my account' }));
  expect(props.onSelect).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('radio', { name: 'Use account data instead' }));
  expect(props.onSelect).toHaveBeenCalledWith('account');
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(screen.queryByText('Replace supported data on this device')).toBeNull();
  view.rerender(<AccountMergePanel {...props} review={{ ...props.review, choice: 'account' }} />);
  expect(
    screen.getByRole('radio', { name: 'Use account data instead' }).props.accessibilityState
      .checked,
  ).toBe(true);
  expect(screen.getByText('Replace supported data on this device')).toBeTruthy();
  expect(
    screen.getByText(/Device-only changes in those collections will not be added/),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Confirm use of account data' }));
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
});

test('all affected meal placements and distinct catalogue titles remain visible in a slot conflict', () => {
  const local = [meal('52819', 'local-a'), meal('53064', 'shared-b', '2026-10-01')];
  const account = [meal('52835', 'shared-b')];
  const conflict: AccountMergeConflict = {
    id: 'exact-current-comparison',
    kind: 'slot_collision',
    path: 'plan/slots/opaque',
    base: [],
    local,
    account,
  };
  const props = mergeProps({ conflicts: [conflict], canConfirm: false });
  render(<AccountMergePanel {...props} />);
  expect(screen.getByText('Cajun spiced fish tacos')).toBeTruthy();
  expect(screen.getByText('Fettuccine Alfredo')).toBeTruthy();
  expect(screen.getByText('Fettucine alfredo')).toBeTruthy();
  expect(screen.getByText('Thursday 1 October 2026 · Dinner')).toBeTruthy();
  expect(screen.getAllByText('Wednesday 30 September 2026 · Dinner')).toHaveLength(2);
  const confirm = screen.getByRole('button', { name: 'Confirm merge & sync' });
  expect(confirm).toBeDisabled();
  fireEvent.press(confirm);
  expect(props.onConfirm).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Keep this device for difference 1' }));
  expect(props.onResolve).toHaveBeenCalledWith(conflict.id, 'local');
  expect(screen.getByText('Fettucine alfredo')).toBeTruthy(); // Parent state remains authoritative.
});

test('deleted preferences and long values are shown completely without raw object or ID output', () => {
  const value = 'A precise saved ingredient preference. '.repeat(6);
  const conflict: AccountMergeConflict = {
    id: 'private-conflict-id',
    kind: 'delete_edit',
    path: 'preferences/private-preference-id',
    base: null,
    local: null,
    account: { preferenceId: 'private-preference-id', type: 'ingredient_avoid', value },
  };
  render(<AccountMergePanel {...mergeProps({ conflicts: [conflict], canConfirm: false })} />);
  expect(screen.getByText('No saved preference')).toBeTruthy();
  expect(screen.getByText('Ingredient I avoid')).toBeTruthy();
  expect(screen.getByText(value)).toBeTruthy();
  expect(screen.getByText(value).props.numberOfLines).toBeUndefined();
  expect(screen.queryByText(/private-conflict-id|private-preference-id/)).toBeNull();
});

test('setting conflicts show the actual human-readable setting values', () => {
  const conflicts: AccountMergeConflict[] = [
    {
      id: 'theme',
      kind: 'setting',
      path: 'appPreferences/theme',
      base: 'system',
      local: 'dark',
      account: 'light',
    },
    {
      id: 'name',
      kind: 'setting',
      path: 'profile/displayName',
      base: null,
      local: 'My exact display name',
      account: null,
    },
  ];
  const props = mergeProps({ conflicts, canConfirm: false });
  render(<AccountMergePanel {...props} />);
  expect(screen.getByText('Dark')).toBeTruthy();
  expect(screen.getByText('Light')).toBeTruthy();
  expect(screen.getByText('My exact display name')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Keep account version for difference 2' }));
  expect(props.onResolve).toHaveBeenCalledWith('name', 'account');
});

function purchaseConflict(id = 'purchase-comparison'): AccountMergeConflict {
  const mark = {
    groupKey: 'a'.repeat(64),
    groupingVersion: 'v1',
    demandFingerprint: 'b'.repeat(64),
    purchased: true,
    changed: false,
  };
  return {
    id,
    kind: 'purchase_state',
    path: `shopping/purchaseMarks/${mark.groupKey}`,
    base: null,
    local: mark,
    account: { ...mark, purchased: false, changed: true },
  };
}

test('purchase choices require both actual item descriptions and are invalidated with the comparison ID', () => {
  const conflict = purchaseConflict();
  const props = mergeProps({ conflicts: [conflict], canConfirm: false });
  const view = render(<AccountMergePanel {...props} />);
  expect(screen.getByText('Shopping item details unavailable')).toBeTruthy();
  const local = () => screen.getByRole('button', { name: 'Keep this device for difference 1' });
  const account = () =>
    screen.getByRole('button', { name: 'Keep account version for difference 1' });
  expect(local()).toBeDisabled();
  expect(account()).toBeDisabled();
  fireEvent.press(local());
  expect(props.onResolve).not.toHaveBeenCalled();
  const partial = {
    [conflict.id]: { local: { name: 'Garlic', quantity: '1 clove finely chopped' } },
  };
  view.rerender(<AccountMergePanel {...props} purchaseDescriptions={partial} />);
  expect(local()).toBeDisabled();
  expect(account()).toBeDisabled();
  const complete = {
    [conflict.id]: {
      ...partial[conflict.id],
      account: { name: 'Garlic', quantity: '2 cloves finely chopped' },
    },
  };
  view.rerender(<AccountMergePanel {...props} purchaseDescriptions={complete} />);
  expect(local()).toBeEnabled();
  expect(account()).toBeEnabled();
  expect(screen.getByText('1 clove finely chopped')).toBeTruthy();
  expect(screen.getByText('2 cloves finely chopped')).toBeTruthy();
  expect(screen.getByText('Purchased')).toBeTruthy();
  expect(screen.getByText('Not purchased')).toBeTruthy();
  expect(screen.getByText('Ingredients changed since review')).toBeTruthy();
  fireEvent.press(account());
  expect(props.onResolve).toHaveBeenCalledWith(conflict.id, 'account');
  view.rerender(
    <AccountMergePanel
      {...props}
      review={{ ...props.review, conflicts: [purchaseConflict('changed-comparison')] }}
      purchaseDescriptions={complete}
    />,
  );
  expect(local()).toBeDisabled();
  expect(account()).toBeDisabled();
  expect(screen.queryByText('a'.repeat(64))).toBeNull();
});

test('a deleted purchase mark still requires identification of the surviving item', () => {
  const conflict = { ...purchaseConflict(), kind: 'delete_edit' as const, local: null };
  const props = mergeProps({ conflicts: [conflict], canConfirm: false });
  const view = render(<AccountMergePanel {...props} />);
  expect(screen.getByText('No purchase mark')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Keep this device for difference 1' })).toBeDisabled();
  view.rerender(
    <AccountMergePanel
      {...props}
      purchaseDescriptions={{
        [conflict.id]: { account: { name: 'Garlic', quantity: '2 cloves' } },
      }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Keep this device for difference 1' })).toBeEnabled();
});

test('recovery has no new merge/replacement choice and leaving cannot imply cancellation', () => {
  const props = mergeProps({ recovering: true, initial: false, canConfirm: false });
  const view = render(<AccountMergePanel {...props} />);
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByText(/server save may already have completed/)).toBeTruthy();
  expect(screen.getByText(/does not cancel or undo the pending sync operation/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirm reviewed changes' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Return to account' }));
  expect(props.onCancel).toHaveBeenCalledTimes(1);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onConfirm).not.toHaveBeenCalled();
  view.rerender(<AccountMergePanel {...props} review={{ ...props.review, canConfirm: true }} />);
  fireEvent.press(screen.getByRole('button', { name: 'Confirm reviewed changes' }));
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
});
