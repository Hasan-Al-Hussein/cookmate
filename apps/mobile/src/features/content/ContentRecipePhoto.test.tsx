import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { createBundledContentReader, type ReadingRecipe } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import type { OrdinaryCatalogueController } from './ordinaryCatalogueState';
import { ContentRecipePhoto } from './ContentRecipePhoto';
import { RecipePhoto } from '../../components/RecipePhoto';
import { createContentPhotoResource } from './contentPhotoResource';
import { ContentPhotoCleanupError } from './contentPhotoResourceTypes';

jest.mock('./contentPhotoResource', () => ({ createContentPhotoResource: jest.fn() }));
let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
const resource = jest.mocked(createContentPhotoResource);
let recipe: Immutable<ReadingRecipe>;
let flagged: Immutable<ReadingRecipe>;
const cleanupFailure = jest.fn();
beforeAll(async () => {
  // A presentation fixture only; cryptographic verification is covered by the signed-store bridge.
  const bundled = await createBundledContentReader(async () => 'a'.repeat(64));
  recipe = bundled.recipes.find((r) => r.recipeId === '52819')!;
  flagged = bundled.recipes.find(
    (r) =>
      r.provenance.kind === 'imported' && r.provenance.photoTreatment.warningAnnotationId !== null,
  )!;
});
beforeEach(() => {
  mockFocused = true;
  cleanupFailure.mockClear();
  resource
    .mockReset()
    .mockImplementation(() => ({ uri: 'blob:exact-photo', release: jest.fn(() => true) }));
});
function result() {
  return {
    installationId: 'fixture',
    ownerId: null,
    head: null,
    adoptionRevision: 0,
    identity: { version: 'fixture', fingerprint: 'a'.repeat(64) },
    value: {
      contentRef: recipe.contentRef,
      assetId: recipe.media[0]!.assetId,
      sha256: recipe.media[0]!.sha256,
      mimeType: recipe.media[0]!.mimeType,
      width: 8,
      height: 8,
      bytes: new Uint8Array([1, 2, 3]),
    },
  };
}
function reader() {
  return {
    readPhoto: jest.fn<
      ReturnType<OrdinaryCatalogueController['readPhoto']>,
      Parameters<OrdinaryCatalogueController['readPhoto']>
    >(),
  };
}
test('hidden retained routes cancel pending photos and resume only when focused', async () => {
  const content = reader();
  let finish!: (value: ReturnType<typeof result>) => void;
  content.readPhoto.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const mounted = () => (
    <ContentRecipePhoto
      recipe={recipe}
      content={content}
      scopeKey="focus"
      onCleanupFailure={cleanupFailure}
    />
  );
  const view = render(mounted());
  const first = content.readPhoto.mock.calls[0]![2]!;
  mockFocused = false;
  view.rerender(mounted());
  expect(first.aborted).toBe(true);
  await act(async () => {
    finish(result());
  });
  expect(resource).not.toHaveBeenCalled();
  expect(content.readPhoto).toHaveBeenCalledTimes(1);
  mockFocused = true;
  view.rerender(mounted());
  expect(content.readPhoto).toHaveBeenCalledTimes(2);
  expect(content.readPhoto.mock.calls[1]![2]!.aborted).toBe(false);
  view.unmount();
  expect(content.readPhoto.mock.calls[1]![2]!.aborted).toBe(true);
});
test('published photos use exact references, preserve the photo frame and clean up on retirement', async () => {
  const content = reader();
  content.readPhoto.mockResolvedValue(result());
  const release = jest.fn(() => true);
  resource.mockReturnValue({ uri: 'blob:exact-photo', release });
  const view = render(
    <ContentRecipePhoto
      recipe={recipe}
      content={content}
      scopeKey="owner1:head1"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await waitFor(() =>
    expect(view.getByLabelText(`Supplied photo of ${recipe.title}`).props.source).toEqual({
      uri: 'blob:exact-photo',
    }),
  );
  expect(content.readPhoto).toHaveBeenCalledWith(
    recipe.contentRef,
    recipe.media[0]!.assetId,
    expect.any(AbortSignal),
  );
  const signal = content.readPhoto.mock.calls[0]![2]!;
  expect(signal.aborted).toBe(false);
  fireEvent(view.getByLabelText(`Supplied photo of ${recipe.title}`), 'error');
  expect(view.getByText('Photo unavailable')).toBeTruthy();
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
});
test('late old-scope bytes cannot allocate or replace a new photo', async () => {
  const old = reader(),
    next = reader();
  let finish!: (value: ReturnType<typeof result>) => void;
  old.readPhoto.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  next.readPhoto.mockRejectedValue(new Error('Withdrawn'));
  const view = render(
    <ContentRecipePhoto
      recipe={recipe}
      content={old}
      scopeKey="owner1:head1"
      onCleanupFailure={cleanupFailure}
    />,
  );
  view.rerender(
    <ContentRecipePhoto
      recipe={recipe}
      content={next}
      scopeKey="owner2:head2"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await act(async () => {
    finish(result());
  });
  await waitFor(() => expect(view.getByText('Photo unavailable')).toBeTruthy());
  expect(resource).not.toHaveBeenCalled();
});

test('a recorded non-primary asset uses its exact verified bytes and releases them when deselected', async () => {
  const primary = recipe.media[0]!;
  const secondary = {
    ...primary,
    assetId: `sha256:${'b'.repeat(64)}`,
    sha256: 'b'.repeat(64),
    photoKey: 'recorded-secondary',
  };
  const twoPhotos: Immutable<ReadingRecipe> = { ...recipe, media: [secondary, primary] };
  const content = reader();
  content.readPhoto.mockResolvedValue({
    ...result(),
    value: { ...result().value, assetId: secondary.assetId, sha256: secondary.sha256 },
  });
  const release = jest.fn(() => true);
  resource.mockReturnValue({ uri: 'blob:recorded-secondary', release });
  const view = render(
    <ContentRecipePhoto
      recipe={twoPhotos}
      content={content}
      assetId={secondary.assetId}
      scopeKey="history"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await waitFor(() =>
    expect(view.getByLabelText(`Supplied photo of ${recipe.title}`).props.source).toEqual({
      uri: 'blob:recorded-secondary',
    }),
  );
  expect(content.readPhoto).toHaveBeenCalledWith(
    recipe.contentRef,
    secondary.assetId,
    expect.any(AbortSignal),
  );
  view.rerender(
    <ContentRecipePhoto
      recipe={twoPhotos}
      content={content}
      assetId={null}
      scopeKey="history"
      onCleanupFailure={cleanupFailure}
    />,
  );
  expect(view.getByText('Photo unavailable')).toBeTruthy();
  expect(release).toHaveBeenCalledTimes(1);
  expect(content.readPhoto).toHaveBeenCalledTimes(1);
});

test('an asset outside the verified revision never falls back to its primary photograph', () => {
  const content = reader();
  const view = render(
    <ContentRecipePhoto
      recipe={recipe}
      content={content}
      assetId={`sha256:${'c'.repeat(64)}`}
      scopeKey="missing-member"
      onCleanupFailure={cleanupFailure}
    />,
  );
  expect(view.getByText('Photo unavailable')).toBeTruthy();
  expect(content.readPhoto).not.toHaveBeenCalled();
  expect(resource).not.toHaveBeenCalled();
});
test('mismatched exact bytes never fall back to the bundled photo for the same ID', async () => {
  const content = reader(),
    wrong = result();
  wrong.value.contentRef = { ...recipe.contentRef, revisionId: 'wrong-revision' };
  content.readPhoto.mockResolvedValue(wrong);
  const view = render(
    <ContentRecipePhoto
      recipe={recipe}
      content={content}
      scopeKey="owner1:head1"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await waitFor(() => expect(view.getByText('Photo unavailable')).toBeTruthy());
  expect(resource).not.toHaveBeenCalled();
  expect(view.queryByLabelText(`Supplied photo of ${recipe.title}`)).toBeNull();
});
test('existing bundled photo keeps its layout and independent load-failure presentation', () => {
  const view = render(<RecipePhoto recipeId={recipe.recipeId} title={recipe.title} />);
  const image = view.getByLabelText(`Supplied photo of ${recipe.title}`);
  expect(image.props.resizeMode).toBe('cover');
  fireEvent(image, 'error');
  expect(view.getByText('Photo unavailable')).toBeTruthy();
});

test('authored revisions retain treatment only for the exact reused source photograph', async () => {
  const authored: Immutable<ReadingRecipe> = {
    ...flagged,
    contentKind: 'authored',
    provenance: {
      kind: 'authored',
      authorId: 'fixture',
      createdAt: '2026-10-01T12:00:00.000Z',
      changeSummary: 'Fixture title edit',
      basedOn: flagged.contentRef,
      credits: [],
    },
    retainedSources: flagged.retainedSources.map((source) => ({
      ...source,
      disposition: 'inherited_unresolved',
    })),
  };
  const content = reader();
  content.readPhoto.mockImplementation(async (ref, assetId) => ({
    ...result(),
    value: { ...result().value, contentRef: ref, assetId },
  }));
  const view = render(
    <ContentRecipePhoto
      recipe={authored}
      content={content}
      scopeKey="reused"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await waitFor(() =>
    expect(
      view.getByLabelText(`Supplied photo for ${authored.title}; recipe association needs review`),
    ).toBeTruthy(),
  );
  expect(view.getByText('Photo needs review')).toBeTruthy();
  expect(
    view.getByLabelText(`Supplied photo for ${authored.title}; recipe association needs review`)
      .props.resizeMode,
  ).toBe('contain');
  const replacement: Immutable<ReadingRecipe> = {
    ...authored,
    media: [{ ...authored.media[0]!, assetId: `sha256:${'f'.repeat(64)}`, sha256: 'f'.repeat(64) }],
  };
  view.rerender(
    <ContentRecipePhoto
      recipe={replacement}
      content={content}
      scopeKey="replacement"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await waitFor(() =>
    expect(view.getByLabelText(`Supplied photo of ${authored.title}`)).toBeTruthy(),
  );
  expect(view.queryByText('Photo needs review')).toBeNull();
  expect(view.getByLabelText(`Supplied photo of ${authored.title}`).props.resizeMode).toBe('cover');
});
test('failed creation cleanup forwards the retryable resource and retries on unmount', async () => {
  const content = reader();
  content.readPhoto.mockResolvedValue(result());
  const owned = { uri: 'file:///owned-cache/fixture.jpg', release: jest.fn(() => false) };
  resource.mockImplementation(() => {
    throw new ContentPhotoCleanupError(owned);
  });
  const view = render(
    <ContentRecipePhoto
      recipe={recipe}
      content={content}
      scopeKey="cleanup"
      onCleanupFailure={cleanupFailure}
    />,
  );
  await waitFor(() => expect(view.getByText('Photo unavailable')).toBeTruthy());
  expect(cleanupFailure).toHaveBeenCalledWith(owned);
  owned.release.mockReturnValue(true);
  view.unmount();
  expect(owned.release).toHaveBeenCalledTimes(1);
});
