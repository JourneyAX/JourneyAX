/**
 * Request guard for the API routes.
 *
 * Every route previously began with a bare `await req.json()` and trusted
 * whatever came back. A missing body, an array where an object belonged, or a
 * ten-megabyte message all reached the model — or threw an unhandled error
 * that surfaced as a 500 with a stack trace.
 *
 * This module answers three questions before any handler runs: is the caller
 * over their limit, is the body a plausible size, and is it the shape we
 * expect. It is intentionally hand-rolled rather than a schema library, so it
 * adds no dependency; if validation needs grow much beyond this, reach for zod.
 */

import { rateLimit, clientKey, type RateLimitRule } from './rate-limit';

/** Largest request body we will parse. Comfortably above a long conversation. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Longest single chat message. */
export const MAX_MESSAGE_CHARS = 4_000;
/** Most messages we will accept in one conversation payload. */
export const MAX_MESSAGES = 100;

export interface GuardFailure {
  /** Ready-to-return response. Present only when the request was rejected. */
  response: Response;
}
export interface GuardSuccess<T> {
  body: T;
}
export type GuardResult<T> = GuardFailure | GuardSuccess<T>;

export function isFailure<T>(r: GuardResult<T>): r is GuardFailure {
  return 'response' in r;
}

/** Consistent error envelope, so the client never has to parse a stack trace. */
export function errorResponse(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

interface GuardOptions {
  /** Scope name, used to keep per-route limit buckets separate. */
  scope: string;
  rule: RateLimitRule;
}

/**
 * Rate-limit, size-check and JSON-parse a request.
 *
 * Returns either a parsed body or a finished Response to return immediately.
 */
export async function guard<T = unknown>(
  req: Request,
  { scope, rule }: GuardOptions,
): Promise<GuardResult<T>> {
  // Keyed by IP. The JourneyAX original prefers a session id when there is
  // one — a school or call centre shares a single public IP, so IP-keyed
  // limits punish the second person through the door. This app has no
  // sessions, so IP is the only identity available; revisit if auth lands.
  const limit = rateLimit(clientKey(req, scope), rule);
  if (!limit.ok) {
    return {
      response: Response.json(
        {
          error: {
            code: 'rate_limited',
            message: `Too many requests. Try again in ${limit.retryAfter}s.`,
          },
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(limit.retryAfter),
            'X-RateLimit-Limit': String(limit.limit),
            'X-RateLimit-Remaining': '0',
          },
        },
      ),
    };
  }

  const declared = req.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return { response: errorResponse(413, 'body_too_large', 'Request body is too large.') };
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { response: errorResponse(400, 'unreadable_body', 'Could not read the request body.') };
  }

  // Content-Length can lie or be absent (chunked encoding); check the real size.
  if (raw.length > MAX_BODY_BYTES) {
    return { response: errorResponse(413, 'body_too_large', 'Request body is too large.') };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { response: errorResponse(400, 'invalid_json', 'Request body is not valid JSON.') };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { response: errorResponse(400, 'invalid_body', 'Request body must be a JSON object.') };
  }

  return { body: parsed as T };
}

// ── Shape checks ───────────────────────────────────────────────────────
export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Validate a conversation array.
 *
 * Non-string content is coerced away rather than rejected: the chat routes
 * legitimately carry tool-call entries whose content is null, and dropping
 * them is friendlier than failing the whole turn.
 */
export function validateMessages(input: unknown): { ok: true; messages: ChatMessage[] } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, messages: [] };
  if (!Array.isArray(input)) return { ok: false, message: '`messages` must be an array.' };
  if (input.length > MAX_MESSAGES) {
    return { ok: false, message: `Conversation exceeds ${MAX_MESSAGES} messages.` };
  }

  const messages: ChatMessage[] = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, message: 'Each message must be an object.' };
    }
    const { role, content } = entry as Record<string, unknown>;
    if (typeof role !== 'string' || !role) {
      return { ok: false, message: 'Each message needs a string `role`.' };
    }
    if (typeof content === 'string' && content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, message: `A message exceeds ${MAX_MESSAGE_CHARS} characters.` };
    }
    messages.push({ ...(entry as object), role, content: typeof content === 'string' ? content : '' } as ChatMessage);
  }
  return { ok: true, messages };
}

/** Validate a single free-text command (the CSR route's input). */
export function validateCommand(input: unknown): { ok: true; command: string } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, command: '' };
  if (typeof input !== 'string') return { ok: false, message: '`command` must be a string.' };
  if (input.length > MAX_MESSAGE_CHARS) {
    return { ok: false, message: `Command exceeds ${MAX_MESSAGE_CHARS} characters.` };
  }
  return { ok: true, command: input };
}
