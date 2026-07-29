"use client";

/**
 * Users & Roles — REAL platform users from auth-service (B5).
 * Lists this workspace's users + platform admins from journeyx.users.
 */
import React, { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";

export function UsersRoles({ project }: { project: Project }) {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await authedFetch(`/api/users?tenantId=${encodeURIComponent(project.projectId)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setUsers(d.users); setError(null);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [project.projectId]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Users &amp; Roles</h1>
          <p className="pagesub">Real accounts with access to <b>{project.companyName}</b> (from auth-service) — platform admins shown for context.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}

      <div className="panel">
        <div className="micro">ACCOUNTS ({users.length})</div>
        <div className="tblwrap" style={{ marginTop: 8 }}>
          <div className="theadr" style={{ gridTemplateColumns: "2fr 1.4fr 0.9fr 0.9fr 1.1fr" }}>
            <span>User</span><span>Email</span><span>Role</span><span>Workspace</span><span>Created</span>
          </div>
          {users.map((u) => (
            <div key={u.email} className="trow" style={{ gridTemplateColumns: "2fr 1.4fr 0.9fr 0.9fr 1.1fr" }}>
              <div className="who">
                <div className="av2">{(u.fullName || u.email || "?").slice(0, 2).toUpperCase()}</div>
                <b>{u.fullName || u.email}</b>
                {u.role === "admin" && <ShieldCheck size={13} style={{ color: "var(--jx-gray-500)" }} />}
              </div>
              <span className="role">{u.email}</span>
              <span><span className={`pill ${u.role === "admin" ? "p-active" : "p-offline"}`}>{u.role || "user"}</span></span>
              <span className="role">{u.tenantId || "platform"}</span>
              <span className="role">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</span>
            </div>
          ))}
        </div>
        <span className="fhelp">Invitations + role editing land with the auth-service member-management endpoints; today accounts are created at onboarding/registration.</span>
      </div>
    </>
  );
}
