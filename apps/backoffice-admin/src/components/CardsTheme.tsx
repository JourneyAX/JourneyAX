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
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Palette } from "lucide-react";
import {
  CARD_TYPE_NAMES, CARD_TYPES, DEFAULT_TEMPLATES, mergeTokens, tokensToCssVars,
  type CardType, type ThemeTokens, type UiTheme, type SavedTheme,
} from "@journeyax/ui-cards";
import { CardRenderer } from "@journeyax/ui-cards/react";
import { cardsApi, projectApi, type Project, type CardListEntry } from "../lib/api";
import { sampleStateFor } from "../lib/cardSampleState";
import {
  ADVANCED_TOKEN_GROUPS, BRAND_COLORS, BUILTIN_THEMES, CORNER_CHIPS, CORNER_PRESETS,
  CUSTOM_FONT_ID, FONT_PRESETS, SHADOW_CHIPS, SHADOW_PRESETS, SPACE_CHIPS, SPACE_PRESETS,
  STATUS_COLORS, SURFACE_COLORS, TEXT_COLORS, matchFontPreset, matchPreset, namedFromSaved,
  themesMatch, toPickerHex,
  type ColorControl, type NamedTheme,
} from "../lib/themeEditorUi";

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
function PreviewFrame({ tokens, children, minHeight = 160, maxHeight, pad = 20, className }: { tokens: ThemeTokens; children: React.ReactNode; minHeight?: number; maxHeight?: number; pad?: number; className?: string }) {
  return (
    <div
      className={className ? `jx-root ${className}` : "jx-root"}
      style={{
        ...cssVarStyle(tokens), background: "var(--jx-color-bg)", padding: pad, borderRadius: 10, minHeight, boxSizing: "border-box",
        minWidth: 0, width: "100%",
        ...(maxHeight ? { maxHeight, overflowY: "auto" } : {}),
      }}
    >
      {children}
    </div>
  );
}

function CardPreview({ cardType, spec, tokens, settings, maxHeight, pad, className }: { cardType: CardType; spec: any; tokens: ThemeTokens; settings?: Record<string, unknown>; maxHeight?: number; pad?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed) return <div style={badStyle}>Could not render: {failed}</div>;
  try {
    return (
      <PreviewFrame tokens={tokens} maxHeight={maxHeight} pad={pad} className={className}>
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


// ── main component ───────────────────────────────────────────────────────

export function CardsTheme({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const projectId = project.projectId;
  const [tab, setTab] = useState<TabId>("tokens");
  const [editorCard, setEditorCard] = useState<CardType>("products");
  const [draftTokens, setDraftTokens] = useState<Partial<ThemeTokens>>(project.uiTheme?.tokens || {});
  const [cardSettings, setCardSettings] = useState<Record<string, { enabled?: boolean; variant?: string; labels?: Record<string, string> }>>(project.uiTheme?.cards || {});
  const [savedThemes, setSavedThemes] = useState<SavedTheme[]>(project.uiTheme?.savedThemes || []);
  const [activeThemeId, setActiveThemeId] = useState<string | null>(project.uiTheme?.activeThemeId || null);
  const [naming, setNaming] = useState(false);
  const [newThemeName, setNewThemeName] = useState("");
  const [cards, setCards] = useState<CardListEntry[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mergedTokens = useMemo(() => mergeTokens(draftTokens), [draftTokens]);
  const catalog = useMemo<NamedTheme[]>(() => [
    ...BUILTIN_THEMES,
    ...savedThemes.map((t) => namedFromSaved(t.id, t.name, t.tokens)),
  ], [savedThemes]);

  const inferredId = useMemo(() => {
    if (activeThemeId) {
      const selected = catalog.find((t) => t.id === activeThemeId);
      if (selected) return selected.id;
    }
    return catalog.find((t) => themesMatch(mergedTokens, t.tokens))?.id || null;
  }, [catalog, mergedTokens, activeThemeId]);

  const selectedTheme = catalog.find((t) => t.id === inferredId) || null;
  const dirty = !!(selectedTheme && !themesMatch(mergedTokens, selectedTheme.tokens));

  useEffect(() => {
    setDraftTokens(project.uiTheme?.tokens || {});
    setCardSettings(project.uiTheme?.cards || {});
    setSavedThemes(project.uiTheme?.savedThemes || []);
    setActiveThemeId(project.uiTheme?.activeThemeId || null);
    setNaming(false);
    setNewThemeName("");
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

  function updateTokenGroup(group: keyof ThemeTokens, patch: Record<string, string>) {
    setDraftTokens((prev) => ({ ...prev, [group]: { ...(prev[group] as any), ...patch } }));
  }

  function themePayload(extra?: Partial<UiTheme>): UiTheme {
    return {
      ...(project.uiTheme || {}),
      tokens: draftTokens,
      cards: cardSettings,
      savedThemes,
      activeThemeId: activeThemeId || undefined,
      ...extra,
    };
  }

  function applyNamedTheme(theme: NamedTheme) {
    setDraftTokens(theme.tokens);
    setActiveThemeId(theme.id);
    setNaming(false);
  }

  async function saveTokens() {
    setBusy(true); setError(null); setNotice(null);
    try {
      let nextSaved = savedThemes;
      if (activeThemeId && !BUILTIN_THEMES.some((t) => t.id === activeThemeId)) {
        nextSaved = savedThemes.map((t) => t.id === activeThemeId ? { ...t, tokens: draftTokens } : t);
        setSavedThemes(nextSaved);
      }
      await cardsApi.patchTheme(projectId, themePayload({ savedThemes: nextSaved }));
      setNotice("Theme saved to draft.");
      onSaved?.();
    } catch (e: any) {
      setError(`Could not save theme: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNewTheme() {
    const name = newThemeName.trim();
    if (!name) return;
    const id = `custom-${Date.now()}`;
    const entry: SavedTheme = { id, name, tokens: draftTokens };
    const nextSaved = [...savedThemes, entry];
    setBusy(true); setError(null); setNotice(null);
    try {
      setSavedThemes(nextSaved);
      setActiveThemeId(id);
      setNaming(false);
      setNewThemeName("");
      await cardsApi.patchTheme(projectId, themePayload({ savedThemes: nextSaved, activeThemeId: id }));
      setNotice(`Saved “${name}” as a custom theme.`);
      onSaved?.();
    } catch (e: any) {
      setError(`Could not save theme: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function resetTokens() {
    const classic = BUILTIN_THEMES[0];
    setDraftTokens(classic.tokens);
    setActiveThemeId(classic.id);
  }

  async function saveCardSettings(cardType: string, patch: Partial<{ enabled: boolean; variant: string; labels: Record<string, string> }>) {
    const next = { ...cardSettings, [cardType]: { ...(cardSettings[cardType] || {}), ...patch } };
    setCardSettings(next);
    setBusy(true); setError(null);
    try {
      await cardsApi.patchTheme(projectId, themePayload({ cards: next }));
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

      <ThemeSwitcher
        themes={catalog}
        selectedId={inferredId}
        dirty={dirty}
        onPick={applyNamedTheme}
      />

      <div className="cards-theme-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "cards-theme-tab on" : "cards-theme-tab"}
            data-testid={`cards-tab-${t.id}`}
            aria-current={tab === t.id ? "true" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "tokens" && (
        <TokensTab
          mergedTokens={mergedTokens}
          onChange={updateTokenField}
          onPatchGroup={updateTokenGroup}
          onSave={saveTokens}
          onReset={resetTokens}
          naming={naming}
          newName={newThemeName}
          onNameChange={setNewThemeName}
          onStartNaming={() => { setNaming(true); setNewThemeName(selectedTheme && !selectedTheme.builtin ? `${selectedTheme.name} copy` : "My theme"); }}
          onCancelNaming={() => { setNaming(false); setNewThemeName(""); }}
          onSaveAsNew={saveAsNewTheme}
          busy={busy}
        />
      )}
      {tab === "gallery" && (
        <GalleryTab cards={cards} loading={loadingCards} tokens={mergedTokens} cardSettings={cardSettings} onSaveSettings={saveCardSettings} onOpenEditor={(ct) => { setEditorCard(ct); setTab("editor"); }} />
      )}
      {tab === "editor" && (
        <EditorTab projectId={projectId} cards={cards} tokens={mergedTokens} cardSettings={cardSettings} initialCard={editorCard} onSaved={loadCards} />
      )}
      {tab === "compare" && <CompareTab currentProject={project} tokens={mergedTokens} />}
    </div>
  );
}

// ── Tab 1: Theme tokens ───────────────────────────────────────────────────

function TokensTab({
  mergedTokens, onChange, onPatchGroup, onSave, onReset,
  naming, newName, onNameChange, onStartNaming, onCancelNaming, onSaveAsNew, busy,
}: {
  mergedTokens: ThemeTokens;
  onChange: (group: keyof ThemeTokens, field: string, value: string) => void;
  onPatchGroup: (group: keyof ThemeTokens, patch: Record<string, string>) => void;
  onSave: () => void;
  onReset: () => void;
  naming: boolean;
  newName: string;
  onNameChange: (name: string) => void;
  onStartNaming: () => void;
  onCancelNaming: () => void;
  onSaveAsNew: () => void;
  busy: boolean;
}) {
  const corner = matchPreset(mergedTokens.radius, CORNER_PRESETS);
  const shadow = matchPreset(mergedTokens.shadow, SHADOW_PRESETS);
  const space = matchPreset(mergedTokens.space, SPACE_PRESETS);
  const headingFont = matchFontPreset(mergedTokens.font.display);
  const bodyFont = matchFontPreset(mergedTokens.font.body);
  const splitRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      el.style.height = `${Math.max(320, Math.floor(window.innerHeight - top - 24))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });

  return (
    <div className="cards-theme-split" ref={splitRef}>
      <div className="panel theme-studio">
        <div className="theme-studio-head">
          <Palette size={14} strokeWidth={2.25} aria-hidden />
          Edit theme
        </div>
        <div className="theme-studio-body">
          <StudioSection title="Brand">
            <ColorGrid colors={BRAND_COLORS} tokens={mergedTokens} onChange={onChange} />
          </StudioSection>
          <StudioSection title="Page & cards">
            <ColorGrid colors={SURFACE_COLORS} tokens={mergedTokens} onChange={onChange} />
          </StudioSection>
          <StudioSection title="Text">
            <div className="theme-font-row">
              <FontSelect
                label="Headings"
                hint="Titles on the cards"
                valueId={headingFont}
                onPick={(v) => onChange("font", "display", v)}
              />
              <FontSelect
                label="Body"
                hint="Reading text"
                valueId={bodyFont}
                onPick={(v) => onChange("font", "body", v)}
              />
            </div>
            <ColorGrid colors={TEXT_COLORS} tokens={mergedTokens} onChange={onChange} />
          </StudioSection>
          <StudioSection title="Look & feel">
            <ChipRow
              label="Corners"
              hint="How round the cards feel"
              chips={CORNER_CHIPS}
              selected={corner}
              testId="theme-corners"
              onPick={(id) => onPatchGroup("radius", { ...CORNER_PRESETS[id as keyof typeof CORNER_PRESETS] })}
            />
            <ChipRow
              label="Shadow"
              hint="How much the cards lift off the page"
              chips={SHADOW_CHIPS}
              selected={shadow}
              testId="theme-shadow"
              onPick={(id) => onPatchGroup("shadow", { ...SHADOW_PRESETS[id as keyof typeof SHADOW_PRESETS] })}
            />
            <ChipRow
              label="Spacing"
              hint="How tight or airy the layout feels"
              chips={SPACE_CHIPS}
              selected={space}
              testId="theme-spacing"
              onPick={(id) => onPatchGroup("space", { ...SPACE_PRESETS[id as keyof typeof SPACE_PRESETS] })}
            />
          </StudioSection>

          <details className="theme-fold">
            <summary>Status &amp; dark blocks</summary>
            <ColorGrid colors={STATUS_COLORS} tokens={mergedTokens} onChange={onChange} />
          </details>
          <details className="theme-fold" data-testid="theme-advanced">
            <summary>Advanced</summary>
            <p className="fhelp" style={{ marginBottom: 10 }}>Raw token values. Change these only if you know what they do.</p>
            {ADVANCED_TOKEN_GROUPS.map((group) => {
              const wide = group.key === "font" || group.key === "shadow";
              return (
                <div key={group.key} style={{ marginBottom: 14 }}>
                  <div className="theme-section-title">{group.label}</div>
                  <div className="token-grid">
                    {group.fields.map((field) => {
                      const current = (mergedTokens[group.key] as any)[field] as string;
                      const isColor = group.key === "colors";
                      return (
                        <label key={field} className={`token-field${wide ? " full" : ""}`}>
                          <span>{field}</span>
                          <div className="token-field-ctrl">
                            {isColor && (
                              <input
                                type="color"
                                className="token-swatch"
                                value={toPickerHex(current)}
                                onChange={(e) => onChange(group.key, field, e.target.value)}
                              />
                            )}
                            <input
                              className="field"
                              data-token={`${group.key}.${field}`}
                              value={current}
                              onChange={(e) => onChange(group.key, field, e.target.value)}
                              style={{ padding: "6px 8px", fontSize: 12 }}
                            />
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </details>
        </div>
        <div className="theme-studio-foot">
          {naming ? (
            <form className="theme-switcher-name" onSubmit={(e) => { e.preventDefault(); onSaveAsNew(); }}>
              <input
                className="field"
                value={newName}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="Theme name"
                aria-label="New theme name"
                autoFocus
                style={{ padding: "7px 10px", fontSize: 13, width: 160 }}
              />
              <button type="submit" className="btn y" disabled={busy || !newName.trim()}>Save</button>
              <button type="button" className="btn" onClick={onCancelNaming}>Cancel</button>
            </form>
          ) : (
            <>
              <button type="button" className="btn y" onClick={onSave} disabled={busy}>Save draft</button>
              <button type="button" className="btn" onClick={onStartNaming} disabled={busy}>Save as new theme</button>
              <button type="button" className="btn" onClick={onReset} disabled={busy}>Reset to Classic</button>
            </>
          )}
        </div>
      </div>
      <div className="panel theme-preview" data-testid="theme-preview">
        <div className="theme-preview-head">
          <span className="theme-preview-pulse" aria-hidden />
          Live preview
        </div>
        <div className="theme-preview-stage">
          <CardPreview cardType="products" spec={DEFAULT_TEMPLATES.products} tokens={mergedTokens} />
          <CardPreview cardType="clarify" spec={DEFAULT_TEMPLATES.clarify} tokens={mergedTokens} />
          <CardPreview cardType="quote" spec={DEFAULT_TEMPLATES.quote} tokens={mergedTokens} />
        </div>
      </div>
    </div>
  );
}

function ThemeSwitcher({
  themes, selectedId, dirty, onPick,
}: {
  themes: NamedTheme[];
  selectedId: string | null;
  dirty: boolean;
  onPick: (theme: NamedTheme) => void;
}) {
  return (
    <div className="theme-switcher" data-testid="theme-switcher">
      <span className="theme-switcher-label">Themes</span>
      <div className="theme-switcher-pills">
        {themes.map((t) => {
          const on = t.id === selectedId;
          return (
            <button
              key={t.id}
              type="button"
              className={`theme-pill${on ? " on" : ""}${on && dirty ? " dirty" : ""}`}
              data-testid={`theme-pill-${t.id}`}
              aria-pressed={on}
              onClick={() => onPick(t)}
            >
              <span className="theme-pill-dots" aria-hidden>
                <span className="theme-pill-dot" style={{ background: t.swatches[0] }} />
                <span className="theme-pill-dot" style={{ background: t.swatches[1] }} />
              </span>
              {t.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StudioSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="theme-section">
      <h3 className="theme-section-title">{title}</h3>
      {children}
    </section>
  );
}

function ColorGrid({
  colors, tokens, onChange,
}: {
  colors: ColorControl[];
  tokens: ThemeTokens;
  onChange: (group: keyof ThemeTokens, field: string, value: string) => void;
}) {
  return (
    <div className="theme-color-grid">
      {colors.map((c) => {
        const value = tokens.colors[c.field];
        return (
          <label key={c.field} className="theme-color" htmlFor={`theme-color-${c.field}`}>
            <input
              id={`theme-color-${c.field}`}
              type="color"
              className="theme-color-picker"
              data-testid={`theme-color-${c.field}`}
              value={toPickerHex(value)}
              onChange={(e) => onChange("colors", c.field, e.target.value)}
              aria-label={c.label}
            />
            <span className="theme-color-copy">
              <span className="theme-color-label">{c.label}</span>
              <span className="theme-color-hint">{c.hint}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function FontSelect({
  label, hint, valueId, onPick,
}: {
  label: string;
  hint: string;
  valueId: string;
  onPick: (css: string) => void;
}) {
  return (
    <label className="theme-font">
      <span className="theme-color-label">{label}</span>
      <span className="theme-color-hint">{hint}</span>
      <select
        className="field"
        value={valueId}
        onChange={(e) => {
          const preset = FONT_PRESETS.find((p) => p.id === e.target.value);
          if (preset) onPick(preset.value);
        }}
        aria-label={label}
      >
        {FONT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
        {valueId === CUSTOM_FONT_ID && <option value={CUSTOM_FONT_ID}>Custom</option>}
      </select>
      {valueId === CUSTOM_FONT_ID && (
        <span className="theme-color-hint">This workspace uses a custom font. Change it here or edit the stack under Advanced.</span>
      )}
    </label>
  );
}

function ChipRow({
  label, hint, chips, selected, testId, onPick,
}: {
  label: string;
  hint: string;
  chips: readonly { id: string; label: string }[];
  selected: string | null;
  testId: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="theme-chips">
      <div>
        <div className="theme-color-label">{label}</div>
        <div className="theme-color-hint">{hint}</div>
      </div>
      <div className="chips" role="group" aria-label={label}>
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip${selected === c.id ? " on" : ""}`}
            data-testid={`${testId}-${c.id}`}
            aria-pressed={selected === c.id}
            onClick={() => onPick(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Tab 2: Card gallery ───────────────────────────────────────────────────

function galleryCardMatches(cardType: CardType, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const meta = CARD_TYPES[cardType];
  return cardType.toLowerCase().includes(q)
    || meta.title.toLowerCase().includes(q)
    || meta.description.toLowerCase().includes(q);
}

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
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const byType = useMemo(() => new Map(cards.map((c) => [c.cardType, c])), [cards]);
  const matches = useMemo(() => CARD_TYPE_NAMES.filter((ct) => galleryCardMatches(ct, query)), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!searchRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (loading) return <div className="panel">Loading cards…</div>;
  return (
    <div className="card-gallery-wrap">
      <div className="card-gallery-search" ref={searchRef}>
        <input
          className="field"
          data-testid="gallery-search"
          value={query}
          placeholder="Search cards"
          aria-label="Search cards"
          aria-expanded={open}
          aria-controls="gallery-search-suggest"
          autoComplete="off"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.currentTarget.blur(); setOpen(false); } }}
        />
        {query ? (
          <button
            type="button"
            className="btn card-gallery-search-clear"
            aria-label="Clear search"
            onClick={() => { setQuery(""); setOpen(false); }}
          >
            ×
          </button>
        ) : null}
        {open && matches.length > 0 && (
          <ul className="card-gallery-suggest" id="gallery-search-suggest" role="listbox">
            {matches.map((cardType) => (
              <li key={cardType} role="none">
                <button
                  type="button"
                  role="option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setQuery(CARD_TYPES[cardType].title); setOpen(false); }}
                >
                  <span>{CARD_TYPES[cardType].title}</span>
                  <span>{cardType}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {matches.length === 0 ? (
        <p className="card-gallery-empty">No cards match</p>
      ) : (
        <div className="card-gallery" data-testid="card-gallery">
          {matches.map((cardType) => {
            const entry = byType.get(cardType);
            const spec = entry?.spec || DEFAULT_TEMPLATES[cardType];
            const settings = cardSettings[cardType] || {};
            const enabled = settings.enabled !== false;
            return (
              <div key={cardType} className="panel card-gallery-tile" data-testid={`gallery-tile-${cardType}`}>
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
                <CardPreview cardType={cardType} spec={spec} tokens={tokens} settings={settings as any} maxHeight={460} pad={12} className="card-gallery-preview" />
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
      )}
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
  projectId, cards, tokens, cardSettings, initialCard, onSaved,
}: {
  projectId: string;
  cards: CardListEntry[];
  tokens: ThemeTokens;
  cardSettings: Record<string, { enabled?: boolean; variant?: string; labels?: Record<string, string> }>;
  initialCard: CardType;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<CardType>(initialCard);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<any>(DEFAULT_TEMPLATES.products);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => CARD_TYPE_NAMES.filter((ct) => galleryCardMatches(ct, query)), [query]);

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

  const sourceLabel = entry?.source === "tenant" ? "Custom template" : "Platform default";
  const splitRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      el.style.height = `${Math.max(320, Math.floor(window.innerHeight - top - 24))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });

  return (
    <div className="cards-theme-editor" ref={splitRef}>
      <div className="panel cards-theme-editor-pane" data-testid="editor-pane-nav">
        <div className="cards-theme-editor-pane-head">Cards</div>
        <div className="cards-theme-editor-search">
          <input
            className="field"
            data-testid="editor-search"
            value={query}
            placeholder="Search cards"
            aria-label="Search cards"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="btn card-gallery-search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          ) : null}
        </div>
        {matches.length === 0 ? (
          <p className="cards-theme-editor-empty">No cards match</p>
        ) : (
          <div className="cards-theme-editor-list" data-testid="editor-card-list">
            {matches.map((ct) => {
              const has = cards.find((c) => c.cardType === ct)?.source === "tenant";
              return (
                <button
                  key={ct}
                  type="button"
                  className={`cards-theme-editor-item${selected === ct ? " on" : ""}`}
                  data-testid={`editor-card-${ct}`}
                  aria-current={selected === ct ? "true" : undefined}
                  onClick={() => setSelected(ct)}
                >
                  <span className="cards-theme-editor-item-title">{CARD_TYPES[ct].title}</span>
                  <span className="cards-theme-editor-item-meta">
                    {ct}
                    {has ? <span className="cards-theme-editor-item-override">Override</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel cards-theme-editor-pane" data-testid="editor-pane-json">
        <div className="cards-theme-editor-pane-head">
          <div data-testid="editor-heading" className="cards-theme-editor-heading">{CARD_TYPES[selected].title} — {sourceLabel}</div>
          <button type="button" className="cards-theme-editor-cheat-btn" onClick={() => setShowCheatsheet((v) => !v)}>
            {showCheatsheet ? "Hide bindings" : "Show bindings"}
          </button>
        </div>
        {showCheatsheet && (
          <div className="cards-theme-editor-cheatsheet">
            {BINDINGS_CHEATSHEET.map(([code, desc]) => (
              <div key={code}><code>{code}</code> — {desc}</div>
            ))}
          </div>
        )}
        <div className="cards-theme-editor-pane-body">
          <textarea
            className="field cards-theme-editor-json"
            value={text}
            onChange={(e) => onEdit(e.target.value)}
            spellCheck={false}
          />
          {problems.length > 0 && (
            <div style={badStyle}>
              {problems.map((p, i) => <div key={i}>• {p}</div>)}
            </div>
          )}
          {note && !problems.length && <div style={{ ...badStyle, background: "#E6F4EA", color: "#1F8A4C", borderColor: "#A6E3B8" }}>{note}</div>}
        </div>
        <div className="cards-theme-editor-foot">
          <button type="button" className="btn y" onClick={save} disabled={busy || problems.length > 0}>Save</button>
          <button type="button" className="btn" onClick={() => onEdit(JSON.stringify(DEFAULT_TEMPLATES[selected], null, 2))}>Copy default into editor</button>
          <button type="button" className="btn" onClick={revert} disabled={busy || entry?.source !== "tenant"}>Revert to platform default</button>
        </div>
      </div>

      <div className="panel cards-theme-editor-pane" data-testid="editor-pane-preview">
        <div className="cards-theme-editor-pane-head">Live preview</div>
        <div className="cards-theme-editor-pane-body cards-theme-editor-preview-body">
          {problems.length === 0
            ? <CardPreview cardType={selected} spec={parsed} tokens={tokens} settings={cardSettings[selected] as any} />
            : <div style={badStyle}>Fix the JSON to see a preview.</div>}
        </div>
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
  const sourceLabel = (entry: CardListEntry | null) => (entry?.source === "tenant" ? "Custom template" : "Platform default");

  return (
    <div className="cards-theme-compare">
      <div className="cards-theme-compare-bar">
        <div>
          <label className="flabel" htmlFor="compare-card-type">Card</label>
          <select
            id="compare-card-type"
            className="field"
            data-testid="compare-card-type"
            value={cardType}
            onChange={(e) => setCardType(e.target.value as CardType)}
          >
            {CARD_TYPE_NAMES.map((ct) => (
              <option key={ct} value={ct}>{CARD_TYPES[ct].title}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="flabel" htmlFor="compare-workspace">Compare with</label>
          <select
            id="compare-workspace"
            className="field"
            data-testid="compare-workspace"
            value={otherId}
            onChange={(e) => setOtherId(e.target.value)}
          >
            <option value="">Select a workspace</option>
            {others.map((p) => (
              <option key={p.projectId} value={p.projectId}>{p.companyName}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="cards-theme-compare-grid">
        <div className="panel cards-theme-compare-pane" data-testid="compare-pane-left">
          <div className="cards-theme-compare-pane-head">{currentProject.companyName} — {sourceLabel(leftEntry)}</div>
          <div className="cards-theme-compare-pane-body">
            <CardPreview cardType={cardType} spec={leftEntry?.spec || DEFAULT_TEMPLATES[cardType]} tokens={leftTokens} />
          </div>
        </div>
        <div className="panel cards-theme-compare-pane" data-testid="compare-pane-right">
          <div className="cards-theme-compare-pane-head">
            {otherProject ? `${otherProject.companyName} — ${sourceLabel(rightEntry)}` : "Choose a workspace"}
          </div>
          {otherProject ? (
            <div className="cards-theme-compare-pane-body">
              <CardPreview cardType={cardType} spec={rightEntry?.spec || DEFAULT_TEMPLATES[cardType]} tokens={rightTokens} />
            </div>
          ) : (
            <div className="cards-theme-compare-empty">Select a workspace to compare</div>
          )}
        </div>
      </div>
    </div>
  );
}
