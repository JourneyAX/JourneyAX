import type { FactType } from '../model';
import type { FactSource, FactUnavailable } from './facts';

/**
 * What another system says about a fact whose value comes from the source of truth. It is kept for `explain` and never replaces or
 * sits beside the value in a plain answer.
 */
export interface FactCrossCheck {
  bindingId: string;
  system: string;
  displayName: string;
  sample: boolean;
  tool: string;
  /** Present when the other system gave a value. */
  source?: FactSource;
  value?: unknown;
  /** `null`: nothing to compare, because the other system gave no value or the fact has none. */
  agrees: boolean | null;
  unavailable?: FactUnavailable;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The same text for the same data, whatever order the keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** A decimal written as text with the zeros that change nothing taken off, or `null` when the text is not a plain decimal. */
function plainDecimal(text: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const digits = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  const body = decimals ? `${digits}.${decimals}` : digits;
  return body === '0' ? '0' : `${sign}${body}`;
}

/** A date, or a date and time of day with its offset from UTC. Nothing else is a time: the zone of a time with no offset is not known. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?))?$/;

export interface IsoTime {
  /** The moment, in milliseconds since 1970. A date with no time of day is the start of that day in UTC. */
  ms: number;
  /** The same time written one way: UTC with a Z, whole seconds unless the source gave a fraction. A date stays a date. */
  text: string;
}

/**
 * Reads a time the way ISO 8601 writes it, or returns `null`. The engine's own date parser reads many texts that are not times (a bare
 * number, an order number with a digit in it), so it is not used: a source time that is not an ISO 8601 time is no time at all. A day
 * that is not on the calendar, an hour of 24 and a time with no offset are refused.
 */
export function parseIsoTime(text: unknown): IsoTime | null {
  if (typeof text !== 'string') return null;
  const match = ISO_TIME.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const start = new Date(0);
  start.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  // A day that is not on the calendar rolls into the next month; a month past twelve rolls into the next year.
  if (start.getUTCMonth() !== Number(month) - 1 || start.getUTCDate() !== Number(day)) return null;
  if (hour === undefined) return { ms: start.getTime(), text };

  const wholeSeconds = Number(second ?? '0');
  if (Number(hour) > 23 || Number(minute) > 59 || wholeSeconds > 59) return null;
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetRest = Number(digits.slice(2) || '0');
    if (offsetHours > 23 || offsetRest > 59) return null;
    offsetMinutes = (offset.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetRest);
  }
  const seconds = Number(hour) * 3600 + Number(minute) * 60 + wholeSeconds;
  const ms = start.getTime() + seconds * 1000 + Number((fraction ?? '').slice(0, 3).padEnd(3, '0')) - offsetMinutes * 60_000;
  const written = new Date(ms).toISOString();
  // A time pushed past year 9999 or before year 0 by its offset is written with a sign and six digits: not a time this module keeps.
  return /^\d{4}-/.test(written) ? { ms, text: written.replace(/\.000Z$/, 'Z') } : null;
}

function sameTime(a: unknown, b: unknown): boolean | null {
  const first = parseIsoTime(a);
  const second = parseIsoTime(b);
  return first && second ? first.ms === second.ms : null;
}

/**
 * Whether two values of one fact are the same value. Money agrees when the currency is the same and the amounts are the same number
 * (62.50 and 62.5 agree). Times agree when they are the same moment, and both are ISO 8601 times; two texts that are not times are
 * compared as text, so two different codes never agree. Everything else must be identical. The type may be left out to compare any two
 * pieces of data.
 */
export function valuesAgree(type: FactType | undefined, a: unknown, b: unknown): boolean {
  if (type === 'money' && isRecord(a) && isRecord(b) && typeof a.amount === 'string' && typeof b.amount === 'string') {
    const first = plainDecimal(a.amount);
    const second = plainDecimal(b.amount);
    if (first !== null && second !== null) return a.currency === b.currency && first === second;
  }
  if (type === 'date' || type === 'datetime') {
    const same = sameTime(a, b);
    if (same !== null) return same;
  }
  return canonical(a) === canonical(b);
}
