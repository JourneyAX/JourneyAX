/**
 * Data-maintenance BFF (AUG-18).
 *
 * These repairs — reindex, dedupe, purge — previously had to be run by hand
 * against the database: no authorisation, no audit trail, not repeatable by an
 * operator. This puts them on the SAME path as ingestion: authenticated,
 * `knowledge.ingest`-checked, tenant-validated, gateway-routed.
 *
 *   POST /api/knowledge/maintenance { projectId, op, dryRun }
 *
 * dryRun defaults to TRUE — a destructive default would be the wrong one.
 */
import { resolve } from 'path';
import { config as dotenv } from 'dotenv';
// Next only auto-loads .env from the app dir; service URLs and the internal key
// live in the monorepo root .env.
dotenv({ path: resolve(process.cwd(), '../../.env') });

import { NextResponse } from 'next/server';
import { requireAuth, tenantAllowed } from '../../../../lib/require-auth';
import { readCookie, COOKIE_AT } from '../../../../lib/bff-auth';

const GATEWAY_URL = () => process.env.GATEWAY_URL || 'http://localhost:3010';
const PRODUCT_API = () => process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
const INTERNAL_KEY = () => process.env.INTERNAL_API_KEY || '';

/** Same trusted-caller pattern as the ingestion BFF: the operator is already
 *  authenticated here, and the internal key never reaches the browser. */
async function callService(path: string, init: RequestInit, token?: string) {
  const key = INTERNAL_KEY();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
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

  let body: { projectId?: string; op?: string; dryRun?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }

  const projectId = (body.projectId || '').toLowerCase();
  const op = (body.op || '').trim();
  if (!projectId || !op) return NextResponse.json({ ok: false, error: 'projectId and op are required.' }, { status: 400 });
  if (!tenantAllowed(auth.identity, projectId)) {
    return NextResponse.json({ ok: false, error: 'Not authorised for this project.' }, { status: 403 });
  }

  const res = await callService(
    `/api/v1/${encodeURIComponent(projectId)}/products/maintenance`,
    { method: 'POST', body: JSON.stringify({ op, dryRun: body.dryRun !== false }) },
    readCookie(req, COOKIE_AT),
  );
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
