import { cleanup, render, screen } from '@testing-library/react-native';
import type { PortableBackupReferenceSummary } from '@cookmate/domain';
import { BackupReferenceSummary } from './BackupReferenceSummary';

const empty = (): PortableBackupReferenceSummary => ({
  schemaVersion: 1,
  totalRecipeIds: 0,
  knownExactRecipeIds: [],
  trustedArchivedRecipeIds: [],
  archiveResolution: 'unavailable',
  unresolved: [],
  historyEntries: 0,
  historyContentVerification: 'not_checked',
  restoreAuthorized: false,
});
afterEach(cleanup);

test('shows confirmed catalogue references separately from unavailable trusted archives without restore controls', () => {
  render(
    <BackupReferenceSummary
      summary={{ ...empty(), totalRecipeIds: 2, knownExactRecipeIds: ['52835', '52839'] }}
    />,
  );
  expect(screen.getByText('Known exact catalogue references: 2')).toBeTruthy();
  expect(screen.getByText('Known IDs: 52835, 52839')).toBeTruthy();
  expect(screen.getByText('Exact trusted archive references: unavailable')).toBeTruthy();
  expect(screen.getByText(/No references are counted as recoverable from an archive/)).toBeTruthy();
  expect(screen.getByText('Unresolved recipe references: 0')).toBeTruthy();
  expect(screen.getByText(/Reference inspection does not authorize restore/)).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('explains unavailable IDs and mismatched catalogue identity with the unchanged-file recovery route', () => {
  render(
    <BackupReferenceSummary
      summary={{
        ...empty(),
        totalRecipeIds: 1,
        unresolved: [{ recipeId: '99999', reasons: ['recipe_unavailable', 'catalogue_mismatch'] }],
      }}
    />,
  );
  expect(screen.getByText('Recipe ID 99999')).toBeTruthy();
  expect(screen.getByText('This recipe ID is unavailable in the current catalogue.')).toBeTruthy();
  expect(
    screen.getByText('The recorded catalogue identity does not match this workspace.'),
  ).toBeTruthy();
  expect(screen.getByText(/Keep the original backup unchanged/)).toBeTruthy();
  expect(
    screen.getByText(/A latest recipe or matching title will not be substituted/),
  ).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('ordinary history inspection remains unresolved and never implies content verification', () => {
  render(
    <BackupReferenceSummary
      summary={{
        ...empty(),
        totalRecipeIds: 1,
        historyEntries: 3,
        unresolved: [{ recipeId: '52835', reasons: ['history_content_unverified'] }],
      }}
    />,
  );
  expect(screen.getByText('Known exact catalogue references: 0')).toBeTruthy();
  expect(
    screen.getByText(/Cooking history content has not been verified during this file inspection/),
  ).toBeTruthy();
});

test('whole-backup history failure does not pretend to identify the particular mismatching entry', () => {
  render(
    <BackupReferenceSummary
      summary={{
        ...empty(),
        totalRecipeIds: 1,
        historyEntries: 3,
        historyContentVerification: 'mismatch',
        unresolved: [{ recipeId: '52835', reasons: ['history_content_mismatch'] }],
      }}
    />,
  );
  expect(
    screen.getByText(/At least one history entry failed exact content verification/),
  ).toBeTruthy();
  expect(screen.getByText(/All history recipe IDs remain unresolved in this summary/)).toBeTruthy();
});

test('large unresolved summaries bound rendering and state that the original retains every reference', () => {
  render(
    <BackupReferenceSummary
      summary={{
        ...empty(),
        totalRecipeIds: 30,
        unresolved: Array.from({ length: 30 }, (_, index) => ({
          recipeId: String(10000 + index),
          reasons: ['recipe_unavailable'],
        })),
      }}
    />,
  );
  expect(screen.getByText('Unresolved recipe references: 30')).toBeTruthy();
  expect(screen.getByText('Recipe ID 10009')).toBeTruthy();
  expect(screen.queryByText('Recipe ID 10010')).toBeNull();
  expect(screen.getByText(/Showing the first 10 of 30 unresolved IDs/)).toBeTruthy();
  expect(screen.getByText(/The original backup retains every reference/)).toBeTruthy();
});

test('empty summary states no references without implying restore is available', () => {
  render(<BackupReferenceSummary summary={empty()} />);
  expect(screen.getByText('This file contains no recipe references.')).toBeTruthy();
  expect(screen.getByText(/Other restore checks still apply/)).toBeTruthy();
});
