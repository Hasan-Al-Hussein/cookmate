import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { SearchCriteria } from '@cookmate/domain';
import { DiscoverProvider, useDiscoverState } from '../discover/DiscoverState';
import { AssistantEntryProvider, useAssistantEntry } from './AssistantEntryState';
import { AssistantSearchContext } from './AssistantSearchContext';
import { AssistantComposer } from './AssistantPresentation';

// This harness exercises provider lifetime across screen-content changes, not Expo routing.
// The context, composer, discovery state and question-building helpers remain real.
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));

interface Probe {
  entry: ReturnType<typeof useAssistantEntry>;
  discover: ReturnType<typeof useDiscoverState>;
}
let observed: Probe | undefined;
function current() {
  if (!observed) throw new Error('The handoff providers are not mounted');
  return observed;
}

function Workbench({
  visible,
  editable,
  onDraftChange,
  onSend,
  draftOnly = false,
}: {
  visible: boolean;
  editable: boolean;
  onDraftChange(text: string): void;
  onSend(): void;
  draftOnly?: boolean;
}) {
  const entry = useAssistantEntry();
  const discover = useDiscoverState();
  observed = { entry, discover };
  const changeDraft = (text: string) => {
    onDraftChange(text);
    entry.setPreviewDraft(text);
  };
  return (
    <>
      {visible && (
        <AssistantSearchContext
          draft={entry.previewDraft}
          onChangeDraft={changeDraft}
          editable={editable}
          draftOnly={draftOnly}
        />
      )}
      <AssistantComposer
        value={entry.previewDraft}
        onChangeText={changeDraft}
        onSend={onSend}
        editable={editable}
        sendDisabled
      />
    </>
  );
}

function fixture(draft = '', editable = true, draftOnly = false) {
  const onDraftChange = jest.fn();
  const onSend = jest.fn();
  const tree = (visible: boolean) => (
    <DiscoverProvider>
      <AssistantEntryProvider>
        <Workbench
          visible={visible}
          editable={editable}
          onDraftChange={onDraftChange}
          onSend={onSend}
          draftOnly={draftOnly}
        />
      </AssistantEntryProvider>
    </DiscoverProvider>
  );
  const view = render(tree(true));
  act(() => current().entry.setPreviewDraft(draft));
  return {
    onDraftChange,
    onSend,
    showContext: (visible: boolean) => view.rerender(tree(visible)),
    applyCriteria: (criteria: SearchCriteria, offset = 734) => {
      act(() => {
        current().discover.setCriteria(criteria);
        current().discover.setScrollOffset(offset);
      });
    },
    openSearch: () => act(() => current().entry.openSearch(current().discover.criteria)),
  };
}

function question() {
  return screen.getByLabelText('Suggested question from your search');
}
function addQuestion() {
  return screen.getByRole('button', { name: 'Add question to draft' });
}
function expectDraft(text: string) {
  expect(current().entry.previewDraft).toBe(text);
  expect(screen.getByLabelText('Message the assistant')).toHaveDisplayValue(text);
}

afterEach(() => {
  cleanup();
  observed = undefined;
});

test('handoff copies applied search criteria and ingredient selections instead of retaining aliases', () => {
  const workbench = fixture('Keep my separate question.');
  const ingredients = ['Prawns', 'Chilli'];
  const applied = { query: '  pasta  ', category: 'Pasta', cuisine: 'Italian', ingredients };
  workbench.applyCriteria(applied);
  workbench.openSearch();
  const search = current().entry.search!;
  expect(search.criteria).not.toBe(applied);
  expect(search.criteria.ingredients).not.toBe(ingredients);
  expect(search.criteria).toEqual(applied);
  expect(search.question).toContain('“pasta”');
  expect(search.question).toContain('category: Pasta');
  expect(search.question).toContain('cuisine: Italian');
  expect(search.question).toContain('ingredients: Prawns, Chilli');

  // An external caller mutating its former input must not rewrite the staged question/context.
  applied.query = 'changed outside the handoff';
  ingredients.push('Chicken');
  act(() => current().entry.setQuestion('A deliberate edit to the suggested question.'));
  expect(current().entry.search!.criteria).toEqual({
    query: '  pasta  ',
    category: 'Pasta',
    cuisine: 'Italian',
    ingredients: ['Prawns', 'Chilli'],
  });
  expectDraft('Keep my separate question.');
  expect(workbench.onDraftChange).not.toHaveBeenCalled();
  expect(workbench.onSend).not.toHaveBeenCalled();
});

test('appearing, editing, leaving and removing search context never overwrite or send the draft', () => {
  const draft = '  Keep this exact draft\nincluding its spacing. 🍋  ';
  const workbench = fixture(draft);
  const applied = { query: 'lentils', cuisine: 'Indian', ingredients: ['Garlic'] };
  workbench.applyCriteria(applied);
  workbench.openSearch();
  expectDraft(draft);
  fireEvent.changeText(question(), 'Can you help me compare these recipes?');
  expectDraft(draft);
  workbench.showContext(false);
  workbench.showContext(true);
  expect(question()).toHaveDisplayValue('Can you help me compare these recipes?');
  fireEvent.press(screen.getByRole('button', { name: /^Remove context: Search:/ }));
  expect(current().entry.search).toBeNull();
  expect(screen.queryByLabelText('Suggested question from your search')).toBeNull();
  expectDraft(draft);
  expect(current().discover.criteria).toBe(applied);
  expect(current().discover.scrollOffset.current).toBe(734);
  expect(workbench.onDraftChange).not.toHaveBeenCalled();
  expect(workbench.onSend).not.toHaveBeenCalled();
});

test('explicit insertion appends the edited question once, preserves the exact draft and keeps the Discover return state', () => {
  const draft = '  My unfinished thought\nneeds to stay.  ';
  const edited = '  Which pasta recipe would use these ingredients? 🍋  ';
  const workbench = fixture(draft);
  const applied = { query: 'pasta', category: 'Seafood', ingredients: ['Prawns'] };
  workbench.applyCriteria(applied, 910);
  workbench.openSearch();
  fireEvent.changeText(question(), edited);
  expectDraft(draft);
  fireEvent.press(addQuestion());
  const combined = `${draft}\n\n${edited}`;
  expectDraft(combined);
  expect(workbench.onDraftChange.mock.calls).toEqual([[combined]]);
  expect(workbench.onSend).not.toHaveBeenCalled();
  expect(current().entry.search).toBeNull();
  workbench.showContext(false);
  workbench.showContext(true);
  expect(screen.queryByRole('button', { name: 'Add question to draft' })).toBeNull();
  expectDraft(combined);
  expect(workbench.onDraftChange).toHaveBeenCalledTimes(1);
  expect(current().discover.criteria).toBe(applied);
  expect(current().discover.scrollOffset.current).toBe(910);
});

test('combined message length counts code points and separators, rejects overflow without consuming context, and accepts exactly 4000', () => {
  const draft = '🍋'.repeat(3997);
  const workbench = fixture(draft);
  workbench.applyCriteria({ query: 'lemon' });
  workbench.openSearch();
  fireEvent.changeText(question(), '🍋🍋');
  expect(addQuestion()).toBeDisabled();
  fireEvent.press(addQuestion());
  expectDraft(draft);
  expect(current().entry.search).not.toBeNull();
  expect(workbench.onDraftChange).not.toHaveBeenCalled();
  expect(screen.getByText(/Nothing has been replaced\./)).toBeTruthy();

  fireEvent.changeText(question(), '🍋');
  expect(addQuestion()).toBeEnabled();
  fireEvent.press(addQuestion());
  const combined = `${draft}\n\n🍋`;
  expect([...combined]).toHaveLength(4000);
  expect(combined.length).toBeGreaterThan(4000);
  expectDraft(combined);
  expect(workbench.onDraftChange.mock.calls).toEqual([[combined]]);
  expect(workbench.onSend).not.toHaveBeenCalled();
});

test.each(['', ' \t\n '])(
  'an empty or whitespace-only suggested question (%j) cannot consume context or modify the draft',
  (empty) => {
    const workbench = fixture('Keep this draft');
    workbench.applyCriteria({ query: 'soup' });
    workbench.openSearch();
    fireEvent.changeText(question(), empty);
    expect(addQuestion()).toBeDisabled();
    fireEvent.press(addQuestion());
    expectDraft('Keep this draft');
    expect(current().entry.search!.question).toBe(empty);
    expect(workbench.onDraftChange).not.toHaveBeenCalled();
    expect(workbench.onSend).not.toHaveBeenCalled();
  },
);

test('a paused or unavailable composer cannot accept the staged question', () => {
  const workbench = fixture('Waiting for the current composer operation.', false);
  workbench.applyCriteria({ query: 'dinner' });
  workbench.openSearch();
  expect(addQuestion()).toBeDisabled();
  fireEvent.press(addQuestion());
  expectDraft('Waiting for the current composer operation.');
  expect(current().entry.search).not.toBeNull();
  expect(workbench.onDraftChange).not.toHaveBeenCalled();
  expect(workbench.onSend).not.toHaveBeenCalled();
});

test('browser search context describes a draft-only handoff and still requires explicit insertion', () => {
  const workbench = fixture('Keep this browser draft', true, true);
  workbench.applyCriteria({ query: 'pasta' });
  workbench.openSearch();
  expect(screen.getByText(/This preview keeps a draft only; sending is unavailable/)).toBeTruthy();
  expect(screen.queryByText(/Only your message is sent when you choose Send/)).toBeNull();
  expectDraft('Keep this browser draft');
  expect(workbench.onDraftChange).not.toHaveBeenCalled();
  fireEvent.press(addQuestion());
  expectDraft('Keep this browser draft\n\nHelp me choose a recipe for “pasta”.');
  expect(workbench.onSend).not.toHaveBeenCalled();
});
