/**
 * Models write a card's state in slightly different shapes (a list of SKU strings where objects are wanted, "title" for "label",
 * the product's SKU at the top of the card). The card schemas stay strict, but the plain, unambiguous variants are put into shape
 * here, so a good answer is not thrown away over a key name and the model is not sent round another turn to fix it.
 * Nothing here adds information: a SKU still has to come from a tool result, and the catalogue still supplies every fact.
 */

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const slug = (label: string, fallback: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;

/** A product reference written as a SKU string, or as an object carrying `sku`, becomes `{ sku, ...rest }`. */
function productRef(entry: unknown): Record<string, any> | undefined {
  if (typeof entry === 'string' && entry.trim()) return { sku: entry.trim() };
  if (isObject(entry) && text(entry.sku)) return { ...entry, sku: text(entry.sku) };
  return undefined;
}

const productList = (value: unknown): Array<Record<string, any>> => (Array.isArray(value) ? value.map(productRef).filter((ref): ref is Record<string, any> => !!ref) : []);

export function normaliseCardState(cardType: string, input: unknown): Record<string, any> {
  const state: Record<string, any> = isObject(input) ? { ...input } : {};

  if (cardType === 'products') {
    if (!Array.isArray(state.products) && Array.isArray(state.skus)) state.products = state.skus;
    if (Array.isArray(state.products)) state.products = productList(state.products);
  }

  if (cardType === 'accessories' && Array.isArray(state.groups)) {
    state.groups = state.groups.filter(isObject).map((group: Record<string, any>, index: number) => {
      const label = text(group.label) || text(group.title) || text(group.name) || text(group.heading);
      const items = productList(group.items ?? group.products ?? group.skus);
      const { title: _title, name: _name, heading: _heading, products: _products, skus: _skus, purpose, ...rest } = group;
      return { ...rest, key: text(group.key) || slug(label, `group-${index + 1}`), label: label || `Group ${index + 1}`, ...(text(group.hint) || text(purpose) ? { hint: text(group.hint) || text(purpose) } : {}), items };
    });
  }

  if (cardType === 'quantity') {
    const product = productRef(state.product) || productRef(state.sku);
    if (product) state.product = product;
    else if (text(state.sku)) state.product = { sku: text(state.sku) };
  }

  if (cardType === 'visual' && Array.isArray(state.products)) state.products = productList(state.products);

  return state;
}
