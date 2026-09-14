/**
 * Sample state for every card type (v3 Card CMS Cards & Theme studio,
 * docs/v3-card-cms-architecture.md) — shaped exactly like `CARD_TYPES[type].state`
 * in `@journeyax/ui-cards`, so a template previews with realistic data instead
 * of an empty shell. Images are placeholder URLs (picsum, seeded by SKU) —
 * never a real tenant's assets, since this studio previews a template's
 * LAYOUT, not a specific catalogue.
 */
import type { CardType } from '@journeyax/ui-cards';

const img = (seed: string) => `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/400`;

const PRODUCTS = [
  { sku: 'SAMPLE-001', title: 'Modern Laundry Base Kit 450', description: 'Compact base unit with integrated sink — fits tight secondary laundries.', imageUrl: img('SAMPLE-001'), price: 1847, currency: 'USD', category: 'Laundry', stockLabel: 'In stock', recommended: true, reason: 'Best fit for the space you described.', specs: { Width: '450mm', Warranty: '10 years' } },
  { sku: 'SAMPLE-002', title: 'Petite Stainless Steel Sink', description: 'Undermount sink with overflow protection.', imageUrl: img('SAMPLE-002'), price: 312, currency: 'USD', category: 'Laundry', stockLabel: 'In stock', reason: 'Companion sink for the base kit.' },
  { sku: 'SAMPLE-003', title: 'Soft-Close Drawer Runner Kit', description: 'Full-extension, 35kg capacity.', imageUrl: img('SAMPLE-003'), price: 64, currency: 'USD', category: 'Hardware', stockLabel: 'Low stock' },
];

const QUOTE_LINES = PRODUCTS.map((p, i) => ({
  ...p, qty: i === 0 ? 1 : 2, lineTotal: p.price * (i === 0 ? 1 : 2), note: p.reason,
  required: i === 0, autoAdded: i === 0, qtyLabel: `× ${i === 0 ? 1 : 2}`,
}));

const TOTALS = (() => {
  const subtotal = QUOTE_LINES.reduce((s, l) => s + l.lineTotal, 0);
  const tax = subtotal * 0.1;
  const total = subtotal + tax;
  const money = (n: number) => `$${n.toFixed(2)}`;
  return { subtotal, tax, total, currency: 'USD', taxLabel: '10% tax', subtotalLabel: money(subtotal), taxAmountLabel: money(tax), totalLabel: money(total) };
})();

export const SAMPLE_STATE: Record<CardType, Record<string, unknown>> = {
  hero: { headline: 'What are you trying to achieve today?', sub: 'Tell us your project and we’ll put together the right plan.', chips: ['Help me choose the right product', 'I have a project in mind'] },
  clarify: { questions: [
    { id: 'q1', text: 'Which best describes your project?', options: ['Renovating', 'Building new', 'Replacing fixtures'] },
    { id: 'q2', text: 'What finish are you after?', options: ['Matte black', 'Chrome', 'Brushed brass'] },
  ] },
  products: { heading: 'Recommended for you', intro: 'Based on what you told us.', products: PRODUCTS },
  productDetail: { product: { ...PRODUCTS[0], specs: { Width: '450mm', Height: '900mm', Depth: '600mm', Warranty: '10-year guarantee' } } },
  comparison: {
    products: PRODUCTS.slice(0, 2),
    dimensions: ['Price', 'Warranty', 'Stock'],
    rows: [['$1,847', '$312'], ['10 years', '5 years'], ['In stock', 'In stock']],
    verdict: 'The base kit covers more of what you need out of the box.',
  },
  bundle: { heading: 'Everything for your laundry', why: 'These work together as a set.', items: PRODUCTS, totals: TOTALS },
  quote: {
    quoteId: 'Q-SAMPLE-001', heading: 'Your Quote (3 Items)', eyebrow: 'Project Quote · Live · Job ID: Q-SAMPLE-001',
    lines: QUOTE_LINES, totals: TOTALS,
    fulfilment: { label: 'Branch fulfilment & pickup', badge: '60-min Click & Collect', options: [{ value: 'branch-a', label: 'Main Branch' }, { value: 'branch-b', label: 'North Branch' }], selected: 'branch-a', status: 'Checked — 3 of 3 items ready' },
    notes: [{ title: 'Installation', text: 'DIY-friendly — no licensed trade required for this kit.' }],
    compliance: 'Building Code Verified',
    ordering: false,
  },
  cart: { lines: QUOTE_LINES, totals: TOTALS },
  orderStatus: {
    orderId: 'ORD-SAMPLE-001', status: 'confirmed', statusText: 'Order ORD-SAMPLE-001 is confirmed.', placedAt: new Date().toISOString().slice(0, 10),
    lines: QUOTE_LINES, totals: TOTALS,
    timeline: [{ title: 'Order placed', status: 'done' }, { title: 'Preparing for pickup', status: 'running' }, { title: 'Ready for collection' }],
  },
  guide: {
    heading: 'Fixing a slow drain', safety: 'Turn off the water supply before starting any work.',
    sections: [{ title: 'Step 1 — Isolate', body: 'Shut off the isolation valve behind the fixture.', steps: ['Locate the isolation valve', 'Turn clockwise until firm', 'Confirm water flow has stopped'] }],
    products: PRODUCTS.slice(0, 1),
  },
  plan: { heading: 'Deck build — 4m × 3m', steps: [{ title: 'Vitex decking boards × 24', detail: 'Primary decking surface.', products: PRODUCTS.slice(0, 1) }, { title: 'Joist hangers × 12' }, { title: 'NZ Building code', detail: 'Check local council consent requirements before starting.' }], totals: { subtotal: 2400, total: 2400, currency: 'USD' } },
  accessories: { groups: [
    { key: 'required', label: 'Required', items: PRODUCTS.slice(1, 2) },
    { key: 'recommended', label: 'Recommended', items: PRODUCTS.slice(2, 3) },
  ] },
  warranty: { items: [{ title: 'Standard warranty', text: '10 years on the cabinetry, 5 years on the mechanism.' }, { title: 'Installation', text: 'DIY installation keeps the warranty intact for this product.' }] },
  fitment: { recommendation: 'We recommend size M', confidenceText: 'Based on your usual size and the brand’s size chart.', alternatives: ['S', 'L'] },
  disclosure: { title: 'Custom print terms', text: 'Custom-printed items are made to order and cannot be returned once production has started.', acceptLabel: 'I understand' },
  suggestions: { chips: ['Show me cheaper options', 'Compare with another brand', 'Add to my quote'] },
  working: { elapsed: 8, label: 'Building your quote', heard: 'One-piece toilet, steady drip, I’ll DIY this myself.', steps: [{ title: 'Searched the catalogue', status: 'done' }, { title: 'Checked stock', status: 'done' }, { title: 'Building your quote', status: 'running' }], lastReply: 'Here’s what I’d start with — all in stock, ready today.' },
};

export function sampleStateFor(cardType: CardType): Record<string, unknown> {
  return SAMPLE_STATE[cardType] || {};
}
