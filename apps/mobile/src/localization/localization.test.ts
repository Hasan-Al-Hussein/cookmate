import {
  formatCalendarDate,
  formatNumber,
  isolateSourceText,
  localeDirection,
  localizationStatus,
  resolveLocale,
  translate,
} from './index';
import { arabicMessages, englishMessages } from './messages';

test('dictionaries have the same keys and interpolation fields, with Arabic status kept honest', () => {
  expect(Object.keys(arabicMessages).sort()).toEqual(Object.keys(englishMessages).sort());
  for (const key of Object.keys(englishMessages) as (keyof typeof englishMessages)[]) {
    expect(arabicMessages[key].match(/\{[^}]+\}/g) ?? []).toEqual(
      englishMessages[key].match(/\{[^}]+\}/g) ?? [],
    );
  }
  expect(localizationStatus.arabic).toBe('unreviewed-foundation');
  expect(translate('en', 'language.foundationNotice')).toContain('has not been reviewed');
});

test.each(['ar', 'ar-AE', 'ar_EG', 'AR-SA'])('recognizes system Arabic locale %s', (locale) => {
  expect(resolveLocale('system', locale)).toBe('ar');
});

test('unsupported system languages use English while explicit choices take priority', () => {
  expect(resolveLocale('system', 'fr-FR')).toBe('en');
  expect(resolveLocale('en', 'ar-AE')).toBe('en');
  expect(resolveLocale('ar', 'en-GB')).toBe('ar');
  expect(localeDirection('ar')).toBe('rtl');
  expect(localeDirection('en')).toBe('ltr');
});

test('typed messages interpolate user-visible values without changing original source text', () => {
  expect(translate('en', 'language.current', { language: 'Arabic' })).toBe(
    'Current interface language: Arabic',
  );
  expect(translate('ar', 'language.current', { language: 'العربية' })).toContain('العربية');
  const title = 'Fettucine alfredo';
  expect(isolateSourceText(title)).toBe(`\u2068${title}\u2069`);
  expect(title).toBe('Fettucine alfredo');
});

test('calendar dates remain Gregorian calendar identities, formatted in the chosen language', () => {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  for (const locale of ['en', 'ar'] as const) {
    const expected = new Intl.DateTimeFormat(locale, {
      ...options,
      calendar: 'gregory',
      timeZone: 'UTC',
    }).format(new Date('2026-09-30T00:00:00Z'));
    expect(formatCalendarDate('2026-09-30', locale, options)).toBe(expected);
  }
  expect(formatCalendarDate('2024-02-29', 'en')).toContain('2024');
  expect(formatCalendarDate('0099-09-30', 'en')).not.toContain('1999');
});

test.each(['2026-02-29', '2026-13-01', '2026-04-31', '2026-09-00', '30/09/2026', '0000-01-01'])(
  'does not normalize invalid date %s into another planned date',
  (value) => {
    expect(() => formatCalendarDate(value, 'ar')).toThrow(RangeError);
  },
);

test('localized number formatting changes presentation only and rejects nonfinite quantities', () => {
  const original = 1250.5;
  expect(formatNumber(original, 'ar')).toBe(new Intl.NumberFormat('ar').format(original));
  expect(original).toBe(1250.5);
  expect(() => formatNumber(Number.NaN, 'en')).toThrow(RangeError);
  expect(() => formatNumber(Number.POSITIVE_INFINITY, 'ar')).toThrow(RangeError);
});
