import { humanizeMeasure } from '@journeyax/shared-types';

interface Length { mm: number; index: number; end: number }
const LENGTH = /(-?\d+(?:[.,]\d+)*(?:\s*(?:[x×]|[–—-])\s*-?\d+(?:[.,]\d+)*){0,3})\s*(mm|cm|m)\b(?![²³]|\s*\^\s*[23])/gi;
export function lengthEvidence(text: unknown): Length[] {
  const value = humanizeMeasure(text), out: Length[] = [];
  for (const match of value.matchAll(LENGTH)) {
    const factor = { mm: 1, cm: 10, m: 1000 }[match[2].toLowerCase()]!;
    for (const number of match[1].matchAll(/-?\d+(?:[.,]\d+)*/g)) {
      const raw = number[0].replace(/^-/, match[1].trim().startsWith('-') ? '-' : '');
      const value = /^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
      const mm = Number(value) * factor;
      if (Number.isFinite(mm)) out.push({ mm: Number(mm.toPrecision(12)), index: match.index!, end: match.index! + match[0].length });
    }
  }
  return out;
}
const same = (a: number, b: number) => Math.abs(a - b) < 0.00001;

/** Stream-local attribution follows an explicit product heading into its detail lines, never the first search result. */
export class ProductMeasurementEvidence {
  private activeSku?: string;
  private products: Array<{ sku: string; title: string; lengths: number[]; fields: Array<{ label: string; values: number[] }> }> = [];
  private customerLengths: number[] = [];
  update(products: any[], customerText: string): void {
    this.products = products.filter(product => product?.sku && product.integrity?.identityConsistent !== false).map(product => ({
      sku: String(product.sku), title: String(product.title || product.name || ''),
      lengths: [...new Set([...lengthEvidence(product.title || product.name), ...Object.values(product.specs || {}).flatMap(lengthEvidence)].map(value => value.mm))],
      fields: Object.entries(product.specs || {}).map(([label, value]) => ({ label: label.toLowerCase(), values: lengthEvidence(value).map(value => value.mm) })).filter(field => field.values.length),
    }));
    this.customerLengths = lengthEvidence(customerText).map(value => value.mm);
  }
  check(sentence: string, newSection = false): 'cross_product_measurement' | 'unattributed_product_measurement' | 'impossible_cut' | undefined {
    // Source-link destinations can contain dimension-like SKU slugs. Their URL
    // authenticity is checked separately; they are not visible measurement claims.
    sentence = sentence.replace(/https?:\/\/[^\s<>()]+/gi, value => ' '.repeat(value.length));
    const references = this.products.flatMap(product => {
      const escaped = product.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sku = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'i').exec(sentence);
      const title = product.title.length > 8 ? sentence.toLowerCase().indexOf(product.title.toLowerCase()) : -1;
      return sku || title >= 0 ? [{ product, index: sku?.index ?? title, explicitSku: !!sku }] : [];
    });
    // A model-written title cannot override the exact identifier it attributes it to.
    const named = references.some(reference => reference.explicitSku) ? references.filter(reference => reference.explicitSku) : references;
    if (newSection && !named.length) this.activeSku = undefined;
    if (named.length === 1) this.activeSku = named[0].product.sku;
    const measures = lengthEvidence(sentence);
    if (!measures.length || !this.products.length) return undefined;
    const active = this.products.find(product => product.sku === this.activeSku) ?? (this.products.length === 1 ? this.products[0] : undefined);
    const boundedCutTargets = new Set<number>();
    const cut = /\b(?:cut|trim|shorten|saw)(?:ted|ting|s|med|ming|n|ning)?\b[^.!?\n]{0,90}?\bto\s*(?:length\s*)?[:~≈]?\s*/i.exec(sentence);
    if (cut) {
      const targets = measures.filter(value => value.index >= cut.index + cut[0].length);
      const before = measures.filter(value => value.end <= cut.index + cut[0].length);
      const source = named.length === 1 ? named[0].product : active;
      const maximum = source?.lengths.length ? Math.max(...source.lengths) : before.length ? Math.max(...before.map(value => value.mm)) : undefined;
      const denied = /\b(?:cannot|can[’']t|could\s+not|not|unable\s+to)\b[^.!?\n]{0,35}$/i.test(sentence.slice(0, cut.index));
      if (maximum !== undefined && !denied && targets.some(value => value.mm > maximum + 0.00001)) return 'impossible_cut';
      if (maximum !== undefined) for (const target of targets) boundedCutTargets.add(target.index);
    }
    const productAssertion = named.length > 0 || /\b(?:width|height|depth|length|thick(?:ness)?|wide|deep|tall|long|dimensions?|measures?|cut|trim)\b/i.test(sentence);
    if (!productAssertion) return undefined;
    for (const measure of measures) {
      if (boundedCutTargets.has(measure.index)) continue;
      // A customer's own measurements remain available for acknowledgement and questions.
      const before = sentence.slice(Math.max(0, measure.index - 65), measure.index);
      if (!named.length && this.customerLengths.some(value => same(value, measure.mm)) && /\b(?:your|you\s+(?:said|provided|measured)|available)\s+(?:[A-Za-z-]+\s+){0,4}$/i.test(before)) continue;
      const subject = named.length ? [...named].sort((a, b) => Math.abs(a.index - measure.index) - Math.abs(b.index - measure.index))[0].product : active;
      if (!subject) {
        if (/\b(?:this|it|the\s+(?:product|item))\b/i.test(sentence)) return 'unattributed_product_measurement';
        continue;
      }
      if (subject.lengths.length && !subject.lengths.some(value => same(value, measure.mm))) return 'cross_product_measurement';
      const prefix = sentence.slice(0, measure.index).replace(/[*_`]/g, '').replace(/\([^)]*\)/g, ''), suffix = sentence.slice(measure.end).replace(/[*_`]/g, '');
      const aliases: Record<string, string[]> = { width: ['wide'], depth: ['deep'], height: ['tall', 'high'], length: ['long'], thickness: ['thick'] };
      for (const field of subject.fields) {
        const words = [field.label, ...(aliases[field.label] || [])].map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        if ((new RegExp(`\\b(?:${words})\\s*(?::|is|of|=)?\\s*$`, 'i').test(prefix) || new RegExp(`^\\s*(?:${words})\\b`, 'i').test(suffix)) && !field.values.some(value => same(value, measure.mm))) return 'cross_product_measurement';
      }
    }
    return undefined;
  }
}
