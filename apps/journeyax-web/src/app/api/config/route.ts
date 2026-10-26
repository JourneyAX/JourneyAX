/**
 * Public storefront config — the customer-facing subset of the project's config
 * (theme, labels, brand name, greeting), fetched from project-service. The
 * storefront applies this at load so the SAME app renders each tenant's brand and
 * vocabulary. The tenant is resolved PER REQUEST (multi-storefront routing):
 * ?project= param → X-Tenant-ID header → Host domain → env fallback.
 */
import { resolveTenant } from '../../../lib/tenant';
import { handleConfigFailure, json } from '../../../lib/config/configFailure';

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
      return await handleConfigFailure(PROJECT_ID);
    }
    const p: any = withPreviewDraft(await res.json());
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
      checkoutReview: p?.extensions?.checkoutReview?.enabled === true,
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
    });
  } catch {
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

/**
 * Preview only: when the preview launcher names a draft (PREVIEW_DRAFT), its storefront settings (extensions checkoutReview, payment,
 * brandTheme) are laid over the project's own, in this response only, so a draft can be tried before it is published. Without that
 * variable (every real deployment) the project is returned as it is.
 */
function withPreviewDraft(project: any) {
  const file = process.env.PREVIEW_DRAFT;
  if (!file) return project;
  try {
    const { readFileSync } = require('node:fs');
    const path = require('node:path');
    const draft = JSON.parse(readFileSync(path.resolve(process.cwd(), '../..', file), 'utf8'));
    const keep = ['checkoutReview', 'payment', 'brandTheme'];
    const extensions = { ...(project?.extensions || {}) };
    for (const key of keep) if (draft?.extensions?.[key]) extensions[key] = draft.extensions[key];
    return { ...project, extensions };
  } catch {
    return project;
  }
}
