import { act, renderHook } from '@testing-library/react-native';
import type { ManualShoppingItem, ShoppingGroup } from '@cookmate/domain';
import { useStableShoppingChecklist } from './useStableShoppingChecklist';

const group = (key: string, purchased = false): ShoppingGroup => ({
  groupKey: key,
  displayName: 'Salt',
  quantityLabel: key === 'a' ? '10 g' : 'Amount not supplied',
  contributions: [],
  demandFingerprint: `demand-${key}`,
  purchased,
  changed: true,
  revision: 4,
});
const manual = (id: string, purchased = false): ManualShoppingItem => ({
  kind: 'manual',
  itemId: id,
  name: 'Salt',
  amountText: 'a little',
  unitText: null,
  category: 'other',
  purchased,
  deleted: false,
  revision: 6,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});
type Input = Parameters<typeof useStableShoppingChecklist>[0];
function setup(overrides: Partial<Input> = {}) {
  const input: Input = {
    groups: [group('a'), group('b')],
    manual: [manual('a')],
    owner: {},
    manualEpoch: 2,
    filter: 'to_buy',
    search: '',
    ...overrides,
  };
  const view = renderHook((props: Input) => useStableShoppingChecklist(props), {
    initialProps: input,
  });
  return { ...view, input };
}

test.each(['to_buy', 'purchased'] as const)(
  '%s retains only touched identities and reads current values in their original order',
  (filter) => {
    const purchased = filter === 'purchased';
    const view = setup({
      filter,
      groups: [group('a', purchased), group('b', purchased)],
      manual: [manual('a', purchased)],
    });
    const before = view.result.current.rows.map((row) => row.key);
    act(() => {
      view.result.current.retain(view.result.current.rows[0]!);
      view.result.current.retain(view.result.current.rows[2]!);
    });
    expect(view.result.current.retainedCount).toBe(0);
    const changed = {
      ...view.input,
      groups: [{ ...group('a', !purchased), revision: 5 }, group('b', purchased)],
      manual: [{ ...manual('a', !purchased), revision: 7 }],
    };
    view.rerender(changed);
    expect(view.result.current.rows.map((row) => row.key)).toEqual(before);
    expect(view.result.current.rows[0]).toMatchObject({
      group: { purchased: !purchased, revision: 5, quantityLabel: '10 g' },
    });
    expect(view.result.current.rows[2]).toMatchObject({
      item: { purchased: !purchased, revision: 7, amountText: 'a little' },
    });
    expect(view.result.current.retainedCount).toBe(2);
    view.rerender({
      ...changed,
      groups: [group('a', purchased), group('b', purchased)],
      manual: [manual('a', purchased)],
    });
    expect(view.result.current.rows.map((row) => row.key)).toEqual(before);
    expect(view.result.current.retainedCount).toBe(0);
  },
);

test('explicit refilter and search edits discard exceptions without changing saved purchase values', () => {
  const view = setup();
  act(() => view.result.current.retain(view.result.current.rows[0]!));
  const changed = { ...view.input, groups: [group('a', true), group('b')] };
  view.rerender(changed);
  expect(view.result.current.retainedCount).toBe(1);
  act(() => view.result.current.reset());
  expect(view.result.current.rows.map((row) => row.key)).toEqual(['recipe:b', 'manual:a']);
  view.rerender({ ...changed, filter: 'purchased' });
  act(() => view.result.current.retain(view.result.current.rows[0]!));
  view.rerender({ ...changed, filter: 'purchased', groups: [group('a'), group('b')] });
  expect(view.result.current.retainedCount).toBe(1);
  view.rerender({
    ...changed,
    filter: 'purchased',
    groups: [group('a'), group('b')],
    search: 'salt',
  });
  expect(view.result.current.rows).toEqual([]);
  view.rerender({ ...changed, filter: 'purchased', groups: [group('a'), group('b')] });
  expect(view.result.current.rows).toEqual([]);
  expect(changed.groups[0]!.purchased).toBe(true);
});

test('demand changes, vanished rows and deleted manual identities cannot revive a retained exception', () => {
  const view = setup();
  act(() => {
    view.result.current.retain(view.result.current.rows[0]!);
    view.result.current.retain(view.result.current.rows[2]!);
  });
  view.rerender({
    ...view.input,
    groups: [{ ...group('a', true), demandFingerprint: 'new demand' }],
    manual: [{ ...manual('a', true), deleted: true }],
  });
  expect(view.result.current.rows).toEqual([]);
  view.rerender({ ...view.input, groups: [group('a', true)], manual: [manual('a', true)] });
  expect(view.result.current.rows).toEqual([]);
  const missing = setup();
  act(() => missing.result.current.retain(missing.result.current.rows[0]!));
  missing.rerender({ ...missing.input, groups: [] });
  missing.rerender({ ...missing.input, groups: [group('a', true)] });
  expect(missing.result.current.rows.map((row) => row.key)).toEqual(['manual:a']);
});

test('manual epoch changes clear only manual exceptions; owner changes clear every exception', () => {
  const view = setup();
  act(() => {
    view.result.current.retain(view.result.current.rows[0]!);
    view.result.current.retain(view.result.current.rows[2]!);
  });
  const changed = {
    ...view.input,
    groups: [group('a', true)],
    manual: [manual('a', true)],
    manualEpoch: 3,
  };
  view.rerender(changed);
  expect(view.result.current.rows.map((row) => row.key)).toEqual(['recipe:a']);
  view.rerender({ ...changed, owner: {} });
  expect(view.result.current.rows).toEqual([]);
});

test('a rejected or pending purchase never gets an optimistic check mark', () => {
  const view = setup();
  act(() => view.result.current.retain(view.result.current.rows[0]!));
  view.rerender({ ...view.input });
  expect(view.result.current.rows[0]).toMatchObject({ group: { purchased: false, revision: 4 } });
  expect(view.result.current.retainedCount).toBe(0);
});
