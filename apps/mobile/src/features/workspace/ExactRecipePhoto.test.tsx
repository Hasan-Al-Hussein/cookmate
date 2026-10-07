import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { catalogue, type Immutable } from '@cookmate/catalogue';
import { createRecipeSearch } from '@cookmate/domain';
import {
  createBundledContentReader,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { OrdinaryCatalogueProvider } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import { useExactPlanRecipe } from './ExactRecipePhoto';

jest.mock('../content/ContentRecipePhoto', () => ({ ContentRecipePhoto: () => null }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));

type PhotoResult = Awaited<ReturnType<OrdinaryCatalogueController['readPhoto']>>;
let recipe: Immutable<ReadingRecipe>;
beforeAll(async () => {
  // Controlled presentation fixture; the backend suite owns real verification evidence.
  recipe = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
afterEach(cleanup);

function fixture() {
  const search = createRecipeSearch({ identity: catalogue.identity, recipes: [recipe] });
  const state: OrdinaryCatalogueState = {
    kind: 'ready',
    scopeKey: 'exact-owner:head',
    mode: 'content',
    photoMode: 'verified',
    identity: catalogue.identity,
    recipes: [recipe],
    facets: search.facets,
    search: search.search,
    current: () => recipe,
  };
  const reader = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    retry: jest.fn(),
    close: jest.fn(),
    readCurrent: jest.fn(async (): Promise<ReadingLookup> => ({ kind: 'missing' })),
    readSavedIdentity: jest.fn(async (): Promise<ReadingLookup> => ({ kind: 'missing' })),
    readExact: jest.fn(
      async (_ref: RecipeContentRef): Promise<ReadingLookup> => ({
        kind: 'readable',
        state: 'historical',
        recipe,
      }),
    ),
    readPhoto: jest.fn(
      async (
        _ref: RecipeContentRef,
        _assetId: string,
        _signal?: AbortSignal,
      ): Promise<PhotoResult> => {
        throw new Error('Unused controlled photo response');
      },
    ),
    onPhotoCleanupFailure: jest.fn(),
  } satisfies OrdinaryCatalogueController;
  const response: PhotoResult = {
    installationId: '11111111-1111-4111-8111-111111111111',
    ownerId: null,
    head: null,
    adoptionRevision: 0,
    identity: catalogue.identity,
    value: {
      contentRef: recipe.contentRef,
      assetId: recipe.media[0]!.assetId,
      sha256: recipe.media[0]!.sha256,
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: new Uint8Array([1]),
    },
  };
  function wrapper({ children }: PropsWithChildren) {
    return <OrdinaryCatalogueProvider controller={reader}>{children}</OrdinaryCatalogueProvider>;
  }
  return { reader, response, wrapper };
}

test('saved exact photo wrapper forwards the same AbortSignal and exact reference', async () => {
  const f = fixture(),
    request = new AbortController();
  f.reader.readPhoto.mockResolvedValue(f.response);
  const view = renderHook(() => useExactPlanRecipe(recipe.contentRef), { wrapper: f.wrapper });
  await waitFor(() => expect(view.result.current.lookup?.kind).toBe('readable'));
  await expect(
    view.result.current.readPhoto(recipe.contentRef, f.response.value.assetId, request.signal),
  ).resolves.toBe(f.response);
  expect(f.reader.readPhoto).toHaveBeenCalledWith(
    recipe.contentRef,
    f.response.value.assetId,
    request.signal,
  );
  expect(f.reader.readPhoto.mock.calls[0]![2]).toBe(request.signal);
  expect(f.reader.readCurrent).not.toHaveBeenCalled();
});

test.each(['aborted', 'unmounted'] as const)(
  'saved exact photo wrapper discards a pending response when %s',
  async (retirement) => {
    const f = fixture(),
      request = new AbortController();
    let resolveLate!: (value: PhotoResult) => void;
    const late = new Promise<PhotoResult>((resolve) => {
      resolveLate = resolve;
    });
    const abortError = new Error('Controlled catalogue request aborted');
    f.reader.readPhoto.mockImplementation(
      (_ref, _assetId, signal) =>
        new Promise((resolve, reject) => {
          const abort = () => reject(abortError);
          signal?.addEventListener('abort', abort, { once: true });
          void late.then((value) => {
            signal?.removeEventListener('abort', abort);
            resolve(value);
          });
        }),
    );
    const view = renderHook(() => useExactPlanRecipe(recipe.contentRef), { wrapper: f.wrapper });
    await waitFor(() => expect(view.result.current.lookup?.kind).toBe('readable'));
    const readPhoto = view.result.current.readPhoto,
      escaped = jest.fn();
    const outcome = readPhoto(recipe.contentRef, f.response.value.assetId, request.signal).then(
      escaped,
      (error: unknown) => error,
    );
    expect(f.reader.readPhoto.mock.calls[0]![2]).toBe(request.signal);
    if (retirement === 'aborted') request.abort();
    else view.unmount();
    await act(async () => {
      resolveLate(f.response);
      await outcome;
    });
    expect(escaped).not.toHaveBeenCalled();
    if (retirement === 'aborted') expect(await outcome).toBe(abortError);
    else expect(await outcome).toEqual(new Error('Saved recipe scope changed'));
    expect(f.reader.readCurrent).not.toHaveBeenCalled();
  },
);
