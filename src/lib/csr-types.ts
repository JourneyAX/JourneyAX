// ═══════════════════════════════════════════════════════════════════════
// CSR Journey — types
//
// Field names and enum values are taken from the real COMS orders grid
// export (COMS_Orders_Grid_Export_2026-08-13). Keeping the same shape means
// swapping mock-data.ts for a real COMS feed is a one-file change.
// ═══════════════════════════════════════════════════════════════════════

// ── COMS workflow ──────────────────────────────────────────────────────
export type ComsStage =
  | 'ORDER_PREP'
  | 'TAG_AND_PROOF'
  | 'PROOF_ONLY'
  | 'TAG_ONLY'
  | 'APPROVAL'
  | 'FINANCIAL_APPROVAL'
  | 'CONFIRMED'
  | 'MO_RELEASE'
  | 'PRODUCTION_ART'
  | 'COMPLETED'
  | 'SHIPPED';

export type ComsSubState =
  | 'READY'
  | 'IN_PROGRESS'
  | 'ACTION_REQUIRED'
  | 'WAITING_FOR_CUSTOMER'
  | 'ON_HOLD'
  | 'REVISION';

export type OrderType = 'SUBLIMATION' | 'PH_DECO' | 'PH_CUSTOM' | 'STOCKEDCAP' | 'LEAGUE_KIT';
export type OrderSubType = 'MOCK_ONLY' | 'FULL_ORDER';

export type ArtType =
  | 'Standard Builder'
  | 'Freestyle Art'
  | 'Vector Art'
  | 'Raster Art'
  | 'CDL Art'
  | 'Twill'
  | 'Embroidery';

/** Tag values observed in the COMS export. These double as the problem taxonomy. */
export const COMS_TAGS = [
  'Proof Rejected',
  'Neon Colors',
  'PMS Colors',
  'Player Names',
  'Design/Order on Behalf',
  'Reorder',
  'Redesign',
  'CS_Unresponsive',
  'CS_General',
] as const;

// ── Which system each block of data comes from ─────────────────────────
// The whole point of the copilot is that a CSR currently visits all of
// these to service one call. We label every block so the saving is visible.
export type SourceSystem = 'COMS' | 'Commerce' | 'Builder' | 'ERP' | 'Email';

export const SOURCE_LABEL: Record<SourceSystem, string> = {
  COMS: 'COMS',
  Commerce: 'Commerce',
  Builder: 'FreeStyle Builder',
  ERP: 'ERP / M3',
  Email: 'Email',
};

// ── Roster ─────────────────────────────────────────────────────────────
export interface RosterEntry {
  id: string;
  name: string;
  number: string;
  size: string;
  /** Set when this line differs from the previous order. Drives the diff view. */
  change?: 'added' | 'removed' | 'edited';

  // ── Fit signals ──────────────────────────────────────────────────────
  // All optional. COMS does not hold these today; the fit engine degrades to
  // whatever is present, so populating them later is additive.

  /** US grade 1–12. The cheapest growth predictor available. */
  gradeLevel?: number;
  /** When this size was last confirmed. Falls back to the order date. */
  sizedAt?: string;
  /** Prior confirmed sizes for this same person, oldest first. */
  sizeHistory?: { at: string; size: string; styleId?: string }[];
}

export const SIZES = ['YS', 'YM', 'YL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] as const;

// ── Customer / account ─────────────────────────────────────────────────
export interface Account {
  acctNumber: string;
  accountName: string;
  /** Dealers order on behalf of schools — this is who the CSR is usually talking to. */
  accountType: 'Dealer' | 'School' | 'Club' | 'Direct';
  salesRepName: string;
  paymentTerms: string;
  contactName?: string;
  contactEmail?: string;
  city?: string;
  state?: string;
}

// ── Product / design ───────────────────────────────────────────────────
export interface DesignProduct {
  styleId: string;
  styleName: string;
  colorway: string;
  unitPrice: number;
  /** false when the style has been retired since the previous order */
  stillAvailable: boolean;
  discontinuedNote?: string;
  suggestedReplacement?: {
    styleId: string;
    styleName: string;
    unitPrice: number;
    cut?: 'compression' | 'athletic' | 'standard' | 'relaxed';
    runs?: -1 | 0 | 1;
  };
  imageUrl?: string;

  /** How the garment is cut. Feeds the fit engine's preference signal. */
  cut?: 'compression' | 'athletic' | 'standard' | 'relaxed';
  /**
   * −1 runs small, 0 true to size, +1 runs large. Per style.
   * This is what stops a substituted style becoming a silent size change.
   */
  runs?: -1 | 0 | 1;
}

// ── Order ──────────────────────────────────────────────────────────────
export interface ComsOrder {
  comsId: number;
  /** The S number customers quote on the phone. */
  sNumber: string;
  onlineNumber?: string;
  orderNumber?: string;
  poNumber?: string;

  acctNumber: string;
  accountName: string;
  salesRepName: string;

  orderType: OrderType;
  orderSubType: OrderSubType;
  stage: ComsStage;
  subState: ComsSubState;

  artTypes: ArtType[];
  tags: string[];

  proofsRequested: number;
  proofsReady: number;
  revisionCount: number;

  hold: boolean;
  rush: boolean;

  receivedDate: string;
  requestedShipDate?: string;
  assignee?: string;

  sport: string;
  season: string;
  product: DesignProduct;
  roster: RosterEntry[];

  designTotal: number;
  unitTotal: number;

  /** Free-text history the CSR would otherwise dig out of email. */
  notes?: { at: string; who: string; text: string }[];
}

// ── Validation ─────────────────────────────────────────────────────────
export type CheckLevel = 'ok' | 'warn' | 'block';

export interface ValidationCheck {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
  /** What the CSR can do about it, if anything. */
  action?: string;
}

// ── Search ─────────────────────────────────────────────────────────────
export interface SearchHit {
  order: ComsOrder;
  /** Why this matched — shown to the CSR so results are explainable. */
  matchedOn: string;
  score: number;
}

// ── CSR journey phases ─────────────────────────────────────────────────
export type CsrPhase = 'search' | 'results' | 'order' | 'submitted';

// ── Helpers ────────────────────────────────────────────────────────────
export function formatUSD(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** COMS shows status as `STAGE | SUBSTATE`. Keep the same rendering. */
export function statusLabel(o: Pick<ComsOrder, 'stage' | 'subState'>): string {
  return `${o.stage} | ${o.subState}`;
}

export function subStateTone(s: ComsSubState): 'good' | 'warn' | 'bad' | 'neutral' {
  switch (s) {
    case 'READY':
      return 'good';
    case 'ACTION_REQUIRED':
    case 'REVISION':
      return 'bad';
    case 'WAITING_FOR_CUSTOMER':
    case 'ON_HOLD':
      return 'warn';
    default:
      return 'neutral';
  }
}

/**
 * Does this change need a new artist proof?
 *
 * This is the highest-value decision in the whole reorder flow — it decides
 * whether an artist gets pulled in. Roster-only changes should not.
 */
export function needsNewProof(opts: {
  rosterChanged: boolean;
  sizesChanged: boolean;
  colorChanged: boolean;
  artChanged: boolean;
  styleChanged: boolean;
}): { required: boolean; reason: string } {
  if (opts.artChanged) return { required: true, reason: 'Artwork changed — artist must re-proof.' };
  if (opts.colorChanged) return { required: true, reason: 'Colour changed — needs production colour approval.' };
  if (opts.styleChanged) return { required: true, reason: 'Different garment style — artwork must be remapped.' };
  if (opts.rosterChanged || opts.sizesChanged) {
    return { required: false, reason: 'Names, numbers and sizes only — approved artwork is reused.' };
  }
  return { required: false, reason: 'Exact repeat of an approved design.' };
}
