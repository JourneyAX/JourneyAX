import { NextResponse } from 'next/server';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';
import { connectToDatabase } from '@journeyax/database';

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'journeyx';

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, 'project.read');
    if (!auth.ok) {
      return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
    }

    const url = new URL(req.url);
    // Derive tenant strictly from authenticated identity via scopeTenant (never trust unauthenticated caller)
    const tenantId = scopeTenant(auth.identity, url.searchParams.get('tenantId') || url.searchParams.get('projectId'));
    const environmentId = (url.searchParams.get('environmentId') || 'production').trim();

    if (!tenantId) {
      return NextResponse.json({ ok: false, message: 'Missing tenantId' }, { status: 400 });
    }

    if (!MONGODB_URI) {
      return NextResponse.json(
        {
          ok: false,
          configured: false,
          tenantId,
          environmentId,
          message: 'Durable storage unconfigured: MONGODB_URI is required to list installed connections',
          connections: [],
        },
        { status: 503 }
      );
    }

    const { db } = await connectToDatabase(MONGODB_URI, DB_NAME);

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
