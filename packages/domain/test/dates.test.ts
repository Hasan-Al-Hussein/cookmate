import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPlanWeek,
  getPlanWeekdayOffset,
  isSupportedPlanDate,
  relativeDateContextChanged,
  shiftPlanDate,
} from '../src/dates';

test('Monday weeks retain exact calendar dates across month, year and leap-day boundaries', () => {
  assert.deepEqual(getPlanWeek('2024-02-29').days, [
    '2024-02-26',
    '2024-02-27',
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
    '2024-03-02',
    '2024-03-03',
  ]);
  assert.equal(getPlanWeek('2023-01-01').startDate, '2022-12-26');
  assert.equal(getPlanWeek('2023-01-02').startDate, '2023-01-02');
  assert.equal(shiftPlanDate('2000-02-28', 1), '2000-02-29');
  assert.equal(shiftPlanDate('1900-02-28', 1), '1900-03-01');
  assert.equal(shiftPlanDate('2100-02-28', 1), '2100-03-01');
  assert.equal(shiftPlanDate('2026-01-01', -1), '2025-12-31');
});

test('supported boundaries disable navigation and retain the final partial week', () => {
  const first = getPlanWeek('1900-01-01');
  assert.equal(first.previousWeek, null);
  assert.equal(first.days.length, 7);
  const last = getPlanWeek('2100-12-31');
  assert.equal(last.startDate, '2100-12-27');
  assert.equal(last.endDate, '2100-12-31');
  assert.equal(last.days.length, 5);
  assert.equal(last.nextWeek, null);
  assert.equal(last.previousWeek, '2100-12-20');
  assert.equal(shiftPlanDate('2100-12-31', 1), null);
  assert.equal(shiftPlanDate('1900-01-01', -1), null);
  for (const value of ['1899-12-31', '2101-01-01', '1900-02-29', '2100-02-29', '2026-2-01']) {
    assert.equal(isSupportedPlanDate(value), false);
    assert.throws(() => getPlanWeek(value), RangeError);
  }
  assert.throws(() => shiftPlanDate('2026-09-28', 0.5), RangeError);
});

test('Sunday weeks preserve civil dates across month, year and leap-day boundaries', () => {
  assert.deepEqual(getPlanWeek('2024-02-29', 'sunday').days, [
    '2024-02-25',
    '2024-02-26',
    '2024-02-27',
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
    '2024-03-02',
  ]);
  assert.equal(getPlanWeek('2023-01-01', 'sunday').startDate, '2023-01-01');
  assert.equal(getPlanWeek('2022-12-31', 'sunday').startDate, '2022-12-25');
  assert.equal(getPlanWeek('2022-12-31', 'sunday').endDate, '2022-12-31');
  assert.equal(getPlanWeek('2026-01-01', 'sunday').startDate, '2025-12-28');
  assert.equal(getPlanWeek('2026-01-01', 'sunday').endDate, '2026-01-03');
  assert.deepEqual(getPlanWeek('2026-01-01'), getPlanWeek('2026-01-01', 'monday'));
});

test('the first partial Sunday week is reachable in both directions without out-of-range dates', () => {
  const first = getPlanWeek('1900-01-01', 'sunday');
  assert.deepEqual(first.days, [
    '1900-01-01',
    '1900-01-02',
    '1900-01-03',
    '1900-01-04',
    '1900-01-05',
    '1900-01-06',
  ]);
  assert.equal(first.previousWeek, null);
  assert.equal(first.nextWeek, '1900-01-07');
  const second = getPlanWeek(first.nextWeek!, 'sunday');
  assert.equal(second.previousWeek, first.startDate);
  assert.deepEqual(getPlanWeek(second.previousWeek!, 'sunday'), first);
  // Weekday alignment includes the preceding unsupported Sunday, unlike the clipped date list.
  assert.equal(getPlanWeekdayOffset('1900-01-01', 'sunday'), 1);
  assert.equal(getPlanWeekdayOffset('1900-01-01'), 0);
  assert.equal(getPlanWeekdayOffset('1900-01-07', 'sunday'), 0);
  assert.equal(getPlanWeekdayOffset('1900-01-07'), 6);
});

test('the final partial Sunday week has bounded navigation and stable weekday positions', () => {
  const final = getPlanWeek('2100-12-31', 'sunday');
  assert.equal(final.startDate, '2100-12-26');
  assert.equal(final.endDate, '2100-12-31');
  assert.equal(final.days.length, 6);
  assert.equal(final.nextWeek, null);
  assert.equal(final.previousWeek, '2100-12-19');
  assert.equal(getPlanWeek(final.previousWeek!, 'sunday').nextWeek, final.startDate);
  assert.equal(getPlanWeekdayOffset('2100-12-31', 'sunday'), 5);
  assert.equal(getPlanWeekdayOffset('2100-12-31', 'monday'), 4);
  assert.equal(Object.isFrozen(final), true);
  assert.equal(Object.isFrozen(final.days), true);
  assert.throws(() => getPlanWeek('1900-01-01', 'friday' as 'monday'), RangeError);
  assert.throws(() => getPlanWeekdayOffset('1899-12-31', 'sunday'), RangeError);
});

test('changing week presentation never changes the selected date or its actual weekday', () => {
  for (const date of [
    '1900-01-01',
    '2000-02-29',
    '2024-02-29',
    '2025-12-31',
    '2026-01-01',
    '2100-12-31',
  ]) {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const sundayOffset = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    assert.equal(getPlanWeekdayOffset(date, 'sunday'), sundayOffset);
    assert.equal(getPlanWeekdayOffset(date, 'monday'), (sundayOffset + 6) % 7);
    for (const start of ['monday', 'sunday'] as const) {
      const week = getPlanWeek(date, start);
      assert.equal(week.days.includes(date), true);
      assert.equal(week.startDate <= date && week.endDate >= date, true);
    }
  }
});

test('pending relative dates notice day/timezone changes without changing a resolved calendar date', () => {
  const interpretedAt = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  const guard = { interpretedAt, resolvedDate: '2026-09-29', sourceMessageId: 'source' };
  assert.equal(relativeDateContextChanged(guard, { ...interpretedAt }), false);
  assert.equal(
    relativeDateContextChanged(guard, { ...interpretedAt, localDate: '2026-09-29' }),
    true,
  );
  assert.equal(
    relativeDateContextChanged(guard, {
      ...interpretedAt,
      timeZone: 'Asia/Kolkata',
      utcOffsetMinutes: 330,
    }),
    true,
  );
  assert.equal(
    relativeDateContextChanged(guard, { ...interpretedAt, utcOffsetMinutes: 180 }),
    true,
  );
  assert.equal(guard.resolvedDate, '2026-09-29');
});

test('calendar arithmetic round-trips every supported date against independent Gregorian UTC arithmetic', () => {
  // Date is used only as an independent test oracle; production helpers never create instants.
  const end = Date.UTC(2100, 11, 31);
  for (let instant = Date.UTC(1900, 0, 1); instant <= end; instant += 86_400_000) {
    const value = new Date(instant).toISOString().slice(0, 10);
    assert.equal(shiftPlanDate(value, 0), value);
    if (instant < end)
      assert.equal(
        shiftPlanDate(value, 1),
        new Date(instant + 86_400_000).toISOString().slice(0, 10),
      );
  }
});
