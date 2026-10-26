/**
 * Zendesk Support: the customer-service ticket desk. Tickets are the conversations with customers (an order that has not arrived, a quote
 * request, a warranty question); Salesforce cases are the CRM's record of the same customers' problems.
 *
 * Settings (names only here):
 *   ZENDESK_SUBDOMAIN   the part before .zendesk.com, for example placemakers-demo
 *   ZENDESK_EMAIL       the e-mail address of the agent the API token belongs to
 *   ZENDESK_API_TOKEN   Admin Center > Apps and integrations > APIs > Zendesk API > Add API token
 *   optional: ZENDESK_API_URL (override the address, for a test)
 *
 * What it can change: it can raise a ticket (create_ticket) and add an INTERNAL note to one (add_ticket_note). It never sends a public reply, so
 * nothing the assistant does is read by a customer except the ticket-received message Zendesk itself sends for a new ticket. It cannot edit,
 * close or delete anything. Both writes ask the person first (the pack says so).
 */
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, clip, compact, setting, settingsMissing } from '../http';

const SYSTEM = 'Zendesk';
const REQUIRED = ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN'];
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const EMAIL = /^[^@\s"'<>]{1,64}@[^@\s"'<>]{1,255}$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TYPES = ['question', 'incident', 'problem', 'task'];
/** Tickets the assistant raises carry this tag, so a person can find them and Zendesk rules can route them. */
const ASSISTANT_TAG = 'jx-assistant';

export function zendesk(env: Env, deps: Deps): RealConnector {
  const secrets = () => [setting(env, 'ZENDESK_API_TOKEN') ?? ''];
  const base = (): string => {
    const override = setting(env, 'ZENDESK_API_URL');
    if (override) return override.replace(/\/$/, '');
    const subdomain = setting(env, 'ZENDESK_SUBDOMAIN') ?? '';
    // The subdomain goes into an address, so it must be a plain name and nothing that could point somewhere else.
    if (!SUBDOMAIN.test(subdomain)) throw new ToolError('not_connected', 'ZENDESK_SUBDOMAIN must be only the name before .zendesk.com.');
    return `https://${subdomain}.zendesk.com`;
  };
  // Zendesk signs in with "e-mail/token:API token" as a Basic credential. It does not expire; a 401 means the token was revoked.
  const tokens = new TokenCache(deps.now);
  const credentials = async () => ({ token: Buffer.from(`${setting(env, 'ZENDESK_EMAIL')}/token:${setting(env, 'ZENDESK_API_TOKEN')}`).toString('base64'), expiresInSec: 3600 });
  const client = new VendorClient({ system: SYSTEM, deps, secrets, token: () => tokens.get(credentials), forgetToken: () => tokens.clear(), scheme: 'Basic' });
  const api = (method: string, path: string, request: { query?: Rec; body?: unknown } = {}) => client.json(method, `${base()}/api/v2${path}`, request);

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
    missing: () => settingsMissing(env, REQUIRED),
    tools,
  };
}

