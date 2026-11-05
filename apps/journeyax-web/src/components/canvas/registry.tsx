'use client';

/**
 * Which component draws which working surface, and what each is called. Importing this file registers the three the shop always has;
 * a form, a report or a plugin's view is registered the same way (`registerCanvas` for its heading and room, an entry in `drawCanvas`
 * for its component).
 */
import type { ReactNode } from 'react';
import { registerCanvas, type CanvasRequest } from '@/lib/shell/canvasRegistry';
import CartCanvas from './CartCanvas';
import CheckoutCanvas from './CheckoutCanvas';
import OrderCanvas from './OrderCanvas';
import OperationalDeskCanvas from './desks/OperationalDeskCanvas';
import DashboardCanvas from './dashboard/DashboardCanvas';
import { getDashboardState } from '@/lib/shell/dashboardStore';
import { orderRef } from './money';

/** A working surface needs room for lines, prices and a payment form. */
export const CANVAS_MIN_WIDTH = 560;

registerCanvas({ kind: 'cart', title: () => 'Your order', minWidth: CANVAS_MIN_WIDTH });
registerCanvas({
  kind: 'checkout',
  title: () => 'Pay securely',
  minWidth: CANVAS_MIN_WIDTH,
  ready: (request) => !!request.orderId && !!request.payment,
});
registerCanvas({
  kind: 'order',
  title: (request) => `Order${request.orderId ? ` #${orderRef(request.orderId)}` : ''}`,
  minWidth: CANVAS_MIN_WIDTH,
  ready: (request) => !!request.orderId,
});

registerCanvas({ kind: 'operational-desk', title: request => request.title || 'Working surface', minWidth: CANVAS_MIN_WIDTH, ready: request => typeof request.params?.deskId === 'string' && typeof request.params?.projectId === 'string' });

/** The dashboard the corner tile opens; its name is the shop's own (what the pack calls this team's dashboard). */
registerCanvas({ kind: 'dashboard', title: (request) => getDashboardState().data?.title || request.title || 'Dashboard', minWidth: CANVAS_MIN_WIDTH });

type Draw = (request: CanvasRequest) => ReactNode;

const drawers: Record<string, Draw> = {
  'operational-desk': request => <OperationalDeskCanvas deskId={String(request.params!.deskId)} projectId={String(request.params!.projectId)} initialMode={request.params?.mode === 'board' ? 'board' : 'list'} initialRecordId={typeof request.params?.recordId === 'string' ? request.params.recordId : undefined} />,
  dashboard: () => <DashboardCanvas />,
  cart: () => <CartCanvas />,
  checkout: (request) => (request.orderId && request.payment ? <CheckoutCanvas key={request.orderId} orderId={request.orderId} payment={request.payment} /> : null),
  order: (request) => (request.orderId ? <OrderCanvas key={request.orderId} orderId={request.orderId} /> : null),
};

/** Adds the component for a surface (a plugin's or a form's). Declaring the same kind again replaces it. */
export function registerCanvasDrawer(kind: string, draw: Draw): void {
  drawers[kind] = draw;
}

/** The surface for a request, or a plain line when nothing draws that kind. */
export function drawCanvas(request: CanvasRequest): ReactNode {
  const draw = drawers[request.kind];
  return draw ? draw(request) : <p className="cv__empty-text">This view is not available here.</p>;
}
