import type { ManualShoppingItem, ShoppingGroup } from '@cookmate/domain';
import { shoppingChecklist } from './shoppingChecklist';

const group = (key: string, purchased = false): ShoppingGroup => ({
  groupKey: key,
  displayName: 'Salt',
  quantityLabel: key === 'grams' ? '10 g' : 'Amount not supplied',
  demandFingerprint: `fingerprint-${key}`,
  purchased,
  changed: false,
  revision: 4,
  contributions: [
    {
      contributionId: key,
      occurrenceId: 'dinner',
      recipeId: '52839',
      source: { recipeId: '52839', section: 'ingredient', position: 1 },
      rawName: 'Sea salt',
      rawMeasure: null,
      quantity: { kind: 'unknown' },
    },
  ],
});
const manual = (id: string, name: string, purchased = false): ManualShoppingItem => ({
  kind: 'manual',
  itemId: id,
  name,
  amountText: 'a little',
  unitText: null,
  category: 'other',
  purchased,
  deleted: false,
  revision: 6,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

test('same-label manual and recipe rows retain distinct identity and original quantities', () => {
  const computed = [group('grams'), group('unknown', true)];
  const own = [manual('grams', 'Salt')];
  const before = JSON.stringify({ computed, own });
  const rows = shoppingChecklist(computed, own, 'all', ' sAlT ');
  expect(rows.map((row) => row.key)).toEqual(['recipe:grams', 'recipe:unknown', 'manual:grams']);
  expect(rows[0]).toMatchObject({
    group: { quantityLabel: '10 g', demandFingerprint: 'fingerprint-grams' },
  });
  expect(rows[1]).toMatchObject({ group: { quantityLabel: 'Amount not supplied' } });
  expect(rows[2]).toMatchObject({ item: { amountText: 'a little', unitText: null, revision: 6 } });
  expect(JSON.stringify({ computed, own })).toBe(before);
});

test('filters inspect the complete input and keep stable order without reviving deleted manual items', () => {
  const own = Array.from({ length: 51 }, (_, index) =>
    manual(`item-${index}`, index === 50 ? 'Kitchen towels' : `Own item ${index}`, index === 50),
  );
  own.push({ ...manual('gone', 'Kitchen towels', true), deleted: true });
  expect(shoppingChecklist([], own, 'purchased', 'kitchen towels').map((row) => row.key)).toEqual([
    'manual:item-50',
  ]);
  expect(shoppingChecklist([], own, 'to_buy', 'kitchen')).toEqual([]);
  expect(
    shoppingChecklist([group('a'), group('b')], [], 'all', 'SEA SALT').map((row) => row.key),
  ).toEqual(['recipe:a', 'recipe:b']);
});
