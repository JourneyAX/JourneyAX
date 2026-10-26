/**
 * Records a paid shop order in the business's own commerce system (commercetools), so the order the customer sees in the storefront is also
 * the order the business sees in its back office, under the same number.
 *
 * The shop never holds that system's keys. It asks the real connector server (the same one the assistant's connectors use) to run its
 * `place_order` tool, with the shop's key for that server. Nothing here is on unless `ORDER_MIRROR=commercetools` is set, and a failure
 * never touches the order: the customer has paid and keeps their order; the attempt and its reason are written on the order and retried
 * the next time the order is opened. Asking twice for the same order number is safe (the tool returns the order it already made).
 *
 *   ORDER_MIRROR=commercetools                        switches it on
 *   ORDER_MIRROR_URL=http://127.0.0.1:4020/mcp/commercetools   (default: the commercetools address in CONNECTOR_MCP_SERVERS)
 *   ORDER_MIRROR_KEY=...                              (default: CONNECTOR_SECRET_REAL_CONNECTORS_KEY)
 */
import type { OrderDoc } from './order.service';

export interface MirroredOrder {
  system: 'commercetools';
  /** The number the customer saw ("#A1B2C3D4"), the same one the business sees. */
  orderNumber: string;
  /** The other system's own id for the order. */
  orderId?: string;
  at: string;
}

export type MirrorResult = { ok: true; mirrored: MirroredOrder } | { ok: false; reason: string };

export interface MirrorDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** The number a customer is shown for an order: the last eight characters of its id (the storefront draws it the same way). */
export const shownOrderNumber = (orderId: string | undefined | null): string => {
  const id = String(orderId || '').replace(/^ord_/, '');
  return id ? id.slice(-8).toUpperCase() : '';
};

/** Where to send it, or null when the mirror is not switched on or not fully set up. */
export function mirrorSettings(env: Record<string, string | undefined> = process.env): { url: string; key: string } | null {
  if ((env.ORDER_MIRROR || '').trim().toLowerCase() !== 'commercetools') return null;
  let url = (env.ORDER_MIRROR_URL || '').trim();
  if (!url) {
    try { url = String(JSON.parse(env.CONNECTOR_MCP_SERVERS || '{}').commercetools || '').trim(); } catch { /* an unreadable list means no address */ }
  }
  const key = (env.ORDER_MIRROR_KEY || env.CONNECTOR_SECRET_REAL_CONNECTORS_KEY || '').trim();
  return url && key ? { url, key } : null;
}

export const mirrorIsOn = (env: Record<string, string | undefined> = process.env): boolean => mirrorSettings(env) !== null;

const text = (value: unknown, max: number): string | undefined => {
  const out = String(value ?? '').trim().slice(0, max);
  return out || undefined;
};

/** What the tool is asked: the order as the customer paid for it, prices before tax, tax at the quote's rate. */
export function placeOrderArguments(order: OrderDoc): Record<string, unknown> {
  const lines = (order.lines ?? []).map((line) => ({
    sku: line.sku,
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice ?? (line.quantity ? Number((line.lineTotal / line.quantity).toFixed(2)) : 0),
  }));
  const address = order.shipping?.address;
  return {
    orderNumber: shownOrderNumber(order.orderId),
    currency: String(order.currency || '').toUpperCase(),
    taxRate: typeof order.taxRate === 'number' ? order.taxRate : 0,
    ...(order.discount ? { discount: order.discount } : {}),
    ...(text(order.billing?.email || order.customer?.email, 320) ? { customerEmail: text(order.billing?.email || order.customer?.email, 320) } : {}),
    paid: true,
    lines,
    ...(order.shipping ? {
      shipping: {
        name: text(order.shipping.name || order.billing?.name, 120),
        line1: text(address?.line1, 120), line2: text(address?.line2, 120), city: text(address?.city, 80),
        state: text(address?.state, 80), postalCode: text(address?.postalCode, 20), country: text(address?.country, 2),
      },
    } : {}),
  };
}

/** Records a paid order. Returns null when the mirror is off, so a caller can tell "not tried" from "tried and failed". */
export async function mirrorPaidOrder(order: OrderDoc, deps: MirrorDeps = {}): Promise<MirrorResult | null> {
  const settings = mirrorSettings(deps.env ?? process.env);
  if (!settings) return null;
  if (order.status !== 'paid') return { ok: false, reason: 'The order is not paid.' };
  if (!order.lines || order.lines.length === 0) return { ok: false, reason: 'The order has no lines to record.' };
  if (!order.currency) return { ok: false, reason: 'The order has no currency.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
  try {
    const response = await (deps.fetchImpl ?? fetch)(settings.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${settings.key}`, 'x-tenant-id': order.tenantId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'place_order', arguments: placeOrderArguments(order) } }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `The connector server answered ${response.status}.` };
    const body: any = await response.json();
    if (body?.error) return { ok: false, reason: String(body.error.message || 'The connector server refused the call.').slice(0, 200) };
    const payload = JSON.parse(String(body?.result?.content?.[0]?.text ?? '{}'));
    if (body?.result?.isError || payload?.ok === false) return { ok: false, reason: String(payload?.error?.message || 'The order was not recorded.').slice(0, 200) };
    const record = payload?.record ?? {};
    const orderNumber = String(record.orderNumber || shownOrderNumber(order.orderId));
    return { ok: true, mirrored: { system: 'commercetools', orderNumber, ...(record.orderId ? { orderId: String(record.orderId) } : {}), at: (deps.now ?? (() => new Date()))().toISOString() } };
  } catch (error: any) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'The connector server did not answer in time.' : String(error?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
