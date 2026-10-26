/**
 * Checks on a draft reply before a person sees it. They do not stop the draft; they tell the person where to look.
 *
 * New Zealand's consumer rules make the remedy for a fault depend on whether it is minor or substantial, which is a person's call, so a draft
 * must not promise a refund, a replacement or an amount unless the person is about to approve exactly that step. And a date the draft names
 * must be one the systems showed, so the customer is never told a day nobody checked.
 */
import type { CareStep } from './care.types';

const MONEY_WORDS = /\b(refund|refunded|replace|replacement|replaced|compensat\w*|reimburs\w*|credit(?:ed)?|discount|free of charge)\b/i;
const AMOUNT = /(?:NZ\$|\$)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|NZD)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** "28 October", "28 Oct" and "Wednesday" as comparable keys ("28 oct", "wednesday"). */
export function dateKeys(text: string): string[] {
  const keys: string[] = [];
  const t = text.toLowerCase();
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)) keys.push(`${Number(m[1])} ${m[2]}`);
  for (const d of DAYS) if (new RegExp(`\\b${d}\\b`).test(t)) keys.push(d);
  for (const w of ['tomorrow', 'next week', 'this week', 'by friday']) if (t.includes(w)) keys.push(w);
  return keys;
}

export function checkReply(text: string, ctx: { facts: string[]; steps: CareStep[]; isReply: boolean }): Array<{ label: string; ok: boolean }> {
  if (!ctx.isReply) return [{ label: 'Internal only. Nothing here goes to the customer', ok: true }];
  const checks: Array<{ label: string; ok: boolean }> = [];
  const names = MONEY_WORDS.test(text) || AMOUNT.test(text);
  const money = ctx.steps.find((s) => s.kind === 'money');
  if (!names) checks.push({ label: 'No refund, replacement or amount promised', ok: true });
  else if (money) checks.push({ label: `Names a refund or an amount: it holds only if you approve the step "${money.what}"`, ok: false });
  else checks.push({ label: 'Names a refund, a replacement or an amount that no step covers: check it', ok: false });
  const known = new Set(ctx.facts.flatMap((f) => dateKeys(f)));
  const stray = dateKeys(text).filter((k) => !known.has(k));
  checks.push(stray.length ? { label: `Names a date the systems did not show (${[...new Set(stray)].join(', ')}): check it`, ok: false } : { label: 'Dates come from the systems', ok: true });
  return checks;
}
