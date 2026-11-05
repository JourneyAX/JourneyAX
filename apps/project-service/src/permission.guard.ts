/**
 * RequirePermission (P0-02 R3) — INDEPENDENT authorization at the service.
 *
 * The audit requires each service to authenticate callers itself, "not only at
 * the gateway." This guard establishes the caller's permissions on MUTATING
 * project endpoints from, in order:
 *   1. the internal service key (`x-internal-key`) — trusted service-to-service;
 *   2. a cryptographically signed gateway assertion (raw role/permission
 *      headers are never accepted as proof);
 *   3. the caller's own `Authorization: Bearer <jwt>` — verified HERE against
 *      auth-service, so project-service enforces even when reached directly
 *      (the back office calls it directly today).
 *
 * A development setting never manufactures an authenticated identity.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, isPlatformTenantId, resolveServiceUrl, type Permission } from '@journeyax/shared-types';
import { verifyGatewayAssertion } from '@journeyax/database';

export const PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
export const PUBLIC_PROJECT_ROUTE = 'publicProjectRoute';
export const PublicProjectRoute = () => SetMetadata(PUBLIC_PROJECT_ROUTE, true);

// Read lazily (inside canActivate), not at module-eval time: ESM import
// hoisting can load this module before main.ts's dotenv.config() has run,
// which would permanently bake in an empty INTERNAL_KEY for the life of the
// process — silently rejecting every internal-key-authenticated request.
const internalKey = () => process.env.INTERNAL_API_KEY;
const authUrl = () => resolveServiceUrl('AUTH_SERVICE_URL', process.env.AUTH_SERVICE_URL, 'http://localhost:8080');

// A standalone Reflector (its .get just calls Reflect.getMetadata) — no DI
// needed, so the guard works even when applied via @UseGuards(ClassName) where
// constructor injection of Reflector is not wired.
const reflector = new Reflector();

@Injectable()
export class PermissionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = reflector.get<Permission>(PERMISSION_KEY, context.getHandler());
    if (reflector.get<boolean>(PUBLIC_PROJECT_ROUTE, context.getHandler())) return true;
    if (!required) throw new ForbiddenException('This endpoint has no configured access policy.');

    const req = context.switchToHttp().getRequest();
    const setScope = (tenantId: string, role: string, internal = false) => {
      const tenant = tenantId.trim().toLowerCase();
      req.projectAccess = { tenantId: tenant, platformAdmin: internal || role === 'admin' && isPlatformTenantId(tenant), internal };
      const createdProject = required === 'user.manage' && !req.params?.projectId ? req.body?.projectId : undefined;
      if (createdProject && !req.projectAccess.platformAdmin && createdProject !== tenant) throw new ForbiddenException('This identity cannot create another project.');
    };

    // 1. Internal service-to-service call.
    const internalKeyValue = internalKey();
    if (internalKeyValue && req.headers['x-internal-key'] === internalKeyValue) {
      req.headers['x-user-id'] = String(req.headers['x-user-id'] || req.headers['x-principal-id'] || 'service:internal');
      req.headers['x-authenticated-role'] = String(req.headers['x-user-role'] || req.headers['x-principal-role'] || 'admin');
      setScope(String(req.params?.projectId || req.headers['x-tenant-id'] || ''), req.headers['x-authenticated-role'], true);
      return true;
    }

    // 2. Cryptographically signed gateway identity. Never trust raw
    // x-user-permissions/x-user-role headers from a direct caller.
    const assertion = String(req.headers['x-gateway-assertion'] || '');
    if (assertion) {
      const secret = process.env.GATEWAY_ASSERTION_SECRET || '';
      try {
        const payload = verifyGatewayAssertion(assertion, secret, {
          expectedTenantId: String(req.params?.projectId || req.headers['x-tenant-id'] || ''),
          // Project-service routes are tenant-scoped control-plane routes rather
          // than /:environment runtime routes, so the gateway signs this hop as
          // production regardless of which target environment is being edited.
          expectedEnvironmentId: 'production',
        });
        if (!can(payload.role, required)) {
          throw new ForbiddenException(`This action requires the '${required}' permission.`);
        }
        req.headers['x-user-id'] = payload.sub;
        req.headers['x-authenticated-role'] = payload.role;
        setScope(payload.tenantId, payload.role);
        return true;
      } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        throw new ForbiddenException('Invalid gateway identity assertion.');
      }
    }

    // 3. Verify the caller's own JWT directly (back office calls us directly).
    const authz = String(req.headers['authorization'] || '');
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    if (token) {
      try {
        const r = await fetch(`${authUrl()}/api/v1/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) {
          const { valid, payload } = (await r.json()) as { valid: boolean; payload?: { sub?: string; role: string; tenantId?: string } };
          if (valid && payload?.sub && can(payload.role, required)) {
            const target = String(req.params?.projectId || req.headers['x-tenant-id'] || '').toLowerCase();
            const tenant = String(payload.tenantId || '').toLowerCase();
            const platformAdmin = payload.role === 'admin' && isPlatformTenantId(tenant);
            if (!platformAdmin && (!target || tenant !== target)) throw new ForbiddenException('This identity cannot access the requested project.');
            req.headers['x-user-id'] = payload.sub;
            req.headers['x-authenticated-role'] = payload.role;
            setScope(tenant, payload.role);
            return true;
          }
          throw new ForbiddenException(`This action requires the '${required}' permission.`);
        }
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
        // auth-service unreachable → fall through to deny (unless dev bypass)
      }
    }

    throw new ForbiddenException(`This action requires the '${required}' permission.`);
  }
}
