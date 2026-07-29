/**
 * WhatsApp Cloud API webhook (Tier 1 — real WhatsApp via Meta).
 *
 * MULTI-TENANT: one webhook URL serves every project. Inbound messages are routed
 * to the owning tenant by the WhatsApp phone-number-id in the payload — and that
 * tenant's send token is read from its project config (project-service), NOT from
 * shared env. All WhatsApp credentials are entered per-project in the back office.
 *
 *   GET  /api/whatsapp/webhook  → Meta verification handshake
 *   POST /api/whatsapp/webhook  → inbound messages
 *     phone_number_id → project-service resolve → { tenantId, accessToken }
 *       → agent-commerce-service /chat (tenantId) → reply via that tenant's token
 *
 * Env here is only infra plumbing (never per-tenant secrets):
 *   WHATSAPP_VERIFY_TOKEN — shared handshake secret for this one webhook URL
 *   WHATSAPP_APP_SECRET   — Meta app secret; used to verify X-Hub-Signature-256
 *   PROJECT_API           — project-service base (default http://localhost:8082)
 *   AGENT_URL             — agent-commerce-service base (default http://localhost:3004)
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { alreadyProcessed, resolveSessionId } from '../wa-store';

const GRAPH = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
// P0-06: NO insecure default. If these aren't configured the webhook refuses to
// operate rather than trusting a well-known token / skipping signature checks.
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const CONFIGURED = Boolean(VERIFY_TOKEN && APP_SECRET);
const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3004';

if (!CONFIGURED) {
  // Loud, once, at module load — the operational equivalent of failing startup
  // for a serverless route: the handlers below reject until this is fixed.
  console.error(
    '[wa webhook] DISABLED — set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET. ' +
    'The webhook will reject all traffic until both are configured (no default token, no unsigned POSTs).',
  );
}

/** Verify Meta's HMAC-SHA256 body signature (P0-06) before trusting the payload. */
function verifySignature(rawBody: string, header: string | null): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', APP_SECRET).update(rawBody, 'utf8').digest('hex');
  const provided = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// ── GET: Meta webhook verification ─────────────────────────────────────
export async function GET(req: Request) {
  if (!CONFIGURED) return new Response('Webhook not configured', { status: 503 });
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ── POST: inbound messages ─────────────────────────────────────────────
export async function POST(req: Request) {
  if (!CONFIGURED) return new Response('Webhook not configured', { status: 503 });

  // Read the RAW body first — HMAC must be computed over the exact bytes Meta
  // signed, before any JSON round-trip.
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
    console.warn('[wa webhook] rejected: invalid or missing X-Hub-Signature-256');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  try {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    // The phone number that RECEIVED the message identifies the tenant.
    const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
    const messages = value?.messages;
    if (Array.isArray(messages) && phoneNumberId) {
      const tenant = await resolveTenant(phoneNumberId);
      if (!tenant) {
        console.warn(`[wa webhook] no project registered for phone_number_id=${phoneNumberId}`);
        return new Response('ok', { status: 200 });
      }
      for (const msg of messages) {
        // Persistent, cross-instance dedupe of Meta's at-least-once retries.
        if (!msg?.id || (await alreadyProcessed(msg.id))) continue;
        const from: string = msg.from;
        const text: string | undefined =
          msg.type === 'text' ? msg.text?.body
          : msg.type === 'interactive'
            ? (msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title)
            : undefined;
        if (!from || !text) continue;
        await handleInbound(tenant, phoneNumberId, from, text);
      }
    }
  } catch (e) {
    console.error('[wa webhook] error', e);
  }
  return new Response('ok', { status: 200 });
}

interface TenantWa { tenantId: string; accessToken?: string }

// Resolve the owning tenant + its send token from project-service by phone number.
async function resolveTenant(phoneNumberId: string): Promise<TenantWa | null> {
  try {
    const res = await fetch(`${PROJECT_API}/api/v1/projects/resolve/whatsapp/${encodeURIComponent(phoneNumberId)}`, { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } });
    if (!res.ok) return null;
    const r = await res.json();
    return { tenantId: r.tenantId, accessToken: r.accessToken };
  } catch {
    return null;
  }
}

// ── Core: run the tenant's agent for one message and reply ─────────────
async function handleInbound(tenant: TenantWa, phoneNumberId: string, from: string, text: string) {
  // P0-03 tail: opaque, high-entropy session id mapped per (tenant, phone) —
  // never the guessable `wa:<tenant>:<phone>`. The phone stays out of the key.
  const sessionId = await resolveSessionId(tenant.tenantId, from);
  let content = '';
  let uiActions: any[] = [];
  try {
    const res = await fetch(`${AGENT_URL}/api/v1/${tenant.tenantId}/commerce/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenant.tenantId },
      // Client-minimal contract: send only the new message + opaque sessionId;
      // the agent owns the transcript + journey state for this WhatsApp session.
      body: JSON.stringify({ message: text, tenantId: tenant.tenantId, sessionId }),
    });
    const data = await res.json();
    content = data?.message?.content || '';
    uiActions = Array.isArray(data?.uiActions) ? data.uiActions : [];
  } catch {
    content = `Sorry — I couldn't reach the assistant just now. Please try again in a moment.`;
  }

  if (content.trim()) await sendText(tenant, phoneNumberId, from, toWhatsAppText(content));

  const clarify = extractClarify(uiActions);
  if (clarify && clarify.options.length) {
    await sendList(tenant, phoneNumberId, from, 'Choose one', clarify.title, clarify.options.slice(0, 10));
  }
}

// ── Presentation adapter: agent output → WhatsApp grammar ──────────────
function toWhatsAppText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4096);
}

function extractClarify(uiActions: any[]): { title: string; options: string[] } | null {
  try {
    for (const a of uiActions) {
      let args: any = a?.arguments ?? a;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
      const q = args?.questions?.[0];
      if (q?.title && Array.isArray(q?.options) && q.options.length) {
        return { title: String(q.title).slice(0, 60), options: q.options.map((o: any) => String(o)) };
      }
    }
  } catch { /* tolerate any shape */ }
  return null;
}

// ── WhatsApp Cloud API senders (per-tenant token) ──────────────────────
async function waSend(tenant: TenantWa, phoneNumberId: string, body: any) {
  if (!tenant.accessToken) {
    console.warn(`[wa webhook] tenant ${tenant.tenantId} has no WhatsApp access token configured (set it in the Channels tab).`);
    return;
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) console.error('[wa webhook] send failed', res.status, await res.text());
}

function sendText(tenant: TenantWa, phoneNumberId: string, to: string, body: string) {
  return waSend(tenant, phoneNumberId, { to, type: 'text', text: { preview_url: false, body } });
}

function sendList(tenant: TenantWa, phoneNumberId: string, to: string, buttonLabel: string, header: string, options: string[]) {
  return waSend(tenant, phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: header.slice(0, 60) },
      body: { text: 'Tap to choose:' },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: [{ rows: options.map((o, i) => ({ id: `opt_${i}`, title: o.slice(0, 24) })) }],
      },
    },
  });
}
