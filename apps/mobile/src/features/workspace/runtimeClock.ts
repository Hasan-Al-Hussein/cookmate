import type { DateContext } from '@cookmate/contracts';
import { getPlanWeek, isSupportedPlanDate } from '@cookmate/domain';

export interface RuntimeClock {
  now(): string;
  dateContext(): DateContext;
}

export const runtimeClock: RuntimeClock = {
  now: () => new Date().toISOString(),
  dateContext() {
    const date = new Date();
    return {
      localDate: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMinutes: -date.getTimezoneOffset(),
    };
  },
};

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function formatPlanDate(value: string, short = false): string {
  if (!isSupportedPlanDate(value)) return value;
  const day = weekdays[getPlanWeek(value).days.indexOf(value)]!;
  return `${short ? day.slice(0, 3) : day} ${Number(value.slice(8))} ${short ? months[Number(value.slice(5, 7)) - 1]!.slice(0, 3) : months[Number(value.slice(5, 7)) - 1]}${short ? '' : ` ${value.slice(0, 4)}`}`;
}

export function mealLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
