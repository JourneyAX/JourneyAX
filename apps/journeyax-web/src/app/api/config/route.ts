/**
 * Public storefront config — the customer-facing subset of the project's config
 * (theme, labels, brand name, greeting), fetched from project-service. The
 * storefront applies this at load so the SAME app renders each tenant's brand and
 * vocabulary. The tenant is resolved PER REQUEST (multi-storefront routing):
 * ?project= param → X-Tenant-ID header → Host domain → env fallback.
 */
import { resolveTenant } from '../../../lib/tenant';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';

export async function GET(req: Request) {
  const PROJECT_ID = await resolveTenant(req);
  try {
    // PUBLISHED config, not the live draft (FR-CONFIG-002) — back-office edits reach
    // customers only after Publish. Server falls back to draft pre-first-publish.
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(PROJECT_ID)}/published`, {
      headers: { 'X-Tenant-ID': PROJECT_ID },
      cache: 'no-store',
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) {
        return json({ error: 'ProjectNotFound', message: 'This project is currently disabled or does not exist.' });
      }
      return json(fallback(PROJECT_ID));
    }
    const p: any = await res.json();
    return json({
      projectId: p.projectId || PROJECT_ID,
      companyName: p.companyName || 'JourneyAX',
      theme: p.theme || {},
      labels: {
        items: p?.labels?.items || 'Products',
        itemsSingular: p?.labels?.itemsSingular || 'Product',
        headerTitle: p?.labels?.headerTitle || 'AI Configurator',
      },
      greeting: p?.persona?.greetingMessage || '',
      systemName: p?.persona?.systemName || '',
      capabilities: Array.isArray(p?.capabilities) ? p.capabilities : [],
      // Commerce surface — DECLARED per brand ('cart' B2C vs 'quote' B2B). Default
      // 'quote' so existing fixtures/kit tenants are unchanged when unset.
      commerceMode: p?.commerceMode === 'cart' ? 'cart' : 'quote',
      configurator: p?.configurator?.enabled ? p.configurator : null,
      // Opening-screen copy — starters + input placeholder, set per tenant in the
      // back office (no hardcoded generic example).
      intro: p?.intro && typeof p.intro === 'object' ? {
        starters: Array.isArray(p.intro.starters)
          ? p.intro.starters.filter((s: any) => s && s.label && s.prompt).map((s: any) => ({ label: String(s.label), prompt: String(s.prompt) }))
          : undefined,
        inputPlaceholder: typeof p.intro.inputPlaceholder === 'string' ? p.intro.inputPlaceholder : undefined,
        heroHeadline: typeof p.intro.heroHeadline === 'string' ? p.intro.heroHeadline : undefined,
        heroSubtitle: typeof p.intro.heroSubtitle === 'string' ? p.intro.heroSubtitle : undefined,
      } : null,
      components: p?.components || null,
      multiTradeBundles: p?.multiTradeBundles || null,
      // Card CMS (v3 — docs/v3-card-cms-architecture.md): the three theme layers
      // pass straight through from the published snapshot. `uiTheme` → --jx-* vars
      // + per-card settings; `cardTemplates` → tenant json-render overrides
      // (resolveTemplate falls back to DEFAULT_TEMPLATES); `fulfilment` → mode,
      // labels and the branch list the quote/cart cards offer via selectBranch.
      uiTheme: p?.uiTheme && typeof p.uiTheme === 'object' ? p.uiTheme : null,
      cardTemplates: p?.cardTemplates && typeof p.cardTemplates === 'object' ? p.cardTemplates : null,
      fulfilment: p?.fulfilment && typeof p.fulfilment === 'object' ? p.fulfilment : null,
      // Quote card copy (mapQuoteCard's sub/compliance) — real config, not a
      // tenant-name literal in the panel. Absent = the card's generic default.
      quoteIntro: typeof p?.quoteIntro === 'string' ? p.quoteIntro : null,
      complianceBadge: typeof p?.complianceBadge === 'string' ? p.complianceBadge : null,
    });
  } catch {
    return json(fallback(PROJECT_ID));
  }
}

function fallback(projectId: string) {
  if (projectId === 'placemakers') {
    return {
      projectId: 'placemakers',
      companyName: 'PlaceMakers (Fletcher Building)',
      theme: {
        primaryColor: '#E31E24',
        accentColor: '#111111',
        fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
        logoUrl: '/brands/placemakers.png',
        visualizerEnabled: true,
      },
      labels: { items: 'Trade Building Products', itemsSingular: 'Product', headerTitle: 'PlaceMakers Project Consultant' },
      greeting: "Kia ora! I'm your PlaceMakers project and materials consultant. Whether you're planning a complete laundry or bathroom makeover, building a compliant deck, or estimating materials across our branches, how can I help you today?",
      systemName: 'PlaceMakers Consultant',
      capabilities: ['products', 'quote', 'steps', 'installGuide', 'warranty', 'buildProjectPlan', 'checkBranchStock', 'openSpacePlanner'],
      commerceMode: 'quote',
      components: {
        productCard: { layout: 'technical', showBranchStock: true, showSpecs: true },
        quoteCard: { layout: 'multi-trade-bom', showTradeDiscounts: true, fulfillmentOptions: ['branch-pickup', 'delivery', 'trade-dispatch'], defaultBranch: 'Mount Wellington / Cook St' },
        spacePlanner: { enabled: true, roomTypes: ['laundry', 'bathroom', 'decking'], defaultRoom: 'laundry' },
      },
      intro: {
        heroHeadline: 'Build it right with PlaceMakers.',
        heroSubtitle: 'Instant multi-trade material estimation, compliant project packs, and 60-minute branch pickup.',
        inputPlaceholder: 'e.g. I want to plan a complete laundry makeover for a 2.4m space...',
        starters: [
          { label: '🧺 Laundry Room Makeover', prompt: 'I want to do a complete laundry room makeover with cabinetry, tub, and wall linings.' },
          { label: '🪵 Kwila Deck Estimator', prompt: 'Estimate Kwila decking, SG8 framing, and stainless screws for a 5m x 4m deck.' },
          { label: '🛁 GIB Aqualine & Wet Walls', prompt: 'What moisture-resistant linings and waterproofing do I need for my wet area?' },
          { label: '📍 Branch Stock Check', prompt: 'Check stock availability for Robinhood SuperTub and GIB Aqualine at Mt Wellington branch.' },
        ],
      },
      uiTheme: null,
      cardTemplates: null,
      // Branch list the storefront used to hardcode (QuotePanel PM_BRANCHES) —
      // now config so the quote card reads `cfg.fulfilment.branches`. `id` keeps
      // the value the branch-stock endpoint already understands.
      fulfilment: {
        mode: 'both',
        label: 'Branch fulfilment & pickup',
        badge: '60-min Click & Collect',
        branches: [
          { id: 'Mt Wellington', name: 'PlaceMakers Mount Wellington', address: '106 Carbine Rd' },
          { id: 'Cook Street', name: 'PlaceMakers Cook Street', address: '124 Cook St' },
          { id: 'Albany', name: 'PlaceMakers Albany', address: '21 Corinthian Dr' },
          { id: 'Te Rapa', name: 'PlaceMakers Te Rapa', address: 'Maui St' },
          { id: 'Petone', name: 'PlaceMakers Petone', address: '43 Bouverie St' },
          { id: 'Riccarton', name: 'PlaceMakers Riccarton', address: 'Mandeville St' },
        ],
      },
      // Real quote-card copy (mapQuoteCard's sub/compliance) — was hardcoded
      // `isPlaceMakers` text inside QuotePanel.tsx; now config, same as fulfilment above.
      quoteIntro: 'Review your PlaceMakers materials list below. Select branch fulfillment or site delivery before placing your order.',
      complianceBadge: 'NZ Building Code Verified',
    };
  }

  return {
    projectId,
    companyName: 'JourneyAX',
    theme: {},
    labels: { items: 'Products', itemsSingular: 'Product', headerTitle: 'AI Configurator' },
    greeting: '',
    systemName: '',
    commerceMode: 'quote',
    components: null,
    multiTradeBundles: null,
    uiTheme: null,
    cardTemplates: null,
    fulfilment: null,
    quoteIntro: null,
    complianceBadge: null,
  };
}

function json(data: any, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
  });
}
