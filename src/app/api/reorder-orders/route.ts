import { filterOrdersForViewer, resolveReorderViewer } from '../../../lib/reorder-authorization';

export const dynamic = 'force-dynamic';

type ReorderOrder = { school: string } & Record<string, unknown>;

export async function GET(request: Request) {
  const viewer = resolveReorderViewer(request);
  if (!viewer) {
    return Response.json({ error: 'Sign in with an authorized school account to view reorder history.' }, { status: 401 });
  }

  const search = new URL(request.url).searchParams.get('q')?.trim().slice(0, 120) ?? '';
  const serviceUrl = process.env.REORDER_DATA_API_URL || 'http://127.0.0.1:3101';
  try {
    const response = await fetch(`${serviceUrl}/orders?q=${encodeURIComponent(search)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Order data service returned ${response.status}`);
    const payload = await response.json() as { records?: ReorderOrder[]; source?: string };
    const authorizedRecords = filterOrdersForViewer(payload.records ?? [], viewer);
    return Response.json({
      records: authorizedRecords,
      source: payload.source,
      viewer: {
        name: viewer.name,
        role: viewer.role,
        schools: viewer.schools,
        authentication: viewer.source,
      },
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Reorder order lookup failed', error instanceof Error ? error.message : 'Unknown data service error');
    return Response.json({ error: 'Reorder history is temporarily unavailable.' }, { status: 503 });
  }
}
