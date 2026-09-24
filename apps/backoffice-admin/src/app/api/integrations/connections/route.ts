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
      // Safe development/test fallback when MONGODB_URI is not set
      return NextResponse.json({
        ok: true,
        tenantId,
        environmentId,
        connections: [
          {
            connectionRef: `conn_ct_${tenantId}_dev`,
            name: `${tenantId} commercetools (dev)`,
            pieceName: '@activepieces/piece-commercetools',
            environmentId,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }

    const { db } = await connectToDatabase(MONGODB_URI, DB_NAME);

    // Query tenant_connections collection strictly scoped by authenticated tenant
    const connectionsDocs = await db
      .collection('tenant_connections')
      .find({
        tenantId,
        environmentId: { $in: [environmentId, 'all'] },
      })
      .project({ _id: 0, connectionRef: 1, name: 1, pieceName: 1, environmentId: 1, createdAt: 1 })
      .toArray();

    // Query tenant_secrets for connectionRef / secretRef entries owned by this tenant
    const secretsDocs = await db
      .collection('tenant_secrets')
      .find({
        tenantId,
        environmentId: { $in: [environmentId, 'all'] },
      })
      .project({ _id: 0, secretRef: 1, connectionRef: 1, pieceName: 1, environmentId: 1, createdAt: 1 })
      .toArray();

    const connectionsMap = new Map<string, any>();

    for (const doc of connectionsDocs) {
      if (doc.connectionRef) {
        connectionsMap.set(doc.connectionRef, {
          connectionRef: doc.connectionRef,
          name: doc.name || doc.connectionRef,
          pieceName: doc.pieceName || '@activepieces/piece-commercetools',
          environmentId: doc.environmentId || environmentId,
          createdAt: doc.createdAt || new Date().toISOString(),
        });
      }
    }

    for (const doc of secretsDocs) {
      const ref = doc.connectionRef || doc.secretRef;
      if (ref && !connectionsMap.has(ref)) {
        connectionsMap.set(ref, {
          connectionRef: ref,
          name: ref,
          pieceName: doc.pieceName || '@activepieces/piece-commercetools',
          environmentId: doc.environmentId || environmentId,
          createdAt: doc.createdAt || new Date().toISOString(),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      tenantId,
      environmentId,
      connections: Array.from(connectionsMap.values()),
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: err.message }, { status: 500 });
  }
}
