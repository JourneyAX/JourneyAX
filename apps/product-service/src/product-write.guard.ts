import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { can, permissionsFor, resolveServiceUrl } from '@journeyax/shared-types';

/** Destructive/ingestion endpoints verify a credential, never a caller-supplied permission list. */
@Injectable()
export class ProductWriteGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const internal = process.env.INTERNAL_API_KEY;
    if (internal && req.headers?.['x-internal-key'] === internal) return true;
    const token = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization ?? ''))?.[1];
    if (!token) throw new ForbiddenException('Verified knowledge administration is required.');
    try {
      const response = await fetch(`${resolveServiceUrl('AUTH_SERVICE_URL', process.env.AUTH_SERVICE_URL, 'http://localhost:8080')}/api/v1/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000) });
      const result = response.ok ? await response.json() as any : undefined;
      const actor = result?.payload;
      const target = req.params?.projectId;
      if (result?.valid !== true || !actor?.sub || !actor.tenantId || !can(actor.role, 'knowledge.ingest') || !target || !(actor.role === 'admin' && actor.tenantId === 'platform' || actor.tenantId === target)) throw new Error('refused');
      req.headers['x-user-permissions'] = permissionsFor(actor.role).join(',');
      return true;
    } catch { throw new ForbiddenException('Verified tenant-scoped knowledge administration is required.'); }
  }
}
