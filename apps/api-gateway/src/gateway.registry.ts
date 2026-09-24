import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Service Registry — maps route prefixes to backend microservice URLs.
 * In production, this would be replaced by Kong/Envoy service discovery.
 */
// domain → backend service base URL
export const DOMAIN_REGISTRY: Record<string, string> = {
  commerce:      process.env.AGENT_SERVICE_URL              || 'http://localhost:3004',
  runtime:       process.env.JOURNEY_RUNTIME_SERVICE_URL    || process.env.JOURNEY_RUNTIME_URL || process.env.RUNTIME_SERVICE_URL || 'http://localhost:3009',
  products:      process.env.PRODUCT_SERVICE_URL            || 'http://localhost:8083',
  cdl:           process.env.PRODUCT_SERVICE_URL    || 'http://localhost:8083',  // CDL lives in product-service
  projects:      process.env.PROJECT_SERVICE_URL    || 'http://localhost:8082',
  organizations: process.env.ORG_SERVICE_URL        || 'http://localhost:8085',
  analytics:     process.env.ANALYTICS_SERVICE_URL  || 'http://localhost:8086',
  leads:         process.env.LEAD_SERVICE_URL       || 'http://localhost:8087',
  auth:          process.env.AUTH_SERVICE_URL        || 'http://localhost:8080',
  data:          process.env.DATA_SERVICE_URL       || 'http://localhost:8084',
};

// Kept for health-check iteration (base URLs only).
export const SERVICE_REGISTRY: Record<string, string> = DOMAIN_REGISTRY;

/**
 * Validates that production deployments do not point to localhost / 127.0.0.1 targets.
 * Throws a fatal error if localhost target is detected in production.
 */
export function validateProductionRegistry(
  registry: Record<string, string> = DOMAIN_REGISTRY,
  env: string = process.env.NODE_ENV || 'development'
): void {
  if (env !== 'production') return;

  const localhostErrors: string[] = [];
  for (const [domain, url] of Object.entries(registry)) {
    if (!url || typeof url !== 'string') {
      localhostErrors.push(`Domain '${domain}' has undefined or empty URL target.`);
      continue;
    }
    const normalized = url.toLowerCase();
    if (
      normalized.includes('localhost') ||
      normalized.includes('127.0.0.1') ||
      normalized.includes('0.0.0.0') ||
      normalized.includes('::1')
    ) {
      localhostErrors.push(`Domain '${domain}' is configured with insecure localhost target '${url}'.`);
    }
  }

  if (localhostErrors.length > 0) {
    throw new Error(
      `[GatewayRegistry] Production deployment misconfiguration: localhost service targets are forbidden in production:\n  - ${localhostErrors.join('\n  - ')}`
    );
  }
}

// Platform-level domains are NOT tenant-scoped (no projectId in their URL).
const PLATFORM_DOMAINS = new Set(['auth', 'organizations', 'projects']);
// Tenant-scoped domains carry the projectId as the first path segment:
//   /api/v1/:projectId/<domain>/... or /api/v1/:projectId/:environmentId/<domain>/...
const PROJECT_DOMAINS = new Set(['commerce', 'products', 'cdl', 'analytics', 'leads', 'data', 'runtime']);

export interface ParsedRoute {
  projectId: string | null;
  environmentId: string | null;
  domain: string | null;
}

/**
 * Parse an /api/v1/... path into its projectId (if tenant-scoped), environmentId, and domain.
 *   /api/v1/workweargroup/production/runtime/turn → { projectId: 'workweargroup', environmentId: 'production', domain: 'runtime' }
 *   /api/v1/workweargroup/runtime/turn            → { projectId: 'workweargroup', environmentId: 'production', domain: 'runtime' }
 *   /api/v1/caroma/commerce/chat                  → { projectId: 'caroma',        environmentId: 'production', domain: 'commerce' }
 *   /api/v1/projects/caroma/rules                 → { projectId: null,            environmentId: null,         domain: 'projects' }
 */
export function parseRoute(path: string): ParsedRoute {
  const segs = path.split('?')[0].split('/').filter(Boolean); // ['api','v1',...]
  if (segs[0] !== 'api' || segs[1] !== 'v1' || !segs[2]) return { projectId: null, environmentId: null, domain: null };
  const s1 = segs[2], s2 = segs[3], s3 = segs[4];
  if (PLATFORM_DOMAINS.has(s1)) return { projectId: null, environmentId: null, domain: s1 };
  if (s3 && PROJECT_DOMAINS.has(s3)) return { projectId: s1, environmentId: s2, domain: s3 };
  if (s2 && PROJECT_DOMAINS.has(s2)) return { projectId: s1, environmentId: 'production', domain: s2 };
  if (PROJECT_DOMAINS.has(s1)) return { projectId: null, environmentId: 'production', domain: s1 };
  return { projectId: null, environmentId: null, domain: s1 };
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
 * Extracts tenant ID from headers or subdomain.
 * Injects X-Tenant-ID into the proxied request if present.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    // Priority: explicit header → subdomain
    let tenantId = req.headers['x-tenant-id'] as string;

    if (!tenantId) {
      const host = req.headers.host || '';
      const subdomain = host.split('.')[0];
      if (subdomain && subdomain !== 'localhost' && subdomain !== 'www' && subdomain !== 'api') {
        tenantId = subdomain;
      }
    }

    if (tenantId) {
      req.headers['x-tenant-id'] = tenantId;
    }
    next();
  }
}
