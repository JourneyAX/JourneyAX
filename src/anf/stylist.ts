import { CATALOG } from './catalog';
import {
  Product,
  StyleQuestion,
  Occasion,
  Palette,
  Dept,
  Category,
  AnfPhase,
} from './types';

// ─── Style quiz shown on the right panel ────────────────────────────────
export const QUIZ: StyleQuestion[] = [
  { id: 'dept', title: "Who are we styling?", options: ['Menswear', 'Womenswear', 'Everyone'] },
  { id: 'occasion', title: "What's the vibe?", options: ['A night out', 'Everyday basics', 'Cold-weather layers', 'Work & polished'] },
  { id: 'palette', title: 'Your color story?', options: ['Clean neutrals', 'Warm earth tones', 'Bold statement'] },
  { id: 'focus', title: 'Where should I focus?', options: ['Tops', 'Bottoms', 'Outerwear', 'A full look'] },
];

// ─── Answer → tag maps ──────────────────────────────────────────────────
const OCCASION_MAP: Record<string, Occasion> = {
  'A night out': 'going-out',
  'Everyday basics': 'everyday',
  'Cold-weather layers': 'cold-weather',
  'Work & polished': 'workwear',
};

const PALETTE_MAP: Record<string, Palette> = {
  'Clean neutrals': 'neutral',
  'Warm earth tones': 'earthy',
  'Bold statement': 'bold',
};

const DEPT_MAP: Record<string, Dept | null> = {
  Menswear: 'Mens',
  Womenswear: 'Womens',
  Everyone: null,
};

const FOCUS_MAP: Record<string, Category | null> = {
  Tops: 'Tops',
  Bottoms: 'Bottoms',
  Outerwear: 'Outerwear',
  'A full look': null,
};

const OCCASION_PHRASE: Record<Occasion, string> = {
  'going-out': 'a night out',
  everyday: 'your everyday rotation',
  'cold-weather': 'cold-weather layering',
  workwear: 'a polished workday',
  active: 'an active day',
};

const PALETTE_PHRASE: Record<Palette, string> = {
  neutral: 'clean neutrals',
  earthy: 'warm earth tones',
  bold: 'bolder statement pieces',
};

export interface Prefs {
  occasion: Occasion;
  palette: Palette;
  dept: Dept | null;
  focus: Category | null;
}

function prefsFromAnswers(answers: Record<string, string>): Prefs {
  return {
    occasion: OCCASION_MAP[answers.occasion] ?? 'everyday',
    palette: PALETTE_MAP[answers.palette] ?? 'neutral',
    dept: DEPT_MAP[answers.dept] ?? null,
    focus: FOCUS_MAP[answers.focus] ?? null,
  };
}

function scoreProduct(p: Product, prefs: Prefs): number {
  // Exclude department-specific pieces that don't match the shopper.
  if (prefs.dept && p.dept !== 'Unisex' && p.dept !== prefs.dept) {
    return -Infinity;
  }
  let score = 0;
  if (p.occasions.includes(prefs.occasion)) score += 3;
  if (p.palette === prefs.palette) score += 2;
  if (prefs.dept && (p.dept === prefs.dept || p.dept === 'Unisex')) score += 1;
  if (prefs.focus && p.category === prefs.focus) score += 2;
  // Small nudge toward versatile everyday pieces so results never feel empty.
  if (p.occasions.includes('everyday')) score += 0.5;
  return score;
}

function buildReason(p: Product, prefs: Prefs): string {
  const bits: string[] = [];
  if (p.occasions.includes(prefs.occasion)) {
    bits.push(`Made for ${OCCASION_PHRASE[prefs.occasion]}`);
  } else {
    bits.push('A versatile anchor for the look');
  }
  if (p.palette === prefs.palette) {
    bits.push(`sits right in your ${PALETTE_PHRASE[prefs.palette]}`);
  }
  return bits.join(', ') + '.';
}

export function recommend(answers: Record<string, string>): Product[] {
  const prefs = prefsFromAnswers(answers);

  const scored = CATALOG.map((p) => ({ p, s: scoreProduct(p, prefs) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s);

  let picks: Product[];

  if (prefs.focus === null) {
    // A full look — guarantee variety across categories.
    const chosen: Product[] = [];
    const wanted: Category[] = ['Tops', 'Bottoms', 'Outerwear', 'Dresses'];
    for (const cat of wanted) {
      const best = scored.find(
        (x) => x.p.category === cat && !chosen.includes(x.p)
      );
      if (best) chosen.push(best.p);
    }
    for (const x of scored) {
      if (chosen.length >= 6) break;
      if (!chosen.includes(x.p)) chosen.push(x.p);
    }
    picks = chosen.slice(0, 6);
  } else {
    picks = scored.slice(0, 5).map((x) => x.p);
  }

  return picks.map((p) => ({ ...p, reason: buildReason(p, prefs) }));
}

export function curationHeadline(answers: Record<string, string>): string {
  const prefs = prefsFromAnswers(answers);
  const who = prefs.dept === 'Mens' ? "Men's" : prefs.dept === 'Womens' ? "Women's" : 'Your';
  return `${who} edit — ${OCCASION_PHRASE[prefs.occasion]}, ${PALETTE_PHRASE[prefs.palette]}`;
}

// ─── Free-text intent detection ─────────────────────────────────────────
export interface Intent {
  occasion?: Occasion;
  dept?: Dept;
  category?: Category;
}

export function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  const intent: Intent = {};

  if (/(night out|going out|party|date|club|dinner|drinks|event|wedding)/.test(t)) intent.occasion = 'going-out';
  else if (/(cold|winter|snow|layer|warm|coat|freezing)/.test(t)) intent.occasion = 'cold-weather';
  else if (/(work|office|polished|professional|interview|meeting|business)/.test(t)) intent.occasion = 'workwear';
  else if (/(everyday|casual|basic|daily|weekend|lounge|comfy)/.test(t)) intent.occasion = 'everyday';

  if (/(\bmen'?s?\b|guy|male|him|boyfriend|husband)/.test(t)) intent.dept = 'Mens';
  else if (/(\bwomen'?s?\b|female|her|girlfriend|wife|dress|skirt)/.test(t)) intent.dept = 'Womens';

  if (/(tee|shirt|hoodie|sweater|knit|top|button)/.test(t)) intent.category = 'Tops';
  else if (/(jean|pant|trouser|cargo|jogger|skirt|denim)/.test(t)) intent.category = 'Bottoms';
  else if (/(jacket|coat|vest|puffer|outer)/.test(t)) intent.category = 'Outerwear';
  else if (/(dress)/.test(t)) intent.category = 'Dresses';

  return intent;
}

// Reorder quiz options so a detected preference is offered first.
export function tailorQuiz(intent: Intent): StyleQuestion[] {
  return QUIZ.map((q) => {
    if (q.id === 'occasion' && intent.occasion) {
      const label = Object.keys(OCCASION_MAP).find((k) => OCCASION_MAP[k] === intent.occasion);
      if (label) return { ...q, options: [label, ...q.options.filter((o) => o !== label)] };
    }
    if (q.id === 'dept' && intent.dept) {
      const label = Object.keys(DEPT_MAP).find((k) => DEPT_MAP[k] === intent.dept);
      if (label) return { ...q, options: [label, ...q.options.filter((o) => o !== label)] };
    }
    if (q.id === 'focus' && intent.category) {
      return { ...q, options: [intent.category, ...q.options.filter((o) => o !== intent.category)] };
    }
    return q;
  });
}

// ─── Orchestrator for a free-text chat message ──────────────────────────
export interface StylistResult {
  reply: string;
  note?: string;
  phase?: AnfPhase;
  quiz?: StyleQuestion[];
  gotoBag?: boolean;
  gotoProducts?: boolean;
  reset?: boolean;
}

export function runStylist(
  userText: string,
  ctx: { phase: AnfPhase; hasBag: boolean; hasRecs: boolean }
): StylistResult {
  const t = userText.toLowerCase().trim();

  if (/(start over|reset|restart|new edit|clear)/.test(t)) {
    return {
      reply: "Fresh start! Tell me the occasion and I'll pull a brand-new edit for you.",
      reset: true,
    };
  }

  if (/(checkout|check out|place order|buy|pay)/.test(t)) {
    if (ctx.hasBag) return { reply: "Great — I've pulled up your bag on the right. Review it and place your order when you're ready.", phase: 'bag', gotoBag: true };
    return { reply: "Your bag is empty right now. Let's find a few pieces first — what's the occasion?" };
  }

  if (/(bag|cart|basket)/.test(t)) {
    if (ctx.hasBag) return { reply: "Here's your bag on the right.", phase: 'bag', gotoBag: true };
    return { reply: "Nothing in your bag yet. Want me to style an edit? Just tell me the vibe." };
  }

  if (/(show|see|recommend|edit|product|options|again)/.test(t) && ctx.hasRecs) {
    return { reply: "Here's your edit again on the right.", phase: 'products', gotoProducts: true };
  }

  // Default: treat the message as a styling brief and open the style quiz.
  const intent = detectIntent(userText);
  const quiz = tailorQuiz(intent);
  let reply: string;
  if (intent.occasion) {
    reply = `Love it — ${OCCASION_PHRASE[intent.occasion]}. I've got a few quick style questions on the right to dial in your edit. Answer those and I'll pull your pieces.`;
  } else {
    reply = "On it. I've popped a few quick style questions on the right — answer those and I'll curate a personalized edit for you.";
  }
  return { reply, phase: 'style', quiz };
}
