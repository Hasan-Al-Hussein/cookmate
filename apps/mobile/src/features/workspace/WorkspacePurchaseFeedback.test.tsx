import { AccessibilityInfo } from 'react-native';
import { cleanup, render, screen } from '@testing-library/react-native';
import type { LocalCommand, OperationReceipt } from '@cookmate/contracts';
import type { DirectActionReview } from '@cookmate/domain';
import type { ActionState } from './directActionController';
import { ActionConfirmation, WorkspaceFeedback } from './WorkspaceFeedback';

const mockWorkspace = jest.fn();
jest.mock('./WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));
jest.mock('../assistant/useAssistant', () => ({ useAssistant: () => ({ assistant: null }) }));
jest.mock('../../components/Page', () => ({ usePageStyles: () => ({ section: {} }) }));
jest.mock('../../components/PresenceModal', () => ({
  PresenceModal: () => null,
  useModalAction: (_active: boolean, callback: () => void) => callback,
}));
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));

const input = { kind: 'setPurchased', groupKey: 'flour', purchased: true } as const;
const review: DirectActionReview = {
  guard: { kind: 'none' },
  input,
  payload: {
    ...input,
    scopeId: 'scope',
    expectedDemandFingerprint: 'a'.repeat(64),
    expectedRevision: 1,
  },
  consequences: {
    kind: 'purchase',
    groupKey: 'flour',
    displayName: 'Flour',
    quantityLabel: '600 g',
    purchased: true,
  },
};
const command: LocalCommand = {
  schemaVersion: 2,
  operationId: 'purchase-op',
  userIntentId: 'purchase-intent',
  intentRevision: 1,
  payloadFingerprint: 'b'.repeat(64),
  command: {
    ...input,
    scopeId: 'scope',
    expectedDemandFingerprint: 'a'.repeat(64),
    expectedRevision: 1,
  },
};
const receipt: OperationReceipt = {
  schemaVersion: 1,
  operationId: command.operationId,
  userIntentId: command.userIntentId,
  payloadFingerprint: command.payloadFingerprint,
  committedAt: '2026-10-01T04:00:00Z',
  outcome: 'committed',
  effects: [],
  shoppingProjection: 'unchanged',
};
const actions = { acknowledgeDisplayedReceipt: jest.fn(), restoreAfterRemoval: jest.fn() };
function state(actionState: ActionState, recovering = false) {
  mockWorkspace.mockReturnValue({
    actions,
    actionState,
    availability: { kind: 'ready' },
    recoveryState: recovering
      ? { kind: 'loading' }
      : { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
  });
}
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('checklist routine purchase stages add no feedback height while global receipt announcement remains', () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const stages: ActionState[] = [
    { kind: 'reviewing', input },
    { kind: 'preparing', review },
    { kind: 'applying', review, command },
    { kind: 'receipt', review, command, receipt },
  ];
  state(stages[0]!);
  const view = render(
    <>
      <WorkspaceFeedback checklist />
      <ActionConfirmation />
    </>,
  );
  for (const stage of stages.slice(1)) {
    state(stage);
    view.rerender(
      <>
        <WorkspaceFeedback checklist />
        <ActionConfirmation />
      </>,
    );
    expect(view.toJSON()).toBeNull();
  }
  expect(announce).toHaveBeenCalledTimes(1);
  expect(actions.acknowledgeDisplayedReceipt).toHaveBeenCalledTimes(1);
});

test('failed and uncertain purchases retain recovery controls in compact mode', () => {
  state({
    kind: 'failed',
    input,
    error: { code: 'storage_failure', messageKey: 'test', retry: 'never' },
  });
  const view = render(<WorkspaceFeedback checklist />);
  expect(screen.getByText('Couldn’t save this change')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Dismiss error' })).toBeTruthy();
  state({
    kind: 'uncertain',
    review,
    command,
    checking: false,
    detail: 'The receipt has not been confirmed.',
  });
  view.rerender(<WorkspaceFeedback checklist />);
  expect(screen.getByText('Save result unconfirmed')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
});

test('compacting a purchase never hides earlier recovery or other action feedback', () => {
  state({ kind: 'receipt', review, command, receipt }, true);
  const view = render(<WorkspaceFeedback checklist />);
  expect(screen.getByText('Checking earlier saved changes…')).toBeTruthy();
  state({ kind: 'reviewing', input: { kind: 'setFavourite', recipeId: '52819', saved: true } });
  view.rerender(<WorkspaceFeedback checklist />);
  expect(screen.getByText('Checking the current saved state…')).toBeTruthy();
});

test('ordinary screens retain their purchase confirmation', () => {
  state({ kind: 'receipt', review, command, receipt });
  render(<WorkspaceFeedback />);
  expect(screen.getByRole('button', { name: 'Dismiss confirmation' })).toBeTruthy();
});

test('a previous favourite receipt cannot shift the checklist when a purchase begins', () => {
  const favourite = { kind: 'setFavourite', recipeId: '52819', saved: true } as const;
  const favouriteReview: DirectActionReview = {
    guard: { kind: 'none' },
    input: favourite,
    payload: favourite,
    consequences: { kind: 'favourite', recipeId: '52819', saved: true },
  };
  state({
    kind: 'receipt',
    review: favouriteReview,
    command: { ...command, command: favourite },
    receipt,
  });
  const view = render(<WorkspaceFeedback checklist />);
  expect(view.toJSON()).toBeNull();
  state({ kind: 'reviewing', input });
  view.rerender(<WorkspaceFeedback checklist />);
  expect(view.toJSON()).toBeNull();
});
