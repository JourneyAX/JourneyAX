"use client";

/**
 * Account — the REAL signed-in user + this workspace's organization (B5).
 * User comes from the auth session; org from organization-service.
 */
import React, { useEffect, useState } from "react";
import { UserRound, Building2 } from "lucide-react";
import type { Project } from "../lib/api";

const ORG_API = process.env.NEXT_PUBLIC_ORG_API || "http://localhost:8085";

export function AccountView({ project }: { project: Project }) {
  const [user, setUser] = useState<{ email?: string; fullName?: string; role?: string; tenantId?: string } | null>(null);
  const [org, setOrg] = useState<any>(null);

  useEffect(() => {
    try { setUser(JSON.parse(sessionStorage.getItem("jax_user") || "null")); } catch {}
  }, []);

  useEffect(() => {
    setOrg(null);
    if (!project.orgId) return;
    fetch(`${ORG_API}/api/v1/organizations/${encodeURIComponent(project.orgId)}`)
      .then((r) => (r.ok ? r.json() : null)).then(setOrg).catch(() => {});
  }, [project.orgId]);

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Account &amp; Company</h1>
          <p className="pagesub">Your signed-in account and the organization behind <b>{project.companyName}</b>.</p>
        </div>
      </div>

      <div className="cardrow">
        <div className="panel">
          <div className="micro"><UserRound size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />SIGNED IN AS</div>
          {user ? (
            <div className="who" style={{ marginTop: 4 }}>
              <div className="av2" style={{ width: 40, height: 40, fontSize: 14 }}>{(user.fullName || user.email || "?").slice(0, 2).toUpperCase()}</div>
              <div>
                <b style={{ fontSize: 14 }}>{user.fullName || user.email}</b>
                <div className="role">{user.email}</div>
                <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                  <span className="pill p-active">{user.role || "user"}</span>
                  <span className="pill p-offline">{user.tenantId || "platform"}</span>
                </div>
              </div>
            </div>
          ) : <span className="role">Session not found — sign in again.</span>}
        </div>

        <div className="panel">
          <div className="micro"><Building2 size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />ORGANIZATION</div>
          {org ? (
            <div style={{ marginTop: 4 }}>
              <b style={{ fontSize: 14 }}>{org.name || org.companyName || project.companyName}</b>
              <div className="role">{org.domain || project.domain}</div>
              <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="pill p-offline">org: {project.orgId}</span>
                {org.country && <span className="pill p-offline">{org.country}</span>}
                {Array.isArray(org.projects) && <span className="pill p-active">{org.projects.length} project(s)</span>}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 4 }}>
              <b style={{ fontSize: 14 }}>{project.companyName}</b>
              <div className="role">{project.domain}</div>
              <span className="fhelp">Organization record not reachable (org-service) — showing project identity.</span>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="micro">WORKSPACE</div>
        <div className="form-grid" style={{ marginTop: 4 }}>
          <div><span className="flabel">Project ID</span><div className="node">{project.projectId}</div></div>
          <div><span className="flabel">Status</span><div className="node">{project.status} · v{project.activeVersion ?? "draft"}</div></div>
          <div><span className="flabel">Currency</span><div className="node">{project.pricing?.currency} ({project.pricing?.symbol})</div></div>
          <div><span className="flabel">Storefront domain</span><div className="node">{project.domain}</div></div>
        </div>
      </div>
    </>
  );
}
