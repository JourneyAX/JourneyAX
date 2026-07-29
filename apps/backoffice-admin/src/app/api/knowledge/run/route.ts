/**
 * Ingestion control BFF (AUG-9).
 *
 * The browser holds no token (HttpOnly cookies), so the back office calls this
 * same-origin route; it authenticates, checks the `knowledge.ingest` permission,
 * and forwards to the gateway-routed service endpoint. Ingestion is therefore
 * triggered through the platform's own API contract — never a script.
 *
 *   POST /api/knowledge/run  { projectId, only? }  → { ok, jobId }
 *   GET  /api/knowledge/run?projectId=&jobId=      → live job status
 */
import { resolve } from 'path';
import { config as dotenv } from 'dotenv';
// Next only auto-loads .env from the app dir; service URLs and the internal key
// live in the monorepo root .env (same pattern as lib/mongo-server.ts).
dotenv({ path: resolve(process.cwd(), '../../.env') });

import { NextResponse } from 'next/server';
import { requireAuth, tenantAllowed } from '../../../../lib/require-auth';
import { readCookie, COOKIE_AT } from '../../../../lib/bff-auth';

const GATEWAY_URL = () => process.env.GATEWAY_URL || 'http://localhost:3010';
const PRODUCT_API = () => process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
const INTERNAL_KEY = () => process.env.INTERNAL_API_KEY || '';

/**
 * Call the service through the gateway, presenting BOTH the caller's token and
 * the internal key.
 *
 * This route has already authenticated the operator and verified
 * `knowledge.ingest`, and it runs server-side where the internal key never
 * reaches the browser — so the BFF is a trusted caller in its own right. Sending
 * the key means ingestion still works when the gateway can't vouch for the
 * subject (e.g. an older gateway build that doesn't stamp x-user-permissions),
 * while the downstream service keeps enforcing its own check.
 */
async function callService(path: string, init: RequestInit, token?: string) {
  const key = INTERNAL_KEY();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
    ...(key ? { 'X-Internal-Key': key } : {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const viaGateway = await fetch(`${GATEWAY_URL()}${path}`, { ...init, headers });
    if (![404, 502, 503].includes(viaGateway.status)) return viaGateway;
  } catch { /* gateway unavailable → fall through to the service */ }
  return fetch(`${PRODUCT_API()}${path}`, { ...init, headers });
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, 'knowledge.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.message }, { status: auth.status });

  let body: { projectId?: string; only?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }
  const projectId = (body.projectId || '').toLowerCase();
  if (!projectId) return NextResponse.json({ ok: false, error: 'projectId required' }, { status: 400 });
  if (!tenantAllowed(auth.identity, projectId)) {
    return NextResponse.json({ ok: false, error: 'Not authorised for this project.' }, { status: 403 });
  }

  const res = await callService(
    `/api/v1/${encodeURIComponent(projectId)}/products/ingest`,
    { method: 'POST', body: JSON.stringify({ only: body.only }) },
    readCookie(req, COOKIE_AT),
  );
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET(req: Request) {
  const auth = await requireAuth(req, 'knowledge.read');
  if (!auth.ok) return NextResponse.json({ found: false, error: auth.message }, { status: auth.status });

  const url = new URL(req.url);
  const projectId = (url.searchParams.get('projectId') || '').toLowerCase();
  const jobId = url.searchParams.get('jobId') || '';
  if (!projectId || !jobId) return NextResponse.json({ found: false }, { status: 400 });
  if (!tenantAllowed(auth.identity, projectId)) return NextResponse.json({ found: false }, { status: 403 });

  const res = await callService(
    `/api/v1/${encodeURIComponent(projectId)}/products/ingest/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
    readCookie(req, COOKIE_AT),
  );
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
