import { NextResponse } from 'next/server';
import { requireAuth, scopeTenant, isPlatformIdentity } from '../../../../lib/require-auth';
import { connectToDatabase } from '@journeyax/database';
import { can } from '@journeyax/shared-types';

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, 'project.read');
    if (!auth.ok) {
      return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
    }

    const isPlatform = isPlatformIdentity(auth.identity);
    const url = new URL(req.url);
    const requested = url.searchParams.get('tenantId') || url.searchParams.get('projectId');
    const targetProject = requested && requested.trim() ? requested.trim() : auth.identity.tenantId;

    // Tenant admins remain strictly tenant-scoped unless they hold a dedicated platform identity
    // or active project membership in the requested project
    let tenantId = auth.identity.tenantId;
    if (isPlatform) {
      tenantId = targetProject;
    } else if (targetProject !== auth.identity.tenantId) {
      tenantId = targetProject;
    }

    if (!tenantId) {
      return NextResponse.json({ ok: false, message: 'Missing authenticated tenant context' }, { status: 400 });
    }

    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      return NextResponse.json(
        {
          ok: false,
          configured: false,
          tenantId,
          message: 'Durable storage unconfigured: MONGODB_URI is required to list installed connections',
          connections: [],
        },
        { status: 503 }
      );
    }

    const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
    const { db } = await connectToDatabase(mongoUri, dbName);

    // Verify membership if not a dedicated platform identity
    if (!isPlatform) {
      const member = await db.collection('project_members').findOne({
        projectId: tenantId,
        email: auth.identity.email,
      });

      if (!member) {
        return NextResponse.json({ ok: false, message: `Access denied to project '${tenantId}'` }, { status: 403 });
      }

      // Require accepted/active/non-revoked membership lifecycle
      const memberStatus = (member.status || '').toLowerCase();
      if (
        !['active', 'accepted'].includes(memberStatus) ||
        ['pending', 'revoked', 'suspended', 'invited'].includes(memberStatus)
      ) {
        return NextResponse.json(
          { ok: false, message: `Access denied to project '${tenantId}': membership is in '${memberStatus || 'inactive'}' state` },
          { status: 403 }
        );
      }

      // Require project-scoped permission for project.read
      const memberRole = member.role || auth.identity.role;
      if (!can(memberRole, 'project.read')) {
        return NextResponse.json(
          { ok: false, message: `Access denied to project '${tenantId}': role '${memberRole}' lacks 'project.read' permission` },
          { status: 403 }
        );
      }
    }

    // Derive environment and verify membership from server-side project configuration
    const projectConfig =
      (await db.collection('tenant_configs').findOne({ projectId: tenantId })) ||
      (await db.collection('projects').findOne({ projectId: tenantId }));

    if (!projectConfig) {
      return NextResponse.json(
        { ok: false, message: `Project configuration not found for '${tenantId}'; failing closed.` },
        { status: 412 }
      );
    }

    const environmentId: string =
      projectConfig?.environment ||
      projectConfig?.defaultEnvironment ||
      (process.env.APP_ENV === 'staging' ? 'staging' : 'production');

    // Query authoritative tenant_connections collection strictly scoped by authenticated tenant
    // Arbitrary tenant_secrets are strictly excluded from connection enumeration
    const connectionsDocs = await db
      .collection('tenant_connections')
      .find({
        tenantId,
        environmentId: { $in: [environmentId, 'all'] },
        status: { $nin: ['revoked', 'inactive'] },
        enabled: { $ne: false },
      })
      .project({
        _id: 0,
        connectionRef: 1,
        name: 1,
        pieceName: 1,
        pieceId: 1,
        provider: 1,
        environmentId: 1,
        status: 1,
        createdAt: 1,
      })
      .toArray();

    const connections = connectionsDocs.map((doc: any) => ({
      connectionRef: doc.connectionRef,
      name: doc.name || doc.connectionRef,
      pieceName: doc.pieceName || doc.pieceId || doc.provider || '@activepieces/piece-commercetools',
      environmentId: doc.environmentId || environmentId,
      status: doc.status || 'active',
      createdAt: doc.createdAt || new Date().toISOString(),
    }));

    return NextResponse.json({
      ok: true,
      configured: true,
      tenantId,
      environmentId,
      connections,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: err.message }, { status: 500 });
  }
}
