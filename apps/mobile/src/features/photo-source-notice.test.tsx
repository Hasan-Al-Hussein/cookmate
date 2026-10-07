import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { getRecipe, getRecipePhotoTreatment } from '@cookmate/catalogue';
import { RecipeCard } from '../components/RecipeCard';
import { RecipePhoto } from '../components/RecipePhoto';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@cookmate/catalogue/photos', () => ({
  recipePhotoAssets: { '53208': 1, '53230': 2, '53262': 3, '52839': 4, '53389': 5, '53318': 6 },
}));

afterEach(cleanup);

test('a compact failed photograph keeps its visible review warning and recipe identity', () => {
  const recipe = getRecipe('53208')!;
  render(<RecipePhoto recipeId={recipe.recipeId} title={recipe.title} compact />);
  const photo = screen.getByLabelText(
    `Supplied photo for ${recipe.title}; recipe association needs review`,
  );
  expect(screen.getByText('Photo needs review')).toBeTruthy();
  fireEvent(photo, 'error');
  expect(screen.getByText('Photo unavailable')).toBeTruthy();
  expect(screen.getByText('Photo needs review')).toBeTruthy();
  expect(screen.getByLabelText(`Photo unavailable for ${recipe.title}`)).toBeTruthy();
});

test.each(['53208', '53230'])('reviewed photo uncertainty stays visible for %s', (recipeId) => {
  const recipe = getRecipe(recipeId)!;
  render(<RecipePhoto recipeId={recipeId} title={recipe.title} />);
  expect(screen.getByText('Photo needs review')).toBeTruthy();
  expect(
    screen.getByLabelText(`Supplied photo for ${recipe.title}; recipe association needs review`),
  ).toBeTruthy();
});

test('the card announces its photo uncertainty when its open control groups the image', () => {
  const recipe = getRecipe('53208')!;
  render(<RecipeCard recipe={recipe} />);
  expect(
    screen.getByRole('button', {
      name: `Open ${recipe.title}, ${recipe.cuisine}. Photo needs review; see source notes`,
    }),
  ).toBeTruthy();
});

test.each([
  ['53262', 'contain'],
  ['52839', 'cover'],
])('a credit note or ordinary source photo keeps its reviewed framing: %s', (id, framing) => {
  const recipe = getRecipe(id)!;
  render(<RecipePhoto recipeId={id} title={recipe.title} />);
  expect(screen.queryByText('Photo needs review')).toBeNull();
  const image = screen.getByLabelText(`Supplied photo of ${recipe.title}`);
  expect(image.props.resizeMode).toBe(framing);
});

test.each(['53389', '53318'])(
  'approved v2 warning %s retains grouped card labels and its full photo frame',
  (recipeId) => {
    const recipe = getRecipe(recipeId)!;
    const treatment = getRecipePhotoTreatment(recipeId);
    expect(treatment).toMatchObject({
      recipeId,
      preserveFullFrame: true,
      warningAnnotationId: `${recipeId}-photo-uncertainty`,
      creditAnnotationId: null,
    });
    expect(
      recipe.annotations.find((note) => note.annotationId === treatment?.warningAnnotationId),
    ).toMatchObject({ recipeId, kind: 'source_gap' });
    const view = render(<RecipePhoto recipeId={recipeId} title={recipe.title} />);
    expect(screen.getByText('Photo needs review')).toBeTruthy();
    expect(
      screen.getByLabelText(`Supplied photo for ${recipe.title}; recipe association needs review`)
        .props.resizeMode,
    ).toBe('contain');
    view.unmount();
    render(<RecipeCard recipe={recipe} />);
    expect(
      screen.getByRole('button', {
        name: `Open ${recipe.title}, ${recipe.cuisine}. Photo needs review; see source notes`,
      }),
    ).toBeTruthy();
  },
);
