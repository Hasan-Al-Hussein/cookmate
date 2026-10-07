import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { Linking } from 'react-native';
import type { Immutable } from '@cookmate/catalogue';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
  type PublishedRecipeTranslation,
} from '@cookmate/catalogue/content';
import {
  ContentRecipeReaderView,
  type ContentRecipeReaderViewProps,
  type ContentCookingReadingParts,
} from './ContentRecipeReaderView';
import type { RecipeVideoPlayerProps } from '../recipes/video/videoModel';
import { ActionButton } from '../../components/Controls';

let mockPhotoProps: { recipe: Immutable<ReadingRecipe>; scopeKey: string } | undefined;
let mockPlayer: RecipeVideoPlayerProps | undefined;
const mockUnmount = jest.fn();
jest.mock('./ContentRecipePhoto', () => ({
  ContentRecipePhoto: (props: { recipe: Immutable<ReadingRecipe>; scopeKey: string }) => {
    const { View } = jest.requireActual('react-native');
    mockPhotoProps = props;
    return <View testID="exact-photo" />;
  },
}));
jest.mock('../recipes/video/RecipeVideoPlayer', () => ({
  RecipeVideoPlayer: (props: RecipeVideoPlayerProps) => {
    const { View } = jest.requireActual('react-native');
    mockPlayer = props;
    jest.requireActual('react').useEffect(() => () => mockUnmount(), []);
    return <View testID="exact-video" />;
  },
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '52819': 1 } }));

let imported: Immutable<ReadingRecipe>;
beforeAll(async () => {
  // Presentation fixtures only. The host's signed-content tests establish body/media trust.
  imported = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes.find(
    (r) => r.recipeId === '52819',
  )!;
});
beforeEach(() => {
  jest.useFakeTimers();
  mockPhotoProps = undefined;
  mockPlayer = undefined;
  mockUnmount.mockClear();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
function authored(): Immutable<ReadingRecipe> {
  return {
    ...imported,
    contentRef: {
      ...imported.contentRef,
      revisionId: 'authored-reader-fixture',
      contentFingerprint: 'b'.repeat(64),
    },
    contentKind: 'authored',
    title: 'An exact authored title with every word preserved for the reader',
    description: 'A separately authored description.',
    ingredients: [
      {
        recipeId: imported.recipeId,
        position: 1,
        rawName: 'Original raw ingredient',
        rawMeasure: '  1½ tbsp + 2 tsp  ',
        source: null,
      },
      {
        recipeId: imported.recipeId,
        position: 2,
        rawName: 'Unmeasured ingredient',
        rawMeasure: null,
        source: null,
      },
    ],
    instructions: [
      {
        recipeId: imported.recipeId,
        sequence: 1,
        rawText: 'Preparation',
        presentation: 'heading',
        source: null,
      },
      {
        recipeId: imported.recipeId,
        sequence: 2,
        rawText: 'Keep this paragraph.\n\nAnd this exact second paragraph.',
        presentation: 'passage',
        source: null,
      },
    ],
    videoUrl: 'https://www.youtube.com/watch?v=C5n1fN8TGHs',
    recipePage: null,
    originalSourceUrl: null,
    rawTags: null,
    annotations: [],
    retainedSources: [],
    provenance: {
      kind: 'authored',
      authorId: 'Fixture author',
      createdAt: '2026-10-01T00:00:00.000Z',
      changeSummary: 'Exact authored changes.',
      basedOn: null,
      credits: [{ label: 'Fixture original creator', url: 'https://example.test/credit' }],
    },
  };
}

function translated(recipe = authored()): Immutable<ReadingRecipe> {
  const item: PublishedRecipeTranslation = {
    translationId: 'reader-translation-fixture',
    translationRevision: 2,
    sourceRef: { ...recipe.contentRef },
    originalLanguage: 'en',
    targetLanguage: 'ar',
    content: {
      title: 'عنوان الوصفة',
      description: null,
      category: 'حساء',
      cuisine: 'تجريبي',
      rawTags: null,
      ingredients: recipe.ingredients.map((row) => ({
        position: row.position,
        rawName: `مكون ${row.position}`,
      })),
      instructions: recipe.instructions.map((row) => ({
        sequence: row.sequence,
        rawText: `فقرة ${row.sequence}\nنص محفوظ.`,
      })),
    },
    attribution: 'mixed',
    machineAssisted: true,
    review: {
      reviewerId: 'fixture-reviewer',
      reviewedAt: '2026-10-02T00:00:00.000Z',
      source: 'Presentation fixture, not human language acceptance.',
      evidence: 'operator_acknowledgement',
    },
    permission: {
      subject: {
        scope: 'translated_recipe_text',
        translationId: 'reader-translation-fixture',
        translationRevision: 2,
        language: 'ar',
      },
      status: 'permitted',
      statement: 'Fixture permission only.',
      sourceUrl: null,
      review: {
        reviewerId: 'fixture-reviewer',
        reviewedAt: '2026-10-02T00:00:00.000Z',
        source: 'Fixture permission.',
      },
      contentBinding: 'c'.repeat(64),
    },
  };
  return { ...recipe, translations: [item] };
}
const readPhoto: ContentRecipeReaderViewProps['readPhoto'] = async () => {
  throw new Error('Unused presentation port');
};
function props(
  recipe = authored(),
  state: Extract<ReadingLookup, { kind: 'readable' }>['state'] = 'current',
): ContentRecipeReaderViewProps {
  return {
    lookup: { kind: 'readable', recipe, state },
    readPhoto,
    scopeKey: 'owner:head:1',
    onBack: jest.fn(),
    onCleanupFailure: jest.fn(),
  };
}

test('exact authored quantities/title/paragraphs render without workbook casts or invented capabilities', () => {
  const recipe = authored(),
    plan = jest.fn();
  const view = render(<ContentRecipeReaderView {...props(recipe)} onPlan={plan} />);
  expect(view.getByText(recipe.title).props.numberOfLines).toBeUndefined();
  expect(view.getByText('  1½ tbsp + 2 tsp  ')).toBeTruthy();
  expect(view.getByText('Amount not supplied')).toBeTruthy();
  expect(mockPhotoProps?.recipe.contentRef).toEqual(recipe.contentRef);
  expect(view.queryByLabelText(/favourite/i)).toBeNull();
  expect(view.queryByText('Ask about this recipe')).toBeNull();
  fireEvent.press(view.getByRole('button', { name: 'Add to plan' }));
  expect(plan).toHaveBeenCalledWith(recipe.contentRef);
  fireEvent.press(view.getByRole('tab', { name: 'Instructions' }));
  for (const passage of recipe.instructions) expect(view.getByText(passage.rawText)).toBeTruthy();
  expect(view.queryByTestId('exact-video')).toBeNull();
  expect(view.queryByText(/Cooking passage/)).toBeNull();
});

test('title watch opens one exact player; tab/scope changes stop it and reset local state', () => {
  const initial = props(),
    view = render(<ContentRecipeReaderView {...initial} />);
  fireEvent.press(view.getByRole('button', { name: 'Watch recipe' }));
  expect(view.getByRole('tab', { name: 'Instructions' })).toBeSelected();
  expect(view.getAllByTestId('exact-video')).toHaveLength(1);
  expect(mockPlayer?.videoId).toBe('C5n1fN8TGHs');
  fireEvent.press(view.getByRole('tab', { name: 'Source' }));
  expect(view.queryByTestId('exact-video')).toBeNull();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  const watches = view.getAllByRole('button', { name: 'Watch recipe' });
  fireEvent.press(watches[watches.length - 1]!);
  expect(view.getAllByTestId('exact-video')).toHaveLength(1);
  view.rerender(<ContentRecipeReaderView {...initial} scopeKey="owner:head:2" />);
  expect(view.getByRole('tab', { name: 'Ingredients' })).toBeSelected();
  expect(view.queryByTestId('exact-video')).toBeNull();
  expect(mockUnmount).toHaveBeenCalledTimes(2);
});

test('a changed exact revision resets state even when recipe ID and scope stay the same', () => {
  const initial = props(),
    view = render(<ContentRecipeReaderView {...initial} />);
  fireEvent.press(view.getByRole('button', { name: 'Watch recipe' }));
  const next = authored();
  view.rerender(
    <ContentRecipeReaderView
      {...props({ ...next, contentRef: { ...next.contentRef, revisionId: 'another-revision' } })}
    />,
  );
  expect(view.getByRole('tab', { name: 'Ingredients' })).toBeSelected();
  expect(view.queryByTestId('exact-video')).toBeNull();
});

test('archive/historical states are explicit and plan capability is optional', () => {
  const plan = jest.fn();
  const view = render(<ContentRecipeReaderView {...props(authored(), 'archived')} onPlan={plan} />);
  expect(view.getByText('Archived recipe')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Add to plan' })).toBeNull();
  view.rerender(<ContentRecipeReaderView {...props(authored(), 'historical')} onPlan={plan} />);
  expect(view.getByText('Saved recipe version')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Add to plan' })).toBeNull();
  expect(plan).not.toHaveBeenCalled();
  view.rerender(<ContentRecipeReaderView {...props(authored())} />);
  expect(view.queryByRole('button', { name: 'Add to plan' })).toBeNull();
});

test('a retained current Plan callback cannot act after the same exact version becomes historical', () => {
  const recipe = authored(),
    plan = jest.fn();
  const view = render(<ContentRecipeReaderView {...props(recipe)} onPlan={plan} />);
  const press = view
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Add to plan')!.props.onPress;
  view.rerender(<ContentRecipeReaderView {...props(recipe, 'historical')} onPlan={plan} />);
  act(() => press());
  expect(plan).not.toHaveBeenCalled();
});

test('withdrawn/missing views reveal no body, photo, video or planning actions', () => {
  const initial = props(),
    view = render(
      <ContentRecipeReaderView
        {...initial}
        lookup={{
          kind: 'withdrawn',
          recipeId: imported.recipeId,
          reason: 'Fixture rights withdrawal.',
        }}
      />,
    );
  expect(view.getByText('Fixture rights withdrawal.')).toBeTruthy();
  expect(view.queryByTestId('exact-photo')).toBeNull();
  expect(view.queryByRole('tab')).toBeNull();
  fireEvent.press(view.getByRole('button', { name: 'Back' }));
  expect(initial.onBack).toHaveBeenCalledTimes(1);
  view.rerender(<ContentRecipeReaderView {...initial} lookup={{ kind: 'missing' }} />);
  expect(view.getByText('Recipe unavailable')).toBeTruthy();
});

test('authored credits and inherited original notes remain distinct with exact evidence', () => {
  const source = imported.retainedSources[0]!;
  const note: ReadingRecipe['annotations'][number] = {
    annotationId: 'fixture-source-note',
    recipeId: imported.recipeId,
    kind: 'source_gap',
    ruleVersion: 'fixture-only',
    note: 'Original conflicting instruction retained verbatim.',
    evidence: [{ sheet: 'Instructions' as const, row: 42, column: 'B' }],
  };
  const recipe: Immutable<ReadingRecipe> = {
    ...authored(),
    retainedSources: [
      {
        ...source,
        disposition: 'inherited_unresolved',
        document: {
          ...source.document,
          recipe: { ...source.document.recipe, annotations: [note] },
        },
      },
    ],
  };
  const view = render(<ContentRecipeReaderView {...props(recipe)} />);
  expect(view.getByText('Original source notes remain unresolved')).toBeTruthy();
  fireEvent.press(view.getByRole('button', { name: 'Read original source notes' }));
  expect(view.getByText('Authored by Fixture author')).toBeTruthy();
  expect(view.getByText('Fixture original creator')).toBeTruthy();
  expect(view.getAllByText(note.note)).toHaveLength(1);
  fireEvent.press(view.getByRole('button', { name: 'Show worksheet references' }));
  expect(view.getByText('Instructions B42')).toBeTruthy();
  expect(view.queryByText(/Recipe content and supplied photographs are retained from/)).toBeNull();
});

test('actual imported passages and annotations use the real retained document without duplicates', () => {
  const view = render(<ContentRecipeReaderView {...props(imported)} />);
  fireEvent.press(view.getByRole('tab', { name: 'Instructions' }));
  for (const passage of imported.instructions)
    expect(view.getAllByText(passage.rawText)).toHaveLength(1);
  fireEvent.press(view.getByRole('tab', { name: 'Source' }));
  fireEvent.press(view.getByRole('button', { name: 'About this source' }));
  for (const note of imported.annotations) expect(view.getAllByText(note.note)).toHaveLength(1);
  expect(view.queryByText(/Authored by/)).toBeNull();
});

test('cooking presentation reuses exact authored words and quantities without inventing reviewed roles', () => {
  const recipe = authored();
  let captured: ContentCookingReadingParts | undefined;
  const view = render(
    <ContentRecipeReaderView
      {...props(recipe)}
      renderCooking={(parts) => {
        captured = parts;
        return null;
      }}
    />,
  );
  expect(captured?.recipe).toBe(recipe);
  expect(captured?.sectionRoles.every((role) => role === null)).toBe(true);
  const parts = captured!;
  view.unmount();
  const cooking = render(
    <>
      {parts.ingredients}
      {parts.fullInstructions}
    </>,
  );
  expect(cooking.getByText(recipe.ingredients[0]!.rawMeasure!)).toBeTruthy();
  for (const passage of recipe.instructions)
    expect(cooking.getAllByText(passage.rawText)).toHaveLength(1);
});

test('the private-note entry remains separate from source visibility and recipe actions', () => {
  const open = jest.fn();
  const initial = props(authored());
  const personalControl = <ActionButton label="Private note" variant="quiet" onPress={open} />;
  const view = render(<ContentRecipeReaderView {...initial} personalControl={personalControl} />);
  fireEvent.press(view.getByRole('button', { name: 'Private note' }));
  expect(open).toHaveBeenCalledTimes(1);
  view.rerender(
    <ContentRecipeReaderView
      {...initial}
      lookup={{ kind: 'missing' }}
      personalControl={personalControl}
    />,
  );
  expect(view.queryByTestId('exact-photo')).toBeNull();
  expect(view.queryByRole('button', { name: 'Add to plan' })).toBeNull();
  fireEvent.press(view.getByRole('button', { name: 'Private note' }));
  expect(open).toHaveBeenCalledTimes(2);
});

test('unsupported supplied video is a manual safe link and failures retain the instructions', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('Offline'));
  const recipe = { ...authored(), videoUrl: 'https://example.test/video' };
  const view = render(<ContentRecipeReaderView {...props(recipe)} />);
  expect(view.queryByRole('button', { name: 'Watch recipe' })).toBeNull();
  fireEvent.press(view.getByRole('tab', { name: 'Instructions' }));
  expect(view.getByText('This supplied video link cannot be played inside CookMate.')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByRole('button', { name: 'Open video source ↗' })));
  expect(open).toHaveBeenCalledWith(recipe.videoUrl);
  expect(view.getByText('Couldn’t open this source')).toBeTruthy();
  expect(view.getByText(recipe.instructions[1]!.rawText)).toBeTruthy();
  expect(view.queryByTestId('exact-video')).toBeNull();
});

test('reviewed language is selected explicitly and View original restores exact source text', () => {
  const recipe = translated(),
    translation = recipe.translations![0]!;
  const view = render(<ContentRecipeReaderView {...props(recipe)} />);
  expect(view.getByText(recipe.title)).toBeTruthy();
  expect(view.getByText(recipe.description!)).toBeTruthy();
  expect(view.getByRole('button', { name: 'Original text' })).toBeSelected();
  expect(view.queryByText(translation.content.title)).toBeNull();
  expect(view.queryByText('Reviewed translation')).toBeNull();
  fireEvent.press(view.getByRole('button', { name: 'العربية' }));
  expect(view.getByRole('button', { name: 'العربية' })).toBeSelected();
  expect(view.getByText(translation.content.title)).toHaveStyle({
    writingDirection: 'rtl',
    textAlign: 'right',
  });
  expect(
    view.getByText(`${translation.content.cuisine} · ${translation.content.category}`),
  ).toBeTruthy();
  expect(view.getByText(translation.content.ingredients[0]!.rawName)).toBeTruthy();
  expect(view.queryByText(recipe.title)).toBeNull();
  expect(view.queryByText(recipe.description!)).toBeNull();
  expect(view.getByText('Reviewed translation')).toBeTruthy();
  expect(
    view.getByText(
      'Machine-assisted translation. Review does not establish independent language certification.',
    ),
  ).toBeTruthy();
  fireEvent.press(view.getByRole('button', { name: 'View original' }));
  expect(view.getByRole('button', { name: 'Original text' })).toBeSelected();
  expect(view.getByText(recipe.title)).toBeTruthy();
  expect(view.getByText(recipe.description!)).toBeTruthy();
  expect(view.getByText(recipe.ingredients[0]!.rawName)).toBeTruthy();
  expect(view.queryByText('Reviewed translation')).toBeNull();
});

test('switching reviewed languages uses that translation description and direction without inheriting another attribution', () => {
  const original = translated(),
    arabic = original.translations![0]!;
  const french: Immutable<PublishedRecipeTranslation> = {
    ...arabic,
    translationId: 'reader-french-fixture',
    targetLanguage: 'fr',
    attribution: 'human',
    machineAssisted: false,
    content: {
      ...arabic.content,
      title: 'Titre français',
      description: 'Description française.',
      category: 'Soupe',
      cuisine: 'Exemple',
    },
    permission: {
      ...arabic.permission,
      subject: {
        scope: 'translated_recipe_text',
        translationId: 'reader-french-fixture',
        translationRevision: arabic.translationRevision,
        language: 'fr',
      },
    },
  };
  const recipe: Immutable<ReadingRecipe> = { ...original, translations: [arabic, french] };
  const view = render(<ContentRecipeReaderView {...props(recipe)} />);
  fireEvent.press(view.getByRole('button', { name: 'العربية' }));
  fireEvent.press(view.getByRole('button', { name: 'français' }));
  expect(view.getByRole('button', { name: 'français' })).toBeSelected();
  expect(view.getByRole('button', { name: 'العربية' })).not.toBeSelected();
  expect(view.getByText(french.content.title)).not.toHaveStyle({ writingDirection: 'rtl' });
  expect(view.getByText(french.content.description!)).toBeTruthy();
  expect(view.queryByText(arabic.content.title)).toBeNull();
  expect(view.queryByText(/Machine-assisted translation/)).toBeNull();
});

test.each([
  ['ar', 'rtl'],
  ['ar-Arab', 'rtl'],
  ['en-Hebr', 'rtl'],
  ['ar-Latn', 'ltr'],
  ['ar-Cyrl', 'ltr'],
  ['ar-Deva', undefined],
] as const)(
  'explicit script takes precedence in translated text direction for %s',
  (language, direction) => {
    const original = translated(),
      item = original.translations![0]!;
    const recipe: Immutable<ReadingRecipe> = {
      ...original,
      translations: [
        {
          ...item,
          targetLanguage: language,
          content: { ...item.content, title: `Script fixture ${language}` },
          permission: {
            ...item.permission,
            subject: {
              scope: 'translated_recipe_text',
              translationId: item.translationId,
              translationRevision: item.translationRevision,
              language,
            },
          },
        },
      ],
    };
    const view = render(<ContentRecipeReaderView {...props(recipe)} />);
    const choice = view
      .getAllByRole('button')
      .find((button) => button.props.accessibilityState?.selected === false)!;
    fireEvent.press(choice);
    const title = view.getByText(recipe.translations![0]!.content.title);
    if (direction)
      expect(title).toHaveStyle({
        writingDirection: direction,
        textAlign: direction === 'rtl' ? 'right' : 'left',
      });
    else {
      expect(title).not.toHaveStyle({ writingDirection: 'rtl' });
      expect(title).not.toHaveStyle({ writingDirection: 'ltr' });
    }
    expect(view.getByText(recipe.ingredients[0]!.rawMeasure!)).toBeTruthy();
  },
);

test('translated reading preserves exact quantities, unknown amounts, notes, media, links and private/exact actions', async () => {
  const note: ReadingRecipe['annotations'][number] = {
    annotationId: 'unchanged-amount-note',
    recipeId: imported.recipeId,
    kind: 'missing_measure',
    ruleVersion: 'fixture-only',
    note: 'Original amount is not supplied.',
    evidence: [{ sheet: 'Ingredients', row: 42, column: 'F' }],
  };
  const recipe = translated({
    ...authored(),
    annotations: [note],
    originalSourceUrl: 'https://example.test/source',
    recipePage: 'https://example.test/collection',
  });
  const translation = recipe.translations![0]!,
    plan = jest.fn(),
    privateNote = jest.fn(),
    save = jest.fn(),
    cooked = jest.fn();
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const view = render(
    <ContentRecipeReaderView
      {...props(recipe)}
      onPlan={plan}
      personalControl={<ActionButton label="Private note" onPress={privateNote} />}
      saveControl={<ActionButton label="Save exact recipe" onPress={save} />}
      cookingControl={<ActionButton label="Mark cooked" onPress={cooked} />}
    />,
  );
  fireEvent.press(view.getByRole('button', { name: 'العربية' }));
  expect(view.getByText(recipe.ingredients[0]!.rawMeasure!)).toBeTruthy();
  expect(view.getByText('Amount not supplied')).toBeTruthy();
  expect(view.getAllByText(note.note)).toHaveLength(1);
  expect(mockPhotoProps?.recipe).toBe(recipe);
  expect(mockPhotoProps?.scopeKey).toBe('owner:head:1');
  fireEvent.press(view.getByRole('button', { name: 'Add to plan' }));
  expect(plan).toHaveBeenCalledWith(recipe.contentRef);
  fireEvent.press(view.getByRole('button', { name: 'Private note' }));
  fireEvent.press(view.getByRole('button', { name: 'Save exact recipe' }));
  expect(privateNote).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByRole('button', { name: 'Watch recipe' }));
  expect(mockPlayer?.videoId).toBe('C5n1fN8TGHs');
  expect(
    view.getByRole('header', { name: translation.content.instructions[0]!.rawText }),
  ).toBeTruthy();
  expect(view.getByText(translation.content.instructions[1]!.rawText)).toBeTruthy();
  expect(view.getAllByText(note.note)).toHaveLength(1);
  fireEvent.press(view.getByRole('button', { name: 'Mark cooked' }));
  expect(cooked).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByRole('tab', { name: 'Source' }));
  await act(async () =>
    fireEvent.press(view.getByRole('button', { name: 'Open original publisher' })),
  );
  expect(open).toHaveBeenCalledWith(recipe.originalSourceUrl);
  await act(async () =>
    fireEvent.press(view.getByRole('button', { name: 'Open recipe collection' })),
  );
  expect(open).toHaveBeenCalledWith(recipe.recipePage);
  expect(mockPhotoProps?.recipe).toBe(recipe);
});

test('translations retain all original imported instruction notes once and original toggle restores passage helpers', () => {
  const recipe = translated(imported),
    translation = recipe.translations![0]!;
  const view = render(<ContentRecipeReaderView {...props(recipe)} />);
  fireEvent.press(view.getByRole('button', { name: 'العربية' }));
  fireEvent.press(view.getByRole('tab', { name: 'Instructions' }));
  for (const note of imported.annotations) expect(view.getAllByText(note.note)).toHaveLength(1);
  for (const passage of translation.content.instructions)
    expect(view.getAllByText(passage.rawText)).toHaveLength(1);
  for (const passage of imported.instructions) expect(view.queryByText(passage.rawText)).toBeNull();
  fireEvent.press(view.getByRole('button', { name: 'View original' }));
  for (const passage of imported.instructions)
    expect(view.getAllByText(passage.rawText)).toHaveLength(1);
  expect(mockPhotoProps?.recipe).toBe(recipe);
});

test('language selection resets on owner scope or exact reference changes and retired controls stay inert', () => {
  for (const changed of ['scope', 'reference'] as const) {
    const recipe = translated(),
      view = render(<ContentRecipeReaderView {...props(recipe)} />);
    const oldPress = view
      .UNSAFE_getAllByType(ActionButton)
      .find((button) => button.props.label === 'العربية')!.props.onPress;
    fireEvent.press(view.getByRole('button', { name: 'العربية' }));
    const next =
      changed === 'reference'
        ? translated({
            ...authored(),
            contentRef: { ...recipe.contentRef, revisionId: 'new-exact-reference' },
          })
        : recipe;
    const nextProps = {
      ...props(next),
      scopeKey: changed === 'scope' ? 'different-owner:head:1' : 'owner:head:1',
    };
    view.rerender(<ContentRecipeReaderView {...nextProps} />);
    expect(view.getByRole('button', { name: 'Original text' })).toBeSelected();
    expect(view.getByText(next.title)).toBeTruthy();
    act(() => oldPress());
    expect(view.getByRole('button', { name: 'Original text' })).toBeSelected();
    fireEvent.press(view.getByRole('button', { name: 'العربية' }));
    expect(view.getByText(next.translations![0]!.content.title)).toBeTruthy();
    view.unmount();
  }
});

test('baseline and older recipes without translations expose no language choices or review claims', () => {
  const { translations: _translations, ...older } = authored();
  for (const recipe of [imported, older]) {
    const view = render(<ContentRecipeReaderView {...props(recipe)} />);
    expect(view.getByText(recipe.title)).toBeTruthy();
    expect(view.queryByText('Recipe language')).toBeNull();
    expect(view.queryByText('Reviewed translation')).toBeNull();
    expect(view.queryByRole('button', { name: 'Original text' })).toBeNull();
    expect(view.queryByRole('button', { name: 'العربية' })).toBeNull();
    view.unmount();
  }
});

test('translated cooking presentation retains the exact original recipe authority and section roles', () => {
  const recipe = translated();
  let captured: ContentCookingReadingParts | undefined;
  const view = render(
    <ContentRecipeReaderView
      {...props(recipe)}
      renderCooking={(parts) => {
        captured = parts;
        return null;
      }}
    />,
  );
  const originalRoles = captured!.sectionRoles;
  fireEvent.press(view.getByRole('button', { name: 'العربية' }));
  const parts = captured!;
  expect(parts.recipe).toBe(recipe);
  expect(parts.sectionRoles).toEqual(originalRoles);
  view.unmount();
  const cooking = render(
    <>
      {parts.ingredients}
      {parts.fullInstructions}
    </>,
  );
  expect(cooking.getByText(recipe.ingredients[0]!.rawMeasure!)).toBeTruthy();
  expect(cooking.getByText('Amount not supplied')).toBeTruthy();
  for (const passage of recipe.translations![0]!.content.instructions)
    expect(cooking.getByText(passage.rawText)).toBeTruthy();
});
