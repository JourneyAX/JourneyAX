/**
 * Sends PlaceMakers-style web visits to a Google Analytics 4 property, so the Google Analytics connector has traffic to report. A new
 * property is empty, and an empty property answers every question with nothing.
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/google-analytics.ts [--sessions 40] [--debug] [--apply]
 *
 * Uses the Measurement Protocol, which needs two settings from the property (Admin > Data streams > your web stream):
 *   GA4_MEASUREMENT_ID (looks like G-XXXXXXXXXX) and GA4_API_SECRET (create one under Measurement Protocol API secrets).
 *
 * Limits you should know about:
 *  - Google accepts events up to 3 days old, so this makes the last 3 days of traffic, not a long history. Run it again on later days
 *    and the history grows. Reports can take several hours to show new events.
 *  - These are real events in a real property, made up by this script. Use a test property, not one that measures a live site.
 *  - "Conversions" in the connector are GA4 key events. Mark generate_lead as a key event in Admin > Events, or that column stays empty.
 *  - With --debug the events are only checked by Google (which says what is wrong with them); nothing is recorded.
 *
 * A dry run (the default) says what it would send and sends nothing.
 */
import type { Deps, Env, Rec } from '../../src/types';
import { must, readFlags, required, sampleCollection } from './shared';

const SYSTEM = 'Google Analytics';
const DAYS = 3;
const PER_REQUEST = 25;
const DAY_MICROS = 24 * 60 * 60 * 1_000_000;

export interface Visit { clientId: string; sessionId: number; startedMicros: number; events: Rec[] }
export interface Plan { sessions: number; events: number; visits: Visit[] }

/** A repeatable choice from a list, weighted by each item's weight, so the same run makes the same traffic. */
function pick<T>(items: T[], weights: number[], seed: number): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let point = ((Math.sin(seed * 9301 + 49297) + 1) / 2) * total;
  for (let i = 0; i < items.length; i++) { point -= weights[i]; if (point <= 0) return items[i]; }
  return items[items.length - 1];
}

export function planVisits(options: { sessionsPerDay: number; nowMicros: number }): Plan {
  const pages = sampleCollection('google-analytics', 'page_traffic');
  const searches = sampleCollection('google-analytics', 'search_terms');
  const visits: Visit[] = [];
  let events = 0;
  for (let day = 0; day < DAYS; day++) {
    for (let n = 0; n < options.sessionsPerDay; n++) {
      const seed = day * 1000 + n + 1;
      const startedMicros = options.nowMicros - day * DAY_MICROS - Math.floor(((n + 1) / (options.sessionsPerDay + 1)) * (DAY_MICROS - 3_600_000_000)) - 600_000_000;
      const sessionId = Math.floor(startedMicros / 1_000_000);
      const first = pick(pages, pages.map((page) => Number(page.views)), seed);
      const second = pick(pages, pages.map((page) => Number(page.views)), seed + 7);
      const visit: Visit = { clientId: `demo.${day}.${n}`, sessionId, startedMicros, events: [] };
      const pageView = (page: Rec) => ({ name: 'page_view', params: { page_location: `https://demo.placemakers.example${page.path}`, page_title: page.title, session_id: sessionId, engagement_time_msec: 4000 + (seed % 7) * 1500 } });
      visit.events.push(pageView(first));
      if (seed % 3 !== 0) visit.events.push(pageView(second));
      if (seed % 4 === 0) {
        const term = pick(searches, searches.map((entry) => Number(entry.impressions)), seed + 13);
        visit.events.push({ name: 'view_search_results', params: { search_term: term.term, session_id: sessionId, engagement_time_msec: 2000 } });
      }
      if (seed % 11 === 0) visit.events.push({ name: 'generate_lead', params: { session_id: sessionId, engagement_time_msec: 1500, currency: 'NZD', value: 25 } });
      events += visit.events.length;
      visits.push(visit);
    }
  }
  return { sessions: visits.length, events, visits };
}

export async function sendGoogleAnalytics(options: { env: Env; deps: Deps; apply: boolean; debug?: boolean; sessions?: number; log?: (line: string) => void }): Promise<Plan & { sent: number; problems: string[] }> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  required(env, apply ? ['GA4_MEASUREMENT_ID', 'GA4_API_SECRET'] : []);
  const plan = planVisits({ sessionsPerDay: options.sessions ?? 40, nowMicros: deps.now() * 1000 });
  log(`${apply ? (options.debug ? 'Checking' : 'Sending') : 'Dry run. Would send'}: ${plan.sessions} visits (${plan.events} events) spread over the last ${DAYS} days.`);
  const result = { ...plan, sent: 0, problems: [] as string[] };
  if (!apply) return result;

  const host = env.GA4_MP_URL?.trim() || 'https://www.google-analytics.com';
  const url = `${host.replace(/\/$/, '')}${options.debug ? '/debug/mp/collect' : '/mp/collect'}`;
  const secrets = [env.GA4_API_SECRET ?? ''];
  for (const visit of plan.visits) {
    for (let i = 0; i < visit.events.length; i += PER_REQUEST) {
      const answer = await must(deps, SYSTEM, secrets, 'POST', url, {
        query: { measurement_id: env.GA4_MEASUREMENT_ID!, api_secret: env.GA4_API_SECRET! },
        body: { client_id: visit.clientId, timestamp_micros: String(visit.startedMicros), events: visit.events.slice(i, i + PER_REQUEST) },
      });
      if (options.debug) for (const message of answer.json?.validationMessages ?? []) result.problems.push(String(message.description ?? message.validationCode));
      result.sent += visit.events.slice(i, i + PER_REQUEST).length;
    }
  }
  log(`${options.debug ? 'Google checked' : 'Sent'} ${result.sent} events${result.problems.length ? `; Google found ${result.problems.length} problem(s), the first: ${result.problems[0]}` : ''}.`);
  return result;
}

async function main() {
  const flags = readFlags(process.argv.slice(2), ['sessions']);
  const result = await sendGoogleAnalytics({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, debug: flags.rest.includes('--debug'), sessions: flags.limit.sessions, log: console.log });
  if (!flags.apply) console.log('Nothing was sent. Add --apply to send (add --debug first to have Google check the events without recording them).');
  if (result.problems.length) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
