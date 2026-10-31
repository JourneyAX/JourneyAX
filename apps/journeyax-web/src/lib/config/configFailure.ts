/**
 * What the storefront config route answers when the project's published configuration cannot be loaded.
 *
 * Kept out of the route file on purpose: a Next route file may export only its HTTP handlers and route settings, and `next build`
 * refuses one that exports anything else. The route and the architecture-closure test both import from here.
 */
import { resolveTenantRouting } from '../routing/cutover';

/**
 * Handles configuration load failure by checking cutover state.
 * A tenant with an active canonical pack/config must fail closed when loading it fails.
 * Legacy fallback is permitted ONLY when the cutover repository explicitly says that tenant is not activated.
 */
export async function handleConfigFailure(projectId: string): Promise<Response> {
  const routing = await resolveTenantRouting(projectId, 'production');
  if (routing.cutoverState === 'migrated') {
    return json(
      {
        error: 'CanonicalConfigurationUnavailable',
        message: `Canonical storefront configuration failed to load for activated tenant '${projectId}'. Legacy fallback is prohibited after canonical activation.`,
        tenantId: projectId,
        cutoverState: routing.cutoverState,
      },
      { status: 503 }
    );
  }

  return json(fallback(projectId));
}

function fallback(projectId: string) {
  if (projectId === 'placemakers') {
    return {
      projectId: 'placemakers',
      companyName: 'PlaceMakers (Fletcher Building)',
      theme: {
        primaryColor: '#002855',
        accentColor: '#FFD200',
        fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
        logoUrl: '/brands/placemakers.png',
        visualizerEnabled: true,
        sidebarStyle: 'dark',
        sidebarColor: '#002855',
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
      spacePlanner: null,
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
    spacePlanner: null,
    multiTradeBundles: null,
    uiTheme: null,
    cardTemplates: null,
    fulfilment: null,
    quoteIntro: null,
    complianceBadge: null,
  };
}

export function json(data: any, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
  });
}
