import { createHmac } from 'node:crypto';
import type { KeyCaseRule } from './types';

/**
 * The longest text a pattern is ever applied to. A key pattern in a dictionary can be written so that it matches slowly on a very long
 * input, so a pattern is applied only to a value or a note of this length or shorter, and a longer one is treated as not matching. The
 * same limit applies to every key value, with or without a pattern, and to the text a note key is read from (a description that carries
 * an account number among other sentences). It has to be long enough for such a description and short enough to bound the work.
 */
export const MAX_PATTERN_INPUT_LENGTH = 2000;

/**
 * Name normalisation, in this order:
 * 1. Unicode NFKC (full-width letters and ligatures become plain ones).
 * 2. Lower case.
 * 3. `&` becomes the word `and`, so `&` and `and` are one token.
 * 4. Every other mark that is not a letter, a digit or a combining mark becomes a space.
 * 5. Runs of spaces collapse to one and the ends are trimmed.
 * Word order is kept. No suffix word is stripped. The result is only ever compared, never shown or stored.
 */
export function normaliseName(text: string): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

/** The words of a normalised name. */
export function nameWords(text: string): string[] {
  const normalised = normaliseName(text);
  return normalised === '' ? [] : normalised.split(' ');
}

/**
 * A candidate matches when the normalised words of the query are a contiguous run of whole words inside the normalised name.
 * A query with no words matches nothing.
 */
export function nameContainsWords(name: string, query: string): boolean {
  const wanted = nameWords(query);
  const words = nameWords(name);
  if (wanted.length === 0 || wanted.length > words.length) return false;
  for (let start = 0; start + wanted.length <= words.length; start++) {
    if (wanted.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

export type KeyValueCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'absent' | 'too_long' | 'pattern' };

/** Compares two ids by code point, so a list is in the same order on every machine. */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function applyCaseRule(value: string, caseRule: KeyCaseRule): string {
  if (caseRule === 'upper') return value.toUpperCase();
  if (caseRule === 'lower') return value.toLowerCase();
  return value;
}

/**
 * Reads one identifier. Blank, null, absent and non-text values are `absent` (a missing note is "not there", never zero). A value is
 * trimmed, written in the kind's case, and only then tested against the kind's pattern, so a pattern is written for the normal form.
 */
export function normaliseKeyValue(value: unknown, rule: { caseRule: KeyCaseRule; pattern?: string }): KeyValueCheck {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string') return { ok: false, reason: 'absent' };
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'absent' };
  if (trimmed.length > MAX_PATTERN_INPUT_LENGTH) return { ok: false, reason: 'too_long' };
  const cased = applyCaseRule(trimmed, rule.caseRule);
  if (cased.length > MAX_PATTERN_INPUT_LENGTH) return { ok: false, reason: 'too_long' };
  if (rule.pattern !== undefined) {
    let expression: RegExp;
    try {
      expression = new RegExp(rule.pattern);
    } catch {
      return { ok: false, reason: 'pattern' };
    }
    if (!expression.test(cased)) return { ok: false, reason: 'pattern' };
  }
  return { ok: true, value: cased };
}

/**
 * Reads the number out of a free-text note (a description that says "Account number ..."), with the mapping's extract pattern, which has
 * one capture group. A missing or blank note is `absent`; a note that is too long to test is `too_long`; a note that does not carry the
 * number any more (someone edited it) is `pattern`. The captured text is then read like any other key value.
 */
export function extractNoteKey(note: unknown, extract: { pattern: string }, rule: { caseRule: KeyCaseRule; pattern?: string }): KeyValueCheck {
  if (typeof note !== 'string' || note.trim() === '') return { ok: false, reason: 'absent' };
  if (note.length > MAX_PATTERN_INPUT_LENGTH) return { ok: false, reason: 'too_long' };
  let found: RegExpExecArray | null;
  try {
    found = new RegExp(extract.pattern).exec(note);
  } catch {
    return { ok: false, reason: 'pattern' };
  }
  if (!found || found[1] === undefined) return { ok: false, reason: 'pattern' };
  return normaliseKeyValue(found[1], rule);
}

/**
 * A contact is keyed by its account and a salted hash of its lower-case email, so the key table holds nothing readable. The hash is an
 * HMAC-SHA-256 keyed by the salt, written as 64 hex characters. A contact with no email has no key (the result is `undefined`). A missing
 * salt throws: there is no default.
 */
export function contactKeyHash(email: string, salt: string): string | undefined {
  if (typeof salt !== 'string' || salt.trim() === '') throw new Error('contactKeyHash needs a salt from configuration.');
  if (typeof email !== 'string') return undefined;
  const lower = email.normalize('NFKC').trim().toLowerCase();
  if (lower === '') return undefined;
  return createHmac('sha256', salt).update(lower, 'utf8').digest('hex');
}

const KEYED_UNDER_SEPARATOR = ':';

/** The canonical id of a thing that is keyed under an account, for example a contact: the account's canonical id, a colon and the hash. */
export function contactCanonicalId(accountCanonicalId: string, hash: string): string {
  return `${accountCanonicalId}${KEYED_UNDER_SEPARATOR}${hash}`;
}

/** True when a canonical id was made by {@link contactCanonicalId} for this account. */
export function isKeyedUnder(canonicalId: string, accountCanonicalId: string): boolean {
  const prefix = `${accountCanonicalId}${KEYED_UNDER_SEPARATOR}`;
  return canonicalId.length > prefix.length && canonicalId.startsWith(prefix);
}

/**
 * The canonical id of a contact under an account, or `undefined` when the contact has no email address (it is listed in the key report,
 * not keyed). The address itself is never part of the result.
 */
export function contactKeyValue(accountCanonicalId: string, email: string | undefined | null, salt: string): string | undefined {
  const hash = contactKeyHash(email ?? '', salt);
  return hash === undefined ? undefined : contactCanonicalId(accountCanonicalId, hash);
}
