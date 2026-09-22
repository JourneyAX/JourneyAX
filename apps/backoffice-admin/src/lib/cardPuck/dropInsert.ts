/**
 * The json-render spec is the source of truth for which elements exist and
 * where they are allowed to sit. A Price that lives in the product card can
 * only be dropped back inside that card, and it returns to its original slot.
 */
import type { PuckData, PuckNode } from "./specAdapter";

const LAYOUT = new Set(["Box", "Card", "Grid"]);
const SLOT_KEYS = ["jxChildren", "jxHeader", "jxFooter"] as const;

export type SchemaElement = {
  key: string;
  type: string;
  label: string;
  /** Container the pointer must be inside. The nearest Card, or the direct parent. */
  homeKey: string;
  parentKey: string;
  slot: (typeof SLOT_KEYS)[number];
  /** Original sibling keys, this element included, in schema order. */
  order: string[];
  props: Record<string, unknown>;
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 32 ? `${t.slice(0, 29)}…` : t;
}

function labelFor(type: string, props: Record<string, unknown>): string {
  const raw = props.label ?? props.text;
  if (typeof raw === "string" && raw.trim()) return clip(raw);
  if (raw && typeof raw === "object" && typeof (raw as { $template?: string }).$template === "string") {
    const plain = (raw as { $template: string }).$template.replace(/\$\{[^}]+\}/g, "").replace(/\s+/g, " ").trim();
    if (plain) return clip(plain);
  }
  if (type === "Text" && raw && typeof raw === "object") {
    const path = (raw as { $item?: string; $state?: string }).$item
      || (raw as { $state?: string }).$state
      || "";
    if (path) return clip(String(path).replace(/^\//, ""));
  }
  return type;
}

function walkNodes(list: PuckNode[] | undefined, visit: (node: PuckNode) => void) {
  for (const node of list || []) {
    if (!node) continue;
    visit(node);
    for (const slot of SLOT_KEYS) {
      const kids = node.props?.[slot];
      if (Array.isArray(kids)) walkNodes(kids as PuckNode[], visit);
    }
  }
}

/** Content elements from the loaded spec, each pinned to the container it belongs in. */
export function schemaElements(content: PuckData["content"]): SchemaElement[] {
  const out: SchemaElement[] = [];
  const visit = (
    list: PuckNode[],
    parentKey: string | null,
    slot: (typeof SLOT_KEYS)[number],
    ancestors: { key: string; type: string }[],
  ) => {
    const order = (list || []).map((node) => String(node?.props?.jxId || "")).filter(Boolean);
    for (const node of list || []) {
      const key = node?.props?.jxId;
      if (typeof key !== "string" || !key) continue;
      const card = [...ancestors].reverse().find((a) => a.type === "Card");
      const homeKey = card?.key || parentKey;
      if (parentKey && homeKey && !LAYOUT.has(node.type)) {
        const props = clone(node.props || {});
        delete props.id;
        delete props.jxId;
        for (const s of SLOT_KEYS) delete props[s];
        out.push({
          key,
          type: node.type,
          label: labelFor(node.type, props),
          homeKey,
          parentKey,
          slot,
          order,
          props,
        });
      }
      const next = [...ancestors, { key, type: node.type }];
      for (const s of SLOT_KEYS) {
        const kids = node.props?.[s];
        if (Array.isArray(kids)) visit(kids as PuckNode[], key, s, next);
      }
    }
  };
  visit(content || [], null, "jxChildren", []);
  const seen = new Map<string, number>();
  for (const el of out) seen.set(el.label, (seen.get(el.label) || 0) + 1);
  return out.map((el) => seen.get(el.label)! > 1 ? { ...el, label: `${el.label} · ${el.type}` } : el);
}

function findNode(list: PuckNode[] | undefined, key: string): PuckNode | null {
  for (const node of list || []) {
    if (node?.props?.jxId === key) return node;
    for (const slot of SLOT_KEYS) {
      const kids = node?.props?.[slot];
      if (Array.isArray(kids)) {
        const hit = findNode(kids as PuckNode[], key);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Put a removed schema element back in its original slot. No-op if it is already there or its parent is gone. */
export function restoreElement(data: PuckData, element: SchemaElement): PuckData | null {
  if (findNode(data.content, element.key)) return null;
  const next = clone(data);
  const parent = findNode(next.content, element.parentKey);
  if (!parent) return null;
  const kids = Array.isArray(parent.props[element.slot]) ? (parent.props[element.slot] as PuckNode[]) : [];
  const node: PuckNode = {
    type: element.type,
    props: { ...clone(element.props), id: `jx-${element.key}`, jxId: element.key },
  };
  const mine = element.order.indexOf(element.key);
  let at = kids.length;
  if (mine >= 0) {
    for (let i = 0; i < kids.length; i++) {
      const idx = element.order.indexOf(String(kids[i]?.props?.jxId || ""));
      if (idx > mine) {
        at = i;
        break;
      }
    }
  }
  kids.splice(at, 0, node);
  parent.props[element.slot] = kids;
  return next;
}

export function hasElement(content: PuckData["content"], key: string): boolean {
  return findNode(content, key) != null;
}
