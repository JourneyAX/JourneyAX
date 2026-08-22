// ═══════════════════════════════════════════════════════════════════════
// Two businesses, one engine.
//
// This file exists to be read as much as to be run. The two scenarios below
// have almost nothing in common — different wearers, different evidence,
// different failure mode, different unit economics — and they are served by
// the same `reviewSizes()` call with a different brand profile.
//
// If a third brand ever needed a code change, the abstraction would be
// wrong. Adding one here should be data only.
// ═══════════════════════════════════════════════════════════════════════

import { StyleFitProfile, Wearer } from '@/lib/fit-types';
import { ORDERS } from '@/services/csr/mock-data';
import { orderToFitInput, retailLineToStyle, retailLineToWearer } from './adapters';

export interface EvidenceColumn {
  key: string;
  label: string;
  get: (w: Wearer) => string;
}

export interface DemoScenario {
  id: string;
  brandId: string;
  /** Tab label. */
  tab: string;
  /** What this desk is looking at. */
  title: string;
  subtitle: string;
  /** Why a wrong size costs money here. The two answers are very different. */
  costOfError: string;
  styleLabel: string;
  wearers: Wearer[];
  style: StyleFitProfile;
  defaultSizedAt?: string;
  /** Which evidence to show — a brand only holds some of it. */
  columns: EvidenceColumn[];
}

const dash = '—';
const fmt = (v?: string) => v?.trim() || dash;

// ── 1. Augusta — a school reorder ──────────────────────────────────────
const oswego = ORDERS.find(o => o.sNumber === 'S482913')!;
const oswegoInput = orderToFitInput(oswego);

const AUGUSTA_SCENARIO: DemoScenario = {
  id: 'augusta',
  brandId: 'augusta',
  tab: 'Augusta Sportswear',
  title: 'Oswego East High School · Girls’ Volleyball',
  subtitle: `Reordering last season’s kit. Roster last sized ${oswego.receivedDate}.`,
  costOfError:
    'Nothing here is returnable — every jersey carries a name and a number. '
    + 'A wrong size is a reprint, a CSR call and a player who cannot dress for the opener.',
  styleLabel: `${oswego.product.styleId} · ${oswego.product.colorway}`,
  wearers: oswegoInput.wearers,
  style: oswegoInput.style,
  defaultSizedAt: oswegoInput.defaultSizedAt,
  columns: [
    { key: 'grade', label: 'Grade', get: w => (w.gradeLevel ? `Grade ${w.gradeLevel}` : dash) },
    { key: 'sized', label: 'Last sized', get: w => fmt(w.sizedAt ?? oswego.receivedDate) },
    {
      key: 'history',
      label: 'Prior seasons',
      get: w => (w.history?.length ? w.history.map(h => h.size).join(' → ') : dash),
    },
    { key: 'returns', label: 'Returns', get: () => 'n/a — made to order' },
  ],
};

// ── 2. Abercrombie & Fitch — a pre-ship size check ─────────────────────
// The retail equivalent of the reorder desk: orders placed today for one
// style, checked before they leave the warehouse. This is the use case the
// whole fit-tech category sells — stop the return before it ships.
const AF_STYLE = {
  lineId: '', customerName: '', size: '',
  styleId: 'AF-8841',
  styleName: 'Essential Crew Tee',
  cut: 'athletic' as const,
  // True to size. Left at 0 deliberately so the per-customer signals have to
  // do the work — a style-wide offset would flag everyone and prove nothing.
  runs: 0 as const,
};

const AF_WEARERS: Wearer[] = [
  retailLineToWearer(
    { ...AF_STYLE, lineId: 'af-1', customerName: 'Dana Whitfield', size: 'M' },
    {
      fitPreference: 'relaxed',
      returns: [{ at: '02/11/2026', size: 'M', reason: 'too-small' }],
      chestIn: 43,
    }
  ),
  retailLineToWearer(
    { ...AF_STYLE, lineId: 'af-2', customerName: 'Marcus Reed', size: 'L' },
    { fitPreference: 'true' }
  ),
  retailLineToWearer(
    { ...AF_STYLE, lineId: 'af-3', customerName: 'Tricia Nolan', size: 'S' },
    {
      purchases: [
        { at: '01/04/2024', size: 'XS' },
        { at: '06/20/2025', size: 'S' },
      ],
    }
  ),
  retailLineToWearer(
    { ...AF_STYLE, lineId: 'af-4', customerName: 'Priya Raman', size: 'XL' },
    {
      fitPreference: 'athletic',
      returns: [{ at: '06/30/2026', size: 'XL', reason: 'too-large' }],
    }
  ),
  retailLineToWearer(
    { ...AF_STYLE, lineId: 'af-5', customerName: 'Jordan Ellis', size: 'M' },
    { fitPreference: 'relaxed' }
  ),
];

const ABERCROMBIE_SCENARIO: DemoScenario = {
  id: 'abercrombie',
  brandId: 'abercrombie',
  tab: 'Abercrombie & Fitch',
  title: 'Pre-ship size check · orders placed today',
  subtitle: 'Five orders for one style, checked before they leave the warehouse.',
  costOfError:
    'Every wrong size here comes back. The brand pays shipping twice, handles the '
    + 'garment twice, and often loses the sale entirely.',
  styleLabel: `${AF_STYLE.styleId} · ${AF_STYLE.styleName}`,
  wearers: AF_WEARERS,
  style: retailLineToStyle(AF_STYLE),
  columns: [
    {
      key: 'purchases',
      label: 'Past purchases',
      get: w => (w.history?.length ? w.history.map(h => h.size).join(' → ') : dash),
    },
    {
      key: 'returns',
      label: 'Returns',
      get: w =>
        w.returns?.length
          ? w.returns.map(r => `${r.size} ${r.reason.replace('-', ' ')}`).join(', ')
          : dash,
    },
    { key: 'pref', label: 'Fit preference', get: w => fmt(w.fitPreference) },
    {
      key: 'measure',
      label: 'Measurements',
      get: w => (w.measurements?.chestIn ? `${w.measurements.chestIn}" chest` : dash),
    },
  ],
};

export const DEMO_SCENARIOS: DemoScenario[] = [AUGUSTA_SCENARIO, ABERCROMBIE_SCENARIO];

export function getScenario(id: string): DemoScenario {
  return DEMO_SCENARIOS.find(s => s.id === id) ?? DEMO_SCENARIOS[0];
}

/** Human labels for the signal ids, used by the brand-profile card. */
export const SIGNAL_LABELS: Record<string, string> = {
  'elapsed-growth': 'Time since sized',
  'size-history': 'Wearer’s own history',
  'return-signal': 'Previous return reason',
  'fit-preference': 'Stated fit preference',
  'style-offset': 'How this style runs',
  'measurement-chart': 'Measurement vs chart',
};

export const ALL_SIGNAL_IDS = Object.keys(SIGNAL_LABELS);
