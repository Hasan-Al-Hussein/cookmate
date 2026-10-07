import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { ActionButton } from '../../components/Controls';
import { RecentlyViewedSettings } from './RecentlyViewedSettings';
import { RecentlyViewedProvider } from './RecentlyViewedProvider';
import {
  createRecentlyViewedController,
  encodeRecentlyViewed,
  type RecentlyViewedController,
} from './recentlyViewed';

const ref = { recipeId: '52839', revisionId: 'bundled-one', contentFingerprint: 'a'.repeat(64) };
const controllers: RecentlyViewedController[] = [];
function fixture(enabled = true) {
  let text: string | null = encodeRecentlyViewed({ enabled, entries: [{ ref, openedAt: 1000 }] });
  const store = {
    read: async () => text,
    write: jest.fn(async (value: string) => {
      text = value;
    }),
  };
  const controller = createRecentlyViewedController(store, { now: () => 1000 });
  controllers.push(controller);
  return { controller, store, text: () => text };
}
const tree = (controller: RecentlyViewedController) => (
  <RecentlyViewedProvider controller={controller}>
    <RecentlyViewedSettings />
  </RecentlyViewedProvider>
);
afterEach(() => {
  cleanup();
  controllers.splice(0).forEach((controller) => controller.dispose());
});

test('enable and disable are explicit local choices and disabling preserves exact recent entries', async () => {
  const f = fixture(false),
    view = render(tree(f.controller));
  await act(async () => f.controller.hydrate());
  expect(view.getByRole('tab', { name: 'Off' })).toBeSelected();
  expect(view.getByText(/not sent to the Assistant, account sync or analytics/)).toBeTruthy();
  await act(async () => fireEvent.press(view.getByRole('tab', { name: 'On' })));
  expect(view.getByRole('tab', { name: 'On' })).toBeSelected();
  await act(async () => fireEvent.press(view.getByRole('tab', { name: 'Off' })));
  expect(f.controller.getSnapshot().entries).toEqual([{ ref, openedAt: 1000 }]);
  expect(f.controller.getSnapshot().enabled).toBe(false);
});

test('clear has independent confirmation, keeps the collection setting, and stores no recipe text', async () => {
  const f = fixture(),
    view = render(tree(f.controller));
  await act(async () => f.controller.hydrate());
  fireEvent.press(view.getByRole('button', { name: 'Clear recently viewed' }));
  expect(
    view.getByText(
      /favourites, plans, notes, cooking history and saved cooking progress will stay unchanged/,
    ),
  ).toBeTruthy();
  expect(f.store.write).not.toHaveBeenCalled();
  fireEvent.press(view.getByRole('button', { name: 'Keep recent history' }));
  expect(f.controller.getSnapshot().entries).toHaveLength(1);
  fireEvent.press(view.getByRole('button', { name: 'Clear recently viewed' }));
  await act(async () =>
    fireEvent.press(view.getByRole('button', { name: 'Clear recent history' })),
  );
  expect(f.controller.getSnapshot().entries).toEqual([]);
  expect(f.controller.getSnapshot().enabled).toBe(true);
  expect(JSON.parse(f.text()!)).toEqual({ schemaVersion: 1, enabled: true, entries: [] });
});

test('a retained clear confirmation cannot target a replacement owner', async () => {
  const first = fixture(),
    second = fixture();
  await first.controller.hydrate();
  await second.controller.hydrate();
  const view = render(tree(first.controller));
  fireEvent.press(view.getByRole('button', { name: 'Clear recently viewed' }));
  const clear = view
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Clear recent history')!.props.onPress;
  view.rerender(tree(second.controller));
  await act(async () => clear());
  expect(first.store.write).not.toHaveBeenCalled();
  expect(second.store.write).not.toHaveBeenCalled();
  expect(view.queryByText('Clear only recently viewed?')).toBeNull();
});

test('a rejected clear acknowledgement is not described as successful deletion', async () => {
  const f = fixture(),
    view = render(tree(f.controller));
  await act(async () => f.controller.hydrate());
  f.store.write.mockRejectedValueOnce(new Error('unknown result'));
  fireEvent.press(view.getByRole('button', { name: 'Clear recently viewed' }));
  await act(async () =>
    fireEvent.press(view.getByRole('button', { name: 'Clear recent history' })),
  );
  expect(view.getByText('Recent history needs another check')).toBeTruthy();
  expect(view.getByText('Clear only recently viewed?')).toBeTruthy();
  expect(view.queryByText(/History cleared/)).toBeNull();
});
