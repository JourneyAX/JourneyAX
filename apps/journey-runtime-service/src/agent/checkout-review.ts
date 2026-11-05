/**
 * The last look before payment, built from the order itself.
 *
 * Nothing here is written by a model: each line comes from what the customer has in their order and what the catalogue (and the
 * knowledge, for warranty) says about that product. A fact the record does not carry is left out, never filled in. The words on the card
 * are the tenant's own (pack `extensions.checkoutReview.labels`); the platform's plain wording is only the fallback.
 */
import { pieceSizeFromName, permitsPieceArea, statedCoverage } from './quantity-estimate';

export const DEFAULT_REVIEW_LABELS: Record<string, string> = {
  heading: 'Before you pay',
  intro: 'A last look at your order. Each line below comes from our own records.',
  summaryAll: 'All {total} checks look right',
  summarySome: '{ok} of {total} checks look right, {look} worth a look',
  quantities: 'Quantities',
  quantitiesOk: 'Quantities are as you chose them',
  quantitiesLook: 'Check these match what you need',
  covers: 'Covers about {area} {unit}',
  coverPiece: 'each piece covers {each} {unit}',
  coverPack: 'one pack covers {each} {unit}',
  areaUnit: 'm²',
  quantityAsChosen: 'Quantity as you chose it',
  checkQuantity: 'Check my quantity',
  checkQuantityText: 'Please check the quantity of {title} for me: how many do I need for my area?',
  accessories: 'Things you may still need',
  accessoriesNone: 'Nothing else is suggested for what is in your order',
  accessoriesSome: 'Suggestions to check, not confirmed requirements',
  add: 'Add',
  fulfilment: 'Pick-up or delivery',
  fulfilmentOk: 'Every item can be collected or delivered',
  fulfilmentLook: 'Worth knowing before you pay',
  pickupOnly: 'Pick-up only',
  stockAt: 'Catalogue lists {available} of {total} branches',
  stockUnconfirmed: 'Branch stock has not been checked',
  yourBranch: 'At {branch}: {status}',
  noBranch: 'No branch chosen yet',
  chooseBranch: 'Choose my branch',
  chooseBranchText: 'Which branch is closest to me, and is everything in my order in stock there?',
  warranty: 'Warranty and guides',
  warrantyOk: 'Warranty and guides are on file',
  warrantyLook: 'Some warranty details are not on file yet',
  warrantyOn: 'Warranty on file',
  catalogueWarrantyOn: 'Catalogue warranty duration',
  warrantyNone: 'No warranty details on file yet; we will confirm with the maker',
  askWarranty: 'Ask about the warranty',
  askWarrantyText: 'What warranty does {title} have, and what does it cover?',
  guideOn: 'Guide available',
  explainGuide: 'Explain the guide',
  explainGuideText: 'Explain the guide for {title} to me.',
  pay: 'Take me to payment',
  discontinued: 'No longer sold: please take this out of your order',
};

export interface ReviewLine {
  sku: string;
  title: string;
  category?: string;
  categoryPath?: string[];
  quantity: number;
  imageUrl?: string;
  discontinued?: boolean;
  /** What the product record says about collecting and delivery. */
  pickupOnly?: boolean;
  deliveryOptions?: string[];
  branchesAvailable?: number;
  branchesTotal?: number;
  /** Text the record offers about how much one pack covers (description, highlights). */
  coverageTexts?: string[];
  /** The status a branch check gave for this line, when the customer has chosen a branch. */
  branchStatus?: string;
  /** The first words of the warranty the knowledge has verified for this product, or undefined. */
  warranty?: string;
  catalogueWarranty?: string;
  /** Titles of the guides kept with this product. */
  guides?: string[];
}

export interface ReviewSuggestion { sku: string; title: string; imageUrl?: string; reason?: string }

export interface ReviewInput {
  lines: ReviewLine[];
  suggestions: ReviewSuggestion[];
  branch?: { id?: string; name?: string };
  labels?: Record<string, string>;
  deliveryLabels?: Record<string, string>;
  coveragePatterns?: string[];
  minPieceSideMm?: number;
  pieceAreaCategories?: string[];
  maxAccessories?: number;
}

export interface ReviewRow {
  key: string; title: string; detail?: string; ok: boolean; warn: boolean; imageUrl?: string;
  actionLabel?: string; actionText?: string; actionSku?: string; hasMessage: boolean; hasAdd: boolean;
}
export interface ReviewSection { title: string; summary: string; ok: boolean; warn: boolean; rows: ReviewRow[] }
export interface ReviewState {
  heading: string; intro?: string; summary: string;
  quantity: ReviewSection; accessories: ReviewSection; fulfilment: ReviewSection; warranty: ReviewSection;
  payLabel: string;
}

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
const round = (value: number) => String(Math.round(value * 10) / 10);
const round2 = (value: number) => String(Math.round(value * 100) / 100);
/** "clickAndCollect" → "Click and collect": the fallback when the tenant has not worded a fulfilment code. */
const humanise = (code: string) => {
  const words = code.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function buildReview(input: ReviewInput): ReviewState {
  const L = { ...DEFAULT_REVIEW_LABELS, ...(input.labels || {}) };
  const unit = L.areaUnit;
  const row = (over: Partial<ReviewRow> & { key: string; title: string }): ReviewRow => ({
    ok: true, warn: false, hasMessage: Boolean(over.actionText && !over.actionSku), hasAdd: Boolean(over.actionSku), ...over,
  });
  const section = (title: string, rows: ReviewRow[], okSummary: string, lookSummary: string): ReviewSection => {
    const warn = rows.some((r) => r.warn);
    return { title, summary: warn ? lookSummary : okSummary, ok: !warn, warn, rows };
  };

  // 1. Quantities: what the number covers, so the customer can tell whether it is the area they have.
  const quantityRows = input.lines.map((line) => {
    if (line.discontinued) return row({ key: `q-${line.sku}`, title: `${line.quantity} × ${line.title}`, detail: L.discontinued, ok: false, warn: true });
    const piece = permitsPieceArea(line, input) ? pieceSizeFromName(line.title, input.minPieceSideMm) : undefined;
    const pack = piece ? undefined : statedCoverage(line.coverageTexts || [], input.coveragePatterns);
    const each = piece ? (piece.length * piece.width) / 1e6 : pack;
    if (each && each > 0) {
      const covered = each * line.quantity;
      return row({
        key: `q-${line.sku}`, title: `${line.quantity} × ${line.title}`,
        detail: `${fill(L.covers, { area: round(covered), unit })} (${fill(piece ? L.coverPiece : L.coverPack, { each: round2(each), unit })})`,
        ok: false, warn: true, actionLabel: L.checkQuantity, actionText: fill(L.checkQuantityText, { title: line.title }),
      });
    }
    return row({ key: `q-${line.sku}`, title: `${line.quantity} × ${line.title}`, detail: L.quantityAsChosen });
  });

  // 2. What else the order may need: suggestions the catalogue and knowledge give, minus what is already in the order.
  const inOrder = new Set(input.lines.map((line) => line.sku));
  const accessoryRows = input.suggestions
    .filter((item) => item.sku && !inOrder.has(item.sku))
    .slice(0, input.maxAccessories ?? 4)
    .map((item) => row({ key: `a-${item.sku}`, title: item.title, detail: item.reason, imageUrl: item.imageUrl, ok: false, warn: true, actionLabel: L.add, actionSku: item.sku }));

  // 3. Pick-up or delivery, and where it is in stock.
  const label = (code: string) => input.deliveryLabels?.[code] || humanise(code);
  const branchName = input.branch?.name || input.branch?.id;
  const fulfilmentRows = input.lines.map((line) => {
    const parts: string[] = [];
    let warn = false;
    if (line.pickupOnly) { parts.push(L.pickupOnly); warn = true; }
    else if (line.deliveryOptions && line.deliveryOptions.length > 0) parts.push(line.deliveryOptions.map(label).join(' or '));
    if (line.branchesAvailable !== undefined && line.branchesTotal !== undefined && line.branchesTotal > 0) {
      parts.push(fill(L.stockAt, { available: line.branchesAvailable, total: line.branchesTotal }));
      if (line.branchesAvailable / line.branchesTotal < 0.25) warn = true;
    }
    if (branchName && line.branchStatus) {
      parts.push(fill(L.yourBranch, { branch: branchName, status: line.branchStatus }));
      if (!/in stock/i.test(line.branchStatus)) warn = true;
    } else {
      parts.push(L.stockUnconfirmed);
      warn = true;
    }
    const needsBranch = !branchName;
    return row({
      key: `f-${line.sku}`, title: line.title, detail: parts.join('. ') || undefined, ok: !warn, warn,
      ...(needsBranch && (line.pickupOnly || warn) ? { actionLabel: L.chooseBranch, actionText: L.chooseBranchText } : {}),
    });
  });

  // 4. Warranty and guides.
  const warrantyRows = input.lines.map((line) => {
    const parts: string[] = [];
    if (line.warranty) parts.push(`${L.warrantyOn}: ${clip(line.warranty, 140)}`);
    else { if (line.catalogueWarranty) parts.push(`${L.catalogueWarrantyOn}: ${line.catalogueWarranty}`); parts.push(L.warrantyNone); }
    if (line.guides && line.guides.length > 0) parts.push(`${L.guideOn}: ${line.guides.slice(0, 2).join(', ')}`);
    const missing = !line.warranty;
    return row({
      key: `w-${line.sku}`, title: line.title, detail: parts.join('. '), ok: !missing, warn: missing,
      ...(missing
        ? { actionLabel: L.askWarranty, actionText: fill(L.askWarrantyText, { title: line.title }) }
        : line.guides && line.guides.length > 0 ? { actionLabel: L.explainGuide, actionText: fill(L.explainGuideText, { title: line.title }) } : {}),
    });
  });

  const quantity = section(L.quantities, quantityRows, L.quantitiesOk, L.quantitiesLook);
  const accessories = section(L.accessories, accessoryRows, L.accessoriesNone, L.accessoriesSome);
  if (accessoryRows.length === 0) accessories.rows = [];
  const fulfilment = section(L.fulfilment, fulfilmentRows, L.fulfilmentOk, L.fulfilmentLook);
  const warranty = section(L.warranty, warrantyRows, L.warrantyOk, L.warrantyLook);
  const sections = [quantity, accessories, fulfilment, warranty];
  const looks = sections.filter((s) => s.warn).length;
  return {
    heading: L.heading, intro: L.intro,
    summary: looks === 0 ? fill(L.summaryAll, { total: sections.length }) : fill(L.summarySome, { ok: sections.length - looks, total: sections.length, look: looks }),
    quantity, accessories, fulfilment, warranty, payLabel: L.pay,
  };
}
