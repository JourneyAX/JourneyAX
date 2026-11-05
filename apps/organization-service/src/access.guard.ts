import { Injectable, type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { authenticateServiceIdentity } from '@journeyax/database';
import { isPlatformTenantId, resolveServiceUrl } from '@journeyax/shared-types';

/** This is a cross-project billing container. Tenant project membership is not
 * proof of organisation ownership; only verified platform administration or an
 * authenticated internal service may use these administrative endpoints. */
@Injectable()
export class OrganizationAccessGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getHandler().name === 'health') return true;
    const req = context.switchToHttp().getRequest();
    try {
      const identity = await authenticateServiceIdentity(req.headers, { internalKey: process.env.INTERNAL_API_KEY, assertionSecret: process.env.GATEWAY_ASSERTION_SECRET,
        authUrl: resolveServiceUrl('AUTH_SERVICE_URL', process.env.AUTH_SERVICE_URL, 'http://localhost:8080'), expectedTenantId: String(req.headers['x-tenant-id'] || '') });
      if (!identity.internal && !(identity.role === 'admin' && isPlatformTenantId(identity.tenantId))) throw new Error('Not authorised.');
      req.organizationIdentity = identity;
      return true;
    } catch { throw new ForbiddenException('Verified platform organisation authority is required.'); }
  }
}
