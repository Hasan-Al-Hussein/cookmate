import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ActionButton } from '../../components/Controls';
import { PrivateContentEntry } from './PrivateContentEntry';
import type {
  PrivateContentController,
  PrivateContentPreparation,
} from './privateContentController';
import { PrivateContentCleanupError } from './privateContentRuntime';
import type { PrivateContentScreen } from './PrivateContentScreen';

jest.mock('@cookmate/catalogue/content-trust', () => ({ createContentTrustVerifier: jest.fn() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
let mockScreenProps: ComponentProps<typeof PrivateContentScreen> | undefined;
jest.mock('./PrivateContentScreen', () => ({
  PrivateContentScreen: (props: ComponentProps<typeof PrivateContentScreen>) => {
    mockScreenProps = props;
    const { Text } = jest.requireActual('react-native');
    return <Text>Opened private reader boundary</Text>;
  },
}));
function setup() {
  const controller: PrivateContentController = {
    open: jest.fn(async () => {
      throw new Error('screen boundary owns opening');
    }),
    prepare: jest.fn(
      async (): Promise<PrivateContentPreparation> => ({ kind: 'prepared', resumed: false }),
    ),
  };
  return controller;
}
afterEach(() => {
  cleanup();
  mockScreenProps = undefined;
});

test('render is read only; explicit preparation never opens or adopts content', async () => {
  const controller = setup();
  const screen = render(<PrivateContentEntry controller={controller} />);
  expect(controller.prepare).not.toHaveBeenCalled();
  expect(controller.open).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  await waitFor(() => expect(screen.getByText('Review workspace prepared')).toBeTruthy());
  expect(controller.prepare).toHaveBeenCalledTimes(1);
  expect(controller.open).not.toHaveBeenCalled();
  expect(screen.queryByText('Opened private reader boundary')).toBeNull();
  fireEvent.press(screen.getByText('Open prepared review workspace'));
  expect(mockScreenProps?.open).toBe(controller.open);
  act(() => mockScreenProps?.onExit());
  expect(screen.getByText('Separate review workspace')).toBeTruthy();
});

test('retained open and preparation handlers cannot race an in-flight preparation', async () => {
  const controller = setup();
  let finish!: () => void;
  controller.prepare = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ kind: 'prepared', resumed: true });
      }),
  );
  const screen = render(<PrivateContentEntry controller={controller} />);
  const buttons = screen.UNSAFE_getAllByType(ActionButton);
  const open = buttons.find((button) => button.props.label === 'Open prepared review workspace')!
    .props.onPress;
  const prepare = buttons.find((button) => button.props.label === 'Prepare new review workspace')!
    .props.onPress;
  act(() => {
    prepare();
    prepare();
    open();
  });
  expect(controller.prepare).toHaveBeenCalledTimes(1);
  expect(mockScreenProps).toBeUndefined();
  await act(async () => finish());
  expect(screen.getByText(/Interrupted preparation was safely resumed/)).toBeTruthy();
});

test('cleanup failure disables both actions and remains blocked for retained callbacks', async () => {
  const controller = setup();
  controller.prepare = jest.fn(async () => {
    throw new PrivateContentCleanupError([]);
  });
  const screen = render(<PrivateContentEntry controller={controller} />);
  const buttons = screen.UNSAFE_getAllByType(ActionButton);
  const open = buttons.find((button) => button.props.label === 'Open prepared review workspace')!
    .props.onPress;
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  await waitFor(() => expect(screen.getByText('Workspace cleanup is unconfirmed')).toBeTruthy());
  act(() => open());
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  expect(controller.prepare).toHaveBeenCalledTimes(1);
  expect(mockScreenProps).toBeUndefined();
});

test('clean preparation refusal permits a deliberate retry', async () => {
  const controller = setup();
  controller.prepare = jest
    .fn()
    .mockRejectedValueOnce(new Error('not admitted'))
    .mockResolvedValueOnce({ kind: 'already_prepared', resumed: false });
  const screen = render(<PrivateContentEntry controller={controller} />);
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  await waitFor(() => expect(screen.getByText('Preparation could not finish')).toBeTruthy());
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  await waitFor(() => expect(screen.getByText('Existing review workspace verified')).toBeTruthy());
});

test('leaving the entry synchronously blocks a retained preparation handler', () => {
  const controller = setup();
  const screen = render(<PrivateContentEntry controller={controller} />);
  const buttons = screen.UNSAFE_getAllByType(ActionButton);
  const open = buttons.find((button) => button.props.label === 'Open prepared review workspace')!
    .props.onPress;
  const prepare = buttons.find((button) => button.props.label === 'Prepare new review workspace')!
    .props.onPress;
  act(() => {
    open();
    prepare();
  });
  expect(mockScreenProps?.open).toBe(controller.open);
  expect(controller.prepare).not.toHaveBeenCalled();
});

test('late preparation for a replaced controller cannot update or unblock its successor', async () => {
  const old = setup(),
    next = setup();
  let finishOld!: () => void;
  old.prepare = jest.fn(
    () =>
      new Promise((resolve) => {
        finishOld = () => resolve({ kind: 'prepared', resumed: true });
      }),
  );
  const screen = render(<PrivateContentEntry controller={old} />);
  const oldPrepare = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Prepare new review workspace')!.props.onPress;
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  screen.rerender(<PrivateContentEntry controller={next} />);
  await act(async () => {
    await oldPrepare();
  });
  await act(async () => finishOld());
  expect(screen.queryByText('Review workspace prepared')).toBeNull();
  expect(old.prepare).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Prepare new review workspace'));
  await waitFor(() => expect(screen.getByText('Review workspace prepared')).toBeTruthy());
  expect(next.prepare).toHaveBeenCalledTimes(1);
});
