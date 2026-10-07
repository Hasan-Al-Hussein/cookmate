import { act, cleanupAsync, fireEvent, render } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import type {
  ContentPlanOccurrence,
  ContentShoppingSnapshot,
} from '../../data/contentWorkspaceQueries';
import { getPlanWeek } from '@cookmate/domain';
import { ShoppingEvidenceSheets } from './ShoppingEvidenceSheets';
import { recipeReferenceKey } from './ordinaryShoppingModel';
import type { PlanningPreferencesSnapshot } from '../planning-preferences/planningPreferences';
let mockPlanning: PlanningPreferencesSnapshot;
jest.mock('../planning-preferences/PlanningPreferencesProvider', () => ({
  usePlanningPreferences: () => mockPlanning,
}));
const mockPush = jest.fn();
let mockDismiss: (() => void) | undefined;
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../../components/FocusedSheet', () => ({
  FocusedSheet: ({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) => {
    mockDismiss = onDismiss;
    return children;
  },
}));
jest.mock('../workspace/ExactRecipePhoto', () => ({ ExactRecipePhoto: () => null }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
const entries: ContentPlanOccurrence[] = ['old', 'new'].map((revision, index) => ({
  occurrence: {
    occurrenceId: revision,
    recipeId: '52839',
    placement: { actualDate: index === 0 ? '2026-10-01' : '2026-10-08', mealKey: 'dinner' },
    revision: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  contentRef: {
    recipeId: '52839',
    revisionId: revision,
    contentFingerprint: (index === 0 ? 'a' : 'b').repeat(64),
  },
  content: {
    kind: 'readable',
    state: index === 0 ? 'historical' : 'current',
    title: `Verified ${revision} title`,
    photoAssetId: null,
  },
}));
const snapshot: Extract<ContentShoppingSnapshot, { kind: 'current' }>['snapshot'] = {
  scope: { scopeId: 'scope', revision: 1, occurrenceIds: ['old', 'new'] },
  selectedOccurrences: entries.map((entry) => entry.occurrence),
  status: 'current',
  projectionRevision: 1,
  groups: [
    {
      groupKey: 'flour',
      displayName: 'Flour',
      quantityLabel: '300 g',
      demandFingerprint: 'a'.repeat(64),
      purchased: false,
      changed: false,
      revision: 1,
      contributions: entries.map((entry, index) => ({
        contributionId: entry.occurrence.occurrenceId,
        occurrenceId: entry.occurrence.occurrenceId,
        recipeId: entry.occurrence.recipeId,
        contentRef: entry.contentRef,
        source: { section: 'ingredient', recipeId: '52839', position: 1 },
        rawName: ' Flour ',
        rawMeasure: index === 0 ? '100 g' : '200 g',
        quantity: {
          kind: 'exact',
          numerator: index === 0 ? '100' : '200',
          denominator: '1',
          unit: 'g',
        },
      })),
    },
  ],
};
const props = (): ComponentProps<typeof ShoppingEvidenceSheets> => ({
  evidence: { kind: 'ingredient', groupKey: 'flour' },
  snapshot,
  notes: [],
  contentEntries: entries,
  week: getPlanWeek('2026-10-01'),
  canChangeMeals: true,
  onClose: jest.fn(),
  onReturnFocus: jest.fn(),
  onRecipeNavigation: jest.fn(),
});
afterEach(async () => {
  await cleanupAsync();
  mockPush.mockClear();
  mockDismiss = undefined;
});
beforeEach(() => {
  mockPlanning = {
    preferences: { weekStart: 'monday', defaultMealSlot: 'dinner' },
    hydrated: true,
    saving: false,
    error: null,
  };
});
test('ingredient evidence separates revisions of one recipe and source navigation carries the exact pin', () => {
  const input = props();
  const view = render(<ShoppingEvidenceSheets {...input} />);
  expect(view.getByText('Verified old title')).toBeTruthy();
  expect(view.getByText('Verified new title')).toBeTruthy();
  expect(view.getByText(/100 g/)).toBeTruthy();
  expect(view.getByText(/200 g/)).toBeTruthy();
  fireEvent.press(view.getAllByRole('button', { name: 'Open recipe source' })[0]!);
  expect(input.onClose).toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  act(() => mockDismiss?.());
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: {
      id: '52839',
      section: 'source',
      contentRef: recipeReferenceKey(entries[0]!.contentRef),
    },
  });
});
test('a retained sheet dismissal cannot navigate after its workspace unmounts', async () => {
  const view = render(<ShoppingEvidenceSheets {...props()} />);
  fireEvent.press(view.getAllByRole('button', { name: 'Open recipe source' })[1]!);
  const dismiss = mockDismiss;
  await act(async () => view.unmount());
  act(() => dismiss?.());
  expect(mockPush).not.toHaveBeenCalled();
});

test('Sunday grouping keeps exact occurrence identities and does not change selected shopping meals', () => {
  const input = props();
  mockPlanning = {
    ...mockPlanning,
    preferences: { ...mockPlanning.preferences, weekStart: 'sunday' },
  };
  const before = JSON.stringify(snapshot);
  const view = render(
    <ShoppingEvidenceSheets
      {...input}
      evidence={{ kind: 'scope' }}
      week={getPlanWeek('2026-10-01', 'sunday')}
    />,
  );
  expect(view.getByText('Sun 27 Sep – Saturday 3 October 2026')).toBeTruthy();
  expect(view.getByText('Sun 4 Oct – Saturday 10 October 2026')).toBeTruthy();
  expect(view.getByText('Verified old title')).toBeTruthy();
  expect(view.getByText('Verified new title')).toBeTruthy();
  expect(JSON.stringify(snapshot)).toBe(before);
});

test('a delayed change-meals dismissal cannot silently replace the week captured before a preference change', () => {
  const input = props();
  const view = render(<ShoppingEvidenceSheets {...input} evidence={{ kind: 'scope' }} />);
  fireEvent.press(view.getByRole('button', { name: 'Change meals' }));
  const oldDismiss = mockDismiss;
  mockPlanning = {
    ...mockPlanning,
    preferences: { ...mockPlanning.preferences, weekStart: 'sunday' },
  };
  view.rerender(
    <ShoppingEvidenceSheets
      {...input}
      evidence={null}
      week={getPlanWeek('2026-10-01', 'sunday')}
    />,
  );
  act(() => oldDismiss?.());
  act(() => mockDismiss?.());
  expect(mockPush).not.toHaveBeenCalled();
});
