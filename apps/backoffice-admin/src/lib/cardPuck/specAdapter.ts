/**
 * json-render Spec ↔ Puck Data.
 *
 * Puck stores a nested tree (`content` + slot arrays). JourneyAX stores a flat
 * `{ root, elements }` graph with `repeat` / `visible` / `on`. This adapter is
 * the only place those two shapes meet — Mongo and the storefront never see Puck.
 */
import type { Spec } from "@json-render/core";

/** Same set as LAYOUT_PRIMITIVE_NAMES in ui-cards/react — kept here so the adapter stays React-free. */
const LAYOUT_PRIMITIVE_NAMES = ["Box", "Card", "Grid"] as const;

export type PuckNode = {
  type: string;
  props: Record<string, unknown> & { id?: string };
};

export type PuckData = {
  root: { props: Record<string, unknown> };
  content: PuckNode[];
};

const LAYOUT = new Set<string>(LAYOUT_PRIMITIVE_NAMES);
const SLOT_NAMES: Record<string, string[]> = { Card: ["header", "footer"] };

const EDITOR_KEYS = new Set([
  "id", "jxId", "jxRepeat", "jxVisible", "jxOn", "jxWatch",
  "jxChildren", "jxHeader", "jxFooter",
]);

export const EMPTY_PUCK_DATA: PuckData = { root: { props: {} }, content: [] };

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function isIdent(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(s);
}

function slugType(type: string): string {
  return type ? type.charAt(0).toLowerCase() + type.slice(1) : "el";
}

function cleanProps(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (EDITOR_KEYS.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function elementToNode(spec: Spec, key: string, seen: Set<string>): PuckNode {
  if (seen.has(key)) {
    return { type: "Box", props: { id: `jx-${key}`, jxId: key } };
  }
  seen.add(key);
  const el = spec.elements[key];
  if (!el || typeof el !== "object") {
    return { type: "Box", props: { id: `jx-${key}`, jxId: key } };
  }
  const type = typeof el.type === "string" ? el.type : "Box";
  const props: Record<string, unknown> = {
    ...clone(el.props || {}),
    id: `jx-${key}`,
    jxId: key,
  };
  if (el.repeat) props.jxRepeat = clone(el.repeat);
  if (el.visible !== undefined) props.jxVisible = clone(el.visible);
  if (el.on) props.jxOn = clone(el.on);
  if (el.watch) props.jxWatch = clone(el.watch);

  const childKeys = Array.isArray(el.children) ? el.children : [];
  if (LAYOUT.has(type) || childKeys.length) {
    props.jxChildren = childKeys.map((c) => elementToNode(spec, String(c), seen));
  }
  for (const slot of SLOT_NAMES[type] || []) {
    const puckKey = slot === "header" ? "jxHeader" : slot === "footer" ? "jxFooter" : `jxSlot_${slot}`;
    const ids = el.slots?.[slot];
    props[puckKey] = Array.isArray(ids) ? ids.map((c) => elementToNode(spec, String(c), seen)) : [];
  }
  return { type, props };
}

export function specToPuckData(spec: Spec | null | undefined): PuckData {
  if (!spec || typeof spec !== "object" || !spec.root || !spec.elements) return EMPTY_PUCK_DATA;
  const rootEl = spec.elements[spec.root];
  if (!rootEl) return EMPTY_PUCK_DATA;
  return {
    root: { props: {} },
    content: [elementToNode(spec, spec.root, new Set())],
  };
}

function allocId(preferred: string | undefined, type: string, used: Set<string>): string {
  const base = preferred && isIdent(preferred) ? preferred : slugType(type);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n++}`;
  }
  used.add(id);
  return id;
}

function walkNode(node: PuckNode, elements: Spec["elements"], used: Set<string>): string {
  const type = typeof node?.type === "string" ? node.type : "Box";
  const raw = (node?.props && typeof node.props === "object") ? node.props : {};
  const id = allocId(
    typeof raw.jxId === "string" ? raw.jxId : undefined,
    type,
    used,
  );
  const childNodes = Array.isArray(raw.jxChildren) ? (raw.jxChildren as PuckNode[]) : [];
  const headerNodes = Array.isArray(raw.jxHeader) ? (raw.jxHeader as PuckNode[]) : [];
  const footerNodes = Array.isArray(raw.jxFooter) ? (raw.jxFooter as PuckNode[]) : [];
  const children = childNodes.map((c) => walkNode(c, elements, used));
  const slots: Record<string, string[]> = {};
  if (headerNodes.length) slots.header = headerNodes.map((c) => walkNode(c, elements, used));
  if (footerNodes.length) slots.footer = footerNodes.map((c) => walkNode(c, elements, used));

  const el: Spec["elements"][string] = {
    type,
    props: cleanProps(raw),
  };
  if (children.length || LAYOUT.has(type)) el.children = children;
  if (Object.keys(slots).length) el.slots = slots;
  if (raw.jxRepeat && typeof raw.jxRepeat === "object") el.repeat = clone(raw.jxRepeat) as Spec["elements"][string]["repeat"];
  if (raw.jxVisible !== undefined && raw.jxVisible !== null && raw.jxVisible !== "") {
    el.visible = clone(raw.jxVisible) as Spec["elements"][string]["visible"];
  }
  if (raw.jxOn && typeof raw.jxOn === "object" && Object.keys(raw.jxOn as object).length) {
    el.on = clone(raw.jxOn) as Spec["elements"][string]["on"];
  }
  if (raw.jxWatch && typeof raw.jxWatch === "object") {
    el.watch = clone(raw.jxWatch) as Spec["elements"][string]["watch"];
  }
  elements[id] = el;
  return id;
}

export function puckDataToSpec(data: PuckData | null | undefined): Spec {
  const elements: Spec["elements"] = {};
  const used = new Set<string>();
  const content = Array.isArray(data?.content) ? data!.content : [];
  if (!content.length) {
    elements.root = { type: "Box", props: {}, children: [] };
    return { root: "root", elements };
  }
  if (content.length === 1) {
    const root = walkNode(content[0], elements, used);
    return { root, elements };
  }
  const childIds = content.map((n) => walkNode(n, elements, used));
  let rootId = "root";
  let n = 2;
  while (used.has(rootId)) rootId = `root-${n++}`;
  used.add(rootId);
  elements[rootId] = { type: "Box", props: { gap: "md" }, children: childIds };
  return { root: rootId, elements };
}

/** Drop empty children / undefined extras so round-trip compares stay honest. */
export function canonicalizeSpec(spec: Spec): Spec {
  const elements: Spec["elements"] = {};
  for (const [key, el] of Object.entries(spec.elements || {})) {
    if (!el || typeof el !== "object") continue;
    const next: Spec["elements"][string] = {
      type: el.type,
      props: cleanProps((el.props || {}) as Record<string, unknown>),
    };
    if (Array.isArray(el.children) && el.children.length) next.children = el.children;
    if (el.slots && Object.keys(el.slots).length) next.slots = el.slots;
    if (el.repeat) next.repeat = el.repeat;
    if (el.visible !== undefined) next.visible = el.visible;
    if (el.on) next.on = el.on;
    if (el.watch) next.watch = el.watch;
    elements[key] = next;
  }
  return { root: spec.root, elements };
}
