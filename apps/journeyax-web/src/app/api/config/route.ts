/**
 * Public storefront config — the customer-facing subset of the project's config
 * (theme, labels, brand name, greeting), fetched from project-service. The
 * storefront applies this at load so the SAME app renders each tenant's brand and
 * vocabulary. The tenant is resolved PER REQUEST (multi-storefront routing):
 * ?project= param → X-Tenant-ID header → Host domain → env fallback.
 */
import { resolveTenant } from '../../../lib/tenant';
import { handleConfigFailure, json } from '../../../lib/config/configFailure';
import { applyBrandOverlay, overlayFromEnv } from '../../../lib/brand/overlay';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';

export async function GET(req: Request) {
  const PROJECT_ID = await resolveTenant(req);
  const environment = process.env.COMMERCE_ENVIRONMENT || 'production';
  if (!['dev', 'test', 'staging', 'production'].includes(environment) || environment !== 'production' && !process.env.INTERNAL_API_KEY) return Response.json({ error: 'ConfigurationUnavailable' }, { status: 503 });
  try {
    // PUBLISHED config, not the live draft (FR-CONFIG-002) — back-office edits reach
    // customers only after Publish. Server falls back to draft pre-first-publish.
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(PROJECT_ID)}/published${environment === 'production' ? '' : `?environmentId=${environment}`}`, {
      headers: { 'X-Tenant-ID': PROJECT_ID, ...(environment !== 'production' ? { 'X-Internal-Key': process.env.INTERNAL_API_KEY! } : {}) },
      cache: 'no-store',
    });
    if (!res.ok) {
      if (environment !== 'production') return Response.json({ error: 'ConfigurationUnavailable' }, { status: 503 });
      if (res.status === 404 || res.status === 403) {
        return json({ error: 'ProjectNotFound', message: 'This project is currently disabled or does not exist.' });
      }
      return await handleConfigFailure(PROJECT_ID);
    }
    const p: any = await res.json();
    // With a brand overlay on (BRAND_OVERLAY) the config is shown under that brand; with it off the config is returned as it is.
    const overlay = overlayFromEnv();
    const shown = (config: Record<string, any>) => (overlay ? applyBrandOverlay(config, overlay) : config);
    return json(shown({
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
      checkoutReview: p?.extensions?.checkoutReview?.enabled === true,
      // What buyers often mention about a kind of product (pack extension buyerFeedback): shown on the product's details.
      buyerFeedback: Array.isArray(p?.extensions?.buyerFeedback?.rules)
        ? p.extensions.buyerFeedback.rules
            .filter((rule: any) => rule && Array.isArray(rule.when) && Array.isArray(rule.mentions))
            .map((rule: any) => ({
              when: rule.when.map(String),
              mentions: rule.mentions.map(String),
              ...(Array.isArray(rule.watchFor) ? { watchFor: rule.watchFor.map(String) } : {}),
            }))
        : [],
      payment: p?.extensions?.payment?.embedded === true
        ? { embedded: true, collectShipping: p.extensions.payment.collectShipping === true, shippingCountries: Array.isArray(p.extensions.payment.shippingCountries) ? p.extensions.payment.shippingCountries.map(String) : [] }
        : undefined,
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
      spacePlanner: p?.extensions?.spacePlanner || p?.experience?.spacePlanner || p?.spacePlanner || null,
      multiTradeBundles: p?.multiTradeBundles || null,
      // Card CMS (v3 — docs/v3-card-cms-architecture.md): the three theme layers
      // pass straight through from the published snapshot. `uiTheme` → --jx-* vars
      // + per-card settings; `cardTemplates` → tenant json-render overrides
      // (resolveTemplate falls back to DEFAULT_TEMPLATES); `fulfilment` → mode,
      // labels and the branch list the quote/cart cards offer via selectBranch.
      // The shop's own button, link and panel-header colours (pack extension brandTheme) sit on top of its brand colours.
      uiTheme: withBrandTheme(p?.uiTheme && typeof p.uiTheme === 'object' ? p.uiTheme : null, p?.extensions?.brandTheme),
      cardTemplates: p?.cardTemplates && typeof p.cardTemplates === 'object' ? p.cardTemplates : null,
      fulfilment: p?.fulfilment && typeof p.fulfilment === 'object' ? p.fulfilment : null,
      // Quote card copy (mapQuoteCard's sub/compliance) — real config, not a
      // tenant-name literal in the panel. Absent = the card's generic default.
      quoteIntro: typeof p?.quoteIntro === 'string' ? p.quoteIntro : null,
      complianceBadge: typeof p?.complianceBadge === 'string' ? p.complianceBadge : null,
      // Hand-offs to the tenant's own tools (custom print, configurator): the
      // product-detail card shows the button when a product matches a rule.
      handoffs: Array.isArray(p?.handoffs) ? p.handoffs.filter((h: any) => h && h.label && h.url && h.match).map((h: any) => ({ match: h.match, label: String(h.label), url: String(h.url), note: h.note ? String(h.note) : undefined })) : [],
      // Sample-customer demo: only the PUBLIC profile list reaches the browser
      // (name, country, role, scenario, suggested asks). Orders, offers and
      // inventory stay server-side and are read through the agent's tools,
      // bound to the profile the customer picks — never sent wholesale.
      demoCustomers: p?.demoCustomers?.enabled && Array.isArray(p.demoCustomers.profiles) ? {
        label: typeof p.demoCustomers.label === 'string' ? p.demoCustomers.label : 'Explore a sample customer',
        disclaimer: typeof p.demoCustomers.disclaimer === 'string' ? p.demoCustomers.disclaimer : 'Demo data — all customers, orders, prices and stock are fictional.',
        profiles: p.demoCustomers.profiles.filter((x: any) => x && x.id && x.name).map((x: any) => ({
          id: String(x.id), name: String(x.name), role: String(x.role || 'customer'),
          country: x.country ? String(x.country) : null, scenario: x.scenario ? String(x.scenario) : null,
          summary: x.summary ? String(x.summary) : null,
          tryAsking: Array.isArray(x.tryAsking) ? x.tryAsking.map(String) : [],
        })),
      } : null,
    }));
  } catch {
    if (environment !== 'production') return Response.json({ error: 'ConfigurationUnavailable' }, { status: 503 });
    return await handleConfigFailure(PROJECT_ID);
  }
}


const BRAND_KEYS = ['action', 'actionText', 'link', 'canvasHeader', 'canvasHeaderText'] as const;
function withBrandTheme(uiTheme: any, brand: any) {
  const picked: Record<string, string> = {};
  for (const key of BRAND_KEYS) if (typeof brand?.[key] === 'string' && /^#[0-9A-Fa-f]{6}$/.test(brand[key])) picked[key] = brand[key];
  if (Object.keys(picked).length === 0) return uiTheme;
  // The cards' main buttons (and the older storefront buttons that follow the same brand token) take the shop's button colour too.
  if (picked.action) { picked.brand = picked.action; if (picked.actionText) picked.brandText = picked.actionText; }
  if (picked.link) picked.accent = picked.link;
  const tokens = uiTheme?.tokens && typeof uiTheme.tokens === 'object' ? uiTheme.tokens : {};
  return { ...(uiTheme || {}), tokens: { ...tokens, colors: { ...(tokens.colors && typeof tokens.colors === 'object' ? tokens.colors : {}), ...picked } } };
}
