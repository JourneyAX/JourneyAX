/**
 * Knowledge ingestion control plane (B4).
 *
 * POST /api/knowledge/ingest { projectId, limit? }
 *   → creates an ingest_jobs doc, SPAWNS the generic ingest runner
 *     (apps/journeyax-web/src/scripts/ingest-project.ts) as a detached child
 *     process (ingestion runs minutes — never inline in a request), returns jobId.
 *
 * GET /api/knowledge/ingest?jobId=…   → that job's status/progress/log
 * GET /api/knowledge/ingest?projectId=… → latest job for the project
 *
 * The runner reads the PROJECT's knowledgeSource config — the site being ingested
 * is configuration, not code. Docs land tagged with projectId (isolation contract).
 */
import { NextResponse } from "next/server";
import { invalidateProject } from "@journeyax/cache";
import { spawn } from "child_process";
import { resolve } from "path";
import { ObjectId } from "mongodb";
import { ingestJobsCollection } from "../../../../lib/mongo-server";
import { requireAuth, scopeTenant, tenantAllowed } from "../../../../lib/require-auth";

/** Jobs whose completion has already dropped the cache (the UI polls). */
const settledJobs = new Set<string>();

export async function POST(req: Request) {
  try {
    // Starting an ingest is a privileged, resource-heavy action.
    const auth = await requireAuth(req, "knowledge.ingest");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const body = await req.json();
    const limit = body?.limit;
    /* Optional stage selection. Ingestion is a dozen stages and re-running all
     * of them to refresh one is wasteful — and worse, it re-crawls a customer's
     * site to fix a colour palette. Comma-separated stage names, validated as
     * plain identifiers so nothing shell-ish reaches the spawn. */
    const only = String(body?.only || '')
      .split(',').map((x: string) => x.trim()).filter((x: string) => /^[a-z0-9-]+$/i.test(x));
    const projectId = scopeTenant(auth.identity, body?.projectId);
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    const jobs = await ingestJobsCollection();

    /* One run at a time per project — ingestion is heavy (browser + embeddings).
     *
     * But a job whose runner died leaves its record saying "running" forever and
     * then blocks the project permanently: there is no cancel endpoint, so the
     * only escape was editing the database by hand. The runner writes progress
     * and log lines continuously, so a stale `updatedAt` is reliable evidence it
     * is gone. Such a job is closed out as failed and the new run proceeds. */
    const STALE_MS = 10 * 60 * 1000;
    const running = await jobs.findOne({ projectId, status: { $in: ["queued", "running"] } });
    if (running) {
      const beat = new Date(running.updatedAt ?? running.createdAt ?? 0).getTime();
      if (Date.now() - beat < STALE_MS) {
        return NextResponse.json({ error: `An ingest is already ${running.status} for this project.`, jobId: String(running._id) }, { status: 409 });
      }
      await jobs.updateOne({ _id: running._id }, { $set: {
        status: "failed",
        error: `Runner stopped reporting for over ${Math.round(STALE_MS / 60000)} minutes — presumed dead.`,
        finishedAt: new Date(), updatedAt: new Date(),
      } });
    }

    const { insertedId } = await jobs.insertOne({
      projectId,
      status: "queued",
      progress: { discovered: 0, processed: 0, chunks: 0, failed: 0 },
      log: [],
      requestedLimit: limit ?? null,
      requestedStages: only.length ? only : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = String(insertedId);

    // Spawn the generic runner detached, cwd = journeyax-web so its dotenv +
    // relative imports resolve. Output goes to the job doc, not our stdio.
    const webAppDir = resolve(process.cwd(), "../journeyax-web");
    /* Two runners, chosen by what was asked for. `ingest-project` crawls the
     * customer's site (the full onboarding path). `run-ingest` drives the
     * config-defined pipeline stages and is the only one that accepts --only,
     * so a targeted refresh (a colour palette, a design capture) does not
     * re-crawl an entire storefront to update one field. */
    const runner = only.length ? "src/scripts/run-ingest.ts" : "src/scripts/ingest-project.ts";
    const args = ["tsx", runner, "--project", projectId, "--job", jobId];
    if (limit) args.push("--limit", String(limit));
    if (only.length) args.push("--only", only.join(","));
    const child = spawn("npx", args, { cwd: webAppDir, detached: true, stdio: "ignore", env: process.env });
    child.unref();

    return NextResponse.json({ ok: true, jobId });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "knowledge.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const url = new URL(req.url);
    const jobId = url.searchParams.get("jobId");
    const projectIdParam = url.searchParams.get("projectId");
    const jobs = await ingestJobsCollection();

    let doc: any = null;
    if (jobId) {
      // Look up by id, then enforce tenant isolation on the job's own projectId —
      // a tenant user can't read another tenant's job by guessing an ObjectId.
      doc = await jobs.findOne({ _id: new ObjectId(jobId) });
      if (doc && !tenantAllowed(auth.identity, doc.projectId)) doc = null;
    } else {
      const projectId = scopeTenant(auth.identity, projectIdParam);
      if (projectId) doc = await jobs.findOne({ projectId }, { sort: { createdAt: -1 } });
    }
    if (!doc) return NextResponse.json({ error: "job not found" }, { status: 404 });

    const { _id, ...rest } = doc as any;
    /* An ingest is the one thing that changes the catalogue and knowledge
     * figures. The moment a run finishes, drop that project's cached counts —
     * once per job, since the UI polls this endpoint. */
    const jobKey = String(_id);
    if ((doc as any).status === 'completed' && !settledJobs.has(jobKey)) {
      settledJobs.add(jobKey);
      await invalidateProject((doc as any).projectId);
    }
    return NextResponse.json({ jobId: jobKey, ...rest });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
