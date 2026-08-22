// ═══════════════════════════════════════════════════════════════════════
// The saved size profile.
//
// Every advisor worth using remembers you, because the second time is where
// the value is: no questions at all, just "you're an L in this one".
//
// Deliberately in localStorage rather than on a server, and deliberately
// opt-in. Nothing is written unless the shopper ticks the box, and clearing
// it is one click. Body measurements are the kind of data that should never
// end up somewhere the person who typed them cannot delete.
//
// When this eventually moves server-side it belongs behind a signed session,
// not a client-supplied id — see the CSR journey for the same rule.
// ═══════════════════════════════════════════════════════════════════════

import { AdvisorAnswers } from '@/lib/advisor-types';

const KEY = 'journeyax.fit.profile.v1';

export function loadProfile(): AdvisorAnswers | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdvisorAnswers;
    // Anything without a usable body is not worth restoring.
    if (!parsed.heightIn && !parsed.reference && !parsed.overrides) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProfile(answers: AdvisorAnswers): void {
  if (typeof window === 'undefined') return;
  try {
    // Store only what the advisor needs to reproduce the answer.
    const { heightIn, weightLb, age, chart, preference, reference, overrides } = answers;
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ heightIn, weightLb, age, chart, preference, reference, overrides })
    );
  } catch {
    // Private browsing, quota, or storage disabled. Not worth interrupting a
    // purchase over — the advisor works fine without a memory.
  }
}

export function clearProfile(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** A short human description of what we remembered, for the UI. */
export function describeProfile(p: AdvisorAnswers): string {
  if (p.overrides && Object.keys(p.overrides).length) return 'your own measurements';
  if (p.heightIn && p.weightLb) {
    const ft = Math.floor(p.heightIn / 12);
    const inch = Math.round(p.heightIn % 12);
    return `${ft}′${inch}″, ${p.weightLb} lb`;
  }
  if (p.reference) return `your ${p.reference.size} at another brand`;
  return 'your saved measurements';
}
