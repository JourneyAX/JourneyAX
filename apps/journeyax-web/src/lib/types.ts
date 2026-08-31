// ── Phase machine ──────────────────────────────────────────────────────
export type Phase = 'intro' | 'research' | 'clarify' | 'validating' | 'products' | 'accessories' | 'choice' | 'install' | 'warranty' | 'guide' | 'quote' | 'ordered' | 'concepts' | 'configurator' | 'designEditor'
  // Coach team-order journey: four flat views approval -> roster -> per-player 3D preview.
  | 'teamDesign' | 'teamRoster' | 'teamPreview'
  // Fitment guide: a grounded size recommendation (or an honest "no chart yet").
  | 'sizeRecommendation'
  // Real-photo 3D match: upload up to 4 real photos of an actual garment, baked
  // onto the real 3D mesh (distinct from teamDesign's AI-generated views).
  | 'photoUploadDesign'
  // PlaceMakers deterministic project & materials planner (decking, fencing, wall lining, retaining).
  | 'projectPlan';

// ── PlaceMakers Project Plan & Materials Engine ────────────────────────
export interface ProjectMaterialItem {
  category: string;
  name: string;
  sku?: string;
  description: string;
  quantity: number;
  unit: string;
  estimatedUnitPriceNzd?: number;
  estimatedTotalPriceNzd?: number;
}

export interface ProjectPlan {
  projectName: string;
  projectType: 'decking' | 'fencing' | 'lining' | 'retaining' | 'cladding';
  dimensions: string;
  areaM2?: number;
  materials: ProjectMaterialItem[];
  toolsNeeded: string[];
  nzBuildingNotes: string[];
  totalEstimateNzd?: number;
  currency: string;
  branchAvailability?: {
    recommendedBranch: string;
    status: 'In Stock' | 'Order Needed';
    pickupTimeframe: string;
  };
}

export interface BranchStockItem {
  branchCode: string;
  branchName: string;
  region: string;
  address: string;
  phone: string;
  openingHours: string;
  stockQty: number;
  status: 'In Stock' | 'Low Stock' | 'Order on Request';
  clickAndCollectReady: boolean;
  collectionTimeframe: string;
  hiabDeliveryAvailable: boolean;
}

export interface BranchStockResponse {
  sku: string;
  productTitle: string;
  requestedBranch?: string;
  branches: BranchStockItem[];
}

// ── Coach team-order journey ────────────────────────────────────────────
/** The four flat 2D design views (front/back/left/right), each a concept id
 *  served by GET /api/cdl/concept/:id. A view is absent if its generation failed
 *  — never blocks the others. */
export interface TeamDesignViews {
  frontId?: string; backId?: string; leftId?: string; rightId?: string;
  /** The running, accumulated brief that produced these views — re-sent on the
   *  next edit so "make the sleeves orange" layers onto what's already there. */
  brief?: string;
  /** The confirmed style/template code this team order prices against — set
   *  once the coach picks a real style (via getProductOptions), consumed by
   *  TeamRosterPanel (skuByGarment) and the teamPreview 3D configurator. */
  sku?: string;
}
/** One roster row — mirrors RosterPanel's Row shape, kept minimal for the 3D
 *  per-player overlay (CustomDesign3D's `roster` prop only needs name+number). */
export interface RosterRow {
  name?: string;
  number?: string;
  sizes?: Record<string, string>;
}

// ── Phase B capability payloads (rendered in the 60% panel) ────────────
export interface AccessoryItem {
  name: string;
  sku?: string;
  price?: number;
  imageUrl?: string;
  category?: string;
  group: 'required' | 'recommended' | 'optional';
  reason?: string;
}
export interface ChoiceOption { id: string; label: string; description?: string }
export interface JourneyChoice { title: string; key?: string; options: ChoiceOption[]; selected?: string }

/**
 * The garment design being discussed. Held in journey state so the CONVERSATION
 * and the 3D configurator are two views of one thing: the agent can set it from
 * chat, and the panel's own controls write back to it. Whichever the customer
 * uses, the other stays in step.
 */
export interface DesignSpec {
  sku?: string;               // unlocks that product's real orderable colours
  baseColor?: string;         // catalogue colour NAME or hex
  accentColor?: string;
  name?: string;              // text on the garment
  number?: string;
  note?: string;              // one line from the agent about what is shown
  artworkUrl?: string;        // customer-supplied logo, applied to the 3D
  artworkId?: string;
  designLine?: string;        // pattern layer; without one the body renders unfilled
  textColour?: string;        // lettering fill — explicit, never derived from colour order
  outlineColour?: string;
}
/**
 * One finished garment hanging in the kit (AUG-31).
 *
 * A kit is what the customer is actually buying: a top AND a bottom AND a cap,
 * each with its own design. The rack holds these — it is not a style switcher,
 * because switching would throw away the design you just made.
 */
export interface KitItem {
  sku: string;
  garmentType?: string;          // Top / Bottom / Accessories — from the catalogue
  title?: string;
  designLine?: string;
  baseColor?: string;
  accentColor?: string;
  name?: string;
  number?: string;
  /** Catalogue photo or a rendered still, for the rack thumbnail. */
  image?: string;
}

export interface InstallGuideDoc { title: string; url: string; kind?: string }
export interface InstallGuide { productName?: string; summary?: string; guides: InstallGuideDoc[] }
export interface WarrantyInfo {
  productName?: string;
  standardWarranty?: string;
  conditions?: string;
  installationNote?: string;
  documentUrl?: string;
  extendedPackage?: { name: string; price?: number; summary?: string };
}

/** Fitment guide (v1) — the recommendSize tool's result, rendered as a small
 *  card. `ok:false` (or a missing recommendedSize) means we genuinely have no
 *  real size chart for this category yet — shown as an honest message, never
 *  a guessed size. */
export interface SizeRecommendation {
  ok: boolean;
  recommendedSize?: string;
  availableSizes?: string[];
  categoryGroup?: string | null;
  bandSource?: string;
  message: string;
}

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
  /**
   * Whether this style can actually be custom-designed (annotated server-side by
   * enforceItemDesignability). Explicit `false` means a stock garment, so the
   * card must not offer a Design button that would fail after the click.
   * `undefined` means unproven — we still offer it rather than hide a designable
   * style, since custom is the business, not stock.
   */
  designable?: boolean;
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

// ── Authoritative server quote (P0-04) ─────────────────────────────────
// The server owns all money. The client renders these figures and NEVER
// recomputes prices/totals. Mirrors agent-commerce-service Quote.
export interface ServerQuoteLine {
  sku: string;
  name: string;
  unitPrice: number | null;
  quantity: number;
  lineTotal: number;
  sourceOfPrice: 'catalogue' | 'unavailable';
  inStock: boolean;
  category?: string;
  imageUrl?: string;
  url?: string;
  reason?: string;
  required?: boolean;
}
export interface ServerQuote {
  quoteId: string;
  title: string;
  currency: string;
  symbol: string;
  lines: ServerQuoteLine[];
  subtotal: number;
  discountRate: number;
  discount: number;
  taxRate: number;
  tax: number;
  total: number;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  status: 'draft' | 'ordered' | 'expired';
  installationSummary?: string;
  warrantySummary?: string;
  leadTimeSummary?: string;      // production window narrative (C6)
  leadTimeDays?: number;
  expiresAt: string;
}

// ── School research (AUG-48) ───────────────────────────────────────────
export interface SchoolResearchColour {
  name: string;
  hex?: string;
  pantone?: string;
  role?: 'primary' | 'secondary' | 'accent';
  mappedTo?: { name: string; hex?: string };
}
export interface SchoolResearch {
  school: string;
  location?: string;
  team?: string;
  mascot?: string;
  typeface?: string;
  colours: SchoolResearchColour[];
  logo?: { description?: string; officialArtworkSource?: string; usageRestrictions?: string };
  styleWords?: string[];
  sources: { title?: string; url: string }[];
  confidence?: 'high' | 'medium' | 'low';
  notes?: string;
  cached?: boolean;
  error?: string;
}

// ── Journey state ──────────────────────────────────────────────────────
export interface JourneyState {
  phase: Phase;
  /** Garments hung in the kit, each keeping its own design (AUG-31). */
  kit: KitItem[];
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
  leadTimeSummary?: string;    // production window narrative (C6)
  serverQuote?: ServerQuote;   // authoritative quote (P0-04) — source of all money
  schoolResearch?: SchoolResearch;  // live brand research (AUG-48)
  /** The confirmed order, as the SERVER states it (P0-04). Read on return from
   *  payment, when client state has been wiped by the redirect. */
  placedOrder?: {
    orderId: string; status: string; total?: number; currency?: string; symbol?: string;
    title?: string; paidAt?: string | null; leadTimeSummary?: string;
    lines?: { sku: string; name?: string; quantity?: number; unitPrice?: number | null; lineTotal?: number; imageUrl?: string }[];
  };
  ordering?: boolean;          // order request in flight
  orderError?: string;
  // Phase B capabilities
  accessories?: AccessoryItem[];
  choice?: JourneyChoice;
  design?: DesignSpec;
  conceptId?: string;          // CDL Door A: id of the AI-generated concept image for this design
  proofId?: string;            // CDL Path A: id of the faithful "your artwork on our garment" proof
  installGuide?: InstallGuide;
  warranty?: WarrantyInfo;
  // Coach team-order journey
  teamDesign?: TeamDesignViews;
  roster?: RosterRow[];
  selectedPlayerIdx?: number;
  // Fitment guide
  sizeRecommendation?: SizeRecommendation;
  // PlaceMakers Project Plan & Branch Stock
  projectPlan?: ProjectPlan;
  branchStock?: BranchStockResponse;
}

export const INITIAL_STATE: JourneyState = {
  phase: 'intro',
  kit: [],
  messages: [
    {
      id: 'welcome',
      role: 'ai',
      // Generic default — ChatPanel swaps in the project's configured greeting
      // (persona.greetingMessage) once the storefront config loads.
      text: "Welcome! I'm your personal consultant — whether you're exploring options, fixing a problem, or just looking for inspiration, I'm here to help. What brings you in today?",
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
  // Show cents when the price actually has them ($3.99, $65.10) and only drop
  // them for whole values ($1,299). Rounding to whole dollars turned $3.99 into
  // "$4" and $65.10 into "$65" — wrong for candy and for per-unit team pricing
  // (AUG-87). Symbol stays "$"; the quote engine carries the authoritative
  // currency for anything customer-facing beyond a card.
  const whole = Number.isInteger(n);
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
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
