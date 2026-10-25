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

type Draw = (request: CanvasRequest) => ReactNode;

const drawers: Record<string, Draw> = {
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
