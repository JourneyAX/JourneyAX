import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { parseRoute } from './gateway.registry';
import { requiredPermission, can, permissionsFor } from '@journeyax/shared-types';

/**
 * Validate the URL's projectId against the authenticated identity.
 *  - platform admin (role 'admin', tenant 'platform') → may act on any project
 *  - a tenant user → may only act on their own project (tenantId === projectId)
 * Returns true if allowed. Guests (no jwt) are handled by the caller.
 */
function projectAllowed(projectId: string, role?: string, tenantId?: string): boolean {
  if (role === 'admin' || tenantId === 'platform') return true;
  return !!tenantId && tenantId === projectId;
}

/**
 * Auth Guard Middleware — API Gateway Layer
 *
 * Three access tiers:
 *
 * 1. PUBLIC_ROUTES     → Always open, no token checked at all.
 *                         (auth endpoints, health checks)
 *
 * 2. ANONYMOUS_ROUTES  → Token OPTIONAL. If a valid token is present, claims
 *                         are injected for personalization. If absent/invalid,
 *                         the request proceeds as an anonymous guest.
 *                         (customer chat — anyone can chat)
 *
 * 3. Everything else   → Token REQUIRED. Invalid or missing → 401.
 *                         (backoffice analytics, leads, organizations, etc.)
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';
// P0-02: NO implicit fail-open. Auth previously passed through on bad/missing
// tokens whenever NODE_ENV !== 'production'. That is removed. A local developer
// who genuinely needs to bypass auth must opt in EXPLICITLY with AUTH_DEV_BYPASS=true
// (never set in any deployed environment); otherwise protected routes 401 as they
// should. The flag is logged loudly so it can't hide.
const DEV_BYPASS = process.env.AUTH_DEV_BYPASS === 'true';
if (DEV_BYPASS) {
  console.warn('[AuthGuard] ⚠️  AUTH_DEV_BYPASS=true — authentication is DISABLED for protected routes. NEVER use this in production.');
}

// Always open — no token check whatsoever
const PUBLIC_ROUTES = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/health',
];

// Domains where anonymous (guest) access is allowed — customer-facing storefront
// surfaces. A guest chatting with a public brand storefront has no token, and the
// projectId in the URL identifies which brand they're talking to.
const ANONYMOUS_DOMAINS = new Set(['commerce', 'products', 'cdl']);

@Injectable()
export class AuthGuard implements NestMiddleware {
  async use(req: Request, res: Response, next: NextFunction) {
    const path = req.originalUrl.split('?')[0];

    // ── 1. Fully public ───────────────────────────────────────────
    if (
      PUBLIC_ROUTES.some(r => path.startsWith(r)) ||
      path.endsWith('/health') ||
      (path.startsWith('/api/v1/projects/') && path.endsWith('/published'))
    ) {
      return next();
    }

    const { projectId, domain } = parseRoute(path);
    const authHeader = req.headers['authorization'];
    const hasToken = !!authHeader && authHeader.startsWith('Bearer ');

    // ── 2. Anonymous-allowed domains (customer-facing storefront) ──
    const isAnonymousRoute = !!domain && ANONYMOUS_DOMAINS.has(domain);

    if (isAnonymousRoute && !hasToken) {
      // Guest — the URL projectId identifies which brand they're chatting with.
      req.headers['x-tenant-id']  = projectId || (req.headers['x-tenant-id'] as string) || 'caroma';
      req.headers['x-user-email'] = 'guest@anonymous';
      req.headers['x-user-role']  = 'guest';
      req.headers['x-auth-type']  = 'anonymous';
      return next();
    }

    // ── 3. Token present — verify it ─────────────────────────────
    if (hasToken) {
      const token = authHeader!.replace('Bearer ', '').trim();

      try {
        const verifyResponse = await fetch(`${AUTH_SERVICE_URL}/api/v1/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(3000),
        });

        if (verifyResponse.ok) {
          const { payload } = await verifyResponse.json() as {
            valid: boolean;
            payload: { sub: string; tenantId: string; role: string; fullName: string };
          };

          // ── Tenant isolation: the URL projectId must belong to this identity ──
          if (projectId && !projectAllowed(projectId, payload.role, payload.tenantId)) {
            console.warn(`[AuthGuard] ⛔ ${payload.sub} (tenant=${payload.tenantId}) blocked from project '${projectId}'`);
            return res.status(403).json({
              error: 'Forbidden',
              message: `You are not authorized for project '${projectId}'.`,
            });
          }

          // ── Permission enforcement (P0-02): a valid token is not enough — the
          // identity must hold the permission this domain+method requires. ──
          const needed = requiredPermission(domain, req.method);
          if (needed && !can(payload.role, needed)) {
            console.warn(`[AuthGuard] ⛔ ${payload.sub} (role=${payload.role}) lacks '${needed}' for ${req.method} ${path}`);
            return res.status(403).json({
              error: 'Forbidden',
              message: `This action requires the '${needed}' permission.`,
            });
          }

          // Inject verified claims. Trusted tenant = the validated path projectId
          // (or the token's own tenant for platform-level routes).
          req.headers['x-user-email']       = payload.sub;
          req.headers['x-user-role']        = payload.role;
          req.headers['x-user-name']        = payload.fullName;
          req.headers['x-user-permissions'] = permissionsFor(payload.role).join(',');
          req.headers['x-tenant-id']        = projectId || payload.tenantId;
          req.headers['x-auth-type']        = 'jwt';

          console.log(`[AuthGuard] ✅ ${payload.sub} | project=${projectId || payload.tenantId} | role=${payload.role}`);
          return next();

        } else {
          // Bad token
          if (isAnonymousRoute) {
            // On anonymous routes, fall through as guest even with a bad token
            req.headers['x-tenant-id']  = projectId || (req.headers['x-tenant-id'] as string) || 'caroma';
            req.headers['x-user-email'] = 'guest@anonymous';
            req.headers['x-user-role']  = 'guest';
            req.headers['x-auth-type']  = 'anonymous';
            return next();
          }

          if (DEV_BYPASS) {
            console.warn('[AuthGuard] ⚠️  Bad token — AUTH_DEV_BYPASS passthrough');
            req.headers['x-tenant-id'] = projectId || (req.headers['x-tenant-id'] as string) || 'caroma';
            return next();
          }

          const body = await verifyResponse.json().catch(() => ({}));
          return res.status(401).json({ error: 'Unauthorized', message: (body as any).message || 'Invalid token.' });
        }

      } catch (err: any) {
        // Auth-service unreachable
        if (isAnonymousRoute) {
          req.headers['x-tenant-id']  = projectId || (req.headers['x-tenant-id'] as string) || 'caroma';
          req.headers['x-user-email'] = 'guest@anonymous';
          req.headers['x-user-role']  = 'guest';
          req.headers['x-auth-type']  = 'anonymous';
          return next();
        }

        if (DEV_BYPASS) {
          console.warn(`[AuthGuard] ⚠️  Auth service unreachable — AUTH_DEV_BYPASS passthrough`);
          req.headers['x-tenant-id'] = projectId || (req.headers['x-tenant-id'] as string) || 'caroma';
          return next();
        }

        return res.status(503).json({ error: 'Service Unavailable', message: 'Auth service unreachable.' });
      }
    }

    // ── 4. Protected route, no token ─────────────────────────────
    if (DEV_BYPASS) {
      console.warn(`[AuthGuard] ⚠️  No token on protected route — AUTH_DEV_BYPASS passthrough: ${req.method} ${path}`);
      req.headers['x-tenant-id'] = projectId || (req.headers['x-tenant-id'] as string) || 'caroma';
      return next();
    }

    return res.status(401).json({
      error: 'Unauthorized',
      message: 'This route requires authentication. Please log in.',
    });
  }
}

