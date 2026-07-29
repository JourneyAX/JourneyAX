/**
 * Authoritative quote types (P0-04). A quote is SERVER-owned and versioned:
 * the agent proposes only SKUs + quantities; every monetary field here is
 * computed from the catalogue price + the project's configured tax/discount —
 * never from the LLM or the client.
 */
export interface QuoteLineInput {
  sku: string;
  quantity?: number;
  reason?: string;
  required?: boolean;
}

export interface QuoteLine {
  sku: string;
  name: string;
  unitPrice: number | null;      // authoritative catalogue price (null ⇒ price on request)
  quantity: number;
  lineTotal: number;             // unitPrice * quantity (0 when price unknown)
  sourceOfPrice: 'catalogue' | 'unavailable';
  inStock: boolean;
  category?: string;
  imageUrl?: string;
  url?: string;
  reason?: string;
  required?: boolean;
  /** Standard production window in business days (made-to-order only, C6). */
  leadTimeDays?: number;
}

export interface QuoteValidation {
  ok: boolean;
  errors: string[];              // hard problems (missing SKU, blocked item)
  warnings: string[];            // soft (price on request, out of stock)
}

export type QuoteStatus = 'draft' | 'ordered' | 'expired';

export interface Quote {
  quoteId: string;
  tenantId: string;
  sessionId?: string;
  version: number;
  title: string;
  currency: string;              // from project.pricing.currency
  symbol: string;
  lines: QuoteLine[];
  subtotal: number;
  discountRate: number;          // from project.pricing (config, not hardcoded)
  discount: number;
  taxRate: number;               // from project.pricing
  tax: number;
  total: number;
  validation: QuoteValidation;
  status: QuoteStatus;
  /**
   * Standard production window for the whole order, in business days (C6).
   * The MAX across made-to-order lines — the order is not complete until its
   * slowest item is — computed server-side from the catalogue, never quoted by
   * the model. Absent when no line carries a window (e.g. all stock).
   */
  leadTimeDays?: number;
  leadTimeSummary?: string;      // narrative only — NOT priced
  installationSummary?: string;  // narrative only — NOT priced
  warrantySummary?: string;      // narrative only — NOT priced
  createdAt: string;
  expiresAt: string;
}
