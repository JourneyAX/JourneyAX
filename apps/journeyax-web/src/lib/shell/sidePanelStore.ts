/**
 * Which card, if any, is open in the right-hand side panel. One panel at a time: opening another card replaces the one shown.
 *
 * Held outside React state (like the compare selection) because the thing that opens it — a card action, or the agent's own
 * `present_card` — lives far from the panel that shows it, and neither owns the other.
 */
import { useSyncExternalStore } from 'react';

export interface OpenPanel {
  /** The card id the opener pushed. A card pushed right after another of its kind can be merged into it, so the id may not survive. */
  id: string;
  cardType: string;
}

let openPanel: OpenPanel | null = null;
let opener: HTMLElement | null = null;
let rememberedAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** How long a remembered tap target stays valid: product details can take a moment to arrive after the tap. */
const OPENER_TTL_MS = 15_000;

/** Call at the moment of a tap (before any waiting), so closing the panel can return focus to what the person pressed. */
export function rememberPanelOpener(): void {
  if (typeof document === 'undefined') return;
  const el = document.activeElement;
  opener = el instanceof HTMLElement && el !== document.body ? el : null;
  rememberedAt = Date.now();
}

export function getOpenPanel(): OpenPanel | null { return openPanel; }

export function openPanelCard(cardId: string, cardType: string): void {
  if (!cardId || !cardType) return;
  if (!opener || Date.now() - rememberedAt > OPENER_TTL_MS) {
    if (typeof document !== 'undefined') {
      const el = document.activeElement;
      opener = el instanceof HTMLElement && el !== document.body ? el : null;
    }
  }
  if (openPanel && openPanel.id === cardId && openPanel.cardType === cardType) return;
  openPanel = { id: cardId, cardType };
  emit();
}

/** The card an open request points at: that exact card if it still exists, else the latest card of its kind (it was merged). */
export function resolvePanelCard<T extends { id: string; cardType: string }>(cards: readonly T[], open: OpenPanel | null): T | null {
  if (!open) return null;
  const exact = cards.find((card) => card.id === open.id);
  if (exact) return exact;
  for (let i = cards.length - 1; i >= 0; i--) if (cards[i].cardType === open.cardType) return cards[i];
  return null;
}

/** Closes the panel and hands back the element to focus (if it is still on the page). */
export function closePanelCard(): HTMLElement | null {
  const back = opener && typeof document !== 'undefined' && document.contains(opener) ? opener : null;
  opener = null;
  if (openPanel === null) return back;
  openPanel = null;
  emit();
  return back;
}

export function useOpenPanel(): OpenPanel | null {
  return useSyncExternalStore(subscribe, getOpenPanel, () => null);
}
