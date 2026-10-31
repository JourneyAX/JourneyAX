/**
 * What the empty chat says to the person who is signed in, as the shop's pack words it (`extensions.welcome`, chosen on the server for
 * their team and handed over with their connector list). The page only fills in the greeting and drops the starters the person could not
 * use: it never decides who gets what.
 */
import type { ConnectorItem } from '../connectors/connectors';
import { displayFirstName, timeOfDayHello } from './greeting';
import { toolUsable, type Starter } from './starters';

export interface Welcome {
  headline?: string;
  subtitle?: string;
  /** What the empty message box says before anyone types. */
  placeholder?: string;
  starters?: Array<Starter & { needs?: string[] }>;
}

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/** The `welcome` part of the connector list answer; anything malformed is left out, and no usable part means no welcome. */
export function parseWelcome(json: unknown): Welcome | undefined {
  const raw = (json as { welcome?: unknown } | null | undefined)?.welcome as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const starters = Array.isArray(raw.starters)
    ? raw.starters.flatMap((entry: any) => {
        const label = text(entry?.label, 60);
        const prompt = text(entry?.prompt, 500);
        if (!label || !prompt) return [];
        const needs = Array.isArray(entry?.needs) ? entry.needs.filter((n: unknown): n is string => typeof n === 'string' && /^[a-z0-9-]+\.[a-z0-9_]+$/i.test(n)).slice(0, 4) : [];
        return [{ label, prompt, ...(needs.length ? { needs } : {}) }];
      }).slice(0, 6)
    : undefined;
  const placeholder = text(raw.placeholder, 100);
  const welcome: Welcome = { headline: text(raw.headline, 120), subtitle: text(raw.subtitle, 240), ...(placeholder ? { placeholder } : {}), ...(starters?.length ? { starters } : {}) };
  return welcome.headline || welcome.subtitle || welcome.placeholder || welcome.starters ? welcome : undefined;
}

/** "{hello}, {name}." becomes "Good morning, Finn." and, with no name, "Good morning." */
export function fillGreeting(template: string | undefined, name: string | undefined | null, now: Date = new Date()): string | undefined {
  if (!template) return undefined;
  return template
    .replace(/\{hello\}/g, timeOfDayHello(now))
    .replace(/\{name\}/g, displayFirstName(name))
    .replace(/\s*,\s*(?=[.!?])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*$/, '')
    .trim() || undefined;
}

/** The welcome's starters this person may use; undefined when there are none to offer, so the page falls back to its own. */
export function welcomeStarters(welcome: Welcome | undefined, connectors: ConnectorItem[]): Starter[] | undefined {
  const usable = (welcome?.starters ?? []).filter((starter) => (starter.needs ?? []).every((tool) => toolUsable(connectors, tool)));
  return usable.length ? usable.map(({ label, prompt }) => ({ label, prompt })) : undefined;
}

/**
 * What the empty chat offers a person the pack has words for. The starters of their team that they may use; and when the team has starters
 * but this person may use none of them yet (their systems are not connected), nothing at all, because the shop's own starters are for
 * shoppers and are never shown to a team. `undefined` only when the pack gave this person no starters, so the page falls back to its own.
 */
export function welcomeOffer(welcome: Welcome | undefined, connectors: ConnectorItem[]): Starter[] | undefined {
  if (!welcome?.starters?.length) return undefined;
  return welcomeStarters(welcome, connectors) ?? [];
}
