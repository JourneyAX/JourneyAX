"use client";

import React, { useEffect, useMemo, useState } from "react";
import { PlusCircle, RotateCcw, Save, SearchCheck, Trash2 } from "lucide-react";
import { catalogMappingApi, projectApi, type MappingCheck, type Project } from "../../lib/api";
import { MappingCheckReport } from "./MappingCheckReport";
import {
  GROUP_LABELS, LIST_FIELDS, MEANINGS, emptyPriceSource, fromMapping, toMapping, assignFieldMeaning, validateForm,
  type FieldMeaning, type MappingForm, type MappingGroup,
} from "./catalog-mapping-form";

const GROUP_ORDER: MappingGroup[] = ["identity", "category", "pricing", "stock", "lifecycle", "attributes", "advanced"];
const fieldStyle: React.CSSProperties = { display: "grid", gap: 2 };
const errorStyle: React.CSSProperties = { color: "var(--jx-destructive)", fontSize: 12 };

const get = (mapping: any, key: string): unknown => key.split(".").reduce((value: any, part) => (value == null ? undefined : value[part]), mapping);
const asText = (value: unknown) => (Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value));

export interface MappingFormApi {
  state: typeof catalogMappingApi.state;
  check: typeof catalogMappingApi.check;
  save: (projectId: string, mapping: Record<string, any> | null) => Promise<unknown>;
}

const liveApi: MappingFormApi = {
  state: catalogMappingApi.state,
  check: catalogMappingApi.check,
  save: (projectId, mapping) => projectApi.update(projectId, { catalogMapping: mapping } as any),
};

/**
 * Guided editor for the catalogue mapping: which of a tenant's product fields hold the code, name, price, currency, stock,
 * category and lifecycle. It validates as you type, shows what your products really contain, and checks the mapping against
 * a spread of real products before it can be saved.
 */
export function CatalogMappingForm({
  project, onSaved, api = liveApi, initial,
}: {
  project: Pick<Project, "projectId" | "catalogMapping">;
  onSaved?: () => void;
  api?: MappingFormApi;
  /** Supplied by tests or a parent that already has them; otherwise loaded from the service. */
  initial?: { defaults?: Record<string, any>; check?: MappingCheck | null; mapping?: Record<string, any> | null };
}) {
  const [form, setForm] = useState<MappingForm>(() => fromMapping((initial?.mapping !== undefined ? initial.mapping : project.catalogMapping) as any));
  const [defaults, setDefaults] = useState<Record<string, any>>(initial?.defaults ?? {});
  const [check, setCheck] = useState<MappingCheck | null>(initial?.check ?? null);
  const [checkedFor, setCheckedFor] = useState<string | null>(initial?.check ? JSON.stringify(toMapping(fromMapping((initial?.mapping !== undefined ? initial.mapping : project.catalogMapping) as any))) : null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, FieldMeaning>>({});

  useEffect(() => {
    if (initial?.defaults) return;
    let cancelled = false;
    api.state(project.projectId).then((state) => { if (!cancelled) setDefaults(state.defaults); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [project.projectId, api, initial?.defaults]);

  const errors = useMemo(() => validateForm(form), [form]);
  const mapping = useMemo(() => toMapping(form), [form]);
  const signature = JSON.stringify(mapping);
  const stale = check !== null && checkedFor !== signature;
  const hasErrors = Object.keys(errors).length > 0;
  // Saving needs a current check without errors; a catalogue with no products to check against is allowed through.
  const canSave = !hasErrors && check !== null && !stale && check.ok;
  const unchanged = signature === JSON.stringify(toMapping(fromMapping(project.catalogMapping as any)));

  const update = (change: (draft: MappingForm) => MappingForm | void) => setForm((current) => {
    const draft = structuredClone(current);
    return change(draft) ?? draft;
  });

  async function runCheck() {
    setBusy("check"); setMessage(null);
    try {
      const result = await api.check(project.projectId, mapping);
      setCheck(result); setCheckedFor(signature);
    } catch (error: any) {
      setMessage({ tone: "bad", text: error.message || String(error) });
    } finally { setBusy(null); }
  }

  async function save(value: Record<string, any> | null) {
    setBusy("save"); setMessage(null);
    try {
      await api.save(project.projectId, value);
      setMessage({ tone: "ok", text: value === null ? "Reverted to platform defaults. It takes effect on the next Business Pack publish." : "Saved. It takes effect on the next Business Pack publish." });
      onSaved?.();
    } catch (error: any) {
      setMessage({ tone: "bad", text: error.message || String(error) });
    } finally { setBusy(null); }
  }

  function applyRaw() {
    try {
      const parsed = JSON.parse(rawText ?? "");
      setForm(fromMapping(parsed));
      setRawText(null);
      setMessage({ tone: "ok", text: "JSON applied to the form. Check it before saving." });
    } catch {
      setMessage({ tone: "bad", text: "That is not valid JSON." });
    }
  }

  const placeholder = (key: string) => {
    const value = asText(get(defaults, key));
    return value ? `Platform default: ${value}` : "Platform default";
  };
  const input = (id: string, label: string, value: string, onChange: (value: string) => void, extra: { help?: string; placeholder?: string } = {}) => (
    <div style={fieldStyle}>
      <label htmlFor={id} style={{ fontWeight: 600, fontSize: 12.5 }}>{label}</label>
      <input id={id} className="inp" value={value} placeholder={extra.placeholder} aria-invalid={errors[id] ? true : undefined} aria-describedby={errors[id] ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)} />
      {extra.help && <span className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-500)" }}>{extra.help}</span>}
      {errors[id] && <span id={`${id}-error`} role="alert" style={errorStyle}>{errors[id]}</span>}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {message && <div className="node" role="status" style={{ borderColor: message.tone === "ok" ? "#52c41a" : "var(--jx-destructive)" }}>{message.text}</div>}

      {GROUP_ORDER.map((group) => {
        const fields = LIST_FIELDS.filter((field) => field.group === group);
        if (fields.length === 0 && group !== "pricing" && group !== "attributes" && group !== "advanced") return null;
        return (
          <fieldset key={group} style={{ border: "1px solid var(--jx-gray-200)", borderRadius: 10, padding: "10px 12px", display: "grid", gap: 10 }}>
            <legend style={{ fontWeight: 700, padding: "0 6px" }}>{GROUP_LABELS[group].title}</legend>
            <p className="micro" style={{ textTransform: "none", letterSpacing: 0, margin: 0, color: "var(--jx-gray-600)" }}>{GROUP_LABELS[group].help}</p>

            {fields.map((field) => (
              <React.Fragment key={field.key}>
                {input(field.key, field.label, form.lists[field.key], (value) => update((draft) => { draft.lists[field.key] = value; }), { help: field.help, placeholder: placeholder(field.key) })}
              </React.Fragment>
            ))}

            {group === "pricing" && (
              <>
                {form.priceSources.length === 0 && <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>No price source set: the platform defaults are used ({asText((defaults.pricing?.sources ?? []).map((source: any) => source.path))}).</div>}
                {form.priceSources.map((source, index) => {
                  const at = `priceSources.${index}`;
                  return (
                    <div key={index} className="node" style={{ display: "grid", gap: 8 }} role="group" aria-label={`Price source ${index + 1}`}>
                      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
                        {input(`${at}.path`, "Price field", source.path, (value) => update((draft) => { draft.priceSources[index].path = value; }), { placeholder: "e.g. price.amount" })}
                        <div style={fieldStyle}>
                          <label htmlFor={`${at}.unit`} style={{ fontWeight: 600, fontSize: 12.5 }}>Unit</label>
                          <select id={`${at}.unit`} className="inp" value={source.unit} aria-invalid={errors[`${at}.unit`] ? true : undefined}
                            onChange={(event) => update((draft) => { draft.priceSources[index].unit = event.target.value as any; })}>
                            <option value="">Choose…</option><option value="major">Whole currency units (12.50)</option><option value="minor">Cents (1250)</option>
                          </select>
                          {errors[`${at}.unit`] && <span role="alert" style={errorStyle}>{errors[`${at}.unit`]}</span>}
                        </div>
                        {input(`${at}.rangeKey`, "Range key", source.rangeKey, (value) => update((draft) => { draft.priceSources[index].rangeKey = value; }), { placeholder: "e.g. min", help: "When the field is an object like {min, max}." })}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
                        <div style={fieldStyle}>
                          <label htmlFor={`${at}.mode`} style={{ fontWeight: 600, fontSize: 12.5 }}>Currency is…</label>
                          <select id={`${at}.mode`} className="inp" value={source.currencyMode} onChange={(event) => update((draft) => { draft.priceSources[index].currencyMode = event.target.value as any; })}>
                            <option value="field">Declared on each product</option><option value="fixed">The same for every product</option><option value="none">Not declared</option>
                          </select>
                        </div>
                        {source.currencyMode === "field" && input(`${at}.currencyPath`, "Currency field", source.currencyPath, (value) => update((draft) => { draft.priceSources[index].currencyPath = value; }), { placeholder: "e.g. currency" })}
                        {source.currencyMode === "fixed" && input(`${at}.currency`, "Currency code", source.currency, (value) => update((draft) => { draft.priceSources[index].currency = value; }), { placeholder: "e.g. NZD", help: "State it only if this feed is entirely in one currency." })}
                        {source.currencyMode === "none" && <p className="micro" style={{ textTransform: "none", letterSpacing: 0, margin: 0, color: "var(--jx-destructive)" }}>Without a declared currency these prices are never quoted to customers.</p>}
                      </div>
                      <div><button type="button" className="btn" onClick={() => update((draft) => { draft.priceSources.splice(index, 1); })}><Trash2 size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />Remove this price source</button></div>
                    </div>
                  );
                })}
                <div className="actions">
                  <button type="button" className="btn" onClick={() => update((draft) => { draft.priceSources.push(emptyPriceSource()); })}><PlusCircle size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />Add a price source</button>
                  <label className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
                    Quote prices without a declared currency?{" "}
                    <select className="inp" aria-label="Quote prices without a declared currency" value={form.requireDeclaredCurrency} onChange={(event) => update((draft) => { draft.requireDeclaredCurrency = event.target.value as any; })}>
                      <option value="">Platform default (never)</option><option value="yes">Never</option><option value="no">Yes, if the source states none</option>
                    </select>
                  </label>
                </div>
              </>
            )}

            {group === "attributes" && (
              <div style={{ display: "grid", gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>Attribute names customers use → fields that hold them</b>
                {form.attributeAliases.map((entry, index) => (
                  <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 8, alignItems: "end" }}>
                    {input(`attributeAliases.${index}.key`, "Attribute", entry.key, (value) => update((draft) => { draft.attributeAliases[index].key = value; }), { placeholder: "e.g. toeType" })}
                    {input(`attributeAliases.${index}.aliases`, "Held in", entry.aliases, (value) => update((draft) => { draft.attributeAliases[index].aliases = value; }), { placeholder: "e.g. toeProtection, toe_cap" })}
                    <button type="button" className="btn" aria-label={`Remove attribute ${index + 1}`} onClick={() => update((draft) => { draft.attributeAliases.splice(index, 1); })}><Trash2 size={13} aria-hidden="true" /></button>
                  </div>
                ))}
                <div><button type="button" className="btn" onClick={() => update((draft) => { draft.attributeAliases.push({ key: "", aliases: "" }); })}><PlusCircle size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />Add an attribute</button></div>
              </div>
            )}

            {group === "advanced" && input("candidateLimit", "Products considered per search", form.candidateLimit, (value) => update((draft) => { draft.candidateLimit = value; }), { placeholder: placeholder("candidateLimit"), help: "A whole number from 1 to 1000." })}
          </fieldset>
        );
      })}

      <div className="actions" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={runCheck} disabled={busy !== null || hasErrors}><SearchCheck size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />Check against my catalogue</button>
        <button type="button" className="btn y" onClick={() => save(mapping)} disabled={busy !== null || !canSave || unchanged}><Save size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />Save mapping</button>
        <button type="button" className="btn" onClick={() => { setForm(fromMapping(null)); setCheck(null); setCheckedFor(null); save(null); }} disabled={busy !== null}><RotateCcw size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />Use platform defaults</button>
      </div>
      {!canSave && (
        <p className="micro" style={{ textTransform: "none", letterSpacing: 0, margin: 0 }}>
          {hasErrors ? "Fix the highlighted fields first." : unchanged ? "No changes to save." : check === null ? "Check the mapping against your catalogue to enable saving." : stale ? "The mapping changed since the last check — check it again." : "Fix the problems in the check before saving."}
        </p>
      )}

      {check && <MappingCheckReport check={check} stale={stale} />}

      {check && check.fields.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Fields found on your products ({check.fields.length})</summary>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)" }}>Choose what a field means to add it to the mapping above.</p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Field", "Type", "On", "Example", "This field is…"].map((title) => <th key={title} scope="col" style={{ padding: "3px 6px", textAlign: "left", fontSize: 11 }}>{title}</th>)}</tr></thead>
            <tbody>
              {check.fields.map((field) => (
                <tr key={field.path}>
                  <th scope="row" style={{ padding: "3px 6px", textAlign: "left", fontWeight: 600, fontSize: 12 }}>{field.path}</th>
                  <td style={{ padding: "3px 6px", fontSize: 12 }}>{field.type}</td>
                  <td style={{ padding: "3px 6px", fontSize: 12 }}>{Math.round(field.seen * 100)}%</td>
                  <td style={{ padding: "3px 6px", fontSize: 12, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{field.example}</td>
                  <td style={{ padding: "3px 6px" }}>
                    <select className="inp" aria-label={`What ${field.path} means`} value={pick[field.path] ?? ""} onChange={(event) => {
                      const meaning = event.target.value as FieldMeaning;
                      setPick((current) => ({ ...current, [field.path]: meaning }));
                      if (meaning) { setForm((current) => assignFieldMeaning(current, field.path, meaning)); setPick((current) => ({ ...current, [field.path]: "" as any })); }
                    }}>
                      <option value="">Choose…</option>
                      {MEANINGS.map((meaning) => <option key={meaning.value} value={meaning.value}>{meaning.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700 }} onClick={() => setRawText((current) => (current === null ? JSON.stringify(mapping ?? {}, null, 2) : null))}>Advanced: edit as JSON</summary>
        {rawText !== null && (
          <>
            <textarea className="inp" aria-label="Catalogue mapping JSON" style={{ width: "100%", minHeight: 160, fontFamily: "monospace", fontSize: 11 }} value={rawText} onChange={(event) => setRawText(event.target.value)} />
            <div className="actions" style={{ marginTop: 6 }}><button type="button" className="btn" onClick={applyRaw}>Apply to the form</button></div>
          </>
        )}
      </details>
    </div>
  );
}
