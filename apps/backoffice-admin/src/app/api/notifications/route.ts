import { NextResponse } from 'next/server';
import { requireAuth, scopeTenant } from '../../../lib/require-auth';
import { connectToDatabase, NotificationDispatcher } from '@journeyax/database';

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'journeyx';

let dispatcherPromise: Promise<NotificationDispatcher> | null = null;
async function getDispatcher(): Promise<NotificationDispatcher | null> {
  if (!MONGODB_URI) return null;
  if (!dispatcherPromise) {
    dispatcherPromise = connectToDatabase(MONGODB_URI, DB_NAME).then(({ db }) => new NotificationDispatcher(db));
  }
  return dispatcherPromise;
}

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, 'project.read');
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

    const url = new URL(req.url);
    const tenantId = scopeTenant(auth.identity, url.searchParams.get('tenantId'));
    if (!tenantId) {
      return NextResponse.json({ error: 'Missing tenantId' }, { status: 400 });
    }

    const dispatcher = await getDispatcher();
    if (!dispatcher) {
      return NextResponse.json({ deliveries: [] });
    }

    const deliveries = await dispatcher.listDeliveries(tenantId, 50);
    return NextResponse.json({ deliveries });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req, 'config.publish');
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

    const body = await req.json();
    const tenantId = scopeTenant(auth.identity, body.tenantId || body.projectId);
    if (!tenantId) {
      return NextResponse.json({ error: 'Missing tenantId' }, { status: 400 });
    }

    const dispatcher = await getDispatcher();
    if (!dispatcher || !MONGODB_URI) {
      return NextResponse.json(
        {
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          message: 'Notification delivery service unavailable: MongoDB connection (MONGODB_URI) is required to record and dispatch notifications.',
          deliveries: [],
        },
        { status: 503 }
      );
    }

    const { db } = await connectToDatabase(MONGODB_URI, DB_NAME);
    const tenantDoc = await db.collection('tenant_configs').findOne({ projectId: tenantId });
    const serverChannelsConfig = tenantDoc?.notifications?.channels;

    const result = await dispatcher.dispatch(
      tenantId,
      body.eventId || 'testAlert',
      body.payload || {
        test: true,
        message: 'Manual test alert from JourneyAX Backoffice Console',
        dispatchedAt: new Date().toISOString(),
      },
      serverChannelsConfig,
      {
        recipients: body.recipients,
      }
    );

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
