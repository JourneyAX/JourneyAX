"use client";

/**
 * Journey Overview — ONE journey, the platform's loop, with this project's
 * plug-ins shown at each stage. Rendered entirely from the project's config:
 *
 *   understand → clarify (only if needed) → show → explain & recommend → bag
 *   → checkout & summary → one add-on → history when signed in; support beside.
 *
 * The loop is code every tenant shares. What a tenant adds is knowledge, not
 * flow: its house rules (persona.journeyGuidance), the questions it cares
 * about (contextDimensions), its rules, its facts (capacity guide, purchase
 * limits, hand-offs), the tools it has switched on (capabilities), and the
 * acceptance scenarios the loop must handle (scenarios). Nothing here is
 * tenant-specific. A project whose guidance still carries numbered
 * "JOURNEY n — …" paragraphs (PlaceMakers) gets those listed too.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Route, Puzzle, Compass, MessageSquare, PencilLine, GitBranch, Shield, AlertTriangle, HelpCircle, Sparkles, Filter, ListChecks } from "lucide-react";
import { CAPABILITY_CATALOG, SERVICES, type Project } from "../lib/api";

interface Rule { ruleId: string; name: string; scope: string; condition: string; action: string; status?: string; isActive?: boolean }

/** Numbered "JOURNEY n — TITLE. …" paragraphs, for projects that still write guidance that way. */
function parseNumberedJourneys(guidance: string): { preamble: string; gates: string[]; journeys: { n: number; title: string; body: string }[] } {
  const text = (guidance || "").replace(/\r\n/g, "\n");
  const re = /JOURNEY\s+(\d+)\s*[—–-]+\s*([^\n.]+?)\.\s*/g;
  const marks: { n: number; title: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ n: Number(m[1]), title: m[2].trim(), start: m.index, bodyStart: m.index + m[0].length });
  const preambleRaw = marks.length ? text.slice(0, marks[0].start) : text;
  const paras = preambleRaw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // A gate announces itself in capitals ("ONE HARD GATE — …"); a rule that says "never" in passing is not one.
  const gates = paras.filter((p) => /HARD GATE|\bMUST\b|\bNEVER\b/.test(p) && p.length < 900);
  const preamble = paras.filter((p) => !gates.includes(p)).join("\n\n");
  const journeys = marks.map((mk, i) => ({ n: mk.n, title: mk.title, body: text.slice(mk.bodyStart, i + 1 < marks.length ? marks[i + 1].start : undefined).trim() }));
  return { preamble, gates, journeys };
}

const STAGE_ORDER = ["understand", "clarify", "show", "recommend", "bag", "checkout", "history", "support"] as const;
type StageId = (typeof STAGE_ORDER)[number];

export function JourneyMap({ project, onEdit, onOpenBuilder }: { project: Project; onEdit: () => void; onOpenBuilder?: () => void }) {
  const p: any = project;
  const caps: string[] = project.capabilities?.length ? project.capabilities : CAPABILITY_CATALOG.map((c) => c.id);
  const has = (id: string) => caps.includes(id);
  const capLabel = (id: string) => CAPABILITY_CATALOG.find((c) => c.id === id)?.label || id;
  const dims = project.contextDimensions || [];
  const guidance = project.persona?.journeyGuidance?.trim() || "";
  const graph = project.persona?.journeyGraph;
  const starters = (project.intro?.starters || []) as { label: string; prompt: string }[];
  const scenarios = (p.scenarios || []) as { id: string; say: string; expect: string; stage?: string }[];
  const parsed = useMemo(() => parseNumberedJourneys(guidance), [guidance]);
  const [rules, setRules] = useState<Rule[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${SERVICES.project}/api/v1/projects/${project.projectId}/rules`, { headers: { "X-Tenant-ID": project.projectId } });
        const data = await res.json();
        const list: Rule[] = Array.isArray(data) ? data : data?.rules || [];
        if (!cancelled) setRules(list);
      } catch { if (!cancelled) setRules([]); }
    })();
    return () => { cancelled = true; };
  }, [project.projectId]);

  const askedDims = dims.filter((d) => d.askWhenMissing);
  const hardDims = dims.filter((d) => d.hardFilter);
  const derivedDims = dims.filter((d) => d.derive?.from);
  const publishedRules = rules.filter((r) => (r.status ? r.status === "published" : r.isActive !== false));
  const rulesByScope = (scope: string) => publishedRules.filter((r) => r.scope === scope);
  const isCart = p.commerceMode === "cart";
  const bagWord = isCart ? "bag" : "quote";
  const handoffs = (p.handoffs || []) as { label: string; match?: any }[];
  const limits = (p.purchaseLimits || []) as { maxQuantity: number; reason?: string; match?: any }[];
  const storageGuide = (p.storageGuide || []) as any[];
  const demoProfiles = (p.demoCustomers?.profiles || []) as any[];
  const graphTools = new Set<string>((graph?.nodes || []).map((n: any) => n?.data?.capabilityId).filter(Boolean));
  const missingCaps = [...graphTools].filter((t) => !has(t));

  /** What each stage of the loop uses from THIS project. `off` = the journey names it but it is switched off. */
  const stages: { id: StageId; title: string; platform: string; plugins: { text: string; off?: boolean }[] }[] = [
    { id: "understand", title: "Understand the intent", platform: "Intent, goal and the configured dimensions are read from every message; scoping dimensions decide what the business serves.",
      plugins: [
        ...dims.filter((d) => d.scoping).map((d) => ({ text: `${d.label || d.key} is scoping — a request outside ${d.values?.length || 0} values is out of scope` })),
        ...derivedDims.map((d) => ({ text: `${d.label || d.key} is derived from ${d.derive!.from} — never asked` })),
        ...dims.filter((d) => !d.scoping && !d.derive && !d.askWhenMissing).map((d) => ({ text: `${d.label || d.key} — inferred, never asked` })),
      ] },
    { id: "clarify", title: "Clarify — only if needed", platform: "The agent decides whether a question changes what it would show; when it asks, it asks the business's own questions as tappable chips, at most two, beside the cards. Open goals are asked first.",
      plugins: askedDims.length
        ? askedDims.map((d) => ({ text: `“${d.question || `Which ${(d.label || d.key).toLowerCase()}?`}” → ${(d.values || []).join(" · ")}`, off: !has("choice") && false }))
        : [{ text: "No dimension is marked “ask when missing” — the agent asks in free text only when the guidance requires it." }] },
    { id: "show", title: "Show real products first", platform: "Cards from the catalogue, grounded on the pricebook (price, image, stock); sold-out never shown; comparison card for finalists.",
      plugins: [
        { text: `Product cards + comparison`, off: !has("products") },
        ...hardDims.map((d) => ({ text: `${d.label || d.key} is a hard filter — no item of another ${(d.label || d.key).toLowerCase()} reaches a card` })),
        ...rulesByScope("recommendation").map((r) => ({ text: `Rule · ${r.name}` })),
      ] },
    { id: "recommend", title: "Explain, recommend, complete the set", platform: "The reason in a sentence; a set as one bundle with a total; storage sized by arithmetic; add-ons from real relationships.",
      plugins: [
        { text: `Bundle card (one total, Add all)`, off: !has("products") },
        { text: `Accessories & add-ons`, off: !has("accessories") },
        { text: `Decisions (choice card)`, off: !has("choice") },
        ...(storageGuide.length ? [{ text: `Capacity guide — ${storageGuide.length} families, computed in code` }] : []),
        ...handoffs.map((h) => ({ text: `Hand-off · ${h.label}` })),
      ] },
    { id: "bag", title: isCart ? "Bag" : "Quote", platform: `Server-authoritative ${bagWord}: every tap is applied deterministically; sold-out refused; limits enforced.`,
      plugins: [
        ...limits.map((l) => ({ text: `Purchase limit · max ${l.maxQuantity}${l.reason ? ` — ${l.reason}` : ""}` })),
        ...rulesByScope("compliance").map((r) => ({ text: `Rule · ${r.name}` })),
        ...rulesByScope("pricing").map((r) => ({ text: `Rule · ${r.name}` })),
      ] },
    { id: "checkout", title: "Checkout, summary, one add-on", platform: "Stripe checkout; on return the order card, a thank-you with the order number, and one relevant add-on offer.",
      plugins: rulesByScope("conversation").map((r) => ({ text: `Rule · ${r.name}` })) },
    { id: "history", title: "Signed in — match past history", platform: "Own orders only, bound server-side; historical price kept distinct from today's.",
      plugins: [
        { text: demoProfiles.length ? `Customer history tools · ${demoProfiles.length} sample profiles` : "Customer history tools", off: !has("customerHistory") },
        ...rulesByScope("escalation").map((r) => ({ text: `Rule · ${r.name}` })),
      ] },
    { id: "support", title: "Support & how-to, beside the loop", platform: "Answers from ingested guides and policies, never memory; every answer ends with one door back into buying.",
      plugins: [
        { text: "Step-by-step guides", off: !has("steps") },
        { text: "Guide documents", off: !has("installGuide") },
      ] },
  ];

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Journey Overview</h1>
          <p className="pagesub">
            One journey — the platform's loop — with what <b>{project.companyName}</b> plugs into each stage, live from its configuration. The agent decides each step from context; nothing below scripts it.
          </p>
        </div>
        <div className="actions">
          {onOpenBuilder && (
            <button className="btn" onClick={onOpenBuilder}>
              <GitBranch size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Open in Journey Builder
            </button>
          )}
          <button className="btn y" onClick={onEdit}>
            <PencilLine size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Edit in AI Orchestration
          </button>
        </div>
      </div>

      {missingCaps.length > 0 && (
        <div className="panel" style={{ borderColor: "#e0b400", background: "#fffbe6" }}>
          <div className="micro"><AlertTriangle size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />TOOLS ON THE CANVAS THAT THE PROJECT HAS NOT ENABLED</div>
          <div className="chips">{missingCaps.map((c) => <span key={c} className="chip" style={{ cursor: "default" }}>{capLabel(c)}</span>)}</div>
          <span className="fhelp">The agent cannot call a tool that is switched off. Enable these under AI Orchestration → Capabilities, or take them off the canvas.</span>
        </div>
      )}

      {/* The loop */}
      <div className="panel">
        <div className="micro"><Route size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />THE JOURNEY (platform loop · this project's plug-ins per stage)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
          {stages.map((st, i) => (
            <div key={st.id} className="node" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="pill p-active" style={{ fontSize: 10 }}>{i + 1}</span>
                <b style={{ fontSize: 13 }}>{st.title}</b>
              </div>
              <span style={{ fontSize: 12, color: "var(--jx-gray-600)", lineHeight: 1.5 }}>{st.platform}</span>
              {st.plugins.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 2 }}>
                  {st.plugins.map((pl, j) => (
                    <span key={j} style={{ fontSize: 12, lineHeight: 1.45, color: pl.off ? "var(--jx-gray-400)" : "var(--jx-gray-800)", textDecoration: pl.off ? "line-through" : "none" }} title={pl.off ? "switched off for this project" : undefined}>
                      · {pl.text}{pl.off ? " (off)" : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* House rules + hard gates */}
      <div className="cardrow">
        <div className="panel">
          <div className="micro"><Compass size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />HOUSE RULES &amp; FACTS (what the agent reasons with — goals, not a script)</div>
          {guidance
            ? <p style={{ fontSize: 13, lineHeight: 1.65, color: "var(--jx-gray-700)", whiteSpace: "pre-wrap", margin: 0 }}>{parsed.preamble || guidance}</p>
            : <span className="role">No guidance configured yet — the agent runs on platform defaults. Add house rules in AI Orchestration.</span>}
        </div>
        <div className="panel">
          <div className="micro"><Shield size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />HARD GATES &amp; WHAT IS ENFORCED IN CODE</div>
          {parsed.gates.map((g, i) => (
            <div key={i} className="node" style={{ borderColor: "var(--jx-black)", fontSize: 12.5, lineHeight: 1.55 }}>{g}</div>
          ))}
          {hardDims.map((d) => (
            <div key={d.key} className="node" style={{ fontSize: 12 }}>
              <Filter size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} /><b>{d.label || d.key}</b> — once known, no item of another {String(d.label || d.key).toLowerCase()} reaches a card{d.derive?.from ? `; derived from ${d.derive.from}, never asked` : ""}.
            </div>
          ))}
          {limits.map((l, i) => <div key={i} className="node" style={{ fontSize: 12 }}>Purchase limit — max {l.maxQuantity} per person{l.reason ? ` (${l.reason})` : ""}, enforced at the {bagWord}.</div>)}
          {storageGuide.length > 0 && <div className="node" style={{ fontSize: 12 }}>Capacity — {storageGuide.length} families; cards × sleeving → the box or binder band, computed, never narrated.</div>}
          <div className="node" style={{ fontSize: 12 }}>Sold-out items never reach a card or the {bagWord}. Every card's price, image and stock come from the pricebook, not the model.</div>
          {parsed.gates.length === 0 && hardDims.length === 0 && limits.length === 0 && <span className="role">Nothing beyond the platform's own guards.</span>}
        </div>
      </div>

      {/* Questions + rules */}
      <div className="cardrow">
        <div className="panel">
          <div className="micro"><HelpCircle size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />THE QUESTIONS THIS BUSINESS CAN ASK (chips — the agent decides when, only if not inferable)</div>
          {askedDims.length === 0 && <span className="role">No dimension is marked “ask when missing”. Mark them in AI Orchestration to make the agent's questions tappable.</span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {askedDims.map((d) => (
              <div key={d.key} className="node">
                <b style={{ fontSize: 12.5 }}>{d.question || `Which ${(d.label || d.key).toLowerCase()}?`}</b>
                <div className="chips" style={{ marginTop: 6 }}>
                  {(d.values || []).map((v) => <span key={v} className="chip" style={{ cursor: "default", padding: "4px 10px", fontSize: 11 }}>{v}</span>)}
                </div>
                {d.description && <span className="fhelp">{d.description}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="micro"><Shield size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />BUSINESS RULES IN FORCE ({publishedRules.length} published{rules.length > publishedRules.length ? `, ${rules.length - publishedRules.length} draft` : ""})</div>
          {publishedRules.length === 0 && <span className="role">No published rules — the agent runs on the guidance alone.</span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {publishedRules.map((r) => (
              <div key={r.ruleId} className="node" style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className="pill p-draft" style={{ fontSize: 10 }}>{r.scope}</span>
                <span><b>{r.name}</b> — <span style={{ color: "var(--jx-gray-600)" }}>{r.condition}</span> → {r.action}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Scenarios — the acceptance list */}
      <div className="panel">
        <div className="micro"><ListChecks size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />SCENARIOS THE LOOP MUST HANDLE ({scenarios.length}) — examples and the acceptance list, never instructions to the agent</div>
        {scenarios.length === 0 && <span className="role">None recorded. Add scenarios to the project (id, what the customer says, what must be true) to keep a test list beside the journey.</span>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
          {scenarios.map((s) => (
            <div key={s.id} className="node" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className="pill p-active" style={{ fontSize: 10 }}>{s.id}</span>
                {s.stage && <span className="micro">{stages.find((x) => x.id === s.stage)?.title || s.stage}</span>}
              </div>
              <b style={{ fontSize: 12.5 }}>“{s.say}”</b>
              <span style={{ fontSize: 12, color: "var(--jx-gray-700)", lineHeight: 1.5 }}>{s.expect}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Numbered journeys, for projects that still write guidance that way */}
      {parsed.journeys.length > 0 && (
        <div className="panel">
          <div className="micro"><Compass size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />NUMBERED JOURNEYS IN THE GUIDANCE ({parsed.journeys.length})</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {parsed.journeys.map((j) => (
              <details key={j.n} className="node">
                <summary style={{ cursor: "pointer", fontSize: 12.5 }}><span className="pill p-active" style={{ marginRight: 8, fontSize: 10 }}>J{j.n}</span><b>{j.title}</b></summary>
                <p style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--jx-gray-700)", whiteSpace: "pre-wrap", marginTop: 6 }}>{j.body}</p>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* Entry points, tools, dimensions, persona */}
      <div className="cardrow">
        <div className="panel">
          <div className="micro"><Sparkles size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />ENTRY POINTS &amp; TOOLS</div>
          <div>
            <div className="micro" style={{ marginBottom: 6 }}>Storefront starters</div>
            <div className="chips">
              {starters.map((s) => <span key={s.label} className="chip" style={{ cursor: "default", padding: "4px 10px", fontSize: 11 }} title={s.prompt}>{s.label}</span>)}
              {!starters.length && <span className="role">None configured.</span>}
            </div>
          </div>
          <div>
            <div className="micro" style={{ marginBottom: 6 }}>Tools the agent can use (order decided per conversation, never scripted)</div>
            <div className="chips">
              <span className="chip on" style={{ cursor: "default", padding: "4px 10px", fontSize: 11 }}>Understand &amp; clarify</span>
              {CAPABILITY_CATALOG.filter((c) => has(c.id)).map((c) => <span key={c.id} className="chip" style={{ cursor: "default", padding: "4px 10px", fontSize: 11 }} title={c.description}>{c.label}</span>)}
            </div>
            {CAPABILITY_CATALOG.some((c) => !has(c.id)) && (
              <span className="fhelp">Off: {CAPABILITY_CATALOG.filter((c) => !has(c.id)).map((c) => c.label).join(", ")}.</span>
            )}
          </div>
          <div>
            <div className="micro" style={{ marginBottom: 6 }}><Puzzle size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} />Everything the agent listens for</div>
            <div className="chips">
              {dims.map((d) => (
                <span key={d.key} className="chip" style={{ cursor: "default", padding: "4px 10px", fontSize: 11 }} title={d.description}>
                  {d.label || d.key}{d.scoping ? " · scoping" : ""}{d.askWhenMissing ? " · askable" : ""}{d.hardFilter ? " · hard filter" : ""}{d.derive ? " · derived" : ""}
                </span>
              ))}
              {dims.length === 0 && <span className="role">None configured — a "space" dimension is auto-derived from catalogue rooms.</span>}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="micro"><MessageSquare size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />PERSONA</div>
          <div className="between">
            <div>
              <b style={{ fontSize: 14 }}>{project.persona?.systemName || "Unnamed agent"}</b>
              <p className="role" style={{ marginTop: 4, maxWidth: 720, whiteSpace: "normal" }}>
                {project.persona?.systemPromptOverrides?.trim() || "No persona overrides — platform default voice."}
              </p>
            </div>
            <span className="pill p-active">model: {project.ai?.model || "platform default"}</span>
          </div>
        </div>
      </div>
    </>
  );
}
