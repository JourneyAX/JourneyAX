import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { authenticateServiceIdentity } from '@journeyax/database';
import { can, isPlatformTenantId, resolveServiceUrl } from '@journeyax/shared-types';

/** Image generation is a paid, personal-photo operation. Verify the caller again
 * at the product boundary instead of trusting browser-supplied identity headers. */
@Injectable()
export class TryOnAccessGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const target = String(req.params?.projectId || '').trim().toLowerCase();
    const declared = req.headers?.['x-tenant-id'];
    if (!target || declared && declared !== target) throw new ForbiddenException('One try-on tenant is required.');
    try {
      const identity = await authenticateServiceIdentity(req.headers || {}, {
        internalKey: process.env.INTERNAL_API_KEY,
        assertionSecret: process.env.GATEWAY_ASSERTION_SECRET,
        authUrl: resolveServiceUrl('AUTH_SERVICE_URL', process.env.AUTH_SERVICE_URL, 'http://localhost:8080'),
        expectedTenantId: target,
      });
      const platformAdmin = identity.role === 'admin' && isPlatformTenantId(identity.tenantId);
      if (!identity.internal && (!can(identity.role, 'chat.use') || !platformAdmin && identity.tenantId !== target)) throw new Error('refused');
      return true;
    } catch { throw new ForbiddenException('Verified tenant-scoped try-on access is required.'); }
  }
}
