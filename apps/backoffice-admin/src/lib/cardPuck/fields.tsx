"use client";

import React, { createContext, useContext } from "react";
import { getByPath } from "@json-render/core";
import { actions, CARD_TYPES, type CardType } from "@journeyax/ui-cards";
import type { CustomFieldRender } from "@puckeditor/core";

export const ACTION_NAMES = Object.keys(actions) as string[];

export type BindOption = { kind: "state" | "item"; path: string; label: string };

type EditorMeta = { cardType: CardType; sampleState: Record<string, unknown> };
const EditorMetaContext = createContext<EditorMeta>({ cardType: "products", sampleState: {} });
export function PuckEditorMetaProvider({ value, children }: { value: EditorMeta; children: React.ReactNode }) {
  return <EditorMetaContext.Provider value={value}>{children}</EditorMetaContext.Provider>;
}
export function usePuckEditorMeta() {
  return useContext(EditorMetaContext);
}

const RepeatCtx = createContext<unknown>(undefined);
export function RepeatScope({ item, children }: { item: unknown; children: React.ReactNode }) {
  return <RepeatCtx.Provider value={item}>{children}</RepeatCtx.Provider>;
}
export function useRepeatItem() {
  return useContext(RepeatCtx);
}

function unwrapZod(schema: any): any {
  let s = schema;
  const seen = new Set<any>();
  while (s && !seen.has(s)) {
    seen.add(s);
    const t = s.def?.type;
    if (t === "optional" || t === "default" || t === "nullable") {
      s = s.def.innerType ?? s.unwrap?.();
      continue;
    }
    break;
  }
  return s;
}

export function bindOptionsFor(cardType: CardType): BindOption[] {
  const out: BindOption[] = [];
  const seen = new Set<string>();
  const add = (opt: BindOption) => {
    const k = `${opt.kind}:${opt.path}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(opt);
  };
  const walk = (schema: any, path: string, itemMode: boolean) => {
    const s = unwrapZod(schema);
    const t = s?.def?.type;
    if (t === "object") {
      for (const [key, child] of Object.entries(s.shape || {})) {
        const next = itemMode ? (path ? `${path}.${key}` : key) : `${path}/${key}`;
        const u = unwrapZod(child);
        const ut = u?.def?.type;
        if (ut === "object") walk(u, next, itemMode);
        else if (ut === "array") {
          add({ kind: itemMode ? "item" : "state", path: next, label: next });
          const el = unwrapZod(u.def.element);
          if (el?.def?.type === "object") walk(el, "", true);
        } else {
          add({ kind: itemMode ? "item" : "state", path: next, label: next });
        }
      }
    }
  };
  walk(CARD_TYPES[cardType].state, "", false);
  return out;
}

export function isBinding(v: unknown): v is { $state?: string; $item?: string; $template?: string } {
  return !!v && typeof v === "object" && !Array.isArray(v) && ("$state" in v || "$item" in v || "$template" in v);
}

export function resolveDisplayValue(value: unknown, state: Record<string, unknown>, item: unknown): unknown {
  if (!isBinding(value)) return value;
  if (typeof value.$state === "string") {
    return getByPath(state, value.$state);
  }
  if (typeof value.$item === "string") {
    if (item && typeof item === "object") return (item as Record<string, unknown>)[value.$item];
    return undefined;
  }
  if (typeof value.$template === "string") {
    return value.$template.replace(/\$\{([^}]+)\}/g, (_m, p) => {
      const path = String(p).trim();
      const got = getByPath(state, path.startsWith("/") ? path : `/${path}`);
      return got == null ? "" : String(got);
    });
  }
  return value;
}

export function resolveDisplayProps(props: Record<string, unknown>, state: Record<string, unknown>, item: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = resolveDisplayValue(v, state, item);
  return out;
}

function repeatArray(repeat: any, state: Record<string, unknown>, parentItem: unknown): unknown[] | undefined {
  if (!repeat?.statePath) return undefined;
  const sp = repeat.statePath;
  if (typeof sp === "string") {
    const arr = getByPath(state, sp);
    return Array.isArray(arr) ? arr : undefined;
  }
  if (sp && typeof sp === "object" && typeof sp.$item === "string") {
    const src = parentItem && typeof parentItem === "object" ? (parentItem as Record<string, unknown>)[sp.$item] : undefined;
    return Array.isArray(src) ? src : undefined;
  }
  return undefined;
}

export function firstRepeatItem(repeat: any, state: Record<string, unknown>, parentItem: unknown): unknown {
  const arr = repeatArray(repeat, state, parentItem);
  return arr ? arr[0] : undefined;
}

export function repeatItems(repeat: any, state: Record<string, unknown>, parentItem: unknown): unknown[] {
  const arr = repeatArray(repeat, state, parentItem);
  if (arr && arr.length) return arr;
  return parentItem === undefined ? [] : [parentItem];
}

function FieldShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="puck-jx-field">
      <div className="puck-jx-field-label">{label}</div>
      {children}
    </div>
  );
}

function encodeBind(v: unknown): { mode: string; text: string } {
  if (isBinding(v)) {
    if (typeof v.$state === "string") return { mode: `state:${v.$state}`, text: "" };
    if (typeof v.$item === "string") return { mode: `item:${v.$item}`, text: "" };
    if (typeof v.$template === "string") return { mode: "template", text: v.$template };
  }
  if (v === undefined || v === null) return { mode: "literal", text: "" };
  if (typeof v === "object") return { mode: "literal", text: JSON.stringify(v) };
  return { mode: "literal", text: String(v) };
}

function decodeBind(mode: string, text: string, previous: unknown): unknown {
  if (mode === "literal") {
    if (typeof previous === "number") {
      const n = Number(text);
      return Number.isFinite(n) && text.trim() !== "" ? n : text;
    }
    if (typeof previous === "boolean") return text === "true";
    if (Array.isArray(previous)) {
      try { return JSON.parse(text); } catch { return previous; }
    }
    return text;
  }
  if (mode === "template") return { $template: text };
  if (mode.startsWith("state:")) return { $state: mode.slice(6) };
  if (mode.startsWith("item:")) return { $item: mode.slice(5) };
  return text;
}

export const BindField: CustomFieldRender<unknown> = ({ value, onChange, name }) => {
  const { cardType } = usePuckEditorMeta();
  const opts = bindOptionsFor(cardType);
  const enc = encodeBind(value);
  return (
    <FieldShell label={name}>
      <select
        className="field puck-jx-select"
        value={enc.mode}
        onChange={(e) => onChange(decodeBind(e.target.value, enc.text, value))}
      >
        <option value="literal">Literal</option>
        <option value="template">Template</option>
        {opts.filter((o) => o.kind === "state").map((o) => (
          <option key={`s-${o.path}`} value={`state:${o.path}`}>{o.path}</option>
        ))}
        {opts.filter((o) => o.kind === "item").map((o) => (
          <option key={`i-${o.path}`} value={`item:${o.path}`}>item.{o.path}</option>
        ))}
      </select>
      {(enc.mode === "literal" || enc.mode === "template") && (
        <input
          className="field"
          data-testid={enc.mode === "literal" ? "bind-literal" : "bind-template"}
          value={enc.text}
          onChange={(e) => onChange(decodeBind(enc.mode, e.target.value, value))}
        />
      )}
    </FieldShell>
  );
};

export const RepeatField: CustomFieldRender<any> = ({ value, onChange }) => {
  const { cardType } = usePuckEditorMeta();
  const opts = bindOptionsFor(cardType).filter((o) => o.kind === "state" || o.kind === "item");
  const sp = value?.statePath;
  const mode = !sp ? "off" : typeof sp === "string" ? `state:${sp}` : sp?.$item ? `item:${sp.$item}` : "off";
  return (
    <FieldShell label="Repeat">
      <select
        className="field puck-jx-select"
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "off") onChange(undefined);
          else if (v.startsWith("state:")) onChange({ statePath: v.slice(6), key: value?.key || "" });
          else onChange({ statePath: { $item: v.slice(5) }, key: value?.key || "" });
        }}
      >
        <option value="off">Off</option>
        {opts.filter((o) => o.kind === "state").map((o) => (
          <option key={`s-${o.path}`} value={`state:${o.path}`}>{o.path}</option>
        ))}
        {opts.filter((o) => o.kind === "item").map((o) => (
          <option key={`i-${o.path}`} value={`item:${o.path}`}>item.{o.path}</option>
        ))}
      </select>
      {mode !== "off" && (
        <input
          className="field"
          placeholder="item key (sku, id…)"
          value={value?.key || ""}
          onChange={(e) => onChange({ ...value, key: e.target.value || undefined })}
        />
      )}
    </FieldShell>
  );
};

function parseVisible(value: unknown): { mode: string; eq?: string } {
  if (value == null || value === true || (Array.isArray(value) && value.length === 0)) return { mode: "always" };
  const first = Array.isArray(value) ? value[0] : value;
  if (first && typeof first === "object") {
    const f = first as any;
    const extra = f.eq !== undefined ? `=${String(f.eq)}` : f.neq !== undefined ? `!=${String(f.neq)}` : "";
    if (typeof f.$state === "string") return { mode: `state:${f.$state}`, eq: extra || undefined };
    if (typeof f.$item === "string") return { mode: `item:${f.$item}`, eq: extra || undefined };
  }
  return { mode: "custom" };
}

export const VisibleField: CustomFieldRender<any> = ({ value, onChange }) => {
  const { cardType } = usePuckEditorMeta();
  const opts = bindOptionsFor(cardType);
  const parsed = parseVisible(value);
  return (
    <FieldShell label="Show when">
      <select
        className="field puck-jx-select"
        value={parsed.mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "always") onChange(undefined);
          else if (v === "custom") onChange(value);
          else if (v.startsWith("state:")) onChange([{ $state: v.slice(6) }]);
          else onChange([{ $item: v.slice(5) }]);
        }}
      >
        <option value="always">Always</option>
        {opts.filter((o) => o.kind === "state").map((o) => (
          <option key={`s-${o.path}`} value={`state:${o.path}`}>{o.path} is set</option>
        ))}
        {opts.filter((o) => o.kind === "item").map((o) => (
          <option key={`i-${o.path}`} value={`item:${o.path}`}>item.{o.path} is set</option>
        ))}
        {parsed.mode === "custom" ? <option value="custom">Custom (kept)</option> : null}
      </select>
    </FieldShell>
  );
};

export const OnPressField: CustomFieldRender<any> = ({ value, onChange }) => {
  const press = value?.press;
  if (Array.isArray(press)) {
    return (
      <FieldShell label="On press">
        <div className="puck-jx-muted">Multiple actions (kept). Clear to replace.</div>
        <button type="button" className="btn" onClick={() => onChange(undefined)}>Clear</button>
      </FieldShell>
    );
  }
  const action = press?.action || "";
  return (
    <FieldShell label="On press">
      <select
        className="field puck-jx-select"
        value={action}
        onChange={(e) => {
          const a = e.target.value;
          onChange(a ? { press: { action: a, params: press?.params || {} } } : undefined);
        }}
      >
        <option value="">None</option>
        {ACTION_NAMES.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    </FieldShell>
  );
};

export const ParamsField: CustomFieldRender<any> = ({ value, onChange, name }) => {
  const { cardType } = usePuckEditorMeta();
  const opts = bindOptionsFor(cardType);
  const entries = Object.entries(value && typeof value === "object" && !isBinding(value) ? value as Record<string, unknown> : {});
  return (
    <FieldShell label={name}>
      {entries.map(([k, v], i) => {
        const enc = encodeBind(v);
        return (
          <div key={i} className="puck-jx-param-row">
            <input className="field" value={k} onChange={(e) => {
              const next = { ...(value || {}) };
              delete next[k];
              next[e.target.value || k] = v;
              onChange(next);
            }} />
            <select className="field puck-jx-select" value={enc.mode} onChange={(e) => onChange({ ...(value || {}), [k]: decodeBind(e.target.value, enc.text, v) })}>
              <option value="literal">Literal</option>
              {opts.filter((o) => o.kind === "state").map((o) => <option key={o.path} value={`state:${o.path}`}>{o.path}</option>)}
              {opts.filter((o) => o.kind === "item").map((o) => <option key={o.path} value={`item:${o.path}`}>item.{o.path}</option>)}
            </select>
            {enc.mode === "literal" && (
              <input className="field" value={enc.text} onChange={(e) => onChange({ ...(value || {}), [k]: decodeBind("literal", e.target.value, v) })} />
            )}
          </div>
        );
      })}
      <button type="button" className="btn" onClick={() => onChange({ ...(value || {}), "": "" })}>Add param</button>
    </FieldShell>
  );
};
