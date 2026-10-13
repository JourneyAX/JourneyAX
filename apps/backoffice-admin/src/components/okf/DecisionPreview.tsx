"use client";

import React from "react";
import { ShieldAlert } from "lucide-react";
import type { LiveProducts } from "../../lib/api";
import { COMMERCE_COPY, MODE_COPY, count, formatMoney } from "./insight-model";

const cell: React.CSSProperties = { padding: "3px 6px", textAlign: "left", borderBottom: "1px solid var(--jx-gray-200)", fontSize: 12 };

function ProductSample({ live }: { live: LiveProducts }) {
  if (live.sample.length === 0) return null;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
      <thead><tr><th scope="col" style={cell}>Code</th><th scope="col" style={cell}>Name</th><th scope="col" style={cell}>Price</th></tr></thead>
      <tbody>
        {live.sample.map((product) => (
          <tr key={product.sku}><td style={cell}>{product.sku}</td><td style={cell}>{product.title}</td><td style={cell}>{formatMoney(product.priceCents, product.currency)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * "What would the assistant use for this message?" — the knowledge decision, in plain words, with the live products behind
 * each scope. It shows what the service computed; it decides nothing itself.
 */
export function DecisionPreview({ preview, onAnswer }: { preview: any; onAnswer?: (factKey: string, value: string) => void }) {
  if (!preview) return null;
  if (preview.previewable === false) {
    return <div className="node" style={{ marginTop: 10 }}><b>Blocked</b><div className="micro">The draft must validate before it can be previewed.</div></div>;
  }
  const decision = preview.decision;
  const live = preview.live ?? { scope: null, groups: [], suggestions: [] };
  const blocked = decision.retrieval?.permission !== "allowed";
  const claims: string[] = decision.claims?.allowedClasses ?? [];
  const disclaimers: string[] = decision.claims?.disclaimers ?? [];
  return (
    <div className="node" style={{ marginTop: 10, display: "grid", gap: 8 }} aria-label="What the assistant would use">
      <div className="between">
        <b>{preview.conceptName || "No concept matched"}</b>
        <span className={`pill ${blocked ? "p-draft" : "p-active"}`}>{decision.mode}</span>
      </div>
      <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{MODE_COPY[decision.mode] ?? ""}</div>

      {decision.safety?.blocksProducts && (
        <div style={{ color: "var(--jx-destructive)", fontSize: 12.5 }}>
          <ShieldAlert size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />
          Products and checkout are paused{decision.safety.guidanceUnavailable ? "; no verified guidance exists, so the customer is referred to a qualified professional." : "."}
        </div>
      )}

      {decision.clarification && (
        <div>
          <div className="micro">Then asks</div>
          <div>{decision.clarification.question}</div>
          <div className="actions" style={{ flexWrap: "wrap", marginTop: 4, gap: 6 }}>
            {decision.clarification.options.map((option: { value: string; label: string }) => onAnswer
              ? <button key={option.value} className="btn" type="button" onClick={() => onAnswer(decision.clarification.factKey, option.value)}>{option.label}</button>
              : <span key={option.value} className="pill p-offline">{option.label}</span>)}
          </div>
        </div>
      )}

      {live.scope && (
        <div>
          <div className="micro">Products it would draw from</div>
          <div><b>{count(live.scope.products)}</b> listed product{live.scope.products === 1 ? "" : "s"} in scope</div>
          <ProductSample live={live.scope} />
        </div>
      )}
      {live.groups.length > 0 && (
        <div>
          <div className="micro">Examples shown from each category</div>
          {live.groups.map((group: LiveProducts & { conceptId: string; label: string }) => (
            <div key={group.conceptId}>{group.label}: <b>{count(group.products)}</b>{group.products === 0 && <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}> — nothing to show</span>}</div>
          ))}
        </div>
      )}
      {!live.scope && live.groups.length === 0 && blocked && <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>No products would be retrieved.</div>}

      {live.suggestions.length > 0 && (
        <div>
          <div className="micro">{live.suggestions[0].label}</div>
          {live.suggestions.map((suggestion: LiveProducts & { conceptId: string; name: string }) => (
            <div key={suggestion.conceptId}>{suggestion.name}: <b>{count(suggestion.products)}</b></div>
          ))}
          <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{decision.suggestions?.[0]?.note}</div>
        </div>
      )}

      <div>
        <div className="micro">Basket and checkout</div>
        <div>{COMMERCE_COPY.addToCart[decision.commerce?.addToCart as keyof typeof COMMERCE_COPY.addToCart] ?? decision.commerce?.addToCart}</div>
        <div>{COMMERCE_COPY.checkout[decision.commerce?.checkout as keyof typeof COMMERCE_COPY.checkout] ?? decision.commerce?.checkout}</div>
      </div>

      <div>
        <div className="micro">May claim</div>
        <div>{claims.length ? claims.join(", ") : "Nothing beyond what the catalogue lists"}</div>
        {disclaimers.map((text) => <div key={text} className="micro" style={{ textTransform: "none", letterSpacing: 0, marginTop: 2 }}>{text}</div>)}
      </div>

      <details>
        <summary className="micro" style={{ cursor: "pointer" }}>Why</summary>
        <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
          Matched by {decision.trace?.matchedBy ?? "—"} · {(decision.trace?.reasonCodes ?? []).join(", ") || "no reason codes"} · draft revision {preview.revision}
        </div>
      </details>
    </div>
  );
}
