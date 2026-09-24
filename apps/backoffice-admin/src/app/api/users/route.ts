/**
 * /api/users — Real platform users and project members management.
 * Connects via API Gateway to auth-service and project-service.
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
    const tenantId = scopeTenant(auth.identity, url.searchParams.get("tenantId"));

    // 1. Fetch auth users
    const authRes = await fetch(
      `${GATEWAY_URL}/api/v1/auth/users${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    ).catch(() => null);

    const authData = authRes && authRes.ok ? await authRes.json() : { users: [] };
    const authUsers: any[] = authData.users || [];

    // 2. Fetch project members if tenantId is available
    let projectMembers: any[] = [];
    if (tenantId) {
      const membersRes = await fetch(
        `${GATEWAY_URL}/api/v1/projects/${encodeURIComponent(tenantId)}/members`,
        { headers: { Authorization: `Bearer ${auth.token}` } }
      ).catch(() => null);
      if (membersRes && membersRes.ok) {
        projectMembers = await membersRes.json();
      }
    }

    // 3. Merge members and auth users into a unified map keyed by email
    const userMap = new Map<string, any>();
    for (const u of authUsers) {
      userMap.set(u.email.toLowerCase(), {
        email: u.email,
        fullName: u.fullName || u.email,
        role: u.role || 'viewer',
        tenantId: u.tenantId || 'platform',
        createdAt: u.createdAt,
        isActive: u.isActive !== false,
        source: 'auth',
      });
    }

    for (const m of projectMembers) {
      const key = m.email.toLowerCase();
      const existing = userMap.get(key);
      userMap.set(key, {
        email: m.email,
        fullName: m.fullName || existing?.fullName || m.email,
        role: m.role || existing?.role || 'viewer',
        tenantId: m.projectId || tenantId,
        createdAt: m.invitedAt || existing?.createdAt,
        isActive: m.isActive !== false,
        source: 'project_member',
      });
    }

    return NextResponse.json({ users: Array.from(userMap.values()) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req, "user.manage");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

    const body = await req.json();
    const tenantId = scopeTenant(auth.identity, body.tenantId || body.projectId);
    if (!tenantId) {
      return NextResponse.json({ error: "Missing tenantId" }, { status: 400 });
    }
    if (!body.email || !body.fullName) {
      return NextResponse.json({ error: "Email and Full Name are required" }, { status: 400 });
    }

    const res = await fetch(`${GATEWAY_URL}/api/v1/projects/${encodeURIComponent(tenantId)}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        email: body.email.trim().toLowerCase(),
        fullName: body.fullName.trim(),
        role: body.role || 'viewer',
        orgId: body.orgId,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Gateway returned ${res.status}`);
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req, "user.manage");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

    const body = await req.json();
    const tenantId = scopeTenant(auth.identity, body.tenantId || body.projectId);
    if (!tenantId || !body.email) {
      return NextResponse.json({ error: "Missing tenantId or email" }, { status: 400 });
    }

    const email = body.email.trim().toLowerCase();
    const res = await fetch(
      `${GATEWAY_URL}/api/v1/projects/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          role: body.role,
          isActive: body.isActive,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Gateway returned ${res.status}`);
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAuth(req, "user.manage");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

    const url = new URL(req.url);
    const tenantId = scopeTenant(auth.identity, url.searchParams.get("tenantId"));
    const email = url.searchParams.get("email");
    if (!tenantId || !email) {
      return NextResponse.json({ error: "Missing tenantId or email" }, { status: 400 });
    }

    const res = await fetch(
      `${GATEWAY_URL}/api/v1/projects/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(email.trim().toLowerCase())}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}` },
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Gateway returned ${res.status}`);
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
