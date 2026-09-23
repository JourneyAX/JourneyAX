"use client";

import React from "react";
import type { Config } from "@puckeditor/core";
import { primitives } from "@journeyax/ui-cards";
import { LAYOUT_PRIMITIVE_NAMES, PrimitiveView } from "@journeyax/ui-cards/react";
import { RepeatScope, firstRepeatItem, resolveDisplayProps, useRepeatItem } from "./fields";

const LAYOUT = new Set<string>(LAYOUT_PRIMITIVE_NAMES);

/** Visual props only. Content bindings, actions, and structure stay on the spec but are not editable yet. */
const STYLE_PROPS = new Set([
  "direction", "gap", "pad", "align", "justify", "wrap", "bg", "border",
  "radius", "shadow", "width", "maxWidth", "minWidth", "height", "flex", "overflow",
  "variant", "interactive", "columns", "minItemWidth",
  "tone", "weight", "lines", "uppercase", "size",
  "ratio", "fit", "icon", "iconRight", "fullWidth",
  "spacing", "grow", "inline", "dense", "pulse",
]);

const STYLE_LABELS: Record<string, string> = {
  gap: "Gap", pad: "Padding", bg: "Background", align: "Align", justify: "Justify",
  wrap: "Wrap", radius: "Radius", shadow: "Shadow", direction: "Direction",
  variant: "Variant", tone: "Tone", weight: "Weight", size: "Size",
  ratio: "Ratio", fit: "Fit", uppercase: "Uppercase", fullWidth: "Full width",
  minItemWidth: "Min item width", iconRight: "Icon right",
};

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

function fieldForProp(name: string, schema: any): Record<string, unknown> | null {
  if (!STYLE_PROPS.has(name)) return null;
  const label = STYLE_LABELS[name] || name.charAt(0).toUpperCase() + name.slice(1);
  const u = unwrapZod(schema);
  const t = u?.def?.type;
  if (t === "enum") {
    const opts = (u.options || Object.values(u.def?.entries || {})).map((v: string) => ({ label: String(v), value: v }));
    return { type: "select", label, options: opts };
  }
  if (t === "boolean") {
    return { type: "radio", label, options: [{ label: "Yes", value: true }, { label: "No", value: false }] };
  }
  if (t === "number") return { type: "number", label };
  if (t === "string") return { type: "text", label };
  return null;
}

function defaultPropsFor(name: string, hasChildrenSlot: boolean): Record<string, unknown> {
  const props: Record<string, unknown> = { jxId: "" };
  if (hasChildrenSlot) props.jxChildren = [];
  if (name === "Card") {
    props.jxHeader = [];
    props.jxFooter = [];
  }
  if (name === "Text") props.text = "Text";
  if (name === "Button") props.label = "Button";
  if (name === "Badge") props.text = "Badge";
  if (name === "Image") props.ratio = "4:3";
  if (name === "Alert") props.text = "Notice";
  if (name === "KeyValue") {
    props.label = "Label";
    props.value = "Value";
  }
  return props;
}

function PrimitivePuckView({
  type,
  puck,
  jxChildren: Children,
  jxHeader: Header,
  jxFooter: Footer,
  jxRepeat,
  jxVisible: _jxVisible,
  jxOn: _jxOn,
  jxWatch: _jxWatch,
  jxId: _jxId,
  id: _id,
  ...rest
}: any) {
  const sampleState = (puck?.metadata?.sampleState || {}) as Record<string, unknown>;
  const parentItem = useRepeatItem();
  const childItem = firstRepeatItem(jxRepeat, sampleState, parentItem) ?? parentItem;
  const resolved = resolveDisplayProps(rest, sampleState, parentItem);
  const inline = LAYOUT.has(type);
  const node = (
    <RepeatScope item={childItem}>
      <PrimitiveView
        type={type}
        props={{
          ...resolved,
          style: {
            ...((resolved.style as object) || {}),
            ...(inline ? { position: (resolved.style as any)?.position || "relative" } : {}),
          },
        }}
        rootRef={inline ? puck?.dragRef : undefined}
        children={typeof Children === "function" ? <Children minEmptyHeight={0} /> : null}
        slots={{
          header: typeof Header === "function" ? <Header minEmptyHeight={0} /> : undefined,
          footer: typeof Footer === "function" ? <Footer minEmptyHeight={0} /> : undefined,
        }}
      />
    </RepeatScope>
  );
  return node;
}

function buildComponents(): Config["components"] {
  const components: Config["components"] = {};
  for (const [name, def] of Object.entries(primitives)) {
    const shape = (def as any).props?.shape || {};
    const fields: Record<string, unknown> = {};
    for (const [prop, schema] of Object.entries(shape)) {
      const field = fieldForProp(prop, schema);
      if (field) fields[prop] = field;
    }
    const hasChildren = LAYOUT.has(name);
    if (hasChildren) fields.jxChildren = { type: "slot", visible: false };
    if (name === "Card") {
      fields.jxHeader = { type: "slot", visible: false };
      fields.jxFooter = { type: "slot", visible: false };
    }
    components[name] = {
      label: name,
      inline: hasChildren,
      defaultProps: defaultPropsFor(name, hasChildren),
      fields: fields as any,
      render: (props: any) => <PrimitivePuckView type={name} {...props} />,
    };
  }
  return components;
}

export const puckConfig: Config = {
  root: { fields: {} },
  components: buildComponents(),
};
