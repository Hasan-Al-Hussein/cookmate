import { isActualLocalDate, isRelativeDateContextCurrent } from '@cookmate/contracts';
import type { DateContext, LocalDate, RelativeDateGuard } from '@cookmate/contracts';

export const PLAN_MIN_DATE = '1900-01-01';
export const PLAN_MAX_DATE = '2100-12-31';

export function isSupportedPlanDate(value: string): boolean {
  return isActualLocalDate(value) && value >= PLAN_MIN_DATE && value <= PLAN_MAX_DATE;
}

function monthLengths(year: number): readonly number[] {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
}

function daysBeforeYear(year: number): number {
  const previous = year - 1;
  return (
    365 * previous +
    Math.floor(previous / 4) -
    Math.floor(previous / 100) +
    Math.floor(previous / 400)
  );
}

/** Gregorian day ordinal, with 0001-01-01 (Monday) at zero. No timestamp or time zone conversion. */
function ordinal(value: LocalDate): number {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return (
    daysBeforeYear(year) +
    monthLengths(year)
      .slice(0, month - 1)
      .reduce((sum, days) => sum + days, 0) +
    Number(value.slice(8, 10)) -
    1
  );
}

function fromOrdinal(value: number): LocalDate {
  let low = 1900;
  let high = 2101;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (daysBeforeYear(middle) <= value) low = middle;
    else high = middle;
  }
  let remaining = value - daysBeforeYear(low);
  let month = 1;
  for (const length of monthLengths(low)) {
    if (remaining < length) break;
    remaining -= length;
    month++;
  }
  return `${low}-${String(month).padStart(2, '0')}-${String(remaining + 1).padStart(2, '0')}`;
}

const minimum = ordinal(PLAN_MIN_DATE);
const maximum = ordinal(PLAN_MAX_DATE);

/** Null is a deliberate navigation boundary, never a silently clamped different date. */
export function shiftPlanDate(value: LocalDate, days: number): LocalDate | null {
  if (!isSupportedPlanDate(value) || !Number.isSafeInteger(days))
    throw new RangeError('Invalid plan date or day offset');
  const target = ordinal(value) + days;
  return target < minimum || target > maximum ? null : fromOrdinal(target);
}

export interface PlanWeek {
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly days: readonly LocalDate[];
  readonly previousWeek: LocalDate | null;
  readonly nextWeek: LocalDate | null;
}

export type PlanWeekStart = 'monday' | 'sunday';

/** Full weekday position, including days outside the supported navigation range. */
export function getPlanWeekdayOffset(
  value: LocalDate,
  weekStart: PlanWeekStart = 'monday',
): number {
  if (!isSupportedPlanDate(value)) throw new RangeError('Unsupported plan date');
  if (weekStart !== 'monday' && weekStart !== 'sunday')
    throw new RangeError('Unsupported week start');
  return (ordinal(value) + (weekStart === 'sunday' ? 1 : 0)) % 7;
}

export function getPlanWeek(value: LocalDate, weekStart: PlanWeekStart = 'monday'): PlanWeek {
  const offset = getPlanWeekdayOffset(value, weekStart);
  const day = ordinal(value);
  const start = day - offset;
  const first = Math.max(minimum, start);
  const last = Math.min(maximum, start + 6);
  return Object.freeze({
    startDate: fromOrdinal(first),
    endDate: fromOrdinal(last),
    days: Object.freeze(
      Array.from({ length: last - first + 1 }, (_, index) => fromOrdinal(first + index)),
    ),
    // The first Sunday week starts outside the range, but its supported partial week is reachable.
    previousWeek: start <= minimum ? null : fromOrdinal(Math.max(minimum, start - 7)),
    nextWeek: start + 7 > maximum ? null : fromOrdinal(start + 7),
  });
}

/** A changed interpretation context requires review; never reinterpret an already committed date. */
export function relativeDateContextChanged(
  guard: RelativeDateGuard,
  current: DateContext,
): boolean {
  return !isRelativeDateContextCurrent(guard.interpretedAt, current);
}
