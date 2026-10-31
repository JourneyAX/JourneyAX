/**
 * Exact arithmetic for signals. A threshold test must give the same answer at the boundary every time, so nothing here uses floating
 * point: a value is a fraction of two whole numbers, a comparison multiplies across, and a ratio of two decimals stays exact (a third
 * stays a third). A JS number is read through its shortest printed form, so 0.1 is one tenth.
 */

export interface ExactNumber {
  /** Lowest terms; carries the sign. */
  readonly num: bigint;
  /** Above zero. */
  readonly den: bigint;
}

/** Plain decimal text, with an optional exponent: no spaces, no thousands marks, no sign other than + or -. */
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Technical bounds on what is read, so that one hostile string cannot build an enormous integer. They are not business values. */
const LONGEST_TEXT = 200;
const LARGEST_EXPONENT = 400;

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let x = absolute(a);
  let y = absolute(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** A fraction in lowest terms with a positive divisor. */
export function exact(num: bigint, den: bigint = 1n): ExactNumber {
  if (den === 0n) throw new RangeError('a fraction needs a divisor other than zero');
  const sign = den < 0n ? -1n : 1n;
  const common = greatestCommonDivisor(num, den);
  return { num: (sign * num) / common, den: (sign * den) / common };
}

/** Reads plain decimal text exactly. Anything else (blank, spaces, 'NaN', two points, a bare exponent) is null. */
export function parseExact(text: string): ExactNumber | null {
  if (text.length === 0 || text.length > LONGEST_TEXT) return null;
  const match = DECIMAL_TEXT.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = '', exponentText] = match;
  const digits = `${whole}${fraction}`;
  if (digits.length === 0) return null;
  const exponent = (exponentText === undefined ? 0 : Number(exponentText)) - fraction.length;
  if (Math.abs(exponent) > LARGEST_EXPONENT) return null;
  const magnitude = BigInt(digits);
  const signed = sign === '-' ? -magnitude : magnitude;
  return exponent >= 0 ? exact(signed * 10n ** BigInt(exponent)) : exact(signed, 10n ** BigInt(-exponent));
}

/** A JS number as the decimal it prints as. Not finite is null. */
export function fromJsNumber(value: number): ExactNumber | null {
  return Number.isFinite(value) ? parseExact(String(value)) : null;
}

/** A money value as it travels: an amount (text or number) and a currency. Anything else is null. */
export function readAmount(value: unknown): { amount: ExactNumber; currency: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  if (typeof currency !== 'string' || currency.length === 0) return null;
  const parsed = typeof amount === 'string' ? parseExact(amount) : typeof amount === 'number' ? fromJsNumber(amount) : null;
  return parsed ? { amount: parsed, currency } : null;
}

export function compareExact(a: ExactNumber, b: ExactNumber): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function signOf(value: ExactNumber): -1 | 0 | 1 {
  return value.num < 0n ? -1 : value.num > 0n ? 1 : 0;
}

/** Null when the divisor is zero: there is no answer, and no stand-in for one. */
export function divideExact(a: ExactNumber, b: ExactNumber): ExactNumber | null {
  return b.num === 0n ? null : exact(a.num * b.den, a.den * b.num);
}

/** The decimal it equals when it has a finite one (a quarter is 0.25), else the fraction (a third is 1/3). Never rounded. */
export function formatExact(value: ExactNumber): string {
  if (value.den === 1n) return value.num.toString();
  let rest = value.den;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) { rest /= 2n; twos += 1; }
  while (rest % 5n === 0n) { rest /= 5n; fives += 1; }
  if (rest !== 1n) return `${value.num}/${value.den}`;
  const places = Math.max(twos, fives);
  const scaled = absolute(value.num) * (10n ** BigInt(places) / value.den);
  const digits = scaled.toString().padStart(places + 1, '0');
  const point = digits.length - places;
  return `${value.num < 0n ? '-' : ''}${digits.slice(0, point)}.${digits.slice(point)}`;
}
