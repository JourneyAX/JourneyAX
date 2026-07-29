"use client";

/**
 * Channels — per-tenant channel config. The WhatsApp panel captures the project's
 * own Cloud API credentials (phone number id + access token), stored on the
 * project config (project-service). The webhook resolves the tenant by phone
 * number id at runtime, so every project runs its own WhatsApp number/token —
 * no shared env, fully multi-tenant.
 */
import React, { useEffect, useState } from "react";
import { MessageCircle, Save, Globe } from "lucide-react";
import { projectApi, type Project } from "../lib/api";

export function ChannelsConfig({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const wa0 = project.integrations?.whatsapp || { enabled: false };
  const [enabled, setEnabled] = useState<boolean>(!!wa0.enabled);
  const [phoneNumberId, setPhoneNumberId] = useState(wa0.phoneNumberId || "");
  const [accessToken, setAccessToken] = useState(wa0.accessToken || "");
  const [wabaId, setWabaId] = useState(wa0.wabaId || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wa = project.integrations?.whatsapp || { enabled: false };
    setEnabled(!!wa.enabled);
    setPhoneNumberId(wa.phoneNumberId || "");
    setAccessToken(wa.accessToken || "");
    setWabaId(wa.wabaId || "");
  }, [project.projectId]);

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await projectApi.update(project.projectId, {
        channels: { whatsapp: enabled },
        integrations: {
          whatsapp: { enabled, phoneNumberId: phoneNumberId.trim(), accessToken: accessToken.trim(), wabaId: wabaId.trim() },
        },
      });
      setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }


  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Channels</h1>
          <p className="pagesub">Where <b>{project.companyName}</b>'s agent meets customers. Each channel's credentials are stored on this workspace — never shared across tenants.</p>
        </div>
        <div className="actions">
          <button className="btn y" onClick={save} disabled={saving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save channel config"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}

      {/* Web — always on */}
      <div className="panel">
        <div className="between">
          <h4><Globe size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Web storefront</h4>
          <span className="pill p-active">Always on</span>
        </div>
        <p className="micro" style={{ color: "var(--jx-gray-600)", marginTop: 4 }}>The embedded journey chat on this workspace's storefront.</p>
      </div>

      {/* WhatsApp */}
      <div className="panel">
        <div className="between">
          <h4><MessageCircle size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />WhatsApp (Cloud API)</h4>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <span className="micro">{enabled ? "Enabled" : "Disabled"}</span>
            <div className={`switch ${enabled ? "on" : ""}`} onClick={() => setEnabled((v) => !v)} />
          </label>
        </div>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
          From Meta → WhatsApp → API Setup. The webhook routes inbound messages to this workspace by its Phone number ID.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <span className="flabel">Phone number ID</span>
            <input className="field" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="123456789012345" />
          </div>
          <div>
            <span className="flabel">WABA ID (optional)</span>
            <input className="field" value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="098765432109876" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <span className="flabel">Access token</span>
            <input className="field" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="EAAG… (System-User token)" />
            <span className="micro" style={{ color: "var(--jx-gray-500)" }}>Stored on this workspace. Used only to send replies for this tenant.</span>
          </div>
        </div>
      </div>
    </>
  );
}
