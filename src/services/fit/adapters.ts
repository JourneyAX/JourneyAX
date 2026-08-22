// ═══════════════════════════════════════════════════════════════════════
// Adapters — source system → the engine's Wearer shape.
//
// The engine deliberately knows nothing about COMS, rosters or carts. Each
// business gets a small adapter here, and that is the whole integration.
//
// Note how little each one is. That is the point: the expensive part of a
// fit product is the signals and the evidence, not the plumbing, so the
// plumbing is where a new brand should cost the least.
// ═══════════════════════════════════════════════════════════════════════

import { StyleFitProfile, Wearer } from '@/lib/fit-types';
import { ComsOrder, DesignProduct, RosterEntry } from '@/lib/csr-types';

// ── Team wear (Augusta / Momentec, via COMS) ───────────────────────────

export function rosterToWearers(roster: RosterEntry[], orderDate?: string): Wearer[] {
  return roster.map(r => ({
    id: r.id,
    name: r.name?.trim() || `#${r.number}`,
    size: r.size,
    gradeLevel: r.gradeLevel,
    sizedAt: r.sizedAt ?? orderDate,
    history: r.sizeHistory,
  }));
}

export function productToStyle(product: DesignProduct): StyleFitProfile {
  return {
    styleId: product.styleId,
    styleName: product.styleName,
    cut: product.cut ?? 'standard',
    runs: product.runs ?? 0,
  };
}

export function orderToFitInput(order: ComsOrder): { wearers: Wearer[]; style: StyleFitProfile; defaultSizedAt?: string } {
  return {
    wearers: rosterToWearers(order.roster, order.receivedDate),
    style: productToStyle(order.product),
    defaultSizedAt: order.receivedDate,
  };
}

// ── Retail (a fashion brand's customer + basket) ───────────────────────
// Not used by the CSR spine. It exists to keep the second business honest:
// if the retail shape did not map cleanly onto Wearer, the abstraction
// would be wrong, and it is cheaper to find that out now than after a
// prospect asks.

export interface RetailLine {
  lineId: string;
  customerName: string;
  size: string;
  styleId: string;
  styleName?: string;
  cut?: StyleFitProfile['cut'];
  runs?: StyleFitProfile['runs'];
}

export interface RetailCustomer {
  fitPreference?: Wearer['fitPreference'];
  purchases?: { at: string; size: string; styleId?: string }[];
  returns?: Wearer['returns'];
  chestIn?: number;
}

export function retailLineToWearer(line: RetailLine, customer: RetailCustomer): Wearer {
  return {
    id: line.lineId,
    name: line.customerName,
    size: line.size,
    ageBand: 'adult',
    fitPreference: customer.fitPreference,
    history: customer.purchases,
    returns: customer.returns,
    measurements: customer.chestIn ? { chestIn: customer.chestIn } : undefined,
  };
}

export function retailLineToStyle(line: RetailLine): StyleFitProfile {
  return {
    styleId: line.styleId,
    styleName: line.styleName,
    cut: line.cut ?? 'standard',
    runs: line.runs ?? 0,
  };
}
