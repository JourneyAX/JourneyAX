"use client";

/**
 * Cards & Theme — the v3 Card CMS studio (docs/v3-card-cms-architecture.md).
 *
 * A tenant's storefront cards are JSON in Mongo (`cardTemplates`), rendered at
 * runtime by json-render against a fixed catalog of neutral primitives
 * (`@journeyax/ui-cards`). This screen is where that JSON gets edited: theme
 * tokens (layer 1), per-card settings (layer 2), and template overrides
 * (layer 3) — with a live preview on every tab so nothing is a guess.
 *
 * Same draft/publish model as every other config screen in this app: writes
 * here land on the DRAFT project doc; the storefront only ever reads the
 * PUBLISHED snapshot. Nothing here is live until Publish is pressed.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  CARD_TYPE_NAMES, CARD_TYPES, DEFAULT_TEMPLATES, mergeTokens, tokensToCssVars,
  type CardType, type ThemeTokens, type UiTheme,
} from "@journeyax/ui-cards";
import { CardRenderer } from "@journeyax/ui-cards/react";
import { cardsApi, projectApi, type Project, type CardListEntry } from "../lib/api";
import { sampleStateFor } from "../lib/cardSampleState";

// ── shared bits ──────────────────────────────────────────────────────────

function cssVarStyle(tokens: ThemeTokens): React.CSSProperties {
  return tokensToCssVars(tokens) as unknown as React.CSSProperties;
}

/** Wraps a card in the same box the storefront renders it in — bg + padding —
 *  so a preview here looks like the real stage, not a bare component.
 *  `maxHeight` caps + scrolls it: without one, a long card (e.g. "products",
 *  which samples multiple items) stretches its grid tile far taller than a
 *  short one (e.g. "comparison"), so the Enabled/Edit-template row underneath
 *  lands at a different height in every column — the gallery's alignment
 *  complaint. Density views (gallery grid) pass a cap; the single-card views
 *  (tokens/editor/compare) leave it unset and render at natural height. */
function PreviewFrame({ tokens, children, minHeight = 160, maxHeight }: { tokens: ThemeTokens; children: React.ReactNode; minHeight?: number; maxHeight?: number }) {
  return (
    <div
      className="jx-root"
      style={{
        ...cssVarStyle(tokens), background: "var(--jx-color-bg)", padding: 20, borderRadius: 10, minHeight, boxSizing: "border-box",
        ...(maxHeight ? { maxHeight, overflowY: "auto" } : {}),
      }}
    >
      {children}
    </div>
  );
}

function CardPreview({ cardType, spec, tokens, settings, maxHeight }: { cardType: CardType; spec: any; tokens: ThemeTokens; settings?: Record<string, unknown>; maxHeight?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed) return <div style={badStyle}>Could not render: {failed}</div>;
  try {
    return (
      <PreviewFrame tokens={tokens} maxHeight={maxHeight}>
        <CardRenderer template={spec} state={sampleStateFor(cardType)} settings={settings} stateKey={cardType} />
      </PreviewFrame>
    );
  } catch (e: any) {
    // Should be rare — putCard() validates structurally server-side before
    // save — but a live-typed draft in the JSON editor can be mid-edit.
    if (!failed) setTimeout(() => setFailed(e?.message || "render error"), 0);
    return <div style={badStyle}>Rendering…</div>;
  }
}

const badStyle: React.CSSProperties = { padding: 16, borderRadius: 8, background: "#FFF4F2", color: "#B42318", fontSize: 13, border: "1px solid #FDA29B" };

const TABS = [
  { id: "tokens", label: "Theme tokens" },
  { id: "gallery", label: "Card gallery" },
  { id: "editor", label: "Template editor" },
  { id: "compare", label: "Compare tenants" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TOKEN_GROUPS: { key: keyof ThemeTokens; label: string; fields: string[] }[] = [
  { key: "colors", label: "Colours", fields: ["bg", "surface", "surfaceAlt", "muted", "border", "text", "textMuted", "brand", "brandText", "accent", "success", "warning", "danger", "inverse", "inverseText"] },
  { key: "font", label: "Fonts", fields: ["display", "body", "mono"] },
  { key: "radius", label: "Radius", fields: ["sm", "md", "lg", "pill"] },
  { key: "shadow", label: "Shadow", fields: ["sm", "md", "lg"] },
  { key: "space", label: "Spacing", fields: ["xs", "sm", "md", "lg", "xl"] },
];

// ── main component ───────────────────────────────────────────────────────

export function CardsTheme({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const projectId = project.projectId;
  const [tab, setTab] = useState<TabId>("tokens");
  const [draftTokens, setDraftTokens] = useState<Partial<ThemeTokens>>(project.uiTheme?.tokens || {});
  const [cardSettings, setCardSettings] = useState<Record<string, { enabled?: boolean; variant?: string; labels?: Record<string, string> }>>(project.uiTheme?.cards || {});
  const [cards, setCards] = useState<CardListEntry[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mergedTokens = useMemo(() => mergeTokens(draftTokens), [draftTokens]);

  useEffect(() => {
    setDraftTokens(project.uiTheme?.tokens || {});
    setCardSettings(project.uiTheme?.cards || {});
  }, [project.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCards() {
    setLoadingCards(true);
    try {
      const { cards } = await cardsApi.list(projectId);
      setCards(cards);
    } catch (e: any) {
      setError(`Could not load cards: ${e.message}`);
    } finally {
      setLoadingCards(false);
    }
  }
  useEffect(() => { loadCards(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateTokenField(group: keyof ThemeTokens, field: string, value: string) {
    setDraftTokens((prev) => ({ ...prev, [group]: { ...(prev[group] as any), [field]: value } }));
  }

  async function saveTokens() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const next: UiTheme = { ...(project.uiTheme || {}), tokens: draftTokens, cards: cardSettings };
      await cardsApi.patchTheme(projectId, next);
      setNotice("Theme saved to draft.");
      onSaved?.();
    } catch (e: any) {
      setError(`Could not save theme: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function resetTokens() {
    setDraftTokens({});
  }

  async function saveCardSettings(cardType: string, patch: Partial<{ enabled: boolean; variant: string; labels: Record<string, string> }>) {
    const next = { ...cardSettings, [cardType]: { ...(cardSettings[cardType] || {}), ...patch } };
    setCardSettings(next);
    setBusy(true); setError(null);
    try {
      await cardsApi.patchTheme(projectId, { ...(project.uiTheme || {}), tokens: draftTokens, cards: next });
      setNotice(`Saved settings for ${cardType}.`);
      onSaved?.();
    } catch (e: any) {
      setError(`Could not save card settings: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await saveTokens();
      await projectApi.publish(projectId, { note: "Cards & Theme" });
      setNotice("Published.");
      onSaved?.();
    } catch (e: any) {
      setError(`Could not publish: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const hasUnpublished = (project.version || 0) !== (project.activeVersion || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="crumb">JourneyAX / Cards &amp; Theme</div>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Card templates, colours and per-card settings for <strong>{project.companyName}</strong> — draft here, publish when ready.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 999,
              background: hasUnpublished ? "#FFF4CE" : "#E6F4EA",
              color: hasUnpublished ? "#8A6116" : "#1F8A4C",
            }}
          >
            {hasUnpublished ? `Draft v${project.version} · Live v${project.activeVersion ?? 0}` : `Published v${project.activeVersion ?? 0}`}
          </span>
          <button type="button" onClick={publish} disabled={busy} className="btn y">
            {busy ? "Working…" : "Publish"}
          </button>
        </div>
      </div>

      {error && <div style={badStyle}>{error}</div>}
      {notice && !error && <div style={{ ...badStyle, background: "#E6F4EA", color: "#1F8A4C", borderColor: "#A6E3B8" }}>{notice}</div>}

      <div style={{ display: "flex", gap: 6, borderBottom: "1px solid var(--border-base)" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: "10px 14px", fontSize: 13, fontWeight: 600, border: "none", background: "transparent", cursor: "pointer",
              color: tab === t.id ? "var(--text-strong)" : "var(--text-muted)",
              borderBottom: tab === t.id ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "tokens" && (
        <TokensTab draftTokens={draftTokens} mergedTokens={mergedTokens} onChange={updateTokenField} onSave={saveTokens} onReset={resetTokens} busy={busy} />
      )}
      {tab === "gallery" && (
        <GalleryTab cards={cards} loading={loadingCards} tokens={mergedTokens} cardSettings={cardSettings} onSaveSettings={saveCardSettings} onOpenEditor={(ct) => setTab("editor")} />
      )}
      {tab === "editor" && (
        <EditorTab projectId={projectId} cards={cards} tokens={mergedTokens} cardSettings={cardSettings} onSaved={loadCards} />
      )}
      {tab === "compare" && <CompareTab currentProject={project} tokens={mergedTokens} />}
    </div>
  );
}

// ── Tab 1: Theme tokens ───────────────────────────────────────────────────

function TokensTab({
  draftTokens, mergedTokens, onChange, onSave, onReset, busy,
}: {
  draftTokens: Partial<ThemeTokens>;
  mergedTokens: ThemeTokens;
  onChange: (group: keyof ThemeTokens, field: string, value: string) => void;
  onSave: () => void;
  onReset: () => void;
  busy: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: 20, alignItems: "start" }}>
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {TOKEN_GROUPS.map((group) => (
          <div key={group.key}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-muted)", marginBottom: 8 }}>{group.label}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {group.fields.map((field) => {
                const current = (mergedTokens[group.key] as any)[field] as string;
                const isColor = group.key === "colors";
                return (
                  <label key={field} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    {isColor && (
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(current) ? current : "#000000"}
                        onChange={(e) => onChange(group.key, field, e.target.value)}
                        style={{ width: 22, height: 22, padding: 0, border: "1px solid var(--border-base)", borderRadius: 4 }}
                      />
                    )}
                    <span style={{ width: 74, color: "var(--text-muted)", flexShrink: 0 }}>{field}</span>
                    <input
                      value={current}
                      onChange={(e) => onChange(group.key, field, e.target.value)}
                      style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "4px 6px", border: "1px solid var(--border-base)", borderRadius: 6 }}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn y" onClick={onSave} disabled={busy}>Save draft</button>
          <button type="button" className="btn" onClick={onReset} disabled={busy}>Reset to defaults</button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Live preview</div>
        <CardPreview cardType="products" spec={DEFAULT_TEMPLATES.products} tokens={mergedTokens} />
        <CardPreview cardType="clarify" spec={DEFAULT_TEMPLATES.clarify} tokens={mergedTokens} />
        <CardPreview cardType="quote" spec={DEFAULT_TEMPLATES.quote} tokens={mergedTokens} />
      </div>
    </div>
  );
}

// ── Tab 2: Card gallery ───────────────────────────────────────────────────

function GalleryTab({
  cards, loading, tokens, cardSettings, onSaveSettings, onOpenEditor,
}: {
  cards: CardListEntry[];
  loading: boolean;
  tokens: ThemeTokens;
  cardSettings: Record<string, { enabled?: boolean; variant?: string; labels?: Record<string, string> }>;
  onSaveSettings: (cardType: string, patch: Partial<{ enabled: boolean; variant: string; labels: Record<string, string> }>) => void;
  onOpenEditor: (cardType: CardType) => void;
}) {
  const byType = useMemo(() => new Map(cards.map((c) => [c.cardType, c])), [cards]);
  if (loading) return <div className="panel">Loading cards…</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
      {CARD_TYPE_NAMES.map((cardType) => {
        const entry = byType.get(cardType);
        const spec = entry?.spec || DEFAULT_TEMPLATES[cardType];
        const settings = cardSettings[cardType] || {};
        const enabled = settings.enabled !== false;
        return (
          <div key={cardType} className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{CARD_TYPES[cardType].title}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{cardType}</div>
              </div>
              <span
                style={{
                  fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 999, textTransform: "uppercase",
                  background: entry?.source === "tenant" ? "#E8E4FF" : "var(--surface-muted)",
                  color: entry?.source === "tenant" ? "#4B3FCF" : "var(--text-muted)",
                }}
              >
                {entry?.source === "tenant" ? "Tenant override" : "Platform default"}
              </span>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>{CARD_TYPES[cardType].description}</p>
            <CardPreview cardType={cardType} spec={spec} tokens={tokens} settings={settings as any} maxHeight={320} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={enabled} onChange={(e) => onSaveSettings(cardType, { enabled: e.target.checked })} />
                Enabled
              </label>
              <button type="button" className="btn" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => onOpenEditor(cardType)}>
                Edit template →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab 3: Template editor ────────────────────────────────────────────────

const BINDINGS_CHEATSHEET = [
  ['{ "$state": "/products" }', "Read a value from card state"],
  ['{ "$item": "title" }', "Field of the current repeat() item"],
  ['repeat: { statePath: "/products", key: "sku" }', "Render one child per array item"],
  ['visible: [{ "$state": "/heading" }]', "Hide the element when the value is falsy"],
  ['{ "$template": "Hello ${/name}" }', "Interpolate state into a string"],
  ['on: { press: { action: "addToCart", params: { sku: { "$item": "sku" } } } }', "Fire a catalog action"],
];

function EditorTab({
  projectId, cards, tokens, cardSettings, onSaved,
}: {
  projectId: string;
  cards: CardListEntry[];
  tokens: ThemeTokens;
  cardSettings: Record<string, { enabled?: boolean; variant?: string; labels?: Record<string, string> }>;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<CardType>("products");
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<any>(DEFAULT_TEMPLATES.products);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showCheatsheet, setShowCheatsheet] = useState(false);

  const entry = cards.find((c) => c.cardType === selected);

  useEffect(() => {
    const spec = entry?.spec || DEFAULT_TEMPLATES[selected];
    setText(JSON.stringify(spec, null, 2));
    setParsed(spec);
    setProblems([]);
    setNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, cards]);

  function onEdit(value: string) {
    setText(value);
    try {
      const obj = JSON.parse(value);
      setParsed(obj);
      setProblems(validateSpecLocally(obj));
    } catch {
      setProblems(["Not valid JSON."]);
    }
  }

  async function save() {
    if (problems.length) return;
    setBusy(true); setNote(null);
    try {
      await cardsApi.putCard(projectId, selected, parsed, { note: "Edited in Cards & Theme studio" });
      setNote("Saved to draft.");
      onSaved();
    } catch (e: any) {
      setProblems([e.message]);
    } finally {
      setBusy(false);
    }
  }

  async function revert() {
    setBusy(true); setNote(null);
    try {
      await cardsApi.deleteCard(projectId, selected);
      setNote("Reverted to platform default.");
      onSaved();
    } catch (e: any) {
      setProblems([e.message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 1fr", gap: 16, alignItems: "start" }}>
      <div className="panel" style={{ padding: 8 }}>
        {CARD_TYPE_NAMES.map((ct) => {
          const has = cards.find((c) => c.cardType === ct)?.source === "tenant";
          return (
            <button
              key={ct}
              type="button"
              onClick={() => setSelected(ct)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 10px", fontSize: 12.5, border: "none", borderRadius: 6, cursor: "pointer",
                background: selected === ct ? "var(--surface-muted)" : "transparent",
                fontWeight: selected === ct ? 700 : 500,
              }}
            >
              {ct}{has ? " ●" : ""}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{selected} — {entry?.source === "tenant" ? "tenant override" : "platform default"}</div>
          <button type="button" onClick={() => setShowCheatsheet((v) => !v)} style={{ fontSize: 11, background: "none", border: "none", color: "var(--accent)", cursor: "pointer" }}>
            {showCheatsheet ? "Hide" : "Show"} bindings cheatsheet
          </button>
        </div>
        {showCheatsheet && (
          <div className="panel" style={{ fontSize: 11, fontFamily: "monospace", display: "flex", flexDirection: "column", gap: 6 }}>
            {BINDINGS_CHEATSHEET.map(([code, desc]) => (
              <div key={code}><code style={{ background: "var(--surface-muted)", padding: "1px 4px", borderRadius: 4 }}>{code}</code> — {desc}</div>
            ))}
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => onEdit(e.target.value)}
          spellCheck={false}
          style={{ width: "100%", height: 420, fontFamily: "monospace", fontSize: 12, padding: 10, border: "1px solid var(--border-base)", borderRadius: 8, resize: "vertical" }}
        />
        {problems.length > 0 && (
          <div style={badStyle}>
            {problems.map((p, i) => <div key={i}>• {p}</div>)}
          </div>
        )}
        {note && !problems.length && <div style={{ ...badStyle, background: "#E6F4EA", color: "#1F8A4C", borderColor: "#A6E3B8" }}>{note}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn y" onClick={save} disabled={busy || problems.length > 0}>Save</button>
          <button type="button" className="btn" onClick={() => onEdit(JSON.stringify(DEFAULT_TEMPLATES[selected], null, 2))}>Copy default into editor</button>
          <button type="button" className="btn" onClick={revert} disabled={busy || entry?.source !== "tenant"}>Revert to platform default</button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Live preview</div>
        {problems.length === 0
          ? <CardPreview cardType={selected} spec={parsed} tokens={tokens} settings={cardSettings[selected] as any} />
          : <div style={badStyle}>Fix the JSON to see a preview.</div>}
      </div>
    </div>
  );
}

/** Same structural checks project-service runs before storing a spec — done
 *  client-side too so a mistake is caught before the round-trip. */
function validateSpecLocally(spec: any): string[] {
  const problems: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["Spec must be an object of shape { root, elements }."];
  if (typeof spec.root !== "string" || !spec.root.trim()) problems.push("root must be a non-empty string");
  if (!spec.elements || typeof spec.elements !== "object") { problems.push("elements must be an object keyed by element id"); return problems; }
  const keys = Object.keys(spec.elements);
  if (!keys.length) problems.push("elements is empty");
  if (spec.root && !(spec.root in spec.elements)) problems.push(`root '${spec.root}' is not a key in elements`);
  for (const key of keys) {
    const el = spec.elements[key];
    if (!el || typeof el !== "object") { problems.push(`elements.${key} must be an object`); continue; }
    if (typeof el.type !== "string") problems.push(`elements.${key}.type must be a string`);
    if (el.children && !Array.isArray(el.children)) problems.push(`elements.${key}.children must be an array`);
    for (const child of el.children || []) {
      if (!(child in spec.elements)) problems.push(`elements.${key}.children references missing '${child}'`);
    }
  }
  return problems;
}

// ── Tab 4: Compare tenants ────────────────────────────────────────────────

function CompareTab({ currentProject, tokens }: { currentProject: Project; tokens: ThemeTokens }) {
  const [others, setOthers] = useState<Project[]>([]);
  const [otherId, setOtherId] = useState<string>("");
  const [otherProject, setOtherProject] = useState<Project | null>(null);
  const [cardType, setCardType] = useState<CardType>("products");
  const [leftEntry, setLeftEntry] = useState<CardListEntry | null>(null);
  const [rightEntry, setRightEntry] = useState<CardListEntry | null>(null);

  useEffect(() => {
    projectApi.list().then((list) => setOthers(list.filter((p) => p.projectId !== currentProject.projectId && p.status !== "archived"))).catch(() => {});
  }, [currentProject.projectId]);

  useEffect(() => {
    cardsApi.list(currentProject.projectId).then(({ cards }) => setLeftEntry(cards.find((c) => c.cardType === cardType) || null)).catch(() => {});
  }, [currentProject.projectId, cardType]);

  useEffect(() => {
    if (!otherId) { setOtherProject(null); setRightEntry(null); return; }
    projectApi.get(otherId).then(setOtherProject).catch(() => {});
    cardsApi.list(otherId).then(({ cards }) => setRightEntry(cards.find((c) => c.cardType === cardType) || null)).catch(() => {});
  }, [otherId, cardType]);

  const leftTokens = mergeTokens(currentProject.uiTheme?.tokens);
  const rightTokens = otherProject ? mergeTokens(otherProject.uiTheme?.tokens) : tokens;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          Card type
          <select value={cardType} onChange={(e) => setCardType(e.target.value as CardType)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-base)" }}>
            {CARD_TYPE_NAMES.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          Compare against
          <select value={otherId} onChange={(e) => setOtherId(e.target.value)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-base)" }}>
            <option value="">Select a project…</option>
            {others.map((p) => <option key={p.projectId} value={p.projectId}>{p.companyName}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{currentProject.companyName} — {leftEntry?.source === "tenant" ? "override" : "default"}</div>
          <CardPreview cardType={cardType} spec={leftEntry?.spec || DEFAULT_TEMPLATES[cardType]} tokens={leftTokens} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{otherProject ? `${otherProject.companyName} — ${rightEntry?.source === "tenant" ? "override" : "default"}` : "Pick a project to compare"}</div>
          {otherProject
            ? <CardPreview cardType={cardType} spec={rightEntry?.spec || DEFAULT_TEMPLATES[cardType]} tokens={rightTokens} />
            : <div className="panel" style={{ minHeight: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>No project selected</div>}
        </div>
      </div>
    </div>
  );
}
