import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SegmentControl } from '../../components/Controls';
import { PlanningSettings } from './PlanningSettings';
import { PlanningPreferencesProvider } from '../planning-preferences/PlanningPreferencesProvider';
import {
  createPlanningPreferencesController,
  encodePlanningPreferences,
  type PlanningPreferencesController,
} from '../planning-preferences/planningPreferences';

const controllers: PlanningPreferencesController[] = [];
function setup(text: string | null = null) {
  const store = {
    read: jest.fn(async () => text),
    write: jest.fn(async (_text: string) => undefined),
  };
  const controller = createPlanningPreferencesController(store);
  controllers.push(controller);
  return { controller, store };
}
const tree = (controller: PlanningPreferencesController) => (
  <PlanningPreferencesProvider controller={controller}>
    <PlanningSettings />
  </PlanningPreferencesProvider>
);
afterEach(() => {
  cleanup();
  controllers.splice(0).forEach((controller) => controller.dispose());
});

test('loads saved defaults without writing and shows the civil week across the year boundary', async () => {
  const { controller, store } = setup(
    encodePlanningPreferences({ weekStart: 'sunday', defaultMealSlot: 'breakfast' }),
  );
  render(tree(controller));
  expect(screen.getByRole('tab', { name: 'Sunday' })).toBeDisabled();
  await act(async () => controller.hydrate());
  expect(screen.getByRole('tab', { name: 'Sunday' })).toBeSelected();
  expect(screen.getByRole('tab', { name: 'Breakfast' })).toBeSelected();
  expect(
    screen.getByText('Example for Friday 1 January 2027: Sun 27 Dec – Saturday 2 January 2027.'),
  ).toBeTruthy();
  expect(screen.getByText(/does not move saved meals or alter Shopping selections/)).toBeTruthy();
  expect(store.write).not.toHaveBeenCalled();
});

test('each deliberate control saves only its device-local preference and keeps the other value', async () => {
  const { controller, store } = setup();
  render(tree(controller));
  await act(async () => controller.hydrate());
  await act(async () => {
    fireEvent.press(screen.getByRole('tab', { name: 'Sunday' }));
  });
  await act(async () => {
    fireEvent.press(screen.getByRole('tab', { name: 'Lunch' }));
  });
  expect(store.write.mock.calls.map(([text]) => JSON.parse(text))).toEqual([
    { schemaVersion: 1, preferences: { weekStart: 'sunday', defaultMealSlot: 'dinner' } },
    { schemaVersion: 1, preferences: { weekStart: 'sunday', defaultMealSlot: 'lunch' } },
  ]);
  expect(screen.getByRole('tab', { name: 'Lunch' })).toBeSelected();
});

test('a failed save keeps confirmed controls and exposes an honest retryable error', async () => {
  const { controller, store } = setup();
  store.write.mockRejectedValueOnce(new Error('unavailable'));
  render(tree(controller));
  await act(async () => controller.hydrate());
  await act(async () => {
    fireEvent.press(screen.getByRole('tab', { name: 'Sunday' }));
  });
  expect(screen.getByRole('tab', { name: 'Monday' })).toBeSelected();
  expect(screen.getByText('Planning defaults need another check')).toBeTruthy();
  expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByRole('tab', { name: 'Sunday' }));
  });
  expect(screen.getByRole('tab', { name: 'Sunday' })).toBeSelected();
});

test('a delayed storage failure keeps controls busy until its visible failure is known', async () => {
  const { controller, store } = setup();
  let rejectWrite!: (reason: Error) => void;
  store.write.mockImplementationOnce(
    () =>
      new Promise<undefined>((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  render(tree(controller));
  await act(async () => controller.hydrate());
  await act(async () => {
    fireEvent.press(screen.getByRole('tab', { name: 'Sunday' }));
  });
  expect(screen.getByRole('tab', { name: 'Breakfast' })).toBeDisabled();
  expect(screen.getByText('Saving planning default…')).toBeTruthy();
  await act(async () => {
    rejectWrite(new Error('late failure'));
    await controller.drain();
  });
  expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Monday' })).toBeSelected();
  expect(screen.queryByText('Saving planning default…')).toBeNull();
});

test('a control retained from another preference owner cannot write after provider replacement', async () => {
  const first = setup(),
    second = setup();
  await act(async () => {
    await first.controller.hydrate();
    await second.controller.hydrate();
  });
  const view = render(tree(first.controller));
  const change = screen.UNSAFE_getAllByType(SegmentControl)[0]!.props.onChange;
  view.rerender(tree(second.controller));
  await act(async () => change('sunday'));
  expect(first.store.write).not.toHaveBeenCalled();
  expect(second.store.write).not.toHaveBeenCalled();
  expect(screen.getByRole('tab', { name: 'Monday' })).toBeSelected();
});

test('an unsupported record remains unchanged with a visible explanation', async () => {
  const { controller, store } = setup(
    '{"schemaVersion":2,"preferences":{"weekStart":"sunday","defaultMealSlot":"lunch"}}',
  );
  render(tree(controller));
  await act(async () => controller.hydrate());
  fireEvent.press(screen.getByRole('tab', { name: 'Breakfast' }));
  await act(async () => controller.drain());
  expect(screen.getByText(/newer CookMate version/)).toBeTruthy();
  expect(store.write).not.toHaveBeenCalled();
});
