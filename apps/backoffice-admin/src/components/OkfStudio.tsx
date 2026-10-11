"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, CheckCircle2, GitBranch, Play, Save, ShieldCheck, UploadCloud } from "lucide-react";
import {
  okfApi, projectApi,
  type OkfAnalysis, type OkfDraft, type OkfReleaseMeta, type OkfRevocationSummary, type Project,
} from "../lib/api";
import { ENVIRONMENTS, assignVerifier, type EnvironmentId } from "./okf/okf-model";
import { ArtifactPolicyToggle } from "./okf/ArtifactPolicyToggle";
import { ConceptEditor } from "./okf/ConceptEditor";
import { ImportExportBar } from "./okf/ImportExportBar";
import { ReadinessPanel } from "./okf/ReadinessPanel";
import { RelationshipList } from "./okf/RelationshipList";
import { RevocationPanel } from "./okf/RevocationPanel";
import { VerificationQueue } from "./okf/VerificationQueue";

function shortChecksum(value?: string) {
  return value ? `${value.replace(/^sha256:/, "").slice(0, 12)}…` : "—";
}

export function OkfStudio({ project }: { project: Project }) {
  const [environmentId, setEnvironmentId] = useState<EnvironmentId>("production");
  const [analysis, setAnalysis] = useState<OkfAnalysis | null>(null);
  const [revocations, setRevocations] = useState<OkfRevocationSummary[]>([]);
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
    const [nextDraft, nextReleases, nextAnalysis, nextRevocations] = await Promise.all([
      okfApi.draft(project.projectId, environmentId).catch(() => null),
      okfApi.releases(project.projectId, environmentId).catch(() => []),
      okfApi.analysis(project.projectId, environmentId).catch(() => null),
      okfApi.revocations(project.projectId, environmentId).catch(() => []),
    ]);
    setDraft(nextDraft);
    setReleases(nextReleases);
    setAnalysis(nextAnalysis);
    setRevocations(nextRevocations);
    setRaw(nextDraft ? JSON.stringify(nextDraft.content, null, 2) : "");
  }, [project.projectId, environmentId]);

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

  const persist = async (content: unknown, successMessage?: string) => {
    const saved = await okfApi.saveDraft(project.projectId, draft?.revision || 0, content, environmentId);
    setDraft(saved);
    setRaw(JSON.stringify(saved.content, null, 2));
    setNotice(successMessage || `Draft revision ${saved.revision} saved. ${saved.validation.valid ? "Validation passed." : `${saved.validation.issues.length} issue(s) remain.`}`);
    setAnalysis(await okfApi.analysis(project.projectId, environmentId).catch(() => null));
  };

  const saveDraft = () => act("save", async () => { await persist(JSON.parse(raw)); });
  const saveContent = (content: unknown) => act("save", async () => { await persist(content); });

  const validate = () => act("validate", async () => {
    const result = await okfApi.validate(project.projectId, environmentId);
    setDraft((current) => current ? { ...current, validation: result } : current);
    setNotice(result.valid ? "The draft satisfies the OKF publication contract." : `${result.issues.length} validation issue(s) must be resolved.`);
  });

  const runPreview = () => act("preview", async () => {
    setPreview(await okfApi.preview(project.projectId, message, {}, environmentId));
  });

  const publishKnowledge = () => act("publish", async () => {
    if (!draft) throw new Error("Save a valid draft first.");
    const result = await okfApi.publish(project.projectId, {
      expectedRevision: draft.revision, version, required: true, failurePolicy: "fail_closed", environmentId,
    });
    setNotice(`Knowledge release ${result.release.releaseId} is ready and staged. Publish the Business Pack to activate both atomically.`);
    setHasStagedRelease(true);
    await load();
  });

  const activate = () => act("activate", async () => {
    await projectApi.publish(project.projectId, { note: `Activate OKF ${project.knowledgeModel?.version || version} (${environmentId})`, environmentId });
    setNotice(`Business Pack published to ${environmentId}. The pack and its exact OKF release are now one active unit.`);
  });

  const stageRelease = (release: OkfReleaseMeta) => act(`stage:${release.releaseId}`, async () => {
    await okfApi.selectRelease(project.projectId, release, environmentId);
    setHasStagedRelease(true);
    setNotice(`Release ${release.version} is staged. Publish the Business Pack to activate it; use Config History for an atomic rollback.`);
  });

  const importBundle = (file: File) => act("import", async () => {
    const result = await okfApi.importBundle(project.projectId, file, draft?.revision || 0, environmentId);
    setDraft(result.draft);
    setRaw(JSON.stringify(result.draft.content, null, 2));
    setNotice(`Imported ${file.name} as draft revision ${result.draft.revision}${result.diagnostics.length ? ` with ${result.diagnostics.length} diagnostic(s) to review` : ""}.`);
    setAnalysis(await okfApi.analysis(project.projectId, environmentId).catch(() => null));
  });

  const exportRelease = (releaseId: string) => act("export", async () => {
    const blob = await okfApi.exportRelease(project.projectId, releaseId, environmentId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${releaseId}.zip`; link.click();
    URL.revokeObjectURL(url);
  });

  const setArtifactPolicy = (required: boolean) => act("policy", async () => {
    await okfApi.setArtifactPolicy(project.projectId, required, environmentId);
    setAnalysis(await okfApi.analysis(project.projectId, environmentId).catch(() => null));
    setNotice(required ? "Releases now need an exported, verified artifact before they count as ready." : "Artifact export is no longer required for readiness.");
  });

  const assign = (target: { targetType: "concept" | "relationship"; targetId: string }, verifiedBy: string, verifierRole: string) => act("assign", async () => {
    if (!draft) throw new Error("No draft to update.");
    await persist(assignVerifier(draft.content, { ...target, verifiedBy, verifierRole }), `Verifier assigned for ${target.targetId}. They must now attest it themselves.`);
  });

  const attest = (recordId: string) => act("attest", async () => {
    if (!draft) throw new Error("No draft to attest.");
    await okfApi.attest(project.projectId, recordId, draft.revision, environmentId);
    setNotice(`Attestation recorded for ${recordId}.`);
  });

  const configureRole = (roleId: string, principalIds: string[]) => act("role", async () => {
    await okfApi.setVerifierRole(project.projectId, roleId, principalIds, environmentId);
    setNotice(`Verifier role '${roleId}' now has ${principalIds.length} member(s).`);
  });

  const createRevocation = (input: { releaseId: string; conceptIds: string[]; reason: string; expiresAt: string }) => act("revoke", async () => {
    await okfApi.createRevocation(project.projectId, { ...input, environmentId });
    setNotice("Revocation is active. Affected guidance stops being used immediately.");
    setRevocations(await okfApi.revocations(project.projectId, environmentId));
  });

  const liftRevocation = (revocationId: string, correctedReleaseId: string, reason: string) => act("lift", async () => {
    await okfApi.liftRevocation(project.projectId, revocationId, { environmentId, correctedReleaseId, reason });
    setNotice("Revocation lifted by the corrected release.");
    setRevocations(await okfApi.revocations(project.projectId, environmentId));
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
        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
          <label className="micro">Environment
            <select className="inp" style={{ marginLeft: 6 }} value={environmentId} onChange={(event) => setEnvironmentId(event.target.value as EnvironmentId)} aria-label="Environment">
              {ENVIRONMENTS.map((env) => <option key={env} value={env}>{env}</option>)}
            </select>
          </label>
        <span className={`pill ${draft?.validation?.valid ? "p-active" : "p-draft"}`}>
          {draft ? (draft.validation?.valid ? `Draft r${draft.revision} valid` : `Draft r${draft.revision} needs review`) : "No draft"}
        </span>
        </div>
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
          <div className="between"><h4>Concepts</h4><span className="micro">{summary.relationships} typed relationships</span></div>
          {!draft && <div className="micro" style={{ padding: 6 }}>Import an OKF bundle or paste a typed draft to begin. Nothing in the legacy packs folder is read here.</div>}
          {draft && <ConceptEditor content={draft.content} busy={busy !== null} onSave={saveContent} />}
          <h4 style={{ marginTop: 14 }}>Relationships</h4>
          <RelationshipList content={draft?.content} />
        </div>

        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <ReadinessPanel analysis={analysis} />
          <ArtifactPolicyToggle required={Boolean(analysis?.artifactRequired)} disabled={busy !== null} onChange={setArtifactPolicy} />
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
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
        <VerificationQueue
          analysis={analysis} content={draft?.content} busy={busy !== null}
          roles={analysis?.verifierRoles || []}
          onAssign={assign} onAttest={attest} onConfigureRole={configureRole}
        />
        <RevocationPanel
          revocations={revocations} releases={releases}
          concepts={(draft?.content?.concepts || []).map((concept: any) => ({ conceptId: concept.conceptId, name: concept.name }))}
          busy={busy !== null} onCreate={createRevocation} onLift={liftRevocation}
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <ImportExportBar releases={releases} busy={busy !== null} onImport={importBundle} onExport={exportRelease} />
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
