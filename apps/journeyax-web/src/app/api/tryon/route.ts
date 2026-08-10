// POST /api/tryon — virtual try-on: composite a catalogue garment onto the shopper's
// uploaded photo. Consent + "AI preview, not a fit guarantee" is enforced by the UI.
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;                 // image generation can take 10–40s

const MAX_PERSON_BYTES = 8 * 1024 * 1024;      // cap the uploaded photo at ~8MB
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const personDataUrl: string = body?.personImage || '';
    const garmentImageUrl: string = body?.garmentImageUrl || '';
    if (!personDataUrl.startsWith('data:image/')) {
      return NextResponse.json({ error: 'A photo of yourself is required.' }, { status: 400 });
    }
    if (!/^https?:\/\//.test(garmentImageUrl)) {
      return NextResponse.json({ error: 'A valid garment image is required.' }, { status: 400 });
    }
    // rough size guard (base64 is ~1.37x the raw bytes)
    if (personDataUrl.length * 0.75 > MAX_PERSON_BYTES) {
      return NextResponse.json({ error: 'Please use a photo under 8MB.' }, { status: 413 });
    }

    const projectId = (
      req.headers.get('x-tenant-id') ||
      req.nextUrl.searchParams.get('project') ||
      process.env.DEFAULT_PROJECT_ID ||
      'caroma'
    ).toLowerCase();

    const res = await fetch(`${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/products/tryon`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': projectId,
      },
      body: JSON.stringify({
        personDataUrl,
        garmentImageUrl,
        garmentName: typeof body?.garmentName === 'string' ? body.garmentName.slice(0, 120) : undefined,
        garmentColor: typeof body?.garmentColor === 'string' ? body.garmentColor.slice(0, 60) : undefined,
      }),
      signal: AbortSignal.timeout(55000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: err.message || 'Could not generate the preview.' }, { status: res.status });
    }

    const out = await res.json();
    return NextResponse.json({ image: out.imageDataUrl, provider: out.provider });
  } catch (e: any) {
    console.error('[tryon] failed:', e?.message);
    return NextResponse.json({ error: 'Could not generate the preview. Please try another photo.' }, { status: 500 });
  }
}
