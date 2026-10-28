/**
 * The care canvases' calls to the care desk, through the portal's own address (`/api/care/...`). Which tickets the person sees, and what they may do
 * with them, is the server's call; these functions only carry the request and say plainly when it did not go through.
 *
 * `FIXTURES` (NEXT_PUBLIC_CARE_FIXTURES=1) is for a preview with no server: the canvases then show a fixed list and make no calls. It is never the
 * default, so a care person is never shown tickets that are not real.
 */
import type { CareTicket, DeskKind } from './careData';

export const FIXTURES = process.env.NEXT_PUBLIC_CARE_FIXTURES === '1';

export interface CareActor { name: string; id: string; isLead: boolean }

const withProject = (path: string) => `/api/care/${path}${typeof window !== 'undefined' && window.location.search ? `?${window.location.search.slice(1)}` : ''}`;
/** The stock exceptions desk answers the same routes under `stock/`. */
const deskPath = (desk: DeskKind, path: string) => (desk === 'stock' ? `stock/${path}` : path);

/**
 * Whether the signed-in person is care staff, as the server says. Anyone else, and any failure, is "no": this only decides whether the chat
 * offers the care screens, it never gives access (every care call is checked again on the server).
 */
export async function fetchCareAccess(): Promise<boolean> {
  try {
    const res = await fetch(withProject('me'), { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body?.care === true;
  } catch { return false; }
}

/** Whether the signed-in person works the stock exceptions desk, as the server says: "no" for anyone else, for any failure, and while the desk is off. */
export async function fetchStockAccess(): Promise<boolean> {
  try {
    const res = await fetch(withProject('stock/me'), { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body?.stock === true;
  } catch { return false; }
}

export async function fetchTickets(desk: DeskKind = 'care'): Promise<{ tickets: CareTicket[]; actor?: CareActor } | { error: string }> {
  try {
    const res = await fetch(withProject(deskPath(desk, 'tickets')), { cache: 'no-store', credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: res.status === 403 ? (desk === 'stock' ? 'Branch staff only.' : 'Customer care only.') : String(body?.error || `Could not read the ${desk === 'stock' ? 'exceptions' : 'tickets'}.`) };
    return { tickets: Array.isArray(body.tickets) ? body.tickets : [], actor: body.actor };
  } catch { return { error: desk === 'stock' ? 'Could not reach the stock desk.' : 'Could not reach the care desk.' }; }
}

export async function decide(id: string, action: 'approve' | 'retry' | 'reject' | 'to-lead', body: Record<string, unknown> = {}, desk: DeskKind = 'care'): Promise<{ ok: true; ticket: CareTicket; done?: boolean } | { ok: false; error: string }> {
  try {
    const res = await fetch(withProject(deskPath(desk, `tickets/${encodeURIComponent(id)}/${action}`)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(out?.error || out?.message || 'That did not go through.') };
    return { ok: true, ticket: out.ticket, done: out.done };
  } catch { return { ok: false, error: desk === 'stock' ? 'Could not reach the stock desk.' : 'Could not reach the care desk.' }; }
}
