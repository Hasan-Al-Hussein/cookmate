import { Dimensions, Text, View, type ScaledSize } from 'react-native';
import type { ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react-native';
import { catalogue, getRecipePhotoTreatment } from '@cookmate/catalogue';
import { useNativeLayout } from '../hooks/useNativeLayout';
import { RecipeCard } from './RecipeCard';

jest.unmock('react-native/Libraries/Utilities/useWindowDimensions');
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@cookmate/catalogue', () => {
  const actual = jest.requireActual('@cookmate/catalogue');
  return { ...actual, getRecipePhotoTreatment: jest.fn(actual.getRecipePhotoTreatment) };
});
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function environment() {
  let current: ScaledSize = { width: 428, height: 926, scale: 3, fontScale: 1 };
  const listeners = new Set<Parameters<typeof Dimensions.addEventListener>[1]>();
  jest.spyOn(Dimensions, 'get').mockImplementation(() => current);
  jest.spyOn(Dimensions, 'addEventListener').mockImplementation((_event, listener) => {
    listeners.add(listener);
    // The layout hook consumes only remove; the test supplies its own event source.
    return {
      remove: () => {
        listeners.delete(listener);
      },
    } as ReturnType<typeof Dimensions.addEventListener>;
  });
  return {
    listeners,
    change(patch: Partial<ScaledSize>) {
      current = { ...current, ...patch };
      [...listeners].forEach((listener) => listener({ window: current, screen: current }));
    },
  };
}

function LayoutProbe() {
  const layout = useNativeLayout();
  return <Text>{`${layout.width}:${layout.fontScale}:${layout.columns}`}</Text>;
}
function Cards() {
  return (
    <View>
      <LayoutProbe />
      {catalogue.recipes.slice(0, 12).map((recipe) => (
        <RecipeCard key={recipe.recipeId} recipe={recipe} presentation="editorial" />
      ))}
    </View>
  );
}

test('layout event render-work probe keeps width and text-size updates correct', () => {
  const source = environment();
  const view = render(<Cards />);
  const reads = jest.mocked(getRecipePhotoTreatment);
  const listenerCount = source.listeners.size;
  const initialReads = reads.mock.calls.length;
  reads.mockClear();
  for (const height of [720, 620, 926]) act(() => source.change({ height }));
  const heightOnlyReads = reads.mock.calls.length;
  expect(listenerCount).toBe(1);
  expect(heightOnlyReads).toBe(0);
  expect(view.getByText('428:1:2')).toBeTruthy();
  reads.mockClear();
  act(() => source.change({ width: 360 }));
  const widthReads = reads.mock.calls.length;
  expect(widthReads).toBe(initialReads);
  expect(view.getByText('360:1:1')).toBeTruthy();
  reads.mockClear();
  act(() => source.change({ fontScale: 1.5 }));
  const textSizeReads = reads.mock.calls.length;
  expect(textSizeReads).toBe(initialReads);
  expect(view.getByText('360:1.5:1')).toBeTruthy();
  view.unmount();
  expect(source.listeners.size).toBe(0);
  // Deterministic React work counts, not device frame-rate or wall-clock measurements.
  console.info('CookMate layout probe', {
    cards: 12,
    listenerCount,
    initialReads,
    heightOnlyReads,
    widthReads,
    textSizeReads,
  });
});

test('the last consumer releases the listener and remount reads dimensions changed while idle', () => {
  const source = environment();
  const first = render(<LayoutProbe />);
  const second = render(<LayoutProbe />);
  expect(source.listeners.size).toBe(1);
  first.unmount();
  expect(source.listeners.size).toBe(1);
  act(() => source.change({ width: 380, fontScale: 1.3 }));
  expect(second.getByText('380:1.3:1')).toBeTruthy();
  second.unmount();
  expect(source.listeners.size).toBe(0);
  source.change({ width: 428, fontScale: 1 });
  const returning = render(<LayoutProbe />);
  expect(returning.getByText('428:1:2')).toBeTruthy();
  expect(source.listeners.size).toBe(1);
  returning.unmount();
  expect(source.listeners.size).toBe(0);
});

test('server rendering uses its stable fallback without a Dimensions read or subscription', () => {
  const source = environment();
  const { renderToStaticMarkup } = require('react-dom/server.node') as {
    renderToStaticMarkup(node: ReactNode): string;
  };
  let observed: ReturnType<typeof useNativeLayout> | undefined;
  function ServerProbe() {
    observed = useNativeLayout();
    return null;
  }
  renderToStaticMarkup(<ServerProbe />);
  const initial = observed;
  renderToStaticMarkup(<ServerProbe />);
  expect(observed).toBe(initial);
  expect(observed).toEqual({ width: 0, fontScale: 1, columns: 1, enlarged: false });
  expect(Dimensions.get).not.toHaveBeenCalled();
  expect(source.listeners.size).toBe(0);
});

test('synthetic mixed-script title remains exact at narrow and enlarged text sizes', () => {
  const source = environment();
  const title =
    'وصفة تجريبية — Creamy chicken with spinach, tomatoes and a long original recipe title';
  const recipe = { ...catalogue.recipes[0]!, title };
  const view = render(<RecipeCard recipe={recipe} presentation="editorial" />);
  for (const width of [428, 390, 320]) {
    act(() => source.change({ width, fontScale: 1.5 }));
    expect(view.getByRole('button', { name: `Open ${title}, ${recipe.cuisine}` })).toBeTruthy();
    for (const text of view.getAllByText(title)) expect(text.props.numberOfLines).toBeUndefined();
  }
});
