/**
 * The guided catalogue-mapping form, as pure data. The form edits the same mapping the service validates and the runtime
 * reads; nothing here decides what a field means — it only shapes text into the mapping and back, and rejects what the
 * service would reject so a person finds out while typing, not when saving. Parity with the service's schema is tested.
 */
import { parseList } from "./okf-model";

export type MappingGroup = "identity" | "category" | "pricing" | "stock" | "lifecycle" | "attributes" | "advanced";

export const GROUP_LABELS: Record<MappingGroup, { title: string; help: string }> = {
  identity: { title: "Product identity and text", help: "Which fields hold a product's code, name, description and brand, and which are searched." },
  category: { title: "Categories", help: "Where a product's category and its department → group → category path are stored." },
  pricing: { title: "Price and currency", help: "Where prices live, whether they are whole currency units or cents, and where the currency is declared. A price with no declared currency is never quoted." },
  stock: { title: "Stock", help: "Where availability is recorded." },
  lifecycle: { title: "Product lifecycle", help: "Values that hide a product from customers, or mark it as price-on-application." },
  attributes: { title: "Attributes and media", help: "Where specifications, images and certifications are stored." },
  advanced: { title: "Advanced", help: "Candidate limit and other tuning." },
};

export type ListKey =
  | "identifierPaths" | "titlePaths" | "descriptionPaths" | "brandPaths" | "searchPaths"
  | "categoryPaths" | "categoryScopePaths" | "categoryHierarchyPaths"
  | "stock.booleanPaths" | "stock.countPaths"
  | "availability.excludeFlagPaths" | "availability.statusPaths" | "availability.excludedStatuses" | "availability.unpricedStatuses"
  | "attributeContainers" | "imagePaths" | "certificationPaths" | "quantityPaths";

export interface ListField {
  key: ListKey;
  group: MappingGroup;
  label: string;
  help: string;
  /** Field paths are checked against the path grammar; plain values (lifecycle words) are only required to be non-empty. */
  kind: "path" | "value";
}

export const LIST_FIELDS: ListField[] = [
  { key: "identifierPaths", group: "identity", kind: "path", label: "Product code (SKU)", help: "First field with a value is the product's code. Used for lookups and baskets." },
  { key: "titlePaths", group: "identity", kind: "path", label: "Name", help: "The name shown to customers." },
  { key: "descriptionPaths", group: "identity", kind: "path", label: "Description", help: "Shown with the product." },
  { key: "brandPaths", group: "identity", kind: "path", label: "Brand", help: "" },
  { key: "searchPaths", group: "identity", kind: "path", label: "Searched fields", help: "Customer words are matched against all of these." },
  { key: "categoryPaths", group: "category", kind: "path", label: "Category name", help: "The product's own category label." },
  { key: "categoryScopePaths", group: "category", kind: "path", label: "Fields matched by category names", help: "A concept that names a category by words matches products whose value here contains it." },
  { key: "categoryHierarchyPaths", group: "category", kind: "path", label: "Category path (department → group → category)", help: "An array on the product. Path scopes are matched against it segment by segment, exactly." },
  { key: "stock.booleanPaths", group: "stock", kind: "path", label: "In stock (true / false)", help: "First field holding a true/false value is used." },
  { key: "stock.countPaths", group: "stock", kind: "path", label: "Available quantity", help: "A number above zero means in stock." },
  { key: "availability.excludeFlagPaths", group: "lifecycle", kind: "path", label: "Fields that are true when a product must be hidden", help: "e.g. a discontinued flag." },
  { key: "availability.statusPaths", group: "lifecycle", kind: "path", label: "Lifecycle status fields", help: "Text fields whose value says where the product is in its life." },
  { key: "availability.excludedStatuses", group: "lifecycle", kind: "value", label: "Status values that hide a product", help: "Compared without regard to case." },
  { key: "availability.unpricedStatuses", group: "lifecycle", kind: "value", label: "Status values meaning price on application", help: "The product is shown without a price and cannot be added to a basket." },
  { key: "attributeContainers", group: "attributes", kind: "path", label: "Specification containers", help: "Objects on the product whose entries are its attributes." },
  { key: "imagePaths", group: "attributes", kind: "path", label: "Image", help: "" },
  { key: "certificationPaths", group: "attributes", kind: "path", label: "Certifications", help: "" },
  { key: "quantityPaths", group: "attributes", kind: "path", label: "Pack quantity", help: "" },
];

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const RANGE_KEY = /^[A-Za-z0-9_]+$/;
const CURRENCY = /^[A-Za-z]{3}$/;

export type CurrencyMode = "field" | "fixed" | "none";

export interface PriceSourceForm {
  path: string;
  unit: "major" | "minor" | "";
  currencyMode: CurrencyMode;
  currencyPath: string;
  currency: string;
  rangeKey: string;
}

export interface MappingForm {
  lists: Record<ListKey, string>;
  priceSources: PriceSourceForm[];
  /** "" = platform default. */
  requireDeclaredCurrency: "" | "yes" | "no";
  attributeAliases: Array<{ key: string; aliases: string }>;
  candidateLimit: string;
  /** Parts of the mapping this form does not edit; they are carried through unchanged. */
  preserved: { version?: string; componentCategoryRules?: Record<string, unknown> };
}

export const emptyPriceSource = (): PriceSourceForm => ({ path: "", unit: "", currencyMode: "field", currencyPath: "", currency: "", rangeKey: "" });

const get = (mapping: any, key: string): unknown => key.split(".").reduce((value: any, part) => (value == null ? undefined : value[part]), mapping);

export function emptyForm(): MappingForm {
  return {
    lists: Object.fromEntries(LIST_FIELDS.map((field) => [field.key, ""])) as Record<ListKey, string>,
    priceSources: [], requireDeclaredCurrency: "", attributeAliases: [], candidateLimit: "", preserved: {},
  };
}

/** Mapping (as stored) → form text. Anything unset stays empty, which means "use the platform default". */
export function fromMapping(mapping: Record<string, any> | null | undefined): MappingForm {
  const form = emptyForm();
  if (!mapping) return form;
  for (const field of LIST_FIELDS) {
    const value = get(mapping, field.key);
    if (Array.isArray(value)) form.lists[field.key] = value.join(", ");
  }
  form.priceSources = (mapping.pricing?.sources ?? []).map((source: any): PriceSourceForm => ({
    path: source.path ?? "", unit: source.unit ?? "", rangeKey: source.rangeKey ?? "",
    currencyMode: source.currencyPath ? "field" : source.currency ? "fixed" : "none",
    currencyPath: source.currencyPath ?? "", currency: source.currency ?? "",
  }));
  if (typeof mapping.pricing?.requireDeclaredCurrency === "boolean") form.requireDeclaredCurrency = mapping.pricing.requireDeclaredCurrency ? "yes" : "no";
  form.attributeAliases = Object.entries(mapping.attributeAliases ?? {}).map(([key, aliases]) => ({ key, aliases: (aliases as string[]).join(", ") }));
  if (typeof mapping.candidateLimit === "number") form.candidateLimit = String(mapping.candidateLimit);
  form.preserved = {
    ...(mapping.version ? { version: mapping.version } : {}),
    ...(mapping.componentCategoryRules ? { componentCategoryRules: mapping.componentCategoryRules } : {}),
  };
  return form;
}

/** Form → mapping. Empty fields are left out (platform default); an entirely empty form is `null`. */
export function toMapping(form: MappingForm): Record<string, any> | null {
  const mapping: Record<string, any> = {};
  const set = (key: string, value: unknown) => {
    const parts = key.split(".");
    let target = mapping;
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {});
    target[parts[parts.length - 1]] = value;
  };
  for (const field of LIST_FIELDS) {
    const values = parseList(form.lists[field.key]);
    if (values.length) set(field.key, values);
  }
  const sources = form.priceSources.filter((source) => source.path.trim()).map((source) => ({
    path: source.path.trim(), unit: source.unit as "major" | "minor",
    ...(source.currencyMode === "field" && source.currencyPath.trim() ? { currencyPath: source.currencyPath.trim() } : {}),
    ...(source.currencyMode === "fixed" && source.currency.trim() ? { currency: source.currency.trim().toUpperCase() } : {}),
    ...(source.rangeKey.trim() ? { rangeKey: source.rangeKey.trim() } : {}),
  }));
  if (sources.length) set("pricing.sources", sources);
  if (form.requireDeclaredCurrency) set("pricing.requireDeclaredCurrency", form.requireDeclaredCurrency === "yes");
  const aliases = form.attributeAliases.filter((entry) => entry.key.trim());
  if (aliases.length) set("attributeAliases", Object.fromEntries(aliases.map((entry) => [entry.key.trim(), parseList(entry.aliases)])));
  if (form.candidateLimit.trim()) set("candidateLimit", Number(form.candidateLimit));
  if (form.preserved.componentCategoryRules) set("componentCategoryRules", form.preserved.componentCategoryRules);
  if (Object.keys(mapping).length && form.preserved.version) set("version", form.preserved.version);
  return Object.keys(mapping).length ? mapping : null;
}

export type FormErrors = Record<string, string>;

/** Mirrors the service's schema: the same path grammar and bounds, reported next to the field that is wrong. */
export function validateForm(form: MappingForm): FormErrors {
  const errors: FormErrors = {};
  for (const field of LIST_FIELDS) {
    const values = parseList(form.lists[field.key]);
    if (field.kind === "path") {
      const bad = values.filter((value) => !FIELD_PATH.test(value));
      if (bad.length) errors[field.key] = `Not a field name: ${bad.slice(0, 3).join(", ")}. Use letters, digits, underscores and dots (e.g. price.amount).`;
    }
  }
  form.priceSources.forEach((source, index) => {
    const filled = source.path.trim() || source.unit || source.currencyPath.trim() || source.currency.trim();
    if (!filled) return;
    const at = `priceSources.${index}`;
    if (!source.path.trim()) errors[`${at}.path`] = "Say which field holds the price.";
    else if (!FIELD_PATH.test(source.path.trim())) errors[`${at}.path`] = "Not a field name.";
    if (!source.unit) errors[`${at}.unit`] = "Say whether the price is in whole currency units or in cents.";
    if (source.rangeKey.trim() && !RANGE_KEY.test(source.rangeKey.trim())) errors[`${at}.rangeKey`] = "Use letters, digits and underscores.";
    if (source.currencyMode === "field" && source.currencyPath.trim() && !FIELD_PATH.test(source.currencyPath.trim())) errors[`${at}.currencyPath`] = "Not a field name.";
    if (source.currencyMode === "fixed" && !CURRENCY.test(source.currency.trim())) errors[`${at}.currency`] = "A three-letter currency code, e.g. NZD.";
    if (source.currencyMode === "field" && !source.currencyPath.trim()) errors[`${at}.currencyPath`] = "Name the field that declares the currency, or choose another option.";
  });
  const seen = new Set<string>();
  form.attributeAliases.forEach((entry, index) => {
    if (!entry.key.trim() && !entry.aliases.trim()) return;
    const at = `attributeAliases.${index}`;
    if (!entry.key.trim()) errors[`${at}.key`] = "Name the attribute.";
    else if (seen.has(entry.key.trim())) errors[`${at}.key`] = "Each attribute can be listed once.";
    else seen.add(entry.key.trim());
    const aliases = parseList(entry.aliases);
    if (aliases.length === 0) errors[`${at}.aliases`] = "List the fields that hold it.";
  });
  if (form.candidateLimit.trim()) {
    const n = Number(form.candidateLimit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) errors.candidateLimit = "A whole number from 1 to 1000.";
  }
  return errors;
}

export type FieldMeaning =
  | "identifier" | "title" | "description" | "brand" | "category" | "categoryPath" | "price" | "priceInCents" | "currency"
  | "stockFlag" | "stockCount" | "status" | "image" | "searchable";

export const MEANINGS: Array<{ value: FieldMeaning; label: string }> = [
  { value: "identifier", label: "Product code (SKU)" }, { value: "title", label: "Name" }, { value: "description", label: "Description" },
  { value: "brand", label: "Brand" }, { value: "category", label: "Category name" }, { value: "categoryPath", label: "Category path" },
  { value: "price", label: "Price (whole units)" }, { value: "priceInCents", label: "Price (cents)" }, { value: "currency", label: "Currency of the price" },
  { value: "stockFlag", label: "In stock (true/false)" }, { value: "stockCount", label: "Available quantity" },
  { value: "status", label: "Lifecycle status" }, { value: "image", label: "Image" }, { value: "searchable", label: "Searched by customer words" },
];

const MEANING_LIST: Partial<Record<FieldMeaning, ListKey>> = {
  identifier: "identifierPaths", title: "titlePaths", description: "descriptionPaths", brand: "brandPaths", category: "categoryPaths",
  categoryPath: "categoryHierarchyPaths", stockFlag: "stock.booleanPaths", stockCount: "stock.countPaths", status: "availability.statusPaths",
  image: "imagePaths", searchable: "searchPaths",
};

/**
 * "This field on my products means …": adds it to the right place. A list gains the field if it is not already there;
 * a price becomes a price source; a currency becomes the currency field of the first source that has none.
 */
export function assignFieldMeaning(form: MappingForm, path: string, meaning: FieldMeaning): MappingForm {
  const next: MappingForm = structuredClone(form);
  const list = MEANING_LIST[meaning];
  if (list) {
    const current = parseList(next.lists[list]);
    if (!current.includes(path)) next.lists[list] = [...current, path].join(", ");
    return next;
  }
  if (meaning === "price" || meaning === "priceInCents") {
    const unit = meaning === "price" ? "major" : "minor";
    if (!next.priceSources.some((source) => source.path === path)) next.priceSources.push({ ...emptyPriceSource(), path, unit });
    return next;
  }
  if (meaning === "currency") {
    const open = next.priceSources.find((source) => !source.currencyPath.trim() && source.currencyMode !== "fixed") ?? next.priceSources[0];
    if (open) { open.currencyMode = "field"; open.currencyPath = path; }
    else next.priceSources.push({ ...emptyPriceSource(), currencyPath: path });
  }
  return next;
}

/** Plain-language summary of a check result for the form header. */
export function describeIssue(issue: { severity: string; affected: number; share: number }): string {
  if (issue.affected === 0) return "";
  return `${issue.affected} product${issue.affected === 1 ? "" : "s"} (${Math.round(issue.share * 100)}% of the sample)`;
}
