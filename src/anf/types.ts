// ─── Abercrombie & Fitch — AI Stylist types ─────────────────────────────

export type AnfPhase =
  | 'intro'
  | 'style'
  | 'curating'
  | 'products'
  | 'bag'
  | 'confirmed';

export type MsgRole = 'ai' | 'user' | 'note';

export interface AnfMessage {
  id: string;
  role: MsgRole;
  text: string;
  head?: string;
}

export interface StyleQuestion {
  id: string;
  title: string;
  options: string[];
}

export interface ProductColor {
  name: string;
  hex: string;
}

export type Category = 'Tops' | 'Bottoms' | 'Outerwear' | 'Dresses';
export type Dept = 'Mens' | 'Womens' | 'Unisex';
export type Palette = 'neutral' | 'earthy' | 'bold';
export type Occasion =
  | 'going-out'
  | 'everyday'
  | 'cold-weather'
  | 'workwear'
  | 'active';

export interface Product {
  id: string;
  name: string;
  price: number;
  category: Category;
  dept: Dept;
  occasions: Occasion[];
  palette: Palette;
  colors: ProductColor[];
  sizes: string[];
  blurb: string;
  reason?: string; // filled in by the stylist to explain the pick
}

export interface BagItem {
  key: string; // productId|size|color
  productId: string;
  name: string;
  price: number;
  size: string;
  color: string;
  category: string;
  qty: number;
}

export interface AnfState {
  phase: AnfPhase;
  messages: AnfMessage[];
  quizQuestions: StyleQuestion[];
  quizAnswers: Record<string, string>;
  recommended: Product[];
  heroReason: string;
  bag: BagItem[];
  isThinking: boolean;
  orderId: string | null;
}

export const INITIAL_STATE: AnfState = {
  phase: 'intro',
  messages: [
    {
      id: 'welcome',
      role: 'ai',
      text: "Hey — welcome to Abercrombie & Fitch. I'm your personal stylist. Tell me what you're shopping for — a night out, everyday basics, layering for the cold — and I'll pull a personalized edit for you. What's the occasion?",
    },
  ],
  quizQuestions: [],
  quizAnswers: {},
  recommended: [],
  heroReason: '',
  bag: [],
  isThinking: false,
  orderId: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────
export function formatUSD(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return '—';
  if (n === 0) return 'Free';
  return '$' + n.toFixed(2).replace(/\.00$/, '');
}

export const FREE_SHIP_THRESHOLD = 75;
export const MEMBER_DISCOUNT = 0.15;

export interface BagTotals {
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  itemCount: number;
}

export function calcTotals(bag: BagItem[]): BagTotals {
  const subtotal = bag.reduce((s, i) => s + i.price * i.qty, 0);
  const itemCount = bag.reduce((s, i) => s + i.qty, 0);
  const discount = subtotal * MEMBER_DISCOUNT;
  const afterDiscount = subtotal - discount;
  const shipping =
    subtotal === 0 || afterDiscount >= FREE_SHIP_THRESHOLD ? 0 : 7;
  const total = afterDiscount + shipping;
  return { subtotal, discount, shipping, total, itemCount };
}
