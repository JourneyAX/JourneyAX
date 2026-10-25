/**
 * The working surfaces that open beside the conversation (the cart, the payment form, a placed order, a form, a report, a plugin's
 * own view), declared in one place. No React here: a surface says what it is called and how much room it needs; the component that
 * draws it is registered next to the components (components/canvas/registry.tsx), so this file can be unit tested.
 *
 * A request to open one names its kind and carries what that kind needs. A kind nobody registered is not drawn (the panel says so
 * instead of showing nothing), so a plugin that is switched off cannot leave an empty panel behind.
 */
export interface CanvasRequest {
  /** Which surface: `cart`, `checkout`, `order`, `form`, `report`, or a plugin's own kind (`plugin:<id>:<name>`). */
  kind: string;
  /** The order to show (`order`), or the order being paid (`checkout`). */
  orderId?: string;
  /** What the payment form needs to open (`checkout`): Stripe's client secret and the public key. */
  payment?: { clientSecret: string; publishableKey: string };
  /** Whatever else the kind needs (a form id, a report id, a plugin's own settings). Plain data only. */
  params?: Record<string, unknown>;
  /** The heading, for a kind whose heading depends on what it shows. */
  title?: string;
}

export interface CanvasSpec {
  kind: string;
  /** The panel's heading for this request. */
  title: (request: CanvasRequest) => string;
  /** The narrowest the surface works at, in pixels: lines, prices and a payment form need room. */
  minWidth: number;
  /** Whether the request carries what the surface needs; a request that does not is not opened. */
  ready?: (request: CanvasRequest) => boolean;
}

const specs = new Map<string, CanvasSpec>();

/** Declares a surface. Declaring a kind twice replaces it, so a test or a plugin reload does not stack copies. */
export function registerCanvas(spec: CanvasSpec): void {
  specs.set(spec.kind, spec);
}

export function canvasSpec(kind: string): CanvasSpec | undefined {
  return specs.get(kind);
}

export function registeredCanvasKinds(): string[] {
  return [...specs.keys()];
}

/** The heading for a request: the surface's own, else the request's, else a plain fallback. */
export function canvasHeading(request: CanvasRequest): string {
  const spec = specs.get(request.kind);
  return (spec ? spec.title(request) : request.title) || 'Details';
}

/** The width a surface needs, or the plain panel minimum for one nobody registered. */
export function canvasMinWidth(request: CanvasRequest, fallback: number): number {
  return specs.get(request.kind)?.minWidth ?? fallback;
}

/** True when the request names a registered surface and carries what it needs. */
export function canvasCanOpen(request: CanvasRequest): boolean {
  const spec = specs.get(request.kind);
  return !!spec && (spec.ready ? spec.ready(request) : true);
}
