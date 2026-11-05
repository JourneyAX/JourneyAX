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
 * Writes are explicit commands: ticket creation, internal notes, public replies and supported ticket updates. The shared harness must hold
 * customer-visible or operational changes for exact approval and retain the actual vendor receipt. Replies and updates use Zendesk's
 * safe_update/updated_stamp contract so a stale approved draft cannot overwrite a newer ticket.
 */
import { createHash } from 'node:crypto';
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
  const api = (method: string, path: string, request: { query?: Rec; body?: unknown; headers?: Record<string, string> } = {}) => client.json(method, `${access.base()}/api/v2${path}`, request);

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
    externalId: ticket.external_id,
    organizationId: ticket.organization_id,
    customFields: Array.isArray(ticket.custom_fields) ? ticket.custom_fields : undefined,
    tags: Array.isArray(ticket.tags) && ticket.tags.length ? ticket.tags : undefined,
    summary: ticket.description ? clip(String(ticket.description).replace(/\s+/g, ' ').trim(), 200) : undefined,
  });

  /** Words for the search box with everything that could be read as a search operator taken out. */
  const plainWords = (text: unknown): string => String(text ?? '').replace(/[^\p{L}\p{N} .@_'-]/gu, ' ').replace(/\b(?:status|priority|type|tags?|requester|assignee|created|updated|subject|description|order)\s*[:<>]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

  const tools: ToolSpec[] = [
    {
      name: 'find_tickets',
      readOnly: true,
      staffOnly: true,
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
      name: 'count_tickets', readOnly: true, staffOnly: true,
      description: 'Read the source-reported number of support tickets, optionally by status. Unsolved includes new, open, pending and hold. This is a search-index count, not the size of a returned ticket page.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['unsolved', ...STATUSES] } }, additionalProperties: false },
      async run(args) {
        if (args.status !== undefined && !['unsolved', ...STATUSES].includes(args.status)) throw new ToolError('invalid_arguments', 'Unsupported ticket status.');
        const query = ['type:ticket', ...(args.status ? [args.status === 'unsolved' ? 'status<solved' : `status:${args.status}`] : [])].join(' ');
        // https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/#show-results-count
        const answer = await api('GET', '/search/count', { query: { query } });
        if (!Number.isSafeInteger(answer.count) || answer.count < 0) throw new ToolError('not_recorded', 'The support source did not return a valid count.');
        return { record: { count: answer.count, checkedAt: new Date(deps.now()).toISOString() }, sourceKind: 'search_index' };
      },
    },
    {
      name: 'list_recent_tickets',
      readOnly: true,
      staffOnly: true,
      description: 'Read a current page of tickets, including existing backlog and follow-ups. Defaults to newest change first; oldest_first supports backlog work. Follow nextCursor while more is true. Give since to return changes after a saved checkpoint. This is a page, never a whole-backlog count.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', maxLength: 40, description: 'An ISO 8601 time. Only tickets changed after it are returned.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to look at (default 25).' },
          afterCursor: { type: 'string', minLength: 1, maxLength: 1000 },
          order: { type: 'string', enum: ['newest_first', 'oldest_first'] },
        },
      },
      async run(args) {
        let sinceMs: number | undefined;
        if (args.since !== undefined) {
          sinceMs = Date.parse(String(args.since));
          if (Number.isNaN(sinceMs)) throw new ToolError('invalid_arguments', 'since is not a time (use ISO 8601, for example 2026-10-26T09:41:00Z).');
        }
        const limit = boundedInt(args.limit, 25, 1, 50);
        if (args.afterCursor !== undefined && (typeof args.afterCursor !== 'string' || !args.afterCursor || args.afterCursor.length > 1000 || /[\u0000-\u001f\u007f]/.test(args.afterCursor))) throw new ToolError('invalid_arguments', 'The ticket page cursor is invalid.');
        if (args.order !== undefined && !['newest_first', 'oldest_first'].includes(args.order)) throw new ToolError('invalid_arguments', 'The ticket sort order is invalid.');
        // Zendesk cursor pagination uses `sort`, not the offset-only sort_by/sort_order parameters.
        // https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#list-tickets
        const answer = await api('GET', '/tickets.json', { query: { sort: args.order === 'oldest_first' ? 'updated_at' : '-updated_at', 'page[size]': limit, ...(args.afterCursor ? { 'page[after]': args.afterCursor } : {}) } });
        const all: any[] = Array.isArray(answer.tickets) ? answer.tickets : [];
        const tickets = all.filter((ticket) => sinceMs === undefined || Date.parse(String(ticket.updated_at)) > sinceMs).slice(0, limit);
        const more = answer.meta?.has_more === true;
        const nextCursor = answer.meta?.after_cursor;
        if (more && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 1000)) throw new ToolError('source_contract', 'The ticket source indicates another page without a usable cursor.');
        const people = await peopleById(tickets.map((ticket) => ticket.requester_id));
        return {
          returned: tickets.length,
          more, ...(more ? { nextCursor } : {}),
          checkedAt: new Date(deps.now()).toISOString(),
          records: tickets.map((ticket) => ({ ...ticketRecord(ticket, people), description: ticket.description ? clip(String(ticket.description).replace(/\s+/g, ' ').trim(), 1500) : undefined, via: ticket.via?.channel })),
        };
      },
    },
    ...[false, true].map((publicOnly): ToolSpec => ({
      name: publicOnly ? 'get_customer_ticket' : 'get_ticket', readOnly: true, staffOnly: !publicOnly,
      ...(publicOnly ? { shopperIdentityFields: ['requesterEmail'] } : {}),
      description: publicOnly ? 'Read a ticket owned by the verified requester, with public comments only. Paged; use nextCursor for remaining comments.' : 'Read a ticket and a page of its full public/internal conversation. Use nextCursor for remaining comments; never claim a truncated page is the whole thread.',
      inputSchema: { type: 'object', required: ['ticketId', ...(publicOnly ? ['requesterEmail'] : [])], properties: {
        ticketId: { type: 'integer', minimum: 1, maximum: 2147483647 },
        ...(publicOnly ? { requesterEmail: { type: 'string', maxLength: 320 } } : {}),
        afterCursor: { type: 'string', minLength: 1, maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      } },
      async run(args) {
        const id = Number(args.ticketId);
        const ticket = await api('GET', `/tickets/${id}.json`);
        if (!ticket.ticket) throw new ToolError('not_found', 'Ticket is unavailable.');
        const requester = await peopleById([ticket.ticket.requester_id]);
        const requesterEmail = requester.get(String(ticket.ticket.requester_id))?.email;
        if (publicOnly && (!EMAIL.test(String(args.requesterEmail)) || typeof requesterEmail !== 'string' || requesterEmail.toLowerCase() !== String(args.requesterEmail).toLowerCase())) throw new ToolError('not_found', 'Ticket is unavailable.');
        const comments = await api('GET', `/tickets/${id}/comments.json`, { query: { sort_order: 'asc', 'page[size]': boundedInt(args.limit, 25, 1, 100), ...(args.afterCursor ? { 'page[after]': String(args.afterCursor) } : {}) } });
        const thread: any[] = (Array.isArray(comments.comments) ? comments.comments : []).filter((comment: any) => !publicOnly || comment.public === true);
        const people = await peopleById([ticket.ticket.requester_id, ...(publicOnly ? [] : [ticket.ticket.assignee_id]), ...thread.map(comment => comment.author_id)]);
        const more = comments.meta?.has_more === true || Boolean(comments.next_page);
        const nextCursor = typeof comments.meta?.after_cursor === 'string' ? comments.meta.after_cursor : undefined;
        const conversation = thread.map(comment => ({ commentId: comment.id, from: people.get(String(comment.author_id))?.name ?? 'Support', kind: comment.public === true ? 'public reply' : 'internal note', at: comment.created_at, said: String(comment.plain_body ?? comment.body ?? '') }));
        return { more, ...(nextCursor && more ? { nextCursor } : {}), record: {
          ...(publicOnly ? compact({ ticketId: ticket.ticket.id, subject: ticket.ticket.subject, status: ticket.ticket.status, created: ticket.ticket.created_at, updated: ticket.ticket.updated_at }) : ticketRecord(ticket.ticket, people)),
          conversation, more, ...(nextCursor && more ? { nextCursor } : {}),
        } };
      },
    })),
    {
      name: 'create_ticket',
      readOnly: false,
      shopperIdentityFields: ['requesterEmail'],
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
      async run(args, execution) {
        if (!execution?.actionId || !execution.tenantId || !execution.environmentId || !execution.principalId) throw new ToolError('not_authorised', 'Creating a support request requires a verified scoped action identity.');
        if (!EMAIL.test(String(args.requesterEmail))) throw new ToolError('invalid_arguments', 'requesterEmail is not an e-mail address.');
        const tags = [...new Set([ASSISTANT_TAG, ...(Array.isArray(args.tags) ? args.tags.map(String) : [])])];
        // Zendesk caches ticket-creation keys for two hours. Durable action receipts
        // remain authoritative after that window; an uncertain old action is never
        // retried merely because this vendor cache may have expired.
        const idempotencyKey = createHash('sha256').update(JSON.stringify([execution.tenantId, execution.environmentId, execution.principalId, execution.actionId])).digest('hex');
        const created = await api('POST', '/tickets.json', {
          headers: { 'Idempotency-Key': idempotencyKey },
          body: {
            ticket: compact({
              subject: String(args.subject),
              comment: { body: String(args.description), public: true },
              // Zendesk needs a name when this email has no requester yet. Use
              // the supplied email as its label rather than inventing a person.
              // Existing matching users are not updated during ticket creation:
              // https://developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets/
              requester: { email: String(args.requesterEmail), name: args.requesterName ? String(args.requesterName) : String(args.requesterEmail) },
              priority: args.priority ? String(args.priority) : undefined, type: args.type ? String(args.type) : undefined, tags,
            }),
          },
        });
        if (!created.ticket?.id) throw new ToolError('rejected', `${SYSTEM} did not create the ticket.`);
        return { created: true, record: compact({ ticketId: created.ticket.id, subject: created.ticket.subject, status: created.ticket.status, priority: created.ticket.priority, tags: created.ticket.tags }) };
      },
    },
    ...[true, false].map((publicReply): ToolSpec => ({
      name: publicReply ? 'reply_to_ticket' : 'update_ticket', readOnly: false, staffOnly: true,
      description: publicReply ? 'Send the exact approved public reply to a ticket, optionally changing its status. Requires the last observed updated timestamp and returns a vendor audit receipt. May notify the requester; ask first.' : 'Apply an approved ticket status, priority, assignment or internal note. Requires the last observed updated timestamp. Never sends a public reply. Returns a vendor audit receipt; ask first.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['ticketId', 'updatedStamp', ...(publicReply ? ['body'] : [])], properties: {
        ticketId: { type: 'integer', minimum: 1, maximum: 2147483647 },
        updatedStamp: { type: 'string', minLength: 20, maxLength: 40, description: 'Exact updated value returned by the ticket read.' },
        status: { type: 'string', enum: ['open', 'pending', 'hold', 'solved'] },
        ...(publicReply ? { body: { type: 'string', minLength: 1, maxLength: 10000 } } : {
          priority: { type: 'string', enum: PRIORITIES },
          assigneeId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          groupId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          note: { type: 'string', minLength: 1, maxLength: 10000 },
        }),
      } },
      async run(args) {
        if (!Number.isFinite(Date.parse(String(args.updatedStamp))) || !/^\d{4}-\d{2}-\d{2}T/.test(String(args.updatedStamp))) throw new ToolError('invalid_arguments', 'A valid last-observed ticket timestamp is required.');
        if (!publicReply && !['status', 'priority', 'assigneeId', 'groupId', 'note'].some(key => args[key] !== undefined)) throw new ToolError('invalid_arguments', 'No ticket change was requested.');
        const id = Number(args.ticketId);
        const ticket = compact({ safe_update: true, updated_stamp: String(args.updatedStamp), status: args.status,
          ...(publicReply ? { comment: { body: String(args.body), public: true } } : { priority: args.priority, assignee_id: args.assigneeId, group_id: args.groupId, ...(args.note ? { comment: { body: String(args.note), public: false } } : {}) }),
        });
        const result = await api('PUT', `/tickets/${id}.json`, { body: { ticket } });
        if (result.ticket?.id !== id || !result.audit?.id) throw new ToolError('receipt_unavailable', 'The ticket update has no verifiable audit receipt. Its outcome must be reconciled before any retry.');
        const comment = Array.isArray(result.audit.events) ? result.audit.events.find((event: any) => event.type === 'Comment' && event.public === publicReply) : undefined;
        if ((publicReply || args.note) && !comment?.id) throw new ToolError('receipt_unavailable', 'The ticket response did not confirm the expected comment. Reconcile the outcome before retrying.');
        return { updated: true, publicReply, record: compact({ ticketId: result.ticket.id, status: result.ticket.status, updated: result.ticket.updated_at }), receipt: compact({ auditId: result.audit.id, commentId: comment?.id, createdAt: result.audit.created_at }) };
      },
    })),
    {
      name: 'add_ticket_note',
      readOnly: false, staffOnly: true,
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

