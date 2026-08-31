/**
 * GET /api/users?tenantId=… — REAL platform users from auth-service's collection
 * (journeyx.users), scoped by tenant (B5 — replaces the static Users & Roles rows).
 * Passwords/hashes are never projected.
 */
import { NextResponse } from "next/server";
import { requireAuth, scopeTenant } from "../../../lib/require-auth";

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "user.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const url = new URL(req.url);
    // Tenant comes from the IDENTITY, not the caller's query string (isolation).
    const tenantId = scopeTenant(auth.identity, url.searchParams.get("tenantId"));

    const res = await fetch(`${GATEWAY_URL}/api/v1/auth/users${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
