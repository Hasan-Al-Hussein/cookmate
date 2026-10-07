import type { ShoppingContribution } from './services';

export const QUANTITY_RULE_VERSION = 'source-quantity-v1';
export type ParsedQuantity = ShoppingContribution['quantity'];
type ExactQuantity = Extract<ParsedQuantity, { kind: 'exact' }>;

// Lexical aliases only. No conversion between units, densities, pack sizes or servings.
const units: Readonly<Record<string, string>> = Object.freeze({
  '': 'count',
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  ml: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'L',
  litre: 'L',
  litres: 'L',
  liter: 'L',
  liters: 'L',
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tbsp: 'tbsp',
  tbs: 'tbsp',
  tblsp: 'tbsp',
  tbls: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  cup: 'cup',
  cups: 'cup',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  clove: 'clove',
  cloves: 'clove',
});
const vulgarFractions: Readonly<Record<string, string>> = Object.freeze({
  '½': '1/2',
  '⅓': '1/3',
  '⅔': '2/3',
  '¼': '1/4',
  '¾': '3/4',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅐': '1/7',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⅑': '1/9',
  '⅒': '1/10',
});
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function exact(numerator: bigint, denominator: bigint, unit: string): ExactQuantity {
  const divisor = gcd(numerator, denominator);
  return {
    kind: 'exact',
    numerator: (numerator / divisor).toString(),
    denominator: (denominator / divisor).toString(),
    unit,
  };
}

/** Only complete supported measures parse. Qualifiers/ranges/pack expressions stay attributed raw text. */
export function parseSourceQuantity(raw: string | null): ParsedQuantity {
  if (raw === null || raw.trim() === '') return { kind: 'unknown' };
  if (raw.length > 256) return { kind: 'unparsed' };
  if (/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]\s*[\d/.]/.test(raw)) return { kind: 'unparsed' };
  const text = raw
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]/g, (character) => ` ${vulgarFractions[character]!}`)
    .replace(/⁄/g, '/')
    .trim()
    .replace(/\s+/g, ' ');
  const match = /^(\d+ \d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(text);
  if (!match) return { kind: 'unparsed' };
  const unit = units[match[2]!.toLowerCase()];
  if (unit === undefined) return { kind: 'unparsed' };
  const amount = match[1]!;
  if (amount.includes('/')) {
    const [left, divisor] = amount.split('/');
    const parts = left!.split(' ');
    const numerator = BigInt(parts.at(-1)!);
    const denominator = BigInt(divisor!);
    if (denominator === 0n || (parts.length === 2 && numerator >= denominator))
      return { kind: 'unparsed' };
    return exact(
      numerator + (parts.length === 2 ? BigInt(parts[0]!) * denominator : 0n),
      denominator,
      unit,
    );
  }
  const [integer, fraction = ''] = amount.split('.');
  return exact(BigInt(integer! + fraction), 10n ** BigInt(fraction.length), unit);
}

function validateExact(value: ExactQuantity): void {
  if (
    value.kind !== 'exact' ||
    !/^\d{1,256}$/.test(value.numerator) ||
    !/^[1-9]\d{0,255}$/.test(value.denominator) ||
    !Object.values(units).includes(value.unit)
  )
    throw new Error('Invalid exact quantity');
}

export function sumCompatibleQuantities(values: readonly ExactQuantity[]): ExactQuantity {
  if (!values.length) throw new Error('No quantities to sum');
  let total = exact(0n, 1n, values[0]!.unit);
  for (const value of values) {
    validateExact(value);
    if (value.unit !== total.unit) throw new Error('Incompatible quantity units');
    total = exact(
      BigInt(total.numerator) * BigInt(value.denominator) +
        BigInt(value.numerator) * BigInt(total.denominator),
      BigInt(total.denominator) * BigInt(value.denominator),
      total.unit,
    );
  }
  return total;
}

export function formatExactQuantity(value: ExactQuantity): string {
  validateExact(value);
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  let amount = whole.toString();
  if (remainder) {
    if (1000n % denominator === 0n) {
      const decimal = ((remainder * 1000n) / denominator)
        .toString()
        .padStart(3, '0')
        .replace(/0+$/, '');
      amount += `.${decimal}`;
    } else amount = `${whole ? `${whole} ` : ''}${remainder}/${denominator}`;
  }
  return value.unit === 'count' ? amount : `${amount} ${value.unit}`;
}

// Actual case-only collisions were reviewed across all 960 source entries. Search aliases are excluded.
export const REVIEWED_INGREDIENT_CASE_KEYS: readonly string[] = Object.freeze([
  'cornstarch',
  'garlic',
  'plum tomatoes',
  'water',
  'cinnamon stick',
  'lemon',
  'cayenne pepper',
  'olive oil',
  'soy sauce',
  'vegetable oil',
  'coconut cream',
  'tamarind paste',
  'spring onions',
  'brown sugar',
  'chilli',
  'minced garlic',
  'ground ginger',
]);
const reviewedNames = new Set(REVIEWED_INGREDIENT_CASE_KEYS);
export function ingredientGroupingIdentity(rawName: string): string {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 256) throw new Error('Invalid ingredient name');
  const lower = name.toLowerCase();
  return reviewedNames.has(lower) ? `reviewed:${lower}` : `exact:${name}`;
}
