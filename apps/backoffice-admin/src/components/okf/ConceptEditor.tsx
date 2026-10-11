"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
import { formatList, parseList, patchConcept, type ConceptPatch } from "./okf-model";

const RISK = ["standard", "compatibility", "safety_critical"] as const;
const ADD_TO_CART = ["allowed", "allowed_with_warning", "blocked"] as const;
const CHECKOUT = ["allowed", "requires_compatibility_resolution", "requires_professional_confirmation", "blocked"] as const;
const LIFECYCLE = ["active_draft", "deprecated", "retired"] as const;
const IMPORTANCE = ["high", "medium", "low"] as const;

export function ConceptEditor({ content, busy, onSave }: { content: any; busy: boolean; onSave: (next: any) => void }) {
  const concepts: any[] = content?.concepts || [];
  const [selectedId, setSelectedId] = useState<string>(concepts[0]?.conceptId || "");
  const selected = useMemo(() => concepts.find((concept) => concept.conceptId === selectedId), [concepts, selectedId]);
  const factKeys: string[] = useMemo(() => (content?.factRegistry || []).map((fact: any) => fact.factKey), [content]);
  const [form, setForm] = useState<ConceptPatch>({});
  const [synonyms, setSynonyms] = useState("");
  const [phrases, setPhrases] = useState("");
  const [categories, setCategories] = useState("");

  useEffect(() => {
    if (!concepts.some((concept) => concept.conceptId === selectedId)) setSelectedId(concepts[0]?.conceptId || "");
  }, [concepts, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setForm({
      name: selected.name, description: selected.description, riskClass: selected.riskClass,
      compatibilitySensitive: selected.compatibilitySensitive, addToCart: selected.commercePolicy?.addToCart,
      checkout: selected.commercePolicy?.checkout, blocksProducts: selected.safety?.blocksProducts,
      lifecycleStatus: selected.lifecycle?.status, requiredFacts: selected.requiredFacts || [],
    });
    setSynonyms(formatList(selected.synonyms));
    setPhrases(formatList(selected.customerPhrases));
    setCategories(formatList(selected.searchScope?.catalogCategoryIds));
  }, [selected]);

  if (!concepts.length) return <div className="micro">No concepts yet. Import a bundle or paste a typed draft in the advanced editor.</div>;

  const set = (patch: ConceptPatch) => setForm((current) => ({ ...current, ...patch }));
  const save = () => onSave(patchConcept(content, selectedId, {
    ...form, synonyms: parseList(synonyms), customerPhrases: parseList(phrases), catalogCategoryIds: parseList(categories),
  }));
  const facts = form.requiredFacts || [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 0.6fr) minmax(0, 1.4fr)", gap: 12 }}>
      <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--jx-gray-200)", borderRadius: 8 }} role="listbox" aria-label="Concepts">
        {concepts.map((concept) => (
          <button
            key={concept.conceptId}
            role="option"
            aria-selected={concept.conceptId === selectedId}
            onClick={() => setSelectedId(concept.conceptId)}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, borderBottom: "1px solid var(--jx-gray-200)", background: concept.conceptId === selectedId ? "var(--jx-gray-100)" : "transparent", cursor: "pointer" }}
          >
            <b>{concept.name}</b>
            <span className="micro" style={{ display: "block", color: "var(--jx-gray-600)" }}>{concept.riskClass} · {concept.lens}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div style={{ display: "grid", gap: 8 }}>
          <label className="micro">Name<input className="inp" value={form.name || ""} onChange={(e) => set({ name: e.target.value })} /></label>
          <label className="micro">Description<textarea className="inp" rows={2} value={form.description || ""} onChange={(e) => set({ description: e.target.value })} /></label>
          <label className="micro">Synonyms (comma or line separated)<input className="inp" value={synonyms} onChange={(e) => setSynonyms(e.target.value)} /></label>
          <label className="micro">Customer phrases<input className="inp" value={phrases} onChange={(e) => setPhrases(e.target.value)} /></label>
          <label className="micro">Catalogue category scope<input className="inp" value={categories} onChange={(e) => setCategories(e.target.value)} /></label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label className="micro">Risk class
              <select className="inp" value={form.riskClass} onChange={(e) => set({ riskClass: e.target.value as ConceptPatch["riskClass"] })}>{RISK.map((v) => <option key={v}>{v}</option>)}</select>
            </label>
            <label className="micro">Lifecycle
              <select className="inp" value={form.lifecycleStatus} onChange={(e) => set({ lifecycleStatus: e.target.value as ConceptPatch["lifecycleStatus"] })}>{LIFECYCLE.map((v) => <option key={v}>{v}</option>)}</select>
            </label>
            <label className="micro">Add to cart
              <select className="inp" value={form.addToCart} onChange={(e) => set({ addToCart: e.target.value as ConceptPatch["addToCart"] })}>{ADD_TO_CART.map((v) => <option key={v}>{v}</option>)}</select>
            </label>
            <label className="micro">Checkout
              <select className="inp" value={form.checkout} onChange={(e) => set({ checkout: e.target.value as ConceptPatch["checkout"] })}>{CHECKOUT.map((v) => <option key={v}>{v}</option>)}</select>
            </label>
          </div>
          <label className="micro"><input type="checkbox" checked={Boolean(form.compatibilitySensitive)} onChange={(e) => set({ compatibilitySensitive: e.target.checked })} /> Compatibility-sensitive (ask before showing products)</label>
          <label className="micro"><input type="checkbox" checked={Boolean(form.blocksProducts)} onChange={(e) => set({ blocksProducts: e.target.checked })} /> Safety first — block products until guidance is satisfied</label>

          <div>
            <div className="between"><span className="micro">Required facts</span>
              <button className="btn" type="button" disabled={!factKeys.length} onClick={() => set({ requiredFacts: [...facts, { factKey: factKeys[0], importance: "medium" }] })}>Add fact</button>
            </div>
            {facts.map((fact, index) => (
              <div key={`${fact.factKey}-${index}`} style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <select className="inp" value={fact.factKey} onChange={(e) => set({ requiredFacts: facts.map((item, i) => (i === index ? { ...item, factKey: e.target.value } : item)) })}>
                  {factKeys.map((key) => <option key={key}>{key}</option>)}
                </select>
                <select className="inp" value={fact.importance} onChange={(e) => set({ requiredFacts: facts.map((item, i) => (i === index ? { ...item, importance: e.target.value as typeof IMPORTANCE[number] } : item)) })}>
                  {IMPORTANCE.map((v) => <option key={v}>{v}</option>)}
                </select>
                <button className="btn" type="button" onClick={() => set({ requiredFacts: facts.filter((_, i) => i !== index) })} aria-label="Remove fact">×</button>
              </div>
            ))}
          </div>

          <p className="micro" style={{ color: "var(--jx-gray-600)" }}>
            Saving rebinds the content hash on the server. Changing a verified concept marks its verification stale until it is re-attested.
          </p>
          <div><button className="btn y" onClick={save} disabled={busy}><Save size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Save concept</button></div>
        </div>
      )}
    </div>
  );
}
