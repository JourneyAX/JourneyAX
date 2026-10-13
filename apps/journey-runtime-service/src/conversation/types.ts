export interface Product {
  sku: string;
  title: string;
  description?: string;
  brand?: string;
  category?: string;
  price?: number;
  currency?: string;
  attributes?: Record<string, unknown>;
  features?: unknown;
  specifications?: unknown;
  [key: string]: unknown;
}

/** What answering an option tells us: words to look for, a brand, a price range, or "no preference". */
export interface Constraint { terms?: string[]; brand?: string; priceMin?: number; priceMax?: number; any?: boolean }
export interface QuestionOption { value: string; label: string; constraint?: Constraint }
export interface QuestionPlan {
  source: 'okf' | 'facet';
  factKey: string;
  question: string;
  uiInputType: string;
  options: QuestionOption[];
}

/** Everything remembered about what the customer wants, kept in the workspace between turns. */
export interface ConversationState {
  conceptId?: string;
  /** Stemmed words the customer used to say what they need. */
  terms: string[];
  /** stem → the word the customer actually used, for saying it back. */
  surfaces: Record<string, string>;
  constraints: { brands: string[]; priceMin?: number; priceMax?: number };
  /** Kinds of question already asked for this concept; each kind is asked at most once. */
  asked: string[];
  /** The question on screen, so a tapped answer can be read next turn. */
  pending?: QuestionPlan;
}

export interface PlannedProduct {
  item: Product;
  score: number;
  /** The customer's words (stems) this product's own text matched. */
  matched: string[];
  why?: { needs: string[]; excerpt?: string };
}

export type ConversationAction = 'ask' | 'recommend' | 'show' | 'answer' | 'defer';

export interface ConversationPlan {
  action: ConversationAction;
  /** Why this action, in order: the rules that decided it. Goes to the trace, never to the customer. */
  because: string[];
  /** The customer's needs, in their own words. */
  needs: string[];
  products: PlannedProduct[];
  question?: QuestionPlan;
  showCards: { question: boolean; products: boolean; suggestions: boolean };
  /** The sentence for the customer, when the platform words this turn itself (otherwise the model does). */
  message?: string;
  heading?: string;
  eyebrow?: string;
  nextState: ConversationState;
}
