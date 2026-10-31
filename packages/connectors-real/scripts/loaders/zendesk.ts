/**
 * Puts sample support tickets into a Zendesk trial, so the Zendesk connector has something real to read: delivery and invoice questions about
 * the won deals' orders, tickets for the service cases, quote requests from the launch's leads, and everyday shopper questions (see tickets.ts).
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/zendesk.ts [--apply]
 *
 * It uses Zendesk's ticket import, which is made for loading history: tickets keep their real dates and whole conversations, and it sends no
 * e-mail to anyone and runs no trigger. The people are made as end users with example.test addresses. A dry run (the default) says what it
 * would do and sends nothing. Running it again changes nothing: each ticket has an external id (PM-TKT-0001...) and one that exists is left alone.
 * It uses the connector's own sign-in (ZENDESK_SUBDOMAIN with ZENDESK_CLIENT_ID and ZENDESK_CLIENT_SECRET, or the older e-mail and API token), which
 * must act as an administrator for the import.
 */
import { zendeskAccess } from '../../src/connectors/zendesk';
import { errorFor, redact, send, setting } from '../../src/http';
import { ToolError, type Deps, type Env, type Rec } from '../../src/types';
import { readFlags, sleep } from './shared';
import { plan, TODAY } from './tickets';

const SYSTEM = 'Zendesk';

export interface ZendeskLoadSummary { tickets: { created: number; existing: number }; people: number; messages: number }

export async function loadZendesk(options: { env: Env; deps: Deps; apply: boolean; log?: (line: string) => void }): Promise<ZendeskLoadSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  const tickets = plan();
  const people = new Map(tickets.map((ticket) => [ticket.requester.email, ticket.requester]));
  const summary: ZendeskLoadSummary = { tickets: { created: 0, existing: 0 }, people: 0, messages: 0 };
  const byStatus = tickets.reduce<Record<string, number>>((count, ticket) => ({ ...count, [ticket.status]: (count[ticket.status] ?? 0) + 1 }), {});
  log(`${apply ? 'Loading' : 'Dry run. Would load'}: ${tickets.length} tickets (${Object.entries(byStatus).map(([status, n]) => `${n} ${status}`).join(', ')}) from ${people.size} customers, with their conversations and dates.`);
  if (!apply) return summary;

  const access = zendeskAccess(env, deps);
  const missing = [...(!setting(env, 'ZENDESK_SUBDOMAIN') && !setting(env, 'ZENDESK_API_URL') ? ['ZENDESK_SUBDOMAIN'] : []),
    ...(setting(env, 'ZENDESK_CLIENT_ID') && setting(env, 'ZENDESK_CLIENT_SECRET') || setting(env, 'ZENDESK_EMAIL') && setting(env, 'ZENDESK_API_TOKEN') ? [] : ['ZENDESK_CLIENT_ID', 'ZENDESK_CLIENT_SECRET'])];
  if (missing.length) throw new ToolError('not_connected', `Still needed before this can run: ${missing.join(', ')}.`);
  const base = `${access.base()}/api/v2`;
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const answer = await send(deps, SYSTEM, method, `${base}${path}`, { headers: { authorization: `${access.scheme()} ${await access.token()}` }, ...(body !== undefined ? { body } : {}) });
      if (answer.ok) return answer.json ?? {};
      if (answer.status === 401 && !renewed) { renewed = true; access.forget(); continue; }
      if ((answer.status === 429 || answer.status === 503) && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
      throw errorFor(SYSTEM, answer.status, redact(`${answer.json?.description ?? answer.json?.error ?? answer.text ?? ''}`.replace(/\s+/g, ' ').slice(0, 240), access.secrets()));
    }
  };

  const me = (await call('GET', '/users/me.json')).user;
  if (!me?.id) throw new ToolError('not_authorised', `${SYSTEM} did not say who the API token belongs to.`);
  const ids = new Map<string, number>();
  for (const person of people.values()) {
    const made = await call('POST', '/users/create_or_update.json', { user: { name: person.name, email: person.email, role: 'end-user', verified: true } });
    ids.set(person.email, Number(made.user.id));
    summary.people++;
  }
  log(`Customers: ${summary.people} ready as end users.`);

  const at = (daysAgo: number, hoursAfter = 0): string => new Date(Date.parse(`${TODAY}T09:00:00Z`) - daysAgo * 86400000 + hoursAfter * 3600000).toISOString();
  for (const ticket of tickets) {
    const found = await call('GET', `/tickets.json?external_id=${encodeURIComponent(ticket.externalId)}`);
    if (Array.isArray(found.tickets) && found.tickets.length) { summary.tickets.existing++; continue; }
    const requesterId = ids.get(ticket.requester.email)!;
    const comments = [
      { author_id: requesterId, value: ticket.description, public: true, created_at: at(ticket.createdDaysAgo) },
      ...ticket.thread.map((message) => ({ author_id: message.from === 'customer' ? requesterId : me.id, value: message.body, public: message.public, created_at: at(ticket.createdDaysAgo, message.hoursAfter) })),
    ];
    const last = comments[comments.length - 1].created_at;
    await call('POST', '/imports/tickets.json', {
      ticket: {
        external_id: ticket.externalId, subject: ticket.subject, requester_id: requesterId, submitter_id: requesterId, ...(ticket.status === 'new' ? {} : { assignee_id: me.id }),
        status: ticket.status, priority: ticket.priority, type: ticket.type, tags: ticket.tags, created_at: at(ticket.createdDaysAgo), updated_at: last, ...(ticket.status === 'solved' ? { solved_at: last } : {}), comments,
      },
    });
    summary.tickets.created++;
    summary.messages += comments.length;
  }
  log(`Tickets: ${summary.tickets.created} created with ${summary.messages} messages, ${summary.tickets.existing} already there.`);
  return summary;
}

async function main() {
  const flags = readFlags(process.argv.slice(2), []);
  await loadZendesk({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, log: console.log });
  if (!flags.apply) console.log('Nothing was sent. Add --apply to load.');
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
