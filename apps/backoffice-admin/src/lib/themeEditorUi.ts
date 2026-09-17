/**
 * Labels, presets and helpers for the Cards & Theme visual studio.
 * Token keys stay the ones in ThemeTokens — this file is display-only.
 */
import { DEFAULT_TOKENS, mergeTokens, type ThemeTokens } from "@journeyax/ui-cards";

export type ColorField = keyof ThemeTokens["colors"];

export interface ColorControl {
  field: ColorField;
  label: string;
  hint: string;
}

export const BRAND_COLORS: ColorControl[] = [
  { field: "brand", label: "Brand colour", hint: "Used on Add to cart buttons and highlights" },
  { field: "brandText", label: "Button text", hint: "Text sitting on the brand colour" },
  { field: "accent", label: "Accent", hint: "Links, labels, and small highlights" },
];

export const SURFACE_COLORS: ColorControl[] = [
  { field: "bg", label: "Page background", hint: "The stage behind the cards" },
  { field: "surface", label: "Card background", hint: "The card itself" },
  { field: "muted", label: "Subtle fill", hint: "Chips, stripes, quiet areas" },
  { field: "border", label: "Borders", hint: "Lines around cards and fields" },
];

export const TEXT_COLORS: ColorControl[] = [
  { field: "text", label: "Body colour", hint: "Main reading text" },
  { field: "textMuted", label: "Secondary text", hint: "Captions and hints" },
];

export const STATUS_COLORS: ColorControl[] = [
  { field: "success", label: "Success", hint: "In stock, confirmed, done" },
  { field: "warning", label: "Warning", hint: "Low stock and cautions" },
  { field: "danger", label: "Error", hint: "Alerts and destructive actions" },
  { field: "inverse", label: "Dark blocks", hint: "Inverted panels" },
  { field: "inverseText", label: "Text on dark", hint: "Text sitting on dark blocks" },
];

export const FONT_PRESETS = [
  { id: "space-grotesk", label: "Space Grotesk", value: "'Space Grotesk', 'DM Sans', system-ui, sans-serif" },
  { id: "dm-sans", label: "DM Sans", value: "'DM Sans', system-ui, -apple-system, sans-serif" },
  { id: "system", label: "System", value: "system-ui, -apple-system, sans-serif" },
  { id: "georgia", label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { id: "mono", label: "Monospace", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
] as const;

export const CUSTOM_FONT_ID = "custom";

export function matchFontPreset(value: string): string {
  const found = FONT_PRESETS.find((p) => p.value === value);
  return found ? found.id : CUSTOM_FONT_ID;
}

export const CORNER_PRESETS = {
  sharp: { sm: "0px", md: "4px", lg: "8px", pill: "999px" },
  soft: { sm: "6px", md: "12px", lg: "20px", pill: "999px" },
  round: { sm: "12px", md: "20px", lg: "32px", pill: "999px" },
} as const;

export const SHADOW_PRESETS = {
  flat: { sm: "none", md: "none", lg: "none" },
  subtle: {
    sm: "0 1px 3px rgba(20,20,19,0.06)",
    md: "0 6px 18px rgba(11,42,86,0.08)",
    lg: "0 14px 40px rgba(11,42,86,0.16)",
  },
  deep: {
    sm: "0 2px 6px rgba(20,20,19,0.10)",
    md: "0 10px 28px rgba(11,42,86,0.16)",
    lg: "0 22px 56px rgba(11,42,86,0.28)",
  },
} as const;

export const SPACE_PRESETS = {
  compact: { xs: "2px", sm: "6px", md: "12px", lg: "18px", xl: "28px" },
  comfortable: { xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "40px" },
  roomy: { xs: "6px", sm: "12px", md: "20px", lg: "32px", xl: "52px" },
} as const;

export const CORNER_CHIPS = [
  { id: "sharp", label: "Sharp" },
  { id: "soft", label: "Soft" },
  { id: "round", label: "Round" },
] as const;

export const SHADOW_CHIPS = [
  { id: "flat", label: "Flat" },
  { id: "subtle", label: "Subtle" },
  { id: "deep", label: "Deep" },
] as const;

export const SPACE_CHIPS = [
  { id: "compact", label: "Compact" },
  { id: "comfortable", label: "Comfortable" },
  { id: "roomy", label: "Roomy" },
] as const;

function scalesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(b).every((k) => a[k] === b[k]);
}

export function matchPreset<T extends Record<string, Record<string, string>>>(
  current: Record<string, string>,
  presets: T,
): keyof T | null {
  for (const [id, scale] of Object.entries(presets)) {
    if (scalesEqual(current, scale)) return id as keyof T;
  }
  return null;
}

/** Parse a CSS colour to #rrggbb for <input type="color">. Alpha is dropped. */
export function toPickerHex(value: string): string {
  const raw = (value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1], g = raw[2], b = raw[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const h = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}`.toLowerCase();
  }
  return "#000000";
}

export const ADVANCED_TOKEN_GROUPS: { key: keyof ThemeTokens; label: string; fields: string[] }[] = [
  { key: "colors", label: "Colours", fields: ["bg", "surface", "surfaceAlt", "muted", "border", "text", "textMuted", "brand", "brandText", "accent", "success", "warning", "danger", "inverse", "inverseText"] },
  { key: "font", label: "Fonts", fields: ["display", "body", "mono"] },
  { key: "radius", label: "Corners", fields: ["sm", "md", "lg", "pill"] },
  { key: "shadow", label: "Shadow", fields: ["sm", "md", "lg"] },
  { key: "space", label: "Spacing", fields: ["xs", "sm", "md", "lg", "xl"] },
];

export interface NamedTheme {
  id: string;
  name: string;
  swatches: [string, string];
  tokens: ThemeTokens;
  builtin?: boolean;
}

function pack(id: string, name: string, swatches: [string, string], overlay: Partial<ThemeTokens>): NamedTheme {
  return { id, name, swatches, tokens: mergeTokens(overlay), builtin: true };
}

export const BUILTIN_THEMES: NamedTheme[] = [
  pack("classic", "Classic", ["#FFD600", "#0A0A0A"], {
    colors: {
      ...DEFAULT_TOKENS.colors,
      bg: "#FFFFFF",
      surface: "#FFFFFF",
      surfaceAlt: "#F7F7F7",
      muted: "#F5F5F5",
      border: "#E8E8E8",
      text: "#0A0A0A",
      textMuted: "#555555",
      brand: "#FFD600",
      brandText: "#0A0A0A",
      accent: "#0A0A0A",
      inverse: "#0A0A0A",
      inverseText: "#FFD600",
    },
  }),
  pack("midnight", "Midnight", ["#0A0A0A", "#FFD600"], {
    colors: {
      ...DEFAULT_TOKENS.colors,
      bg: "#141414",
      surface: "#1F1F1F",
      surfaceAlt: "#191919",
      muted: "#2A2A2A",
      border: "rgba(255,255,255,0.14)",
      text: "#F5F5F5",
      textMuted: "#A3A3A3",
      brand: "#FFD600",
      brandText: "#0A0A0A",
      accent: "#FFD600",
      success: "#8FD69B",
      warning: "#FFD600",
      danger: "#EB2127",
      inverse: "#0A0A0A",
      inverseText: "#FFD600",
    },
    radius: { sm: "0px", md: "4px", lg: "8px", pill: "999px" },
    shadow: { sm: "none", md: "0 8px 24px rgba(0,0,0,0.35)", lg: "0 16px 40px rgba(0,0,0,0.45)" },
  }),
  pack("harbour", "Harbour", ["#0F766E", "#0B2E2A"], {
    colors: {
      ...DEFAULT_TOKENS.colors,
      bg: "#F3FAF9",
      surface: "#FFFFFF",
      surfaceAlt: "#E7F4F2",
      muted: "#D5EDEA",
      border: "#C5E0DC",
      text: "#0B2E2A",
      textMuted: "#4A6F6A",
      brand: "#0F766E",
      brandText: "#F3FAF9",
      accent: "#0F766E",
      success: "#0F766E",
      inverse: "#0B2E2A",
      inverseText: "#F3FAF9",
    },
  }),
  pack("editorial", "Editorial", ["#F7F1E8", "#6B1D2A"], {
    colors: {
      ...DEFAULT_TOKENS.colors,
      bg: "#F7F1E8",
      surface: "#FFFBF6",
      surfaceAlt: "#F3EBE0",
      muted: "#EDE4D6",
      border: "#E0D4C4",
      text: "#2A1810",
      textMuted: "#7A6556",
      brand: "#6B1D2A",
      brandText: "#F7F1E8",
      accent: "#6B1D2A",
      inverse: "#2A1810",
      inverseText: "#F7F1E8",
    },
    font: {
      display: "Georgia, 'Times New Roman', serif",
      body: "'DM Sans', system-ui, -apple-system, sans-serif",
      mono: DEFAULT_TOKENS.font.mono,
    },
    radius: { sm: "0px", md: "2px", lg: "6px", pill: "999px" },
  }),
  pack("studio", "Studio", ["#F4F7FB", "#1E3A8A"], {
    colors: {
      ...DEFAULT_TOKENS.colors,
      bg: "#F4F7FB",
      surface: "#FFFFFF",
      surfaceAlt: "#EEF2F8",
      muted: "#E4EAF3",
      border: "#D5DDEA",
      text: "#0F172A",
      textMuted: "#64748B",
      brand: "#1E3A8A",
      brandText: "#F4F7FB",
      accent: "#2563EB",
      inverse: "#0F172A",
      inverseText: "#F4F7FB",
    },
  }),
];

export function themeFingerprint(tokens: ThemeTokens): string {
  return JSON.stringify({
    c: tokens.colors,
    f: tokens.font,
    r: tokens.radius,
    s: tokens.shadow,
    p: tokens.space,
  });
}

export function themesMatch(a: ThemeTokens, b: ThemeTokens): boolean {
  return themeFingerprint(a) === themeFingerprint(b);
}

export function namedFromSaved(id: string, name: string, tokens: Partial<ThemeTokens>): NamedTheme {
  const merged = mergeTokens(tokens);
  return {
    id,
    name,
    swatches: [toPickerHex(merged.colors.brand), toPickerHex(merged.colors.bg)],
    tokens: merged,
  };
}
