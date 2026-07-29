"use client";

/**
 * Platform & Ops — REAL service health (B5). Each tile is a live ping to the
 * service's own /health endpoint via /api/platform/health, refreshed every 15s.
 */
import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { authedFetch } from "../lib/authed-fetch";

interface Svc { id: string; name: string; role: string; up: boolean; status: number; latencyMs: number }

export function PlatformOps() {
  const [data, setData] = useState<{ services: Svc[]; allUp: boolean; checkedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { const r = await authedFetch("/api/platform/health"); if (r.ok) setData(await r.json()); }
    catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Platform &amp; Ops</h1>
          <p className="pagesub">Live health of every platform service — pinged directly, refreshed every 15s.</p>
        </div>
        <div className="actions">
          {data && <span className={`pill ${data.allUp ? "p-active" : "p-inactive"}`}>{data.allUp ? "All systems operational" : "Degraded"}</span>}
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{loading ? "…" : "Check now"}
          </button>
        </div>
      </div>

      <div className="cardrow3">
        {(data?.services || []).map((s) => (
          <div key={s.id} className="panel" style={{ borderColor: s.up ? "var(--jx-gray-200)" : "var(--jx-destructive)" }}>
            <div className="between">
              <b style={{ fontSize: 13.5 }}>{s.name}</b>
              <span className={`pill ${s.up ? "p-active" : "p-inactive"}`}>{s.up ? "Healthy" : "Down"}</span>
            </div>
            <span className="role">{s.role}</span>
            <span className="micro" style={{ color: "var(--jx-gray-500)" }}>
              {s.up ? `HTTP ${s.status} · ${s.latencyMs}ms` : "unreachable"}
            </span>
          </div>
        ))}
      </div>
      {data && <span className="fhelp">Last checked {new Date(data.checkedAt).toLocaleTimeString()}.</span>}
    </>
  );
}
