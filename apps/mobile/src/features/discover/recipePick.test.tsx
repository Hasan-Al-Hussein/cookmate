import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { getRecipe } from '@cookmate/catalogue';
import { pickRecipeId, RecipePick } from './RecipePick';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
afterEach(() => {
  cleanup();
  mockPush.mockClear();
});

test('a choice cannot escape the eligible set or repeat the same pick when alternatives exist', () => {
  for (const random of [0, 0.25, 0.75, 0.999]) {
    expect(pickRecipeId(['52839', '53064'], '52839', () => random)).toBe('53064');
    expect(['52839', '53064']).toContain(pickRecipeId(['52839', '53064'], undefined, () => random));
  }
});
test('zero, one, duplicate and unavailable IDs are handled honestly', () => {
  expect(pickRecipeId([])).toBeNull();
  expect(pickRecipeId(['not-a-recipe'])).toBeNull();
  expect(pickRecipeId(['52839', '52839', 'not-a-recipe'], '52839')).toBe('52839');
});
test('the selected recipe stays stable through render and opens its exact identity', () => {
  const recipe = getRecipe('52839')!;
  const another = jest.fn();
  const dismiss = jest.fn();
  const tree = render(
    <RecipePick recipe={recipe} count={2} onAnother={another} onDismiss={dismiss} />,
  );
  tree.rerender(<RecipePick recipe={recipe} count={2} onAnother={another} onDismiss={dismiss} />);
  expect(screen.getAllByText(recipe.title).length).toBeGreaterThan(0);
  expect(another).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'View picked recipe' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: '52839' } });
  fireEvent.press(screen.getByRole('button', { name: 'Pick another' }));
  expect(another).toHaveBeenCalledTimes(1);
});
test('a single eligible recipe offers no misleading pick-another control', () => {
  render(
    <RecipePick
      recipe={getRecipe('52839')!}
      count={1}
      onAnother={jest.fn()}
      onDismiss={jest.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Pick another' })).toBeNull();
  expect(screen.getByText('The only recipe matching these criteria.')).toBeTruthy();
});
