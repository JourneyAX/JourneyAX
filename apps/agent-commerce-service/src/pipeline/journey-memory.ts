/**
 * Journey working memory (server-owned).
 *
 * Fixes the accessory loop and makes the agent remember what it already did —
 * per the context/memory quality review. The server, not the browser, owns:
 *   - the conversation transcript (messages[])
 *   - a typed JourneyState with a CAPABILITY LEDGER (what's completed/skipped)
 *   - idempotency fingerprints of what was already presented
 *
 * The client now sends only { sessionId } + its new message; everything else is
 * reconstructed here. A reducer folds each turn's UI actions into the state
 * BEFORE it is persisted, so the next turn knows the truth (the old code saved
 * the pre-action client state, which is the structural cause of the loop).
 */

export type LedgerStatus = 'pending' | 'active' | 'completed' | 'skipped';

/** One capability's progress through the journey. */
export interface CapabilityLedger {
  discovery: LedgerStatus;
  recommendation: LedgerStatus;
  accessories: LedgerStatus;
  installationGuide: LedgerStatus;
  warranty: LedgerStatus;
  choice: LedgerStatus;
  quote: LedgerStatus;
  configurator: LedgerStatus;
}

export interface JourneySelectionItem {
  sku?: string;
  name?: string;
  status: 'presented' | 'accepted' | 'rejected';
}

export interface JourneyState {
  goal?: string;
  dimensions?: Record<string, string>;
  constraints?: { finish?: string; budgetMax?: number; currency?: string; installPath?: string };
  selections: {
    products: JourneySelectionItem[];
    accessories: JourneySelectionItem[];
  };
  capabilityLedger: CapabilityLedger;
  pendingDecision?: string | null;
  /** Hashes of capability presentations already made — the loop guard. */
  presentedFingerprints: string[];
  quoteId?: string | null;
  phase?: string;
  /** The style SKU currently open in the configurator — lets a colour/text change
   *  (a legitimately SKU-less showConfigurator) proceed, while a first render with
   *  no SKU is forced to retrieve a real style first. */
  activeSku?: string;
  /** Normalised school/org name already researched this journey — research runs
   *  ONCE per school, never re-firing (and re-showing the confirm card) each turn. */
  researchedOrgKey?: string;
  /** The cards currently on the panel, in display order, so "the second one"
   *  and "product 2" resolve to the style the customer is actually looking at. */
  lastShown?: { sku: string; name?: string }[];
  /** How many players/pieces the customer said they need ("14 players").
   *  Captured once and remembered: without it the quote silently defaulted every
   *  line to quantity 1, so an 18-player order priced as a single jersey. */
  teamSize?: number;
  version: number;
}

export function emptyJourneyState(): JourneyState {
  return {
    selections: { products: [], accessories: [] },
    capabilityLedger: {
      discovery: 'pending', recommendation: 'pending', accessories: 'pending',
      installationGuide: 'pending', warranty: 'pending', choice: 'pending', quote: 'pending',
      configurator: 'pending',
    },
    pendingDecision: null,
    presentedFingerprints: [],
    quoteId: null,
    phase: 'intro',
    version: 0,
  };
}

/** Cheap stable hash for idempotency fingerprints (no crypto dep needed). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Fingerprint a capability presentation by its identifying arguments. */
export function fingerprintAction(name: string, args: any): string {
  let key = name;
  try {
    if (name === 'showItems') key += ':' + (args.products || []).map((p: any) => p.sku || p.name).sort().join(',');
    else if (name === 'showAddons') key += ':' + (args.accessories || []).map((a: any) => a.sku || a.name).sort().join(',');
    else if (name === 'showDocuments') key += ':' + (args.documents || args.guides || []).map((d: any) => d.url || d.title).sort().join(',');
    else if (name === 'showInfo') key += ':warranty';
    else if (name === 'presentChoice') key += ':' + (args.options || []).map((o: any) => o.label || o).sort().join(',');
    else key += ':' + JSON.stringify(args).slice(0, 200);
  } catch { key += ':' + name; }
  return hash(key);
}

/** Which capability a UI tool advances (for the ledger). */
const TOOL_TO_CAPABILITY: Record<string, keyof CapabilityLedger | undefined> = {
  showItems: 'recommendation',
  showAddons: 'accessories',
  showDocuments: 'installationGuide',
  showGuide: 'installationGuide',
  showInfo: 'warranty',
  presentChoice: 'choice',
  updateQuote: 'quote',
  showConfigurator: 'configurator',
};

/**
 * Fold this turn's executed UI actions into the journey state. Called AFTER the
 * tool loop, BEFORE persistence — so the next turn sees what was actually done.
 */
export function reduceActions(
  prev: JourneyState,
  uiActions: { name: string; arguments: any }[],
  intent: { dimensions?: Record<string, string>; stage?: string },
): JourneyState {
  const s: JourneyState = JSON.parse(JSON.stringify(prev));
  // Merge freshly-extracted dimensions (goal context).
  if (intent.dimensions && Object.keys(intent.dimensions).length) {
    s.dimensions = { ...(s.dimensions || {}), ...intent.dimensions };
  }
  if (intent.stage) s.phase = intent.stage;

  for (const a of uiActions) {
    const args = a.arguments || {};
    const cap = TOOL_TO_CAPABILITY[a.name];
    // Record the fingerprint (idempotency memory).
    const fp = fingerprintAction(a.name, args);
    if (!s.presentedFingerprints.includes(fp)) s.presentedFingerprints.push(fp);

    switch (a.name) {
      case 'setPhase':
        if (args.phase === 'clarify') s.capabilityLedger.discovery = 'active';
        s.phase = args.phase || s.phase;
        break;
      case 'showItems':
        /* The cards CURRENTLY on screen, in the order the customer sees them.
         * `selections.products` accumulates across the whole journey, so it
         * cannot answer "the second one" — position 2 there is not position 2 on
         * the panel. Ordinal references resolve against this list only. */
        s.lastShown = (args.products || [])
          .filter((p: any) => p?.sku)
          .map((p: any) => ({ sku: String(p.sku), name: p.name }));
        for (const p of args.products || []) {
          if (!s.selections.products.some((x) => x.sku && x.sku === p.sku))
            s.selections.products.push({ sku: p.sku, name: p.name, status: 'presented' });
        }
        s.capabilityLedger.discovery = 'completed';
        s.capabilityLedger.recommendation = 'completed';
        break;
      case 'showAddons':
        for (const acc of args.accessories || []) {
          if (!s.selections.accessories.some((x) => x.sku && x.sku === acc.sku))
            s.selections.accessories.push({ sku: acc.sku, name: acc.name, status: 'presented' });
        }
        s.capabilityLedger.accessories = 'completed';
        break;
      case 'showDocuments':
      case 'showGuide':
        s.capabilityLedger.installationGuide = 'completed';
        break;
      case 'showInfo':
        s.capabilityLedger.warranty = 'completed';
        break;
      case 'presentChoice':
        s.capabilityLedger.choice = 'active';
        s.pendingDecision = (args.title as string) || 'a choice';
        break;
      case 'updateQuote':
        s.capabilityLedger.quote = 'completed';
        // args is the SERVER quote (P0-04) → use its authoritative id.
        s.quoteId = args.quoteId || args.jobId || s.quoteId || 'quote';
        s.pendingDecision = null;
        break;
      case 'showConfigurator':
        s.capabilityLedger.configurator = 'active';
        s.phase = 'configurator';
        if (args.sku) s.activeSku = String(args.sku);
        break;
    }
    if (cap && s.capabilityLedger[cap] === 'pending') s.capabilityLedger[cap] = 'completed';
  }
  s.version = (prev.version || 0) + 1;
  return s;
}

/**
 * Loop guard: has this exact presentation already been made in this journey?
 * If so the tool loop suppresses the duplicate and nudges the agent forward.
 */
export function alreadyPresented(state: JourneyState, name: string, args: any): boolean {
  return state.presentedFingerprints.includes(fingerprintAction(name, args));
}

/** The compact working-memory block injected into the model each turn. */
export function renderJourneyStateBlock(s: JourneyState): string {
  const led = s.capabilityLedger;
  const done = (Object.keys(led) as (keyof CapabilityLedger)[])
    .filter((k) => led[k] === 'completed').join(', ') || 'none yet';
  const products = s.selections.products.map((p) => `${p.name || p.sku}${p.status !== 'presented' ? ` (${p.status})` : ''}`).join('; ') || 'none';
  const accessories = s.selections.accessories.length
    ? s.selections.accessories.map((a) => `${a.name || a.sku} (${a.status})`).join('; ')
    : 'none offered yet';
  const dims = s.dimensions && Object.keys(s.dimensions).length
    ? Object.entries(s.dimensions).map(([k, v]) => `${k}=${v}`).join(', ') : '(none)';

  return [
    '[JOURNEY MEMORY — the authoritative record of THIS conversation. Trust it over your own recollection.',
    ' NEVER re-ask a question or re-present a step marked completed here. Move to the next unmet goal.]',
    `- Known context: ${dims}${s.constraints?.finish ? ` · finish=${s.constraints.finish}` : ''}${s.constraints?.budgetMax ? ` · budget≤${s.constraints.budgetMax}` : ''}`,
    `- Completed capabilities: ${done}`,
    `- Products already presented: ${products}`,
    `- Accessories: ${accessories}`,
    s.pendingDecision ? `- Awaiting the customer's decision on: ${s.pendingDecision}` : '- No decision pending.',
    s.quoteId ? `- A quote already exists (${s.quoteId}).` : '- No quote built yet.',
  ].join('\n');
}
