"use client";

/**
 * Hand-rolled SVG horizontal bar chart — no charting library.
 * Same intent as LineChart.tsx: small, dependency-free, theme-matched.
 */
import React from "react";

export interface BarDatum {
  label: string;
  value: number;
  /** Optional bar color override (defaults to theme yellow). */
  color?: string;
}

export function BarChart({
  data,
  barHeight = 18,
  gap = 10,
  formatValue = (v: number) => v.toLocaleString(),
}: {
  data: BarDatum[];
  barHeight?: number;
  gap?: number;
  formatValue?: (v: number) => string;
}) {
  if (data.length === 0) {
    return <div className="role" style={{ padding: "20px 0", textAlign: "center" }}>No data yet.</div>;
  }

  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {data.map((d, i) => {
        const pct = Math.round((d.value / max) * 100);
        return (
          <div key={i}>
            <div className="between" style={{ fontSize: 12, marginBottom: 3 }}>
              <span>{d.label}</span>
              <b>{formatValue(d.value)}</b>
            </div>
            <svg viewBox={`0 0 100 ${barHeight}`} preserveAspectRatio="none" style={{ width: "100%", height: barHeight, display: "block" }}>
              <rect x={0} y={0} width={100} height={barHeight} rx={barHeight / 2.4} fill="var(--jx-gray-200)" />
              <rect x={0} y={0} width={pct} height={barHeight} rx={barHeight / 2.4} fill={d.color || "var(--jx-yellow)"} />
            </svg>
          </div>
        );
      })}
    </div>
  );
}
