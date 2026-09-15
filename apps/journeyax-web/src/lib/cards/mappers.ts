/**
 * Legacy state → CardInstance mappers (v3 Card CMS, docs/v3-card-cms-architecture.md).
 *
 * The agent still emits the same 17 tool calls it always has; JourneyContext's
 * reducer keeps setting the legacy fields (recommendedProducts, serverQuote, …)
 * so nothing on the old panels regresses. These pure functions turn that
 * legacy state into a `CardInstance['state']` shaped exactly like the zod
 * contract in `@journeyax/ui-cards`'s `CARD_TYPES`, so it can render through
 * `resolveTemplate` + `CardRenderer` instead of a bespoke component.
 *
 * Money is never recomputed here — every number comes straight from
 * `ServerQuote` / `RecommendedProduct`, which are themselves server-authoritative.
 */
import type {
  RecommendedProduct, ServerQuote, GuideStep, AccessoryItem, DynamicQuestion,
  WarrantyInfo, SizeRecommendation, ProjectPlan, JourneyState, ComparisonData, BundleData,
} from '@/lib/types';
import type { FulfilmentConfig } from '@/context/StorefrontConfigContext';

const fmtMoney = (n: number | undefined | null, currency: string, symbol?: string) => {
  if (n === undefined || n === null) return undefined;
  return symbol ? `${symbol}${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
};

const stockLabel = (l: { inStock?: boolean; branchStock?: { status: string; clickAndCollectReady: boolean; collectionTimeframe: string } }) => {
  if (l.branchStock) return `${l.branchStock.status}${l.branchStock.clickAndCollectReady ? ` · ${l.branchStock.collectionTimeframe}` : ''}`;
  return l.inStock === false ? 'Out of stock' : l.inStock === true ? 'In stock' : undefined;
};

/** A model occasionally puts a refusal ("I'm sorry, but I can't assist with
 *  that request.") in the per-item `description` slot instead of a reason.
 *  That is not a reason to buy anything — hide it rather than print it. */
const REFUSAL_RE = /^\s*(?:i['’]m sorry|i am sorry|sorry[,.]|i can(?:no|['’])t (?:assist|help)|i['’]m unable|as an ai)/i;
const usableReason = (s?: string | null, title?: string) => {
  if (!s || REFUSAL_RE.test(s)) return undefined;
  // A "reason" that merely repeats the product name says nothing — hide it.
  if (title && s.trim().toLowerCase() === title.trim().toLowerCase()) return undefined;
  return s;
};

export function mapProductsCard(products: RecommendedProduct[], heading?: string, closing: 'bag' | 'quote' = 'quote') {
  // A catalogue with no real photography often points every product at the
  // same "no image" placeholder. One identical picture repeated across the
  // whole set says nothing about any product — drop it and let the tile fall
  // back to its icon (data-driven; no tenant URL pattern baked in here).
  // One tile per SKU — a duplicate row from retrieval also duplicated a React key.
  const seen = new Set<string>();
  const list = products.filter((p) => { const k = String(p.sku || '').toUpperCase(); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });
  const urls = list.map((p) => p.imageUrl).filter(Boolean) as string[];
  const sharedPlaceholder = list.length > 1 && urls.length === list.length && new Set(urls).size === 1;
  return {
    heading,
    closing,
    products: list.map((p, i) => ({
      sku: p.sku || `unsku-${i}`,
      title: p.name,
      description: usableReason(p.description, p.name),
      imageUrl: sharedPlaceholder ? null : p.imageUrl || null,
      price: p.price ?? null,
      category: p.category,
      url: p.url,
      specs: p.specs,
      recommended: i === 0,
      // `description` IS the agent's own stated reason this product fits the
      // request (RecommendedProduct's own doc comment) — show it on every
      // card, the top recommendation MOST of all. Withholding it from i===0
      // was backwards: a customer sees "Recommended" on the one item with no
      // stated reason why, while every other item explains itself.
      reason: usableReason(p.description, p.name),
    })),
  };
}

/** Comparison card: the agent's dimensions × SKUs matrix, with each column
 *  headed by the real product (title joined from what was shown this
 *  conversation — the model never re-types a name). */
export function mapComparisonCard(cmp: ComparisonData, shown: RecommendedProduct[]) {
  const bySku = new Map(shown.filter((p) => p.sku).map((p) => [String(p.sku).toUpperCase(), p]));
  const joined = new Map((cmp.products || []).map((p) => [String(p.sku).toUpperCase(), p]));
  const products = cmp.skus.map((sku) => {
    const key = String(sku).toUpperCase();
    const s = joined.get(key);   // server-joined catalogue facts win
    const p = bySku.get(key);    // else what was shown this conversation
    if (s && (s.title || s.name)) return { sku, title: String(s.title || s.name), imageUrl: s.imageUrl || null, price: s.price ?? null, category: s.category, url: s.url };
    return p
      ? { sku, title: p.name, imageUrl: p.imageUrl || null, price: p.price ?? null, category: p.category, url: p.url, specs: p.specs }
      : { sku, title: sku };
  });
  const rows = cmp.dimensions.map((d, i) => [d, ...(cmp.rows[i] || []).map((c) => (c === undefined ? null : c))]);
  return {
    products,
    dimensions: cmp.dimensions,
    rows,
    columns: ['', ...products.map((p) => p.title)],
    verdict: usableReason(cmp.verdict),
  };
}

/** Bundle card: the agent's coordinated set, every fact already server-joined. */
export function mapBundleCard(b: BundleData, closing: 'bag' | 'quote' = 'quote') {
  const currency = b.totals?.currency || b.items.find((i) => i.currency)?.currency;
  return {
    heading: b.heading,
    why: usableReason(b.why),
    closing,
    items: b.items.map((i) => ({
      sku: i.sku, title: i.title, price: i.price ?? null, currency: i.currency || currency, imageUrl: i.imageUrl || null,
      url: i.url, category: i.category, quantity: i.quantity ?? 1, reason: usableReason(i.reason, i.title), stockLabel: i.stockLabel,
    })),
    totals: b.totals ? { subtotal: b.totals.subtotal, total: b.totals.total, currency: b.totals.currency } : undefined,
  };
}

export function mapQuoteCard(quote: ServerQuote, opts: {
  fulfilment?: FulfilmentConfig | null;
  selectedBranch?: string;
  selectedBranchName?: string;
  /** Config-driven quote copy (project.quoteIntro/complianceBadge) — replaces
   *  what used to be `cfg.projectId === 'placemakers'` text baked into
   *  QuotePanel.tsx. Absent = the card's own generic default. */
  quoteIntro?: string | null;
  /** 'bag' for a retail tenant — the card then reads as a bag, not a project quote with a job id. */
  closing?: 'bag' | 'quote';
  complianceBadge?: string | null;
} = {}) {
  const branches = opts.fulfilment?.branches || [];
  const readyCount = quote.lines.filter((l) => l.branchStock?.clickAndCollectReady ?? l.inStock).length;
  const status = opts.selectedBranchName
    ? `Checked — ${readyCount} of ${quote.lines.length} item${quote.lines.length === 1 ? '' : 's'} ready for Click & Collect at ${opts.selectedBranchName}`
    : undefined;
  return {
    quoteId: quote.quoteId,
    heading: quote.title,
    eyebrow: opts.closing === 'bag'
      ? `Your bag · ${quote.lines.length} item${quote.lines.length === 1 ? '' : 's'}`
      : `Project Quote · Live · Job ID: ${quote.quoteId}`,
    sub: opts.quoteIntro || (opts.closing === 'bag'
      ? 'Review what’s in your bag — prices and stock are checked live.'
      : 'Review your order below — I’ll re-validate and re-price as you go.'),
    compliance: opts.closing === 'bag' ? (opts.complianceBadge || undefined) : (opts.complianceBadge || 'Compatibility validated'),
    ctaLabel: opts.closing === 'bag' ? 'Checkout' : 'Approve & pay securely',
    linesLabel: opts.closing === 'bag' ? 'Items' : 'Bill of materials',
    lines: quote.lines.map((l) => ({
      sku: l.sku,
      title: l.name,
      imageUrl: l.imageUrl || null,
      price: l.unitPrice,
      currency: quote.currency,
      qty: l.quantity,
      lineTotal: l.lineTotal,
      note: l.reason,
      required: l.required,
      autoAdded: l.required,
      stockLabel: stockLabel(l),
      category: l.category,
      url: l.url,
    })),
    totals: {
      subtotal: quote.subtotal,
      discount: quote.discount || undefined,
      tax: quote.tax,
      taxLabel: `${Math.round((quote.taxRate || 0) * 100)}% tax`,
      total: quote.total,
      currency: quote.currency,
      subtotalLabel: fmtMoney(quote.subtotal, quote.currency, quote.symbol),
      discountLabel: quote.discount ? `-${fmtMoney(quote.discount, quote.currency, quote.symbol)}` : undefined,
      taxAmountLabel: fmtMoney(quote.tax, quote.currency, quote.symbol),
      totalLabel: fmtMoney(quote.total, quote.currency, quote.symbol),
    },
    fulfilment: branches.length
      ? {
          label: opts.fulfilment?.label || 'Fulfilment',
          badge: opts.fulfilment?.badge,
          options: branches.map((b) => ({ value: b.id, label: b.address ? `${b.name} (${b.address})` : b.name })),
          selected: opts.selectedBranch,
          status,
        }
      : undefined,
    notes: [
      quote.installationSummary ? { title: 'Installation', text: quote.installationSummary } : null,
      quote.warrantySummary ? { title: 'Warranty & compliance', text: quote.warrantySummary } : null,
    ].filter(Boolean) as { title: string; text: string }[],
    ordering: false,
  };
}

/** Patch-only shape for APPLY_QUOTE_BRANCH_STOCK — merged into an existing quote card. */
export function mapQuoteBranchPatch(quote: ServerQuote, opts: { fulfilment?: FulfilmentConfig | null; selectedBranch: string; selectedBranchName: string }) {
  const full = mapQuoteCard(quote, opts);
  return { lines: full.lines, fulfilment: full.fulfilment };
}

export function mapGuideCard(steps: GuideStep[], heading = 'Step-by-step guide') {
  return {
    heading,
    sections: [{ title: heading, body: '', steps: steps.map((s) => `${s.title} — ${s.description}`) }],
  };
}

export function mapAccessoriesCard(items: AccessoryItem[]) {
  const groupLabel: Record<AccessoryItem['group'], string> = {
    required: 'Required', recommended: 'Recommended', optional: 'Optional',
  };
  const byGroup: Record<string, AccessoryItem[]> = {};
  for (const it of items) (byGroup[it.group] ||= []).push(it);
  return {
    groups: (['required', 'recommended', 'optional'] as const)
      .filter((g) => byGroup[g]?.length)
      .map((g) => ({
        key: g,
        label: groupLabel[g],
        items: byGroup[g].map((it, i) => ({
          sku: it.sku || `${g}-${i}`,
          title: it.name,
          imageUrl: it.imageUrl || null,
          price: it.price ?? null,
          category: it.category,
          reason: it.reason,
        })),
      })),
  };
}

/** Clarify card state from the questions + whatever has been answered so far.
 *  Re-run on every tapped chip (CardStage patches the card with the result)
 *  so the chosen chip stays lit and the footer counts progress. */
export function mapClarifyCard(questions: DynamicQuestion[], answers: Record<string, string> = {}) {
  const qs = questions.slice(0, 3);
  const answered = qs.filter((q) => !!answers[q.id]).length;
  const total = qs.length;
  const left = total - answered;
  const progress = total === 0
    ? undefined
    : left === 0
      ? `All ${total === 1 ? 'set' : `${total} answered`} — sending your answers…`
      : total === 1
        ? 'Pick one to continue.'
        : `${answered} of ${total} answered — pick the ${left === 1 ? 'last one' : 'rest'} whenever you're ready, nothing sends until then.`;
  return {
    questions: qs.map((q) => ({ id: q.id, text: q.title, options: q.options, answer: answers[q.id] })),
    progress,
  };
}

export function mapWarrantyCard(w: WarrantyInfo) {
  const items: { title: string; text: string; url?: string }[] = [];
  if (w.standardWarranty) items.push({ title: w.productName ? `${w.productName} — standard warranty` : 'Standard warranty', text: w.standardWarranty });
  if (w.conditions) items.push({ title: 'Conditions', text: w.conditions });
  if (w.installationNote) items.push({ title: 'Installation', text: w.installationNote, url: w.documentUrl });
  if (w.extendedPackage) items.push({ title: w.extendedPackage.name, text: w.extendedPackage.summary || '' });
  return { items };
}

export function mapFitmentCard(s: SizeRecommendation) {
  return {
    recommendation: s.ok && s.recommendedSize ? `We recommend size ${s.recommendedSize}` : s.message,
    confidenceText: s.message,
    alternatives: s.availableSizes,
  };
}

export function mapPlanCard(plan: ProjectPlan) {
  return {
    heading: `${plan.projectName} — ${plan.dimensions}`,
    steps: [
      ...plan.materials.map((m) => ({
        title: `${m.name} × ${m.quantity} ${m.unit}`,
        detail: m.description,
        products: m.sku ? [{ sku: m.sku, title: m.name, price: m.estimatedUnitPriceNzd ?? null, currency: plan.currency }] : undefined,
      })),
      ...plan.toolsNeeded.map((t) => ({ title: `Tool: ${t}` })),
      ...plan.nzBuildingNotes.map((n) => ({ title: 'NZ Building code', detail: n })),
    ],
    totals: plan.totalEstimateNzd != null ? { subtotal: plan.totalEstimateNzd, total: plan.totalEstimateNzd, currency: plan.currency } : undefined,
  };
}

export function mapOrderStatusCard(order: NonNullable<JourneyState['placedOrder']>) {
  return {
    orderId: order.orderId,
    status: order.status,
    statusText: `Order ${order.orderId} is ${order.status}.`,
    placedAt: order.paidAt || undefined,
    lines: (order.lines || []).map((l) => ({
      sku: l.sku, title: l.name || l.sku, imageUrl: l.imageUrl || null,
      price: l.unitPrice ?? null, qty: l.quantity ?? 1, lineTotal: l.lineTotal,
    })),
    totals: order.total != null ? {
      subtotal: order.total, total: order.total, currency: order.currency || 'USD',
      totalLabel: order.symbol ? `${order.symbol}${order.total.toFixed(2)}` : `${order.total.toFixed(2)} ${order.currency || ''}`,
    } : undefined,
  };
}

export function mapHeroCard(intro: { heroHeadline?: string; heroSubtitle?: string; starters?: { label: string; prompt: string }[] } | null | undefined, companyName: string, greeting: string) {
  return {
    headline: intro?.heroHeadline || greeting || `Welcome to ${companyName}`,
    sub: intro?.heroSubtitle,
    chips: (intro?.starters || []).slice(0, 4).map((s) => s.label),
  };
}
