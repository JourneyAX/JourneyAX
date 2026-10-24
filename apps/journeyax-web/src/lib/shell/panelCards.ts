/**
 * Which cards open in the side panel instead of inline, and the one-line note the thread keeps where they were.
 * Wording is generic ("details", "comparison"); product names come from the card's own data.
 */
export const PANEL_CARD_TYPES = ['productDetail', 'comparison'] as const;

export function isPanelCardType(cardType: string | undefined | null): boolean {
  return (PANEL_CARD_TYPES as readonly string[]).includes(String(cardType));
}

export interface PanelCardLike {
  id: string;
  cardType: string;
  state?: Record<string, unknown>;
}

export interface PanelCardCopy {
  /** The panel's heading. */
  title: string;
  /** What the panel is, for assistive tech and the heading's small label. */
  kind: string;
  /** The line the thread keeps where the card was. */
  note: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const pick = (value: unknown, key: string): unknown => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined);

export function panelCardCopy(card: PanelCardLike): PanelCardCopy {
  const state = card.state || {};
  if (card.cardType === 'comparison') {
    const products: unknown[] = Array.isArray(state.products) ? state.products : [];
    const names = products.map((p) => text(pick(p, 'title')) || text(pick(p, 'sku'))).filter(Boolean);
    const vs = names.join(' vs ');
    return {
      title: 'Comparison',
      kind: 'Comparison',
      note: vs ? `Opened a comparison of ${vs} in the side panel` : 'Opened a comparison in the side panel',
    };
  }
  const title = text(pick(state.product, 'title'));
  return {
    title: title || 'Product details',
    kind: 'Product details',
    note: title ? `Opened details for ${title} in the side panel` : 'Opened product details in the side panel',
  };
}
