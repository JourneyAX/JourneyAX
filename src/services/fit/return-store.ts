/**
 * The write half of the returns learning loop.
 *
 * `returnSignal` in `signals.ts` reads `Wearer.returns` and is one of the
 * strongest signals the engine has. Nothing ever wrote to it. The product
 * claim "it learns from returns" was, until this module existed, structurally
 * untrue: the reader was built, the writer was not, and the gap was invisible
 * because a wearer with no returns is indistinguishable from a brand that
 * does not take returns — `returnSignal` returns null in both cases.
 *
 * This closes the loop. `recordReturn` captures a resolved return; `hydrate`
 * merges what we have recorded into a wearer before the engine sees them.
 *
 * PERSISTENCE: the default backing store is an in-process Map, so recorded
 * returns are lost on restart and not shared between instances. That is
 * honest for a pilot and wrong for production. Swap `store` for a database
 * implementation of `ReturnStore` — nothing outside this file changes.
 */

import type { Wearer, WearerReturn } from '@/lib/fit-types';
import type { ReturnReason } from '@/lib/shop-types';
import { logger } from '@/lib/logger';

const log = logger('fit/return-store');

export interface ReturnStore {
  append(wearerId: string, record: WearerReturn): void;
  read(wearerId: string): WearerReturn[];
  clear(): void;
}

/** Keep the tail only; the signal reads the most recent usable return. */
const MAX_PER_WEARER = 20;

function createMemoryStore(): ReturnStore {
  const byWearer = new Map<string, WearerReturn[]>();
  return {
    append(wearerId, record) {
      const existing = byWearer.get(wearerId) ?? [];
      existing.push(record);
      byWearer.set(wearerId, existing.slice(-MAX_PER_WEARER));
    },
    read(wearerId) {
      return byWearer.get(wearerId) ?? [];
    },
    clear() {
      byWearer.clear();
    },
  };
}

let store: ReturnStore = createMemoryStore();

/** Install a real persistence layer. Call once at startup. */
export function setReturnStore(next: ReturnStore) {
  store = next;
}

/**
 * Map a shopper-facing return reason onto a fit signal.
 *
 * `style` and `quality` deliberately collapse to `'other'`: they carry no
 * size information, and `returnSignal` skips `'other'` entirely. Recording
 * them anyway keeps the history honest without letting "wrong colour" nudge
 * somebody's size.
 */
export function fitReasonFor(reason: ReturnReason): WearerReturn['reason'] {
  if (reason === 'too-small') return 'too-small';
  if (reason === 'too-large') return 'too-large';
  return 'other';
}

/** True when this reason will actually move a future recommendation. */
export function isSizeBearing(reason: ReturnReason): boolean {
  return reason === 'too-small' || reason === 'too-large';
}

/**
 * Record a resolved return.
 *
 * Returns whether the record will influence future sizing, so the caller can
 * tell the shopper the truth rather than always claiming to have learned.
 */
export function recordReturn(
  wearerId: string,
  size: string,
  reason: ReturnReason,
  at: string = new Date().toISOString(),
): { recorded: boolean; sizeBearing: boolean } {
  if (!wearerId || !size) {
    log.warn('return not recorded — missing wearer or size');
    return { recorded: false, sizeBearing: false };
  }

  const record: WearerReturn = { at, size, reason: fitReasonFor(reason) };
  store.append(wearerId, record);

  const sizeBearing = isSizeBearing(reason);
  log.debug(`recorded return for ${wearerId}`, { size, reason: record.reason, sizeBearing });
  return { recorded: true, sizeBearing };
}

export function returnsFor(wearerId: string): WearerReturn[] {
  return store.read(wearerId);
}

/**
 * Merge recorded returns into a wearer before the engine evaluates them.
 *
 * Any returns already on the wearer (seeded demo data, or a record imported
 * from the brand's own system) are kept and combined, so hydrating is safe to
 * do unconditionally.
 */
export function hydrate(wearer: Wearer): Wearer {
  const recorded = returnsFor(wearer.id);
  if (recorded.length === 0) return wearer;

  const seen = new Set((wearer.returns ?? []).map(r => `${r.at}|${r.size}|${r.reason}`));
  const merged = [
    ...(wearer.returns ?? []),
    ...recorded.filter(r => !seen.has(`${r.at}|${r.size}|${r.reason}`)),
  ];

  return { ...wearer, returns: merged };
}

/** Test seam. */
export function __clearReturns() {
  store.clear();
}
