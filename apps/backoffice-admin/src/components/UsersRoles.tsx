"use client";

/**
 * Users & Roles — Real team member invitations, role management, and access control.
 * Connected directly to auth-service and project-service member registries.
 */
import React, { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, UserPlus, UserX, Trash2, CheckCircle2, AlertCircle, X } from "lucide-react";
import type { Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";

const ROLES = [
  { id: "owner", label: "Owner", description: "Full workspace & billing administration" },
  { id: "admin", label: "Admin", description: "Publishing, configuration & user management" },
  { id: "manager", label: "Manager", description: "Workflow review, catalog & analytics" },
  { id: "analyst", label: "Analyst", description: "Reporting and analytics viewing" },
  { id: "viewer", label: "Viewer", description: "Read-only workspace visibility" },
];

export function UsersRoles({ project }: { project: Project }) {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Invite modal state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("manager");
  const [inviting, setInviting] = useState(false);

  // Revoke modal state
  const [memberToRevoke, setMemberToRevoke] = useState<any | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Updating role state tracking
  const [updatingEmail, setUpdatingEmail] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await authedFetch(`/api/users?tenantId=${encodeURIComponent(project.projectId)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setUsers(d.users || []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [project.projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail || !inviteName) return;

    setInviting(true);
    setError(null);
    try {
      const r = await authedFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: project.projectId,
          email: inviteEmail.trim(),
          fullName: inviteName.trim(),
          role: inviteRole,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to invite member");

      setNotice(`Invitation sent successfully to ${inviteEmail}.`);
      setShowInviteModal(false);
      setInviteEmail("");
      setInviteName("");
      setInviteRole("manager");
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (email: string, newRole: string) => {
    setUpdatingEmail(email);
    setError(null);
    try {
      const r = await authedFetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: project.projectId,
          email,
          role: newRole,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to update role");

      setNotice(`Role for ${email} updated to ${newRole}.`);
      setUsers((prev) =>
        prev.map((u) => (u.email.toLowerCase() === email.toLowerCase() ? { ...u, role: newRole } : u))
      );
    } catch (err: any) {
      setError(err.message);
      await load();
    } finally {
      setUpdatingEmail(null);
    }
  };

  const handleRevokeConfirm = async () => {
    if (!memberToRevoke) return;
    setRevoking(true);
    setError(null);
    try {
      const r = await authedFetch(
        `/api/users?tenantId=${encodeURIComponent(project.projectId)}&email=${encodeURIComponent(
          memberToRevoke.email
        )}`,
        { method: "DELETE" }
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to revoke access");

      setNotice(`Access revoked for ${memberToRevoke.email}.`);
      setMemberToRevoke(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Users &amp; Roles</h1>
          <p className="pagesub">
            Manage authorized team accounts, workspace invitations, and role assignments for <b>{project.companyName}</b>.
          </p>
        </div>
        <div className="actions" style={{ display: "flex", gap: "8px" }}>
          <button className="btn" onClick={() => setShowInviteModal(true)} style={{ background: "var(--jx-yellow)", color: "var(--jx-black)", fontWeight: 600 }}>
            <UserPlus size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Invite Member
          </button>
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {notice && (
        <div
          className="panel"
          style={{
            borderColor: "var(--jx-success)",
            color: "var(--jx-success)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "16px",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <CheckCircle2 size={16} /> {notice}
          </span>
          <button onClick={() => setNotice(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div
          className="panel"
          style={{
            borderColor: "var(--jx-destructive)",
            color: "var(--jx-destructive)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "16px",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <AlertCircle size={16} /> {error}
          </span>
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="panel">
        <div className="micro">WORKSPACE MEMBERS ({users.length})</div>
        <div className="tblwrap" style={{ marginTop: 8 }}>
          <div className="theadr" style={{ gridTemplateColumns: "1.8fr 1.6fr 1.2fr 0.9fr 0.9fr 0.8fr" }}>
            <span>User</span>
            <span>Email</span>
            <span>Role</span>
            <span>Workspace</span>
            <span>Created</span>
            <span style={{ textAlign: "right" }}>Actions</span>
          </div>

          {users.map((u) => {
            const isUpdating = updatingEmail === u.email;
            return (
              <div key={u.email} className="trow" style={{ gridTemplateColumns: "1.8fr 1.6fr 1.2fr 0.9fr 0.9fr 0.8fr", alignItems: "center" }}>
                <div className="who">
                  <div className="av2">{(u.fullName || u.email || "?").slice(0, 2).toUpperCase()}</div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <b>{u.fullName || u.email}</b>
                    {u.source === "project_member" && (
                      <span style={{ fontSize: "11px", color: "var(--jx-gray-500)" }}>Project Member</span>
                    )}
                  </div>
                  {u.role === "admin" || u.role === "owner" ? (
                    <ShieldCheck size={14} style={{ color: "var(--jx-yellow-dark)", marginLeft: "4px" }} />
                  ) : null}
                </div>

                <span className="role" style={{ wordBreak: "break-all" }}>{u.email}</span>

                <div>
                  <select
                    className="select-role"
                    value={u.role || "viewer"}
                    disabled={isUpdating}
                    onChange={(e) => handleRoleChange(u.email, e.target.value)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      border: "1px solid var(--jx-gray-300)",
                      background: "var(--surface-base)",
                      color: "var(--text-strong)",
                      cursor: "pointer",
                      width: "110px",
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>

                <span className="role">{u.tenantId || project.projectId}</span>

                <span className="role">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</span>

                <div style={{ textAlign: "right" }}>
                  <button
                    className="btn-danger"
                    title="Revoke member access"
                    onClick={() => setMemberToRevoke(u)}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--jx-gray-300)",
                      color: "var(--jx-destructive)",
                      borderRadius: "6px",
                      padding: "4px 8px",
                      cursor: "pointer",
                    }}
                  >
                    <Trash2 size={13} style={{ verticalAlign: "-2px" }} />
                  </button>
                </div>
              </div>
            );
          })}

          {users.length === 0 && !loading && (
            <div style={{ padding: "24px", textAlign: "center", color: "var(--jx-gray-500)" }}>
              No members configured yet. Use &ldquo;Invite Member&rdquo; above to grant access.
            </div>
          )}
        </div>
      </div>

      {/* ── Invite Member Modal ──────────────────────────────────────────────── */}
      {showInviteModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="panel"
            style={{
              width: "100%",
              maxWidth: "480px",
              backgroundColor: "var(--surface-base)",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              borderRadius: "12px",
              padding: "24px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Invite Team Member</h2>
              <button
                onClick={() => setShowInviteModal(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--jx-gray-500)" }}
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: "13px", color: "var(--jx-gray-600)", marginBottom: "20px" }}>
              Invite a user to collaborate on <b>{project.companyName}</b>. They will receive immediate access based on their assigned role.
            </p>

            <form onSubmit={handleInviteSubmit}>
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Alex Mercer"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "14px",
                  }}
                />
              </div>

              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  placeholder="alex@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "14px",
                  }}
                />
              </div>

              <div style={{ marginBottom: "24px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                  Role &amp; Permissions
                </label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "14px",
                    background: "var(--surface-base)",
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} — {r.description}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowInviteModal(false)}
                  disabled={inviting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn"
                  disabled={inviting}
                  style={{ background: "var(--jx-yellow)", color: "var(--jx-black)", fontWeight: 600 }}
                >
                  {inviting ? "Inviting…" : "Send Invitation"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Revoke Confirmation Modal ───────────────────────────────────────── */}
      {memberToRevoke && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="panel"
            style={{
              width: "100%",
              maxWidth: "420px",
              backgroundColor: "var(--surface-base)",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              borderRadius: "12px",
              padding: "24px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  backgroundColor: "rgba(217, 45, 32, 0.1)",
                  color: "var(--jx-destructive)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <UserX size={20} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Revoke Member Access</h3>
                <span style={{ fontSize: "12px", color: "var(--jx-gray-500)" }}>{memberToRevoke.email}</span>
              </div>
            </div>

            <p style={{ fontSize: "13px", color: "var(--jx-gray-600)", marginBottom: "24px" }}>
              Are you sure you want to revoke access for <b>{memberToRevoke.fullName || memberToRevoke.email}</b> from <b>{project.companyName}</b>? They will immediately lose access to this workspace.
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setMemberToRevoke(null)}
                disabled={revoking}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleRevokeConfirm}
                disabled={revoking}
                style={{ backgroundColor: "var(--jx-destructive)", color: "#FFFFFF", fontWeight: 600, border: "none" }}
              >
                {revoking ? "Revoking…" : "Revoke Access"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
