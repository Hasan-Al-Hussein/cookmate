import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Modal, Platform } from 'react-native';
import { catalogue, getRecipe, type CatalogueRecipe } from '@cookmate/catalogue';
import RecipeDetailsScreen from './RecipeDetailsScreen';
import type { RecipeVideoPlayerProps } from './video/videoModel';
import { youtubeVideoId } from './video/videoModel';
import { UnplacedInstructionNotes, InstructionPassageView } from './InstructionPassageView';

const mockParams: { id: string; section?: string } = { id: '52839' };
const mockPush = jest.fn();
const mockPlayerUnmount = jest.fn();
let mockPlayer: RecipeVideoPlayerProps | undefined;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '52839': 1 } }));
jest.mock('./video/RecipeVideoPlayer', () => ({
  RecipeVideoPlayer: (props: RecipeVideoPlayerProps) => {
    mockPlayer = props;
    jest.requireActual('react').useEffect(() => () => mockPlayerUnmount(), []);
    const { View } = jest.requireActual('react-native');
    return <View testID="canonical-recipe-player" />;
  },
}));

const recipe = getRecipe('52839')!;
test('an unresolved synthetic mapping stays readable once and explicitly needs editorial review', () => {
  const original = getRecipe('53076')!;
  const warning = { ...original.annotations[0]!, evidence: [] };
  // Deliberately malformed evidence exercises the defensive view, not accepted content.
  const fixture = { ...original, annotations: [warning] } as unknown as CatalogueRecipe;
  render(
    <>
      <UnplacedInstructionNotes recipe={fixture} />
      <InstructionPassageView recipe={fixture} passage={fixture.instructions[0]!} />
    </>,
  );
  expect(screen.getAllByText(warning.note)).toHaveLength(1);
  expect(
    screen.getByText('Passage association needs editorial review. This note is kept here in full.'),
  ).toBeTruthy();
  expect(screen.getByText(fixture.instructions[0]!.rawText)).toBeTruthy();
});
beforeEach(() => {
  jest.useFakeTimers();
  mockParams.id = recipe.recipeId;
  delete mockParams.section;
  mockPlayer = undefined;
  mockPlayerUnmount.mockClear();
  mockPush.mockClear();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('title Watch opens the single Instructions player; Hide and segment exit tear it down', () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  render(<RecipeDetailsScreen />);
  expect(screen.getByRole('tab', { name: 'Ingredients' })).toBeSelected();
  expect(screen.getByRole('button', { name: 'Watch recipe' })).toBeTruthy();
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();

  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  expect(screen.getByRole('tab', { name: 'Instructions' })).toBeSelected();
  expect(screen.getAllByTestId('canonical-recipe-player')).toHaveLength(1);
  expect(mockPlayer?.videoId).toBe(youtubeVideoId(recipe.videoUrl));
  expect(mockPlayer!.height).toBeGreaterThanOrEqual(200);
  recipe.instructions.forEach((passage) => expect(screen.getByText(passage.rawText)).toBeTruthy());
  expect(open).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();

  fireEvent.press(screen.getByRole('button', { name: 'Hide video' }));
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  expect(mockPlayerUnmount).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: `Watch recipe video for ${recipe.title}` }),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  expect(screen.getAllByTestId('canonical-recipe-player')).toHaveLength(1);
  fireEvent.press(screen.getByRole('tab', { name: 'Ingredients' }));
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  expect(mockPlayerUnmount).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
});

test('Source offers another entrance, never a second player or an automatic external redirect', () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  mockParams.section = 'source';
  render(<RecipeDetailsScreen />);
  expect(screen.getByText('Recipe & credits')).toBeTruthy();
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  const entrances = screen.getAllByRole('button', { name: 'Watch recipe' });
  expect(entrances).toHaveLength(2);
  fireEvent.press(entrances[1]!);
  expect(screen.getByRole('tab', { name: 'Instructions' })).toBeSelected();
  expect(screen.getAllByTestId('canonical-recipe-player')).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
});

test('ordinary Instructions entry never activates video and recipe changes reset video state', () => {
  const withoutVideo = catalogue.recipes.find((entry) => !entry.videoUrl);
  if (!withoutVideo) throw new Error('Expected a real recipe without a supplied video');
  const view = render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  expect(screen.getByTestId('canonical-recipe-player')).toBeTruthy();

  mockParams.id = withoutVideo.recipeId;
  view.rerender(<RecipeDetailsScreen />);
  expect(screen.getByRole('tab', { name: 'Ingredients' })).toBeSelected();
  expect(screen.queryByRole('button', { name: 'Watch recipe' })).toBeNull();
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  expect(mockPlayerUnmount).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  expect(screen.queryByText('Recipe video')).toBeNull();
  expect(screen.queryByText('No video supplied for this recipe.')).toBeNull();
  withoutVideo.instructions.forEach((passage) =>
    expect(screen.getByText(passage.rawText)).toBeTruthy(),
  );
});

test('credit rows open their exact safe link in one action and failures keep the recipe available', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('Unavailable browser'));
  mockParams.section = 'source';
  render(<RecipeDetailsScreen />);
  await act(async () => {
    fireEvent.press(
      screen.getByRole('button', { name: 'Recipe collection, TheMealDB, opens external site' }),
    );
  });
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(recipe.recipePage);
  expect(screen.getByText('Couldn’t open this source')).toBeTruthy();
  expect(screen.getByText(recipe.title)).toBeTruthy();
  expect(mockPush).not.toHaveBeenCalled();
});

test('cooking sections retain source headings with their passages and expose every original passage', () => {
  const source = getRecipe('53262')!; // Adana kebab has three supplied step headings.
  const salt = source.annotations.find((note) => note.kind === 'instruction_only_ingredient')!;
  const credit = source.annotations.find((note) =>
    note.annotationId.endsWith('image-credit-distinction'),
  )!;
  mockParams.id = source.recipeId;
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  expect(screen.getByText('Section 1 of 3')).toBeTruthy();
  expect(screen.getByRole('header', { name: source.instructions[0]!.rawText })).toBeTruthy();
  expect(screen.getByText(source.instructions[1]!.rawText)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous section' })).toBeDisabled();
  expect(screen.getByText(salt.note)).toBeTruthy();
  expect(screen.queryByText(credit.note)).toBeNull();

  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  expect(screen.getByText('Section 2 of 3')).toBeTruthy();
  expect(screen.queryByText(salt.note)).toBeNull();
  fireEvent.press(
    screen.getByRole('button', { name: `All recipe source notes (${source.annotations.length})` }),
  );
  source.annotations.forEach((note) => expect(screen.getByText(note.note)).toBeTruthy());
  fireEvent.press(screen.getByRole('button', { name: 'Show worksheet references' }));
  expect(
    screen.getByText(
      salt.evidence
        .map((locator) => `${locator.sheet} ${locator.column ?? 'row '}${locator.row}`)
        .join(' · '),
    ),
  ).toBeTruthy();
  fireEvent.press(
    screen.getByRole('button', { name: `Hide recipe source notes (${source.annotations.length})` }),
  );
  expect(screen.queryByText(salt.note)).toBeNull();
  source.instructions
    .slice(2, 5)
    .forEach((passage) => expect(screen.getByText(passage.rawText)).toBeTruthy());
  fireEvent.press(screen.getByRole('button', { name: 'Full instructions' }));
  expect(screen.getAllByText(salt.note)).toHaveLength(1);
  source.instructions.forEach((passage) => expect(screen.getByText(passage.rawText)).toBeTruthy());
  source.instructions
    .filter((passage) => passage.presentation === 'heading')
    .forEach((passage) =>
      expect(screen.getByRole('header', { name: passage.rawText })).toBeTruthy(),
    );
  fireEvent.press(screen.getByRole('button', { name: 'Return to section' }));
  expect(screen.getByText('Section 2 of 3')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  expect(screen.getByRole('button', { name: 'Next section' })).toBeDisabled();
  expect(screen.getByText(source.instructions[6]!.rawText)).toBeTruthy();
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  expect(mockPush).not.toHaveBeenCalled();
});

test('cooking conflict notices follow affected passages and cannot be dismissed with the all-notes disclosure', () => {
  const source = getRecipe('52982')!;
  const conflict = source.annotations.find((note) =>
    note.annotationId.endsWith('ingredient-method-conflict'),
  )!;
  mockParams.id = source.recipeId;
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  expect(screen.getByText('Section 1 of 12')).toBeTruthy();
  expect(screen.queryByText(conflict.note)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  expect(screen.getByText(source.instructions[3]!.rawText)).toBeTruthy();
  expect(screen.getAllByText(conflict.note)).toHaveLength(1);
  fireEvent.press(
    screen.getByRole('button', { name: `All recipe source notes (${source.annotations.length})` }),
  );
  expect(screen.getAllByText(conflict.note)).toHaveLength(2);
  fireEvent.press(
    screen.getByRole('button', { name: `Hide recipe source notes (${source.annotations.length})` }),
  );
  expect(screen.getAllByText(conflict.note)).toHaveLength(1);
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  expect(screen.getByText(source.instructions[5]!.rawText)).toBeTruthy();
  expect(screen.getAllByText(conflict.note)).toHaveLength(1);
});

test('ingredients sheet preserves missing amounts and relevant notes without a purchase control', () => {
  const source = getRecipe('53138')!; // Alfajores has an explicitly missing dulce de leche amount.
  mockParams.id = source.recipeId;
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open ingredients sheet' }));
  source.ingredients.forEach((entry) => {
    expect(screen.getAllByText(entry.rawName).length).toBeGreaterThan(0);
    expect(screen.getAllByText(entry.rawMeasure ?? 'Amount not supplied').length).toBeGreaterThan(
      0,
    );
  });
  source.annotations
    .filter((note) => note.kind === 'missing_measure')
    .forEach((note) => expect(screen.getByText(note.note)).toBeTruthy());
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Close ingredients sheet' }));
  expect(screen.getByText(`Section 1 of ${source.instructions.length}`)).toBeTruthy();
  expect(screen.getByText(source.instructions[0]!.rawText)).toBeTruthy();
  expect(mockPush).not.toHaveBeenCalled();
});

test('passages before the first supplied heading remain accessible in their original order', () => {
  const source = getRecipe('53320')!; // Chocolate alfajores begins with passages before a heading.
  const firstHeading = source.instructions.findIndex(
    (passage) => passage.presentation === 'heading',
  );
  expect(firstHeading).toBeGreaterThan(0);
  mockParams.id = source.recipeId;
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  source.instructions
    .slice(0, firstHeading)
    .forEach((passage) => expect(screen.getByText(passage.rawText)).toBeTruthy());
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  expect(
    screen.getByRole('header', { name: source.instructions[firstHeading]!.rawText }),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Full instructions' }));
  source.instructions.forEach((passage) => expect(screen.getByText(passage.rawText)).toBeTruthy());
});

test('reading position is scoped per recipe during this session and Close returns to Instructions', () => {
  const source = catalogue.recipes.find(
    (entry) =>
      !!entry.videoUrl &&
      entry.recipeId !== '53138' &&
      entry.recipeId !== recipe.recipeId &&
      entry.instructions.length > 2 &&
      entry.instructions.every((passage) => passage.presentation !== 'heading'),
  )!;
  const other = catalogue.recipes.find((entry) => !entry.videoUrl)!;
  mockParams.id = source.recipeId;
  const view = render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  fireEvent.press(screen.getByRole('button', { name: 'Next section' }));
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent.press(screen.getByRole('button', { name: 'Close cooking view' }));
  fireEvent(modal, 'dismiss');
  expect(screen.getByRole('tab', { name: 'Instructions' })).toBeSelected();
  expect(mockPush).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  expect(screen.getByText(`Section 2 of ${source.instructions.length}`)).toBeTruthy();

  mockParams.id = other.recipeId;
  view.rerender(<RecipeDetailsScreen />);
  expect(screen.getByRole('tab', { name: 'Ingredients' })).toBeSelected();
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  expect(screen.getByText(/^Section 1 of /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Watch recipe' })).toBeNull();

  mockParams.id = source.recipeId;
  view.rerender(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  expect(screen.getByText(`Section 2 of ${source.instructions.length}`)).toBeTruthy();
});

test('opening the reader tears down playback; its Watch entrance dismisses before one canonical player resumes', () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  expect(screen.getAllByTestId('canonical-recipe-player')).toHaveLength(1);
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  expect(
    screen.queryByTestId('canonical-recipe-player', { includeHiddenElements: true }),
  ).toBeNull();
  expect(mockPlayerUnmount).toHaveBeenCalledTimes(1);
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  fireEvent(modal, 'dismiss');
  expect(screen.getByRole('tab', { name: 'Instructions' })).toBeSelected();
  expect(screen.getAllByTestId('canonical-recipe-player')).toHaveLength(1);
  expect(mockPlayer?.videoId).toBe(youtubeVideoId(recipe.videoUrl));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  const reopened = screen.UNSAFE_getByType(Modal);
  fireEvent.press(screen.getByRole('button', { name: 'Close cooking view' }));
  fireEvent(reopened, 'dismiss');
  expect(screen.queryByTestId('canonical-recipe-player')).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

test('web reader Watch cannot start playback from the obsolete next-frame close fallback', () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  render(<RecipeDetailsScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open cooking view' }));
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent(modal, 'show');
  fireEvent.press(screen.getByRole('button', { name: 'Watch recipe' }));
  act(() => jest.advanceTimersByTime(100));
  expect(screen.queryByTestId('canonical-recipe-player', { includeHiddenElements: true })).toBeNull();
  fireEvent(modal, 'dismiss');
  expect(screen.getAllByTestId('canonical-recipe-player')).toHaveLength(1);
});
