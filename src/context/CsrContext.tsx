'use client';

import React, { createContext, useContext, useReducer, useMemo, useCallback } from 'react';
import {
  ComsOrder, RosterEntry, SearchHit, CsrPhase, ValidationCheck, needsNewProof,
} from '@/lib/csr-types';
import { FitReview, SizeSuggestion } from '@/lib/fit-types';
import { searchOrders } from '@/services/csr/mock-data';
import { reviewSizes } from '@/services/fit/engine';
import { orderToFitInput } from '@/services/fit/adapters';
import { getBrandProfile, DEFAULT_BRAND_ID } from '@/services/fit/brands';

// ── State ──────────────────────────────────────────────────────────────
export interface CsrState {
  phase: CsrPhase;
  query: string;
  hits: SearchHit[];
  /** The order as it exists today — never mutated, so we can diff against it. */
  original: ComsOrder | null;
  /** The working copy the CSR is editing. */
  draft: ComsOrder | null;
  isThinking: boolean;
  lastAction: string | null;
  submittedRef: string | null;
  handedOff: boolean;
  /** Narration from the assist bar, newest last. */
  log: { id: string; role: 'csr' | 'agent'; text: string }[];
  /** Which fit profile this account is serviced under. */
  brandId: string;
  /** Last size review. Null until the CSR (or the model) asks for one. */
  fit: FitReview | null;
  /** Wearer ids the human has accepted or waved away, so we stop re-asking. */
  fitAccepted: string[];
  fitDismissed: string[];
}

const INITIAL: CsrState = {
  phase: 'search',
  query: '',
  hits: [],
  original: null,
  draft: null,
  isThinking: false,
  lastAction: null,
  submittedRef: null,
  handedOff: false,
  log: [],
  brandId: DEFAULT_BRAND_ID,
  fit: null,
  fitAccepted: [],
  fitDismissed: [],
};

type Action =
  | { type: 'SEARCH'; query: string }
  | { type: 'OPEN_ORDER'; sNumber: string }
  | { type: 'BACK_TO_RESULTS' }
  | { type: 'ROSTER_EDIT'; id: string; field: 'name' | 'number' | 'size'; value: string }
  | { type: 'ROSTER_ADD'; entry?: Partial<RosterEntry> }
  | { type: 'ROSTER_REMOVE'; id: string }
  | { type: 'ROSTER_REPLACE'; rows: RosterEntry[] }
  | { type: 'SET_COLORWAY'; colorway: string }
  | { type: 'ACCEPT_REPLACEMENT_STYLE' }
  | { type: 'RUN_FIT_REVIEW' }
  | { type: 'ACCEPT_FIT'; wearerId: string }
  | { type: 'ACCEPT_ALL_FIT' }
  | { type: 'DISMISS_FIT'; wearerId: string }
  | { type: 'CLEAR_FIT' }
  | { type: 'SET_THINKING'; thinking: boolean }
  | { type: 'LOG'; role: 'csr' | 'agent'; text: string }
  | { type: 'SUBMIT' }
  | { type: 'HAND_OFF'; reason: string }
  | { type: 'RESET' };

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function reducer(state: CsrState, action: Action): CsrState {
  switch (action.type) {
    case 'SEARCH': {
      const hits = searchOrders(action.query);
      return { ...state, query: action.query, hits, phase: action.query.trim() ? 'results' : 'search' };
    }

    case 'OPEN_ORDER': {
      const hit = state.hits.find(h => h.order.sNumber === action.sNumber)
        || searchOrders(action.sNumber)[0];
      if (!hit) return state;
      const order = hit.order;
      return {
        ...state,
        phase: 'order',
        original: order,
        // Deep-ish clone so edits never touch the source record.
        draft: { ...order, product: { ...order.product }, roster: order.roster.map(r => ({ ...r })) },
        submittedRef: null,
        handedOff: false,
        fit: null,
        fitAccepted: [],
        fitDismissed: [],
      };
    }

    case 'BACK_TO_RESULTS':
      return {
        ...state,
        phase: state.hits.length ? 'results' : 'search',
        original: null, draft: null,
        fit: null, fitAccepted: [], fitDismissed: [],
      };

    case 'ROSTER_EDIT': {
      if (!state.draft) return state;
      const roster = state.draft.roster.map(r =>
        r.id === action.id
          ? { ...r, [action.field]: action.value, change: r.change === 'added' ? 'added' as const : 'edited' as const }
          : r
      );
      return { ...state, draft: { ...state.draft, roster } };
    }

    case 'ROSTER_ADD': {
      if (!state.draft) return state;
      const entry: RosterEntry = {
        id: uid('r'),
        name: action.entry?.name ?? '',
        number: action.entry?.number ?? '',
        size: action.entry?.size ?? 'M',
        change: 'added',
      };
      return { ...state, draft: { ...state.draft, roster: [...state.draft.roster, entry] } };
    }

    case 'ROSTER_REMOVE': {
      if (!state.draft) return state;
      return { ...state, draft: { ...state.draft, roster: state.draft.roster.filter(r => r.id !== action.id) } };
    }

    case 'ROSTER_REPLACE': {
      if (!state.draft) return state;
      return { ...state, draft: { ...state.draft, roster: action.rows } };
    }

    case 'SET_COLORWAY': {
      if (!state.draft) return state;
      return { ...state, draft: { ...state.draft, product: { ...state.draft.product, colorway: action.colorway } } };
    }

    case 'ACCEPT_REPLACEMENT_STYLE': {
      if (!state.draft?.product.suggestedReplacement) return state;
      const rep = state.draft.product.suggestedReplacement;
      const draft: ComsOrder = {
        ...state.draft,
        product: {
          ...state.draft.product,
          styleId: rep.styleId,
          styleName: rep.styleName,
          unitPrice: rep.unitPrice,
          // Carry the replacement's own fit characteristics. Without this a
          // style that runs small becomes a size change nobody was told about.
          cut: rep.cut ?? state.draft.product.cut,
          runs: rep.runs ?? 0,
          stillAvailable: true,
          discontinuedNote: undefined,
          suggestedReplacement: undefined,
        },
      };
      // If a review was already on screen it is now stale — the garment
      // changed underneath it. Re-run rather than leave the old answer up.
      const fit = state.fit
        ? reviewSizes({ brand: getBrandProfile(state.brandId), ...orderToFitInput(draft) })
        : null;
      return { ...state, draft, fit, fitAccepted: [], fitDismissed: [] };
    }

    // ── Fit ────────────────────────────────────────────────────────────
    case 'RUN_FIT_REVIEW': {
      if (!state.draft) return state;
      const brand = getBrandProfile(state.brandId);
      const input = orderToFitInput(state.draft);
      return {
        ...state,
        fit: reviewSizes({ brand, ...input }),
        fitAccepted: [],
        fitDismissed: [],
      };
    }

    case 'ACCEPT_FIT': {
      const s = state.fit?.suggestions.find(x => x.wearerId === action.wearerId);
      if (!s || !state.draft) return state;
      const roster = state.draft.roster.map(r =>
        r.id === s.wearerId
          ? { ...r, size: s.to, change: r.change === 'added' ? r.change : ('edited' as const) }
          : r
      );
      return {
        ...state,
        draft: { ...state.draft, roster },
        fitAccepted: [...state.fitAccepted, s.wearerId],
      };
    }

    case 'ACCEPT_ALL_FIT': {
      if (!state.fit || !state.draft) return state;
      const open = state.fit.suggestions.filter(
        s => !state.fitAccepted.includes(s.wearerId) && !state.fitDismissed.includes(s.wearerId)
      );
      if (!open.length) return state;
      const byId = new Map(open.map(s => [s.wearerId, s.to]));
      const roster = state.draft.roster.map(r =>
        byId.has(r.id)
          ? { ...r, size: byId.get(r.id)!, change: r.change === 'added' ? r.change : ('edited' as const) }
          : r
      );
      return {
        ...state,
        draft: { ...state.draft, roster },
        fitAccepted: [...state.fitAccepted, ...open.map(s => s.wearerId)],
      };
    }

    case 'DISMISS_FIT':
      return { ...state, fitDismissed: [...state.fitDismissed, action.wearerId] };

    case 'CLEAR_FIT':
      return { ...state, fit: null, fitAccepted: [], fitDismissed: [] };

    case 'SET_THINKING':
      return { ...state, isThinking: action.thinking };

    case 'LOG':
      return { ...state, log: [...state.log, { id: uid('m'), role: action.role, text: action.text }] };

    case 'SUBMIT':
      return { ...state, phase: 'submitted', submittedRef: 'S' + Math.floor(500000 + Math.random() * 99999) };

    case 'HAND_OFF':
      return { ...state, phase: 'submitted', handedOff: true, lastAction: action.reason };

    case 'RESET':
      return { ...INITIAL };

    default:
      return state;
  }
}

// ── Derived: what changed, and does it need an artist? ─────────────────
export interface DraftDiff {
  rosterChanged: boolean;
  sizesChanged: boolean;
  colorChanged: boolean;
  styleChanged: boolean;
  artChanged: boolean;
  added: number;
  removed: number;
  edited: number;
  qtyBefore: number;
  qtyAfter: number;
}

function diffOrders(original: ComsOrder | null, draft: ComsOrder | null): DraftDiff {
  const empty: DraftDiff = {
    rosterChanged: false, sizesChanged: false, colorChanged: false, styleChanged: false,
    artChanged: false, added: 0, removed: 0, edited: 0, qtyBefore: 0, qtyAfter: 0,
  };
  if (!original || !draft) return empty;

  const byId = new Map(original.roster.map(r => [r.id, r]));
  const draftIds = new Set(draft.roster.map(r => r.id));

  let added = 0, edited = 0, sizesChanged = false;
  for (const r of draft.roster) {
    const before = byId.get(r.id);
    if (!before) { added++; continue; }
    if (before.name !== r.name || before.number !== r.number) edited++;
    if (before.size !== r.size) { edited++; sizesChanged = true; }
  }
  const removed = original.roster.filter(r => !draftIds.has(r.id)).length;

  return {
    added, removed, edited, sizesChanged,
    rosterChanged: added + removed + edited > 0,
    colorChanged: original.product.colorway !== draft.product.colorway,
    styleChanged: original.product.styleId !== draft.product.styleId,
    artChanged: false, // set when artwork is replaced — out of scope for the spine
    qtyBefore: original.roster.length,
    qtyAfter: draft.roster.length,
  };
}

function buildChecks(
  draft: ComsOrder | null,
  diff: DraftDiff,
  openFitCount: number
): ValidationCheck[] {
  if (!draft) return [];
  const checks: ValidationCheck[] = [];

  // Unresolved size suggestions. A warning, never a block — the human is
  // allowed to disagree with the engine, they just should not miss it.
  if (openFitCount > 0) {
    checks.push({
      id: 'fit',
      level: 'warn',
      title: `${openFitCount} size ${openFitCount === 1 ? 'suggestion' : 'suggestions'} open`,
      detail: 'Sizes may have changed since this roster was last confirmed.',
      action: 'Review in the Size review panel',
    });
  }

  // Style availability
  if (!draft.product.stillAvailable) {
    checks.push({
      id: 'style',
      level: 'block',
      title: 'Style no longer available',
      detail: draft.product.discontinuedNote || 'This style has been retired.',
      action: draft.product.suggestedReplacement
        ? `Switch to ${draft.product.suggestedReplacement.styleId}`
        : undefined,
    });
  } else {
    checks.push({ id: 'style', level: 'ok', title: 'Style available', detail: `${draft.product.styleId} is current.` });
  }

  // Proof decision — the call that decides whether an artist is pulled in
  const proof = needsNewProof({
    rosterChanged: diff.rosterChanged,
    sizesChanged: diff.sizesChanged,
    colorChanged: diff.colorChanged,
    artChanged: diff.artChanged,
    styleChanged: diff.styleChanged,
  });
  checks.push({
    id: 'proof',
    level: proof.required ? 'warn' : 'ok',
    title: proof.required ? 'New proof required' : 'No new proof needed',
    detail: proof.reason,
    action: proof.required ? 'Route to art queue' : undefined,
  });

  // Roster completeness
  const blanks = draft.roster.filter(r => !r.name.trim() || !r.number.trim());
  if (blanks.length) {
    checks.push({
      id: 'roster-blank',
      level: 'block',
      title: `${blanks.length} incomplete roster ${blanks.length === 1 ? 'line' : 'lines'}`,
      detail: 'Every line needs a name and a number before submission.',
    });
  }

  // Duplicate numbers — a classic reason a roster bounces back
  const seen = new Map<string, number>();
  draft.roster.forEach(r => { if (r.number.trim()) seen.set(r.number, (seen.get(r.number) || 0) + 1); });
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  if (dupes.length) {
    checks.push({
      id: 'roster-dupe',
      level: 'block',
      title: 'Duplicate player numbers',
      detail: `Number${dupes.length > 1 ? 's' : ''} ${dupes.join(', ')} used more than once.`,
    });
  }

  // Minimum quantity
  if (draft.roster.length > 0 && draft.roster.length < 6) {
    checks.push({
      id: 'moq',
      level: 'warn',
      title: 'Below typical minimum',
      detail: `${draft.roster.length} units. Sublimation minimum is usually 6.`,
    });
  }

  // Colour — mirrors the PMS/Neon tag cluster in COMS
  if (diff.colorChanged) {
    checks.push({
      id: 'color',
      level: 'warn',
      title: 'Colour changed',
      detail: 'Production colour mapping must be confirmed against the printer book.',
      action: 'Send to colour approval',
    });
  }

  if (draft.hold) {
    checks.push({ id: 'hold', level: 'warn', title: 'Account on hold', detail: 'Financial approval required before release.' });
  }

  return checks;
}

/**
 * Resolve "drop 6" or "swap Jenkins for Gajji" to a single roster line.
 *
 * Number is matched exactly and first — a CSR saying "6" means the player
 * wearing 6, never the sixth row. Name is only considered when it is a
 * non-empty string, otherwise `includes('')` matches every line and the wrong
 * player gets removed.
 */
function findRosterLine(
  roster: RosterEntry[] | undefined,
  number?: string,
  name?: string
): RosterEntry | undefined {
  if (!roster?.length) return undefined;

  const num = (number ?? '').trim();
  if (num && /^\d+$/.test(num)) {
    const byNumber = roster.find(r => r.number.trim() === num);
    if (byNumber) return byNumber;
  }

  const nm = (name ?? '').trim().toLowerCase();
  if (nm && !/^\d+$/.test(nm)) {
    return roster.find(r => r.name.toLowerCase().includes(nm));
  }

  return undefined;
}

// ── Context ────────────────────────────────────────────────────────────
interface CsrContextType {
  state: CsrState;
  dispatch: React.Dispatch<Action>;
  diff: DraftDiff;
  checks: ValidationCheck[];
  blockers: ValidationCheck[];
  canSubmit: boolean;
  orderValue: number;
  /** Suggestions still awaiting a decision. */
  openFitSuggestions: SizeSuggestion[];
  runCommand: (text: string) => Promise<void>;
}

const CsrContext = createContext<CsrContextType | null>(null);

export function CsrProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const diff = useMemo(() => diffOrders(state.original, state.draft), [state.original, state.draft]);
  const openFitSuggestions = useMemo(
    () => (state.fit?.suggestions ?? []).filter(
      s => !state.fitAccepted.includes(s.wearerId) && !state.fitDismissed.includes(s.wearerId)
    ),
    [state.fit, state.fitAccepted, state.fitDismissed]
  );
  const checks = useMemo(
    () => buildChecks(state.draft, diff, openFitSuggestions.length),
    [state.draft, diff, openFitSuggestions.length]
  );
  const blockers = useMemo(() => checks.filter(c => c.level === 'block'), [checks]);
  const canSubmit = !!state.draft && state.draft.roster.length > 0 && blockers.length === 0;
  const orderValue = useMemo(
    () => (state.draft ? state.draft.roster.length * state.draft.product.unitPrice : 0),
    [state.draft]
  );

  /**
   * The assist bar. A CSR is on a live call, so this is a command line, not a
   * chat — short shorthand in, panel updates out. The route answers with the
   * same uiActions pattern the Caroma chat route uses.
   */
  const runCommand = useCallback(async (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: 'LOG', role: 'csr', text });
    dispatch({ type: 'SET_THINKING', thinking: true });

    try {
      const res = await fetch('/api/csr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: text,
          context: {
            phase: state.phase,
            sNumber: state.draft?.sNumber ?? null,
            accountName: state.draft?.accountName ?? null,
            roster: state.draft?.roster ?? [],
            colorway: state.draft?.product.colorway ?? null,
          },
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || 'Assist unavailable');
      const data = await res.json();

      for (const a of data.uiActions || []) {
        switch (a.name) {
          case 'findOrder':
            dispatch({ type: 'SEARCH', query: a.arguments.query });
            if (a.arguments.openFirst) {
              const first = searchOrders(a.arguments.query)[0];
              if (first) dispatch({ type: 'OPEN_ORDER', sNumber: first.order.sNumber });
            }
            break;
          case 'openOrder':
            dispatch({ type: 'OPEN_ORDER', sNumber: a.arguments.sNumber });
            break;
          case 'editRoster':
            for (const op of a.arguments.operations || []) {
              if (op.op === 'add') dispatch({ type: 'ROSTER_ADD', entry: op });
              else if (op.op === 'remove') {
                const match = findRosterLine(state.draft?.roster, op.number, op.name);
                if (match) dispatch({ type: 'ROSTER_REMOVE', id: match.id });
              } else if (op.op === 'edit') {
                const match = findRosterLine(state.draft?.roster, op.match, op.match);
                if (match) {
                  if (op.name) dispatch({ type: 'ROSTER_EDIT', id: match.id, field: 'name', value: op.name });
                  if (op.number) dispatch({ type: 'ROSTER_EDIT', id: match.id, field: 'number', value: op.number });
                  if (op.size) dispatch({ type: 'ROSTER_EDIT', id: match.id, field: 'size', value: op.size });
                }
              }
            }
            break;
          case 'setColorway':
            dispatch({ type: 'SET_COLORWAY', colorway: a.arguments.colorway });
            break;
          case 'checkSizes':
            dispatch({ type: 'RUN_FIT_REVIEW' });
            break;
        }
      }

      if (data.message) dispatch({ type: 'LOG', role: 'agent', text: data.message });
    } catch (err: unknown) {
      dispatch({ type: 'LOG', role: 'agent', text: `⚠ ${err instanceof Error ? err.message : 'Assist failed'}` });
    } finally {
      dispatch({ type: 'SET_THINKING', thinking: false });
    }
  }, [state.phase, state.draft]);

  return (
    <CsrContext.Provider
      value={{ state, dispatch, diff, checks, blockers, canSubmit, orderValue, openFitSuggestions, runCommand }}
    >
      {children}
    </CsrContext.Provider>
  );
}

export function useCsr() {
  const ctx = useContext(CsrContext);
  if (!ctx) throw new Error('useCsr must be inside CsrProvider');
  return ctx;
}
