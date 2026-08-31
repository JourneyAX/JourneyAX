"use client";

/**
 * Hand-rolled SVG line chart — no charting library.
 *
 * Kept deliberately tiny: this repo has no chart dependency and shouldn't
 * gain one for a single trend line. Matches the dark/yellow theme and the
 * plain-<div>-bars style already used for the funnel/intent panels.
 */
import React, { useState } from "react";

export interface LinePoint {
  /** X-axis label, e.g. an ISO date "2026-08-24" or a short day label. */
  label: string;
  value: number;
}

export function LineChart({
  points,
  height = 140,
  color = "var(--jx-yellow)",
  formatValue = (v: number) => v.toLocaleString(),
  formatLabel = (l: string) => l,
}: {
  points: LinePoint[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
  formatLabel?: (l: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 100; // viewBox units; scales via CSS width:100%
  const padTop = 10;
  const padBottom = 18;
  const plotH = height - padTop - padBottom;

  if (points.length === 0) {
    return <div className="role" style={{ padding: "20px 0", textAlign: "center" }}>No data yet.</div>;
  }

  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: points.length > 1 ? i * stepX : width / 2,
    y: padTop + plotH - (p.value / max) * plotH,
    ...p,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${padTop + plotH} L ${coords[0].x} ${padTop + plotH} Z`;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block", overflow: "visible" }}>
        {/* baseline */}
        <line x1={0} y1={padTop + plotH} x2={width} y2={padTop + plotH} stroke="var(--jx-gray-200)" strokeWidth={0.5} />
        <path d={areaPath} fill={color} opacity={0.12} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {coords.map((c, i) => (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={hover === i ? 2.6 : 1.6}
            fill={hover === i ? color : "var(--jx-white, #fff)"}
            stroke={color}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            style={{ cursor: "pointer" }}
          />
        ))}
      </svg>
      <div className="between" style={{ marginTop: 2 }}>
        <span className="role" style={{ fontSize: 10 }}>{formatLabel(points[0].label)}</span>
        <span className="role" style={{ fontSize: 10 }}>{formatLabel(points[points.length - 1].label)}</span>
      </div>
      {hover !== null && (
        <div
          className="panel"
          style={{
            position: "absolute",
            top: -6,
            left: `${(coords[hover].x / width) * 100}%`,
            transform: "translate(-50%, -100%)",
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 5,
            boxShadow: "0 2px 10px rgba(0,0,0,.15)",
          }}
        >
          {formatLabel(points[hover].label)} — {formatValue(points[hover].value)}
        </div>
      )}
    </div>
  );
}
