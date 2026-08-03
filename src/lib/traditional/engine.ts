/**
 * Traditional (non-LLM) JourneyAX engine.
 * Pure TypeScript rules — zero OpenAI tokens, deterministic responses.
 */

import { CATALOG, toRecommended, type CatalogProduct } from './catalog';
import { QUESTIONS, detectIntent, type Intent } from './questions';
import { pickGuide } from './guides';
import type { RecommendedProduct } from '@/lib/types';

export type { Intent };

export interface EngineState {
  phase?: string;
  bom?: Array<{ sku?: string; name?: string; price?: number; quantity?: number; category?: string; reason?: string; imageUrl?: string; required?: boolean }>;
  recommendedProducts?: RecommendedProduct[];
  finish?: string;
  qty?: number;
  answers?: Record<string, string>;
  lastIntent?: Intent;
}

export interface UiAction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface EngineResult {
  reply: string;
  uiActions: UiAction[];
  meta?: { intent: Intent; answers?: Record<string, string> };
}

function parseAnswersFromMessage(text: string): Record<string, string> {
  const answers: Record<string, string> = {};
  // Formats:
  // "My answers:\nQuestion → Answer"
  // "Build my quote with these selected items:\n- Main Product: X"
  const arrowLines = text.split('\n').map((l) => l.trim());
  for (const line of arrowLines) {
    const m = line.match(/^(.+?)\s*→\s*(.+)$/);
    if (m) {
      const title = m[1].replace(/\?$/, '').trim().toLowerCase();
      const value = m[2].trim();
      if (title.includes('renovat') || title.includes('building')) answers.mode = value;
      else if (title.includes('scope')) answers.scope = value;
      else if (title.includes('shower experience')) answers.shower = value;
      else if (title.includes('style')) answers.style = value;
      else if (title.includes('finish')) answers.finish = value;
      else if (title.includes('kitchen') || title.includes('need')) answers.need = value;
      else if (title.includes('laundry')) answers.need = value;
      else if (title.includes('happening') || title.includes('symptom')) answers.symptom = value;
      else if (title.includes('who will') || title.includes('fix it') || title.includes('diy')) answers.diy = value;
      else answers[title.slice(0, 24)] = value;
    }
  }
  return answers;
}

function styleKey(style?: string): CatalogProduct['styles'][number] {
  const s = (style || '').toLowerCase();
  if (s.includes('soft')) return 'soft';
  if (s.includes('minimal')) return 'minimalist';
  return 'any';
}

function showerKey(shower?: string): 'rain' | 'handheld' | 'combo' {
  const s = (shower || '').toLowerCase();
  if (s.includes('rail') && s.includes('overhead')) return 'combo';
  if (s.includes('rain')) return 'rain';
  if (s.includes('hand')) return 'handheld';
  return 'rain';
}

function matchProducts(intent: Intent, answers: Record<string, string>): CatalogProduct[] {
  const style = styleKey(answers.style);
  const finish = answers.finish;

  if (intent === 'kitchen') {
    const need = (answers.need || '').toLowerCase();
    return CATALOG.filter((p) => p.rooms.includes('kitchen')).filter((p) => {
      if (need.includes('mixer only')) return p.id === 'kitchen-mixer';
      return p.scopes.includes('kitchen');
    });
  }

  if (intent === 'laundry') {
    return CATALOG.filter((p) => p.rooms.includes('laundry'));
  }

  if (intent === 'bathroom_shower') {
    const sk = showerKey(answers.shower);
    const shower = CATALOG.filter(
      (p) => p.showerTypes?.includes(sk) && (p.styles.includes(style) || p.styles.includes('any'))
    );
    const mixer = CATALOG.filter((p) => p.id === 'mixer-shower');
    return [...shower, ...mixer].slice(0, 4);
  }

  // bathroom_full / default
  const scope = (answers.scope || 'The whole bathroom').toLowerCase();
  let products: CatalogProduct[] = [];

  if (scope.includes('just the shower')) {
    products = matchProducts('bathroom_shower', { ...answers, shower: answers.shower || 'Rain overhead' });
  } else if (scope.includes('shower + tapware')) {
    products = CATALOG.filter((p) =>
      ['shower-rain', 'mixer-shower', 'mixer-basin'].includes(p.id)
    );
  } else {
    products = CATALOG.filter((p) =>
      ['shower-combo', 'mixer-shower', 'basin-liano', 'mixer-basin', 'toilet-liano'].includes(p.id)
    );
  }

  // Prefer style match when available
  products = products.filter((p) => p.styles.includes(style) || p.styles.includes('any'));

  // Annotate preferred finish into description lightly
  if (finish && finish !== 'No preference') {
    products = products.map((p) => ({
      ...p,
      description: `${p.description} Preferred finish: ${finish}.`,
      finishes: p.finishes?.includes(finish) ? p.finishes : p.finishes,
    }));
  }

  return products.slice(0, 6);
}

function buildQuoteActions(
  products: RecommendedProduct[],
  answers: Record<string, string>,
  priorBom: EngineState['bom']
): UiAction[] {
  const items: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const pushItem = (item: {
    sku?: string;
    name: string;
    price?: number;
    category?: string;
    reason?: string;
    required?: boolean;
    imageUrl?: string;
  }) => {
    const key = item.sku || item.name;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      sku: item.sku || key,
      name: item.name,
      price: item.price ?? 0,
      quantity: 1,
      category: item.category || '',
      reason: item.reason || item.category || '',
      required: !!item.required,
      imageUrl: item.imageUrl,
    });
  };

  // Preserve prior BOM (multi-room)
  for (const b of priorBom || []) {
    pushItem({
      sku: b.sku,
      name: b.name || 'Item',
      price: b.price,
      category: b.category,
      reason: b.reason,
      required: b.required,
      imageUrl: b.imageUrl,
    });
  }

  for (const p of products) {
    pushItem({
      sku: p.sku,
      name: p.name,
      price: p.price,
      category: p.category,
      reason: 'Selected from your brief',
      imageUrl: p.imageUrl,
    });
    for (const part of p.installationParts || []) {
      pushItem({
        sku: part.sku,
        name: part.name,
        price: part.price,
        category: 'Installation',
        reason: part.required ? 'Mandatory installation part' : 'Recommended installation part',
        required: !!part.required,
      });
    }
    for (const acc of p.accessories || []) {
      // Only auto-include if user summary mentioned it; otherwise skip optional accs
      // (ProductsPanel sends selected accessories in the build-quote message)
      void acc;
    }
  }

  const finish = answers.finish || 'Chrome';
  const jobId = 'JOB-' + Math.floor(1000 + Math.random() * 9000);

  return [
    {
      name: 'updateQuote',
      arguments: {
        title: `Your ${answers.need || answers.scope || 'bathroom'} specification`,
        jobId,
        installationSummary:
          'Install in-wall bodies before tiling. Pressure-test rough-ins. Fit trims and outlets after tiling. Seal wet-area penetrations and commission mixers.',
        warrantySummary: `Tapware typically carries up to 20-year warranty coverage. Finish selected: ${finish}. Confirm exact warranty lines on each product sheet.`,
        items,
      },
    },
    { name: 'setPhase', arguments: { phase: 'quote' } },
  ];
}

function warrantyLookup(text: string): EngineResult {
  const skuMatch = text.toUpperCase().match(/\b[A-Z0-9]{5,}\b/);
  const sku = skuMatch?.[0];
  const product =
    CATALOG.find((p) => p.sku?.toUpperCase() === sku) ||
    CATALOG.find((p) => p.id === 'basin-liano')!;

  const products = [toRecommended(product)];
  if (product.accessories?.length) {
    // keep accessories on the card
  }

  return {
    reply: `${product.name}${product.sku ? ` (${product.sku})` : ''}: ${Object.entries(product.specs || {})
      .map(([k, v]) => `${k} — ${v}`)
      .join('; ')}. I've put the product and matching accessories on the right.`,
    uiActions: [
      { name: 'showProducts', arguments: { products } },
      { name: 'setPhase', arguments: { phase: 'products' } },
    ],
    meta: { intent: 'warranty' },
  };
}

function extractSelectedAccessoryNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/\[Accessory\]\s+(.+)$/);
    if (m) names.push(m[1].trim());
  }
  return names;
}

function extractMainProductNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/Main Product:\s+(.+)$/);
    if (m) names.push(m[1].trim());
  }
  return names;
}

/**
 * Run one traditional turn. No network, no LLM, no tokens.
 */
export function runTraditional(userText: string, state: EngineState = {}): EngineResult {
  const text = userText.trim();
  const lower = text.toLowerCase();

  // ── Build quote from products panel ─────────────────────────────────
  if (lower.includes('build my quote')) {
    const selectedAccs = extractSelectedAccessoryNames(text);
    const mainNames = extractMainProductNames(text);
    let products = state.recommendedProducts || [];
    if (mainNames.length) {
      const fromCatalog = CATALOG.filter((p) => mainNames.some((n) => p.name === n)).map(toRecommended);
      if (fromCatalog.length) products = fromCatalog;
    }
    // Attach selected accessories as extra BOM lines via installationParts hack on clones
    const withAccs = products.map((p) => ({
      ...p,
      accessories: (p.accessories || []).filter((a) => selectedAccs.includes(a.name)),
      installationParts: [
        ...(p.installationParts || []),
        ...(p.accessories || [])
          .filter((a) => selectedAccs.includes(a.name))
          .map((a) => ({ ...a, required: false })),
      ],
    }));

    const answers = { ...(state.answers || {}), finish: state.finish || state.answers?.finish || 'Chrome' };
    const uiActions = buildQuoteActions(withAccs, answers, state.bom);
    // Also show install guide before quote? Product requirement was install then quote in AI mode.
    // Traditional: quote immediately; offer guide next via reply.
    return {
      reply: `Quote ready — I've bundled primary products with mandatory installation parts${selectedAccs.length ? ' and your selected accessories' : ''}. Review the BOM on the right, then approve when you're happy.`,
      uiActions,
      meta: { intent: (state.lastIntent as Intent) || 'bathroom_full', answers },
    };
  }

  // ── Guide follow-ups ────────────────────────────────────────────────
  if (/\bhelp on step\b|\bwhat'?s next\b|\bi'?m stuck\b/i.test(text)) {
    return {
      reply:
        "Stay on the checklist on the right — tick each step as you go. If a cartridge swap is needed and you're not licensed, book a plumber for the isolation and replacement. Want me to build a parts quote for the mixer body/cartridge?",
      uiActions: [],
      meta: { intent: 'troubleshoot' },
    };
  }

  // ── Clarify answers submitted ───────────────────────────────────────
  if (lower.startsWith('my answers:')) {
    const answers = { ...(state.answers || {}), ...parseAnswersFromMessage(text) };
    const intent = state.lastIntent && state.lastIntent !== 'unknown' ? state.lastIntent : detectIntent(text);

    if (intent === 'troubleshoot') {
      const steps = pickGuide(answers, 'troubleshoot');
      const diy = (answers.diy || '').toLowerCase().includes('plumber')
        ? 'Since you want a plumber, use this checklist as a briefing sheet for the visit.'
        : 'DIY path selected — work safely, isolate water first, and stop if you hit licensed plumbing work.';
      return {
        reply: `${diy} I've opened a step-by-step guide on the right.`,
        uiActions: [
          { name: 'showGuide', arguments: { steps } },
          { name: 'setPhase', arguments: { phase: 'guide' } },
        ],
        meta: { intent: 'troubleshoot', answers },
      };
    }

    const matched = matchProducts(intent === 'unknown' ? 'bathroom_full' : intent, answers).map(toRecommended);
    const finishNote = answers.finish ? ` in ${answers.finish}` : '';
    return {
      reply: `Based on your answers, I've matched ${matched.length} product${matched.length === 1 ? '' : 's'}${finishNote}. Details are on the right — select any accessories, then build your quote.`,
      uiActions: [
        { name: 'showProducts', arguments: { products: matched } },
        { name: 'setPhase', arguments: { phase: 'products' } },
      ],
      meta: { intent: intent === 'unknown' ? 'bathroom_full' : intent, answers },
    };
  }

  // ── Warranty / SKU ──────────────────────────────────────────────────
  const intent = detectIntent(text);
  if (intent === 'warranty') {
    return warrantyLookup(text);
  }

  // ── Troubleshoot / install kickoff ──────────────────────────────────
  if (intent === 'troubleshoot') {
    // If they already described a clear drip, skip quiz and show guide
    if (/\bdrip|leak\b/i.test(text) && !/\bmy answers\b/i.test(text)) {
      return {
        reply:
          "Sounds like a shower drip/leak. Answer the quick questions on the right and I'll open the right checklist.",
        uiActions: [
          {
            name: 'setPhase',
            arguments: {
              phase: 'clarify',
              questions: QUESTIONS.troubleshoot,
            },
          },
        ],
        meta: { intent: 'troubleshoot', answers: { symptom: 'Drip / leak at shower' } },
      };
    }
    return {
      reply: "I've got a few quick questions on the right so I can open the right checklist.",
      uiActions: [
        {
          name: 'setPhase',
          arguments: { phase: 'clarify', questions: QUESTIONS.troubleshoot },
        },
      ],
      meta: { intent: 'troubleshoot' },
    };
  }

  // ── Configure journeys ──────────────────────────────────────────────
  if (intent === 'kitchen' || intent === 'laundry' || intent === 'bathroom_shower' || intent === 'bathroom_full') {
    return {
      reply: "I've got a few questions on the right to help me understand your needs.",
      uiActions: [
        {
          name: 'setPhase',
          arguments: { phase: 'clarify', questions: QUESTIONS[intent] },
        },
      ],
      meta: { intent },
    };
  }

  // ── Fallback help ───────────────────────────────────────────────────
  return {
    reply:
      "I can help without AI tokens — try: renovating a shower, speccing a full bathroom, kitchen sink & mixer, laundry tub, a drip/leak fix, or a SKU/warranty lookup.",
    uiActions: [{ name: 'setPhase', arguments: { phase: 'intro' } }],
    meta: { intent: 'unknown' },
  };
}
