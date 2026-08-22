import type { BodyEstimate, GarmentSpec, ZoneFit } from './advisor-types';
import type { BagLine, ReturnCase, TryOnView } from './shop-types';
import { EMPTY_RETURN } from './shop-types';
import type { LanguageCode } from './i18n';

// ── Phase machine ──────────────────────────────────────────────────────
// 'tryon', 'bag' and 'returns' are apparel-only, the same way 'guide' is
// bathroom-only. One phase machine serves both journeys because the shell
// is the same; the tenant decides which phases can actually be reached.
export type Phase =
  | 'intro' | 'clarify' | 'validating' | 'products' | 'fit'
  | 'tryon' | 'bag' | 'returns'
  | 'guide' | 'quote' | 'ordered';

// ── Clarification answers ──────────────────────────────────────────────
export interface ClarifyAnswers {
  mode: string | null;       // "Renovating" | "Building new" | "Replacing fixtures"
  scope: string | null;      // "Just the shower" | "Shower + tapware" | "The whole bathroom"
  collection: string | null; // "Minimalist" | "Soft & curved" | "No preference"
  shower: string | null;     // "Rain overhead" | "Handheld on rail" | "Rail + overhead"
  finishQ: string | null;    // "Matte Black" | "Chrome" | "Brushed Brass"
}

// ── Troubleshooting Guide ──────────────────────────────────────────────
export interface GuideStep {
  id: string;
  title: string;
  description: string;
  completed?: boolean;
}

// ── Product / BOM types ────────────────────────────────────────────────
export interface Product {
  key: string;
  name: string;
  price: number;
  spec: string;
  sku?: string;
  imageUrl?: string;
  category?: string;
  collection?: string;
  url?: string;
}

export interface BOMLine extends Product {
  required: boolean;        // auto-added by CPQ
  reason?: string;          // why it was auto-added
  quantity: number;
  lineTotal: number;
  stock: StockInfo;
  info?: string;
}

export interface StockInfo {
  label: string;
  color: string;            // CSS color for the dot
}

// ── Recommended product (shown during product discovery phase) ─────────
export interface Accessory {
  name: string;
  sku?: string;
  price?: number;
  required?: boolean;
}

export interface RecommendedProduct {
  name: string;
  sku?: string;
  price?: number;
  imageUrl?: string;
  category?: string;
  collection?: string;
  description: string;      // Why this product is recommended
  features?: string[];      // Key features/benefits
  finishes?: string[];
  specs?: Record<string, string>;  // Technical specs
  url?: string;             // Product page URL
  accessories?: Accessory[]; // Optional accessories
  installationParts?: Accessory[]; // Mandatory/recommended installation parts
}

export interface Addon {
  id: string;
  name: string;
  desc: string;
  price: number;
}

// ── Finish ─────────────────────────────────────────────────────────────
export interface Finish {
  name: string;
  suffix: string;           // SKU suffix (B, C, BB, BN, GM, BBZ)
  hex: string;              // CSS color/gradient for swatch
}

export const FINISHES: Finish[] = [
  { name: 'Matte Black', suffix: 'B', hex: '#1A1A1A' },
  { name: 'Chrome', suffix: 'C', hex: 'linear-gradient(135deg,#EDEDED,#B9BEC2)' },
  { name: 'Brushed Brass', suffix: 'BB', hex: 'linear-gradient(135deg,#D8B57E,#A67C4E)' },
  { name: 'Brushed Nickel', suffix: 'BN', hex: 'linear-gradient(135deg,#E2E0DA,#A9A6A0)' },
  { name: 'Gunmetal', suffix: 'GM', hex: 'linear-gradient(135deg,#6E6A66,#332F2B)' },
  { name: 'Brushed Bronze', suffix: 'BBZ', hex: 'linear-gradient(135deg,#C9A07A,#7C5A3E)' },
];

// ── Addons ─────────────────────────────────────────────────────────────
export const DEFAULT_ADDONS: Addon[] = [
  { id: 'ring', name: 'Liano II Basin Dress Ring', desc: 'Finish-matched trim ring for the wall basin.', price: 65 },
  { id: 'rail', name: 'Liano Heated Towel Rail', desc: 'Matched towel rail in your chosen finish.', price: 399 },
  { id: 'warranty', name: 'Caroma Care — 20-year warranty', desc: 'Extended cover across the full BOM.', price: 40 },
];

// ── Dynamic questions (AI-driven) ─────────────────────────────────────
export interface DynamicQuestion {
  id: string;
  title: string;
  options: string[];
}

// ── Message types ──────────────────────────────────────────────────────
export type MessageRole = 'ai' | 'user' | 'note';

export interface JourneyMessage {
  id: string;
  role: MessageRole;
  text: string;
  head?: string;             // note heading (e.g., "EasySwitch added.")
}

// ── Quote totals ───────────────────────────────────────────────────────
export interface QuoteTotals {
  subtotal: number;
  discount: number;
  gst: number;
  total: number;
}

// ── Journey state ──────────────────────────────────────────────────────
export interface JourneyState {
  phase: Phase;
  messages: JourneyMessage[];
  clarify: ClarifyAnswers;
  dynamicQuestions: DynamicQuestion[];
  dynamicAnswers: Record<string, string>;
  recommendedProducts: RecommendedProduct[];
  guideSteps: GuideStep[];
  /**
   * The garment the Fit Advisor is currently running against. Set by the
   * model calling showFitAdvisor; null whenever the advisor is not open.
   */
  fitGarment: GarmentSpec | null;
  /**
   * The size the shopper accepted from the advisor, kept for the quote — and
   * the body/zone detail behind it, which is what lets try-on draw this
   * shopper rather than a generic mannequin.
   */
  fitChoice: {
    size: string;
    summary: string;
    body?: BodyEstimate;
    zones?: ZoneFit[];
  } | null;
  /**
   * The bag. Accumulates across the whole session — unlike customBom, which
   * the model replaces wholesale on every updateQuote. A shopping journey
   * that forgets what you already picked is not one journey; it is several.
   */
  bag: BagLine[];
  /** What try-on is currently visualising, or null when it is closed. */
  tryOn: TryOnView | null;
  /** The in-progress return, if any. */
  returnCase: ReturnCase;
  /**
   * Language for the panels. Lives here rather than in a route so that
   * switching it mid-journey changes the chrome without resetting the bag,
   * the sizes or the conversation.
   */
  language: LanguageCode;
  quoteTitle?: string;
  customBom?: BOMLine[];
  qty: number;
  finish: string;
  selectedAddons: string[];   // addon IDs
  showToast: boolean;
  orderId: string | null;
  isThinking: boolean;
  jobId?: string;
  installationSummary?: string;
  warrantySummary?: string;
}

export const INITIAL_STATE: JourneyState = {
  phase: 'intro',
  messages: [
    {
      id: 'welcome',
      role: 'ai',
      text: "Welcome to the Caroma showroom! I'm your personal consultant — whether you're renovating, fixing a problem, or just looking for inspiration, I'm here to help. What brings you in today?",
    },
  ],
  clarify: { mode: null, scope: null, collection: null, shower: null, finishQ: null },
  dynamicQuestions: [],
  dynamicAnswers: {},
  recommendedProducts: [],
  guideSteps: [],
  qty: 1,
  finish: 'Matte Black',
  selectedAddons: [],
  showToast: false,
  orderId: null,
  isThinking: false,
  fitGarment: null,
  fitChoice: null,
  bag: [],
  tryOn: null,
  returnCase: EMPTY_RETURN,
  language: 'en',
};

// ── Helpers ────────────────────────────────────────────────────────────
export function formatAUD(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n) || n === 0) return 'Price on request';
  return '$' + Math.round(n).toLocaleString('en-AU');
}

export function getStockInfo(key: string, finishName: string): StockInfo {
  const fixedStock = ['basin', 'suite', 'esShower', 'esBasin'];
  if (fixedStock.includes(key)) {
    return { label: 'In stock · NSW DC', color: '#4E7C59' };
  }
  const madeToOrder = ['Brushed Brass', 'Brushed Bronze', 'Gunmetal', 'Brushed Nickel'];
  if (madeToOrder.includes(finishName)) {
    return { label: 'PVD · made to order 3–4 wks', color: '#B58A3C' };
  }
  return { label: 'In stock · NSW DC', color: '#4E7C59' };
}
