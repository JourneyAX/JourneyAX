"use client";

/**
 * PublishControl — the draft → publish → rollback lifecycle (FR-CONFIG-002).
 *
 * Lives in the mini-header so it's visible on every tab. Shows whether the draft
 * has unpublished changes, publishes an immutable config version (with an optional
 * release note), and opens the version history (the audit trail) with one-click
 * rollback. The RUNTIME (agent + storefront) consumes the published version only.
 */
import React, { useEffect, useState } from "react";
import { UploadCloud, History, RotateCcw, X } from "lucide-react";
import { projectApi, type Project, type ConfigVersionMeta } from "../lib/api";

export function PublishControl({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [versions, setVersions] = useState<ConfigVersionMeta[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    try { setVersions(await projectApi.versions(project.projectId)); } catch { setVersions([]); }
  }, [project.projectId]);

  useEffect(() => { load(); setMsg(null); }, [load]);

  const activeMeta = versions.find((v) => v.active);
  // Draft is dirty when it was edited after the active version was published (or never published).
  const dirty = !activeMeta || (!!project.updatedAt && project.updatedAt > activeMeta.publishedAt);

  async function publish() {
    const note = window.prompt("Release note for this version (optional):") ?? undefined;
    setBusy(true); setMsg(null);
    try {
      const r = await projectApi.publish(project.projectId, {
        note: note || undefined,
        publishedBy: (() => { try { return JSON.parse(sessionStorage.getItem("jax_user") || "{}").email; } catch { return undefined; } })(),
      });
      setMsg(`Published v${r.version}`);
      await load(); onChanged();
      setTimeout(() => setMsg(null), 3000);
    } catch (e: any) { setMsg(`Publish failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function rollback(version: number) {
    if (!window.confirm(`Point the live runtime back to v${version}? (Nothing is deleted — you can re-publish or roll forward any time.)`)) return;
    setBusy(true); setMsg(null);
    try {
      await projectApi.rollback(project.projectId, version);
      setMsg(`Rolled back to v${version}`);
      await load(); onChanged();
      setTimeout(() => setMsg(null), 3000);
    } catch (e: any) { setMsg(`Rollback failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
      {msg && <span className="micro" style={{ color: msg.includes("failed") ? "#B7392D" : "var(--jx-gray-600)" }}>{msg}</span>}
      <span
        className="micro"
        title={activeMeta ? `Runtime is on v${activeMeta.version} (published ${new Date(activeMeta.publishedAt).toLocaleString()})` : "Never published — runtime uses the draft"}
        style={{
          padding: "3px 8px", borderRadius: 6, fontWeight: 700, fontSize: 10.5,
          background: dirty ? "rgba(255,214,0,0.25)" : "var(--jx-gray-100)",
          color: "var(--jx-gray-700)", border: "1px solid var(--jx-gray-200)", whiteSpace: "nowrap",
        }}
      >
        {activeMeta ? `v${activeMeta.version}` : "draft"}{dirty ? " · unpublished changes" : " · live"}
      </span>
      <button className="btn y" onClick={publish} disabled={busy}
        style={{ padding: "6px 12px", fontSize: 12 }} title="Snapshot the draft as an immutable version the runtime consumes">
        <UploadCloud size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
        {busy ? "…" : "Publish"}
      </button>
      <button className="btn" onClick={() => setOpen((o) => !o)} title="Version history & rollback"
        style={{ padding: "6px 10px", fontSize: 12 }}>
        <History size={13} style={{ verticalAlign: "-2px" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "120%", right: 0, width: 360, zIndex: 300,
          background: "var(--jx-white)", border: "1px solid var(--jx-gray-200)", borderRadius: 12,
          boxShadow: "0 12px 34px rgba(0,0,0,0.16)", padding: 10,
        }}>
          <div className="between" style={{ marginBottom: 6 }}>
            <b style={{ fontSize: 12.5, color: "var(--jx-black)" }}>Config versions — {project.projectId}</b>
            <button onClick={() => setOpen(false)} style={{ border: "none", background: "transparent", cursor: "pointer" }}><X size={14} /></button>
          </div>
          {versions.length === 0 && (
            <div className="micro" style={{ color: "var(--jx-gray-500)", padding: "6px 2px" }}>
              Never published. The runtime is using the live draft — click Publish to pin a version.
            </div>
          )}
          <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {versions.map((v) => (
              <div key={v.version} style={{
                border: v.active ? "2px solid var(--jx-black)" : "1px solid var(--jx-gray-200)",
                borderRadius: 8, padding: "8px 10px", display: "flex", alignItems: "center", gap: 8,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 12.5, color: "var(--jx-black)" }}>v{v.version}{v.active ? " · live" : ""}</b>
                  <div className="micro" style={{ color: "var(--jx-gray-500)" }}>
                    {new Date(v.publishedAt).toLocaleString()}{v.publishedBy ? ` · ${v.publishedBy}` : ""}
                  </div>
                  {v.note && <div className="micro" style={{ color: "var(--jx-gray-600)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.note}</div>}
                </div>
                {!v.active && (
                  <button className="btn" onClick={() => rollback(v.version)} disabled={busy}
                    style={{ padding: "4px 8px", fontSize: 11 }} title={`Roll runtime back to v${v.version}`}>
                    <RotateCcw size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />Rollback
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
