"use client";

/**
 * Agent Embed — how the agentic-commerce (AX) surface drops onto the customer's
 * OWN e-commerce site. Configures the widget launcher, gives the copy-paste
 * <script> snippet, and shows a LIVE preview of the real embedded agent.
 *
 * This is the "integrate into an actual e-commerce website" story: the customer
 * pastes one tag; the loader injects a floating launcher + an iframe of the AX
 * surface in embed mode (?project=<id>&embed=1), themed from published config.
 */
import React, { useEffect, useState } from "react";
import { Save, Code2, Copy, Check, MonitorSmartphone } from "lucide-react";
import { projectApi, type Project } from "../lib/api";

const STOREFRONT = process.env.NEXT_PUBLIC_STOREFRONT_URL || "http://localhost:3008";

export function AgentEmbed({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const e0 = project.embed || {};
  const [label, setLabel] = useState(e0.launcherLabel || `Ask ${project.persona?.systemName || "our expert"}`);
  const [position, setPosition] = useState<"right" | "left">(e0.position || "right");
  const [color, setColor] = useState(e0.launcherColor || project.theme?.primaryColor || "#FFD600");
  const [origins, setOrigins] = useState((e0.allowedOrigins || ["*"]).join("\n"));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    const e = project.embed || {};
    setLabel(e.launcherLabel || `Ask ${project.persona?.systemName || "our expert"}`);
    setPosition(e.position || "right");
    setColor(e.launcherColor || project.theme?.primaryColor || "#FFD600");
    setOrigins((e.allowedOrigins || ["*"]).join("\n"));
  }, [project.projectId]);

  const snippet =
    `<script src="${STOREFRONT}/embed.js"\n        data-project="${project.projectId}"\n` +
    `        data-label="${label.replace(/"/g, "&quot;")}"\n        data-position="${position}"\n` +
    `        data-accent="${color}" async></script>`;

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await projectApi.update(project.projectId, {
        embed: {
          launcherLabel: label,
          position,
          launcherColor: color,
          allowedOrigins: origins.split("\n").map((s) => s.trim()).filter(Boolean),
        },
      });
      setSaved(true); onSaved(); setPreviewKey((k) => k + 1);
      setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  }

  function copy() {
    navigator.clipboard.writeText(snippet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Agent Embed</h1>
          <p className="pagesub">
            Drop <b>{project.companyName}</b>'s agentic-commerce assistant onto any website — the customer pastes one line.
          </p>
        </div>
        <div className="actions">
          <button className="btn y" onClick={save} disabled={saving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
          </button>
        </div>
      </div>

      <div className="cardrow">
        {/* Launcher config */}
        <div className="panel">
          <h4><MonitorSmartphone size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Launcher</h4>
          <div className="form-grid">
            <div className="full"><span className="flabel">Button label</span>
              <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ask our expert" /></div>
            <div><span className="flabel">Corner</span>
              <select className="field" value={position} onChange={(e) => setPosition(e.target.value as "right" | "left")}>
                <option value="right">Bottom right</option>
                <option value="left">Bottom left</option>
              </select></div>
            <div><span className="flabel">Accent colour</span>
              <div className="row">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 40, height: 38, border: "1px solid var(--jx-gray-300)", borderRadius: 8, cursor: "pointer" }} />
                <input className="field" value={color} onChange={(e) => setColor(e.target.value)} style={{ flex: 1 }} />
              </div></div>
            <div className="full"><span className="flabel">Allowed site origins (one per line · "*" = any)</span>
              <textarea className="field" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder={"*\nhttps://www.customer-store.com"} /></div>
          </div>
        </div>

        {/* Snippet */}
        <div className="panel">
          <div className="between">
            <h4><Code2 size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Install snippet</h4>
            <button className="btn" onClick={copy}>
              {copied ? <Check size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} /> : <Copy size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "2px 0 8px" }}>Paste this before <code>&lt;/body&gt;</code> on any page of the customer's site.</p>
          <pre style={{ background: "var(--jx-black)", color: "#E8E8E8", borderRadius: 10, padding: "14px 16px", fontSize: 11.5, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowX: "auto", margin: 0 }}>
            {snippet}
          </pre>
          <span className="fhelp">
            Uses the PUBLISHED config: brand, persona, journey, capabilities and knowledge — same agent as the storefront. Save + Publish for changes to reach live embeds.
          </span>
        </div>
      </div>

      {/* Live preview — the real embedded agent */}
      <div className="panel">
        <div className="micro">LIVE PREVIEW — the actual embedded agent for this project</div>
        <div style={{ position: "relative", border: "1px solid var(--jx-gray-200)", borderRadius: 12, overflow: "hidden", height: 560, background: "var(--jx-gray-100)" }}>
          <iframe
            key={previewKey}
            title="Agent preview"
            src={`${STOREFRONT}/?project=${encodeURIComponent(project.projectId)}&embed=1`}
            style={{ width: "100%", height: "100%", border: 0 }}
          />
        </div>
        <span className="fhelp">This is the exact surface your customers' visitors interact with, in the embed layout.</span>
      </div>
    </>
  );
}
