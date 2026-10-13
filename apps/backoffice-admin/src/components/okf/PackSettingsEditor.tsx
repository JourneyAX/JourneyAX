"use client";

import React, { useEffect, useState } from "react";
import { Save, RotateCcw } from "lucide-react";
import { projectApi, type Project } from "../../lib/api";
import { CatalogMappingForm } from "./CatalogMappingForm";
import { settingStatus, type SettingKey } from "./okf-model";

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
    title: "How the assistant reads money, quantities and wording",
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
    title: "Moving old conversations to a new release",
    help: "Optional: move idle conversations to the active release after this many hours, only when it can host the conversation. Empty keeps every conversation on its original release.",
    read: (project) => project.extensions?.workspacePinPolicy,
  },
];

const pretty = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2));

export function PackSettingsEditor({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const [text, setText] = useState<Record<SettingKey, string>>(() => Object.fromEntries(SETTINGS.map((s) => [s.key, pretty(s.read(project))])) as Record<SettingKey, string>);
  const [busy, setBusy] = useState<SettingKey | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  // The boxes were filled once, from whatever the project looked like at that moment. When the project is reloaded (another workspace, or
  // a release applied outside this screen) they must show what is stored now, not what was there when the page opened.
  const stored = JSON.stringify(SETTINGS.map((setting) => setting.read(project) ?? null));
  useEffect(() => {
    setText(Object.fromEntries(SETTINGS.map((s) => [s.key, pretty(s.read(project))])) as Record<SettingKey, string>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.projectId, stored]);

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

  const badge = (key: SettingKey) => {
    const status = settingStatus(key, project);
    return (
      <>
        <span className={`pill ${status.state === "set" ? "p-active" : status.state === "missing" ? "p-inactive" : "p-draft"}`} style={{ marginLeft: 8 }}>
          {status.state === "set" ? "Set" : status.state === "missing" ? "Needs a value" : "Built-in defaults"}
        </span>
        <span className="micro" style={{ display: "block", fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)" }}>{status.text}</span>
      </>
    );
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="micro">PACK SETTINGS</div>
      <h3 style={{ margin: "4px 0" }}>Business rules the platform reads from your pack</h3>
      <p className="micro" style={{ color: "var(--jx-gray-600)", textTransform: "none", letterSpacing: 0 }}>
        Each line says what is in effect right now. &ldquo;Built-in defaults&rdquo; is not a gap: nothing is missing, the platform&apos;s own behaviour applies, and you only fill a box in to change it.
        Every setting is checked by the service before it is stored and becomes part of the published, checksummed release.
      </p>
      {message && <div className="node" style={{ marginBottom: 8, borderColor: message.tone === "ok" ? "#52c41a" : "var(--jx-destructive)" }} role="status">{message.text}</div>}
      <details style={{ marginBottom: 8 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Catalogue mapping{badge("catalogMapping")}</summary>
        <p className="micro" style={{ color: "var(--jx-gray-600)" }}>{SETTINGS[0].help}</p>
        <CatalogMappingForm project={project} onSaved={onSaved} />
      </details>
      {SETTINGS.filter((setting) => setting.key !== "catalogMapping").map((setting) => (
        <details key={setting.key} style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{setting.title}{badge(setting.key)}</summary>
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
