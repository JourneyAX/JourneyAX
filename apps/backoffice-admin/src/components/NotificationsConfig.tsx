"use client";

/**
 * Notifications — PERSISTED per-project alert preferences (B5).
 * Toggles save to project.notifications (draft → Publish, like all config).
 */
import React, { useEffect, useState } from "react";
import { Save, BellRing } from "lucide-react";
import { projectApi, type Project } from "../lib/api";

const EVENTS: { id: string; label: string; desc: string; default: boolean }[] = [
  { id: "quoteBuilt",      label: "Quote built",             desc: "A customer completes a quote / bill of materials with the agent", default: true },
  { id: "orderPlaced",     label: "Order placed",            desc: "A journey reaches the ordered stage", default: true },
  { id: "journeyAbandoned",label: "Journey abandoned",       desc: "A session with items goes quiet for 24h", default: true },
  { id: "highValue",       label: "High-value quote",        desc: "Quote total exceeds the project's alert threshold", default: true },
  { id: "ingestFinished",  label: "Knowledge ingest finished", desc: "A corpus ingest completes or fails", default: false },
  { id: "configPublished", label: "Config published",        desc: "Someone publishes a new config version", default: false },
  { id: "weeklyDigest",    label: "Weekly digest",           desc: "Sessions, funnel and quote summary every Monday", default: true },
];

export function NotificationsConfig({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const initial = () => Object.fromEntries(EVENTS.map((e) => [e.id, project.notifications?.[e.id] ?? e.default]));
  const [prefs, setPrefs] = useState<Record<string, boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPrefs(initial()); }, [project.projectId]);

  async function save() {
    setSaving(true); setError(null);
    try {
      await projectApi.update(project.projectId, { notifications: prefs });
      setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Notifications</h1>
          <p className="pagesub">Which events alert <b>{project.companyName}</b>'s operators. Saved per project.</p>
        </div>
        <div className="actions">
          <button className="btn y" onClick={save} disabled={saving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}

      <div className="panel">
        <div className="micro"><BellRing size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />EVENT ALERTS</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {EVENTS.map((e) => (
            <div key={e.id} className="between" style={{ padding: "10px 4px", borderBottom: "1px solid var(--jx-gray-200)" }}>
              <div>
                <b style={{ fontSize: 13 }}>{e.label}</b>
                <div className="role" style={{ fontSize: 12 }}>{e.desc}</div>
              </div>
              <div
                className={`switch ${prefs[e.id] ? "on" : ""}`}
                onClick={() => setPrefs((p) => ({ ...p, [e.id]: !p[e.id] }))}
              />
            </div>
          ))}
        </div>
        <span className="fhelp">Delivery channels (email/WhatsApp/webhook) attach to these events as the notifier service lands; the preferences are live config today.</span>
      </div>
    </>
  );
}
