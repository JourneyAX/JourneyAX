/**
 * RequirePermission (P0-02 R3) — INDEPENDENT authorization at the service.
 *
 * The audit requires each service to authenticate callers itself, "not only at
 * the gateway." This guard establishes the caller's permissions on MUTATING
 * project endpoints from, in order:
 *   1. the internal service key (`x-internal-key`) — trusted service-to-service;
 *   2. the trusted `x-user-permissions` header the gateway injects after it
 *      verified the JWT (fast path when the call came via the gateway);
 *   3. the caller's own `Authorization: Bearer <jwt>` — verified HERE against
 *      auth-service, so project-service enforces even when reached directly
 *      (the back office calls it directly today).
 *
 * No implicit fail-open: a caller with none of the above is denied unless
 * AUTH_DEV_BYPASS is explicitly set (local dev only).
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission } from '@journeyax/shared-types';

export const PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

// Read lazily (inside canActivate), not at module-eval time: ESM import
// hoisting can load this module before main.ts's dotenv.config() has run,
// which would permanently bake in an empty INTERNAL_KEY for the life of the
// process — silently rejecting every internal-key-authenticated request.
const internalKey = () => process.env.INTERNAL_API_KEY;
const devBypass = () => process.env.AUTH_DEV_BYPASS === 'true';
const authUrl = () => process.env.AUTH_SERVICE_URL || 'http://localhost:8080';

// A standalone Reflector (its .get just calls Reflect.getMetadata) — no DI
// needed, so the guard works even when applied via @UseGuards(ClassName) where
// constructor injection of Reflector is not wired.
const reflector = new Reflector();

@Injectable()
export class PermissionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = reflector.get<Permission>(PERMISSION_KEY, context.getHandler());
    if (!required) return true; // endpoint declares no permission → open

    const req = context.switchToHttp().getRequest();

    // 1. Internal service-to-service call.
    const internalKeyValue = internalKey();
    if (internalKeyValue && req.headers['x-internal-key'] === internalKeyValue) return true;

    // 2. Trusted permissions header injected by the gateway.
    const headerPerms = String(req.headers['x-user-permissions'] || '')
      .split(',').map((p: string) => p.trim()).filter(Boolean);
    if (headerPerms.includes(required)) return true;

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
          const { valid, payload } = (await r.json()) as { valid: boolean; payload?: { role: string } };
          if (valid && payload && can(payload.role, required)) return true;
          throw new ForbiddenException(`This action requires the '${required}' permission.`);
        }
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
        // auth-service unreachable → fall through to deny (unless dev bypass)
      }
    }

    if (devBypass()) return true;
    throw new ForbiddenException(`This action requires the '${required}' permission.`);
  }
}
