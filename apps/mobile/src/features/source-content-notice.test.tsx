import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';
import { getRecipe, getRecipePhotoTreatment, type CatalogueRecipe } from '@cookmate/catalogue';
import type { PlanOccurrence, QualityAnnotation } from '@cookmate/contracts';
import type { ShoppingGroup, ShoppingSnapshot } from '@cookmate/domain';
import type { QueryState } from './workspace/WorkspaceProvider';
import { AppText } from '../components/Typography';
import { ShoppingScreen } from './shopping/ShoppingScreen';
import RecipeDetailsScreen from './recipes/RecipeDetailsScreen';
import { getRecipeSourceNotices } from './recipes/sourceNotices';

const mockPush = jest.fn();
const mockParams: Record<string, string> = {};
const mockRetry = jest.fn();
const mockActions = {
  blocked: false,
  begin: jest.fn(),
  restoreAfterRemoval: jest.fn(),
};
const mockRegisterFocus = jest.fn(() => () => undefined);
const mockRestoreFocus = jest.fn();
let mockQueryState: QueryState<ShoppingSnapshot>;

jest.mock('@cookmate/catalogue', () => {
  const actual = jest.requireActual('@cookmate/catalogue');
  return {
    ...actual,
    getRecipe: jest.fn(actual.getRecipe),
    getRecipePhotoTreatment: jest.fn(actual.getRecipePhotoTreatment),
  };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('./workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    assistant: null,
    clock: {
      now: () => '2026-09-28T00:00:00Z',
      dateContext: () => ({
        localDate: '2026-09-28',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
    },
    availability: { kind: 'ready', services: {} },
    actions: mockActions,
    actionState: { kind: 'idle' },
    recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
    registerFocusFallback: mockRegisterFocus,
    restoreScreenFocus: mockRestoreFocus,
  }),
  useWorkspaceQuery: () => ({ state: mockQueryState, retry: mockRetry }),
}));

function occurrence(
  recipeId: string,
  occurrenceId: string,
  actualDate = '2026-09-28',
): PlanOccurrence {
  return {
    recipeId,
    occurrenceId,
    placement: { actualDate, mealKey: 'dinner' },
    revision: 1,
    createdAt: '2026-09-28T00:00:00Z',
    updatedAt: '2026-09-28T00:00:00Z',
  };
}
function snapshot(
  selectedOccurrences: PlanOccurrence[],
  groups: ShoppingGroup[] = [],
): ShoppingSnapshot {
  return {
    selectedOccurrences,
    groups,
    status: 'current',
    projectionRevision: 1,
    scope: {
      scopeId: 'fixture-scope',
      revision: 1,
      occurrenceIds: selectedOccurrences.map((meal) => meal.occurrenceId),
    },
  };
}
function showSnapshot(value: ShoppingSnapshot) {
  mockQueryState = { kind: 'ready', value, revision: 1 };
}
function shopping() {
  return <ShoppingScreen header={<AppText>Plan week of 28 September</AppText>} />;
}
function annotation(recipeId: string, annotationId: string, note: string): QualityAnnotation {
  return {
    recipeId,
    annotationId,
    note,
    kind: 'source_gap',
    evidence: [{ sheet: 'Recipes', row: 1, column: 'F' }],
    ruleVersion: 'synthetic-ui-fixture',
  };
}
function requireV2Conflict() {
  const recipe = getRecipe('52982')!;
  const note = recipe.annotations.find(
    (entry) => entry.annotationId === '52982-ingredient-method-conflict',
  );
  if (!note)
    throw new Error('Use the approved real v2 catalogue; do not synthesize its missing note.');
  return { recipe, note };
}

beforeEach(() => {
  jest.clearAllMocks();
  const actual = jest.requireActual<typeof import('@cookmate/catalogue')>('@cookmate/catalogue');
  jest.mocked(getRecipe).mockImplementation(actual.getRecipe);
  jest.mocked(getRecipePhotoTreatment).mockImplementation(actual.getRecipePhotoTreatment);
  Object.keys(mockParams).forEach((key) => delete mockParams[key]);
  mockActions.blocked = false;
  showSnapshot(snapshot([]));
});
afterEach(cleanup);

test.each(['synthetic-recipe-a', 'unrelated-recipe-b'])(
  'classification for %s uses kind and photo/credit IDs, not recipe IDs or prose',
  (recipeId) => {
    const content = annotation(
      recipeId,
      'content-a',
      'This content note mentions a photo and a missing method detail.',
    );
    const warning = annotation(
      recipeId,
      'warning-x',
      'Uncertain association with no keyword hint.',
    );
    const credit = annotation(recipeId, 'credit-y', 'A separate attribution.');
    const second = annotation(recipeId, 'content-b', 'A second source note.');
    const other = {
      ...annotation(recipeId, 'amount-z', 'Unknown amount.'),
      kind: 'missing_measure' as const,
    };
    const recipe: CatalogueRecipe = {
      ...getRecipe('52839')!,
      recipeId,
      annotations: [content, warning, credit, second, content, other],
    };
    jest.mocked(getRecipePhotoTreatment).mockReturnValue({
      recipeId,
      preserveFullFrame: true,
      warningAnnotationId: warning.annotationId,
      creditAnnotationId: credit.annotationId,
    });
    expect(getRecipeSourceNotices(recipe)).toEqual([content, second]);
    expect(recipe.annotations).toHaveLength(6);
    jest.mocked(getRecipePhotoTreatment).mockReturnValue(undefined);
    expect(getRecipeSourceNotices(recipe)).toEqual([content, warning, credit, second]);
  },
);

test('actual v2 photo exceptions and existing credit notes do not become content notes', () => {
  requireV2Conflict();
  for (const recipeId of ['53389', '53318', '53208', '53230', '53262']) {
    const recipe = getRecipe(recipeId)!;
    const treatment = getRecipePhotoTreatment(recipeId)!;
    const photoIds = [treatment.warningAnnotationId, treatment.creditAnnotationId].filter(Boolean);
    expect(photoIds.length).toBeGreaterThan(0);
    for (const id of photoIds) {
      expect(recipe.annotations.some((note) => note.annotationId === id)).toBe(true);
      expect(getRecipeSourceNotices(recipe).some((note) => note.annotationId === id)).toBe(false);
    }
  }
});

test('one press reveals complete notes and one source link per recipe, including other weeks', () => {
  const { recipe: conflict, note } = requireV2Conflict();
  const garnish = getRecipe('52835')!;
  showSnapshot(
    snapshot([
      occurrence(garnish.recipeId, 'first'),
      occurrence(garnish.recipeId, 'repeated', '2026-10-12'),
      occurrence(conflict.recipeId, 'other-week', '2026-11-02'),
      occurrence('52839', 'unaffected'),
    ]),
  );
  render(shopping());
  expect(screen.getByText('4 meals selected · 2 outside this week')).toBeTruthy();
  const notes = screen.getByRole('button', { name: 'Read 2 recipe notes' });
  expect(notes).not.toBeExpanded();
  expect(screen.queryByRole('button', { name: /^Open source notes for / })).toBeNull();
  fireEvent.press(notes);
  expect(notes).toBeExpanded();
  expect(screen.getByText(note.note)).toBeTruthy();
  const links = screen.getAllByRole('button', { name: /^Open source notes for / });
  expect(links.map((link) => link.props.accessibilityLabel)).toEqual([
    `Open source notes for ${garnish.title}`,
    `Open source notes for ${conflict.title}`,
  ]);
  let modal = screen.UNSAFE_getAllByType(Modal).find((node) => node.props.visible)!;
  fireEvent.press(links[0]!);
  fireEvent(modal, 'dismiss');
  fireEvent.press(screen.getByRole('button', { name: 'Read 2 recipe notes' }));
  modal = screen.UNSAFE_getAllByType(Modal).find((node) => node.props.visible)!;
  fireEvent.press(screen.getByRole('button', { name: `Open source notes for ${conflict.title}` }));
  fireEvent(modal, 'dismiss');
  expect(mockPush.mock.calls).toEqual([
    [{ pathname: '/recipe/[id]', params: { id: garnish.recipeId, section: 'source' } }],
    [{ pathname: '/recipe/[id]', params: { id: conflict.recipeId, section: 'source' } }],
  ]);
  expect(screen.queryByText(note.note)).toBeNull();
  expect(screen.getByRole('button', { name: 'Read 2 recipe notes' })).not.toBeExpanded();
  expect(screen.getByText('Carbonara: the ingredient list and method conflict.')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Show 4 selected meals' }));
  expect(screen.getAllByText('Outside displayed week')).toHaveLength(2);
  expect(mockActions.begin).not.toHaveBeenCalled();
});

test.each([
  { name: 'empty', recipeIds: [] },
  { name: 'unaffected', recipeIds: ['52839'] },
  { name: 'photo-only', recipeIds: ['53389', '53318', '53262'] },
])('$name selections add no content notice', ({ recipeIds }) => {
  showSnapshot(snapshot(recipeIds.map((id, index) => occurrence(id, `meal-${index}`))));
  render(shopping());
  expect(screen.queryByRole('button', { name: /^Read \d+ recipe notes?$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Open source notes for / })).toBeNull();
});

test('a selected recipe can carry both photo and content notes without hiding its content link', () => {
  const actual = jest.requireActual<typeof import('@cookmate/catalogue')>('@cookmate/catalogue');
  const recipeId = 'synthetic-mixed';
  const content = annotation(recipeId, 'content', 'A method detail remains unclear.');
  const photo = annotation(recipeId, 'photo', 'An association warning.');
  const recipe: CatalogueRecipe = {
    ...actual.getRecipe('52839')!,
    recipeId,
    title: 'Mixed source fixture',
    annotations: [photo, content],
  };
  jest
    .mocked(getRecipe)
    .mockImplementation((id) => (id === recipeId ? recipe : actual.getRecipe(id)));
  jest.mocked(getRecipePhotoTreatment).mockImplementation((id) =>
    id === recipeId
      ? {
          recipeId,
          preserveFullFrame: true,
          warningAnnotationId: photo.annotationId,
          creditAnnotationId: null,
        }
      : actual.getRecipePhotoTreatment(id),
  );
  showSnapshot(snapshot([occurrence(recipeId, 'mixed')]));
  render(shopping());
  fireEvent.press(screen.getByRole('button', { name: 'Read 1 recipe note' }));
  expect(
    screen.getAllByRole('button', { name: 'Open source notes for Mixed source fixture' }),
  ).toHaveLength(1);
  expect(screen.queryByText(photo.note)).toBeNull();
  expect(screen.getByText(content.note)).toBeTruthy();
});

test.each(['loading', 'failed', 'pending'] as const)(
  '%s keeps notices tied to the retained selected snapshot and preserves mutation readiness',
  (kind) => {
    const previous = snapshot([occurrence('52835', 'retained', '2026-10-19')]);
    if (kind === 'pending') showSnapshot({ ...previous, status: 'pending' });
    else if (kind === 'loading') mockQueryState = { kind, previous };
    else
      mockQueryState = {
        kind,
        previous,
        error: { code: 'storage_failure', messageKey: 'fixture.read', retry: 'after_correction' },
      };
    const view = render(shopping());
    fireEvent.press(screen.getByRole('button', { name: 'Read 1 recipe note' }));
    expect(
      screen.getByRole('button', { name: `Open source notes for ${getRecipe('52835')!.title}` }),
    ).toBeEnabled();
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    fireEvent.press(screen.getByRole('button', { name: 'Show 1 selected meal' }));
    expect(screen.getByRole('button', { name: 'Change meals' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(
      screen.getByText(
        kind === 'pending'
          ? 'Shopping list is updating'
          : 'The previous view is shown below. Changes are unavailable until the latest saved state is loaded.',
      ),
    ).toBeTruthy();
    showSnapshot(snapshot([occurrence('52839', 'current')]));
    view.rerender(shopping());
    expect(screen.queryByRole('button', { name: /^Read \d+ recipe notes?$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open source notes for / })).toBeNull();
    expect(mockActions.begin).not.toHaveBeenCalled();
  },
);

test('source navigation and remount preserve the supplied selection, demand and purchased state', () => {
  const recipe = getRecipe('52835')!;
  const row = recipe.ingredients[0];
  const meal = occurrence(recipe.recipeId, 'selected');
  // Synthetic UI snapshot uses the real row text; it does not claim projection or persistence proof.
  const group: ShoppingGroup = {
    groupKey: 'group',
    displayName: row.rawName,
    quantityLabel: row.rawMeasure ?? 'Amount not supplied',
    demandFingerprint: 'd'.repeat(64),
    purchased: true,
    changed: false,
    revision: 1,
    contributions: [
      {
        contributionId: 'contribution',
        occurrenceId: meal.occurrenceId,
        recipeId: recipe.recipeId,
        source: { recipeId: recipe.recipeId, section: 'ingredient', position: row.position },
        rawName: row.rawName,
        rawMeasure: row.rawMeasure,
        quantity: { kind: 'unparsed' },
      },
    ],
  };
  const saved = snapshot([meal], [group]);
  const before = JSON.stringify(saved);
  showSnapshot(saved);
  const view = render(shopping());
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByRole('checkbox')).toBeEnabled();
  expect(
    screen.getByText('Alfredo: chives or parsley are alternatives; you do not need both.'),
  ).toBeTruthy();
  expect(screen.queryByText(getRecipeSourceNotices(recipe)[0]!.note)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Read 1 recipe note' }));
  expect(screen.getByText(getRecipeSourceNotices(recipe)[0]!.note)).toBeTruthy();
  expect(screen.getByRole('checkbox')).toBeChecked();
  fireEvent.press(screen.getByRole('button', { name: `Open source notes for ${recipe.title}` }));
  expect(mockActions.begin).not.toHaveBeenCalled();
  view.unmount();
  render(shopping());
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(JSON.stringify(saved)).toBe(before);
  fireEvent.press(screen.getByRole('checkbox'));
  expect(mockActions.begin).toHaveBeenCalledWith(
    { kind: 'setPurchased', groupKey: group.groupKey, purchased: false },
    { observedDemandFingerprint: group.demandFingerprint, restoreFocus: expect.any(Function) },
  );
  expect(JSON.stringify(saved)).toBe(before);
});

test('the compact conflict remains explicit and expands its exact note without changing purchase state', () => {
  const { recipe, note } = requireV2Conflict();
  const meal = occurrence(recipe.recipeId, 'conflict-meal');
  const row = recipe.ingredients[0]!;
  const group: ShoppingGroup = {
    groupKey: 'conflict-group',
    displayName: row.rawName,
    quantityLabel: row.rawMeasure ?? 'Amount not supplied',
    demandFingerprint: 'c'.repeat(64),
    purchased: false,
    changed: true,
    revision: 1,
    contributions: [
      {
        contributionId: 'conflict-contribution',
        occurrenceId: meal.occurrenceId,
        recipeId: recipe.recipeId,
        source: { recipeId: recipe.recipeId, section: 'ingredient', position: row.position },
        rawName: row.rawName,
        rawMeasure: row.rawMeasure,
        quantity: { kind: 'unparsed' },
      },
    ],
  };
  const saved = snapshot([meal], [group]);
  showSnapshot(saved);
  const view = render(shopping());
  expect(screen.getByText('Carbonara: the ingredient list and method conflict.')).toBeTruthy();
  expect(screen.getByText('Changed — review')).toBeTruthy();
  expect(screen.queryByText(note.note)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Read 1 recipe note' }));
  expect(screen.getByText(note.note)).toBeTruthy();
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  view.rerender(shopping());
  expect(screen.getByText(note.note)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByText(note.note)).toBeNull();
  expect(screen.getByText('Carbonara: the ingredient list and method conflict.')).toBeTruthy();
  expect(screen.getByText('Changed — review')).toBeTruthy();
  expect(mockActions.begin).not.toHaveBeenCalled();
  expect(saved.groups[0]!.purchased).toBe(false);
});

test('content guidance keeps Add to plan operable with its existing recipe route', () => {
  const { recipe } = requireV2Conflict();
  mockParams.id = recipe.recipeId;
  render(<RecipeDetailsScreen />);
  expect(screen.getByText('Recipe source notes')).toBeTruthy();
  const add = screen.getByRole('button', { name: 'Add to plan' });
  expect(add).toBeEnabled();
  fireEvent.press(add);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/plan-edit',
    params: { recipeId: recipe.recipeId },
  });
  expect(mockActions.begin).not.toHaveBeenCalled();
});
