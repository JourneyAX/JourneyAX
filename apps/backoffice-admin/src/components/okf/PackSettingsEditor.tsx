"use client";

import React, { useState } from "react";
import { Save, RotateCcw } from "lucide-react";
import { projectApi, type Project } from "../../lib/api";
import { CatalogMappingForm } from "./CatalogMappingForm";

type SettingKey = "catalogMapping" | "routingPolicy" | "interpretationPolicy" | "workspacePinPolicy" | "dialoguePolicy";

const SETTINGS: Array<{ key: SettingKey; title: string; help: string; read: (project: Project) => unknown }> = [
  {
    key: "catalogMapping",
    title: "Catalogue mapping",
    help: "Which product fields hold price, currency, stock, lifecycle status, attributes and category scope. Unset fields use platform defaults; a price without a declared currency is never quoted.",
    read: (project) => project.catalogMapping,
  },
  {
    key: "routingPolicy",
    title: "Default journey",
    help: "The journey that answers a request no other journey matches, as {\"defaultJourneyId\": \"<journey id>\", \"fallbackOnCatalogSearch\": true}. A project with several journeys cannot be published until this is set; the platform never picks one for you.",
    read: (project) => project.routingPolicy,
  },
  {
    key: "interpretationPolicy",
    title: "Interpretation policy",
    help: "Money and quantity wording, grounding words, prompt rules and fallback messages used when reading customer messages. Unset values use platform defaults.",
    read: (project) => project.extensions?.interpretationPolicy,
  },
  {
    key: "dialoguePolicy",
    title: "Conversation flow",
    help: "How the assistant decides each turn: when it asks a question, when it recommends one product and says why, when it shows a short list, and the sentences it uses. Set only the sections you want to change (for example {\"ask\": {\"maxPerConcept\": 1}}); everything else keeps the platform defaults.",
    read: (project) => project.extensions?.dialoguePolicy,
  },
  {
    key: "workspacePinPolicy",
    title: "Workspace pin policy",
    help: "Optional: move idle conversations to the active release after this many hours, only when it can host the conversation. Empty keeps every conversation on its original release.",
    read: (project) => project.extensions?.workspacePinPolicy,
  },
];

const pretty = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2));

export function PackSettingsEditor({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const [text, setText] = useState<Record<SettingKey, string>>(() => Object.fromEntries(SETTINGS.map((s) => [s.key, pretty(s.read(project))])) as Record<SettingKey, string>);
  const [busy, setBusy] = useState<SettingKey | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function save(key: SettingKey, value: unknown) {
    setBusy(key); setMessage(null);
    try {
      await projectApi.update(project.projectId, { [key]: value });
      setMessage({ tone: "ok", text: value === null ? "Reverted to platform defaults." : "Saved. It takes effect on the next Business Pack publish." });
      onSaved?.();
    } catch (error: any) {
      setMessage({ tone: "bad", text: error.message || String(error) });
    } finally { setBusy(null); }
  }

  function submit(key: SettingKey) {
    const raw = text[key].trim();
    if (!raw) return save(key, null);
    try { return save(key, JSON.parse(raw)); }
    catch { setMessage({ tone: "bad", text: "That is not valid JSON." }); }
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="micro">PACK SETTINGS</div>
      <h3 style={{ margin: "4px 0" }}>Business rules the platform reads from your pack</h3>
      <p className="micro" style={{ color: "var(--jx-gray-600)" }}>Nothing here is built into the product. Each setting is validated by the service before it is stored and is part of the published, checksummed release.</p>
      {message && <div className="node" style={{ marginBottom: 8, borderColor: message.tone === "ok" ? "#52c41a" : "var(--jx-destructive)" }} role="status">{message.text}</div>}
      <details style={{ marginBottom: 8 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Catalogue mapping</summary>
        <p className="micro" style={{ color: "var(--jx-gray-600)" }}>{SETTINGS[0].help}</p>
        <CatalogMappingForm project={project} onSaved={onSaved} />
      </details>
      {SETTINGS.filter((setting) => setting.key !== "catalogMapping").map((setting) => (
        <details key={setting.key} style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{setting.title}</summary>
          <p className="micro" style={{ color: "var(--jx-gray-600)" }}>{setting.help}</p>
          <textarea className="inp" style={{ width: "100%", minHeight: 140, fontFamily: "monospace", fontSize: 11 }} aria-label={setting.title}
            value={text[setting.key]} onChange={(e) => setText({ ...text, [setting.key]: e.target.value })} placeholder="Empty = platform defaults" />
          <div className="actions" style={{ marginTop: 6 }}>
            <button className="btn" disabled={busy !== null} onClick={() => submit(setting.key)}><Save size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Save</button>
            <button className="btn" disabled={busy !== null} onClick={() => { setText({ ...text, [setting.key]: "" }); save(setting.key, null); }}><RotateCcw size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Use defaults</button>
          </div>
        </details>
      ))}
    </div>
  );
}
