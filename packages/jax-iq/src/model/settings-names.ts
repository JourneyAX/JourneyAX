/**
 * The settings the engine itself reads, by name only. The dictionary declares each one (with an owner role and the value `null`); the
 * release check fails when one is missing. `null` means: no cache, the default call timeout, no retry, no cool-down, and evidence kept
 * for the same turn only.
 *
 * A freshness limit is not in this list: it is `freshness.<kind>` for each kind of freshness a fact uses, and the kinds are data.
 */
export const ENGINE_SETTINGS = [
  'timeout.call',
  'timeout.query',
  'retry.attempts',
  'retry.delay',
  'cooldown.rateLimited',
  'limit.parallelPerSystem',
  'evidence.retention',
] as const;

export type EngineSettingName = (typeof ENGINE_SETTINGS)[number];
