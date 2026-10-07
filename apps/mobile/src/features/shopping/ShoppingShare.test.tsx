import type { ContentWorkspaceState } from '../content/contentWorkspaceHost';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { ActionButton } from '../../components/Controls';
import { Platform } from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import {
  ShoppingShare,
  type ShoppingSharePersonal,
  type ContentShoppingShareContext,
} from './ShoppingShare';
import type { PersonalChange, ManualShoppingPage, RepositoryResult } from '@cookmate/domain';
import { shoppingShareFixture, contentShoppingShareFixture } from './shoppingShare.test-support';
import type { ShoppingShareTransfer } from './shoppingShareText';

jest.mock('./shoppingShareTransfer', () => ({ createShoppingShareTransfer: jest.fn() }));

let transfer: jest.Mocked<ShoppingShareTransfer>;
beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  transfer = {
    share: jest
      .fn<ReturnType<ShoppingShareTransfer['share']>, [string]>()
      .mockResolvedValue('sheet_closed'),
    dispose: jest.fn(),
  };
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('sharing requires a preview and a separate deliberate share-sheet tap', async () => {
  const factory = jest.fn(() => transfer);
  render(<ShoppingShare snapshot={shoppingShareFixture()} createTransfer={factory} />);
  expect(factory).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  expect(screen.getByText('Review your shopping list')).toBeTruthy();
  expect(screen.getByText(/\[ \] Pasta — 475 g/)).toBeTruthy();
  expect(screen.getByText(/Thursday 8 October 2026/)).toBeTruthy();
  expect(factory).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
  expect(await screen.findByText(/CookMate cannot confirm delivery/)).toBeTruthy();
  expect(transfer.share).toHaveBeenCalledTimes(1);
  expect(transfer.share.mock.calls[0]![0]).toContain('8 October 2026');
  expect(transfer.share.mock.calls[0]![0]).toContain(
    `TheMealDB — ${getRecipe('52839')!.recipePage}`,
  );
  expect(transfer.share.mock.calls[0]![0]).toContain(getRecipe('52839')!.originalSourceUrl!);
});

test('changed quantities or purchase marks require the user to refresh the reviewed text', () => {
  const initial = shoppingShareFixture();
  const view = render(<ShoppingShare snapshot={initial} createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  const updated = {
    ...initial,
    groups: initial.groups.map((group) => ({ ...group, purchased: true })),
  };
  view.rerender(<ShoppingShare snapshot={updated} createTransfer={() => transfer} />);
  expect(screen.getByText('Your list has changed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open share sheet' })).toBeNull();
  expect(transfer.share).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Refresh preview' }));
  expect(screen.getByText(/To buy 0 · Purchased 3/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open share sheet' })).toBeTruthy();
});

test('cancellation is honest and leaves the same preview available', async () => {
  transfer.share.mockResolvedValue('cancelled');
  render(<ShoppingShare snapshot={shoppingShareFixture()} createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
  expect(
    await screen.findByText('Sharing cancelled. Your shopping list is unchanged.'),
  ).toBeTruthy();
  expect(screen.getByText('Review your shopping list')).toBeTruthy();
});

test('an export failure reports uncertainty without a success message', async () => {
  transfer.share.mockRejectedValue(new Error('Synthetic transport failure'));
  render(<ShoppingShare snapshot={shoppingShareFixture()} createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
  expect(await screen.findByText(/could not confirm the sharing outcome/)).toBeTruthy();
  expect(screen.queryByText(/share sheet has closed/)).toBeNull();
});

test('browser preview offers only an explicit text-file download and does not claim it was saved', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  transfer.share.mockResolvedValue('download_requested');
  render(<ShoppingShare snapshot={shoppingShareFixture()} createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  expect(screen.queryByRole('button', { name: 'Open share sheet' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Download text file' }));
  expect(await screen.findByText(/Check your browser’s downloads to confirm/)).toBeTruthy();
});

test('leaving disposes file resources and ignores a late share result', async () => {
  let finish!: (value: Awaited<ReturnType<ShoppingShareTransfer['share']>>) => void;
  transfer.share.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(
    <ShoppingShare snapshot={shoppingShareFixture()} createTransfer={() => transfer} />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
  view.unmount();
  expect(transfer.dispose).toHaveBeenCalledTimes(1);
  await act(async () => finish('sheet_closed'));
});

function manualFixture() {
  let notify: (change: PersonalChange) => void = () => {};
  const data: RepositoryResult<ManualShoppingPage> = {
    kind: 'ready',
    revision: 1,
    value: {
      epoch: 1,
      total: 1,
      nextCursor: null,
      items: [
        {
          kind: 'manual',
          itemId: 'only-manual',
          name: 'Kitchen towels',
          amountText: '2',
          unitText: 'packs',
          category: 'other',
          purchased: false,
          deleted: false,
          revision: 1,
          createdAt: '2026-09-30T10:00:00.000Z',
          updatedAt: '2026-09-30T10:00:00.000Z',
        },
      ],
    },
  };
  const service: jest.Mocked<ShoppingSharePersonal> = {
    readManualShopping: jest
      .fn<
        ReturnType<ShoppingSharePersonal['readManualShopping']>,
        Parameters<ShoppingSharePersonal['readManualShopping']>
      >()
      .mockResolvedValue(data),
    subscribe: jest.fn((listener) => {
      notify = listener;
      return () => {};
    }),
  };
  return {
    service,
    data,
    change: () => notify({ revision: 2, manualShopping: true, notes: false, collections: false }),
  };
}
test('manual rows appear in the reviewed bytes and a later change requires a fresh preview', async () => {
  const manual = manualFixture();
  render(
    <ShoppingShare
      snapshot={shoppingShareFixture()}
      personal={manual.service}
      createTransfer={() => transfer}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  const text = await screen.findByText(/\[ \] Kitchen towels — 2 packs/);
  expect(text).toBeTruthy();
  act(() => manual.change());
  expect(screen.getByText('Your list has changed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open share sheet' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Refresh preview' }));
  await screen.findByRole('button', { name: 'Open share sheet' });
  fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
  await screen.findByText(/CookMate cannot confirm delivery/);
  expect(transfer.share.mock.calls[0]![0]).toContain('[ ] Kitchen towels — 2 packs');
});
test.each(['changed', 'replaced', 'unmounted'])(
  'late manual read is discarded when %s',
  async (reason) => {
    const manual = manualFixture();
    let finish!: (result: RepositoryResult<ManualShoppingPage>) => void;
    manual.service.readManualShopping.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const snapshot = shoppingShareFixture();
    const view = render(
      <ShoppingShare
        snapshot={snapshot}
        personal={manual.service}
        createTransfer={() => transfer}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
    if (reason === 'unmounted') view.unmount();
    else if (reason === 'changed') act(() => manual.change());
    else
      view.rerender(
        <ShoppingShare
          snapshot={snapshot}
          personal={manualFixture().service}
          createTransfer={() => transfer}
        />,
      );
    await act(async () => finish(manual.data));
    if (reason !== 'unmounted') {
      expect(screen.getByText('Sharing needs attention')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Open share sheet' })).toBeNull();
    }
    expect(transfer.share).not.toHaveBeenCalled();
  },
);

const mockPort = <F extends (...args: never[]) => unknown>() =>
  jest.fn<ReturnType<F>, Parameters<F>>();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
/** Controlled ports only. Real signed/SQL/transfer acceptance belongs to the integration lane. */
function contentFixture() {
  const value = contentShoppingShareFixture();
  let state: ContentWorkspaceState = {
    status: 'ready',
    scopeKey: 'content:one',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>();
  const manualBase = manualFixture();
  const manual = {
    ...manualBase.service,
    readState: mockPort<ContentShoppingShareContext['host']['manual']['readState']>(),
  };
  const page = { ...manualBase.data, revision: 4 };
  manual.readManualShopping.mockResolvedValue(page);
  manual.readState.mockResolvedValue({
    kind: 'ready',
    revision: 4,
    value: { revision: 2, epoch: 1 },
  });
  const queries = {
    readShopping: mockPort<ContentShoppingShareContext['host']['queries']['readShopping']>(),
  };
  queries.readShopping.mockResolvedValue({ kind: 'ready', revision: 4, value });
  const host = {
    manual,
    queries,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const context: ContentShoppingShareContext = {
    host,
    scopeKey: state.scopeKey,
    revision: 4,
    value,
  };
  const props = {
    snapshot: value.snapshot,
    personal: manual,
    content: context,
    createTransfer: () => transfer,
  };
  return {
    value,
    page,
    host,
    manual,
    queries,
    context,
    props,
    retire: () => {
      state = { ...state, status: 'revoked', scopeKey: 'content:two' };
      listeners.forEach((listener) => listener());
    },
    change: manualBase.change,
  };
}
async function previewContent(f: ReturnType<typeof contentFixture>) {
  const view = render(<ShoppingShare {...f.props} />);
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  await screen.findByRole('button', { name: 'Open share sheet' });
  return view;
}

test('configured sharing reviews exact versions plus every manual page and validates global clocks before dispatch', async () => {
  const f = contentFixture();
  if (f.page.kind !== 'ready') throw new Error('fixture');
  const one = f.page.value.items[0]!;
  f.manual.readManualShopping
    .mockReset()
    .mockResolvedValueOnce({ ...f.page, value: { ...f.page.value, total: 2, nextCursor: 'next' } })
    .mockResolvedValueOnce({
      ...f.page,
      value: {
        ...f.page.value,
        total: 2,
        items: [{ ...one, itemId: 'second-manual', name: 'Second page item', purchased: true }],
        nextCursor: null,
      },
    });
  await previewContent(f);
  expect(f.manual.readManualShopping).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Second page item/)).toBeTruthy();
  expect(screen.getByText(/Revised pasta \(selected version 2\)/)).toBeTruthy();
  expect(transfer.share).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
  await screen.findByText(/CookMate cannot confirm delivery/);
  expect(f.queries.readShopping).toHaveBeenCalledTimes(2);
  expect(f.manual.readState).toHaveBeenCalledTimes(2);
  expect(transfer.share).toHaveBeenCalledTimes(1);
  expect(transfer.share.mock.calls[0]![0]).toContain('[x] Second page item');
});

test.each([
  'shopping_clock',
  'second_global_clock',
  'manual_epoch',
  'changed_text',
  'changed_ref',
] as const)(
  'configured dispatch requires fresh review after %s changes without notification',
  async (change) => {
    const f = contentFixture();
    await previewContent(f);
    if (change === 'shopping_clock')
      f.queries.readShopping.mockResolvedValue({ kind: 'ready', revision: 5, value: f.value });
    if (change === 'second_global_clock')
      f.manual.readState.mockResolvedValue({
        kind: 'ready',
        revision: 5,
        value: { revision: 2, epoch: 1 },
      });
    if (change === 'manual_epoch')
      f.manual.readState.mockResolvedValue({
        kind: 'ready',
        revision: 4,
        value: { revision: 2, epoch: 2 },
      });
    if (change === 'changed_text')
      f.queries.readShopping.mockResolvedValue({
        kind: 'ready',
        revision: 4,
        value: {
          ...f.value,
          snapshot: {
            ...f.value.snapshot,
            groups: f.value.snapshot.groups.map((group) => ({ ...group, purchased: true })),
          },
        },
      });
    if (change === 'changed_ref') {
      const changed = contentShoppingShareFixture();
      if (changed.share.kind !== 'ready') throw new Error('fixture');
      const replacement = {
        ...changed.selected[1]!.contentRef,
        contentFingerprint: 'c'.repeat(64),
      };
      changed.selected = changed.selected.map((row, index) =>
        index === 1 ? { ...row, contentRef: replacement } : row,
      );
      changed.share = {
        ...changed.share,
        recipes: changed.share.recipes.map((row, index) =>
          index === 1 ? { ...row, contentRef: replacement } : row,
        ),
      };
      f.queries.readShopping.mockResolvedValue({ kind: 'ready', revision: 4, value: changed });
    }
    fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
    await screen.findByText(/Refresh and review the complete preview/);
    expect(screen.getByRole('button', { name: 'Refresh preview' })).toBeTruthy();
    expect(transfer.share).not.toHaveBeenCalled();
  },
);

test('a complete manual page from another global revision cannot become a configured preview', async () => {
  const f = contentFixture();
  f.manual.readManualShopping.mockResolvedValue({ ...f.page, revision: 5 });
  render(<ShoppingShare {...f.props} />);
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  await screen.findByText(/complete shopping list is not ready/);
  expect(f.queries.readShopping).not.toHaveBeenCalled();
  expect(transfer.share).not.toHaveBeenCalled();
});

test.each(['manual', 'shopping', 'state'] as const)(
  'owner retirement during %s preparation hides all private preview and stops following reads',
  async (phase) => {
    const f = contentFixture();
    const gate = deferred<void>();
    if (phase === 'manual')
      f.manual.readManualShopping.mockImplementationOnce(async () => {
        await gate.promise;
        return f.page;
      });
    if (phase === 'shopping')
      f.queries.readShopping.mockImplementationOnce(async () => {
        await gate.promise;
        return { kind: 'ready', revision: 4, value: f.value };
      });
    if (phase === 'state')
      f.manual.readState.mockImplementationOnce(async () => {
        await gate.promise;
        return { kind: 'ready', revision: 4, value: { revision: 2, epoch: 1 } };
      });
    render(<ShoppingShare {...f.props} />);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Share list' })));
    act(() => f.retire());
    await act(async () => gate.resolve());
    expect(screen.queryByText(/Kitchen towels/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open share sheet' })).toBeNull();
    if (phase === 'manual') expect(f.queries.readShopping).not.toHaveBeenCalled();
    if (phase !== 'state') expect(f.manual.readState).not.toHaveBeenCalled();
    expect(transfer.share).not.toHaveBeenCalled();
  },
);

test('retirement after the final asynchronous clock read suppresses an already retained dispatch callback', async () => {
  const f = contentFixture();
  await previewContent(f);
  const gate = deferred<Awaited<ReturnType<typeof f.manual.readState>>>();
  f.manual.readState.mockImplementationOnce(() => gate.promise);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' })));
  act(() => f.retire());
  await act(async () =>
    gate.resolve({ kind: 'ready', revision: 4, value: { revision: 2, epoch: 1 } }),
  );
  expect(transfer.share).not.toHaveBeenCalled();
  expect(screen.queryByText(/Kitchen towels/)).toBeNull();
});

test('source replacement invalidates a retained share callback without exporting old private text', async () => {
  const f = contentFixture();
  const view = await previewContent(f);
  const old: () => void = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Open share sheet')!.props.onPress;
  const next = contentFixture();
  next.context.scopeKey = 'different-scope';
  view.rerender(<ShoppingShare {...next.props} />);
  await act(async () => old());
  expect(transfer.share).not.toHaveBeenCalled();
  expect(screen.queryByText(/Kitchen towels/)).toBeNull();
});

test('complete sharing budget failure is explicit and does not enable a partial preview', () => {
  const f = contentFixture();
  f.value.share = { kind: 'unavailable', reason: 'too_large' };
  render(<ShoppingShare {...f.props} />);
  expect(screen.getByRole('button', { name: 'Share list' })).toBeDisabled();
  expect(screen.getByText('Complete sharing is unavailable')).toBeTruthy();
  expect(f.manual.readManualShopping).not.toHaveBeenCalled();
});

test.each(['resolved', 'rejected'])(
  'changed snapshot during %s dispatched transfer keeps the outcome uncertain and never claims no offer',
  async (outcome) => {
    const pending = deferred<Awaited<ReturnType<ShoppingShareTransfer['share']>>>();
    transfer.share.mockReturnValueOnce(pending.promise);
    const initial = shoppingShareFixture();
    const factory = () => transfer;
    const view = render(<ShoppingShare snapshot={initial} createTransfer={factory} />);
    fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
    fireEvent.press(screen.getByRole('button', { name: 'Open share sheet' }));
    expect(transfer.share).toHaveBeenCalledTimes(1);
    view.rerender(
      <ShoppingShare
        snapshot={{
          ...initial,
          groups: initial.groups.map((group) => ({ ...group, purchased: true })),
        }}
        createTransfer={factory}
      />,
    );
    await act(async () => {
      if (outcome === 'resolved') pending.resolve('sheet_closed');
      else pending.reject(new Error('Unconfirmed transfer'));
    });
    expect(screen.getByText(/could not confirm the sharing outcome/)).toBeTruthy();
    expect(screen.queryByText(/could not be offered/)).toBeNull();
    expect(screen.queryByText(/Nothing was sent/)).toBeNull();
    expect(screen.queryByText(/share sheet has closed/)).toBeNull();
    expect(transfer.share).toHaveBeenCalledTimes(1);
  },
);
