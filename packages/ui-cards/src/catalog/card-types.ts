/**
 * Card TYPES — the vocabulary the agent speaks. Each card type has a
 * data contract (what the server puts in `state`) and, per tenant, a
 * template in Mongo that turns that state into a json-render spec.
 *
 * This is the equivalent of commerce-agents' `present_*` component list.
 * The agent picks a card type + ids + reasons; the server joins the facts.
 */
import { z } from 'zod';

export const ProductRef = z.object({
  sku: z.string(),
  reason: z.string().optional(),
  recommended: z.boolean().optional(),
  qty: z.number().int().min(1).optional(),
});

/** Enriched product as the server joins it from the catalogue. */
export const ProductFact = z.object({
  sku: z.string(),
  title: z.string(),
  description: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
  images: z.array(z.string()).optional(),
  price: z.number().nullable().optional(),
  compareAtPrice: z.number().nullable().optional(),
  currency: z.string().optional(),
  url: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  availability: z.enum(['in_stock', 'low_stock', 'out_of_stock', 'preorder', 'unknown']).optional(),
  stockLabel: z.string().optional(),
  specs: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  badges: z.array(z.string()).optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  variants: z.array(z.record(z.string(), z.unknown())).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
  recommended: z.boolean().optional(),
  qty: z.number().optional(),
  /** Set by the storefront once this SKU is in the bag/quote — the tile's Add turns into "Added". */
  inBag: z.boolean().optional(),
});
export type ProductFact = z.infer<typeof ProductFact>;

export const QuoteLine = ProductFact.extend({
  qty: z.number().int().min(1),
  lineTotal: z.number().nullable().optional(),
  note: z.string().optional(),
  required: z.boolean().optional(),
  autoAdded: z.boolean().optional(),
  branchStock: z.string().optional(),
});

export const QuoteTotals = z.object({
  subtotal: z.number(),
  discount: z.number().optional(),
  tax: z.number().optional(),
  taxLabel: z.string().optional(),
  shipping: z.number().optional(),
  total: z.number(),
  currency: z.string(),
});

/** Every card type, its state contract, and the default title. */
export const CARD_TYPES = {
  products: {
    title: 'Product recommendations',
    description: 'Three to six products with the recommended one first and a one-clause reason each.',
    state: z.object({
      heading: z.string().optional(),
      intro: z.string().optional(),
      products: z.array(ProductFact),
      layout: z.enum(['grid', 'list', 'carousel']).optional(),
      /** The tenant's closing-surface word — "bag" (retail) or "quote" (trade) — for CTA labels. */
      closing: z.string().optional(),
    }),
  },
  productDetail: {
    title: 'Product detail',
    description: 'One product with gallery, specs, availability and actions.',
    state: z.object({
      product: ProductFact,
      related: z.array(ProductFact).optional(),
      closing: z.string().optional(),
      /** Configured hand-off to the tenant's own tool (custom print, configurator). */
      handoff: z.object({ label: z.string(), url: z.string(), note: z.string().optional() }).optional(),
    }),
  },
  comparison: {
    title: 'Comparison',
    description: 'Two to four finalists compared on named dimensions.',
    state: z.object({
      products: z.array(ProductFact).min(2).max(4),
      dimensions: z.array(z.string()),
      /** Table-ready: rows[i] = [dimension, cell per product]; columns = ['', ...titles]. */
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
      columns: z.array(z.string()).optional(),
      verdict: z.string().optional(),
    }),
  },
  bundle: {
    title: 'Bundle / plan',
    description: 'A curated set of products that together achieve the goal, with a total.',
    state: z.object({
      heading: z.string().optional(),
      items: z.array(ProductFact),
      totals: QuoteTotals.optional(),
      why: z.string().optional(),
      closing: z.string().optional(),
    }),
  },
  quote: {
    title: 'Quote / bill of materials',
    description: 'Authoritative server-priced lines, totals, fulfilment and a checkout CTA.',
    state: z.object({
      quoteId: z.string().optional(),
      heading: z.string().optional(),
      lines: z.array(QuoteLine),
      totals: QuoteTotals,
      fulfilment: z.record(z.string(), z.unknown()).optional(),
      notes: z.array(z.object({ title: z.string(), text: z.string() })).optional(),
      compliance: z.string().optional(),
      /** Closing CTA label — "Checkout" (retail bag) or "Approve & pay securely" (trade quote). */
      ctaLabel: z.string().optional(),
      /** Heading over the lines — "Items" (bag) or "Bill of materials" (trade quote). */
      linesLabel: z.string().optional(),
    }),
  },
  cart: {
    title: 'Cart',
    description: 'Retail cart lines with totals and checkout.',
    state: z.object({ lines: z.array(QuoteLine), totals: QuoteTotals }),
  },
  orderStatus: {
    title: 'Order status',
    description: 'One order: status, lines, delivery / collection details.',
    state: z.object({
      orderId: z.string(),
      status: z.string(),
      placedAt: z.string().optional(),
      lines: z.array(QuoteLine),
      totals: QuoteTotals.optional(),
      fulfilment: z.record(z.string(), z.unknown()).optional(),
      timeline: z.array(z.object({ title: z.string(), detail: z.string().optional(), status: z.string().optional() })).optional(),
    }),
  },
  guide: {
    title: 'Guide',
    description: 'Sectioned how-to / install / care guidance; may reference products.',
    state: z.object({
      heading: z.string(),
      sections: z.array(z.object({ title: z.string(), body: z.string(), steps: z.array(z.string()).optional() })),
      products: z.array(ProductFact).optional(),
      safety: z.string().optional(),
    }),
  },
  plan: {
    title: 'Plan',
    description: 'Ordered steps to reach the goal (project plan, build order).',
    state: z.object({
      heading: z.string(),
      steps: z.array(z.object({ title: z.string(), detail: z.string().optional(), products: z.array(ProductFact).optional(), status: z.string().optional() })),
      totals: QuoteTotals.optional(),
    }),
  },
  clarify: {
    title: 'Clarifying questions',
    description: 'Up to three questions with tappable options.',
    state: z.object({
      questions: z.array(z.object({ id: z.string(), text: z.string(), options: z.array(z.string()), multi: z.boolean().optional(), answer: z.string().optional() })).max(3),
      /** "2 of 3 answered — …" footer; the storefront keeps it current as chips are tapped. */
      progress: z.string().optional(),
    }),
  },
  suggestions: {
    title: 'Suggestion chips',
    description: 'Up to four next-step chips; tapping sends the chip as the next message.',
    state: z.object({ chips: z.array(z.string()).max(4) }),
  },
  accessories: {
    title: 'Accessories / cross-sell',
    description: 'Companion items grouped as required / recommended / optional.',
    state: z.object({
      forSku: z.string().optional(),
      groups: z.array(z.object({ key: z.string(), label: z.string(), hint: z.string().optional(), items: z.array(ProductFact) })),
    }),
  },
  warranty: {
    title: 'Warranty & compliance',
    description: 'Warranty terms, compliance marks, documents for a product.',
    state: z.object({
      product: ProductFact.optional(),
      items: z.array(z.object({ title: z.string(), text: z.string(), url: z.string().optional() })),
    }),
  },
  fitment: {
    title: 'Fit / size recommendation',
    description: 'Recommended size or fit with the measurements it was based on.',
    state: z.object({
      product: ProductFact.optional(),
      recommendation: z.string(),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
      basis: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      alternatives: z.array(z.string()).optional(),
    }),
  },
  disclosure: {
    title: 'Disclosure',
    description: 'Policy / disclosure text the merchant requires before a step (returns, custom-print terms).',
    state: z.object({ title: z.string(), text: z.string(), acceptLabel: z.string().optional() }),
  },
  hero: {
    title: 'Intro / hero',
    description: 'Opening stage before the first turn: headline, sub-copy, starter chips.',
    state: z.object({ headline: z.string(), sub: z.string().optional(), chips: z.array(z.string()).optional(), imageUrl: z.string().optional() }),
  },
  working: {
    title: 'Working / trace',
    description: 'Progress strip: elapsed seconds, current step, trace lines, what was heard.',
    state: z.object({
      elapsed: z.number().optional(),
      label: z.string().optional(),
      heard: z.string().optional(),
      steps: z.array(z.object({ title: z.string(), detail: z.string().optional(), status: z.enum(['done', 'running', 'pending']).optional() })).optional(),
      lastReply: z.string().optional(),
    }),
  },
} as const;

export type CardType = keyof typeof CARD_TYPES;
export const CARD_TYPE_NAMES = Object.keys(CARD_TYPES) as CardType[];

/** A card instance on the stage: which template, and the data it binds to. */
export interface CardInstance {
  id: string;
  cardType: CardType;
  /** Server-joined facts; never model-authored numbers. */
  state: Record<string, unknown>;
  /** Optional template variant key (tenant may publish several per type). */
  variant?: string;
  /** Creation turn / tool call id for tracing. */
  streamId?: string;
  createdAt?: string;
}
