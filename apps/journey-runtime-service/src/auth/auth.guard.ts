import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  verifyGatewayAssertion,
  ReplayStore,
  MongoReplayStore,
  InMemoryReplayStore,
  connectToDatabase,
} from '@journeyax/database';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const IS_INTERNAL_ONLY_KEY = 'isInternalOnly';
export const InternalOnly = () => SetMetadata(IS_INTERNAL_ONLY_KEY, true);

export interface AuthContext {
  tenantId: string;
  environmentId: 'dev' | 'test' | 'staging' | 'production';
  principalId: string;
  principalRole: string;
  isInternal: boolean;
}

@Injectable()
export class RuntimeAuthGuard implements CanActivate {
  private replayStore: ReplayStore | null = null;

  constructor(private reflector: Reflector) {}

  public getReplayStore(): ReplayStore {
    if (!this.replayStore) {
      if (process.env.MONGODB_URI) {
        this.replayStore = new MongoReplayStore(async () => {
          const { db } = await connectToDatabase(
            process.env.MONGODB_URI!,
            process.env.MONGODB_DB_NAME || 'journeyx'
          );
          return { db };
        });
      } else {
        this.replayStore = new InMemoryReplayStore();
      }
    }
    return this.replayStore;
  }

  public setReplayStoreForTest(store: ReplayStore): void {
    this.replayStore = store;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const params = req.params || {};
    const headers = req.headers || {};
    const body = req.body || {};

    const pathTenantId = params.tenantId;
    const pathEnvId = (params.environmentId || 'production') as AuthContext['environmentId'];
    const headerTenantId = headers['x-tenant-id'] as string | undefined;
    const internalKey = headers['x-internal-key'] as string | undefined;

    // 1. Enforce Tenant Isolation & Mismatch Detection
    if (pathTenantId && headerTenantId && pathTenantId !== headerTenantId) {
      throw new ForbiddenException(
        `Cross-tenant access forbidden: X-Tenant-ID header '${headerTenantId}' does not match path tenant '${pathTenantId}'`
      );
    }

    if (pathTenantId && body.tenantId && body.tenantId !== pathTenantId) {
      throw new ForbiddenException(
        `Cross-tenant access forbidden: body.tenantId '${body.tenantId}' does not match path tenant '${pathTenantId}'`
      );
    }

    if (pathEnvId && body.environmentId && body.environmentId !== pathEnvId) {
      throw new ForbiddenException(
        `Environment mismatch: body.environmentId '${body.environmentId}' does not match path environment '${pathEnvId}'`
      );
    }

    const tenantId = pathTenantId || headerTenantId;
    if (!tenantId) {
      throw new ForbiddenException('Tenant identification is required (path or X-Tenant-ID header)');
    }

    // 2. Validate internal-only endpoints
    const isInternalOnly = this.reflector.getAllAndOverride<boolean>(IS_INTERNAL_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const configuredInternalKey = process.env.INTERNAL_API_KEY;
    const isInternalKeyValid =
      Boolean(configuredInternalKey) &&
      Boolean(internalKey) &&
      internalKey === configuredInternalKey;

    if (isInternalOnly) {
      if (!configuredInternalKey) {
        throw new UnauthorizedException('Server security error: INTERNAL_API_KEY is not configured');
      }
      if (!isInternalKeyValid) {
        throw new UnauthorizedException('Access denied: valid X-Internal-Key required');
      }
    }

    // 3. Server-derived security identity:
    // Identity MUST come from authenticated workload identity (X-Internal-Key)
    // or a cryptographically signed gateway assertion (X-Gateway-Assertion).
    // Raw external headers (X-User-Role, etc.) without proof are strictly untrusted.
    let principalId = 'anonymous';
    let principalRole = 'customer';

    const gatewayAssertion = headers['x-gateway-assertion'] as string | undefined;

    if (gatewayAssertion) {
      const assertionSecret = process.env.GATEWAY_ASSERTION_SECRET || process.env.INTERNAL_API_KEY;
      if (!assertionSecret) {
        throw new UnauthorizedException('Server security error: Gateway assertion secret is not configured');
      }

      let payload: ReturnType<typeof verifyGatewayAssertion>;
      try {
        payload = verifyGatewayAssertion(gatewayAssertion, assertionSecret, {
          expectedTenantId: tenantId,
          expectedEnvironmentId: pathEnvId,
        });
      } catch (err: any) {
        throw new UnauthorizedException(`Invalid gateway assertion: ${err.message || 'Verification failed'}`);
      }

      // Durable atomic replay protection across runtime instances
      const claimResult = await this.getReplayStore().claim(
        payload.jti,
        payload.tenantId,
        payload.environmentId,
        new Date(payload.exp * 1000)
      );

      if (claimResult === 'already_claimed') {
        throw new UnauthorizedException(`Gateway assertion replayed (jti=${payload.jti})`);
      }

      principalId = payload.sub;
      principalRole = payload.role;
    } else if (isInternalKeyValid) {
      // Authenticated workload identity presenting verified X-Internal-Key
      principalId = (headers['x-user-id'] as string) || (headers['x-principal-id'] as string) || 'internal-service';
      principalRole = (headers['x-user-role'] as string) || (headers['x-principal-role'] as string) || 'admin';
    } else {
      // External caller without proof: cannot claim elevated roles
      principalId = (headers['x-user-id'] as string) || 'anonymous';
      principalRole = 'customer';
    }

    req.authContext = {
      tenantId,
      environmentId: pathEnvId,
      principalId,
      principalRole,
      isInternal: isInternalKeyValid,
    };

    return true;
  }
}
