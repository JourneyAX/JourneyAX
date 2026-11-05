import { Injectable, type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { authenticateServiceIdentity } from '@journeyax/database';
import { can, isPlatformTenantId, permissionsFor, resolveServiceUrl } from '@journeyax/shared-types';

@Injectable()
export class AnalyticsAccessGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getHandler().name === 'health') return true;
    const req = context.switchToHttp().getRequest();
    const declared = [req.params?.projectId, req.query?.tenantId, req.query?.projectId, req.body?.tenantId, req.body?.projectId].filter((value): value is string => typeof value === 'string' && value.length > 0).map(value => value.toLowerCase());
    const headerTenant = typeof req.headers['x-tenant-id'] === 'string' ? req.headers['x-tenant-id'].toLowerCase() : '';
    const target = declared[0] || headerTenant;
    if (!target || declared.some(value => value !== target)) throw new ForbiddenException('One explicit analytics tenant is required.');
    try {
      const identity = await authenticateServiceIdentity(req.headers, { internalKey: process.env.INTERNAL_API_KEY, assertionSecret: process.env.GATEWAY_ASSERTION_SECRET,
        authUrl: resolveServiceUrl('AUTH_SERVICE_URL', process.env.AUTH_SERVICE_URL, 'http://localhost:8080'), expectedTenantId: headerTenant || target });
      const platformAdmin = identity.role === 'admin' && isPlatformTenantId(identity.tenantId);
      if (!identity.internal && (!can(identity.role, 'analytics.read') || !platformAdmin && target !== identity.tenantId)) throw new Error('Not authorised.');
      req.analyticsIdentity = identity;
      req.headers['x-tenant-id'] = target;
      req.headers['x-user-email'] = identity.sub;
      req.headers['x-user-role'] = identity.role;
      req.headers['x-user-permissions'] = identity.internal ? '*' : permissionsFor(identity.role).map(permission => permission.replace('.', ':')).join(',');
      if (identity.internal) req.headers['x-internal-call'] = 'true'; else delete req.headers['x-internal-call'];
      return true;
    } catch { throw new ForbiddenException('Verified analytics authority for this tenant is required.'); }
  }
}
