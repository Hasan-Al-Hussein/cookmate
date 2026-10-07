import {
  act,
  cleanup,
  fireEvent,
  render as renderNative,
  screen,
} from '@testing-library/react-native';
import { FlatList } from 'react-native';
import { catalogue } from '@cookmate/catalogue';
import type {
  AnswerResponse,
  AssistantTurnRequest,
  ContractError,
  LocalCommand,
  MemoryItem,
  OperationReceipt,
  ProposalResponse,
} from '@cookmate/contracts';
import type {
  ContextNarrowing,
  ConversationMemoryPage,
  StoredAssistantIntent,
  StoredConversationMessage,
} from '@cookmate/domain';
import type { AssistantRuntime, AssistantView } from './assistantRuntime';
import AssistantScreen from './AssistantScreen';
import { AssistantMessage } from './AssistantMessage';
import { AssistantRecoveryFeedback } from './AssistantRecoveryFeedback';
import { WorkingContext } from './WorkingContext';
import SettingsScreen from '../settings/SettingsScreen';
import { ConnectionSettings } from '../settings/ConnectionSettings';
import { ProposalReview } from './ProposalReview';
import { ActionButton } from '../../components/Controls';
import { AssistantEntryProvider, useAssistantEntry } from './AssistantEntryState';

function render(ui: Parameters<typeof renderNative>[0]) {
  return renderNative(ui, { wrapper: AssistantEntryProvider });
}

// This existing fixture includes Node crypto; keep its loading within Jest's test boundary.
const {
  id: fixtureId,
  request: createTurnRequest,
  response: createTurnResponse,
} = jest.requireActual<{
  id(value: number): string;
  request(generation?: number): AssistantTurnRequest;
  response(request?: AssistantTurnRequest): ProposalResponse;
}>('../../assistant-core/fixtures.test-support');

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockParams: Record<string, string> = {};
let mockState: AssistantView;
let mockRuntime: AssistantRuntime;
jest.mock('./useAssistant', () => ({
  useAssistant: () => ({ assistant: mockRuntime, state: mockState }),
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    push: mockPush,
    navigate: mockNavigate,
    setParams: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
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
const message: StoredConversationMessage = {
  messageId: 'assistant1',
  conversationId: 'conversation',
  generation: 0,
  sequence: 2,
  role: 'assistant',
  text: 'A fictional test answer.',
  status: 'complete',
  createdAt: '2026-09-28T00:00:00Z',
  referenceSets: [],
};
const ready = <T,>(value: T) => ({ kind: 'ready' as const, value, revision: 8 });
beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
  Object.keys(mockParams).forEach((key) => delete mockParams[key]);
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
  // View-only synthetic doubles; the real Data/core boundary is tested by its owners.
  mockRuntime = {
    get state() {
      return mockState;
    },
    getSnapshot: () => mockState,
    setDraft: jest.fn(),
    send: jest.fn(),
    retryTurn: jest.fn(),
    retryAcceptance: jest.fn(),
    reload: jest.fn(),
    invalidate: jest.fn(),
    workingContextChanged: jest.fn(),
    connectionAction: jest.fn(),
    reviewContinuation: jest.fn(),
    dismissContinuationReview: jest.fn(),
    confirmContinuation: jest.fn(),
    runAction: jest.fn(async (_id: string, operation: () => Promise<unknown>) => {
      await operation();
    }),
    cancel: jest.fn(),
    recovery: { check: jest.fn() },
    core: {
      setWorkingContext: jest.fn(async () => ready(header)),
      readMemoryPage: jest.fn(),
      approve: jest.fn(),
      dispatch: jest.fn(),
      reconcile: jest.fn(),
    },
    persistence: { readCurrentActionState: jest.fn() },
  } as unknown as AssistantRuntime;
});
afterEach(async () => {
  await act(async () => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
});

function retainedTurnFixture(
  error: ContractError | null,
  status: StoredConversationMessage['status'] = 'failed',
) {
  const request = createTurnRequest();
  request.message.sourceSequence = 1;
  const userMessage: StoredConversationMessage = {
    ...message,
    messageId: request.message.messageId,
    conversationId: request.conversationId,
    sequence: request.message.sourceSequence,
    role: 'user',
    text: request.message.text,
    status,
  };
  const record: StoredAssistantIntent = {
    request,
    acceptanceEnvelope: {
      assistantMessageId: fixtureId(5),
      expectedIntentRevision: request.intentRevision,
    },
    intent: { userIntentId: request.userIntentId, revision: 1, phase: 'cancelled', slots: [] },
    response: error
      ? {
          apiVersion: request.apiVersion,
          catalogue: request.catalogue,
          requestId: request.requestId,
          userIntentId: request.userIntentId,
          intentRevision: request.intentRevision,
          conversationId: request.conversationId,
          conversationGeneration: request.conversationGeneration,
          connectionGeneration: request.connectionGeneration,
          preferenceRevision: request.context.preferences.revision,
          kind: 'error',
          error,
        }
      : null,
    actionPlan: null,
    guards: null,
    slotResults: [],
  };
  mockState.conversation = {
    ...mockState.conversation!,
    header: { ...header, conversationId: request.conversationId },
    messages: [userMessage],
    intents: { [request.userIntentId]: record },
  };
  return { request, record, userMessage };
}

function expectNoAssistantEffects() {
  expect(mockRuntime.send).not.toHaveBeenCalled();
  expect(mockRuntime.core.approve).not.toHaveBeenCalled();
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
}

test.each<{
  code: ContractError['code'];
  retry: ContractError['retry'];
  allowed: boolean;
}>([
  { code: 'provider_refused', retry: 'after_correction', allowed: false },
  { code: 'invalid_input', retry: 'after_correction', allowed: false },
  { code: 'unsupported_request', retry: 'never', allowed: false },
  { code: 'quota', retry: 'after_delay', allowed: true },
  { code: 'network_unavailable', retry: 'after_reconnect', allowed: true },
  { code: 'storage_failure', retry: 'reconcile', allowed: true },
  { code: 'cancelled', retry: 'after_reconnect', allowed: false },
])(
  'turn recovery $code/$retry keeps current and historical controls truthful',
  async ({ code, retry, allowed }) => {
    const error: ContractError = { code, retry, messageKey: 'test.private_provider_detail' };
    const { request } = retainedTurnFixture(error, code === 'cancelled' ? 'cancelled' : 'failed');
    mockState.draft = 'My retained next message';
    mockState.outcome = { kind: 'failed', error, userIntentId: request.userIntentId };
    render(<AssistantScreen />);
    await act(async () => jest.runOnlyPendingTimers());
    expect(screen.getByDisplayValue('My retained next message')).toBeTruthy();
    const composer = screen.getByLabelText('Message the assistant');
    expect(composer.props.editable).toBe(true);
    fireEvent.changeText(composer, 'My edited next message');
    expect(mockRuntime.setDraft).toHaveBeenCalledWith('My edited next message');
    expect(screen.queryByText(error.messageKey)).toBeNull();
    expect(mockRuntime.retryTurn).not.toHaveBeenCalled();
    expect(mockRuntime.retryAcceptance).not.toHaveBeenCalled();
    expectNoAssistantEffects();
    if (code === 'provider_refused') {
      expect(
        screen.getAllByText(
          'The AI service declined this request. Edit your message before sending a new request. No actions were authorized by this reply.',
        ),
      ).toHaveLength(2);
    } else if (!allowed && code !== 'cancelled') {
      expect(
        screen.getAllByText(
          'Review the guidance above and edit your message before sending a new request.',
        ),
      ).toHaveLength(2);
    }
    if (allowed) {
      fireEvent.press(screen.getByRole('button', { name: 'Retry this request' }));
      fireEvent.press(screen.getByRole('button', { name: 'Retry this earlier request' }));
      expect(mockRuntime.retryTurn).toHaveBeenCalledTimes(2);
      expect(mockRuntime.retryTurn).toHaveBeenNthCalledWith(1, request.userIntentId);
      expect(mockRuntime.retryTurn).toHaveBeenNthCalledWith(2, request.userIntentId);
    } else {
      expect(screen.queryByRole('button', { name: 'Retry this request' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry this earlier request' })).toBeNull();
    }
    expectNoAssistantEffects();
  },
);

test.each<{
  status: StoredConversationMessage['status'];
  phase: StoredAssistantIntent['intent']['phase'];
  response: 'none' | 'error' | 'accepted';
  retained: boolean;
  allowed: boolean;
}>([
  { status: 'interrupted', phase: 'cancelled', response: 'none', retained: true, allowed: true },
  { status: 'failed', phase: 'cancelled', response: 'none', retained: true, allowed: false },
  { status: 'cancelled', phase: 'cancelled', response: 'none', retained: true, allowed: false },
  {
    status: 'sending',
    phase: 'awaiting_response',
    response: 'none',
    retained: true,
    allowed: false,
  },
  { status: 'interrupted', phase: 'settled', response: 'none', retained: true, allowed: false },
  { status: 'interrupted', phase: 'cancelled', response: 'error', retained: true, allowed: false },
  {
    status: 'interrupted',
    phase: 'cancelled',
    response: 'accepted',
    retained: true,
    allowed: false,
  },
  { status: 'interrupted', phase: 'cancelled', response: 'none', retained: false, allowed: false },
])(
  'turn recovery historical $status/$phase/$response retained=$retained',
  async ({ status, phase, response, retained, allowed }) => {
    const { request, record, userMessage } = retainedTurnFixture(
      response === 'error'
        ? { code: 'network_unavailable', retry: 'after_reconnect', messageKey: 'test.offline' }
        : null,
      status,
    );
    mockState.conversation = {
      ...mockState.conversation!,
      intents: retained
        ? {
            [request.userIntentId]: {
              ...record,
              intent: { ...record.intent, phase },
              response: response === 'accepted' ? createTurnResponse(request) : record.response,
            },
          }
        : {},
    };
    render(<AssistantMessage message={userMessage} />);
    await act(async () => jest.runOnlyPendingTimers());
    expect(mockRuntime.retryTurn).not.toHaveBeenCalled();
    if (allowed) {
      fireEvent.press(screen.getByRole('button', { name: 'Retry this earlier request' }));
      expect(mockRuntime.retryTurn).toHaveBeenCalledTimes(1);
      expect(mockRuntime.retryTurn).toHaveBeenCalledWith(request.userIntentId);
    } else {
      expect(screen.queryByRole('button', { name: 'Retry this earlier request' })).toBeNull();
    }
    expectNoAssistantEffects();
  },
);

test.each<ContractError['retry']>(['after_correction', 'never'])(
  'turn recovery retains local answer-save retry despite %s provider retry policy',
  async (retry) => {
    const { request, record } = retainedTurnFixture(null, 'sending');
    mockState.conversation = {
      ...mockState.conversation!,
      intents: {
        [request.userIntentId]: {
          ...record,
          intent: { ...record.intent, phase: 'awaiting_response' },
        },
      },
    };
    mockState.draft = 'Still here';
    mockState.outcome = {
      kind: 'failed',
      error: { code: 'storage_failure', retry, messageKey: 'test.save_answer' },
      userIntentId: request.userIntentId,
      acceptanceRetry: {
        userIntentId: request.userIntentId,
        response: createTurnResponse(request),
      },
    };
    render(<AssistantScreen />);
    await act(async () => jest.runOnlyPendingTimers());
    expect(screen.getByDisplayValue('Still here')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry this request' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry this earlier request' })).toBeNull();
    expect(
      screen.queryByText(
        'Review the guidance above and edit your message before sending a new request.',
      ),
    ).toBeNull();
    expect(mockRuntime.retryAcceptance).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Save the received answer again' }));
    expect(mockRuntime.retryAcceptance).toHaveBeenCalledTimes(1);
    expect(mockRuntime.retryTurn).not.toHaveBeenCalled();
    expectNoAssistantEffects();
  },
);

test('restored draft remains editable while unpaired, with Send unavailable and no automatic connection call', () => {
  mockState.connection = { status: 'unpaired', generation: 0 };
  mockState.draft = 'My retained request';
  render(<AssistantScreen />);
  expect(screen.getByDisplayValue('My retained request')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Message the assistant'), 'Edited draft');
  expect(mockRuntime.setDraft).toHaveBeenCalledWith('Edited draft');
  expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
  expect(mockRuntime.send).not.toHaveBeenCalled();
});
test('4001 Unicode code points have visible non-truncating limit feedback', () => {
  mockState.draft = '🥑'.repeat(4001);
  render(<AssistantScreen />);
  expect(screen.getByDisplayValue(mockState.draft)).toBeTruthy();
  expect(
    screen.getByText('Message is 1 characters too long. Your text has been kept.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
});
test('a lost connection keeps the saved transcript and draft with a compact route to connection help', () => {
  mockState.conversation = { ...mockState.conversation!, messages: [message] };
  mockState.draft = 'Keep this unfinished question';
  const view = render(<AssistantScreen />);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  mockState.connection = { status: 'reconnect', generation: 2 };
  view.rerender(<AssistantScreen />);
  expect(screen.getByText(message.text)).toBeTruthy();
  expect(screen.getByDisplayValue('Keep this unfinished question')).toBeTruthy();
  expect(screen.queryByText('A little help in the kitchen.')).toBeNull();
  expect(screen.getByText('Connect your laptop to ask CookMate.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Learn more' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/settings',
    params: { section: 'connection' },
  });
  expectNoAssistantEffects();
});

test('ungranted AI sharing stays gated and links to the existing consent settings without changing the draft', () => {
  mockState.aiConsent = { status: 'required' };
  mockState.draft = 'My next question';
  render(<AssistantScreen />);
  expect(screen.getByText('AI sharing is off.')).toBeTruthy();
  expect(screen.getByDisplayValue('My next question')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Allow this data to be sent to Gemini' })).toBeNull();
  for (const label of ['Explore recipes', 'View meal plan', 'Saved preferences']) {
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  }
  fireEvent.press(screen.getByRole('button', { name: 'Learn more' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/settings',
    params: { section: 'connection' },
  });
  expectNoAssistantEffects();
});
test('an older ordered set opens its exact original second recipe without a new search or send', () => {
  render(
    <AssistantMessage
      message={{
        ...message,
        referenceSets: [
          { referenceSetId: 'old-set', messageId: 'assistant1', recipeIds: ['52839', '53064'] },
        ],
      }}
    />,
  );
  const second = screen.getByRole('button', {
    name: `View recipe: 2. ${catalogue.getRecipe('53064')!.title}`,
  });
  fireEvent.press(second);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: '53064' } });
  expect(mockRuntime.send).not.toHaveBeenCalled();
});
test('generated success prose alone displays app-owned no-change status', () => {
  render(<AssistantMessage message={{ ...message, text: 'I saved the recipe!' }} />);
  expect(screen.getByText('No changes were applied by this reply.')).toBeTruthy();
  expect(screen.queryByText(/· saved/)).toBeNull();
});

test('Assistant sources preserve the catalogue warning and distinct deduplicated recipe routes without effects', async () => {
  const conflict = catalogue
    .getRecipe('52982')!
    .annotations.find((note) => note.annotationId === '52982-ingredient-method-conflict')!;
  expect(conflict.note).toBe(
    'The ingredient list and method conflict: the list gives 320g spaghetti, 6 egg yolks and 150g bacon; the method gives 350g spaghetti, 3 whole eggs and 100g pancetta, and also uses parmesan, garlic and butter absent from the list. Review the source before cooking or relying on the shopping list; neither version has been silently selected or verified as complete.',
  );
  const request = createTurnRequest();
  const conversationHeader = { ...header, conversationId: request.conversationId };
  request.message.text = 'Compare the two Alfredo recipes and Carbonara.';
  request.message.sourceSequence = message.sequence - 1;
  request.context.selectedRecipeId = conflict.recipeId;
  const response: AnswerResponse = {
    apiVersion: request.apiVersion,
    catalogue: request.catalogue,
    requestId: request.requestId,
    userIntentId: request.userIntentId,
    intentRevision: request.intentRevision,
    conversationId: request.conversationId,
    conversationGeneration: request.conversationGeneration,
    connectionGeneration: request.connectionGeneration,
    preferenceRevision: request.context.preferences.revision,
    kind: 'answer',
    text: `These recipes have separate source records.\n\n${conflict.note}`,
    sources: [
      { recipeId: '53064', section: 'recipe' },
      { recipeId: '52835', section: 'recipe' },
      { recipeId: '52982', section: 'annotation', annotationId: conflict.annotationId },
      { recipeId: '53064', section: 'ingredient', position: 1 },
    ],
    referenceSets: [],
    memoryUpdate: {
      baseRevision: request.context.memory.projectionRevision,
      baseContextRevision: request.context.memory.baseContextRevision,
      reviews: [{ sourceMessageId: request.message.messageId, disposition: 'non_memory' }],
      entries: [],
    },
  };
  const answer: StoredConversationMessage = {
    ...message,
    messageId: fixtureId(5),
    conversationId: request.conversationId,
    text: response.text,
  };
  const record: StoredAssistantIntent = {
    request,
    response,
    acceptanceEnvelope: {
      assistantMessageId: answer.messageId,
      expectedIntentRevision: request.intentRevision,
    },
    intent: {
      userIntentId: request.userIntentId,
      revision: request.intentRevision + 1,
      phase: 'settled',
      slots: [],
    },
    actionPlan: null,
    guards: {
      conversationId: conversationHeader.conversationId,
      conversationGeneration: conversationHeader.generation,
      contextRevision: conversationHeader.revision,
      connectionGeneration: request.connectionGeneration,
      preferenceRevision: request.context.preferences.revision,
      relativeDateContext: request.context.date,
    },
    slotResults: [],
  };
  mockState.conversation = {
    ...mockState.conversation!,
    header: conversationHeader,
    messages: [answer],
    intents: { [record.intent.userIntentId]: record },
  };
  render(<AssistantMessage message={answer} />);
  expect(screen.getByText(response.text, { exact: true }).props.children).toBe(response.text);
  expect(screen.getAllByRole('button', { name: /^Source: / })).toHaveLength(3);
  expect(screen.getAllByRole('button', { name: 'Source: Fettuccine Alfredo' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Source: Fettucine alfredo' })).toHaveLength(1);
  expect(mockPush).not.toHaveBeenCalled();
  for (const [index, recipeId] of ['53064', '52835', '52982'].entries()) {
    const source = screen.getByRole('button', {
      name: `Source: ${catalogue.getRecipe(recipeId)!.title}`,
    });
    expect(source).toBeEnabled();
    fireEvent.press(source);
    expect(mockPush).toHaveBeenNthCalledWith(index + 1, {
      pathname: '/recipe/[id]',
      params: { id: recipeId, section: 'source' },
    });
  }
  await act(async () => jest.runOnlyPendingTimers());
  expect(mockPush).toHaveBeenCalledTimes(3);
  expect(mockRuntime.send).not.toHaveBeenCalled();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
  expect(mockRuntime.core.reconcile).not.toHaveBeenCalled();
  expect(mockRuntime.reviewContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.persistence.readCurrentActionState).not.toHaveBeenCalled();
  expect(mockState.actionOutcomes).toEqual({});
  expect(record.slotResults).toEqual([]);
  expect(screen.getByText('No changes were applied by this reply.')).toBeTruthy();
  expect(screen.queryByText('Saved results for this request are shown below.')).toBeNull();
});

test('a disconnected transcript names missing messages and preserves exact older reference access', () => {
  const old: StoredConversationMessage = {
    ...message,
    referenceSets: [
      { referenceSetId: 'old-set', messageId: message.messageId, recipeIds: ['52839', '53064'] },
    ],
  };
  mockState.conversation = {
    ...mockState.conversation!,
    messages: [old],
    hasEarlier: true,
    beforeSequence: 70,
    hasHistoryGap: true,
  };
  const view = render(<AssistantScreen />);
  expect(screen.getByText('Some messages are not loaded yet')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Load missing messages' }));
  expect(mockRuntime.reload).toHaveBeenCalledWith(true);
  fireEvent.press(
    screen.getByRole('button', { name: `View recipe: 2. ${catalogue.getRecipe('53064')!.title}` }),
  );
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: '53064' } });
  mockState.conversation = { ...mockState.conversation!, hasHistoryGap: false, beforeSequence: 1 };
  view.rerender(<AssistantScreen />);
  expect(screen.queryByText('Some messages are not loaded yet')).toBeNull();
  expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeTruthy();
  mockState.conversation = { ...mockState.conversation!, hasEarlier: false, beforeSequence: null };
  view.rerender(<AssistantScreen />);
  expect(screen.queryByRole('button', { name: /Load (earlier|missing) messages/ })).toBeNull();
});
test('an actual reconciled receipt replaces proposal status with saved-result wording', () => {
  const request = { message: { messageId: 'user1' } } as AssistantTurnRequest;
  const record = {
    request,
    acceptanceEnvelope: { assistantMessageId: 'assistant1' },
    intent: { userIntentId: 'intent1', phase: 'settled', slots: [] },
    actionPlan: null,
    response: null,
    slotResults: [],
  } as unknown as StoredAssistantIntent;
  mockState.conversation = { ...mockState.conversation!, intents: { intent1: record } };
  mockState.actionOutcomes = {
    intent1: {
      summary: 'complete',
      results: {
        userIntentId: 'intent1',
        slots: [
          {
            slotId: 'slot1',
            result: {
              kind: 'receipt',
              receipt: {
                schemaVersion: 1,
                operationId: 'op1',
                userIntentId: 'intent1',
                payloadFingerprint: 'a'.repeat(64),
                outcome: 'committed',
                committedAt: '2026-09-28T00:00:00Z',
                effects: [],
                shoppingProjection: 'unchanged',
              },
            },
          },
        ],
      },
    },
  };
  render(<AssistantMessage message={message} />);
  expect(screen.getByText('Saved results for this request are shown below.')).toBeTruthy();
  expect(screen.queryByText('No changes were applied by this reply.')).toBeNull();
});

test('an unsupported postcommit correction retains the saved meal and opens the supported Plan route without new effects', async () => {
  const request = createTurnRequest();
  request.message.text = 'Plan Chilli prawn linguine for Monday dinner.';
  request.message.sourceSequence = 1;
  request.context.selectedRecipeId = '52839';
  const placement = { actualDate: '2026-09-28', mealKey: 'dinner' } as const;
  const response: ProposalResponse = {
    ...createTurnResponse(request),
    text: 'Plan Chilli prawn linguine for Monday dinner.',
    sources: [{ recipeId: '52839', section: 'recipe' }],
    proposals: [
      { kind: 'addPlan', recipeId: '52839', placement, expectedTarget: { kind: 'empty' } },
    ],
  };
  const answer: StoredConversationMessage = {
    ...message,
    messageId: fixtureId(5),
    conversationId: request.conversationId,
    text: response.text,
  };
  const origin = {
    conversationId: request.conversationId,
    generation: request.conversationGeneration,
    messageId: request.message.messageId,
  };
  const occurrenceId = fixtureId(12);
  const command: LocalCommand = {
    schemaVersion: 2,
    operationId: fixtureId(11),
    userIntentId: request.userIntentId,
    intentRevision: 2,
    payloadFingerprint: 'a'.repeat(64),
    origin,
    command: {
      kind: 'addPlan',
      occurrenceId,
      recipeId: '52839',
      placement,
      expectedTarget: { kind: 'empty' },
    },
  };
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    operationId: command.operationId,
    userIntentId: command.userIntentId,
    payloadFingerprint: command.payloadFingerprint,
    outcome: 'committed',
    committedAt: '2026-09-28T00:00:00Z',
    effects: [
      {
        kind: 'plan',
        entityId: occurrenceId,
        revision: 1,
        change: 'added',
        recipeId: '52839',
        placement,
      },
    ],
    shoppingProjection: 'unchanged',
  };
  const slotId = fixtureId(10);
  const record: StoredAssistantIntent = {
    request,
    response,
    acceptanceEnvelope: {
      assistantMessageId: answer.messageId,
      expectedIntentRevision: request.intentRevision,
    },
    intent: {
      userIntentId: request.userIntentId,
      revision: 3,
      phase: 'settled',
      origin,
      slots: [{ slotId, command }],
    },
    actionPlan: {
      userIntentId: request.userIntentId,
      revision: 1,
      origin,
      slots: [
        { slotId, operationId: command.operationId, proposalIndex: 0, payload: command.command },
      ],
    },
    guards: {
      conversationId: request.conversationId,
      conversationGeneration: request.conversationGeneration,
      contextRevision: header.revision,
      connectionGeneration: request.connectionGeneration,
      preferenceRevision: request.context.preferences.revision,
      relativeDateContext: request.context.date,
    },
    slotResults: [{ slotId, result: { kind: 'receipt', receipt } }],
  };
  mockState.conversation = {
    ...mockState.conversation!,
    header: { ...header, conversationId: request.conversationId },
    messages: [answer],
    intents: { [record.intent.userIntentId]: record },
  };
  const view = render(<AssistantScreen />);
  const savedMeal = 'Chilli prawn linguine · Monday 28 September 2026 · Dinner';
  expect(screen.getByText(savedMeal)).toBeTruthy();

  // A later failed turn must not relabel or replay the already committed action.
  const correction: StoredConversationMessage = {
    ...answer,
    messageId: fixtureId(21),
    sequence: 3,
    role: 'user',
    text: 'Actually Tuesday, not Monday.',
    status: 'failed',
    createdAt: '2026-09-28T00:01:00Z',
  };
  mockState.conversation = { ...mockState.conversation!, messages: [answer, correction] };
  mockState.outcome = {
    kind: 'failed',
    userIntentId: fixtureId(20),
    error: {
      code: 'unsupported_request',
      messageKey: 'test.unsupported_correction',
      retry: 'never',
    },
  };
  view.rerender(<AssistantScreen />);
  expect(screen.getByText(correction.text)).toBeTruthy();
  expect(screen.getAllByText('Plan Chilli prawn linguine · saved')).toHaveLength(1);
  expect(screen.getAllByText(savedMeal)).toHaveLength(1);
  expect(screen.getByText('Saved results for this request are shown below.')).toBeTruthy();
  expect(screen.getByText('The request needs attention')).toBeTruthy();
  expect(
    screen.getByText(
      'This request is not supported here. Use the recipe, plan or preferences controls.',
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText('Chilli prawn linguine · Tuesday 29 September 2026 · Dinner'),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review proposed changes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review next unfinished change' })).toBeNull();
  expect(mockNavigate).not.toHaveBeenCalled();
  const inspect = screen.getByRole('button', { name: 'Inspect plan' });
  expect(inspect).toBeEnabled();
  fireEvent.press(inspect);
  await act(async () => jest.runOnlyPendingTimers());
  expect(mockNavigate).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith('/plan');
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockRuntime.send).not.toHaveBeenCalled();
  expect(mockRuntime.core.approve).not.toHaveBeenCalled();
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
  expect(mockRuntime.core.reconcile).not.toHaveBeenCalled();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  expect(mockRuntime.reviewContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.persistence.readCurrentActionState).not.toHaveBeenCalled();
  expect(mockState.actionOutcomes).toEqual({});
  expect(record.slotResults).toEqual([{ slotId, result: { kind: 'receipt', receipt } }]);
  expect(screen.getAllByText(savedMeal)).toHaveLength(1);
});

test('three original reservations remain partial until every saved result is confirmed', () => {
  const slots = [1, 2, 3].map((index) => ({
    slotId: `slot${index}`,
    operationId: `op${index}`,
    payload: { kind: 'setFavourite', recipeId: '52839', saved: true },
  }));
  const record = {
    request: { message: { messageId: 'user1' } },
    acceptanceEnvelope: { assistantMessageId: 'assistant1' },
    intent: {
      userIntentId: 'intent1',
      revision: 2,
      phase: 'reconciling',
      slots: [{ slotId: 'slot1', operationId: 'op1' }],
    },
    actionPlan: { slots },
    response: null,
    slotResults: [],
  } as unknown as StoredAssistantIntent;
  mockState.conversation = { ...mockState.conversation!, intents: { intent1: record } };
  const setSavedCount = (count: number) => {
    mockState.historyProofs = {
      intent1: {
        conversationId: header.conversationId,
        conversationGeneration: header.generation,
        userIntentId: 'intent1',
        intentRevision: 2,
        phase: 'reconciling',
        slots: slots.map((slot, index) => ({
          slotId: slot.slotId,
          operationId: slot.operationId,
          outcome: index < count ? 'receipt' : 'not_executed',
          receipt:
            index < count
              ? {
                  schemaVersion: 1,
                  operationId: slot.operationId,
                  userIntentId: 'intent1',
                  payloadFingerprint: 'a'.repeat(64),
                  outcome: 'committed',
                  committedAt: '2026-09-28T00:00:00Z',
                  effects: [],
                  shoppingProjection: 'unchanged',
                }
              : null,
        })),
      },
    };
  };
  setSavedCount(1);
  const view = render(<AssistantMessage message={message} />);
  for (const count of [1, 2]) {
    setSavedCount(count);
    view.rerender(<AssistantMessage message={message} />);
    expect(
      screen.getByText('Some changes are saved. Review the next unfinished change.'),
    ).toBeTruthy();
    expect(screen.getAllByText(/· saved$/)).toHaveLength(count);
    expect(screen.getAllByText(/· not applied$/)).toHaveLength(3 - count);
    expect(screen.queryByText('Saved results for this request are shown below.')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Review next unfinished change' }));
    expect(mockRuntime.reviewContinuation).toHaveBeenLastCalledWith('intent1', 2);
  }
  setSavedCount(3);
  view.rerender(<AssistantMessage message={message} />);
  expect(screen.getByText('Saved results for this request are shown below.')).toBeTruthy();
  expect(screen.getAllByText(/· saved$/)).toHaveLength(3);
  expect(screen.queryByRole('button', { name: 'Review next unfinished change' })).toBeNull();
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();

  setSavedCount(1);
  mockState.conversation = {
    ...mockState.conversation!,
    intents: {
      intent1: { ...record, intent: { ...record.intent, phase: 'cancelled' } },
    },
  };
  view.rerender(<AssistantMessage message={message} />);
  expect(screen.queryByRole('button', { name: 'Review next unfinished change' })).toBeNull();
  expect(
    screen.queryByText('Some changes are saved. Review the next unfinished change.'),
  ).toBeNull();
  expect(
    screen.getAllByText(/This unfinished change was stopped without a saved effect/),
  ).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Check saved results' })).toBeEnabled();
});

test('recovery feedback offers an explicit check without promising a read-only settlement or repeating effects', async () => {
  mockState.recovery = { kind: 'ready', proofs: {}, unresolvedIds: ['intent1'] };
  const view = render(<AssistantRecoveryFeedback />);
  expect(screen.getByText(/Check which changes were saved/)).toBeTruthy();
  expect(screen.queryByText(/Checking only reads saved results/)).toBeNull();
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Check assistant change 1' }));
  });
  expect(mockRuntime.runAction).toHaveBeenCalledWith('intent1', expect.any(Function));
  expect(mockRuntime.core.reconcile).toHaveBeenCalledWith('intent1');
  expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
  expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  expect(mockRuntime.cancel).not.toHaveBeenCalled();
  mockState.busy = true;
  view.rerender(<AssistantRecoveryFeedback />);
  expect(screen.getByRole('button', { name: 'Check assistant change 1' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Stop unfinished assistant change 1' })).toBeDisabled();
});
test.each(['after_reconnect', 'reconcile'] as const)(
  'a not-applied proof preserves the %s failure reason and routes retry through review only',
  (retry) => {
    const record = {
      request: { message: { messageId: 'user1' } },
      acceptanceEnvelope: { assistantMessageId: 'assistant1' },
      intent: { userIntentId: 'intent1', revision: 2, phase: 'reconciling', slots: [] },
      actionPlan: { slots: [{ slotId: 'slot1', payload: { kind: 'addPlan', recipeId: '52839' } }] },
      response: null,
      slotResults: [
        {
          slotId: 'slot1',
          result: {
            kind: 'failed',
            operationId: 'op1',
            error: { code: 'network_unavailable', messageKey: 'test.offline', retry },
          },
        },
      ],
    } as unknown as StoredAssistantIntent;
    mockState.conversation = { ...mockState.conversation!, intents: { intent1: record } };
    mockState.historyProofs = {
      intent1: {
        conversationId: header.conversationId,
        conversationGeneration: 0,
        userIntentId: 'intent1',
        intentRevision: 2,
        phase: 'reconciling',
        slots: [{ slotId: 'slot1', operationId: 'op1', outcome: 'not_executed', receipt: null }],
      },
    };
    render(<AssistantMessage message={message} />);
    expect(
      screen.getByText(
        'Earlier attempt: The laptop could not be reached. Check that it is awake and on the right network.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Saved results confirm this change was not applied.')).toBeTruthy();
    expect(
      screen.queryByText(
        'The outcome of these changes is not yet confirmed. Check the saved results below.',
      ),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry unfinished changes' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Review next unfinished change' }));
    expect(mockRuntime.reviewContinuation).toHaveBeenCalledWith('intent1', 2);
    expect(mockRuntime.core.dispatch).not.toHaveBeenCalled();
    expect(mockRuntime.confirmContinuation).not.toHaveBeenCalled();
  },
);

test('a confirmed continuation receipt with unavailable history confirms only that change', () => {
  const record = {
    request: { message: { messageId: 'user1' } },
    acceptanceEnvelope: { assistantMessageId: 'assistant1' },
    intent: { userIntentId: 'intent1', revision: 2, phase: 'reconciling', slots: [] },
    response: null,
    slotResults: [],
  } as unknown as StoredAssistantIntent;
  mockState.conversation = { ...mockState.conversation!, intents: { intent1: record } };
  mockState.continuationOutcomes = {
    intent1: {
      command: {
        schemaVersion: 2,
        operationId: 'op1',
        userIntentId: 'intent1',
        intentRevision: 2,
        payloadFingerprint: 'a'.repeat(64),
        command: { kind: 'setFavourite', recipeId: '52839', saved: true },
      },
      result: {
        kind: 'receipt',
        receipt: {
          schemaVersion: 1,
          operationId: 'op1',
          userIntentId: 'intent1',
          payloadFingerprint: 'a'.repeat(64),
          outcome: 'committed',
          committedAt: '2026-09-28T00:00:00.000Z',
          effects: [],
          shoppingProjection: 'unchanged',
        },
      },
      actionOutcome: null,
      recoveryError: { code: 'storage_failure', messageKey: 'test.unreadable', retry: 'reconcile' },
    },
  };
  const view = render(<AssistantMessage message={message} />);
  expect(screen.getByText('The saved result for this change is confirmed.')).toBeTruthy();
  expect(
    screen.getByText('Some changes are saved; other results still need checking.'),
  ).toBeTruthy();
  expect(
    screen.getByText(/The remaining results for this request could not be confirmed/),
  ).toBeTruthy();
  expect(screen.queryByText('No changes were applied by this reply.')).toBeNull();
  mockState.actionOutcomes = {
    intent1: {
      summary: 'complete',
      results: {
        userIntentId: 'intent1',
        slots: [{ slotId: 'slot1', result: mockState.continuationOutcomes.intent1!.result }],
      },
    },
  };
  view.rerender(<AssistantMessage message={message} />);
  expect(screen.getByText('The saved result for this change is confirmed.')).toBeTruthy();
  expect(screen.getByText('Saved results for this request are shown below.')).toBeTruthy();
  expect(
    screen.queryByText(/The remaining results for this request could not be confirmed/),
  ).toBeNull();
  const attempt = mockState.continuationOutcomes.intent1!;
  if (attempt.result.kind !== 'receipt') throw new Error('Expected fixture receipt');
  mockState.actionOutcomes = {};
  mockState.conversation = {
    ...mockState.conversation!,
    intents: {
      intent1: {
        ...record,
        actionPlan: {
          slots: [
            {
              slotId: 'slot1',
              operationId: 'op1',
              payload: { kind: 'setFavourite', recipeId: '52839', saved: true },
            },
          ],
        },
      } as unknown as StoredAssistantIntent,
    },
  };
  mockState.historyProofs = {
    intent1: {
      conversationId: header.conversationId,
      conversationGeneration: 0,
      userIntentId: 'intent1',
      intentRevision: 2,
      phase: 'reconciling',
      slots: [
        {
          slotId: 'slot1',
          operationId: 'op1',
          outcome: 'receipt',
          receipt: attempt.result.receipt,
        },
      ],
    },
  };
  view.rerender(<AssistantMessage message={message} />);
  expect(
    screen.queryByText(/The remaining results for this request could not be confirmed/),
  ).toBeNull();
  mockState.historyProofs = {
    intent1: {
      ...mockState.historyProofs.intent1!,
      slots: [
        {
          slotId: 'slot1',
          operationId: 'another-operation',
          outcome: 'receipt',
          receipt: attempt.result.receipt,
        },
      ],
    },
  };
  view.rerender(<AssistantMessage message={message} />);
  expect(
    screen.getByText(/The remaining results for this request could not be confirmed/),
  ).toBeTruthy();
});

test('compact Settings has named product controls with no diagnostic dashboard', () => {
  render(<SettingsScreen />);
  for (const label of [
    'Saved preferences',
    'Conversation',
    'AI connection',
    'Help',
    'Data & privacy',
  ])
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  expect(screen.queryByText('Development evidence')).toBeNull();
  expect(screen.queryByText('Native diagnostic checks')).toBeNull();
});

test.each(['unknown', 'stopped', 'receipt', 'partial'] as const)(
  'restored %s execution uses durable recovery proof without claiming unknown changes were not applied',
  (outcome) => {
    const receipt = {
      schemaVersion: 1 as const,
      operationId: 'op1',
      userIntentId: 'intent1',
      payloadFingerprint: 'a'.repeat(64),
      outcome: 'committed' as const,
      committedAt: '2026-09-28T00:00:00Z',
      effects: [],
      shoppingProjection: 'unchanged' as const,
    };
    const record = {
      request: { message: { messageId: 'user1' } },
      acceptanceEnvelope: { assistantMessageId: 'assistant1' },
      intent: { userIntentId: 'intent1', phase: 'reconciling', slots: [] },
      actionPlan: { slots: [] },
      response: null,
      slotResults: [],
    } as unknown as StoredAssistantIntent;
    mockState.conversation = { ...mockState.conversation!, intents: { intent1: record } };
    mockState.recovery = {
      kind: 'ready',
      unresolvedIds: outcome === 'unknown' || outcome === 'partial' ? ['intent1'] : [],
      proofs: {
        intent1: {
          conversationId: header.conversationId,
          conversationGeneration: header.generation,
          userIntentId: 'intent1',
          intentRevision: 1,
          phase: 'reconciling',
          slots: [
            {
              slotId: 'slot1',
              operationId: 'op1',
              outcome:
                outcome === 'unknown'
                  ? 'unresolved'
                  : outcome === 'stopped'
                    ? 'not_executed'
                    : 'receipt',
              receipt: outcome === 'receipt' || outcome === 'partial' ? receipt : null,
            },
            ...(outcome === 'partial'
              ? [
                  {
                    slotId: 'slot2',
                    operationId: 'op2',
                    outcome: 'unresolved' as const,
                    receipt: null,
                  },
                ]
              : []),
          ],
        },
      },
    };
    render(<AssistantMessage message={message} />);
    if (outcome === 'unknown' || outcome === 'partial') {
      expect(screen.getByText('Requested change · result unknown')).toBeTruthy();
      expect(screen.queryByText('No changes were applied by this reply.')).toBeNull();
      expect(
        screen.getByText(
          outcome === 'partial'
            ? 'Some changes are saved; other results still need checking.'
            : 'The outcome of these changes is not yet confirmed. Check the saved results below.',
        ),
      ).toBeTruthy();
    }
    if (outcome === 'stopped')
      expect(screen.getByText('Requested change · not applied')).toBeTruthy();
    if (outcome === 'receipt' || outcome === 'partial')
      expect(screen.getByText('Requested change · saved')).toBeTruthy();
    expect(mockRuntime.send).not.toHaveBeenCalled();
  },
);
test('paired connection status does not claim provider health or auto-send a draft', () => {
  mockState.draft = 'Keep me';
  render(<ConnectionSettings />);
  expect(screen.getByText('Paired with your laptop')).toBeTruthy();
  expect(screen.getByText(/Pairing shows saved access/)).toBeTruthy();
  expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
  expect(mockRuntime.send).not.toHaveBeenCalled();
});

test('connection details require explicit reveal and hide without starting an action', () => {
  const clientId = 'synthetic-client-operator-test';
  mockState.connection = { status: 'paired', generation: 1, clientId };
  render(<ConnectionSettings />);
  const show = screen.getByRole('button', { name: 'Show connection details' });
  expect(show.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
  expect(screen.queryByText('Client ID')).toBeNull();
  expect(screen.queryByText(clientId)).toBeNull();
  fireEvent.press(show);
  const hide = screen.getByRole('button', { name: 'Hide connection details' });
  expect(hide.props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
  expect(screen.getByText('Client ID')).toBeTruthy();
  expect(screen.getByText(clientId).props.selectable).toBe(true);
  expect(
    screen.getByText(
      'Share this non-secret ID with the laptop operator to identify this connection.',
    ),
  ).toBeTruthy();
  fireEvent.press(hide);
  expect(
    screen.getByRole('button', { name: 'Show connection details' }).props.accessibilityState,
  ).toEqual(expect.objectContaining({ expanded: false }));
  expect(screen.queryByText('Client ID')).toBeNull();
  expect(screen.queryByText(clientId)).toBeNull();
  expect(screen.getByRole('button', { name: 'Disconnect this iPhone' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Disconnect and revoke access' })).toBeEnabled();
  expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
  expect(mockRuntime.send).not.toHaveBeenCalled();
  expect(mockRuntime.runAction).not.toHaveBeenCalled();
  expect(mockRuntime.invalidate).not.toHaveBeenCalled();
});

test.each([
  { label: 'paired without an ID', connection: { status: 'paired', generation: 1 } },
  {
    label: 'paired with an empty ID',
    connection: { status: 'paired', generation: 1, clientId: '' },
  },
  {
    label: 'unpaired with a retained ID',
    connection: { status: 'unpaired', generation: 1, clientId: 'synthetic-stale-client' },
  },
  {
    label: 'reconnect with a retained ID',
    connection: { status: 'reconnect', generation: 1, clientId: 'synthetic-stale-client' },
  },
] as const)('connection details are unavailable when $label', ({ connection }) => {
  mockState.connection = connection;
  render(<ConnectionSettings />);
  expect(screen.queryByRole('button', { name: 'Show connection details' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hide connection details' })).toBeNull();
  expect(screen.queryByText('Client ID')).toBeNull();
  expect(screen.queryByText('synthetic-stale-client')).toBeNull();
  expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
});

test.each(['generation', 'client ID', 'unpaired', 'reconnect', 'missing ID'] as const)(
  'revealed connection details reset after a %s change',
  (changed) => {
    const originalId = 'synthetic-client-before';
    const replacementId = 'synthetic-client-after';
    mockState.connection = { status: 'paired', generation: 1, clientId: originalId };
    const view = render(<ConnectionSettings />);
    fireEvent.press(screen.getByRole('button', { name: 'Show connection details' }));
    expect(screen.getByText(originalId)).toBeTruthy();
    if (changed === 'generation') mockState.connection = { ...mockState.connection, generation: 2 };
    else if (changed === 'client ID')
      mockState.connection = { ...mockState.connection, clientId: replacementId };
    else if (changed === 'missing ID') mockState.connection = { status: 'paired', generation: 1 };
    else mockState.connection = { ...mockState.connection, status: changed };
    view.rerender(<ConnectionSettings />);
    expect(screen.queryByText(originalId)).toBeNull();
    expect(screen.queryByText(replacementId)).toBeNull();
    expect(screen.queryByText('Client ID')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide connection details' })).toBeNull();
    if (changed === 'generation' || changed === 'client ID') {
      const show = screen.getByRole('button', { name: 'Show connection details' });
      expect(show.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
      fireEvent.press(show);
      expect(screen.getByText(changed === 'client ID' ? replacementId : originalId)).toBeTruthy();
    } else {
      expect(screen.queryByRole('button', { name: 'Show connection details' })).toBeNull();
      mockState.connection = { status: 'paired', generation: 2, clientId: replacementId };
      view.rerender(<ConnectionSettings />);
      expect(
        screen.getByRole('button', { name: 'Show connection details' }).props.accessibilityState,
      ).toEqual(expect.objectContaining({ expanded: false }));
      expect(screen.queryByText(replacementId)).toBeNull();
    }
    expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
  },
);

test('unconfirmed revocation notice stays selectable after local erasure without stale paired details', () => {
  const oldClientId = 'synthetic-client-disconnected';
  mockState.connection = { status: 'paired', generation: 1, clientId: oldClientId };
  const view = render(<ConnectionSettings />);
  fireEvent.press(screen.getByRole('button', { name: 'Show connection details' }));
  expect(screen.getByText(oldClientId).props.selectable).toBe(true);
  const notice =
    `Disconnected on this iPhone. The laptop has not confirmed revocation; access may already have been revoked. ` +
    `Give the laptop operator this client ID to check or revoke: ${oldClientId}.`;
  mockState.connection = { status: 'unpaired', generation: 2 };
  mockState.connectionNotice = notice;
  view.rerender(<ConnectionSettings />);
  expect(screen.getByText('Not paired')).toBeTruthy();
  expect(screen.getByText('Connection result')).toBeTruthy();
  expect(screen.getByText(notice).props.selectable).toBe(true);
  expect(screen.queryByText(oldClientId)).toBeNull();
  expect(screen.queryByText('Client ID')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show connection details' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hide connection details' })).toBeNull();
  expect(mockRuntime.connectionAction).not.toHaveBeenCalled();
  expect(mockRuntime.send).not.toHaveBeenCalled();
});

test('context recovery requires explicit choice, exposes whole related quotes and checkbox semantics', async () => {
  const items: MemoryItem[] = [
    {
      memoryId: 'm1',
      revision: 1,
      sourceMessageId: 'u1',
      sourceSequence: 1,
      sourceDateContext: date,
      preferenceRevisionAtSource: 0,
      preferenceLinks: [],
      quote: 'Use rice for this task.',
      kind: 'constraint',
      scope: { kind: 'conversation' },
      relations: [],
    },
    {
      memoryId: 'm2',
      revision: 1,
      sourceMessageId: 'u2',
      sourceSequence: 2,
      sourceDateContext: date,
      preferenceRevisionAtSource: 0,
      preferenceLinks: [],
      quote: 'Actually, use pasta instead.',
      kind: 'correction',
      scope: { kind: 'conversation' },
      relations: [
        { kind: 'supersedes', target: { kind: 'memory', memoryId: 'm1', expectedRevision: 1 } },
      ],
    },
  ];
  const page: ConversationMemoryPage = {
    header,
    items,
    workingContext: { afterSequence: null, carryMemoryIds: [] },
    beforeSequence: null,
    hasEarlier: false,
  };
  const narrowing: ContextNarrowing = {
    kind: 'narrowing',
    revision: 8,
    reason: 'entry_limit',
    workingContext: page.workingContext,
    coverage: {
      retainedEntryCount: 2,
      suppliedEntryCount: 0,
      omittedEntryCount: 2,
      pendingUserSourceCount: 1,
      pendingWorkingSourceCount: 1,
      suppliedReviewTargetCount: 0,
      selectionStatus: 'narrowing_required',
    },
  };
  jest.mocked(mockRuntime.core.readMemoryPage).mockResolvedValue(ready(page));
  render(<WorkingContext narrowing={narrowing} />);
  expect(mockRuntime.core.setWorkingContext).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Review working context' })),
  );
  expect(screen.getByText('“Use rice for this task.”')).toBeTruthy();
  expect(screen.getByText('“Actually, use pasta instead.”')).toBeTruthy();
  fireEvent.press(screen.getByRole('checkbox', { name: 'Carry these related statements' }));
  expect(screen.getByRole('checkbox', { name: 'Remove these related statements' })).toBeChecked();
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Use selected context for this task' })),
  );
  expect(mockRuntime.core.setWorkingContext).toHaveBeenCalledWith({
    expectedContextRevision: 8,
    afterSequence: 9,
    carryMemoryIds: ['m1', 'm2'],
  });
  expect(mockRuntime.send).not.toHaveBeenCalled();
});
test('stale proposal approval never skips the owner check or dispatches after it rejects', async () => {
  const proposal = {
    kind: 'proposal',
    proposals: [
      {
        kind: 'addPlan',
        recipeId: '52839',
        placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
        expectedTarget: { kind: 'occupied', occurrenceId: 'meal1', expectedRevision: 2 },
      },
    ],
  } as unknown as ProposalResponse;
  const record = {
    response: proposal,
    intent: { userIntentId: 'intent1', revision: 1, phase: 'confirmation', slots: [] },
  } as unknown as StoredAssistantIntent;
  const approve = jest.fn(async () => {
    throw new Error('stale');
  });
  const dispatch = jest.fn();
  jest.mocked(mockRuntime.persistence.readCurrentActionState).mockResolvedValue(
    ready({
      guards: {
        conversationId: 'conversation',
        conversationGeneration: 0,
        contextRevision: 8,
        connectionGeneration: 1,
        preferenceRevision: 0,
        relativeDateContext: date,
      },
      planOccurrences: [
        {
          occurrenceId: 'meal1',
          recipeId: '53064',
          revision: 2,
          createdAt: '2026-09-28T00:00:00Z',
          updatedAt: '2026-09-28T00:00:00Z',
          placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
        },
      ],
      shoppingScope: { scopeId: 'scope', revision: 4, occurrenceIds: ['meal1'] },
    }),
  );
  mockRuntime.core.approve = approve;
  mockRuntime.core.dispatch = dispatch;
  mockRuntime.runAction = jest.fn(async (_id, operation) => {
    try {
      await operation();
    } catch {
      /* owner rejects in this synthetic case */
    }
  });
  render(<ProposalReview record={record} />);
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Review proposed changes' })),
  );
  expect(screen.getByText(/This meal stays selected for shopping/)).toBeTruthy();
  const oldApprove = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Apply these changes')!.props.onPress as () => void;
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Apply these changes' })),
  );
  expect(approve).toHaveBeenCalledWith(
    'intent1',
    expect.objectContaining({
      source: 'explicit_user',
      replacementConfirmations: [
        expect.objectContaining({
          occurrenceId: 'meal1',
          expectedRevision: 2,
          expectedShoppingScopeRevision: 4,
          currentRecipeId: '53064',
          replacementRecipeId: '52839',
          includedInShopping: true,
        }),
      ],
    }),
  );
  expect(dispatch).not.toHaveBeenCalled();
  act(oldApprove);
  expect(approve).toHaveBeenCalledTimes(1);
});

describe('Assistant transcript scrolling', () => {
  const scrollSpies: jest.SpyInstance[] = [];
  const initialMessages: StoredConversationMessage[] = [
    { ...message, messageId: 'scroll-message-2', sequence: 2, text: 'Earlier visible answer.' },
    { ...message, messageId: 'scroll-message-3', sequence: 3, text: 'Latest restored answer.' },
  ];

  function transcript(
    ui: Parameters<typeof render>[0] = <AssistantScreen />,
    messages: StoredConversationMessage[] = initialMessages,
  ) {
    mockState.conversation = {
      ...mockState.conversation!,
      messages,
      hasEarlier: messages.length > 0,
      beforeSequence: messages.length > 0 ? 2 : null,
    };
    const view = render(ui);
    // Keep the real FlatList and screen event handlers. Only intercept imperative native motion.
    const list = view.UNSAFE_getByType(FlatList);
    const instance = list.instance as FlatList<StoredConversationMessage>;
    const toEnd = jest.spyOn(instance, 'scrollToEnd').mockImplementation(() => undefined);
    const toOffset = jest.spyOn(instance, 'scrollToOffset').mockImplementation(() => undefined);
    scrollSpies.push(toEnd, toOffset);
    return {
      view,
      list,
      toEnd,
      toOffset,
      layout: (contentHeight = 1800) => {
        fireEvent(list, 'layout', {
          nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } },
        });
        fireEvent(list, 'contentSizeChange', 390, contentHeight);
      },
      scroll: (offset: number, contentHeight = 1800) => {
        fireEvent.scroll(list, {
          nativeEvent: {
            contentOffset: { x: 0, y: offset },
            layoutMeasurement: { width: 390, height: 600 },
            contentSize: { width: 390, height: contentHeight },
          },
        });
      },
    };
  }

  async function finishScrollFrame() {
    await act(async () => jest.advanceTimersByTime(64));
  }

  afterEach(() => {
    // Cancel the screen's scheduled frame before restoring its native-method spies.
    cleanup();
    scrollSpies.splice(0).forEach((spy) => spy.mockRestore());
  });

  test('an overflowing empty welcome stays at the top through layout notifications, then the first message follows', async () => {
    const chat = transcript(<AssistantScreen />, []);
    chat.layout(1500);
    await finishScrollFrame();
    expect(chat.toEnd).not.toHaveBeenCalled();
    expect(chat.toOffset).not.toHaveBeenCalled();
    expect(screen.getByText('A little help in the kitchen.')).toBeTruthy();

    // Native geometry notifications are not a user choosing to read older messages.
    chat.scroll(0, 1700);
    fireEvent(chat.list, 'contentSizeChange', 390, 1700);
    await finishScrollFrame();
    chat.scroll(0, 1700);
    expect(chat.toEnd).not.toHaveBeenCalled();
    expect(chat.toOffset).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /go to latest/i })).toBeNull();

    mockState.conversation = {
      ...mockState.conversation!,
      messages: [
        {
          ...message,
          messageId: 'first-saved-message',
          sequence: 0,
          role: 'user',
          text: 'My first saved question.',
        },
      ],
    };
    chat.view.rerender(<AssistantScreen />);
    fireEvent(chat.list, 'contentSizeChange', 390, 1900);
    await finishScrollFrame();
    expect(chat.toEnd).toHaveBeenCalledWith({ animated: false });
    expect(screen.getByText('My first saved question.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /go to latest/i })).toBeNull();
    expectNoAssistantEffects();
  });

  test('a restored conversation waits for usable layout, then positions at the latest message', async () => {
    const chat = transcript();
    await finishScrollFrame();
    expect(chat.toEnd).not.toHaveBeenCalled();
    chat.layout();
    await finishScrollFrame();
    expect(chat.toEnd).toHaveBeenCalledWith({ animated: false });
    expect(chat.toOffset).not.toHaveBeenCalled();
    expect(screen.getByText('Latest restored answer.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /go to latest/i })).toBeNull();
    expectNoAssistantEffects();
  });

  test('new content follows a reader near the bottom even when its new geometry arrives before content-size notification', async () => {
    const chat = transcript();
    chat.layout();
    await finishScrollFrame();
    chat.scroll(1180);
    chat.toEnd.mockClear();
    chat.toOffset.mockClear();
    mockState.conversation = {
      ...mockState.conversation!,
      messages: [
        ...initialMessages,
        {
          ...message,
          messageId: 'scroll-message-4',
          sequence: 4,
          text: 'A newly received answer.',
        },
      ],
    };
    chat.view.rerender(<AssistantScreen />);
    chat.scroll(1180, 2200);
    fireEvent(chat.list, 'contentSizeChange', 390, 2200);
    await finishScrollFrame();
    expect(chat.toEnd).toHaveBeenCalledWith({ animated: false });
    expect(chat.toOffset).not.toHaveBeenCalled();
    expect(screen.getByText('A newly received answer.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /go to latest/i })).toBeNull();

    // A recipe card can grow after the answer was already received, with no new message ID.
    chat.toEnd.mockClear();
    chat.scroll(1600, 2600);
    fireEvent(chat.list, 'contentSizeChange', 390, 2600);
    await finishScrollFrame();
    expect(chat.toEnd).toHaveBeenCalledWith({ animated: false });
    expect(screen.queryByRole('button', { name: /go to latest/i })).toBeNull();
    expectNoAssistantEffects();
  });

  test('reading and prepending older history do not force scrolling; a later reply offers an explicit jump to latest', async () => {
    const chat = transcript();
    chat.layout();
    await finishScrollFrame();
    fireEvent(chat.list, 'scrollBeginDrag');
    chat.scroll(160);
    fireEvent(chat.list, 'scrollEndDrag');
    chat.toEnd.mockClear();
    chat.toOffset.mockClear();
    expect(screen.getByRole('button', { name: 'Go to latest' })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(mockRuntime.reload).toHaveBeenCalledWith(true);
    const older = {
      ...message,
      messageId: 'scroll-message-1',
      sequence: 1,
      text: 'Previously unloaded history.',
    };
    mockState.conversation = {
      ...mockState.conversation!,
      messages: [older, ...initialMessages],
      hasEarlier: false,
      beforeSequence: null,
    };
    chat.view.rerender(<AssistantScreen />);
    fireEvent(chat.list, 'contentSizeChange', 390, 2200);
    // Model the native list preserving the visible item after a 400-pixel prepend.
    chat.scroll(560, 2200);
    await finishScrollFrame();
    expect(chat.toEnd).not.toHaveBeenCalled();
    expect(chat.toOffset).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'New messages · go to latest' })).toBeNull();

    mockState.conversation = {
      ...mockState.conversation!,
      messages: [
        ...mockState.conversation!.messages,
        {
          ...message,
          messageId: 'scroll-message-4',
          sequence: 4,
          text: 'New answer while reading.',
        },
      ],
    };
    chat.view.rerender(<AssistantScreen />);
    fireEvent(chat.list, 'contentSizeChange', 390, 2600);
    await finishScrollFrame();
    expect(chat.toEnd).not.toHaveBeenCalled();
    expect(chat.toOffset).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'New messages · go to latest' }));
    await finishScrollFrame();
    expect(chat.toEnd).toHaveBeenCalledTimes(1);
    expect(chat.toEnd).toHaveBeenCalledWith({ animated: false });
    expect(screen.queryByRole('button', { name: /go to latest/i })).toBeNull();
    expectNoAssistantEffects();
  });

  function SearchHandoffScreen() {
    const { openSearch } = useAssistantEntry();
    return (
      <>
        <ActionButton label="Stage a pasta search" onPress={() => openSearch({ query: 'pasta' })} />
        <AssistantScreen />
      </>
    );
  }

  test('a new search question takes priority over a simultaneous new reply and remains visible through later layout growth', async () => {
    const chat = transcript(<SearchHandoffScreen />);
    chat.layout();
    await finishScrollFrame();
    chat.toEnd.mockClear();
    chat.toOffset.mockClear();
    fireEvent.press(screen.getByRole('button', { name: 'Stage a pasta search' }));
    mockState.conversation = {
      ...mockState.conversation!,
      messages: [
        ...initialMessages,
        {
          ...message,
          messageId: 'scroll-message-4',
          sequence: 4,
          text: 'Answer arriving with context.',
        },
      ],
    };
    chat.view.rerender(<SearchHandoffScreen />);
    fireEvent(chat.list, 'contentSizeChange', 390, 2400);
    await finishScrollFrame();
    expect(chat.toOffset).toHaveBeenCalledTimes(1);
    expect(chat.toOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    expect(chat.toEnd).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Suggested question from your search')).toHaveDisplayValue(
      'Help me choose a recipe for “pasta”.',
    );
    chat.scroll(0, 2400);
    fireEvent(chat.list, 'contentSizeChange', 390, 2450);
    await finishScrollFrame();
    expect(chat.toOffset).toHaveBeenCalledTimes(1);
    expect(chat.toEnd).not.toHaveBeenCalled();
    expect(mockRuntime.setDraft).not.toHaveBeenCalled();
    expectNoAssistantEffects();
  });
});
