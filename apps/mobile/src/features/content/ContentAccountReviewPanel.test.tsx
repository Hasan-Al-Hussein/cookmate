import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { catalogue } from '@cookmate/catalogue';
import type { AccountContentSnapshot } from '../../../../../packages/account-sync/src/contentSnapshot';
import type { AccountContentMergeConflict } from '../../../../../packages/account-sync/src/contentMerge';
import { ActionButton } from '../../components/Controls';
import {
  ContentAccountReviewPanel,
  type ContentAccountReviewPanelProps,
} from './ContentAccountReviewPanel';
import { buildContentAccountPurchaseDescriptions } from './contentAccountPurchaseDescriptions';

jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
jest.mock('./contentAccountPurchaseDescriptions', () => ({
  buildContentAccountPurchaseDescriptions: jest.fn(),
}));
const describePurchases = jest.mocked(buildContentAccountPurchaseDescriptions);
const at = '2026-10-02T00:00:00.000Z';
const ref = {
  recipeId: '90001',
  revisionId: 'authored-original',
  contentFingerprint: 'a'.repeat(64),
};
type Review = ContentAccountReviewPanelProps['review'];
const snapshot = (): AccountContentSnapshot => ({
  format: 'cookmate-account-snapshot',
  schemaVersion: 3,
  catalogue: catalogue.identity,
  favourites: [],
  preferences: [],
  plan: [],
  planReferences: [],
  personal: { notes: [], collections: [], memberships: [], manualItems: [] },
  shopping: { selectedOccurrenceIds: [], purchaseMarks: [] },
  appPreferences: { theme: 'system', locale: 'system', motion: 'system' },
  profile: { displayName: null },
});
function readyReview(): Extract<Review, { phase: 'push' }> {
  const local = snapshot();
  return {
    kind: 'review',
    phase: 'push',
    initial: true,
    canConfirm: true,
    review: {
      operationId: '10000000-0000-4000-8000-000000000001',
      initialImportRequired: true,
      comparison: { local, account: null },
      merge: { status: 'merged', snapshot: local, notices: [] },
      removalReview: null,
    },
  };
}
function props(review: Review = readyReview()): ContentAccountReviewPanelProps {
  return {
    review,
    ownerKey: 'owner-opening-1',
    isCurrent: () => true,
    dispatch: jest.fn(),
    reopen: jest.fn(),
  };
}
function withConflicts(conflicts: AccountContentMergeConflict[]) {
  const review = readyReview();
  return {
    ...review,
    canConfirm: false,
    review: {
      ...review.review,
      comparison: { ...review.review.comparison, account: snapshot() },
      merge: { status: 'needs_review' as const, conflicts, notices: [] },
    },
  };
}
function removalReview() {
  const review = readyReview();
  return {
    ...review,
    review: {
      ...review.review,
      removalReview: {
        conflicts: [
          {
            id: 'remove-favourite-exact',
            kind: 'favourite' as const,
            incoming: { recipeId: '90001', savedAt: at },
            current: {
              kind: 'removed' as const,
              row: { recipeId: '90001', saved: false, savedAt: at, updatedAt: at, revision: 2 },
            },
            reasons: ['exactFavouriteRemoval'] as ['exactFavouriteRemoval'],
          },
        ],
      },
    },
  };
}
function retainedPress(label: string) {
  const button = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((item) => item.props.label === label);
  if (!button) throw new Error(`Missing ${label}`);
  return button.props.onPress as () => void;
}
beforeEach(() => describePurchases.mockResolvedValue({}));
afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

test('same recipe conflicts show distinct exact versions and forward the issued conflict identity', () => {
  const occurrence = {
    occurrenceId: '20000000-0000-4000-8000-000000000001',
    recipeId: ref.recipeId,
    placement: { actualDate: '2026-10-02', mealKey: 'dinner' as const },
    createdAt: at,
    updatedAt: at,
    contentRef: ref,
  };
  const input = props(
    withConflicts([
      {
        id: 'exact-plan-conflict',
        kind: 'occurrence_edit',
        path: 'plan/one',
        base: null,
        local: occurrence,
        account: {
          ...occurrence,
          contentRef: {
            ...ref,
            revisionId: 'authored-revised',
            contentFingerprint: 'b'.repeat(64),
          },
        },
      },
    ]),
  );
  render(<ContentAccountReviewPanel {...input} />);
  expect(screen.getByText('Recipe 90001 · exact version authored-original')).toBeTruthy();
  expect(screen.getByText('Recipe 90001 · exact version authored-revised')).toBeTruthy();
  fireEvent.press(screen.getAllByRole('button', { name: 'Show exact reference' })[0]!);
  expect(screen.getByText(`Content fingerprint: ${ref.contentFingerprint}`)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Difference 1: keep account version' }));
  expect(input.dispatch).toHaveBeenCalledWith({
    kind: 'resolve',
    id: 'exact-plan-conflict',
    choice: 'account',
  });
  expect(describePurchases).not.toHaveBeenCalled();
});

test.each(['keep_local', 'save_account_version'] as const)(
  'requires exact removal decision %s and resets it for a new issued review',
  (choice) => {
    const input = props(removalReview());
    const view = render(<ContentAccountReviewPanel {...input} />);
    expect(screen.getByRole('button', { name: 'Confirm reviewed changes' })).toBeDisabled();
    fireEvent.press(
      screen.getByRole('radio', {
        name:
          choice === 'keep_local'
            ? 'Removal 1: keep local choice'
            : 'Removal 1: save displayed account version',
      }),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Confirm reviewed changes' }));
    expect(input.dispatch).toHaveBeenCalledWith({
      kind: 'confirm',
      removals: { 'remove-favourite-exact': choice },
    });
    view.rerender(<ContentAccountReviewPanel {...input} review={removalReview()} />);
    expect(screen.getByRole('button', { name: 'Confirm reviewed changes' })).toBeDisabled();
  },
);

test('unknown preference removal and archives describe missing evidence without inventing deleted text', () => {
  const base = readyReview();
  const review: Review = {
    ...base,
    review: {
      ...base.review,
      removalReview: {
        conflicts: [
          {
            id: 'unidentified',
            kind: 'preference',
            incoming: {
              preferenceId: '30000000-0000-4000-8000-000000000001',
              type: 'ingredient_avoid',
              value: 'Coriander',
            },
            current: { kind: 'absent' },
            removals: [],
            lastRemovalRevision: 3,
            reasons: ['unidentifiedPreferenceRemoval', 'retainedRestoreArchive'],
          },
        ],
      },
    },
  };
  render(<ContentAccountReviewPanel {...props(review)} />);
  expect(screen.getByText(/removed value cannot be identified/)).toBeTruthy();
  expect(screen.getByText(/does not identify a deleted value/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirm reviewed changes' })).toBeDisabled();
});

const purchaseConflict: AccountContentMergeConflict = {
  id: 'purchase-1',
  kind: 'purchase_state',
  path: 'shopping/purchaseMarks/one',
  base: null,
  local: {
    groupKey: 'exact-group',
    groupingVersion: 'v1',
    demandFingerprint: 'c'.repeat(64),
    purchased: true,
    changed: false,
  },
  account: {
    groupKey: 'exact-group',
    groupingVersion: 'v1',
    demandFingerprint: 'c'.repeat(64),
    purchased: false,
    changed: false,
  },
};
test('bootstrap purchase decisions stay disabled without an exact content reader', () => {
  const input = props(withConflicts([purchaseConflict]));
  render(<ContentAccountReviewPanel {...input} />);
  expect(screen.getByRole('button', { name: 'Difference 1: keep this device' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Difference 1: keep account version' })).toBeDisabled();
  expect(describePurchases).not.toHaveBeenCalled();
});

test('verified purchase descriptions enable choices, while a retired async result stays hidden', async () => {
  const input = props(withConflicts([purchaseConflict]));
  const readExact = jest.fn<
    ReturnType<NonNullable<ContentAccountReviewPanelProps['readExact']>>,
    Parameters<NonNullable<ContentAccountReviewPanelProps['readExact']>>
  >();
  let finish!: (value: Awaited<ReturnType<typeof buildContentAccountPurchaseDescriptions>>) => void;
  describePurchases.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let active = true;
  const view = render(
    <ContentAccountReviewPanel {...input} readExact={readExact} isCurrent={() => active} />,
  );
  active = false;
  await act(async () =>
    finish({
      'purchase-1': {
        local: { name: 'Hidden exact ingredient', quantity: '100g' },
        account: { name: 'Hidden exact ingredient', quantity: '100g' },
      },
    }),
  );
  expect(screen.queryByText(/Hidden exact ingredient/)).toBeNull();
  active = true;
  describePurchases.mockResolvedValueOnce({
    'purchase-1': {
      local: { name: 'Exact salt', quantity: '100g' },
      account: { name: 'Exact salt', quantity: '100g' },
    },
  });
  view.rerender(
    <ContentAccountReviewPanel
      {...input}
      review={withConflicts([purchaseConflict])}
      readExact={readExact}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Difference 1: keep this device' }),
    ).not.toBeDisabled(),
  );
  expect(screen.getAllByText('Exact salt · 100g')).toHaveLength(2);
});

test('large comparisons page ten rows without losing conflict identities', () => {
  const conflicts: AccountContentMergeConflict[] = Array.from({ length: 21 }, (_, index) => ({
    id: `setting-${index}`,
    kind: 'setting',
    path: 'profile/displayName',
    base: null,
    local: `Local ${index}`,
    account: `Account ${index}`,
  }));
  const input = props(withConflicts(conflicts));
  render(<ContentAccountReviewPanel {...input} />);
  expect(screen.getAllByRole('button', { name: /Difference \d+: keep this device/ })).toHaveLength(
    10,
  );
  expect(screen.queryByText('Local 10')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Next differences' }));
  expect(screen.getByText('Showing 11–20 of 21 differences')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Difference 11: keep this device' }));
  expect(input.dispatch).toHaveBeenCalledWith({
    kind: 'resolve',
    id: 'setting-10',
    choice: 'local',
  });
});

test('retained review callbacks cannot confirm after scope loss or unmount', () => {
  let active = true;
  const input = props();
  const view = render(<ContentAccountReviewPanel {...input} isCurrent={() => active} />);
  const press = retainedPress('Confirm reviewed changes');
  active = false;
  act(press);
  view.unmount();
  active = true;
  act(press);
  expect(input.dispatch).not.toHaveBeenCalled();
});

test('reopen invokes only the close/open owner and does not issue confirm or sync', () => {
  const input = props({
    kind: 'review',
    phase: 'reopen',
    initial: true,
    reason: 'binding_staged',
    operationId: 'operation',
    requestFingerprint: 'd'.repeat(64),
    canConfirm: false,
  });
  render(<ContentAccountReviewPanel {...input} />);
  expect(screen.getByText('Sync is not complete')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Reopen account workspace' }));
  expect(input.reopen).toHaveBeenCalledTimes(1);
  expect(input.dispatch).not.toHaveBeenCalled();
});

test('pull review is explicit replacement and can return to merge without a fabricated base', () => {
  const input = props({
    kind: 'review',
    phase: 'pull',
    initial: true,
    snapshot: snapshot(),
    canConfirm: true,
  });
  render(<ContentAccountReviewPanel {...input} />);
  expect(screen.getByText(/replaces supported local cooking data/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Review a merge instead' }));
  expect(input.dispatch).toHaveBeenCalledWith({ kind: 'select', choice: 'merge' });
  fireEvent.press(screen.getByRole('button', { name: 'Confirm use of account data' }));
  expect(input.dispatch).toHaveBeenLastCalledWith({ kind: 'confirm' });
});
