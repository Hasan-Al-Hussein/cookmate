import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';
import { FilterSheet } from './FilterSheet';
import { ActionButton } from '../../components/Controls';

jest.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test('cuisine search chooses the canonical filter while retaining query and selected ingredients', () => {
  const apply = jest.fn();
  render(
    <FilterSheet
      visible
      criteria={{ query: 'pasta', ingredients: ['Garlic'] }}
      onApply={apply}
      onClose={jest.fn()}
      onDismiss={jest.fn()}
    />,
  );
  fireEvent.press(screen.getByRole('tab', { name: 'Cuisine' }));
  fireEvent.changeText(screen.getByLabelText('Find a cuisine filter'), 'ital');
  fireEvent.press(screen.getByRole('radio', { name: 'Italian' }));
  fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
  expect(apply).toHaveBeenLastCalledWith({
    query: 'pasta',
    ingredients: ['Garlic'],
    cuisine: 'Italian',
  });
  fireEvent.press(screen.getByRole('button', { name: 'Clear cuisine' }));
  fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
  expect(apply).toHaveBeenLastCalledWith({ query: 'pasta', ingredients: ['Garlic'], cuisine: '' });
});

test('selected ingredient chips remain removable even when hidden by the filter search', () => {
  const apply = jest.fn();
  const close = jest.fn();
  render(
    <FilterSheet
      visible
      criteria={{ query: 'dinner', ingredients: ['Garlic', 'Salt'] }}
      onApply={apply}
      onClose={close}
      onDismiss={jest.fn()}
    />,
  );
  fireEvent.press(screen.getByRole('tab', { name: 'Ingredients' }));
  fireEvent.changeText(screen.getByLabelText('Find an ingredient filter'), 'zzzz');
  fireEvent.press(screen.getByRole('button', { name: 'Remove Garlic ingredient filter' }));
  expect(screen.getByText('1 ingredients selected · Match all')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
  expect(apply).toHaveBeenLastCalledWith({ query: 'dinner', ingredients: ['Salt'] });
  fireEvent.press(screen.getByRole('button', { name: 'Reset filters' }));
  fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
  expect(apply).toHaveBeenLastCalledWith({ query: 'dinner' });
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledTimes(1);
});

test('an old Apply callback cannot apply filters after the sheet closes', () => {
  const apply = jest.fn();
  const props = {
    criteria: { query: 'pasta' },
    onApply: apply,
    onClose: jest.fn(),
    onDismiss: jest.fn(),
  };
  const view = render(<FilterSheet {...props} visible />);
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent(modal, 'show');
  const oldApply = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Apply filters')!.props.onPress as () => void;
  view.rerender(<FilterSheet {...props} visible={false} />);
  act(oldApply);
  expect(apply).not.toHaveBeenCalled();
  fireEvent(modal, 'dismiss');
});
