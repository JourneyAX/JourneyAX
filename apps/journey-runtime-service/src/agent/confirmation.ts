/**
 * "Ask first": a tool whose state for this person is `ask` does not run when the assistant calls it. The server keeps the call (the
 * tool and its exact arguments), puts a card in front of the person, and runs the kept call only when the person taps Allow.
 *
 * What makes it safe:
 *  - the kept arguments are the server's copy; the tap carries only the confirmation id and the choice, so nothing can be changed on the way;
 *  - a confirmation is used once, only by the person it was made for, and only for 15 minutes;
 *  - the card is built by the server from the call, never by the model.
 */
import { createHash, randomBytes } from 'node:crypto';
import defaults from '../defaults/tool-confirmation.json';

export const PENDING_KEY = 'pending_confirmations';
export const CONFIRMATION_TTL_MS = 15 * 60_000;
const MAX_PENDING = 5;

export interface ConfirmationDetail { label: string; value: string }

export interface PendingConfirmation {
  id: string;
  toolId: string;
  args: Record<string, unknown>;
  argsHash: string;
  summary: string;
  details: ConfirmationDetail[];
  /** Full server-kept payload, shown before approval; summaries never replace it. */
  reviewPayload: string;
  reviewSource?: { name: string; environment: string; sample: boolean };
  principalId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ConfirmationWording {
  heading?: string;
  prompt?: string;
  allow?: string;
  deny?: string;
  allowed?: string;
  denied?: string;
}

/** The same arguments always hash the same, whatever order the keys were written in. */
export function hashArgs(args: unknown): string {
  const sort = (value: any): any => (Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value);
  return createHash('sha256').update(JSON.stringify(sort(args ?? {}))).digest('hex').slice(0, 24);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const humanise = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/** What the call is about, in a few lines the person can check: short plain values, and a count for a list. */
export function detailsOf(args: Record<string, unknown>): ConfirmationDetail[] {
  const out: ConfirmationDetail[] = [];
  for (const [key, value] of Object.entries(args || {})) {
    if (out.length >= 6) break;
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out.push({ label: humanise(key), value: clip(String(value), 90) });
    else if (Array.isArray(value)) out.push({ label: humanise(key), value: value.length === 1 && typeof value[0] !== 'object' ? clip(String(value[0]), 90) : `${value.length} item${value.length === 1 ? '' : 's'}` });
  }
  return out;
}

export function readPending(workspace: { facts?: Record<string, any> } | undefined): PendingConfirmation[] {
  const value = workspace?.facts?.[PENDING_KEY]?.value;
  return Array.isArray(value) ? value.filter((entry): entry is PendingConfirmation => Boolean(entry && typeof entry.id === 'string' && typeof entry.toolId === 'string')) : [];
}

function writePending(workspace: { facts?: Record<string, any> }, list: PendingConfirmation[]): void {
  if (!workspace.facts) workspace.facts = {};
  workspace.facts[PENDING_KEY] = { value: list, source: 'system', confidence: 1, extractedAt: new Date().toISOString() };
}

/** Keeps a call to be confirmed. The same call asked twice (a model that repeats itself) reuses the one confirmation. */
export function createPendingConfirmation(
  workspace: { facts?: Record<string, any> },
  input: { toolId: string; args: Record<string, unknown>; summary: string; principalId: string; reviewSource?: PendingConfirmation['reviewSource']; /** What the card lists, when the arguments themselves are not what the person should read. */ detailsFrom?: Record<string, unknown> },
  now: Date = new Date(),
): { pending: PendingConfirmation; reused: boolean } {
  const live = readPending(workspace).filter((entry) => Date.parse(entry.expiresAt) > now.getTime());
  const argsHash = hashArgs(input.args);
  const reviewPayload = JSON.stringify(input.args ?? {}, null, 2);
  if (reviewPayload.length > 64_000) throw new Error('This action is too large to review here. Split it into smaller, separately approved actions.');
  const same = live.find((entry) => entry.toolId === input.toolId && entry.argsHash === argsHash && entry.principalId === input.principalId && entry.reviewPayload === reviewPayload);
  if (same) return { pending: same, reused: true };
  if (live.length >= MAX_PENDING) throw new Error('Resolve the outstanding review cards before preparing more actions. No existing review was replaced.');
  const pending: PendingConfirmation = {
    id: `cf_${randomBytes(9).toString('hex')}`,
    toolId: input.toolId,
    args: JSON.parse(JSON.stringify(input.args ?? {})),
    argsHash,
    reviewPayload,
    ...(input.reviewSource ? { reviewSource: structuredClone(input.reviewSource) } : {}),
    summary: clip(input.summary, 300),
    details: input.detailsFrom ? detailsOf(input.detailsFrom).slice(0, 7) : [{ label: defaults.action, value: humanise(input.toolId) }, ...detailsOf(input.args)].slice(0, 7),
    principalId: input.principalId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
  };
  writePending(workspace, [...live, pending]);
  return { pending, reused: false };
}

export type TakeResult = { ok: true; pending: PendingConfirmation } | { ok: false; reason: 'unknown' | 'expired' | 'someone_else' | 'changed' };

/** Takes a confirmation out of the list, once. Someone else's confirmation is left where it is. */
export function takePendingConfirmation(workspace: { facts?: Record<string, any> }, id: string, principalId: string, now: Date = new Date()): TakeResult {
  const all = readPending(workspace);
  const found = all.find((entry) => entry.id === id);
  if (!found) return { ok: false, reason: 'unknown' };
  if (found.principalId !== principalId) return { ok: false, reason: 'someone_else' };
  writePending(workspace, all.filter((entry) => entry.id !== id));
  if (Date.parse(found.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
  if (!found.reviewPayload || found.argsHash !== hashArgs(found.args) || found.reviewPayload !== JSON.stringify(found.args, null, 2)) return { ok: false, reason: 'changed' };
  return { ok: true, pending: found };
}

/** The state of the card for a kept call, in the shop's wording where it has some. */
export function confirmCardState(pending: PendingConfirmation, wording: ConfirmationWording = {}): Record<string, unknown> {
  return {
    confirmationId: pending.id,
    heading: wording.heading || defaults.heading,
    summary: pending.summary,
    reviewPayload: pending.reviewPayload,
    ...(pending.reviewSource ? { reviewSource: pending.reviewSource } : {}),
    ...(pending.details.length > 0 ? { details: pending.details } : {}),
    allowLabel: wording.allow || defaults.allow,
    denyLabel: wording.deny || defaults.deny,
    allowedText: wording.allowed || defaults.allowed,
    deniedText: wording.denied || defaults.denied,
    pending: true,
  };
}

export const defaultPrompt = (wording: ConfirmationWording = {}): string => wording.prompt || defaults.prompt;
export const outcomeWording = (wording: ConfirmationWording = {}) => ({ allowed: wording.allowed || defaults.allowed, denied: wording.denied || defaults.denied });
