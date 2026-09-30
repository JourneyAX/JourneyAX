"use client";

/**
 * AI Orchestration — per-tenant LLM choice + prompt engineering.
 *
 * Reads/writes the selected project's `ai` config (provider/model/temperature/
 * embedding) and `persona.systemPromptOverrides` via project-service. The agent
 * loads these per turn, so changes take effect on the next conversation.
 */
import React, { useEffect, useState } from "react";
import { Cpu, Save, Sparkles, Puzzle, Route, KeyRound } from "lucide-react";
import { compileModelPolicy } from "@journeyax/business-pack";
import { projectApi, LLM_OPTIONS, EMBEDDING_OPTIONS, CAPABILITY_CATALOG, type Project, type ContextDimension } from "../lib/api";

export function AiOrchestration({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [provider, setProvider] = useState(project.ai?.provider || "openai");
  const [model, setModel] = useState(project.ai?.model || "gpt-4o");
  const [temperature, setTemperature] = useState(project.ai?.temperature ?? 0.4);
  const [fallbackProvider, setFallbackProvider] = useState((project.ai as any)?.fallbackProvider || "");
  const [fallbackModel, setFallbackModel] = useState((project.ai as any)?.fallbackModel || "");
  const [embeddingModel, setEmbeddingModel] = useState(project.ai?.embeddingModel || "text-embedding-3-small");
  // Offline ingestion models — separate from the conversational model so bulk
  // jobs can run cheap (narratives) or strong (relationship extraction) without
  // touching the live agent. Empty = inherit.
  const [ingestModel, setIngestModel] = useState(project.ai?.ingestModel || "");
  const [extractModel, setExtractModel] = useState(project.ai?.extractModel || "");
  const [baseUrl, setBaseUrl] = useState(project.ai?.baseUrl || "");
  // API key is write-only: '' means "unchanged" (server keeps the stored key).
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(project.persona?.systemPromptOverrides || "");
  const [systemName, setSystemName] = useState(project.persona?.systemName || "");
  const [journeyGuidance, setJourneyGuidance] = useState(project.persona?.journeyGuidance || "");
  // undefined/empty capabilities in config = all enabled (back-compat); reflect that.
  const [capabilities, setCapabilities] = useState<string[]>(
    project.capabilities && project.capabilities.length ? project.capabilities : CAPABILITY_CATALOG.map((c) => c.id),
  );
  const [dimensions, setDimensions] = useState<ContextDimension[]>(project.contextDimensions || []);

  const [mode, setMode] = useState<'simple' | 'advanced'>((project as any)?.modelPolicyMode || 'simple');
  const [modelPolicy, setModelPolicy] = useState(
    project.modelPolicy ||
      compileModelPolicy({
        projectId: project.projectId,
        mode: 'simple',
        aiConfig: project.ai || { provider: 'openai', model: 'gpt-4o', temperature: 0.4 },
        dataResidency: (project as any)?.dataResidency || 'au',
      })
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-hydrate when the active tenant changes — COMPLETELY RESET modelPolicy state
  useEffect(() => {
    const curProvider = project.ai?.provider || "openai";
    const curModel = project.ai?.model || "gpt-4o";
    const curTemp = project.ai?.temperature ?? 0.4;
    const curFallbackProv = (project.ai as any)?.fallbackProvider || "";
    const curFallbackMod = (project.ai as any)?.fallbackModel || "";

    setProvider(curProvider);
    setModel(curModel);
    setTemperature(curTemp);
    setFallbackProvider(curFallbackProv);
    setFallbackModel(curFallbackMod);
    setEmbeddingModel(project.ai?.embeddingModel || "text-embedding-3-small");
    setIngestModel(project.ai?.ingestModel || "");
    setExtractModel(project.ai?.extractModel || "");
    setBaseUrl(project.ai?.baseUrl || "");
    setApiKey("");
    setShowKey(false);
    setSystemPrompt(project.persona?.systemPromptOverrides || "");
    setSystemName(project.persona?.systemName || "");
    setJourneyGuidance(project.persona?.journeyGuidance || "");
    setCapabilities(project.capabilities && project.capabilities.length ? project.capabilities : CAPABILITY_CATALOG.map((c) => c.id));
    setDimensions(project.contextDimensions || []);

    const newMode: 'simple' | 'advanced' = (project as any).modelPolicyMode || ((project.modelPolicy as any)?.isAdvanced ? 'advanced' : 'simple');
    setMode(newMode);

    if (project.modelPolicy && newMode === 'advanced') {
      setModelPolicy(project.modelPolicy);
    } else {
      // Clean reset: Never carry a previous tenant's policy into another tenant
      const compiled = compileModelPolicy({
        projectId: project.projectId,
        mode: 'simple',
        aiConfig: {
          provider: curProvider,
          model: curModel,
          temperature: curTemp,
          fallbackProvider: curFallbackProv || undefined,
          fallbackModel: curFallbackMod || undefined,
        },
        dataResidency: (project as any).dataResidency || 'au',
      });
      setModelPolicy(compiled);
    }
  }, [project.projectId]);

  const addDimension = () => setDimensions((ds) => [...ds, { key: "", label: "", values: [], scoping: false, filtersRetrieval: true }]);
  const removeDimension = (i: number) => setDimensions((ds) => ds.filter((_, idx) => idx !== i));
  const patchDimension = (i: number, patch: Partial<ContextDimension>) =>
    setDimensions((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  const models = LLM_OPTIONS[provider]?.models || [];
  const toggleCap = (id: string) =>
    setCapabilities((cs) => (cs.includes(id) ? cs.filter((c) => c !== id) : [...cs, id]));

  const updateConversationalModel = (
    newProvider: string,
    newModel: string,
    newFallbackProv?: string,
    newFallbackMod?: string
  ) => {
    setProvider(newProvider);
    setModel(newModel);
    const effFallbackProv = newFallbackProv !== undefined ? newFallbackProv : fallbackProvider;
    const effFallbackMod = newFallbackMod !== undefined ? newFallbackMod : fallbackModel;

    setModelPolicy(
      compileModelPolicy({
        projectId: project.projectId,
        mode: 'simple',
        aiConfig: {
          provider: newProvider,
          model: newModel,
          temperature,
          fallbackProvider: effFallbackProv || undefined,
          fallbackModel: effFallbackMod || undefined,
        },
        dataResidency: (project as any).dataResidency || 'au',
      })
    );
  };

  const patchPolicyCandidate = (policyId: string, candPatch: { provider: string; model: string; fallbackAllowed?: boolean }) => {
    setModelPolicy((prev: any) => {
      const updatedPolicies = (prev.policies || []).map((p: any) => {
        if (p.policyId !== policyId) return p;
        const candidates = Array.isArray(p.candidates) ? [...p.candidates] : [];
        const existingIdx = candidates.findIndex((c: any) => c.provider === candPatch.provider && c.model === candPatch.model);
        if (existingIdx >= 0) {
          const [sel] = candidates.splice(existingIdx, 1);
          candidates.forEach((c: any) => { if (c.priority <= 1) c.priority++; });
          candidates.unshift({ ...sel, priority: 1 });
        } else {
          candidates.forEach((c: any) => { if (c.priority <= 1) c.priority++; });
          candidates.unshift({
            provider: candPatch.provider,
            model: candPatch.model,
            priority: 1,
            temperature: p.policyId === 'fast_intent' ? 0.0 : temperature,
          });
        }
        return {
          ...p,
          candidates,
          ...(candPatch.fallbackAllowed !== undefined ? { fallbackAllowed: candPatch.fallbackAllowed } : {}),
        };
      });
      return { ...prev, policies: updatedPolicies };
    });
  };

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const policyToSave = compileModelPolicy({
        projectId: project.projectId,
        mode,
        existingModelPolicy: mode === 'advanced' ? (modelPolicy as any) : undefined,
        aiConfig: {
          provider,
          model,
          temperature: Number(temperature),
          fallbackProvider: fallbackProvider || undefined,
          fallbackModel: fallbackModel || undefined,
        },
        dataResidency: (project as any).dataResidency || 'au',
      });

      await projectApi.update(project.projectId, {
        ai: {
          provider, model, temperature: Number(temperature), embeddingModel,
          fallbackProvider: fallbackProvider || undefined,
          fallbackModel: fallbackModel || undefined,
          ingestModel: ingestModel || undefined,
          extractModel: extractModel || undefined,
          baseUrl: baseUrl.trim() || undefined,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
        modelPolicy: policyToSave,
        modelPolicyMode: mode,
        persona: { systemName, systemPromptOverrides: systemPrompt, journeyGuidance },
        capabilities,
        contextDimensions: dimensions.filter((d) => d.key.trim()),
      });
      setSaved(true);
      setApiKey("");
      onSaved();
      setTimeout(() => setSaved(false), 3500);
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
          <h1 className="pageh">AI Orchestration</h1>
          <p className="pagesub">
            Configure AI model policy and persona for <b>{project.companyName}</b>. Draft changes apply to runtime only after successful validation, publication, and activation.
          </p>
        </div>
        <div className="actions">
          <button className="btn y" onClick={save} disabled={saving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {saving ? "Saving…" : saved ? "Draft saved ✓ (publish to activate)" : "Save draft"}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>
          {error}
        </div>
      )}

      {/* Model config */}
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}><Cpu size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Model Policy & Orchestration</h4>
          <div style={{ display: "flex", gap: 6, background: "var(--jx-gray-100, #f1f5f9)", padding: "3px 4px", borderRadius: 6 }}>
            <button
              type="button"
              className={`btn micro ${mode === 'simple' ? 'y' : ''}`}
              onClick={() => setMode('simple')}
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              Simple Mode
            </button>
            <button
              type="button"
              className={`btn micro ${mode === 'advanced' ? 'y' : ''}`}
              onClick={() => setMode('advanced')}
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              Advanced Mode (Task Policies)
            </button>
          </div>
        </div>

        {mode === 'simple' ? (
          <div className="form-grid" style={{ marginTop: "10px" }}>
            <div>
              <span className="flabel">Conversational Provider</span>
              <select
                className="field"
                value={provider}
                onChange={(e) => {
                  const newP = e.target.value;
                  const newM = LLM_OPTIONS[newP]?.models[0] || "";
                  updateConversationalModel(newP, newM);
                }}
              >
                {Object.entries(LLM_OPTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <p className="hint">Configures fast_intent, complex_reasoning, tool_selection, and response_generation uniformly.</p>
            </div>
            <div>
              <span className="flabel">Conversational Model</span>
              <select className="field" value={model} onChange={(e) => updateConversationalModel(provider, e.target.value)}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <span className="flabel">Explicit Fallback Provider (Optional)</span>
              <select
                className="field"
                value={fallbackProvider}
                onChange={(e) => {
                  const newFbP = e.target.value;
                  const newFbM = newFbP ? (LLM_OPTIONS[newFbP]?.models[0] || "") : "";
                  setFallbackProvider(newFbP);
                  setFallbackModel(newFbM);
                  updateConversationalModel(provider, model, newFbP, newFbM);
                }}
              >
                <option value="">None (Fail closed)</option>
                {Object.entries(LLM_OPTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <p className="hint">Fallback is only active if explicitly selected. Hidden fallbacks are disabled.</p>
            </div>
            <div>
              <span className="flabel">Fallback Model</span>
              <select
                className="field"
                value={fallbackModel}
                disabled={!fallbackProvider}
                onChange={(e) => {
                  const newFbM = e.target.value;
                  setFallbackModel(newFbM);
                  updateConversationalModel(provider, model, fallbackProvider, newFbM);
                }}
              >
                <option value="">{fallbackProvider ? '-- Select fallback model --' : 'None'}</option>
                {(LLM_OPTIONS[fallbackProvider]?.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <span className="flabel">Temperature — {Number(temperature).toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--jx-yellow)" }} />
            </div>
            <div>
              <span className="flabel">Embedding model</span>
              <select className="field" value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)}>
                {EMBEDDING_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "10px" }}>
            <p className="hint" style={{ marginBottom: 12 }}>
              Independently configure candidates and fallback settings for each task policy. Publication compiles these deterministically.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(modelPolicy?.policies || []).map((pol: any) => {
                const primaryCandidate = pol.candidates?.[0] || { provider: 'openai', model: 'gpt-4o' };
                const candModels = LLM_OPTIONS[primaryCandidate.provider]?.models || [];
                return (
                  <div key={pol.policyId} style={{ border: "1px solid var(--jx-gray-200, #e2e8f0)", borderRadius: 6, padding: "10px 14px", background: "var(--jx-gray-50, #f8fafc)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{pol.policyId}</span>
                      <span className="micro" style={{ color: "var(--jx-gray-500)" }}>{pol.description || pol.policyId}</span>
                    </div>
                    <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      <div>
                        <span className="flabel" style={{ fontSize: 11 }}>Primary Provider</span>
                        <select
                          className="field"
                          value={primaryCandidate.provider}
                          onChange={(e) => {
                            const newP = e.target.value;
                            const newM = LLM_OPTIONS[newP]?.models[0] || "";
                            patchPolicyCandidate(pol.policyId, { provider: newP, model: newM });
                          }}
                        >
                          {Object.entries(LLM_OPTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <span className="flabel" style={{ fontSize: 11 }}>Primary Model</span>
                        <select
                          className="field"
                          value={primaryCandidate.model}
                          onChange={(e) => patchPolicyCandidate(pol.policyId, { provider: primaryCandidate.provider, model: e.target.value })}
                        >
                          {candModels.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 14, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={pol.fallbackAllowed ?? true}
                            onChange={(e) => patchPolicyCandidate(pol.policyId, { provider: primaryCandidate.provider, model: primaryCandidate.model, fallbackAllowed: e.target.checked })}
                          />
                          Allow Fallback
                        </label>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Offline ingestion models. Deliberately separate from the conversational
            model above: these run on batch jobs, not customer turns. */}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--jx-gray-200)", paddingTop: 14 }}>
          <span className="flabel" style={{ margin: 0 }}>Ingestion models</span>
          <p className="hint" style={{ marginTop: 4 }}>
            Used by knowledge ingestion runs, never by live conversations. Leave blank to inherit the model above.
          </p>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div>
              <span className="flabel">Narrative model</span>
              <select className="field" value={ingestModel} onChange={(e) => setIngestModel(e.target.value)}>
                <option value="">Inherit ({model})</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="hint">Bulk product write-ups — favour a cheap, fast model.</p>
            </div>
            <div>
              <span className="flabel">Extraction model</span>
              <select className="field" value={extractModel} onChange={(e) => setExtractModel(e.target.value)}>
                <option value="">Inherit (narrative model)</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="hint">Collections, coordinating sets and adult/youth/ladies sizing from catalogue pages — harder reasoning, favour a stronger model.</p>
            </div>
          </div>
        </div>

        {/* API key — per-project credential (secret; falls back to platform env) */}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--jx-gray-200)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={14} style={{ color: "var(--jx-gray-600)" }} />
            <span className="flabel" style={{ margin: 0 }}>{LLM_OPTIONS[provider]?.label || provider} API key</span>
            {project.ai?.apiKeyConfigured && !apiKey && (
              <span className="micro" style={{ color: "var(--jx-green, #2f855a)", fontWeight: 700 }}>
                ✓ configured ({project.ai.apiKeyHint})
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input
              className="field"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              placeholder={
                provider === "ollama" || provider === "placemaker"
                  ? "Not required for local PlaceMaker Gemma model"
                  : project.ai?.apiKeyConfigured
                    ? "Enter a new key to replace the stored one…"
                    : `Paste this project's key (${LLM_OPTIONS[provider]?.keyHelp || "…"})`
              }
              disabled={provider === "ollama" || provider === "placemaker"}
              style={{ flex: 1, fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12.5 }}
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              disabled={!apiKey}
              style={{ border: "1px solid var(--jx-gray-300)", background: "var(--jx-white)", borderRadius: 8, padding: "0 12px", cursor: apiKey ? "pointer" : "default", fontSize: 12 }}
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          <span className="micro" style={{ color: "var(--jx-gray-500)", display: "block", marginTop: 5 }}>
            Stored encrypted-at-rest and never returned to the browser. Leave blank to keep the current key
            {LLM_OPTIONS[provider]?.keyEnv ? <> — or to use the platform&apos;s <code>{LLM_OPTIONS[provider]?.keyEnv}</code>.</> : "."}
          </span>

          <div style={{ marginTop: 12 }}>
            <span className="flabel">Custom endpoint (optional)</span>
            <input
              className="field"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://… — override for a proxy / self-hosted / Azure-style gateway"
              style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12.5 }}
            />
          </div>
        </div>
      </div>

      {/* Prompt engineering */}
      <div className="panel">
        <h4><Sparkles size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Prompt engineering</h4>
        <div style={{ marginTop: "10px" }}>
          <span className="flabel">Agent name</span>
          <input className="field" value={systemName} onChange={(e) => setSystemName(e.target.value)} placeholder="Caroma Consultant" />
        </div>
        <div style={{ marginTop: "12px" }}>
          <span className="flabel">System prompt overrides</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={9}
            placeholder="You are the senior Caroma bathroom consultant. Understand each customer's real goal…"
            className="field" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "12.5px" }}
          />
          <span className="micro" style={{ color: "var(--jx-gray-500)" }}>
            Injected into the agent's system prompt for this tenant every turn.
          </span>
        </div>
      </div>

      {/* Journey guidance */}
      <div className="panel">
        <h4><Route size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Journey guidance</h4>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 10px" }}>
          GOALS the agent should reason toward — not a fixed script. The agent decides each next step
          itself, guided by these. e.g. "guide from problem to a confident quote; when an item is chosen,
          consider add-ons and what installing it needs; surface warranty before quoting."
        </p>
        <textarea
          value={journeyGuidance}
          onChange={(e) => setJourneyGuidance(e.target.value)}
          rows={6}
          placeholder="Describe the outcomes a great journey should reach for this business…"
          className="field" style={{ fontSize: "12.5px" }}
        />
      </div>

      {/* Context dimensions — what the agent extracts + scopes retrieval by */}
      <div className="panel">
        <h4><Puzzle size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Context dimensions</h4>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
          The dimensions the agent extracts from each conversation and uses to scope retrieval — different
          per vertical, no code change. e.g. a bathroom brand uses <b>space</b> + <b>projectType</b>; a fashion
          brand uses <b>occasion</b>, <b>fit</b>, <b>style</b>; workwear uses <b>industry</b>, <b>role</b>, <b>climate</b>.
          Leave empty to auto-derive a <b>space</b> dimension from your catalogue rooms.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {dimensions.map((d, i) => (
            <div key={i} style={{ border: "1px solid var(--jx-gray-300)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10 }}>
                <div>
                  <span className="flabel">Key</span>
                  <input className="field" value={d.key} onChange={(e) => patchDimension(i, { key: e.target.value })} placeholder="space" />
                </div>
                <div>
                  <span className="flabel">Label</span>
                  <input className="field" value={d.label || ""} onChange={(e) => patchDimension(i, { label: e.target.value })} placeholder="Space" />
                </div>
                <button onClick={() => removeDimension(i)} style={{ alignSelf: "end", border: "1px solid var(--jx-gray-300)", background: "var(--jx-white)", borderRadius: 8, padding: "9px 12px", cursor: "pointer", color: "var(--jx-destructive)", fontSize: 12.5 }}>Remove</button>
              </div>
              <div style={{ marginTop: 10 }}>
                <span className="flabel">Allowed values (comma-separated — leave blank for free text)</span>
                <input
                  className="field"
                  value={(d.values || []).join(", ")}
                  onChange={(e) => patchDimension(i, { values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
                  placeholder="Bathroom, Kitchen, Laundry"
                />
              </div>
              <div style={{ display: "flex", gap: 18, marginTop: 10 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--jx-gray-700)", cursor: "pointer" }}>
                  <input type="checkbox" checked={!!d.scoping} onChange={(e) => patchDimension(i, { scoping: e.target.checked })} />
                  Scoping <span className="micro" style={{ color: "var(--jx-gray-500)" }}>(outside these values = out of scope)</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--jx-gray-700)", cursor: "pointer" }}>
                  <input type="checkbox" checked={d.filtersRetrieval !== false} onChange={(e) => patchDimension(i, { filtersRetrieval: e.target.checked })} />
                  Filters retrieval
                </label>
              </div>
            </div>
          ))}
          <button onClick={addDimension} style={{ alignSelf: "start", border: "1px dashed var(--jx-gray-400)", background: "var(--jx-white)", borderRadius: 8, padding: "9px 14px", cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "var(--jx-black)" }}>
            + Add dimension
          </button>
        </div>
      </div>

      {/* Capabilities — the runtime toolset */}
      <div className="panel">
        <h4><Puzzle size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Capabilities</h4>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
          The agent's toolset is assembled at runtime from what you enable here. A products business, a
          services business and a program each enable a different set — no code change. (Understanding the
          request and asking questions are always on.)
        </p>
        <div className="form-grid">
          {CAPABILITY_CATALOG.map((c) => {
            const on = capabilities.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggleCap(c.id)}
                style={{
                  textAlign: "left", padding: "11px 13px", borderRadius: 10, cursor: "pointer",
                  border: on ? "2px solid var(--jx-black)" : "1px solid var(--jx-gray-300)",
                  background: on ? "var(--jx-gray-100)" : "var(--jx-white)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <b style={{ fontSize: 12.5, color: "var(--jx-black)" }}>{c.label}</b>
                  <span className={`switch ${on ? "on" : ""}`} style={{ pointerEvents: "none" }} />
                </div>
                <div style={{ fontSize: 11, color: "var(--jx-gray-500)", marginTop: 3 }}>{c.description}</div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
