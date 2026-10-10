"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, CheckCircle2, GitBranch, Play, Save, ShieldCheck, UploadCloud } from "lucide-react";
import { okfApi, projectApi, type OkfDraft, type OkfReleaseMeta, type Project } from "../lib/api";

function shortChecksum(value?: string) {
  return value ? `${value.replace(/^sha256:/, "").slice(0, 12)}…` : "—";
}

export function OkfStudio({ project }: { project: Project }) {
  const [draft, setDraft] = useState<OkfDraft | null>(null);
  const [releases, setReleases] = useState<OkfReleaseMeta[]>([]);
  const [raw, setRaw] = useState("");
  const [message, setMessage] = useState("I need help choosing the right option");
  const [preview, setPreview] = useState<any>(null);
  const [version, setVersion] = useState("1.0.0");
  const [busy, setBusy] = useState<string | null>(null);
  const [hasStagedRelease, setHasStagedRelease] = useState(Boolean(project.knowledgeModel));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [nextDraft, nextReleases] = await Promise.all([
      okfApi.draft(project.projectId).catch(() => null),
      okfApi.releases(project.projectId).catch(() => []),
    ]);
    setDraft(nextDraft);
    setReleases(nextReleases);
    if (nextDraft) setRaw(JSON.stringify(nextDraft.content, null, 2));
  }, [project.projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setHasStagedRelease(Boolean(project.knowledgeModel)); }, [project.projectId, project.knowledgeModel?.checksum]);

  const summary = useMemo(() => {
    const content = draft?.content;
    return {
      concepts: content?.concepts?.length || 0,
      relationships: content?.relationships?.length || 0,
      sources: content?.sources?.length || 0,
      evidence: content?.evidenceChunks?.length || 0,
      verified: content?.verifications?.filter((item: any) => item.status === "verified").length || 0,
    };
  }, [draft]);

  async function act(label: string, work: () => Promise<void>) {
    setBusy(label); setError(null); setNotice(null);
    try { await work(); } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  }

  const saveDraft = () => act("save", async () => {
    const content = JSON.parse(raw);
    const saved = await okfApi.saveDraft(project.projectId, draft?.revision || 0, content);
    setDraft(saved);
    setRaw(JSON.stringify(saved.content, null, 2));
    setNotice(`Draft revision ${saved.revision} saved. ${saved.validation.valid ? "Validation passed." : `${saved.validation.issues.length} issue(s) remain.`}`);
  });

  const validate = () => act("validate", async () => {
    const result = await okfApi.validate(project.projectId);
    setDraft((current) => current ? { ...current, validation: result } : current);
    setNotice(result.valid ? "The draft satisfies the OKF publication contract." : `${result.issues.length} validation issue(s) must be resolved.`);
  });

  const runPreview = () => act("preview", async () => {
    const result = await okfApi.preview(project.projectId, message);
    setPreview(result);
  });

  const publishKnowledge = () => act("publish", async () => {
    if (!draft) throw new Error("Save a valid draft first.");
    const result = await okfApi.publish(project.projectId, {
      expectedRevision: draft.revision,
      version,
      required: true,
      failurePolicy: "fail_closed",
    });
    setNotice(`Knowledge release ${result.release.releaseId} is ready and staged. Publish the Business Pack to activate both atomically.`);
    setHasStagedRelease(true);
    await load();
  });

  const activate = () => act("activate", async () => {
    await projectApi.publish(project.projectId, { note: `Activate OKF ${project.knowledgeModel?.version || version}` });
    setNotice("Business Pack published. The pack and its exact OKF release are now one active unit.");
  });

  const stageRelease = (release: OkfReleaseMeta) => act(`stage:${release.releaseId}`, async () => {
    await okfApi.selectRelease(project.projectId, release);
    setHasStagedRelease(true);
    setNotice(`Release ${release.version} is staged. Publish the Business Pack to activate it; use Config History for an atomic rollback.`);
  });

  return (
    <div className="panel" style={{ borderColor: "var(--jx-gray-300)", marginBottom: 16 }}>
      <div className="between" style={{ alignItems: "flex-start", gap: 16 }}>
        <div>
          <div className="micro"><Brain size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />STRUCTURED BUSINESS KNOWLEDGE</div>
          <h3 style={{ margin: "4px 0" }}>OKF control plane</h3>
          <p className="micro" style={{ maxWidth: 760, color: "var(--jx-gray-600)" }}>
            Concepts decide what to ask and what may be claimed. Verified evidence explains. Live catalogue and commerce APIs still own products, price and stock.
          </p>
        </div>
        <span className={`pill ${draft?.validation?.valid ? "p-active" : "p-draft"}`}>
          {draft ? (draft.validation?.valid ? `Draft r${draft.revision} valid` : `Draft r${draft.revision} needs review`) : "No draft"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8, marginTop: 14 }}>
        {Object.entries(summary).map(([label, value]) => (
          <div key={label} style={{ background: "var(--jx-gray-100)", borderRadius: 8, padding: "9px 10px" }}>
            <div className="micro" style={{ textTransform: "uppercase" }}>{label}</div>
            <strong style={{ fontSize: 20 }}>{value}</strong>
          </div>
        ))}
      </div>

      {notice && <div className="node" style={{ marginTop: 12, borderColor: "#52c41a", background: "#f6ffed" }}><CheckCircle2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />{notice}</div>}
      {error && <div className="node" style={{ marginTop: 12, borderColor: "var(--jx-destructive)", background: "#fff1f0" }}><AlertTriangle size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(320px, .85fr)", gap: 14, marginTop: 14 }}>
        <div>
          <div className="between"><h4>Concept map</h4><span className="micro">{summary.relationships} typed relationships</span></div>
          <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--jx-gray-200)", borderRadius: 8 }}>
            {(draft?.content?.concepts || []).map((concept: any) => (
              <div key={concept.conceptId} style={{ padding: "10px 12px", borderBottom: "1px solid var(--jx-gray-200)" }}>
                <div className="between"><strong>{concept.name}</strong><span className={`pill ${concept.riskClass === "safety_critical" ? "p-inactive" : "p-draft"}`}>{concept.riskClass}</span></div>
                <div className="micro" style={{ color: "var(--jx-gray-600)" }}>{concept.type} · {concept.lens} · {concept.requiredFacts?.length || 0} required fact(s)</div>
                <div className="micro" style={{ color: "var(--jx-gray-500)", overflow: "hidden", textOverflow: "ellipsis" }}>{concept.conceptId}</div>
              </div>
            ))}
            {!draft && <div style={{ padding: 14 }} className="micro">Import or generate a typed OKF release draft to begin. Nothing in the legacy packs folder is read here.</div>}
          </div>
        </div>

        <div>
          <h4>Conversation preview</h4>
          <textarea className="inp" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
          <button className="btn" style={{ marginTop: 8 }} onClick={runPreview} disabled={!draft || busy === "preview"}><Play size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Preview decision</button>
          {preview && (
            <div className="node" style={{ marginTop: 10 }}>
              {preview.previewable === false ? <><b>Blocked</b><div className="micro">Draft must validate before preview.</div></> : <>
                <div className="between"><b>{preview.decision?.mode}</b><span className="pill p-active">{preview.decision?.retrieval?.permission}</span></div>
                <div className="micro">Concept: {preview.decision?.conceptId || "No match"}</div>
                {preview.decision?.clarification?.question && <div style={{ marginTop: 6 }}>{preview.decision.clarification.question}</div>}
                {preview.decision?.safety?.blocksProducts && <div className="micro" style={{ color: "var(--jx-destructive)", marginTop: 6 }}>Products blocked until safety guidance is satisfied.</div>}
              </>}
            </div>
          )}
        </div>
      </div>

      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Advanced typed release editor</summary>
        <p className="micro" style={{ color: "var(--jx-gray-600)" }}>Strict JSON contract. Unknown fields, broken references, stale verification and unsigned evidence are rejected by the service.</p>
        <textarea className="inp" style={{ width: "100%", minHeight: 300, fontFamily: "monospace", fontSize: 11 }} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste an OKF release-content document…" />
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn" onClick={saveDraft} disabled={busy === "save"}><Save size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Save draft</button>
          <button className="btn" onClick={validate} disabled={!draft || busy === "validate"}><ShieldCheck size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Validate</button>
        </div>
        {draft && !draft.validation.valid && (
          <div style={{ marginTop: 10, maxHeight: 180, overflow: "auto" }}>
            {draft.validation.issues.map((issue, index) => <div key={`${issue.code}-${index}`} className="micro" style={{ color: "var(--jx-destructive)" }}>{issue.code}: {issue.message}</div>)}
          </div>
        )}
      </details>

      <div className="between" style={{ marginTop: 16, alignItems: "end" }}>
        <div>
          <h4 style={{ marginBottom: 5 }}>Release</h4>
          <label className="micro">Version</label>
          <input className="inp" style={{ width: 150 }} value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn" onClick={publishKnowledge} disabled={!draft?.validation?.valid || busy === "publish"}><UploadCloud size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Publish immutable OKF</button>
          <button className="btn y" onClick={activate} disabled={!hasStagedRelease || busy === "activate"}><GitBranch size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Publish Business Pack</button>
        </div>
      </div>

      {releases.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="micro">RELEASE HISTORY</div>
          {releases.map((release) => (
            <div key={release.releaseId} className="between" style={{ padding: "8px 0", borderBottom: "1px solid var(--jx-gray-200)" }}>
              <div><b>{release.version}</b> <span className="micro">{release.status} · {shortChecksum(release.checksum)}</span></div>
              <button className="btn" onClick={() => stageRelease(release)} disabled={busy === `stage:${release.releaseId}`}>Stage release</button>
            </div>
          ))}
          <p className="micro" style={{ color: "var(--jx-gray-500)" }}>Activation and rollback happen through Business Pack Config History so journey, cards, tools and knowledge move together.</p>
        </div>
      )}
    </div>
  );
}
