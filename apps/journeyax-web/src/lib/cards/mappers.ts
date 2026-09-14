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
  WarrantyInfo, SizeRecommendation, ProjectPlan, JourneyState,
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

export function mapProductsCard(products: RecommendedProduct[], heading?: string) {
  return {
    heading,
    products: products.map((p, i) => ({
      sku: p.sku || `unsku-${i}`,
      title: p.name,
      description: p.description,
      imageUrl: p.imageUrl || null,
      price: p.price ?? null,
      category: p.category,
      url: p.url,
      specs: p.specs,
      recommended: i === 0,
      reason: i === 0 ? undefined : p.description,
    })),
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
    eyebrow: `Project Quote · Live · Job ID: ${quote.quoteId}`,
    sub: opts.quoteIntro || 'Review your order below — I’ll re-validate and re-price as you go.',
    compliance: opts.complianceBadge || 'Compatibility validated',
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

export function mapClarifyCard(questions: DynamicQuestion[]) {
  return { questions: questions.slice(0, 3).map((q) => ({ id: q.id, text: q.title, options: q.options })) };
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
