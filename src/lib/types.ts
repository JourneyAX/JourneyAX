// ── Phase machine ──────────────────────────────────────────────────────
export type Phase = 'intro' | 'clarify' | 'validating' | 'products' | 'guide' | 'quote' | 'ordered';

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

// ── Clarification questions ────────────────────────────────────────────
export interface ClarifyQuestion {
  id: keyof ClarifyAnswers;
  title: string;
  options: string[];
}

export const CLARIFY_QUESTIONS: ClarifyQuestion[] = [
  { id: 'mode', title: 'Renovating, or building new?', options: ['Renovating', 'Building new', 'Replacing fixtures'] },
  { id: 'scope', title: "What's in scope?", options: ['Just the shower', 'Shower + tapware', 'The whole bathroom'] },
  { id: 'collection', title: 'Overall style?', options: ['Minimalist', 'Soft & curved', 'No preference'] },
  { id: 'shower', title: 'Shower experience?', options: ['Rain overhead', 'Handheld on rail', 'Rail + overhead'] },
  { id: 'finishQ', title: 'Finish?', options: ['Matte Black', 'Chrome', 'Brushed Brass'] },
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
  quoteTitle?: string;
  customBom?: BOMLine[];
  qty: number;
  finish: string;
  selectedAddons: string[];   // addon IDs
  revealed: boolean;          // EasySwitch parts revealed
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
      text: "Welcome to the Caroma showroom! I'm your guided bathroom consultant — renovations, full specs, kitchen/laundry, troubleshooting, or warranty lookups. What brings you in today?",
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
  revealed: false,
  showToast: false,
  orderId: null,
  isThinking: false,
};

// ── Product data (from wireframe — real Caroma products) ───────────────
export const SHOWER_OPTIONS: Record<string, Product> = {
  'Rain overhead': {
    key: 'shower',
    name: 'Caroma 300mm Square Rain Shower',
    price: 425,
    spec: '300mm square overhead · single function',
    category: 'Showers',
  },
  'Handheld on rail': {
    key: 'shower',
    name: 'Caroma Contura® II Hand Shower',
    price: 569,
    spec: 'Multi-function hand shower on rail',
    category: 'Showers',
  },
  'Rail + overhead': {
    key: 'shower',
    name: 'Caroma Contura® II Rail Shower With Overhead',
    price: 1063,
    spec: 'Rail + 300mm overhead · with diverter',
    category: 'Showers',
  },
};

export const BASE_PARTS: Record<string, Product> = {
  showerMixer: {
    key: 'showerMixer',
    name: 'Liano II Bath/Shower Mixer',
    price: 349,
    spec: 'WELS 6★ · round cover plate',
    category: 'Tapware',
  },
  basin: {
    key: 'basin',
    name: 'Liano II Hand Wall Basin',
    price: 360,
    spec: 'Fine fire clay · thin rim · matte white',
    sku: '853010MW',
    category: 'Basins',
  },
  basinMixer: {
    key: 'basinMixer',
    name: 'Liano II Wall Basin/Bath Mixer',
    price: 329,
    spec: 'WELS 6★ · 4.5 L/min · lead-free · wall-mounted',
    category: 'Tapware',
  },
  suite: {
    key: 'suite',
    name: 'Liano Cleanflush® WF Invisi Suite',
    price: 690,
    spec: 'Rimless Cleanflush® · GermGard® · gloss white',
    sku: '766100W',
    category: 'Toilet Suites',
  },
};

export const AUTO_PARTS: Record<string, Product & { reason: string }> = {
  esShower: {
    key: 'esShower',
    name: 'EasySwitch® Bath/Shower Mixer In-Wall Body',
    price: 150,
    spec: 'Universal in-wall body · lead-free',
    sku: '99651F',
    reason: 'Required for the shower mixer',
    category: 'In-Wall',
  },
  esBasin: {
    key: 'esBasin',
    name: 'EasySwitch® Basin/Bath Mixer In-Wall Body',
    price: 150,
    spec: 'Universal in-wall body · install now, finish later',
    sku: '99635F',
    reason: 'Required for the wall basin mixer',
    category: 'In-Wall',
  },
  plate: {
    key: 'plate',
    name: 'Invisi Series II® Round Flush Plate',
    price: 130,
    spec: 'Dual-flush plate + buttons · finish-matched',
    reason: 'Finish-matched flush control for the suite',
    category: 'Sanitaryware',
  },
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
