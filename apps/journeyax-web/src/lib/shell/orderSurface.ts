import { openCanvas, type CanvasRequest } from './sidePanelStore';
import { askInChat } from './askInChat';

export function orderSurfaceFor(orderId: string, projectId: string, staff: boolean, desks: Array<{ deskId: string; title: string; recordType?: string }>): CanvasRequest | undefined {
  if (!staff) return { kind: 'order', orderId };
  const desk = desks.find(entry => entry.recordType === 'order');
  return desk ? { kind: 'operational-desk', title: desk.title, params: { deskId: desk.deskId, projectId, recordId: orderId } } : undefined;
}

/** Staff links use only the desk metadata returned for the authenticated caller. Customer receipts keep their existing owner checks. */
export async function openOrderSurface(orderId: string, projectId: string, staff: boolean): Promise<void> {
  if (!staff) { openCanvas({ kind: 'order', orderId }); return; }
  try {
    const response = await fetch(`/api/desks?project=${encodeURIComponent(projectId)}`, { credentials: 'same-origin', cache: 'no-store' });
    const body = response.ok ? await response.json() : {};
    const surface = orderSurfaceFor(orderId, projectId, true, Array.isArray(body.desks) ? body.desks : []);
    if (surface) { openCanvas(surface); return; }
  } catch { /* No private receipt fallback when a staff desk cannot be resolved. */ }
  askInChat(`Show the permitted source details for order ${orderId}.`);
}
