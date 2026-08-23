/**
 * Completed orders, persisted so staff can actually see them.
 *
 * Before this existed, `handleApprove` in JourneyContext.tsx verified the
 * price server-side via /api/quote and then minted a random order id
 * client-side and forgot it — the browser tab was the only place the order
 * ever existed. Nobody — not a CSR, not anyone — could ever see what a
 * customer had actually ordered.
 *
 * Both journeys (`/` Caroma and `/shop` apparel) write here through the same
 * shared checkout path (`handleApprove`/`QuotePanel` is one component tree
 * for both tenants — see lib/tenants.ts), so `source` is how a caller tells
 * them apart afterward.
 *
 * In-memory, same as every other store this session — lost on restart, not
 * shared across instances. Fine for a single demo process; the writable
 * JOURNEYAX_USER_STORE pattern in lib/auth/file-store.ts is the template for
 * making this durable before it represents real money.
 */

export type OrderSource = 'caroma' | 'shop';
export type OrderStatus = 'new' | 'in-review' | 'processed';

export interface OrderLine {
  key: string;
  sku?: string;
  name: string;
  price: number;
  quantity: number;
  category?: string;
}

export interface OrderRecord {
  id: string;
  source: OrderSource;
  title: string;
  jobId?: string;
  lines: OrderLine[];
  subtotal: number;
  discount: number;
  gst: number;
  total: number;
  createdAt: string;
  status: OrderStatus;
  handledBy?: string;
  handledAt?: string;
}

const orders = new Map<string, OrderRecord>();

export function recordOrder(record: Omit<OrderRecord, 'status'>): OrderRecord {
  const full: OrderRecord = { ...record, status: 'new' };
  orders.set(full.id, full);
  return full;
}

/** Newest first — the order a CSR triaging a queue wants to see them. */
export function listOrders(): OrderRecord[] {
  return [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getOrder(id: string): OrderRecord | null {
  return orders.get(id) ?? null;
}

export function setOrderStatus(id: string, status: OrderStatus, handledBy: string): OrderRecord | null {
  const existing = orders.get(id);
  if (!existing) return null;
  const updated: OrderRecord = { ...existing, status, handledBy, handledAt: new Date().toISOString() };
  orders.set(id, updated);
  return updated;
}

export function __clearOrders() {
  orders.clear();
}
