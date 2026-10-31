/**
 * The working surfaces beside the conversation: declared in one place, opened only when registered and complete.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/canvasRegistry.test.ts
 */
import assert from 'node:assert/strict';
import { canvasCanOpen, canvasHeading, canvasMinWidth, canvasSpec, registerCanvas, registeredCanvasKinds } from '../canvasRegistry';
import { closeCanvas, getCanvas, openCanvas } from '../sidePanelStore';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

registerCanvas({ kind: 'cart', title: () => 'Your order', minWidth: 560 });
registerCanvas({ kind: 'order', title: (r) => `Order${r.orderId ? ` #${r.orderId.slice(-4)}` : ''}`, minWidth: 560, ready: (r) => !!r.orderId });
registerCanvas({ kind: 'form', title: (r) => String(r.title || r.params?.formId || 'Form'), minWidth: 420 });

check('a registered surface names its own heading and the room it needs', () => {
  assert.deepEqual(registeredCanvasKinds().sort(), ['cart', 'form', 'order']);
  assert.equal(canvasHeading({ kind: 'cart' }), 'Your order');
  assert.equal(canvasHeading({ kind: 'order', orderId: 'ord_1234567890' }), 'Order #7890');
  assert.equal(canvasHeading({ kind: 'form', title: 'Contact us' }), 'Contact us');
  assert.equal(canvasMinWidth({ kind: 'form' }, 560), 420);
  assert.equal(canvasMinWidth({ kind: 'nobody' }, 560), 560, 'a kind nobody registered gets the plain minimum');
  assert.equal(canvasHeading({ kind: 'nobody', title: 'Plugin view' }), 'Plugin view');
  assert.equal(canvasHeading({ kind: 'nobody' }), 'Details');
});

check('a request opens only when its surface is registered and it carries what the surface needs', () => {
  assert.equal(canvasCanOpen({ kind: 'cart' }), true);
  assert.equal(canvasCanOpen({ kind: 'order' }), false, 'an order canvas without an order');
  assert.equal(canvasCanOpen({ kind: 'order', orderId: 'ord_1' }), true);
  assert.equal(canvasCanOpen({ kind: 'nobody' }), false);
});

check('the panel store refuses a request that cannot open, so no empty panel is left behind', () => {
  closeCanvas();
  openCanvas({ kind: 'nobody' });
  assert.equal(getCanvas(), null);
  openCanvas({ kind: 'order' });
  assert.equal(getCanvas(), null);
  openCanvas({ kind: 'form', params: { formId: 'contact' }, title: 'Contact us' });
  assert.equal(getCanvas()?.kind, 'form');
  assert.equal(getCanvas()?.params?.formId, 'contact');
  closeCanvas();
  assert.equal(getCanvas(), null);
});

check('declaring a kind twice replaces it: a reloaded plugin does not stack copies', () => {
  registerCanvas({ kind: 'form', title: () => 'Replaced', minWidth: 500 });
  assert.equal(canvasHeading({ kind: 'form' }), 'Replaced');
  assert.equal(registeredCanvasKinds().filter((kind) => kind === 'form').length, 1);
  assert.equal(canvasSpec('form')?.minWidth, 500);
});

console.log(`✅ web: canvas registry: ${passed} passed, 0 failed`);
