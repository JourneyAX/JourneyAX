"use client";

/**
 * JsonSpecDesigner — Declarative Component Design Studio using the JSON Library
 *
 * Built directly on `@json-render/core` and `@json-render/react` (`@journeyax/ui-cards`).
 * Allows designers and engineers to create, edit, validate, test, and preview
 * component designs (cards/templates) with zero hardcoding.
 */
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Code, Eye, Play, Check, Copy, Download, Upload, RotateCcw,
  Sparkles, Plus, Trash2, Monitor, Smartphone, Tablet, Layers,
  Terminal, FileJson, Braces, AlertCircle, CheckCircle2, ChevronDown,
  Info, ExternalLink, RefreshCw
} from "lucide-react";
import type { Spec } from "@json-render/core";
import {
  CARD_TYPES, DEFAULT_TEMPLATES, tokensToCssVars, primitives, actions,
  type CardType, type ThemeTokens
} from "@journeyax/ui-cards";
import { CardRenderer } from "@journeyax/ui-cards/react";
import { sampleStateFor } from "../lib/cardSampleState";

export interface JsonSpecDesignerProps {
  projectId: string;
  cardType: CardType;
  spec: Spec;
  tokens: ThemeTokens;
  cardSettings?: Record<string, unknown>;
  onSpecChange: (spec: Spec) => void;
  onSaveDraft: () => Promise<void>;
  onSaveNamedTheme?: () => void;
  naming?: boolean;
  themeName?: string;
  setThemeName?: (name: string) => void;
  onCommitNamedTheme?: () => Promise<void>;
  onCancelNamedTheme?: () => void;
  onRevert?: () => Promise<void>;
  busy?: boolean;
  isOverride?: boolean;
  suggestedThemeName?: string;
}

// ── Primitive Category Catalog ─────────────────────────────────────────────
interface PrimitiveMeta {
  name: string;
  category: "layout" | "content" | "controls" | "data";
  desc: string;
  defaultProps: Record<string, any>;
  hasChildren?: boolean;
  defaultOn?: Record<string, any>;
  defaultRepeat?: Record<string, any>;
}

const PRIMITIVE_CATALOG: PrimitiveMeta[] = [
  // Layout
  {
    name: "Box",
    category: "layout",
    desc: "Flex container for rows/columns, padding, and backgrounds",
    hasChildren: true,
    defaultProps: { direction: "column", gap: "md", pad: "md", radius: "md", bg: "surface" }
  },
  {
    name: "Card",
    category: "layout",
    desc: "Elevated surface container with border, radius, and shadows",
    hasChildren: true,
    defaultProps: { variant: "default", pad: "md", gap: "sm" }
  },
  {
    name: "Grid",
    category: "layout",
    desc: "Responsive grid for multi-column repeats and layouts",
    hasChildren: true,
    defaultProps: { columns: 2, minItemWidth: "220px", gap: "md" }
  },
  {
    name: "Divider",
    category: "layout",
    desc: "Horizontal dividing rule",
    hasChildren: false,
    defaultProps: { spacing: "sm" }
  },
  {
    name: "Spacer",
    category: "layout",
    desc: "Flexible or fixed spacing gap",
    hasChildren: false,
    defaultProps: { size: "md", grow: false }
  },

  // Content
  {
    name: "Text",
    category: "content",
    desc: "Typography block with variant scale and tone",
    hasChildren: false,
    defaultProps: { text: "Component Heading", variant: "heading", tone: "default" }
  },
  {
    name: "Image",
    category: "content",
    desc: "Media asset with aspect ratio and fallback icons",
    hasChildren: false,
    defaultProps: {
      src: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80",
      alt: "Product image",
      ratio: "4:3",
      radius: "sm",
      fallbackIcon: "box"
    }
  },
  {
    name: "Price",
    category: "content",
    desc: "Currency formatting with compare-at original price",
    hasChildren: false,
    defaultProps: { amount: 189.00, currency: "USD", compareAt: 249.00, size: "lg" }
  },
  {
    name: "Badge",
    category: "content",
    desc: "Status pill badge for highlights and recommendations",
    hasChildren: false,
    defaultProps: { text: "Recommended", tone: "brand", variant: "soft", icon: "spark" }
  },
  {
    name: "StatusDot",
    category: "content",
    desc: "Color status dot with availability label",
    hasChildren: false,
    defaultProps: { label: "In Stock · Dispatches 24h", tone: "success", pulse: true }
  },
  {
    name: "Icon",
    category: "content",
    desc: "Inline platform SVG icon",
    hasChildren: false,
    defaultProps: { name: "spark", size: "md", tone: "brand" }
  },
  {
    name: "Markdown",
    category: "content",
    desc: "Formatted markdown text block (bullets, bold, italics)",
    hasChildren: false,
    defaultProps: { text: "**Key Features:**\n- High efficiency water management\n- Solid forged brass construction" }
  },

  // Controls
  {
    name: "Button",
    category: "controls",
    desc: "Clickable action button dispatching catalog events",
    hasChildren: false,
    defaultProps: { label: "Add to Cart", variant: "primary", size: "md", icon: "cart" },
    defaultOn: { press: { action: "addToCart", params: { sku: "SKU-SAMPLE", qty: 1 } } }
  },
  {
    name: "Link",
    category: "controls",
    desc: "Anchor link with external/internal navigation",
    hasChildren: false,
    defaultProps: { label: "View Technical Specification →", href: "#", external: true }
  },
  {
    name: "Chips",
    category: "controls",
    desc: "Tappable filter/option chips emitting selection events",
    hasChildren: false,
    defaultProps: { items: ["Standard", "Heavy Duty", "Commercial"], selected: "Standard", tone: "accent" }
  },
  {
    name: "Quantity",
    category: "controls",
    desc: "Interactive number stepper with bounds",
    hasChildren: false,
    defaultProps: { value: 1, min: 1, max: 99, size: "sm" }
  },
  {
    name: "Select",
    category: "controls",
    desc: "Interactive dropdown selector with options",
    hasChildren: false,
    defaultProps: {
      placeholder: "Choose variant...",
      options: [
        { value: "v1", label: "Matte Black Finish" },
        { value: "v2", label: "Brushed Brass (+ $35)" },
        { value: "v3", label: "Polished Chrome" }
      ]
    }
  },

  // Data
  {
    name: "KeyValue",
    category: "data",
    desc: "Structured label/value specification pair",
    hasChildren: false,
    defaultProps: { label: "Warranty Guarantee", value: "15 Years Comprehensive" }
  },
  {
    name: "Table",
    category: "data",
    desc: "Data grid table with header and rows",
    hasChildren: false,
    defaultProps: {
      columns: ["Spec", "Specification Value"],
      rows: [
        ["Material", "Forged DZR Brass"],
        ["Flow Rate", "4.5 Litres/min (WELS 5-Star)"],
        ["Pressure", "500 kPa Max Operating"]
      ],
      dense: true
    }
  },
  {
    name: "Steps",
    category: "data",
    desc: "Numbered step workflow timeline",
    hasChildren: false,
    defaultProps: {
      current: 1,
      items: [
        { title: "Requirements Gathering", detail: "Specification confirmed", status: "done" },
        { title: "Engineering Fitment", detail: "Checking dimensional clearance", status: "running" },
        { title: "Procurement & Dispatch", detail: "Dispatches from regional DC", status: "pending" }
      ]
    }
  },
  {
    name: "Progress",
    category: "data",
    desc: "Linear progress completion meter",
    hasChildren: false,
    defaultProps: { value: 68, label: "68% Configuration Complete", tone: "brand" }
  },
  {
    name: "Alert",
    category: "data",
    desc: "Callout banner for notes, warnings, or tips",
    hasChildren: false,
    defaultProps: {
      title: "Commercial Trade Discount Active",
      text: "Volume tier 2 has been applied based on your account status.",
      tone: "accent",
      icon: "info"
    }
  },
  {
    name: "Rating",
    category: "data",
    desc: "Star rating visualization with review count",
    hasChildren: false,
    defaultProps: { value: 4.85, count: 142, size: "sm" }
  },
  {
    name: "Swatches",
    category: "data",
    desc: "Interactive visual color/finish swatches",
    hasChildren: false,
    defaultProps: {
      items: [
        { id: "blk", label: "Matte Black", hex: "#18181B" },
        { id: "gld", label: "Brushed Brass", hex: "#D97706" },
        { id: "chr", label: "Chrome", hex: "#E4E4E7" }
      ],
      selected: "blk",
      size: "md"
    }
  }
];

// ── Built-in Design Recipes (JSON library specs) ───────────────────────────
const DESIGN_RECIPES: Record<string, { label: string; desc: string; spec: (ct: CardType) => Spec }> = {
  default: {
    label: "Platform Canonical Default",
    desc: "Reset back to the platform baseline template for this card type",
    spec: (ct: CardType) => DEFAULT_TEMPLATES[ct]
  },
  heroBanner: {
    label: "Modern Hero Banner",
    desc: "High-impact visual banner with badge, headline, value proposition and action",
    spec: () => ({
      root: "hero-card",
      elements: {
        "hero-card": {
          type: "Card",
          props: { variant: "highlight", pad: "lg", gap: "md" },
          children: ["hero-badge", "hero-title", "hero-desc", "hero-actions"]
        },
        "hero-badge": {
          type: "Badge",
          props: { text: "Exclusive Selection", tone: "brand", variant: "solid", icon: "spark" }
        },
        "hero-title": {
          type: "Text",
          props: { text: { $state: "/heading" }, variant: "display", tone: "default" }
        },
        "hero-desc": {
          type: "Text",
          props: { text: { $state: "/subtitle" }, variant: "body", tone: "muted" }
        },
        "hero-actions": {
          type: "Box",
          props: { direction: "row", gap: "sm", align: "center", pad: "0" },
          children: ["hero-btn-primary", "hero-btn-secondary"]
        },
        "hero-btn-primary": {
          type: "Button",
          props: { label: "Explore Products", variant: "primary", icon: "cart" },
          on: { press: { action: "sendMessage", params: { text: "Show me all matching products" } } }
        },
        "hero-btn-secondary": {
          type: "Button",
          props: { label: "Consult Specialist", variant: "secondary", icon: "info" },
          on: { press: { action: "openPanel", params: { panel: "quote" } } }
        }
      }
    })
  },
  productGrid: {
    label: "Dynamic Repeat Product Grid",
    desc: "Responsive grid binding { $state: '/products' } with tiles, price, and add-to-cart",
    spec: () => ({
      root: "prod-container",
      elements: {
        "prod-container": {
          type: "Box",
          props: { gap: "md", pad: "0" },
          children: ["prod-header", "prod-grid"]
        },
        "prod-header": {
          type: "Box",
          props: { direction: "row", justify: "between", align: "center" },
          children: ["prod-title", "prod-status"]
        },
        "prod-title": {
          type: "Text",
          props: { text: "Recommended Solutions", variant: "title" }
        },
        "prod-status": {
          type: "StatusDot",
          props: { label: "Grounded Live Inventory", tone: "success", pulse: true }
        },
        "prod-grid": {
          type: "Grid",
          props: { columns: 2, gap: "md", minItemWidth: "220px" },
          repeat: { statePath: "/products", key: "sku" },
          children: ["prod-tile"]
        },
        "prod-tile": {
          type: "Card",
          props: { pad: "sm", gap: "sm", interactive: true },
          children: ["tile-img", "tile-title", "tile-price", "tile-btn"],
          on: { press: { action: "viewProduct", params: { sku: { $item: "sku" } } } }
        },
        "tile-img": {
          type: "Image",
          props: { src: { $item: "imageUrl" }, alt: { $item: "title" }, ratio: "4:3", radius: "sm" }
        },
        "tile-title": {
          type: "Text",
          props: { text: { $item: "title" }, variant: "subheading", lines: 2 }
        },
        "tile-price": {
          type: "Price",
          props: { amount: { $item: "price" }, currency: { $item: "currency" }, size: "md" }
        },
        "tile-btn": {
          type: "Button",
          props: { label: "Add to Cart", variant: "primary", size: "sm", icon: "cart" },
          on: { press: { action: "addToCart", params: { sku: { $item: "sku" }, qty: 1 } } }
        }
      }
    })
  },
  specSheet: {
    label: "Technical Specification Sheet",
    desc: "Detailed spec table with key-value pairs, progress, and download action",
    spec: () => ({
      root: "spec-card",
      elements: {
        "spec-card": {
          type: "Card",
          props: { variant: "default", pad: "md", gap: "md" },
          children: ["spec-head", "spec-divider-1", "spec-table", "spec-divider-2", "spec-foot"]
        },
        "spec-head": {
          type: "Box",
          props: { gap: "xs" },
          children: ["spec-title", "spec-desc"]
        },
        "spec-title": {
          type: "Text",
          props: { text: "Technical Specifications & Compliance", variant: "heading" }
        },
        "spec-desc": {
          type: "Text",
          props: { text: "Verified against Caroma commercial architectural standards", variant: "small", tone: "muted" }
        },
        "spec-divider-1": {
          type: "Divider",
          props: { spacing: "xs" }
        },
        "spec-table": {
          type: "Table",
          props: {
            columns: ["Property", "Value"],
            rows: [
              ["Material", "DZR Brass with Ceramic Disc Cartridge"],
              ["Finish", "Electroplated Matte Black / PVD Brushed Brass"],
              ["Inlet Connection", "1/2 inch BSP Female Flexible Hoses"],
              ["Warranty", "15-Year Replacement Warranty"]
            ],
            dense: true
          }
        },
        "spec-divider-2": {
          type: "Divider",
          props: { spacing: "xs" }
        },
        "spec-foot": {
          type: "Box",
          props: { direction: "row", justify: "between", align: "center" },
          children: ["spec-link", "spec-btn"]
        },
        "spec-link": {
          type: "Link",
          props: { label: "Download CAD Files (DWG/Revit)", href: "#", external: true }
        },
        "spec-btn": {
          type: "Button",
          props: { label: "Request Specification Signoff", variant: "secondary", size: "sm", icon: "check" },
          on: { press: { action: "sendMessage", params: { text: "Signoff requested on technical specifications" } } }
        }
      }
    })
  }
};

// ── Validation Helper ──────────────────────────────────────────────────────
const PRIMITIVE_SET = new Set(Object.keys(primitives));

function validateJsonSpec(spec: unknown): string[] {
  const issues: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return ["Spec must be an object of shape { root: string, elements: { ... } }"];
  }
  const { root, elements } = spec as { root?: unknown; elements?: unknown };
  if (typeof root !== "string" || !root.trim()) {
    issues.push("`root` must be a non-empty string referencing the root element ID.");
  }
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) {
    issues.push("`elements` must be an object containing all element definitions.");
    return issues;
  }
  const els = elements as Record<string, any>;
  const keys = Object.keys(els);
  if (keys.length === 0) {
    issues.push("`elements` contains no component nodes.");
  }
  if (typeof root === "string" && root.trim() && !(root in els)) {
    issues.push(`Root element '${root}' is not found in elements.`);
  }

  for (const key of keys) {
    const el = els[key];
    if (!el || typeof el !== "object" || Array.isArray(el)) {
      issues.push(`elements['${key}'] must be a valid component object.`);
      continue;
    }
    if (typeof el.type !== "string") {
      issues.push(`elements['${key}'].type must be a string.`);
    } else if (!PRIMITIVE_SET.has(el.type)) {
      issues.push(`elements['${key}'].type '${el.type}' is not in the 24 catalog primitives.`);
    }
    if (el.children && !Array.isArray(el.children)) {
      issues.push(`elements['${key}'].children must be an array of element IDs.`);
    } else if (Array.isArray(el.children)) {
      for (const childId of el.children) {
        if (!(childId in els)) {
          issues.push(`elements['${key}'].children references missing element '${childId}'.`);
        }
      }
    }
  }
  return issues;
}

// ── Main JSON Spec Designer Component ──────────────────────────────────────
export function JsonSpecDesigner({
  projectId,
  cardType,
  spec,
  tokens,
  cardSettings,
  onSpecChange,
  onSaveDraft,
  onSaveNamedTheme,
  naming = false,
  themeName = "",
  setThemeName,
  onCommitNamedTheme,
  onCancelNamedTheme,
  onRevert,
  busy = false,
  isOverride = false,
  suggestedThemeName = ""
}: JsonSpecDesignerProps) {
  // Spec text and parse state
  const [rawJson, setRawJson] = useState<string>(() => JSON.stringify(spec, null, 2));
  const [parsedSpec, setParsedSpec] = useState<Spec>(spec);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Right pane tab & viewport
  const [rightTab, setRightTab] = useState<"preview" | "mockState" | "tree">("preview");
  const [viewportMode, setViewportMode] = useState<"desktop" | "tablet" | "mobile">("desktop");

  // Mock state for interactive testing
  const [mockState, setMockState] = useState<Record<string, unknown>>(() => sampleStateFor(cardType));
  const [rawMockState, setRawMockState] = useState<string>(() => JSON.stringify(sampleStateFor(cardType), null, 2));
  const [stateSyntaxError, setStateSyntaxError] = useState<string | null>(null);

  // Interactive action event console
  const [actionLog, setActionLog] = useState<Array<{ id: string; time: string; action: string; params: any }>>([]);

  // UI helpers
  const [primitiveSearch, setPrimitiveSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [copied, setCopied] = useState(false);
  const [showRecipesMenu, setShowRecipesMenu] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Sync when cardType or parent spec changes
  useEffect(() => {
    setRawJson(JSON.stringify(spec, null, 2));
    setParsedSpec(spec);
    setSyntaxError(null);
    setValidationErrors(validateJsonSpec(spec));
    const nextMock = sampleStateFor(cardType);
    setMockState(nextMock);
    setRawMockState(JSON.stringify(nextMock, null, 2));
    setActionLog([]);
    setNote(null);
  }, [cardType, spec]);

  // Handle JSON typing in code editor
  function handleJsonChange(newText: string) {
    setRawJson(newText);
    try {
      const parsed = JSON.parse(newText);
      setSyntaxError(null);
      const errors = validateJsonSpec(parsed);
      setValidationErrors(errors);
      if (errors.length === 0) {
        setParsedSpec(parsed);
        onSpecChange(parsed);
      }
    } catch (e: any) {
      setSyntaxError(e.message || "Invalid JSON syntax");
    }
  }

  // Handle Tab key in editor
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      const updated = val.substring(0, start) + "  " + val.substring(end);
      handleJsonChange(updated);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  }

  // Format / Prettify JSON
  function handleFormatJson() {
    try {
      const parsed = JSON.parse(rawJson);
      const formatted = JSON.stringify(parsed, null, 2);
      setRawJson(formatted);
      setSyntaxError(null);
      setValidationErrors(validateJsonSpec(parsed));
      setParsedSpec(parsed);
      onSpecChange(parsed);
    } catch (e: any) {
      setSyntaxError("Cannot format: " + (e.message || "Invalid JSON"));
    }
  }

  // Copy spec to clipboard
  function handleCopyJson() {
    navigator.clipboard.writeText(rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Export as .json file
  function handleDownloadJson() {
    const blob = new Blob([rawJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cardType}-spec.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Import JSON from file
  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) {
        handleJsonChange(content);
        setNote("Imported JSON successfully.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Insert a primitive into the JSON spec
  function handleInsertPrimitive(meta: PrimitiveMeta) {
    if (!parsedSpec) return;
    const count = Object.keys(parsedSpec.elements || {}).length + 1;
    const newId = `${meta.name.toLowerCase()}-${count}`;
    const newElement: any = {
      type: meta.name,
      props: { ...meta.defaultProps }
    };
    if (meta.hasChildren) {
      newElement.children = [];
    }
    if (meta.defaultOn) {
      newElement.on = meta.defaultOn;
    }

    // Clone spec
    const nextElements = { ...parsedSpec.elements, [newId]: newElement };
    let nextRoot = parsedSpec.root;

    // Attach to root if root has children
    const rootEl = nextElements[nextRoot];
    if (rootEl && Array.isArray(rootEl.children)) {
      rootEl.children = [...rootEl.children, newId];
    } else if (!rootEl) {
      nextRoot = newId;
    }

    const nextSpec: Spec = {
      ...parsedSpec,
      root: nextRoot,
      elements: nextElements
    };

    const formatted = JSON.stringify(nextSpec, null, 2);
    setRawJson(formatted);
    setParsedSpec(nextSpec);
    setSyntaxError(null);
    setValidationErrors(validateJsonSpec(nextSpec));
    onSpecChange(nextSpec);
    setNote(`Inserted <${meta.name}> as '${newId}'.`);
  }

  // Insert binding expression helper into clipboard/prompt
  function handleInsertSnippet(snippetCode: string, label: string) {
    navigator.clipboard.writeText(snippetCode);
    setNote(`Copied ${label} snippet to clipboard: ${snippetCode}`);
  }

  // Apply a design recipe
  function handleApplyRecipe(recipeKey: string) {
    const recipe = DESIGN_RECIPES[recipeKey];
    if (!recipe) return;
    const nextSpec = recipe.spec(cardType);
    const formatted = JSON.stringify(nextSpec, null, 2);
    setRawJson(formatted);
    setParsedSpec(nextSpec);
    setSyntaxError(null);
    setValidationErrors(validateJsonSpec(nextSpec));
    onSpecChange(nextSpec);
    setShowRecipesMenu(false);
    setNote(`Applied recipe: ${recipe.label}`);
  }

  // Capture interactive action dispatches from the CardRenderer
  function handleAction(name: string, params?: Record<string, unknown>) {
    const newEntry = {
      id: Math.random().toString(36).substring(2, 9),
      time: new Date().toLocaleTimeString(),
      action: name,
      params: params || {}
    };
    setActionLog((prev) => [newEntry, ...prev.slice(0, 19)]);
  }

  // Handle mock state editing
  function handleMockStateChange(text: string) {
    setRawMockState(text);
    try {
      const parsed = JSON.parse(text);
      setMockState(parsed);
      setStateSyntaxError(null);
    } catch (e: any) {
      setStateSyntaxError(e.message || "Invalid JSON");
    }
  }

  // Filter primitives
  const filteredPrimitives = useMemo(() => {
    return PRIMITIVE_CATALOG.filter((p) => {
      const matchesCategory = selectedCategory === "all" || p.category === selectedCategory;
      const matchesSearch = !primitiveSearch ||
        p.name.toLowerCase().includes(primitiveSearch.toLowerCase()) ||
        p.desc.toLowerCase().includes(primitiveSearch.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [selectedCategory, primitiveSearch]);

  const elementCount = parsedSpec?.elements ? Object.keys(parsedSpec.elements).length : 0;
  const isHealthy = !syntaxError && validationErrors.length === 0;

  // Viewport widths
  const viewportWidthStyle =
    viewportMode === "mobile" ? "380px" :
    viewportMode === "tablet" ? "640px" : "100%";

  return (
    <div className="json-designer-root" data-testid="json-spec-designer">
      {/* ── Top Header Toolbar ─────────────────────────────────────────── */}
      <div className="json-designer-head">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Braces size={16} color="var(--jx-yellow)" />
            <span style={{ fontWeight: 700, fontSize: "13px", color: "var(--jx-black)" }}>
              JSON Library Studio
            </span>
          </div>
          <span className="json-designer-badge-engine">
            @json-render/core v0.20 + @journeyax/ui-cards
          </span>
          <span style={{ fontSize: "11px", color: "var(--jx-gray-500)" }}>
            {elementCount} nodes · Root: <code style={{ fontWeight: 600 }}>{parsedSpec?.root || "none"}</code>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {/* Status Indicator */}
          {isHealthy ? (
            <span className="json-designer-pill success" title="JSON schema valid">
              <CheckCircle2 size={12} /> Valid Spec
            </span>
          ) : (
            <span className="json-designer-pill error" title={syntaxError || validationErrors[0]}>
              <AlertCircle size={12} /> {syntaxError ? "JSON Syntax Error" : `${validationErrors.length} Schema Issues`}
            </span>
          )}

          {/* Quick Actions */}
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleFormatJson}
            title="Format / Prettify JSON"
          >
            <Sparkles size={12} /> Format
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleCopyJson}
            title="Copy JSON to clipboard"
          >
            {copied ? <Check size={12} color="#16a34a" /> : <Copy size={12} />}
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleDownloadJson}
            title="Download JSON Spec file"
          >
            <Download size={12} /> Export
          </button>

          <label className="btn btn-sm" style={{ cursor: "pointer" }} title="Import JSON file">
            <Upload size={12} /> Import
            <input type="file" accept=".json" onChange={handleImportJson} style={{ display: "none" }} />
          </label>

          {/* Design Recipes Dropdown */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowRecipesMenu((v) => !v)}
              title="Load standard component design patterns"
            >
              <Layers size={12} /> Recipes <ChevronDown size={10} />
            </button>
            {showRecipesMenu && (
              <div className="json-designer-dropdown-menu">
                <div style={{ padding: "6px 10px", fontSize: "11px", fontWeight: 700, color: "var(--jx-gray-500)", textTransform: "uppercase" }}>
                  Component Recipes
                </div>
                {Object.entries(DESIGN_RECIPES).map(([key, r]) => (
                  <button
                    key={key}
                    type="button"
                    className="json-designer-dropdown-item"
                    onClick={() => handleApplyRecipe(key)}
                  >
                    <div style={{ fontWeight: 600, fontSize: "12px", color: "var(--jx-black)" }}>{r.label}</div>
                    <div style={{ fontSize: "11px", color: "var(--jx-gray-500)" }}>{r.desc}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Notification Banner (if any) ─────────────────────────────── */}
      {note && (
        <div className="json-designer-alert note">
          <Info size={14} />
          <span style={{ flex: 1 }}>{note}</span>
          <button type="button" onClick={() => setNote(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "14px" }}>×</button>
        </div>
      )}

      {/* ── Main Two-Column Split Workspace ───────────────────────────── */}
      <div className="json-designer-split">
        {/* LEFT COLUMN: Primitives Palette + JSON Code Editor */}
        <div className="json-designer-pane left">
          {/* Primitives Insert Drawer */}
          <div className="json-designer-primitives-drawer">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--jx-gray-700)" }}>
                Catalog Primitives (24 Elements)
              </div>
              <input
                type="text"
                placeholder="Search primitives..."
                value={primitiveSearch}
                onChange={(e) => setPrimitiveSearch(e.target.value)}
                className="field"
                style={{ fontSize: "11px", padding: "3px 8px", width: "140px" }}
              />
            </div>

            {/* Category Filter Chips */}
            <div style={{ display: "flex", gap: "4px", marginBottom: "8px", overflowX: "auto" }}>
              {["all", "layout", "content", "controls", "data"].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`json-designer-cat-chip${selectedCategory === cat ? " on" : ""}`}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>

            {/* Primitives Grid */}
            <div className="json-designer-primitives-grid">
              {filteredPrimitives.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="json-designer-primitive-btn"
                  onClick={() => handleInsertPrimitive(p)}
                  title={`${p.name}: ${p.desc} (Click to insert into spec)`}
                >
                  <span style={{ fontWeight: 600 }}>+{p.name}</span>
                  <span style={{ fontSize: "10px", color: "var(--jx-gray-500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.desc}
                  </span>
                </button>
              ))}
            </div>

            {/* Snippet Helpers */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid var(--jx-gray-200)", flexWrap: "wrap" }}>
              <span style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--jx-gray-600)" }}>Expressions:</span>
              <button
                type="button"
                className="btn-snippet"
                onClick={() => handleInsertSnippet('{"$state": "/products/0/title"}', '$state')}
                title="Copy {$state: '/path'} to clipboard"
              >
                + $state
              </button>
              <button
                type="button"
                className="btn-snippet"
                onClick={() => handleInsertSnippet('{"$item": "title"}', '$item')}
                title="Copy {$item: 'field'} to clipboard"
              >
                + $item
              </button>
              <button
                type="button"
                className="btn-snippet"
                onClick={() => handleInsertSnippet('{"$template": "${/title} · ${/sku}"}', '$template')}
                title="Copy {$template: '...'} to clipboard"
              >
                + $template
              </button>
              <button
                type="button"
                className="btn-snippet"
                onClick={() => handleInsertSnippet('"repeat": { "statePath": "/products", "key": "sku" }', 'repeat')}
                title="Copy repeat definition to clipboard"
              >
                + repeat
              </button>
              <button
                type="button"
                className="btn-snippet"
                onClick={() => handleInsertSnippet('"visible": [{ "$state": "/inStock", "eq": true }]', 'visible')}
                title="Copy conditional visibility to clipboard"
              >
                + visible
              </button>
              <button
                type="button"
                className="btn-snippet"
                onClick={() => handleInsertSnippet('"on": { "press": { "action": "addToCart", "params": { "sku": {"$item": "sku"}, "qty": 1 } } }', 'action')}
                title="Copy action dispatch to clipboard"
              >
                + action
              </button>
            </div>
          </div>

          {/* JSON Textarea Editor */}
          <div className="json-designer-editor-wrap">
            <textarea
              className="json-designer-textarea"
              value={rawJson}
              onChange={(e) => handleJsonChange(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              aria-label="JSON Spec Editor"
              data-testid="json-spec-editor-textarea"
            />
          </div>

          {/* Syntax or Schema Errors */}
          {(syntaxError || validationErrors.length > 0) && (
            <div className="json-designer-errors-panel">
              {syntaxError && (
                <div style={{ color: "#B42318", fontWeight: 600, marginBottom: "4px" }}>
                  JSON Syntax Error: {syntaxError}
                </div>
              )}
              {validationErrors.map((err, i) => (
                <div key={i} style={{ color: "#B42318" }}>
                  • {err}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Live Interactive Preview & Testbed */}
        <div className="json-designer-pane right">
          {/* Preview Navigation Bar */}
          <div className="json-designer-preview-bar">
            {/* Tabs */}
            <div style={{ display: "flex", gap: "2px" }}>
              <button
                type="button"
                className={`json-designer-tab-btn${rightTab === "preview" ? " on" : ""}`}
                onClick={() => setRightTab("preview")}
              >
                <Eye size={12} /> Live Preview
              </button>
              <button
                type="button"
                className={`json-designer-tab-btn${rightTab === "mockState" ? " on" : ""}`}
                onClick={() => setRightTab("mockState")}
              >
                <FileJson size={12} /> Mock State Data
              </button>
              <button
                type="button"
                className={`json-designer-tab-btn${rightTab === "tree" ? " on" : ""}`}
                onClick={() => setRightTab("tree")}
              >
                <Layers size={12} /> Element Tree
              </button>
            </div>

            {/* Viewport switch (Desktop / Tablet / Mobile) */}
            {rightTab === "preview" && (
              <div style={{ display: "flex", alignItems: "center", gap: "2px", background: "var(--jx-gray-100)", borderRadius: "6px", padding: "2px" }}>
                <button
                  type="button"
                  className={`json-designer-device-btn${viewportMode === "desktop" ? " on" : ""}`}
                  onClick={() => setViewportMode("desktop")}
                  title="Desktop View (100% width)"
                >
                  <Monitor size={12} />
                </button>
                <button
                  type="button"
                  className={`json-designer-device-btn${viewportMode === "tablet" ? " on" : ""}`}
                  onClick={() => setViewportMode("tablet")}
                  title="Tablet View (640px width)"
                >
                  <Tablet size={12} />
                </button>
                <button
                  type="button"
                  className={`json-designer-device-btn${viewportMode === "mobile" ? " on" : ""}`}
                  onClick={() => setViewportMode("mobile")}
                  title="Mobile View (380px width)"
                >
                  <Smartphone size={12} />
                </button>
              </div>
            )}
          </div>

          {/* Tab 1: Live Interactive Component Preview */}
          {rightTab === "preview" && (
            <div className="json-designer-preview-viewport">
              <div
                style={{
                  width: viewportWidthStyle,
                  margin: "0 auto",
                  transition: "width 0.2s ease"
                }}
              >
                {parsedSpec && (
                  <div
                    className="jx-root"
                    style={{
                      ...(tokensToCssVars(tokens) as unknown as React.CSSProperties),
                      background: "var(--jx-color-bg)",
                      padding: 16,
                      borderRadius: 10,
                      boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                      minHeight: 180,
                      maxHeight: 520,
                      overflowY: "auto"
                    }}
                  >
                    <CardRenderer
                      template={parsedSpec}
                      state={mockState}
                      settings={cardSettings}
                      stateKey={cardType}
                      onAction={handleAction}
                    />
                  </div>
                )}
              </div>

              {/* Action Log Console */}
              <div className="json-designer-action-console">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: 700, color: "var(--jx-gray-700)" }}>
                    <Terminal size={12} /> Interactive Action Stream ({actionLog.length})
                  </div>
                  {actionLog.length > 0 && (
                    <button
                      type="button"
                      className="btn-snippet"
                      onClick={() => setActionLog([])}
                      style={{ fontSize: "10px", padding: "1px 6px" }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {actionLog.length === 0 ? (
                  <div style={{ fontSize: "11px", color: "var(--jx-gray-400)", fontStyle: "italic" }}>
                    Click buttons, chips or links in the preview above to test catalog action dispatches in real-time.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "120px", overflowY: "auto" }}>
                    {actionLog.map((log) => (
                      <div key={log.id} className="json-designer-log-item">
                        <span style={{ color: "var(--jx-gray-400)", fontSize: "10px" }}>{log.time}</span>
                        <span style={{ fontWeight: 700, color: "#4B3FCF", fontSize: "11px" }}>{log.action}</span>
                        <code style={{ fontSize: "10.5px", color: "var(--jx-gray-700)" }}>
                          {JSON.stringify(log.params)}
                        </code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Mock State Tester */}
          {rightTab === "mockState" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "12px", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--jx-gray-700)" }}>
                  Sample State Payload (passed into CardRenderer)
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const fresh = sampleStateFor(cardType);
                    setMockState(fresh);
                    setRawMockState(JSON.stringify(fresh, null, 2));
                    setStateSyntaxError(null);
                  }}
                >
                  <RefreshCw size={11} /> Reset State
                </button>
              </div>
              <textarea
                className="json-designer-textarea"
                value={rawMockState}
                onChange={(e) => handleMockStateChange(e.target.value)}
                style={{ flex: 1, minHeight: "360px" }}
                spellCheck={false}
              />
              {stateSyntaxError && (
                <div style={{ color: "#B42318", fontSize: "12px" }}>
                  State Syntax Error: {stateSyntaxError}
                </div>
              )}
            </div>
          )}

          {/* Tab 3: Element Hierarchy Tree */}
          {rightTab === "tree" && (
            <div style={{ padding: "16px", overflowY: "auto", height: "100%" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, marginBottom: "12px", color: "var(--jx-black)" }}>
                Element Hierarchy (Root: <code>{parsedSpec?.root}</code>)
              </div>
              {parsedSpec && parsedSpec.elements && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {Object.entries(parsedSpec.elements).map(([id, el]: [string, any]) => (
                    <div
                      key={id}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "6px",
                        background: id === parsedSpec.root ? "#EEF2FF" : "var(--jx-gray-100)",
                        border: id === parsedSpec.root ? "1px solid #C7D2FE" : "1px solid var(--jx-gray-200)",
                        fontSize: "12px"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong style={{ color: "var(--jx-black)" }}>{id}</strong>
                          <span style={{ marginLeft: "8px", color: "#4B3FCF", fontWeight: 600 }}>&lt;{el.type}&gt;</span>
                        </div>
                        {id === parsedSpec.root && (
                          <span style={{ fontSize: "10px", fontWeight: 700, background: "#4B3FCF", color: "#fff", padding: "2px 6px", borderRadius: "4px" }}>
                            ROOT
                          </span>
                        )}
                      </div>
                      {el.children && el.children.length > 0 && (
                        <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--jx-gray-600)" }}>
                          Children: {el.children.map((c: string) => <code key={c} style={{ marginRight: "4px" }}>{c}</code>)}
                        </div>
                      )}
                      {el.repeat && (
                        <div style={{ marginTop: "4px", fontSize: "11px", color: "#D97706" }}>
                          Repeat: <code>{el.repeat.statePath}</code> (key: {el.repeat.key})
                        </div>
                      )}
                      {el.visible && (
                        <div style={{ marginTop: "4px", fontSize: "11px", color: "#059669" }}>
                          Conditional: <code>{JSON.stringify(el.visible)}</code>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Footer Controls ───────────────────────────────────────────── */}
      <div className="json-designer-foot">
        {naming && onCommitNamedTheme && setThemeName ? (
          <form
            className="theme-switcher-name"
            onSubmit={(e) => { e.preventDefault(); void onCommitNamedTheme(); }}
            style={{ display: "flex", gap: "8px", alignItems: "center" }}
          >
            <input
              className="field"
              value={themeName}
              onChange={(e) => setThemeName(e.target.value)}
              placeholder="Theme name"
              aria-label="New theme name"
              data-testid="editor-theme-name"
              autoFocus
              style={{ padding: "7px 10px", fontSize: 13, width: 180 }}
            />
            <button type="submit" className="btn y" disabled={busy || !isHealthy || !themeName.trim()}>Save</button>
            <button type="button" className="btn" onClick={onCancelNamedTheme} disabled={busy}>Cancel</button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="btn y"
              onClick={() => void onSaveDraft()}
              disabled={busy || !isHealthy}
              data-testid="json-spec-save-draft"
            >
              {busy ? "Saving..." : "Save Template Draft"}
            </button>

            {onSaveNamedTheme && (
              <button
                type="button"
                className="btn"
                onClick={onSaveNamedTheme}
                disabled={busy || !isHealthy}
              >
                Save as New Theme
              </button>
            )}

            <button
              type="button"
              className="btn"
              onClick={() => handleApplyRecipe("default")}
              disabled={busy}
            >
              Reset to Default Recipe
            </button>

            {onRevert && isOverride && (
              <button
                type="button"
                className="btn"
                onClick={() => void onRevert()}
                disabled={busy}
                style={{ color: "#B42318" }}
              >
                Revert to Platform Default
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
