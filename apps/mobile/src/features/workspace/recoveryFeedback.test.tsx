import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { CookMateServices } from '@cookmate/domain';
import { WorkspaceFeedback } from './WorkspaceFeedback';
import { useWorkspace } from './WorkspaceProvider';
import { DirectActionController } from './directActionController';
import type { AssistantRuntime, AssistantView } from '../assistant/assistantRuntime';

let mockWorkspace: ReturnType<typeof useWorkspace>;
let mockAssistant: AssistantRuntime;
let mockState: AssistantView;
jest.mock('./WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('../assistant/useAssistant', () => ({
  useAssistant: () => ({ assistant: mockAssistant, state: mockState }),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
afterEach(cleanup);

beforeEach(() => {
  // Synthetic view states check simultaneous controls; this is not Data acceptance proof.
  const actions = new DirectActionController({} as CookMateServices, jest.fn());
  actions.state = {
    kind: 'uncertain',
    checking: false,
    retryAllowed: true,
    detail: 'Result needs checking.',
    review: {} as never,
    command: {} as never,
  };
  actions.holdForAssistant(true);
  jest.spyOn(actions, 'reconcile').mockResolvedValue();
  jest.spyOn(actions, 'retryUncertain').mockResolvedValue();
  mockWorkspace = {
    availability: { kind: 'ready' },
    actions,
    actionState: actions.state,
    recoveryState: { kind: 'failed', error: { code: 'storage_failure' } },
    recovery: { check: jest.fn() },
    restoreScreenFocus: jest.fn(),
  } as unknown as ReturnType<typeof useWorkspace>;
  mockAssistant = {
    mutationsHeld: true,
    recovery: { check: jest.fn() },
  } as unknown as AssistantRuntime;
  mockState = {
    mutating: false,
    recovery: { kind: 'failed', error: { code: 'storage_failure' } },
  } as AssistantView;
});

test('direct inventory, current operation and assistant recovery checks remain reachable together', () => {
  render(<WorkspaceFeedback />);
  const checks = screen.getAllByRole('button', { name: 'Check status' });
  expect(checks).toHaveLength(2);
  checks.forEach((button) => {
    expect(button).toBeEnabled();
    fireEvent.press(button);
  });
  fireEvent.press(screen.getByRole('button', { name: 'Check earlier assistant results' }));
  expect(mockWorkspace.recovery!.check).toHaveBeenCalledTimes(1);
  expect(mockWorkspace.actions!.reconcile).toHaveBeenCalledTimes(1);
  expect(mockAssistant.recovery.check).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Retry this same change' })).toBeDisabled();
});

test('a proven eligible uncertain retry becomes available after external holds clear', () => {
  mockWorkspace.actions!.holdForAssistant(false);
  mockWorkspace.recoveryState = {
    kind: 'ready',
    page: { entries: [], nextAfterSequence: null },
  } as typeof mockWorkspace.recoveryState;
  mockAssistant = { ...mockAssistant, mutationsHeld: false } as AssistantRuntime;
  mockState.recovery = { kind: 'ready', proofs: {}, unresolvedIds: [] };
  render(<WorkspaceFeedback />);
  const retry = screen.getByRole('button', { name: 'Retry this same change' });
  expect(mockWorkspace.actions!.blocked).toBe(true);
  expect(retry).toBeEnabled();
  fireEvent.press(retry);
  expect(mockWorkspace.actions!.retryUncertain).toHaveBeenCalledTimes(1);
});
