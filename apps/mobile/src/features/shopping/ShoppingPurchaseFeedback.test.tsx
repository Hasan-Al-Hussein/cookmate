import { fireEvent, render, screen } from '@testing-library/react-native';
import { PersonalOperationFeedback } from '../personal/PersonalUI';
import type { usePersonalOperations } from '../personal/usePersonalOperations';

jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => ({}) }));
const reference = { operationId: 'manual-purchase', createdAt: '2026-10-01T00:00:00Z' };
function operation(): ReturnType<typeof usePersonalOperations> {
  return {
    ready: true,
    busy: false,
    error: null,
    storageError: null,
    receipt: null,
    references: [],
    perform: jest.fn(),
    recover: jest.fn(),
  };
}
function receipt(outcome: 'committed' | 'no_op' | 'cancelled') {
  return {
    operationId: reference.operationId,
    commandKind: 'setManualPurchased' as const,
    outcome,
    entityId: 'manual-salt',
    revision: 2,
    epoch: 1,
    committedAt: reference.createdAt,
    affectedMemberships: 0,
  };
}

test('quiet purchase presentation is opt-in and leaves ordinary personal feedback intact', () => {
  const active = { ...operation(), ready: false, busy: true, references: [reference] };
  const view = render(<PersonalOperationFeedback operation={active} purchasePending />);
  expect(screen.getByText('Checking your local change…')).toBeTruthy();
  expect(screen.getByText('Unconfirmed personal change')).toBeTruthy();
  view.rerender(
    <PersonalOperationFeedback operation={{ ...operation(), receipt: receipt('committed') }} />,
  );
  expect(screen.getByText('Local change saved')).toBeTruthy();
});

test.each(['committed', 'no_op'] as const)(
  'quiet %s receipt remains in state without a checklist feedback panel',
  (outcome) => {
    const state = { ...operation(), receipt: receipt(outcome) };
    const view = render(
      <PersonalOperationFeedback
        operation={state}
        quietPurchase
        purchaseOperationId={reference.operationId}
      />,
    );
    expect(view.toJSON()).toBeNull();
    expect(state.receipt.outcome).toBe(outcome);
    expect(state.recover).not.toHaveBeenCalled();
  },
);

test('failed, uncertain, storage and cancellation feedback stays visible, including recovery controls', () => {
  const state = {
    ...operation(),
    ready: false,
    busy: true,
    references: [reference],
    error: 'Outcome is uncertain.',
  };
  const view = render(
    <PersonalOperationFeedback operation={state} quietPurchase purchasePending />,
  );
  expect(screen.getByText('Change needs attention')).toBeTruthy();
  expect(screen.getByText('Outcome is uncertain.')).toBeTruthy();
  expect(screen.getByText('Unconfirmed personal change')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check personal change receipt' })).toBeDisabled();
  view.rerender(<PersonalOperationFeedback operation={{ ...state, busy: false }} quietPurchase />);
  fireEvent.press(screen.getByRole('button', { name: 'Check personal change receipt' }));
  expect(state.recover).toHaveBeenCalledWith(reference.operationId, false);
  fireEvent.press(screen.getByRole('button', { name: 'Resolve unconfirmed personal change' }));
  expect(state.recover).toHaveBeenCalledWith(reference.operationId, true);
  view.rerender(
    <PersonalOperationFeedback
      operation={{
        ...operation(),
        busy: true,
        storageError: 'Recovery storage unavailable.',
        references: [reference],
      }}
      quietPurchase
      purchasePending
    />,
  );
  expect(screen.getByText('Recovery needs attention')).toBeTruthy();
  expect(screen.getByText('Unconfirmed personal change')).toBeTruthy();
  view.rerender(
    <PersonalOperationFeedback
      operation={{ ...operation(), receipt: receipt('cancelled') }}
      quietPurchase
    />,
  );
  expect(screen.getByText('Earlier request cancelled')).toBeTruthy();
});

test('checking an earlier unresolved purchase keeps recovery visible even while busy', () => {
  const view = render(
    <PersonalOperationFeedback
      operation={{ ...operation(), busy: true, references: [reference] }}
      quietPurchase
    />,
  );
  expect(screen.getByText('Checking your local change…')).toBeTruthy();
  expect(screen.getByText('Unconfirmed personal change')).toBeTruthy();
  view.rerender(
    <PersonalOperationFeedback
      operation={{ ...operation(), receipt: receipt('committed') }}
      quietPurchase
      purchaseOperationId="another-current-operation"
    />,
  );
  expect(screen.getByText('Local change saved')).toBeTruthy();
});

test('quiet purchase option does not hide receipts from other private changes', () => {
  render(
    <PersonalOperationFeedback
      operation={{ ...operation(), receipt: { ...receipt('committed'), commandKind: 'saveNote' } }}
      quietPurchase
    />,
  );
  expect(screen.getByText('Local change saved')).toBeTruthy();
});
