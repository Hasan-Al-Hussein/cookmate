import type {
  Immutable,
  ManualShoppingItem,
  ManualShoppingPage,
  PersonalService,
  RepositoryResult,
} from '@cookmate/domain';
import { readManualPrefix } from './readManualPrefix';
const item = (id: string): Immutable<ManualShoppingItem> => ({
  kind: 'manual',
  itemId: id,
  name: `Item ${id}`,
  amountText: null,
  unitText: null,
  category: 'other',
  purchased: false,
  deleted: false,
  revision: 1,
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
});
const page = (
  ids: string[],
  nextCursor: string | null,
): RepositoryResult<Immutable<ManualShoppingPage>> => ({
  kind: 'ready',
  revision: 1,
  value: { epoch: 1, items: ids.map(item), nextCursor, total: 60 },
});
function fixture() {
  const readManualShopping = jest.fn<
    ReturnType<PersonalService['readManualShopping']>,
    Parameters<PersonalService['readManualShopping']>
  >();
  return { readManualShopping };
}
test('refresh keeps every already revealed item in stable order across fresh guarded pages', async () => {
  const service = fixture();
  service.readManualShopping
    .mockResolvedValueOnce(
      page(
        Array.from({ length: 50 }, (_, index) => String(index)),
        'cursor50',
      ),
    )
    .mockResolvedValueOnce(
      page(
        Array.from({ length: 10 }, (_, index) => String(index + 50)),
        null,
      ),
    );
  const result = await readManualPrefix(service, 60);
  expect(service.readManualShopping.mock.calls).toEqual([
    [{ limit: 50 }],
    [{ limit: 10, cursor: 'cursor50' }],
  ]);
  expect(result.kind === 'ready' ? result.value.items.map((row) => row.itemId) : []).toEqual(
    Array.from({ length: 60 }, (_, index) => String(index)),
  );
});
test('a stale second page returns failure instead of a mixed partial list', async () => {
  const service = fixture();
  const failure = {
    kind: 'failed' as const,
    error: {
      code: 'stale_context' as const,
      messageKey: 'personal.cursor_stale',
      retry: 'after_correction' as const,
    },
  };
  service.readManualShopping
    .mockResolvedValueOnce(page(['first'], 'next'))
    .mockResolvedValueOnce(failure);
  expect(await readManualPrefix(service, 40)).toEqual(failure);
});
test('repeated cursor pages stop within a bounded read without duplicate rows', async () => {
  const service = fixture();
  service.readManualShopping.mockResolvedValue(page(['same'], 'again'));
  expect((await readManualPrefix(service, 60)).kind).toBe('failed');
  expect(service.readManualShopping).toHaveBeenCalledTimes(2);
});
