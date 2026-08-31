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
    });
  } catch {
    return json(fallback(PROJECT_ID));
  }
}

function fallback(projectId: string) {
  return {
    projectId,
    companyName: 'JourneyAX',
    theme: {},
    labels: { items: 'Products', itemsSingular: 'Product', headerTitle: 'AI Configurator' },
    greeting: '',
    systemName: '',
    commerceMode: 'quote',
  };
}

function json(data: any, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
  });
}
