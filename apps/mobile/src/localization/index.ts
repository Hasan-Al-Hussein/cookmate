import type { AppPreferences } from '../features/app-preferences/preferences';
import { arabicMessages, englishMessages, type MessageKey } from './messages';

export type AppLocale = 'en' | 'ar';
export type { MessageKey } from './messages';
export const localizationStatus = { english: 'source', arabic: 'unreviewed-foundation' } as const;

type Placeholders<Text extends string> = Text extends `${string}{${infer Key}}${infer Rest}`
  ? Key | Placeholders<Rest>
  : never;
type TranslationArguments<Key extends MessageKey> = [
  Placeholders<(typeof englishMessages)[Key]>,
] extends [never]
  ? []
  : [values: Record<Placeholders<(typeof englishMessages)[Key]>, string | number>];

export function resolveLocale(
  preference: AppPreferences['locale'],
  systemLocale?: string,
): AppLocale {
  if (preference !== 'system') return preference;
  let resolved = systemLocale;
  if (!resolved) {
    try {
      resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      return 'en';
    }
  }
  return /^ar(?:[-_]|$)/i.test(resolved) ? 'ar' : 'en';
}

export function localeDirection(locale: AppLocale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function translate<Key extends MessageKey>(
  locale: AppLocale,
  key: Key,
  ...args: TranslationArguments<Key>
): string {
  const values = args[0] as Record<string, string | number> | undefined;
  const template = (locale === 'ar' ? arabicMessages : englishMessages)[key];
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_placeholder, name: string) => {
    const value = values?.[name];
    if (value === undefined) throw new Error(`Missing translation value: ${name}`);
    return String(value);
  });
}

export function formatNumber(
  value: number,
  locale: AppLocale,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) throw new RangeError('Only finite numbers can be formatted.');
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatCalendarDate(
  value: string,
  locale: AppLocale,
  options: Omit<Intl.DateTimeFormatOptions, 'timeZone' | 'calendar'> = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  },
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Expected a YYYY-MM-DD date.');
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year === 0 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError('Expected a valid calendar date.');
  }
  // A planned date is a calendar identity, not a timestamp that can shift with device timezone.
  return new Intl.DateTimeFormat(locale, {
    ...options,
    calendar: 'gregory',
    timeZone: 'UTC',
  }).format(date);
}

/** Display-only bidi isolation for source titles/URLs; never store this as recipe content. */
export function isolateSourceText(text: string): string {
  return `\u2068${text}\u2069`;
}
