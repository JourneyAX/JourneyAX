/**
 * ChatThrottleGuard (P0-05) — cost & abuse controls for the public AI chat.
 *
 * The chat endpoints are intentionally anonymous, so a single caller (or a
 * scraper, or a runaway client) could otherwise drive unbounded LLM spend — the
 * exact quota-exhaustion failure mode we hit in testing. This guard is the first
 * line of defense in front of the expensive generation loop:
 *
 *   1. Request bounds — reject oversized/abusive payloads (message count, char
 *      length) BEFORE any model call. Cheap, deterministic, no LLM needed.
 *   2. Rate limits — per-IP and per-(tenant,session) sliding windows. Bursts and
 *      sustained floods both get a graceful 429 with Retry-After.
 *
 * All ceilings are env-tunable so ops can tighten them per environment without a
 * code change. Limits are per-node (in-memory); see rate-limiter.ts for the
 * multi-instance caveat.
 */
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { SlidingWindowLimiter } from './rate-limiter';

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Ceilings (per minute unless noted).
const WINDOW_MS = 60_000;
const PER_IP = envInt('CHAT_RATE_PER_MIN_IP', 30);
const PER_SESSION = envInt('CHAT_RATE_PER_MIN_SESSION', 15);
const MAX_MESSAGE_CHARS = envInt('CHAT_MAX_MESSAGE_CHARS', 4000);
const MAX_MESSAGES = envInt('CHAT_MAX_MESSAGES', 40);

// Module-level singletons so the windows persist across requests.
const ipLimiter = new SlidingWindowLimiter(PER_IP, WINDOW_MS);
const sessionLimiter = new SlidingWindowLimiter(PER_SESSION, WINDOW_MS);

/** Best-effort client IP: first hop of X-Forwarded-For, else socket address. */
function clientIp(req: any): string {
  const xff = (req.headers?.['x-forwarded-for'] as string | undefined) || '';
  const first = xff.split(',')[0]?.trim();
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}

@Injectable()
export class ChatThrottleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const body = req.body || {};
    const now = Date.now();

    // ── 1. Request bounds (reject before any model call) ──────────────────
    // Client-minimal contract sends { message }, but legacy { messages[] } is
    // still accepted — bound both.
    const singleLen = typeof body.message === 'string' ? body.message.length : 0;
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length > MAX_MESSAGES) {
      throw new HttpException(
        graceful(`Conversation payload too large (max ${MAX_MESSAGES} messages).`),
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const longest = Math.max(
      singleLen,
      ...messages.map((m) => (typeof m?.content === 'string' ? m.content.length : 0)),
      0,
    );
    if (longest > MAX_MESSAGE_CHARS) {
      throw new HttpException(
        graceful(`Message too long (max ${MAX_MESSAGE_CHARS} characters).`),
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    // ── 2. Rate limits (per-IP, then per-session) ─────────────────────────
    const ip = clientIp(req);
    const ipDecision = ipLimiter.hit(`ip:${ip}`, now);
    if (!ipDecision.allowed) throw tooMany(ipDecision.retryAfterMs);

    const tenantId = (req.params?.projectId || body.tenantId || 'unknown').toLowerCase();
    const sessionId = body.sessionId || `ip:${ip}`;
    const sessDecision = sessionLimiter.hit(`sess:${tenantId}:${sessionId}`, now);
    if (!sessDecision.allowed) throw tooMany(sessDecision.retryAfterMs);

    return true;
  }
}

/** A shape the storefront can render as an assistant message (graceful degrade). */
function graceful(reason: string) {
  return {
    error: 'rate_limited',
    reason,
    message: {
      role: 'assistant',
      content: `⏳ ${reason} Please slow down and try again in a moment.`,
    },
    conversation: [],
    uiActions: [],
  };
}

function tooMany(retryAfterMs: number): HttpException {
  const secs = Math.ceil(retryAfterMs / 1000) || 1;
  const ex = new HttpException(
    graceful(`You're sending messages a little too quickly.`),
    HttpStatus.TOO_MANY_REQUESTS,
  );
  // Attach Retry-After via the response header on the way out.
  (ex as any).retryAfterSecs = secs;
  return ex;
}
