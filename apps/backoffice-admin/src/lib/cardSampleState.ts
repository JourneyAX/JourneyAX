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
  accessories: { eyebrow: 'Goes with it', heading: 'Accessories & add-ons', groups: [
    { key: 'required', label: 'Required', items: PRODUCTS.slice(1, 2) },
    { key: 'recommended', label: 'Recommended', items: PRODUCTS.slice(2, 3) },
  ] },
  quantity: {
    product: PRODUCTS[0], heading: 'How many you need', quantity: 63, unitLabel: 'pieces',
    working: [{ label: 'Your area', value: '10 m²' }, { label: 'One piece covers', value: '0.16 m²' }, { label: 'To buy', value: '63 pieces' }],
    note: 'Check your own measurements before you order.', ctaLabel: 'Add 63',
  },
  review: {
    heading: 'Before you pay', intro: 'A last look at your order. Each line is from our own records.', summary: '2 of 4 checks look right, 2 are worth a look',
    quantity: { title: 'Quantities', summary: 'Check this matches your area', ok: false, warn: true, rows: [{ key: 'q1', title: '83 x Forum Paver 400 x 400 x 50mm', detail: 'Covers about 13.3 m2 (each piece covers 0.16 m2)', ok: false, warn: true, actionLabel: 'Check my quantity', actionText: 'Work out how many Forum Pavers I need', hasMessage: true, hasAdd: false }] },
    accessories: { title: 'Things you may still need', summary: 'Suggestions to check', ok: false, warn: true, rows: [{ key: 'a1', title: 'Jointing sand 20kg', detail: 'For sweeping into the joints', ok: false, warn: true, actionLabel: 'Add', actionSku: 'SAMPLE-SAND', hasMessage: false, hasAdd: true }] },
    fulfilment: { title: 'Pick-up or delivery', summary: 'All items can be collected', ok: true, warn: false, rows: [{ key: 'f1', title: 'Forum Paver 400 x 400 x 50mm', detail: 'Pick-up only. In stock at 8 of 87 branches', ok: true, warn: false, hasMessage: false, hasAdd: false }] },
    warranty: { title: 'Warranty and guides', summary: 'Guides are available', ok: true, warn: false, rows: [{ key: 'w1', title: 'Forum Paver 400 x 400 x 50mm', detail: 'No warranty details on file yet', ok: true, warn: false, actionLabel: 'Ask about the warranty', actionText: 'What warranty does the Forum Paver have?', hasMessage: true, hasAdd: false }] },
    payLabel: 'Take me to payment',
  },
  visual: { imageUrl: img('SAMPLE-VISUAL'), heading: 'How it could look', caption: 'A small patio laid with the pavers you chose.', disclaimer: 'An illustration made for you, not the exact product.', products: PRODUCTS.slice(0, 2) },
  warranty: { items: [{ title: 'Standard warranty', text: '10 years on the cabinetry, 5 years on the mechanism.' }, { title: 'Installation', text: 'DIY installation keeps the warranty intact for this product.' }] },
  fitment: { recommendation: 'We recommend size M', confidenceText: 'Based on your usual size and the brand’s size chart.', alternatives: ['S', 'L'] },
  disclosure: { title: 'Custom print terms', text: 'Custom-printed items are made to order and cannot be returned once production has started.', acceptLabel: 'I understand' },
  confirm: { confirmationId: 'cf_sample', heading: 'Please check before I go ahead', summary: 'May I add these two items to your order?', details: [{ label: 'Action', value: 'Update cart' }, { label: 'Items', value: '2 items' }], allowLabel: 'Allow', denyLabel: 'Not now', allowedText: 'You allowed this.', deniedText: 'You chose not to.', pending: true },
  form: { formId: 'contact-us', title: 'Contact us', intro: 'Tell us how we can help and we will get back to you.', fields: [{ id: 'name', label: 'Your name', type: 'text', required: true }, { id: 'email', label: 'Email', type: 'email', required: true }, { id: 'message', label: 'How can we help?', type: 'textarea', required: true }], submitLabel: 'Send', status: 'open' },
  records: { heading: 'Open deals', total: 5, shown: 2, rows: [
    { title: 'Riverside Builders Ltd', subtitle: 'Kitchen fit-out, stage two', detail: 'Closes 12 Nov · Send the quote', badge: 'Propose', tone: 'warn', amount: '$6,612', ask: 'Tell me about the Riverside Builders deal.' },
    { title: 'Harbour Joinery Ltd', subtitle: 'Deck and balustrade', detail: 'Closes 19 Nov · Book a site visit', badge: 'Qualify', amount: '$2,223' },
  ] },
  suggestions: { chips: ['Show me cheaper options', 'Compare with another brand', 'Add to my quote'] },
  working: { elapsed: 8, label: 'Building your quote', heard: 'One-piece toilet, steady drip, I’ll DIY this myself.', steps: [{ title: 'Searched the catalogue', status: 'done' }, { title: 'Checked stock', status: 'done' }, { title: 'Building your quote', status: 'running' }], lastReply: 'Here’s what I’d start with — all in stock, ready today.' },
  action_button_group: {
    heading: 'Approval Required',
    description: 'Please confirm whether you want to proceed with this operation.',
    actions: [
      { id: 'confirm_execution', label: 'Approve & Proceed', primary: true, variant: 'primary' },
      { id: 'cancel_execution', label: 'Cancel', primary: false, variant: 'secondary' },
    ],
    buttons: [
      { id: 'confirm_execution', label: 'Approve & Proceed', primary: true, variant: 'primary' },
      { id: 'cancel_execution', label: 'Cancel', primary: false, variant: 'secondary' },
    ],
  },
  order_confirmation: {
    orderId: 'ORD-SAMPLE-001',
    currency: 'USD',
    totalPriceCents: 12500,
    total: 125.00,
    status: 'Confirmed',
    committedAt: new Date().toISOString(),
    lines: QUOTE_LINES,
    totals: TOTALS,
  },
};

export function sampleStateFor(cardType: CardType): Record<string, unknown> {
  return SAMPLE_STATE[cardType] || {};
}
