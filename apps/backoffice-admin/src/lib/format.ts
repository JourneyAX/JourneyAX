/**
 * Small label-formatting helpers. Used as a fallback for any snake_case or
 * camelCase key (intents, stages, etc.) that doesn't have an explicit label
 * map entry — so unmapped keys degrade to something readable instead of
 * rendering raw (e.g. `bathroom_remodel` -> "Bathroom remodel").
 */
export function prettifySnakeCase(key: string): string {
  if (!key) return key;
  const words = key.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function prettifyCamelCase(key: string): string {
  if (!key) return key;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Prettify a key regardless of whether it's snake_case or camelCase. */
export function prettifyKey(key: string): string {
  if (!key) return key;
  return key.includes("_") ? prettifySnakeCase(key) : prettifyCamelCase(key);
}
