/**
 * GET /api/users?tenantId=… — REAL platform users from auth-service's collection
 * (journeyx.users), scoped by tenant (B5 — replaces the static Users & Roles rows).
 * Passwords/hashes are never projected.
 */
import { NextResponse } from "next/server";
import { knowledgeDb } from "../../../lib/mongo-server";
import { requireAuth, scopeTenant } from "../../../lib/require-auth";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "user.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const url = new URL(req.url);
    // Tenant comes from the IDENTITY, not the caller's query string (isolation).
    const tenantId = scopeTenant(auth.identity, url.searchParams.get("tenantId"));
    const db = await knowledgeDb();
    const users = db.collection("users");
    // Platform admins (tenantId 'platform'/missing) are shown to every workspace;
    // tenant users only within their own workspace.
    const filter = tenantId
      ? { $or: [{ tenantId }, { tenantId: { $in: ["platform", null] } }, { tenantId: { $exists: false } }] }
      : {};
    const list = await users
      .find(filter)
      .project({ _id: 0, passwordHash: 0, password: 0 })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return NextResponse.json({ users: list });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
