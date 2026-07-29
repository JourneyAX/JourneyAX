import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Service Registry — maps route prefixes to backend microservice URLs.
 * In production, this would be replaced by Kong/Envoy service discovery.
 */
// domain → backend service base URL
export const DOMAIN_REGISTRY: Record<string, string> = {
  commerce:      process.env.AGENT_SERVICE_URL      || 'http://localhost:3004',
  products:      process.env.PRODUCT_SERVICE_URL    || 'http://localhost:8083',
  projects:      process.env.PROJECT_SERVICE_URL    || 'http://localhost:8082',
  organizations: process.env.ORG_SERVICE_URL        || 'http://localhost:8085',
  analytics:     process.env.ANALYTICS_SERVICE_URL  || 'http://localhost:8086',
  leads:         process.env.LEAD_SERVICE_URL       || 'http://localhost:8087',
  auth:          process.env.AUTH_SERVICE_URL        || 'http://localhost:8080',
  data:          process.env.DATA_SERVICE_URL       || 'http://localhost:8084',
};

// Kept for health-check iteration (base URLs only).
export const SERVICE_REGISTRY: Record<string, string> = DOMAIN_REGISTRY;

// Platform-level domains are NOT tenant-scoped (no projectId in their URL).
const PLATFORM_DOMAINS = new Set(['auth', 'organizations', 'projects']);
// Tenant-scoped domains carry the projectId as the first path segment:
//   /api/v1/:projectId/<domain>/...
const PROJECT_DOMAINS = new Set(['commerce', 'products', 'analytics', 'leads', 'data']);

/**
 * Parse an /api/v1/... path into its projectId (if tenant-scoped) and domain.
 *   /api/v1/caroma/commerce/chat  → { projectId: 'caroma', domain: 'commerce' }
 *   /api/v1/projects/caroma/rules → { projectId: null,     domain: 'projects' }
 *   /api/v1/commerce/chat (legacy)→ { projectId: null,     domain: 'commerce' }
 */
export function parseRoute(path: string): { projectId: string | null; domain: string | null } {
  const segs = path.split('?')[0].split('/').filter(Boolean); // ['api','v1',...]
  if (segs[0] !== 'api' || segs[1] !== 'v1' || !segs[2]) return { projectId: null, domain: null };
  const s1 = segs[2], s2 = segs[3];
  if (PLATFORM_DOMAINS.has(s1)) return { projectId: null, domain: s1 };
  if (s2 && PROJECT_DOMAINS.has(s2)) return { projectId: s1, domain: s2 };   // new tenant-scoped scheme
  if (PROJECT_DOMAINS.has(s1)) return { projectId: null, domain: s1 };       // legacy (no projectId)
  return { projectId: null, domain: s1 };
}

/**
 * Resolves which backend service should handle a given request path.
 */
export function resolveService(path: string): { baseUrl: string; prefix: string } | null {
  const { domain } = parseRoute(path);
  if (domain && DOMAIN_REGISTRY[domain]) {
    return { baseUrl: DOMAIN_REGISTRY[domain], prefix: `/api/v1/${domain}` };
  }
  return null;
}

/**
 * Tenant Resolution Middleware.
 * Extracts tenant ID from headers, subdomain, or defaults to 'caroma'.
 * Injects X-Tenant-ID into the proxied request.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    // Priority: explicit header → subdomain → default
    let tenantId = req.headers['x-tenant-id'] as string;

    if (!tenantId) {
      const host = req.headers.host || '';
      const subdomain = host.split('.')[0];
      if (subdomain && subdomain !== 'localhost' && subdomain !== 'www' && subdomain !== 'api') {
        tenantId = subdomain;
      }
    }

    req.headers['x-tenant-id'] = tenantId || 'caroma';
    next();
  }
}
