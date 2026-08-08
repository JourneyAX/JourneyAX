/**
 * WhatsApp persistence — durable idempotency + opaque session mapping.
 *
 * This now acts as a thin proxy to the Agent Commerce Service via the API Gateway.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

/**
 * Atomic claim: returns true if this messageId was ALREADY processed.
 */
export async function alreadyProcessed(messageId: string): Promise<boolean> {
  try {
    // Dedupe does not depend on tenant context, but the gateway requires a valid
    // path structure, so we send it to a default or 'platform' route. We'll use
    // 'caroma' as the dummy projectId for routing this platform-level concern.
    const res = await fetch(`${GATEWAY_URL}/api/v1/caroma/commerce/whatsapp/dedupe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.processed;
  } catch (e: any) {
    console.error('[wa-store] dedupe error', e);
    return false;
  }
}

/**
 * Opaque, stable session id for a (tenant, phone) pair.
 */
export async function resolveSessionId(tenantId: string, phone: string): Promise<string> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${encodeURIComponent(tenantId)}/commerce/whatsapp/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) return 'wa_fallback_' + Date.now();
    const data = await res.json();
    return data.sessionId;
  } catch (e: any) {
    console.error('[wa-store] resolve session error', e);
    return 'wa_fallback_' + Date.now();
  }
}
