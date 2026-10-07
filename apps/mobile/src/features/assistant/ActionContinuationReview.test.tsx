import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';
import { getRecipe, identity } from '@cookmate/catalogue';
import type { ContractError, LocalCommand, OperationReceipt } from '@cookmate/contracts';
import type { AssistantActionContinuationReview } from '@cookmate/domain';
import { ActionContinuationReview, continuationCommandLabel } from './ActionContinuationReview';
import type { AssistantRuntime, AssistantView, IntentRecord } from './assistantRuntime';
import { ActionButton } from '../../components/Controls';

let mockState: AssistantView;
let mockRuntime: AssistantRuntime;
let mockMutationsHeld: boolean;
let mockRequestId: number;
const mockActions = { blocked: false };
const mockRestoreFocus = jest.fn();
jest.mock('./useAssistant', () => ({
  useAssistant: () => ({ assistant: mockRuntime, state: mockState }),
}));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ actions: mockActions }),
}));
jest.mock('../../hooks/useActionFocus', () => ({
  useActionFocus: () => ({ ref: { current: null }, restoreFocus: mockRestoreFocus }),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const header = {
  conversationId: 'conversation',
  generation: 0,
  revision: 8,
  composerDraft: '',
  nextSequence: 10,
};
const date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
const placement = { actualDate: '2026-09-29', mealKey: 'dinner' as const };
const storageError = {
  code: 'storage_failure' as const,
  messageKey: 'test.storage',
  retry: 'after_correction' as const,
};
const savedFavourite: OperationReceipt = {
  schemaVersion: 1,
  operationId: 'saved-operation',
  userIntentId: 'intent1',
  payloadFingerprint: 'a'.repeat(64),
  outcome: 'committed',
  committedAt: '2026-09-28T00:00:00Z',
  effects: [{ kind: 'favourite', entityId: '52839', revision: 1, saved: true }],
  shoppingProjection: 'unchanged',
};
function command(payload: LocalCommand['command']): LocalCommand {
  return {
    schemaVersion: 2,
    operationId: 'pending-operation',
    userIntentId: 'intent1',
    intentRevision: 6,
    payloadFingerprint: 'b'.repeat(64),
    command: payload,
  };
}
function makeReview(
  payload: LocalCommand['command'] = {
    kind: 'addPlan',
    occurrenceId: 'new-meal',
    recipeId: '53064',
    placement,
    expectedTarget: { kind: 'empty' },
  },
  commandState: AssistantActionContinuationReview['slot']['commandState'] = 'frozen',
): AssistantActionContinuationReview {
  return {
    reviewToken: 'review-token',
    cursor: 1,
    slot: { slotId: 'pending-slot', command: command(payload), commandState },
    prefixReceipts: [{ slotId: 'saved-slot', receipt: savedFavourite }],
    catalogue: identity,
    state: {
      guards: {
        conversationId: header.conversationId,
        conversationGeneration: header.generation,
        connectionGeneration: 1,
        contextRevision: 8,
        preferenceRevision: 0,
        relativeDateContext: date,
      },
      planOccurrences: [
        {
          occurrenceId: 'current-meal',
          recipeId: '52839',
          placement,
          revision: 2,
          createdAt: '2026-09-28T00:00:00Z',
          updatedAt: '2026-09-28T00:00:00Z',
        },
      ],
      shoppingScope: { scopeId: 'scope', revision: 4, occurrenceIds: ['current-meal'] },
    },
  };
}
function makeRecord(userIntentId = 'intent1', revision = 6): IntentRecord {
  return {
    intent: { userIntentId, revision, phase: 'reconciling', slots: [] },
    response: null,
    actionPlan: null,
    slotResults: [],
  } as unknown as IntentRecord;
}
type Rendered = ReturnType<typeof render>;
function openReview(record = makeRecord()) {
  const view = render(<ActionContinuationReview record={record} />);
  fireEvent.press(screen.getByRole('button', { name: 'Review next unfinished change' }));
  view.rerender(<ActionContinuationReview record={record} />);
  return { view, record };
}
function showReview(view: Rendered, record: IntentRecord, review = makeReview()) {
  const ticket = mockState.continuationReview!;
  mockState = {
    ...mockState,
    busy: false,
    continuationReview: { ...ticket, kind: 'ready', review },
  };
  view.rerender(<ActionContinuationReview record={record} />);
  return review;
}
function showUnavailableReview(
  view: Rendered,
  record: IntentRecord,
  kind: 'unavailable' | 'failed',
  error: ContractError = storageError,
) {
  const ticket = mockState.continuationReview!;
  mockState = {
    ...mockState,
    busy: false,
    continuationReview: kind === 'failed' ? { ...ticket, kind, error } : { ...ticket, kind },
  };
  view.rerender(<ActionContinuationReview record={record} />);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockRequestId = 0;
  mockActions.blocked = false;
  mockMutationsHeld = false;
  mockRestoreFocus.mockClear();
  mockState = {
    connection: { generation: 1, status: 'paired' },
    connectionReady: true,
    connectionBusy: false,
    conversation: { header, messages: [], intents: {}, hasEarlier: false, beforeSequence: null },
    loading: false,
    draft: '',
    busy: false,
    mutating: false,
    composerPaused: false,
    actionOutcomes: {},
    recovery: { kind: 'ready', proofs: {}, unresolvedIds: [] },
  };
  // Synthetic central tickets exercise view ownership only, not Data/core authority or receipts.
  mockRuntime = {
    getSnapshot: () => mockState,
    get mutationsHeld() {
      return mockMutationsHeld;
    },
    reviewContinuation: jest.fn(async (userIntentId: string) => {
      mockState = {
        ...mockState,
        busy: true,
        continuationReview: { kind: 'loading', userIntentId, requestId: ++mockRequestId },
      };
    }),
    dismissContinuationReview: jest.fn((requestId?: number) => {
      if (mockState.continuationReview?.requestId === requestId)
        mockState = { ...mockState, continuationReview: undefined };
    }),
    confirmContinuation: jest.fn(async () => {
      mockState = { ...mockState, busy: true, continuationReview: undefined };
    }),
    runAction: jest.fn(async (_id: string, operation: () => Promise<unknown>) => {
      mockState = { ...mockState, busy: true };
      await operation();
    }),
    core: { reconcile: jest.fn(async () => null), dispatch: jest.fn() },
  } as unknown as AssistantRuntime;
});
afterEach(async () => {
  await act(async () => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
});

test('the next plan command is reviewed alone after an earlier favourite receipt', () => {
  const { view, record } = openReview();
  expect(mockRuntime.reviewContinuation).toHaveBeenCalledWith('intent1', 6);
  expect(screen.getByText('Checking the next unfinished change…')).toBeTruthy();
  const review = showReview(view, record);
  expect(screen.getByText(continuationCommandLabel(review.slot.command)!)).toBeTruthy();
  expect(screen.getByText('Earlier results already confirmed')).toBeTruthy();
  expect(screen.getByText(`${getRecipe('52839')!.title} · saved in Favourites`)).toBeTruthy();
  expect(screen.queryByText(`Save ${getRecipe('52839')!.title} to Favourites`)).toBeNull();
  expect(screen.getByText(/Apply confirms only this change/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Apply this change' })).toHaveLength(1);
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
});

test('losing availability retires the owned review and an old Apply callback immediately', () => {
  const { view, record } = openReview();
  showReview(view, record);
  const ticket = mockState.continuationReview!;
  const oldApply = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Apply this change')!.props.onPress as () => void;
  view.rerender(<ActionContinuationReview record={record} available={false} />);
  expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledWith(ticket.requestId);
  expect(screen.queryByRole('button', { name: 'Review next unfinished change' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply this change' })).toBeNull();
  act(oldApply);
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
});

test.each(['unavailable', 'failed'] as const)(
  '%s review never offers confirmation or claims completion',
  (kind) => {
    const { view, record } = openReview();
    showUnavailableReview(view, record, kind);
    expect(
      screen.getByText(
        kind === 'failed' ? 'Couldn’t review this change' : 'No change available to review',
      ),
    ).toBeTruthy();
    if (kind === 'unavailable')
      expect(screen.getByText(/does not confirm that every change finished/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply this change' })).toBeNull();
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
    expect(mockRuntime.runAction).not.toHaveBeenCalled();
  },
);

test.each(['unavailable', 'failed'] as const)(
  '%s review checks saved results only after explicit own-ticket dismissal',
  async (kind) => {
    const { view, record } = openReview();
    const requestId = mockState.continuationReview!.requestId;
    showUnavailableReview(view, record, kind);
    const check = screen.getByRole('button', { name: 'Check saved results' });
    expect(check).toBeEnabled();
    expect(mockRuntime.core.reconcile).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(check);
      fireEvent.press(check);
    });
    expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledTimes(1);
    expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledWith(requestId);
    expect(mockRuntime.runAction).toHaveBeenCalledTimes(1);
    expect(mockRuntime.runAction).toHaveBeenCalledWith('intent1', expect.any(Function));
    expect(jest.mocked(mockRuntime.runAction).mock.calls[0]).toHaveLength(2);
    expect(
      jest.mocked(mockRuntime.dismissContinuationReview).mock.invocationCallOrder[0],
    ).toBeLessThan(jest.mocked(mockRuntime.runAction).mock.invocationCallOrder[0]!);
    expect(mockRuntime.core.reconcile).toHaveBeenCalledWith('intent1');
    expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
    expect(mockRuntime.reviewContinuation).toHaveBeenCalledTimes(1);
    expect(mockState.continuationReview).toBeUndefined();
    view.unmount();
    expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledTimes(1);
  },
);

test.each(['busy', 'connection'])('saved-results checking waits during %s', (blockedBy) => {
  const { view, record } = openReview();
  showUnavailableReview(view, record, 'failed');
  if (blockedBy === 'busy') mockState = { ...mockState, busy: true };
  else mockState = { ...mockState, connectionBusy: true };
  view.rerender(<ActionContinuationReview record={record} />);
  const check = screen.getByRole('button', { name: 'Check saved results' });
  expect(check).toBeDisabled();
  fireEvent.press(check);
  expect(mockRuntime.dismissContinuationReview).not.toHaveBeenCalled();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
});

test('read errors and unresolved mutation holds still allow deliberate saved-results reconciliation', async () => {
  const { view, record } = openReview();
  mockActions.blocked = true;
  mockMutationsHeld = true;
  mockState = { ...mockState, readError: storageError, recovery: { kind: 'loading' } };
  showUnavailableReview(view, record, 'failed');
  const check = screen.getByRole('button', { name: 'Check saved results' });
  expect(check).toBeEnabled();
  await act(async () => fireEvent.press(check));
  expect(mockRuntime.runAction).toHaveBeenCalledWith('intent1', expect.any(Function));
  expect(mockRuntime.core.reconcile).toHaveBeenCalledTimes(1);
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
  expect(mockMutationsHeld).toBe(true);
});

test('cancelled review preserves saved-effects wording and requires an explicit results check', async () => {
  const { view, record } = openReview();
  showUnavailableReview(view, record, 'failed', {
    code: 'cancelled',
    messageKey: 'test.cancelled',
    retry: 'never',
  });
  expect(
    screen.getByText('Waiting stopped. Any completed local changes remain saved.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Apply this change' })).toBeNull();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Check saved results' })),
  );
  expect(mockRuntime.core.reconcile).toHaveBeenCalledWith('intent1');
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
});

test('a stale saved-results handler cannot dismiss or reconcile another row’s ticket', () => {
  const { view, record } = openReview();
  showUnavailableReview(view, record, 'unavailable');
  const check = screen.getByRole('button', { name: 'Check saved results' });
  mockState = {
    ...mockState,
    continuationReview: { kind: 'unavailable', requestId: 99, userIntentId: 'another-intent' },
  };
  fireEvent.press(check);
  expect(mockRuntime.dismissContinuationReview).not.toHaveBeenCalled();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  expect(mockState.continuationReview?.requestId).toBe(99);
});

test('a ticket opened synchronously during dismissal is left for its new owner', () => {
  const { view, record } = openReview();
  showUnavailableReview(view, record, 'failed');
  jest.mocked(mockRuntime.dismissContinuationReview).mockImplementationOnce(() => {
    mockState = {
      ...mockState,
      continuationReview: { kind: 'loading', requestId: 99, userIntentId: 'another-intent' },
    };
  });
  fireEvent.press(screen.getByRole('button', { name: 'Check saved results' }));
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  expect(mockState.continuationReview?.requestId).toBe(99);
});

test.each([true, false])(
  'replacement uses the returned current meal and shopping selection (%s)',
  (selected) => {
    const review = makeReview({
      kind: 'replacePlanRecipe',
      occurrenceId: 'current-meal',
      expectedRevision: 2,
      expectedShoppingScopeRevision: 4,
      recipeId: '53064',
      placement,
    });
    if (!selected) review.state.shoppingScope.occurrenceIds = [];
    const { view, record } = openReview();
    showReview(view, record, review);
    expect(screen.getByText(`Replace ${getRecipe('52839')!.title}?`)).toBeTruthy();
    expect(
      screen.getByText(
        selected
          ? 'This meal stays selected for shopping. Its new ingredients can reset changed purchase marks.'
          : 'This meal stays outside the shopping selection.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply this change' })).toBeEnabled();
  },
);

test.each(['unsupported command', 'missing current meal'])(
  '%s cannot be confirmed through a generic action',
  (condition) => {
    const review = makeReview(
      condition === 'unsupported command'
        ? { kind: 'clearPreferences', expectedPreferenceRevision: 0 }
        : {
            kind: 'replacePlanRecipe',
            occurrenceId: 'missing-meal',
            expectedRevision: 2,
            expectedShoppingScopeRevision: 4,
            recipeId: '53064',
            placement,
          },
    );
    const { view, record } = openReview();
    showReview(view, record, review);
    expect(screen.getByText('This change needs a new review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply this change' })).toBeNull();
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  },
);

test.each(['button', 'sheet close'])('%s dismisses only this row’s displayed ticket', (method) => {
  const { view } = openReview();
  const requestId = mockState.continuationReview!.requestId;
  if (method === 'button')
    fireEvent.press(screen.getByRole('button', { name: 'Keep current choices' }));
  else fireEvent(view.UNSAFE_getByType(Modal), 'requestClose');
  expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledTimes(1);
  expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledWith(requestId);
  view.unmount();
  expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledTimes(1);
});

test('unmount dismisses its pending read but never another row’s replacement ticket', () => {
  const first = openReview();
  first.view.unmount();
  expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledWith(1);
  mockState = { ...mockState, busy: false };
  jest.mocked(mockRuntime.dismissContinuationReview).mockClear();
  const second = openReview();
  mockState = {
    ...mockState,
    continuationReview: { kind: 'loading', requestId: 99, userIntentId: 'another-intent' },
  };
  second.view.unmount();
  expect(mockRuntime.dismissContinuationReview).not.toHaveBeenCalled();
  expect(mockState.continuationReview?.requestId).toBe(99);
});

test('a dismissed pending ticket cannot reopen its modal if an obsolete result is published', () => {
  const { view, record } = openReview();
  const oldTicket = mockState.continuationReview!;
  fireEvent.press(screen.getByRole('button', { name: 'Keep current choices' }));
  mockState = {
    ...mockState,
    busy: false,
    continuationReview: { ...oldTicket, kind: 'ready', review: makeReview() },
  };
  view.rerender(<ActionContinuationReview record={record} />);
  expect(screen.queryByRole('button', { name: 'Apply this change' })).toBeNull();
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
});

test.each(['frozen', 'prospective'] as const)(
  '%s confirmation forwards the exact review once and survives its own slot refresh',
  (commandState) => {
    const { view, record } = openReview();
    const review = showReview(view, record, makeReview(undefined, commandState));
    expect(screen.getByText(continuationCommandLabel(review.slot.command)!)).toBeTruthy();
    expect(screen.queryByText(/frozen|prospective/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check saved results' })).toBeNull();
    const apply = screen.getByRole('button', { name: 'Apply this change' });
    fireEvent.press(apply);
    fireEvent.press(apply);
    expect(mockRuntime.confirmContinuation).toHaveBeenCalledTimes(1);
    const forwarded = jest.mocked(mockRuntime.confirmContinuation).mock.calls[0]![0];
    expect(forwarded).toBe(review);
    expect(forwarded.slot.commandState).toBe(commandState);
    mockState = { ...mockState, mutating: true, recovery: { kind: 'loading' } };
    const refreshedRecord: IntentRecord = {
      ...record,
      intent: {
        ...record.intent,
        slots: [{ slotId: review.slot.slotId, command: review.slot.command }],
      },
    };
    expect(refreshedRecord.intent.revision).toBe(record.intent.revision);
    view.rerender(<ActionContinuationReview record={refreshedRecord} />);
    fireEvent(view.UNSAFE_getByType(Modal), 'dismiss');
    expect(mockRestoreFocus).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mockRuntime.dismissContinuationReview).not.toHaveBeenCalled();
    expect(mockRuntime.runAction).not.toHaveBeenCalled();
  },
);

test('a duplicate review press observes the runtime’s synchronous busy claim', () => {
  const record = makeRecord();
  render(<ActionContinuationReview record={record} />);
  const button = screen.getByRole('button', { name: 'Review next unfinished change' });
  fireEvent.press(button);
  fireEvent.press(button);
  expect(mockRuntime.reviewContinuation).toHaveBeenCalledTimes(1);
  expect(mockRuntime.reviewContinuation).toHaveBeenCalledWith('intent1', 6);
});

test.each(['frozen', 'prospective'] as const)(
  '%s read-only review cannot release an unknown execution hold',
  (commandState) => {
    mockActions.blocked = true;
    mockMutationsHeld = true;
    mockState.recovery = { kind: 'ready', proofs: {}, unresolvedIds: ['earlier-intent'] };
    const { view, record } = openReview();
    expect(mockRuntime.reviewContinuation).toHaveBeenCalledTimes(1);
    showReview(view, record, makeReview(undefined, commandState));
    expect(screen.getByText('Applying changes is paused')).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply this change' });
    expect(apply).toBeDisabled();
    fireEvent.press(apply);
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
    expect(mockRuntime.runAction).not.toHaveBeenCalled();
    expect(mockMutationsHeld).toBe(true);
  },
);

test.each(['busy', 'connection', 'read error', 'workspace hold', 'assistant hold'])(
  'Apply respects a %s after the review opens',
  (blockedBy) => {
    const { view, record } = openReview();
    showReview(view, record);
    if (blockedBy === 'busy') mockState = { ...mockState, busy: true };
    if (blockedBy === 'connection') mockState = { ...mockState, connectionBusy: true };
    if (blockedBy === 'read error') mockState = { ...mockState, readError: storageError };
    if (blockedBy === 'workspace hold') mockActions.blocked = true;
    if (blockedBy === 'assistant hold') mockMutationsHeld = true;
    view.rerender(<ActionContinuationReview record={record} />);
    const apply = screen.getByRole('button', { name: 'Apply this change' });
    expect(apply).toBeDisabled();
    fireEvent.press(apply);
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
    expect(mockRuntime.dismissContinuationReview).not.toHaveBeenCalled();
  },
);

test.each(['busy', 'connection', 'read error'])('review cannot open during %s', (blockedBy) => {
  if (blockedBy === 'busy') mockState.busy = true;
  if (blockedBy === 'connection') mockState.connectionBusy = true;
  if (blockedBy === 'read error') mockState.readError = storageError;
  render(<ActionContinuationReview record={makeRecord()} />);
  const button = screen.getByRole('button', { name: 'Review next unfinished change' });
  expect(button).toBeDisabled();
  fireEvent.press(button);
  expect(mockRuntime.reviewContinuation).not.toHaveBeenCalled();
});

test.each(['intent', 'revision', 'conversation', 'generation', 'connection'])(
  '%s changes retire an owned pending ticket before an obsolete read can be shown',
  (changed) => {
    const opened = openReview();
    const oldTicket = mockState.continuationReview!;
    let record = opened.record;
    if (changed === 'intent') record = makeRecord('different-intent');
    if (changed === 'revision') record = makeRecord('intent1', 7);
    if (changed === 'connection')
      mockState = { ...mockState, connection: { generation: 2, status: 'paired' } };
    if (changed === 'conversation' || changed === 'generation')
      mockState = {
        ...mockState,
        conversation: {
          ...mockState.conversation!,
          header: {
            ...header,
            ...(changed === 'conversation'
              ? { conversationId: 'new-conversation' }
              : { generation: 1 }),
          },
        },
      };
    opened.view.rerender(<ActionContinuationReview record={record} />);
    expect(mockRuntime.dismissContinuationReview).toHaveBeenCalledWith(oldTicket.requestId);
    mockState = {
      ...mockState,
      busy: false,
      continuationReview: { ...oldTicket, kind: 'ready', review: makeReview() },
    };
    opened.view.rerender(<ActionContinuationReview record={record} />);
    expect(screen.queryByRole('button', { name: 'Apply this change' })).toBeNull();
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  },
);

test('labels preserve supported command meaning and reject unsupported command kinds', () => {
  expect(
    continuationCommandLabel(command({ kind: 'setFavourite', recipeId: '52839', saved: false })),
  ).toBe(`Remove ${getRecipe('52839')!.title} from Favourites`);
  expect(
    continuationCommandLabel(
      command({
        kind: 'savePreference',
        preferenceId: 'preference1',
        type: 'ingredient_avoid',
        explicitValue: 'coriander',
        expectedPreferenceRevision: 0,
      }),
    ),
  ).toBe('Save Ingredient I avoid: coriander');
  expect(
    continuationCommandLabel(command({ kind: 'clearPreferences', expectedPreferenceRevision: 0 })),
  ).toBeNull();
});
