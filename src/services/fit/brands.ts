// ═══════════════════════════════════════════════════════════════════════
// Brand fit profiles.
//
// This is the ONLY file that differs between customers. Onboarding a new
// clothing brand means adding an entry here: which signals they hold data
// for, how far they trust each one, what their policy is, and what they
// call the person wearing the garment.
//
// No engine change, no component change, no new endpoint.
// ═══════════════════════════════════════════════════════════════════════

import { BrandFitProfile } from '@/lib/fit-types';

// ── Augusta / Momentec — made-to-order team wear ────────────────────────
// Wearers are school athletes. Two consequences drive the whole profile:
//
//   1. Nothing is returnable — a jersey carries a name and a number. So the
//      return signal has nothing to feed on, and growth becomes the signal
//      that matters. A wrong size here is a reprint and a phone call, not a
//      restock.
//   2. The wearers are minors. Body measurement is switched off outright.
//      That is a policy decision, not a technical limit.
const AUGUSTA: BrandFitProfile = {
  brandId: 'augusta',
  brandName: 'Augusta Sportswear',
  signals: {
    'elapsed-growth': 1.0,
    'size-history': 0.9,
    'style-offset': 0.5,
  },
  policy: {
    allowBodyMeasurement: false,
    assumeMinors: true,
    maxStep: 1,
    minConfidence: 0.45,
    autoApply: false,
  },
  copy: { wearerNoun: 'player', wearerNounPlural: 'players', groupNoun: 'roster' },
};

// ── Abercrombie & Fitch — retail fashion ───────────────────────────────
// The mirror image. Adults, returns exist and are expensive, people state
// how they like things to fit, and measurements are permitted because the
// wearer is the person entering them.
//
// Note elapsed-growth is not listed: it would be noise on an adult book.
// Switching a signal off is a one-line change.
const ABERCROMBIE: BrandFitProfile = {
  brandId: 'abercrombie',
  brandName: 'Abercrombie & Fitch',
  signals: {
    'return-signal': 1.0,
    'size-history': 0.9,
    'fit-preference': 0.7,
    'style-offset': 0.6,
    'measurement-chart': 0.5,
  },
  policy: {
    allowBodyMeasurement: true,
    assumeMinors: false,
    maxStep: 2,
    minConfidence: 0.4,
    autoApply: false,
  },
  copy: { wearerNoun: 'customer', wearerNounPlural: 'customers', groupNoun: 'order' },
};

// ── Generic fallback ───────────────────────────────────────────────────
// A brand we have just onboarded and know nothing about yet. Every signal
// is on at modest weight and the confidence bar is high, so it stays quiet
// until it has something worth saying.
const GENERIC: BrandFitProfile = {
  brandId: 'generic',
  brandName: 'Apparel brand',
  signals: {
    'elapsed-growth': 0.6,
    'size-history': 0.8,
    'return-signal': 0.8,
    'fit-preference': 0.5,
    'style-offset': 0.5,
  },
  policy: {
    allowBodyMeasurement: false,
    assumeMinors: false,
    maxStep: 1,
    minConfidence: 0.55,
    autoApply: false,
  },
  copy: { wearerNoun: 'wearer', wearerNounPlural: 'wearers', groupNoun: 'order' },
};

export const BRAND_PROFILES: Record<string, BrandFitProfile> = {
  augusta: AUGUSTA,
  abercrombie: ABERCROMBIE,
  generic: GENERIC,
};

export function getBrandProfile(brandId?: string): BrandFitProfile {
  if (!brandId) return GENERIC;
  return BRAND_PROFILES[brandId.toLowerCase()] ?? GENERIC;
}

export const DEFAULT_BRAND_ID = 'augusta';
