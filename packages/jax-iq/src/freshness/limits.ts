import type { SettingDef } from '../model';

/**
 * How old a fact may be. A fact names a kind of freshness; the limit for that kind is the release setting `freshness.<kind>`. No limit
 * has a value in code: a setting that is not set, not declared or not a usable time means "no limit", and no limit means the fact is
 * never served from a stored copy and nothing is stored for it.
 */

const SETTING_PREFIX = 'freshness.';

/** The setting that holds the limit for one kind of freshness. */
export const freshnessSettingKey = (kind: string): string => `${SETTING_PREFIX}${kind}`;

/** A setting's value in milliseconds, by the time unit it is declared in. Any other unit is not a time. */
const TO_MILLISECONDS: Readonly<Record<string, (value: number) => number>> = {
  seconds: (value) => value * 1000,
  milliseconds: (value) => value,
  days: (value) => value * 86_400_000,
};

export interface FreshnessLimits {
  /** The limit for a kind in milliseconds, or `null` when it is not set, not declared or not usable. Zero is a limit. */
  millisecondsFor(kind: string): number | null;
  /** Keys of `freshness.*` settings that hold a value this module will not use: a negative number, a unit that is not a time, a key declared twice. */
  unusable: string[];
}

export function buildFreshnessLimits(settings: readonly SettingDef[]): FreshnessLimits {
  const limits = new Map<string, number | null>();
  const seen = new Set<string>();
  const unusable: string[] = [];
  for (const setting of settings) {
    if (!setting.key.startsWith(SETTING_PREFIX)) continue;
    if (seen.has(setting.key)) {
      limits.set(setting.key, null);
      if (!unusable.includes(setting.key)) unusable.push(setting.key);
      continue;
    }
    seen.add(setting.key);
    if (setting.value === null) {
      limits.set(setting.key, null);
      continue;
    }
    const convert = TO_MILLISECONDS[setting.unit];
    const milliseconds = convert ? convert(setting.value) : Number.NaN;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      limits.set(setting.key, null);
      unusable.push(setting.key);
      continue;
    }
    limits.set(setting.key, milliseconds);
  }
  return { millisecondsFor: (kind) => limits.get(freshnessSettingKey(kind)) ?? null, unusable };
}

/**
 * The limit that applies when one answer has to meet several: the shortest of theirs. One call that fills several facts is such a case,
 * and so is one fact read through a binding whose kind of freshness differs from the fact's. When any of them has no limit the answer
 * has none, because that one must always be read again and the one answer serves them all.
 */
export function callFreshnessLimit(limitsMs: ReadonlyArray<number | null>): number | null {
  if (limitsMs.length === 0) return null;
  let shortest: number | null = null;
  for (const limit of limitsMs) {
    if (limit === null) return null;
    if (shortest === null || limit < shortest) shortest = limit;
  }
  return shortest;
}

/** Milliseconds between the read and now, or `null` when the time cannot be read. */
export function retrievalAgeMs(retrievedAt: string, now: Date): number | null {
  const at = Date.parse(retrievedAt);
  return Number.isFinite(at) ? now.getTime() - at : null;
}

/** True when a read taken at `retrievedAt` is no older than the limit. An unset limit, an unreadable time or a time after now is not within. */
export function isWithinLimit(retrievedAt: string, limitMs: number | null, now: Date): boolean {
  if (limitMs === null) return false;
  const age = retrievalAgeMs(retrievedAt, now);
  return age !== null && age >= 0 && age <= limitMs;
}

export interface FreshnessCheck {
  /** False: the value was read in this query and is current by definition. */
  fromCache: boolean;
  retrievedAt: string;
  limitMs: number | null;
  now: Date;
  /** The fact's own `allowStale`. */
  allowStale: boolean;
  /** True when the value is past its limit, it was read again and that failed. */
  refetchFailed: boolean;
}

/**
 * `current`: show it. `stale`: past the limit, the new read failed and the fact allows an old value: show it marked stale.
 * `refused`: past the limit and not allowed to show: the fact is not available. A stored value past its limit that nobody tried to read
 * again is refused too, whatever the fact allows.
 */
export type FreshnessVerdict = 'current' | 'stale' | 'refused';

export function judgeFreshness(check: FreshnessCheck): FreshnessVerdict {
  if (!check.fromCache) return 'current';
  if (isWithinLimit(check.retrievedAt, check.limitMs, check.now)) return 'current';
  return check.allowStale && check.refetchFailed ? 'stale' : 'refused';
}
