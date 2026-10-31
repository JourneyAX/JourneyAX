/**
 * Zendesk Support: the customer-service ticket desk. Tickets are the conversations with customers (an order that has not arrived, a quote
 * request, a warranty question); Salesforce cases are the CRM's record of the same customers' problems.
 *
 * Settings (names only here):
 *   ZENDESK_SUBDOMAIN       the part before .zendesk.com, for example placemakers-demo
 *   and one of:
 *     ZENDESK_CLIENT_ID + ZENDESK_CLIENT_SECRET   an OAuth client (Admin Center > Apps and integrations > APIs > OAuth clients, kind Confidential): its
 *                                                 Identifier and Secret. The connector asks Zendesk for a 30-minute access token with the client
 *                                                 credentials grant, and asks again when it runs out. This is the way new accounts connect.
 *     ZENDESK_EMAIL + ZENDESK_API_TOKEN           an agent's e-mail and an API token. Zendesk has stopped giving API tokens to new accounts and
 *                                                 switches every API token off on 30 April 2027; this is kept only for accounts that still have one.
 *   optional: ZENDESK_SCOPE (default "read write"), ZENDESK_API_URL (override the address, for a test)
 *
 * What it can change: it can raise a ticket (create_ticket) and add an INTERNAL note to one (add_ticket_note). It never sends a public reply, so
 * nothing the assistant does is read by a customer except the ticket-received message Zendesk itself sends for a new ticket. It cannot edit,
 * close or delete anything. Both writes ask the person first (the pack says so).
 */
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, clip, compact, errorFor, redact, send, setting, vendorMessage } from '../http';

const SYSTEM = 'Zendesk';
const REQUIRED = ['ZENDESK_SUBDOMAIN', 'ZENDESK_CLIENT_ID', 'ZENDESK_CLIENT_SECRET'];
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const EMAIL = /^[^@\s"'<>]{1,64}@[^@\s"'<>]{1,255}$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TYPES = ['question', 'incident', 'problem', 'task'];
/** Tickets the assistant raises carry this tag, so a person can find them and Zendesk rules can route them. */
const ASSISTANT_TAG = 'jx-assistant';

/**
 * How to reach Zendesk and sign in, shared by the connector and the sample-ticket loader: the address, the secrets to keep out of messages, and
 * a current credential (an OAuth access token that is renewed, or the legacy e-mail/token pair).
 */
export function zendeskAccess(env: Env, deps: Deps) {
  const oauth = () => Boolean(setting(env, 'ZENDESK_CLIENT_ID') && setting(env, 'ZENDESK_CLIENT_SECRET'));
  const secrets = () => [setting(env, 'ZENDESK_CLIENT_SECRET') ?? '', setting(env, 'ZENDESK_API_TOKEN') ?? ''];
  const base = (): string => {
    const override = setting(env, 'ZENDESK_API_URL');
    if (override) return override.replace(/\/$/, '');
    const subdomain = setting(env, 'ZENDESK_SUBDOMAIN') ?? '';
    // The subdomain goes into an address, so it must be a plain name and nothing that could point somewhere else.
    if (!SUBDOMAIN.test(subdomain)) throw new ToolError('not_connected', 'ZENDESK_SUBDOMAIN must be only the name before .zendesk.com.');
    return `https://${subdomain}.zendesk.com`;
  };
  const tokens = new TokenCache(deps.now);
  async function fetchToken() {
    if (!oauth()) {
      // The legacy pair is itself the credential: "e-mail/token:API token", as a Basic credential. It does not expire.
      return { token: Buffer.from(`${setting(env, 'ZENDESK_EMAIL')}/token:${setting(env, 'ZENDESK_API_TOKEN')}`).toString('base64'), expiresInSec: 3600 };
    }
    const answer = await send(deps, SYSTEM, 'POST', `${base()}/oauth/tokens`, {
      body: { grant_type: 'client_credentials', client_id: setting(env, 'ZENDESK_CLIENT_ID'), client_secret: setting(env, 'ZENDESK_CLIENT_SECRET'), scope: setting(env, 'ZENDESK_SCOPE') ?? 'read write' },
    });
    if (!answer.ok || typeof answer.json?.access_token !== 'string') {
      throw errorFor(SYSTEM, answer.status === 400 || answer.status === 401 ? 401 : answer.status || 500, redact(vendorMessage(answer.json, answer.text), secrets()));
    }
    return { token: answer.json.access_token as string, expiresInSec: Number(answer.json.expires_in) || 1800 };
  }
  return { base, secrets, scheme: (): 'Bearer' | 'Basic' => (oauth() ? 'Bearer' : 'Basic'), token: () => tokens.get(fetchToken), forget: () => tokens.clear() };
}

export function zendesk(env: Env, deps: Deps): RealConnector {
  const access = zendeskAccess(env, deps);
  const client = new VendorClient({ system: SYSTEM, deps, secrets: access.secrets, token: access.token, forgetToken: access.forget, scheme: access.scheme() });
  const api = (method: string, path: string, request: { query?: Rec; body?: unknown } = {}) => client.json(method, `${access.base()}/api/v2${path}`, request);

  const peopleById = async (ids: Array<number | string | null | undefined>): Promise<Map<string, { name?: string; email?: string }>> => {
    const wanted = [...new Set(ids.filter((id): id is number | string => id !== null && id !== undefined).map(String))].slice(0, 100);
    const found = new Map<string, { name?: string; email?: string }>();
    if (!wanted.length) return found;
    const answer = await api('GET', '/users/show_many.json', { query: { ids: wanted.join(',') } });
    for (const user of Array.isArray(answer.users) ? answer.users : []) found.set(String(user.id), { name: user.name, email: user.email });
    return found;
  };

  const ticketRecord = (ticket: any, people: Map<string, { name?: string; email?: string }>): Rec => compact({
    ticketId: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    requester: people.get(String(ticket.requester_id)) ? compact({ ...people.get(String(ticket.requester_id)) }) : ticket.requester_id,
    assignee: ticket.assignee_id ? (people.get(String(ticket.assignee_id))?.name ?? ticket.assignee_id) : undefined,
    created: ticket.created_at,
    updated: ticket.updated_at,
    tags: Array.isArray(ticket.tags) && ticket.tags.length ? ticket.tags.slice(0, 10) : undefined,
    summary: ticket.description ? clip(String(ticket.description).replace(/\s+/g, ' ').trim(), 200) : undefined,
  });

  /** Words for the search box with everything that could be read as a search operator taken out. */
  const plainWords = (text: unknown): string => String(text ?? '').replace(/[^\p{L}\p{N} .@_'-]/gu, ' ').replace(/\b(?:status|priority|type|tags?|requester|assignee|created|updated|subject|description|order)\s*[:<>]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

  const tools: ToolSpec[] = [
    {
      name: 'find_tickets',
      readOnly: true,
      description: 'Find support tickets, newest first, by words in the subject or text, by status ("unsolved" is every ticket not yet solved, or new, open, pending, hold, solved), by priority, by the requester\'s e-mail address, or by a tag such as an account number (acc-0001) or an order number (opp-0001). Returns the ticket number, subject, status, priority, who asked, and when.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 100, description: 'Words to look for.' },
          status: { type: 'string', enum: ['unsolved', ...STATUSES] },
          priority: { type: 'string', enum: PRIORITIES },
          requesterEmail: { type: 'string', maxLength: 320 },
          tag: { type: 'string', maxLength: 60, pattern: TAG.source, description: 'A tag, for example acc-0001.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const parts = ['type:ticket'];
        const words = plainWords(args.query);
        if (words) parts.push(words);
        if (args.status) parts.push(args.status === 'unsolved' ? 'status<solved' : `status:${String(args.status)}`);
        if (args.priority) parts.push(`priority:${String(args.priority)}`);
        if (args.requesterEmail !== undefined) {
          if (!EMAIL.test(String(args.requesterEmail))) throw new ToolError('invalid_arguments', 'requesterEmail is not an e-mail address.');
          parts.push(`requester:${String(args.requesterEmail)}`);
        }
        if (args.tag) parts.push(`tags:${String(args.tag)}`);
        const limit = boundedInt(args.limit, 10, 1, 25);
        const answer = await api('GET', '/search.json', { query: { query: parts.join(' '), sort_by: 'created_at', sort_order: 'desc', per_page: limit } });
        const tickets: any[] = (Array.isArray(answer.results) ? answer.results : []).filter((entry: any) => entry?.result_type === undefined || entry.result_type === 'ticket').slice(0, limit);
        const people = await peopleById(tickets.map((ticket) => ticket.requester_id));
        return { total: Number(answer.count ?? tickets.length), returned: tickets.length, ...(answer.next_page ? { more: true } : {}), records: tickets.map((ticket) => ticketRecord(ticket, people)) };
      },
    },
    {
      name: 'list_recent_tickets',
      readOnly: true,
      description: 'The tickets changed most recently, latest change first, each with its first message and when it was created and last changed. This is how a new or changed ticket is noticed as it happens: unlike a search, the list is current (a search can lag by minutes). Give `since` to get only what changed after that time.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', maxLength: 40, description: 'An ISO 8601 time. Only tickets changed after it are returned.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to look at (default 25).' },
        },
      },
      async run(args) {
        let sinceMs: number | undefined;
        if (args.since !== undefined) {
          sinceMs = Date.parse(String(args.since));
          if (Number.isNaN(sinceMs)) throw new ToolError('invalid_arguments', 'since is not a time (use ISO 8601, for example 2026-10-26T09:41:00Z).');
        }
        const limit = boundedInt(args.limit, 25, 1, 50);
        const answer = await api('GET', '/tickets.json', { query: { sort_by: 'updated_at', sort_order: 'desc', per_page: limit } });
        const all: any[] = Array.isArray(answer.tickets) ? answer.tickets : [];
        const tickets = all.filter((ticket) => sinceMs === undefined || Date.parse(String(ticket.updated_at)) > sinceMs).slice(0, limit);
        const people = await peopleById(tickets.map((ticket) => ticket.requester_id));
        return {
          returned: tickets.length,
          checkedAt: new Date(deps.now()).toISOString(),
          records: tickets.map((ticket) => ({ ...ticketRecord(ticket, people), description: ticket.description ? clip(String(ticket.description).replace(/\s+/g, ' ').trim(), 1500) : undefined, via: ticket.via?.channel })),
        };
      },
    },
    {
      name: 'get_ticket',
      readOnly: true,
      description: 'One ticket by its number, with the conversation so far: who wrote each message, whether it was a public reply or an internal note, and what it said.',
      inputSchema: { type: 'object', required: ['ticketId'], properties: { ticketId: { type: 'integer', minimum: 1, maximum: 2147483647 } } },
      async run(args) {
        const id = Number(args.ticketId);
        const [ticket, comments] = await Promise.all([
          api('GET', `/tickets/${id}.json`),
          api('GET', `/tickets/${id}/comments.json`, { query: { sort_order: 'asc', per_page: 25 } }),
        ]);
        const thread: any[] = Array.isArray(comments.comments) ? comments.comments : [];
        const people = await peopleById([ticket.ticket?.requester_id, ticket.ticket?.assignee_id, ...thread.map((comment) => comment.author_id)]);
        if (!ticket.ticket) throw new ToolError('not_found', `${SYSTEM} has no ticket ${id}.`);
        return {
          record: {
            ...ticketRecord(ticket.ticket, people),
            conversation: thread.map((comment) => compact({
              from: people.get(String(comment.author_id))?.name ?? comment.author_id,
              kind: comment.public === false ? 'internal note' : 'public reply',
              at: comment.created_at,
              said: clip(String(comment.plain_body ?? comment.body ?? '').replace(/\s+/g, ' ').trim(), 700),
            })),
          },
        };
      },
    },
    {
      name: 'create_ticket',
      readOnly: false,
      description: 'Raise a new support ticket for a customer. This adds a ticket in Zendesk (and Zendesk may send the customer its "we have your request" message), so the person is asked first. The first message of the ticket is the description.',
      inputSchema: {
        type: 'object',
        required: ['subject', 'description', 'requesterEmail'],
        properties: {
          subject: { type: 'string', minLength: 3, maxLength: 150 },
          description: { type: 'string', minLength: 3, maxLength: 4000 },
          requesterEmail: { type: 'string', maxLength: 320 },
          requesterName: { type: 'string', maxLength: 100 },
          priority: { type: 'string', enum: PRIORITIES },
          type: { type: 'string', enum: TYPES },
          tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 60, pattern: TAG.source }, description: 'For example the account number (acc-0001) or the order (opp-0001).' },
        },
      },
      async run(args) {
        if (!EMAIL.test(String(args.requesterEmail))) throw new ToolError('invalid_arguments', 'requesterEmail is not an e-mail address.');
        const tags = [...new Set([ASSISTANT_TAG, ...(Array.isArray(args.tags) ? args.tags.map(String) : [])])];
        const created = await api('POST', '/tickets.json', {
          body: {
            ticket: compact({
              subject: String(args.subject),
              comment: { body: String(args.description), public: true },
              requester: compact({ email: String(args.requesterEmail), name: args.requesterName ? String(args.requesterName) : undefined }),
              priority: args.priority ? String(args.priority) : undefined, type: args.type ? String(args.type) : undefined, tags,
            }),
          },
        });
        if (!created.ticket?.id) throw new ToolError('rejected', `${SYSTEM} did not create the ticket.`);
        return { created: true, record: compact({ ticketId: created.ticket.id, subject: created.ticket.subject, status: created.ticket.status, priority: created.ticket.priority, tags: created.ticket.tags }) };
      },
    },
    {
      name: 'add_ticket_note',
      readOnly: false,
      description: 'Add an INTERNAL note to a ticket, visible to the support team and never to the customer. This changes the ticket, so the person is asked first. It cannot send a public reply.',
      inputSchema: {
        type: 'object',
        required: ['ticketId', 'note'],
        properties: { ticketId: { type: 'integer', minimum: 1, maximum: 2147483647 }, note: { type: 'string', minLength: 2, maxLength: 4000 } },
      },
      async run(args) {
        const id = Number(args.ticketId);
        const updated = await api('PUT', `/tickets/${id}.json`, { body: { ticket: { comment: { body: String(args.note), public: false } } } });
        if (!updated.ticket?.id) throw new ToolError('rejected', `${SYSTEM} did not add the note.`);
        return { updated: true, record: compact({ ticketId: updated.ticket.id, status: updated.ticket.status, subject: updated.ticket.subject }) };
      },
    },
  ];

  return {
    connectorId: 'zendesk',
    title: 'Zendesk',
    description: 'The customer-service ticket desk: support tickets and their conversations.',
    required: REQUIRED,
    missing: () => {
      const missing: string[] = [];
      if (!setting(env, 'ZENDESK_SUBDOMAIN') && !setting(env, 'ZENDESK_API_URL')) missing.push('ZENDESK_SUBDOMAIN');
      const oauth = Boolean(setting(env, 'ZENDESK_CLIENT_ID') && setting(env, 'ZENDESK_CLIENT_SECRET'));
      const legacy = Boolean(setting(env, 'ZENDESK_EMAIL') && setting(env, 'ZENDESK_API_TOKEN'));
      if (!oauth && !legacy) for (const name of ['ZENDESK_CLIENT_ID', 'ZENDESK_CLIENT_SECRET']) if (!setting(env, name)) missing.push(name);
      return missing;
    },
    tools,
  };
}

