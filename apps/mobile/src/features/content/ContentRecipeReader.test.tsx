import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  createBundledContentReader,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import type {
  ContentCookingStoreChange,
  openContentCookingStore,
} from '../../data/contentCookingStore';
import { ContentRecipeReader } from './ContentRecipeReader';
import type { ContentRecipeReaderViewProps } from './ContentRecipeReaderView';

let mockView: ContentRecipeReaderViewProps | undefined;
jest.mock('./ContentRecipeReaderView', () => ({
  ContentRecipeReaderView: (props: ContentRecipeReaderViewProps) => {
    mockView = props;
    const { Text } = jest.requireActual('react-native');
    return (
      <Text>
        {props.lookup.kind === 'readable' ? props.lookup.recipe.title : props.lookup.kind}
      </Text>
    );
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
let recipe: Immutable<ReadingRecipe>;
const back = jest.fn(),
  cleanup = jest.fn();
beforeAll(async () => {
  recipe = (await createBundledContentReader(async () => 'a'.repeat(64))).recipes[0]!;
});
beforeEach(() => {
  mockView = undefined;
});
function fixture() {
  const listeners = new Set<(change: ContentCookingStoreChange) => void>();
  const value = {
    installationId: 'fixture',
    ownerId: null,
    head: null,
    adoptionRevision: 0,
    identity: { version: 'fixture', fingerprint: 'a'.repeat(64) },
    value: { kind: 'readable' as const, state: 'current' as const, recipe },
  };
  const store = {
    content: {
      readExact: jest.fn(async (_ref: RecipeContentRef) => value),
      readCurrent: jest.fn(async (_id: string) => value),
      readPhoto: jest.fn(async () => {
        throw new Error('No photo in container-only fixture');
      }),
      readPhotos: jest.fn(async () => {
        throw new Error('No photo batch in container-only fixture');
      }),
      discover: jest.fn(async () => {
        throw new Error('Unexpected discovery');
      }),
      close() {},
    },
    subscribe(callback: (change: ContentCookingStoreChange) => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  } satisfies Pick<Awaited<ReturnType<typeof openContentCookingStore>>, 'content' | 'subscribe'>;
  return { store, value, listeners };
}
test('exact saved references stay exact through failures and an explicit retry', async () => {
  const f = fixture();
  f.store.content.readExact.mockRejectedValueOnce(new Error('Temporarily unavailable'));
  const view = render(
    <ContentRecipeReader
      store={f.store}
      target={{ kind: 'exact', ref: recipe.contentRef }}
      scopeKey="owner1"
      onBack={back}
      onCleanupFailure={cleanup}
    />,
  );
  await waitFor(() => expect(view.getByText('Recipe could not be opened')).toBeTruthy());
  expect(f.store.content.readCurrent).not.toHaveBeenCalled();
  fireEvent.press(view.getByText('Try again'));
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  expect(f.store.content.readExact).toHaveBeenNthCalledWith(1, recipe.contentRef);
  expect(f.store.content.readExact).toHaveBeenNthCalledWith(2, recipe.contentRef);
  expect(mockView!.onCleanupFailure).toBe(cleanup);
});
test('late retired owner results never replace the new selected recipe', async () => {
  const old = fixture(),
    next = fixture();
  let finish!: (value: typeof old.value) => void;
  old.store.content.readCurrent.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(
    <ContentRecipeReader
      store={old.store}
      target={{ kind: 'current', recipeId: recipe.recipeId }}
      scopeKey="owner1"
      onBack={back}
      onCleanupFailure={cleanup}
    />,
  );
  await waitFor(() => expect(old.store.content.readCurrent).toHaveBeenCalled());
  next.store.content.readCurrent.mockResolvedValue({
    ...next.value,
    value: { ...next.value.value, recipe: { ...recipe, title: 'Current owner recipe' } },
  });
  view.rerender(
    <ContentRecipeReader
      store={next.store}
      target={{ kind: 'current', recipeId: recipe.recipeId }}
      scopeKey="owner2"
      onBack={back}
      onCleanupFailure={cleanup}
    />,
  );
  await waitFor(() => expect(view.getByText('Current owner recipe')).toBeTruthy());
  await act(async () => {
    finish(old.value);
  });
  expect(view.queryByText(recipe.title)).toBeNull();
  expect(old.listeners.size).toBe(0);
  view.unmount();
  expect(next.listeners.size).toBe(0);
});
test('adoption invalidation removes old reading before reopening the same exact target', async () => {
  const f = fixture();
  const view = render(
    <ContentRecipeReader
      store={f.store}
      target={{ kind: 'exact', ref: recipe.contentRef }}
      scopeKey="owner1"
      onBack={back}
      onCleanupFailure={cleanup}
    />,
  );
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  let finish!: (value: typeof f.value) => void;
  f.store.content.readExact.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => {
    for (const listener of f.listeners) listener({ kind: 'adoption', storeRevision: 2 });
  });
  expect(view.queryByText(recipe.title)).toBeNull();
  await act(async () => {
    finish({ ...f.value, adoptionRevision: 1 });
  });
  await waitFor(() => expect(view.getByText(recipe.title)).toBeTruthy());
  expect(f.store.content.readCurrent).not.toHaveBeenCalled();
  expect(mockView!.scopeKey).toContain('1');
});
test('invalid target causes no content read or subscription', () => {
  const f = fixture();
  const view = render(
    <ContentRecipeReader
      store={f.store}
      target={{ kind: 'exact', ref: { ...recipe.contentRef, contentFingerprint: 'invalid' } }}
      scopeKey="owner1"
      onBack={back}
      onCleanupFailure={cleanup}
    />,
  );
  expect(view.getByText('Recipe could not be opened')).toBeTruthy();
  expect(f.store.content.readExact).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});
