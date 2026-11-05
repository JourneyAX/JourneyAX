/** Currency arithmetic for quotes and external order delivery. Decimal inputs are
 * rounded once, in the currency's minor unit, before totals are distributed. */
export function commerceFractionDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('An authoritative currency code is required.');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 3) throw new Error('Unsupported currency precision.');
  return digits;
}

function decimal(value: number): [bigint, bigint] {
  if (!Number.isFinite(value)) throw new Error('A finite monetary value is required.');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) throw new Error('Invalid decimal value.');
  const fraction = match[3] || '', scale = fraction.length - Number(match[4] || 0);
  let numerator = BigInt(match[2] + fraction) * (match[1] ? -1n : 1n);
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  return [numerator, scale > 0 ? 10n ** BigInt(scale) : 1n];
}

export function roundCommerceRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error('A positive monetary denominator is required.');
  const sign = numerator < 0n ? -1n : 1n, magnitude = numerator * sign;
  const result = sign * ((magnitude * 2n + denominator) / (2n * denominator));
  const value = Number(result);
  if (!Number.isSafeInteger(value)) throw new Error('Monetary value exceeds the supported range.');
  return value;
}

export function commerceMinorAmount(value: number, currency: string, quantity = 1): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('A whole non-negative quantity is required.');
  const [numerator, denominator] = decimal(value);
  return roundCommerceRatio(numerator * BigInt(quantity) * 10n ** BigInt(commerceFractionDigits(currency)), denominator);
}

export function commerceRateAmount(minor: number, rate: number): number {
  if (!Number.isSafeInteger(minor) || minor < 0 || !Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Invalid monetary amount or configured rate.');
  const [numerator, denominator] = decimal(rate);
  return roundCommerceRatio(BigInt(minor) * numerator, denominator);
}

/** Largest remainder allocation keeps every minor unit and is stable on replay. */
export function allocateCommerceMinor(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error('Invalid monetary allocation.');
  const sum = weights.reduce((value, weight) => value + BigInt(weight), 0n);
  if (sum === 0n) { if (total !== 0) throw new Error('Cannot allocate money without priced lines.'); return weights.map(() => 0); }
  const rows = weights.map((weight, index) => { const amount = BigInt(total) * BigInt(weight); return { index, amount: Number(amount / sum), remainder: amount % sum }; });
  let left = total - rows.reduce((value, row) => value + row.amount, 0);
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) { if (left <= 0) break; row.amount++; left--; }
  return rows.map(row => row.amount);
}
