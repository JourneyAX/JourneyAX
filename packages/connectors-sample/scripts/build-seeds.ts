/**
 * Builds the sample connectors' seed files from the PlaceMakers data folder (read only), and writes each connector's README.
 *
 *   npx tsx packages/connectors-sample/scripts/build-seeds.ts
 *   PLACEMAKERS_DATA_DIR=/path/to/Placemaker-data npx tsx packages/connectors-sample/scripts/build-seeds.ts
 *
 * Real: products, their specifications and documents, branch names, codes and phone numbers, product page paths. Everything else
 * (people, trade accounts, orders, carts, cases, stock counts, traffic, sessions) is invented, from a seeded generator so a rebuild gives
 * the same files, and carries `sample: true`. A record that mixes real and invented values is sample too. No customer data is read or implied.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { scoreText } from '../src/engine';
import type { CollectionProvenance, ConnectorFile, Rec, SeedFile } from '../src/types';
import { applySeedStages } from './seed-stages';
import { readme, seedText } from './seed-writing';

const REPO = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = process.env.PLACEMAKERS_DATA_DIR || path.resolve(REPO, '..', '..', 'jax-whatsapp-open-model', 'Placemaker-data');
const OUT = path.resolve(__dirname, '..', 'connectors');
const TENANT = 'placemakers';
const PRODUCT_LINES_TO_READ = 14000;
const PRODUCT_COUNT = 100;

// ---------------------------------------------------------------- a seeded generator, so a rebuild gives the same files
const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
class Rng {
  private state: number;
  constructor(seed: string) { this.state = hash(seed); }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]; }
  chance(p: number): boolean { return this.next() < p; }
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) { roll -= weight; if (roll <= 0) return item; }
    return items[items.length - 1][0];
  }
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]);
    return out;
  }
}

const REFERENCE_DAY = Date.UTC(2026, 8, 1); // 1 September 2026: the day the data was last looked at
const DAY = 86_400_000;
const isoAt = (daysAgo: number, minutesIntoDay = 0) => new Date(REFERENCE_DAY - daysAgo * DAY + minutesIntoDay * 60_000).toISOString();
const dateOnly = (daysAgo: number) => isoAt(daysAgo).slice(0, 10);
const money = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number, width: number) => String(n).padStart(width, '0');
const clean = (text: unknown, max: number) => String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------- word pools for invented people and businesses
const FIRST_NAMES = ['Aroha', 'Hemi', 'Tane', 'Mere', 'Rangi', 'Kiri', 'Wiremu', 'Anika', 'Callum', 'Fiona', 'Graham', 'Hannah', 'Ian', 'Jess', 'Kyle', 'Leah', 'Mason', 'Nina', 'Owen', 'Priya', 'Quinn', 'Ruth', 'Sione', 'Tessa', 'Una', 'Vikram', 'Wendy', 'Xavier', 'Yvette', 'Zane', 'Ben', 'Carla', 'Dev', 'Ella', 'Finn', 'Grace'];
const LAST_NAMES = ['Harlow', 'Ngata', 'Carrow', 'Pemberton', 'Whitaker', 'Tasman', 'Ashworth', 'Fenwick', 'Marlow', 'Aldridge', 'Hartley', 'Brennan', 'Kereama', 'Lindgren', 'Paterson', 'Ormond', 'Redfern', 'Stanbridge', 'Talbot', 'Yardley', 'Thornbury', 'Bellamy', 'Dunmore', 'Ellery', 'Sutherland', 'Rowe', 'Penrose', 'Whittle', 'Okafor', 'Nguyen', 'Patel', 'Tomlinson', 'Crawley', 'Halloran', 'Mackie', 'Vance'];
const TRADES: Array<[string, string]> = [['builder', 'Builders'], ['joiner', 'Joinery'], ['roofer', 'Roofing'], ['landscaper', 'Landscapes'], ['plumber', 'Plumbing'], ['electrician', 'Electrical'], ['painter', 'Painters'], ['fencer', 'Fencing'], ['concreter', 'Concrete'], ['framer', 'Framing']];
const personName = (r: Rng) => `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}`;

// ---------------------------------------------------------------- reading the PlaceMakers data (read only)
interface SourceProduct extends Rec { sku: string }

async function readProducts(): Promise<SourceProduct[]> {
  const file = path.join(DATA_DIR, 'master', 'placemakers_product_master.jsonl');
  if (!existsSync(file)) throw new Error(`Product data not found at ${file}. Set PLACEMAKERS_DATA_DIR.`);
  const candidates: Array<{ quality: number; product: SourceProduct }> = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let read = 0;
  for await (const line of lines) {
    if (++read > PRODUCT_LINES_TO_READ) break;
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    const department = d.categoryPathNames?.[0]?.[0];
    if (!d.sku || !d.title || !(d.price > 0) || d.discontinued || d.delisted || d.availability === false || !department || department === 'specials') continue;
    const specifications = (Array.isArray(d.specifications) ? d.specifications : []).filter((s: Rec) => s && s.name && s.value !== null && s.value !== undefined && s.value !== '');
    const documents = (Array.isArray(d.documents) ? d.documents : []).filter((x: Rec) => x && x.title && x.url);
    const description = clean(d.descriptionFull || d.description, 400);
    const features = (Array.isArray(d.features) ? d.features : []).map((f: unknown) => clean(f, 160)).filter(Boolean);
    const quality = (specifications.length >= 3 ? 2 : specifications.length > 0 ? 1 : 0) + (documents.length > 0 ? 2 : 0) + (description.length > 80 ? 1 : 0) + (features.length > 0 ? 1 : 0);
    if (quality < 4) continue;
    candidates.push({
      quality,
      product: {
        sku: String(d.sku), title: clean(d.title, 160), brand: clean(d.brand, 60), subBrand: clean(d.subBrand, 60), description,
        price: money(d.price), discountPrice: money(d.discountPrice > 0 ? d.discountPrice : d.price), currency: 'NZD', unitOfMeasure: String(d.unitOfMeasure || 'EA'),
        department, categoryPath: (d.categoryPathNames?.[0] ?? []).join(' > '), url: String(d.url || d.pageUrl || ''), imageUrl: String(d.thumb_image || ''),
        barcode: String(d.barcode || ''), keywords: (Array.isArray(d.keywords) ? d.keywords : []).map((k: unknown) => clean(k, 40)).filter(Boolean).slice(0, 10),
        features: features.slice(0, 5),
        specifications: specifications.slice(0, 12).map((s: Rec) => ({ name: clean(s.name, 60), value: clean(s.value, 80), unit: clean(s.unit, 20) })),
        documents: documents.slice(0, 6).map((x: Rec) => ({ title: clean(x.title, 120), url: String(x.url), type: String(x.type || 'link') })),
        accessories: (Array.isArray(d.accessories) ? d.accessories : []).slice(0, 4).map((a: Rec) => ({ sku: String(a.sku || ''), name: clean(a.name, 100) })).filter((a: Rec) => a.sku),
      },
    });
  }
  // The best-documented products, spread evenly over the departments.
  const byDepartment = new Map<string, Array<{ quality: number; product: SourceProduct }>>();
  for (const entry of candidates) {
    const list = byDepartment.get(entry.product.department);
    if (list) list.push(entry); else byDepartment.set(entry.product.department, [entry]);
  }
  for (const list of byDepartment.values()) list.sort((a, b) => b.quality - a.quality || a.product.sku.localeCompare(b.product.sku));
  const departments = [...byDepartment.keys()].sort();
  const chosen: SourceProduct[] = [];
  for (let round = 0; chosen.length < PRODUCT_COUNT && round < 50; round++) {
    for (const department of departments) {
      const entry = byDepartment.get(department)![round];
      if (entry && chosen.length < PRODUCT_COUNT) chosen.push(entry.product);
    }
  }
  if (chosen.length < PRODUCT_COUNT) throw new Error(`Only ${chosen.length} suitable products in the first ${PRODUCT_LINES_TO_READ} lines.`);
  return chosen.sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Approximate town-centre coordinates, entered by hand for each branch town: the data holds no coordinates. */
const TOWN_COORDINATES: Record<string, [number, number]> = {
  ALBANY: [-36.73, 174.70], ALEXANDRA: [-45.25, 169.38], ASHBURTON: [-43.90, 171.74], BLENHEIM: [-41.51, 173.96], 'CLARENCE STREET HAMILTON': [-37.79, 175.28],
  'COOK ST': [-36.85, 174.76], 'CRANFORD ST': [-43.50, 172.64], CROMWELL: [-45.04, 169.20], DANNEVIRKE: [-40.21, 176.10], DUNEDIN: [-45.87, 170.50],
  'EVANS BAY': [-41.29, 174.79], GISBORNE: [-38.66, 178.02], GORE: [-46.10, 168.94], HASTINGS: [-39.64, 176.84], 'HAVELOCK NORTH': [-39.67, 176.88],
  HAWERA: [-39.59, 174.28], HUNTLY: [-37.56, 175.16], 'HUTT CITY': [-41.23, 174.90], INVERCARGILL: [-46.41, 168.35], KAIAPOI: [-43.38, 172.66],
  KAITAIA: [-35.11, 173.26], KAIWHARAWHARA: [-41.26, 174.78], KAPITI: [-40.91, 175.01], KERIKERI: [-35.23, 173.95], LEVIN: [-40.62, 175.28],
  MANGAWHAI: [-36.13, 174.58], MORRINSVILLE: [-37.65, 175.53], MOSGIEL: [-45.90, 170.35], MOTUEKA: [-41.11, 173.01], 'MT MAUNGANUI': [-37.64, 176.19],
  'MT WELLINGTON': [-36.91, 174.84], NAPIER: [-39.49, 176.91], NELSON: [-41.27, 173.28], 'NEW LYNN': [-36.91, 174.68], OAMARU: [-45.10, 170.97],
  'OHAKUNE DEPOT': [-39.42, 175.56], PAKURANGA: [-36.91, 174.88], 'PALMERSTON NTH': [-40.35, 175.61], PORIRUA: [-41.13, 174.84], PUKEKOHE: [-37.20, 174.90],
  QUEENSTOWN: [-45.02, 168.74], RICCARTON: [-43.53, 172.58], ROLLESTON: [-43.59, 172.38], ROTORUA: [-38.14, 176.25], 'SAXTON RD': [-41.31, 173.23],
  SILVERDALE: [-36.62, 174.68], TAKANINI: [-37.06, 174.92], TARANAKI: [-39.06, 174.08], TAUPO: [-38.69, 176.07], 'TE ANAU': [-45.41, 167.72],
  'TE RAPA': [-37.74, 175.17], THAMES: [-37.14, 175.54], TIMARU: [-44.40, 171.25], TWIZEL: [-44.26, 170.10], 'WAIHEKE IS': [-36.80, 175.10],
  WAIRARAPA: [-40.95, 175.66], 'WAIRAU PARK': [-36.78, 174.74], WANAKA: [-44.70, 169.13], WARKWORTH: [-36.40, 174.66],
  WESTGATE: [-36.81, 174.61], WHAKATANE: [-37.96, 176.99], WHANGANUI: [-39.93, 175.05], WHANGAREI: [-35.73, 174.32], WHITIANGA: [-36.83, 175.70], WINTON: [-46.15, 168.32],
};

const titleCase = (text: string) => text.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bNth\b/, 'North').replace(/\bSt\b/, 'St').replace(/\bIs\b/, 'Island').replace(/\bMt\b/, 'Mt');

function readBranches(): Rec[] {
  const file = path.join(DATA_DIR, 'master', 'placemakers_content_master.jsonl');
  const text = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((page) => String(page.url).endsWith('/online/store-locator'))
    ?.sections?.map((s: Rec) => s.text).join('\n');
  if (!text) throw new Error('The store locator page is not in the content master.');
  const lines: string[] = text.split('\n').map((line: string) => line.trim()).filter(Boolean);
  const branches: Rec[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^[A-Z][A-Z .&'-]+$/.test(lines[i]) || !/^\d{3}$/.test(lines[i + 1] ?? '')) continue;
    const name = lines[i];
    const code = lines[i + 1];
    const body: string[] = [];
    let j = i + 2;
    while (j < lines.length && !(/^[A-Z][A-Z .&'-]+$/.test(lines[j]) && /^\d{3}$/.test(lines[j + 1] ?? ''))) body.push(lines[j++]);
    const phone = body.find((line) => /^[\d ]{7,}$/.test(line) && /\d{6,}/.test(line.replace(/ /g, '')));
    const coords = TOWN_COORDINATES[name];
    if (!coords) throw new Error(`No coordinates entered for branch ${name}`);
    branches.push({
      code, branchId: `B-${code}`, name: titleCase(name), phone: phone ?? '',
      lat: coords[0], lng: coords[1], source: 'store locator page', sample: true,
    });
    i = j - 1;
  }
  return branches;
}

// ---------------------------------------------------------------- writing
const prov = (origin: CollectionProvenance['origin'], source: string, realFields: string[], madeUpFields: string[]): CollectionProvenance => ({ origin, source, realFields, madeUpFields });

// ---------------------------------------------------------------- the build
async function main() {
  const products = await readProducts();
  const branches = readBranches();
  const branchCodes = branches.map((b) => b.code as string);
  console.log(`Read ${products.length} products and ${branches.length} branches from ${DATA_DIR}`);
  const withDocs = products.filter((p) => p.documents.length > 0).length;
  if (withDocs < 60) throw new Error(`Only ${withDocs} products have documents`);

  const seeds = new Map<string, SeedFile>();
  const addSeed = (connectorId: string, collections: Record<string, Rec[]>, provenance: Record<string, CollectionProvenance>) =>
    seeds.set(connectorId, { connectorId, tenantId: TENANT, builtFrom: 'PlaceMakers product master and content master (read only), plus a seeded generator', collections, provenance });

  // ---- accounts and people (made up)
  const ra = new Rng('accounts');
  const usedNames = new Set<string>();
  const accounts: Rec[] = [];
  for (let n = 1; n <= 30; n++) {
    const [tradeType, suffix] = ra.pick(TRADES);
    let name = '';
    do { name = `${ra.pick(LAST_NAMES)} & ${ra.pick(LAST_NAMES)} ${suffix} Ltd`; } while (usedNames.has(name));
    usedNames.add(name);
    const contact = personName(ra);
    const tier = ra.weighted([['bronze', 5], ['silver', 3], ['gold', 2]] as const);
    accounts.push({
      accountId: `ACC-${pad(n, 4)}`, name, tradeType, tier, homeBranchCode: ra.pick(branchCodes), accountManager: personName(ra),
      contactName: contact, contactEmail: `${contact.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`, contactPhone: `021 555 ${pad(ra.int(100, 999) * 10 + n % 10, 4)}`,
      creditLimit: ra.pick([5000, 10000, 20000, 50000]), paymentTerms: ra.pick(['7 days', '20th of the month', '30 days']), status: ra.weighted([['active', 9], ['on_hold', 1]] as const),
      since: dateOnly(ra.int(200, 2500)), sample: true,
    });
  }

  // ---- orders, order lines, carts, cart lines (quantities and people made up; prices and SKUs real)
  const ro = new Rng('orders');
  const quantityFor = (uom: string) => (uom === 'LM' ? ro.int(10, 120) : uom === 'M2' ? ro.int(5, 60) : uom === 'EA' ? ro.int(1, 12) : ro.int(1, 30));
  const orders: Rec[] = [];
  const orderLines: Rec[] = [];
  const makeLines = (r: Rng, ownerKey: 'orderId' | 'cartId', ownerId: string, prefix: string, startLine: number) => {
    const lines: Rec[] = [];
    for (const product of r.sample(products, r.int(1, 4))) {
      const quantity = quantityFor(product.unitOfMeasure);
      lines.push({ lineId: `${prefix}${pad(startLine + lines.length, 5)}`, [ownerKey]: ownerId, sku: product.sku, title: product.title, quantity, unitOfMeasure: product.unitOfMeasure, unitPrice: product.discountPrice, lineTotal: money(quantity * product.discountPrice), sample: true });
    }
    return lines;
  };
  for (let n = 1; n <= 48; n++) {
    const orderId = `ORD-${100000 + n}`;
    const account = ro.chance(0.72) ? ro.pick(accounts) : null;
    const deliveryType = ro.chance(0.65) ? 'delivery' : 'click_and_collect';
    const status = deliveryType === 'delivery'
      ? ro.weighted([['placed', 2], ['confirmed', 3], ['picked', 2], ['dispatched', 3], ['delivered', 8], ['cancelled', 1]] as const)
      : ro.weighted([['placed', 2], ['confirmed', 3], ['picked', 2], ['ready_for_collection', 3], ['collected', 8], ['cancelled', 1]] as const);
    const lines = makeLines(ro, 'orderId', orderId, 'OL-', orderLines.length + 1);
    orderLines.push(...lines);
    orders.push({
      orderId, accountId: account?.accountId ?? null, customerType: account ? 'trade' : 'guest', status, deliveryType, branchCode: account?.homeBranchCode ?? ro.pick(branchCodes),
      placedAt: isoAt(ro.int(0, 62), ro.int(420, 1020)), currency: 'NZD', lineCount: lines.length, total: money(lines.reduce((sum, line) => sum + line.lineTotal, 0)), sample: true,
    });
  }
  orders.sort((a, b) => String(a.placedAt).localeCompare(String(b.placedAt)));
  const carts: Rec[] = [];
  const cartLines: Rec[] = [];
  for (let n = 1; n <= 30; n++) {
    const cartId = `CART-${pad(n, 4)}`;
    const account = ro.chance(0.6) ? ro.pick(accounts) : null;
    const lines = makeLines(ro, 'cartId', cartId, 'CL-', cartLines.length + 1);
    cartLines.push(...lines);
    carts.push({ cartId, accountId: account?.accountId ?? null, status: ro.weighted([['active', 5], ['abandoned', 3], ['converted', 2]] as const), branchCode: account?.homeBranchCode ?? ro.pick(branchCodes), createdAt: isoAt(ro.int(0, 20), ro.int(420, 1020)), lineCount: lines.length, sample: true });
  }
  const lineProvenance = (owner: string) => prov('mixed', 'invented lines over real products', ['sku', 'title', 'unitPrice (the real shelf price)', 'unitOfMeasure'], ['lineId', owner, 'quantity', 'lineTotal']);

  // ---- SAP Commerce
  const sapProducts = products.map((p) => ({
    sku: p.sku, title: p.title, brand: p.brand, department: p.department, categoryPath: p.categoryPath, keywords: p.keywords, unitOfMeasure: p.unitOfMeasure,
    price: p.price, discountPrice: p.discountPrice, currency: 'NZD', url: p.url, imageUrl: p.imageUrl, barcode: p.barcode, description: clean(p.description, 200), sample: false,
  }));
  addSeed('sap-commerce', { products: sapProducts, carts, cart_lines: cartLines, orders, order_lines: orderLines }, {
    products: prov('real', 'placemakers_product_master.jsonl', ['every field'], []),
    carts: prov('sample', 'invented', [], ['cartId', 'accountId', 'status', 'branchCode', 'createdAt']),
    cart_lines: lineProvenance('cartId'),
    orders: prov('sample', 'invented', ['branchCode (a real code)'], ['orderId', 'accountId', 'customerType', 'status', 'deliveryType', 'placedAt', 'lineCount', 'total']),
    order_lines: lineProvenance('orderId'),
  });

  // ---- Salesforce
  const rs = new Rng('salesforce');
  const TOPICS: Array<[string, string]> = [
    ['delivery delay', 'The delivery has not arrived in the booked window.'], ['damaged goods', 'Part of the delivery arrived damaged.'], ['wrong item', 'The item delivered is not the one ordered.'],
    ['pricing query', 'The price charged differs from the quoted trade price.'], ['credit note', 'A credit note is needed for returned goods.'], ['stock enquiry', 'Asking when a product will be back in stock.'],
    ['warranty', 'Asking about the warranty on a product.'], ['account access', 'Cannot sign in to the trade portal.'], ['invoice query', 'A line on the invoice does not match the order.'], ['collection time', 'Asking to change the click and collect time.'],
  ];
  const owners = Array.from({ length: 6 }, () => personName(rs));
  const cases: Rec[] = [];
  for (let n = 1; n <= 44; n++) {
    const account = rs.pick(accounts);
    const [topic, text] = rs.pick(TOPICS);
    const accountOrders = orders.filter((o) => o.accountId === account.accountId);
    const created = rs.int(0, 70);
    const status = rs.weighted([['new', 2], ['open', 4], ['waiting', 2], ['closed', 6]] as const);
    cases.push({
      caseId: `CS-${10000 + n}`, accountId: account.accountId, subject: `${topic[0].toUpperCase()}${topic.slice(1)}`, topic, description: text, status, priority: rs.weighted([['low', 3], ['normal', 6], ['high', 2]] as const),
      origin: rs.pick(['phone', 'email', 'web', 'chat']), owner: rs.pick(owners), branchCode: account.homeBranchCode,
      relatedOrderId: accountOrders.length > 0 && rs.chance(0.65) ? rs.pick(accountOrders).orderId : null,
      createdAt: isoAt(created, rs.int(480, 960)), updatedAt: isoAt(Math.max(0, created - rs.int(0, 5)), rs.int(480, 960)), sample: true,
    });
  }
  cases.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  cases.forEach((c, i) => { c.caseId = `CS-${10001 + i}`; });
  const reviewed = orders.filter((o) => o.accountId).slice(0, 32);
  const orderReviews: Rec[] = reviewed.map((order, i) => {
    const reviewStatus = rs.weighted([['approved', 6], ['pending_review', 3], ['held', 1], ['changes_requested', 1]] as const);
    return {
      reviewId: `OR-${5001 + i}`, orderId: order.orderId, accountId: order.accountId, reviewStatus, reviewer: reviewStatus === 'pending_review' ? null : rs.pick(owners),
      reasonCode: rs.pick(['credit_check', 'price_check', 'stock_check', 'none']), note: reviewStatus === 'held' ? 'Waiting on a credit limit change.' : reviewStatus === 'changes_requested' ? 'Customer asked to change the delivery date.' : '',
      reviewedAt: reviewStatus === 'pending_review' ? null : new Date(Date.parse(order.placedAt) + rs.int(1, 20) * 3_600_000).toISOString(), sample: true,
    };
  });
  addSeed('salesforce', { accounts, cases, order_reviews: orderReviews }, {
    accounts: prov('sample', 'invented', ['homeBranchCode (a real branch code)'], ['every other field']),
    cases: prov('sample', 'invented', ['branchCode (a real branch code)'], ['every other field']),
    order_reviews: prov('sample', 'invented over the sample orders', [], ['every field']),
  });

  // ---- SAP ERP
  const rn = new Rng('erp');
  const stock: Rec[] = [];
  for (const product of products) {
    for (const code of rn.sample(branchCodes, 8)) {
      const branch = branches.find((b) => b.code === code)!;
      const onHand = rn.weighted([[0, 1], [rn.int(1, 20), 4], [rn.int(20, 200), 4], [rn.int(200, 1500), 1]] as const);
      const reserved = Math.min(onHand, rn.int(0, 12));
      stock.push({ sku: product.sku, title: product.title, branchCode: code, branchName: branch.name, onHand, reserved, available: onHand - reserved, reorderLevel: rn.pick([5, 10, 20, 50]), lastCountedAt: dateOnly(rn.int(0, 30)), sample: true });
    }
  }
  const priceList = products.map((p) => {
    const bronze = money(p.price * 0.95);
    const silver = money(p.price * 0.9);
    const gold = money(p.price * 0.85);
    return { sku: p.sku, title: p.title, unitOfMeasure: p.unitOfMeasure, currency: 'NZD', retailPrice: p.price, bronzePrice: bronze, silverPrice: silver, goldPrice: gold, effectiveFrom: dateOnly(rn.int(20, 120)), sample: true };
  });
  const deliveries: Rec[] = orders.filter((o) => o.deliveryType === 'delivery' && o.status !== 'cancelled').map((order, i) => {
    const status = order.status === 'delivered' ? 'delivered' : order.status === 'dispatched' ? 'out_for_delivery' : rn.chance(0.08) ? 'failed_attempt' : 'scheduled';
    return {
      deliveryId: `DEL-${30001 + i}`, orderId: order.orderId, accountId: order.accountId ?? null, branchCode: order.branchCode, status, scheduledDate: dateOnly(Math.max(0, Math.round((REFERENCE_DAY - Date.parse(order.placedAt)) / DAY) - rn.int(1, 3))),
      window: rn.pick(['7am-10am', '10am-1pm', '1pm-4pm']), vehicle: `Truck ${rn.int(1, 9)}`, driver: rn.pick(FIRST_NAMES), stops: rn.int(2, 8), note: status === 'failed_attempt' ? 'Nobody on site; rebook needed.' : '', sample: true,
    };
  });
  const balances: Rec[] = accounts.map((a) => {
    const balance = money(rn.int(0, a.creditLimit * 0.8) + rn.next());
    return { accountId: a.accountId, name: a.name, tier: a.tier, creditLimit: a.creditLimit, balance, overdue: rn.chance(0.2) ? money(balance * rn.next() * 0.5) : 0, lastPaymentAt: dateOnly(rn.int(1, 45)), terms: a.paymentTerms, currency: 'NZD', sample: true };
  });
  addSeed('ace-erp', { branches, stock, price_list: priceList, deliveries, account_balances: balances }, {
    branches: prov('mixed', 'store locator page (content master)', ['code', 'name', 'phone (street addresses are left out: the website text in the data folder has lost characters from them)'], ['lat', 'lng (approximate town centre, entered by hand)']),
    stock: prov('mixed', 'real products and branch codes, invented counts', ['sku', 'title', 'branchCode', 'branchName'], ['onHand', 'reserved', 'available', 'reorderLevel', 'lastCountedAt']),
    price_list: prov('mixed', 'real retail price, invented tier discounts', ['sku', 'title', 'unitOfMeasure', 'retailPrice'], ['bronzePrice', 'silverPrice', 'goldPrice', 'effectiveFrom']),
    deliveries: prov('sample', 'invented over the sample orders', ['branchCode (a real code)'], ['every other field']),
    account_balances: prov('sample', 'invented over the sample accounts', [], ['every field']),
  });

  // ---- MuleSoft
  const rm = new Rng('mulesoft');
  const syncRuns: Rec[] = [];
  const FLOWS: Array<[string, string, string]> = [['order-to-erp', 'commerce', 'erp'], ['order-to-crm-review', 'commerce', 'crm'], ['stock-to-commerce', 'erp', 'commerce'], ['account-sync', 'crm', 'erp']];
  for (const order of orders.slice(0, 30)) {
    const [flow, source, target] = rm.chance(0.6) ? FLOWS[0] : FLOWS[1];
    const status = rm.weighted([['success', 8], ['failed', 1], ['retrying', 1]] as const);
    syncRuns.push({
      runId: '', flow, source, target, orderId: order.orderId, status, startedAt: new Date(Date.parse(order.placedAt) + rm.int(1, 12) * 60_000).toISOString(), durationMs: rm.int(180, 4200), recordsProcessed: order.lineCount + 1,
      retries: status === 'success' ? 0 : rm.int(1, 3), errorCode: status === 'success' ? null : rm.pick(['TARGET_TIMEOUT', 'SCHEMA_MISMATCH', 'RATE_LIMITED']), correlationId: `corr-${rm.int(100000, 999999)}`, sample: true,
    });
  }
  for (let n = 0; n < 8; n++) {
    const [flow, source, target] = FLOWS[2 + (n % 2)];
    syncRuns.push({ runId: '', flow, source, target, orderId: null, status: rm.weighted([['success', 9], ['failed', 1]] as const), startedAt: isoAt(rm.int(0, 30), rm.int(0, 1400)), durationMs: rm.int(900, 9000), recordsProcessed: rm.int(40, 900), retries: 0, errorCode: null, correlationId: `corr-${rm.int(100000, 999999)}`, sample: true });
  }
  syncRuns.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  syncRuns.forEach((run, i) => { run.runId = `RUN-${9001 + i}`; });
  addSeed('mulesoft', { sync_runs: syncRuns }, { sync_runs: prov('sample', 'invented over the sample orders', ['orderId (a sample order)'], ['every other field']) });

  // ---- Salsify
  const salsifyProducts = products.map((p) => ({ ...p, sample: false }));
  addSeed('salsify', { products: salsifyProducts }, { products: prov('real', 'placemakers_product_master.jsonl', ['every field'], []) });

  // ---- Bloomreach (queries come from the real product words; how often they are typed is invented)
  const rb = new Rng('search');
  const catalog = products.map((p) => ({ sku: p.sku, title: p.title, brand: p.brand, department: p.department, categoryPath: p.categoryPath, keywords: p.keywords, price: p.discountPrice, currency: 'NZD', url: p.url, imageUrl: p.imageUrl, sample: false }));
  const frequency = (words: string[]) => [...words.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const stop = new Set(['and', 'the', 'for', 'with', 'x', 'mm', 'm', 'pack', 'of', 'to', 'in', 'kit', 'set']);
  const brandsRanked = frequency(products.map((p) => p.brand.toLowerCase()).filter(Boolean)).slice(0, 8).map(([w]) => w);
  const leafCategories = frequency(products.map((p) => (p.categoryPath.split(' > ').pop() ?? '').toLowerCase()).filter(Boolean)).slice(0, 12).map(([w]) => w);
  const titleWords = frequency(products.flatMap((p) => p.title.toLowerCase().split(/[^a-z]+/).filter((w: string) => w.length > 3 && !stop.has(w)))).slice(0, 14).map(([w]) => w);
  const queryTexts = [...new Set([...leafCategories, ...titleWords, ...brandsRanked])].slice(0, 34);
  const searchConfig = { arg: 'query', fields: [{ field: 'title', weight: 4 }, { field: 'brand', weight: 3 }, { field: 'keywords', weight: 3 }, { field: 'categoryPath', weight: 2 }, { field: 'department', weight: 1 }], mode: 'any' as const };
  const queries = queryTexts.map((query, i) => {
    const ranked = catalog.map((record) => ({ record, score: scoreText(record, searchConfig, query) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title));
    return { query, count: Math.max(8, Math.round(900 / (i + 1.5)) + rb.int(0, 30)), resultCount: ranked.length, topSkus: ranked.slice(0, 5).map((e) => e.record.sku), sample: true };
  });
  addSeed('bloomreach', { catalog, queries }, {
    catalog: prov('real', 'placemakers_product_master.jsonl', ['every field'], []),
    queries: prov('mixed', 'words from the real products; counts invented', ['query', 'resultCount', 'topSkus (found by searching the real catalogue)'], ['count']),
  });

  // ---- Marketing Cloud
  const rk = new Rng('marketing');
  const templates: Rec[] = ['Order confirmed', 'Order ready for collection', 'Delivery on its way', 'Delivery rescheduled', 'Quote follow-up', 'Credit note issued', 'Price list update', 'Back in stock'].map((name, i) => ({
    templateId: `TPL-${100 + i}`, name, channel: i % 3 === 2 ? 'sms' : 'email', sample: true,
  }));
  const contacts: Rec[] = accounts.map((a) => ({ contactId: `CON-${a.accountId.slice(4)}`, accountId: a.accountId, name: a.contactName, email: a.contactEmail, phone: a.contactPhone, emailOptIn: rk.chance(0.85), sample: true }));
  const messages: Rec[] = Array.from({ length: 34 }, (_, i) => {
    const contact = rk.pick(contacts);
    const template = rk.pick(templates);
    const status = rk.weighted([['delivered', 4], ['opened', 4], ['clicked', 2], ['bounced', 1]] as const);
    const sent = rk.int(0, 60);
    return {
      messageId: `MSG-${20001 + i}`, accountId: contact.accountId, contactName: contact.name, contactEmail: contact.email, channel: template.channel === 'sms' ? 'sms' : rk.weighted([['email', 8], ['in_app', 2]] as const),
      templateId: template.templateId, campaign: template.name, subject: template.name, status, sentAt: isoAt(sent, rk.int(480, 1020)), openedAt: status === 'opened' || status === 'clicked' ? isoAt(sent, rk.int(1030, 1400)) : null, sample: true,
    };
  }).sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
  messages.forEach((m, i) => { m.messageId = `MSG-${20001 + i}`; });
  addSeed('marketing-cloud', { messages, contacts, templates }, {
    messages: prov('sample', 'invented', [], ['every field']), contacts: prov('sample', 'invented (the sample accounts\' contacts)', [], ['every field']), templates: prov('sample', 'invented', [], ['every field']),
  });

  // ---- Power BI (some reports computed from the sample orders and cases, the rest invented)
  const rp = new Rng('reports');
  const reports: Rec[] = [];
  const reportRows: Rec[] = [];
  const addReport = (reportId: string, name: string, description: string, grain: string, measure: string, rows: Array<{ periodIndex: number; period: string; dimension: string; value: number }>, derived: boolean) => {
    reports.push({ reportId, name, description, owner: derived ? 'Business insights (computed from the sample orders)' : 'Business insights', grain, measure, refreshedAt: isoAt(0, 360), rowCount: rows.length, sample: true });
    for (const row of rows) reportRows.push({ reportId, ...row, measure, sample: true });
  };
  const topBranches = branches.slice(0, 8);
  addReport('R-SALES-BRANCH', 'Weekly sales by branch', 'Sales value each week for eight branches.', 'week', 'sales (NZD)',
    topBranches.flatMap((b) => Array.from({ length: 26 }, (_, w) => ({ periodIndex: w + 1, period: `2026-W${pad(w + 1, 2)}`, dimension: b.name as string, value: money(rp.int(18000, 90000) + rp.next() * 100) }))), false);
  const weekOf = (iso: string) => Math.max(1, 10 - Math.floor((REFERENCE_DAY - Date.parse(iso)) / (7 * DAY)));
  const statusCounts = new Map<string, number>();
  for (const o of orders) { const key = `${weekOf(o.placedAt)}|${o.status}`; statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1); }
  addReport('R-ORDERS-STATUS', 'Digital orders by status', 'Orders placed online each week, by where they are now.', 'week', 'orders',
    [...statusCounts].map(([key, value]) => { const [w, status] = key.split('|'); return { periodIndex: Number(w), period: `Week ${w}`, dimension: status, value }; }).sort((a, b) => a.periodIndex - b.periodIndex || a.dimension.localeCompare(b.dimension)), true);
  addReport('R-REVIEW-TURNAROUND', 'Order review turnaround', 'Hours between an online order and the support team\'s review, by kind of check.', 'week', 'hours',
    ['credit check', 'price check', 'stock check'].flatMap((d) => Array.from({ length: 26 }, (_, w) => ({ periodIndex: w + 1, period: `2026-W${pad(w + 1, 2)}`, dimension: d, value: money(rp.int(2, 30) + rp.next()) }))), false);
  const topicCounts = new Map<string, number>();
  for (const c of cases) { const w = Math.max(1, 10 - Math.floor((REFERENCE_DAY - Date.parse(c.createdAt)) / (7 * DAY))); const key = `${w}|${c.topic}`; topicCounts.set(key, (topicCounts.get(key) ?? 0) + 1); }
  addReport('R-CASES-TOPIC', 'Service cases by topic', 'Support cases opened each week, by topic.', 'week', 'cases',
    [...topicCounts].map(([key, value]) => { const [w, topic] = key.split('|'); return { periodIndex: Number(w), period: `Week ${w}`, dimension: topic, value }; }).sort((a, b) => a.periodIndex - b.periodIndex || a.dimension.localeCompare(b.dimension)), true);
  addReport('R-COLLECT-VS-DELIVER', 'Click and collect versus delivery', 'Share of digital orders collected or delivered each week.', 'week', 'orders',
    ['click_and_collect', 'delivery'].flatMap((d) => Array.from({ length: 26 }, (_, w) => ({ periodIndex: w + 1, period: `2026-W${pad(w + 1, 2)}`, dimension: d, value: rp.int(40, 220) }))), false);
  const valueBySku = new Map<string, number>();
  for (const line of orderLines) valueBySku.set(line.sku, (valueBySku.get(line.sku) ?? 0) + line.lineTotal);
  addReport('R-TOP-PRODUCTS', 'Top products by order value', 'The thirty products with the most value in digital orders.', 'rank', 'order value (NZD)',
    [...valueBySku].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([sku, value], i) => ({ periodIndex: i + 1, period: `Rank ${i + 1}`, dimension: sku, value: money(value) })), true);
  addSeed('power-bi', { reports, report_rows: reportRows }, {
    reports: prov('sample', 'invented', [], ['every field']),
    report_rows: prov('sample', 'three reports computed from the sample orders and cases; three invented', ['dimension in R-TOP-PRODUCTS (a real SKU)'], ['every figure']),
  });

  // ---- Google Analytics
  const rg = new Rng('analytics');
  const dailyTraffic: Rec[] = Array.from({ length: 60 }, (_, i) => {
    const daysAgo = 59 - i;
    const weekday = new Date(REFERENCE_DAY - daysAgo * DAY).getUTCDay();
    const base = weekday === 0 || weekday === 6 ? 2600 : 4100;
    const sessions = base + rg.int(-400, 600);
    const users = Math.round(sessions * (0.78 + rg.next() * 0.06));
    return { date: dateOnly(daysAgo), sessions, users, newUsers: Math.round(users * (0.32 + rg.next() * 0.1)), pageviews: Math.round(sessions * (3.4 + rg.next())), avgEngagementSec: rg.int(70, 140), bounceRatePct: money(38 + rg.next() * 12), conversions: Math.round(sessions * (0.018 + rg.next() * 0.01)), sample: true };
  });
  const realPaths: Array<[string, string]> = [
    ['/online/store-locator', 'Find a store'], ['/store-finder', 'Store finder'], ['/online/contactus', 'Contact us'], ['/online/useful-contacts', 'Useful contacts'], ['/online/careers', 'Careers'],
    ['/online/fastenings-catalogue', 'Fastenings catalogue'], ['/online/create-trade-account', 'Create a trade account'], ['/online/decking-guides', 'Decking guides'], ['/online/projects/kitchens/showrooms', 'Kitchen showrooms'],
    ['/online/placemakers-LBP-Events', 'LBP events'], ['/online/projects/cladding', 'Cladding projects'], ['/online/farm-sheds', 'Farm sheds'], ['/online/e-tools-whats-new', 'E-tools'],
    ['/online/building-code-update-energy-efficiency-h1', 'Building code update H1'], ['/online/projects/kitchens', 'Kitchens'],
  ];
  const pageTraffic: Rec[] = [
    ...realPaths.map(([p, title]) => ({ path: p, title, kind: 'content page', pathIsReal: true })),
    ...products.slice(0, 26).map((p) => ({ path: new URL(p.url).pathname, title: p.title, kind: 'product page', pathIsReal: true })),
  ].map((page, i) => ({ ...page, views: Math.round(18000 / (i + 2) + rg.int(0, 200)), users: 0, avgEngagementSec: rg.int(25, 190), conversions: rg.int(0, 120), sample: true }))
    .map((page) => ({ ...page, users: Math.round(page.views * (0.62 + rg.next() * 0.15)) }));
  const searchTerms: Rec[] = queries.slice(0, 32).map((q, i) => {
    const impressions = Math.round(30000 / (i + 2) + rg.int(0, 400));
    const clicks = Math.round(impressions * (0.03 + rg.next() * 0.08));
    return { term: q.query, impressions, clicks, ctrPct: money((clicks / impressions) * 100), avgPosition: money(1.5 + rg.next() * 9), sample: true };
  });
  const channels = ['organic search', 'direct', 'email', 'paid search', 'social', 'referral'];
  const channelConversions: Rec[] = channels.flatMap((channel, ci) => Array.from({ length: 5 }, (_, w) => {
    const sessions = Math.round((ci === 0 ? 9000 : ci === 1 ? 6500 : ci === 2 ? 2200 : ci === 3 ? 3000 : 1200 + ci * 100) + rg.int(-300, 300));
    const conversions = Math.round(sessions * (0.012 + rg.next() * 0.03));
    return { channel, weekStarting: dateOnly(28 - w * 7), sessions, conversions, conversionRatePct: money((conversions / sessions) * 100), sample: true };
  }));
  addSeed('google-analytics', { daily_traffic: dailyTraffic, page_traffic: pageTraffic, search_terms: searchTerms, channel_conversions: channelConversions }, {
    daily_traffic: prov('sample', 'invented', [], ['every field']),
    page_traffic: prov('mixed', 'real page paths, invented traffic', ['path', 'title'], ['views', 'users', 'avgEngagementSec', 'conversions']),
    search_terms: prov('mixed', 'words from the real products, invented figures', ['term'], ['impressions', 'clicks', 'ctrPct', 'avgPosition']),
    channel_conversions: prov('sample', 'invented', [], ['every field']),
  });

  // ---- UXCam
  const ru = new Rng('uxcam');
  const SCREENS = ['Home', 'Search', 'Search results', 'Product details', 'Product documents', 'Cart', 'Checkout: delivery', 'Checkout: payment', 'Order confirmation', 'Branch finder', 'Branch details', 'Account', 'Sign in', 'Order history', 'Order details', 'Trade prices', 'Scan barcode', 'Project lists', 'Quote request', 'Help', 'Notifications', 'Settings', 'Favourites', 'Compare products', 'Departments', 'Department landing', 'Deals', 'Collection times', 'Delivery options', 'Contact us'];
  const screens: Rec[] = SCREENS.map((name, i) => ({ screen: name, views: Math.round(24000 / (i + 1.4)) + ru.int(0, 300), avgTimeSec: ru.int(6, 70), exitRatePct: money(4 + ru.next() * 26), rageTapPct: money(ru.next() * 3), sample: true }));
  const sessions: Rec[] = Array.from({ length: 42 }, (_, i) => {
    const outcome = ru.weighted([['completed_order', 3], ['abandoned_cart', 3], ['browsed', 5], ['error', 1]] as const);
    const path = ['Home', ...ru.sample(SCREENS.slice(1, 12), ru.int(2, 6))];
    if (outcome === 'completed_order') path.push('Checkout: payment', 'Order confirmation');
    const platform = ru.pick(['ios', 'android'] as const);
    return {
      sessionId: `UX-${pad(i + 1, 4)}`, startedAt: isoAt(ru.int(0, 30), ru.int(360, 1300)), platform, deviceModel: platform === 'ios' ? ru.pick(['iPhone 14', 'iPhone 15', 'iPhone 13']) : ru.pick(['Galaxy S23', 'Pixel 8', 'Galaxy A54']),
      osVersion: platform === 'ios' ? ru.pick(['17.5', '18.0']) : ru.pick(['14', '15']), appVersion: ru.pick(['5.2.0', '5.3.1', '5.4.0']), durationSec: ru.int(30, 900), screensVisited: path.length, path, outcome,
      dropOffScreen: outcome === 'completed_order' ? null : path[path.length - 1], rageTaps: outcome === 'error' ? ru.int(2, 9) : ru.int(0, 2), userRef: `anon-${hash(`u${i}`).toString(16).slice(0, 6)}`, sample: true,
    };
  }).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  sessions.forEach((s, i) => { s.sessionId = `UX-${pad(i + 1, 4)}`; });
  const FUNNELS: Record<string, string[]> = {
    checkout: ['Cart', 'Checkout: delivery', 'Checkout: payment', 'Order confirmation'],
    'click-and-collect': ['Product details', 'Cart', 'Branch finder', 'Collection times', 'Checkout: payment', 'Order confirmation'],
    'account-sign-in': ['Home', 'Account', 'Sign in', 'Order history', 'Order details'],
    'quote-request': ['Project lists', 'Cart', 'Quote request', 'Contact us', 'Order confirmation'],
    'product-search': ['Home', 'Search', 'Search results', 'Product details', 'Cart'],
  };
  const funnelSteps: Rec[] = Object.entries(FUNNELS).flatMap(([funnel, steps]) => {
    let users = ru.int(2400, 4200);
    return steps.map((step, i) => {
      const before = users;
      if (i > 0) users = Math.round(users * (0.55 + ru.next() * 0.35));
      return { funnel, stepIndex: i + 1, step, users, dropOffPct: i === 0 ? 0 : money(((before - users) / before) * 100), sample: true };
    });
  });
  addSeed('uxcam', { sessions, screens, funnel_steps: funnelSteps }, {
    sessions: prov('sample', 'invented', [], ['every field']), screens: prov('sample', 'invented', [], ['every field']), funnel_steps: prov('sample', 'invented', [], ['every field']),
  });

  // ---- Location
  const rl = new Rng('location');
  const STREETS = ['Kauri Road', 'Rimu Street', 'Harbour View Drive', 'Mill Lane', 'Station Road', 'Victoria Avenue', 'Tui Crescent', 'Fernhill Terrace', 'Quarry Road', 'Church Street', 'Willow Place', 'Totara Street', 'Bridge Road', 'Lakeside Drive', 'Pohutukawa Avenue'];
  const addresses: Rec[] = Array.from({ length: 32 }, (_, i) => {
    const branch = rl.pick(branches);
    const number = rl.int(1, 240);
    const street = rl.pick(STREETS);
    const lat = money(branch.lat + (rl.next() - 0.5) * 0.12);
    const lng = money(branch.lng + (rl.next() - 0.5) * 0.12);
    return { addressId: `ADDR-${pad(i + 1, 4)}`, fullAddress: `${number} ${street}, ${branch.name}`, streetNumber: String(number), street, suburb: branch.name, town: branch.name, postcode: pad(rl.int(100, 9999), 4), lat, lng, kind: rl.pick(['site', 'home', 'yard']), sample: true };
  });
  addSeed('location', { addresses, branches }, {
    addresses: prov('sample', 'invented, placed near real branch towns', ['town (a real branch town)'], ['every other field']),
    branches: prov('mixed', 'store locator page (content master)', ['code', 'name', 'phone (street addresses are left out: the website text in the data folder has lost characters from them)'], ['lat', 'lng (approximate town centre, entered by hand)']),
  });

  // ---- the stages that extend a finished seed (scripts/seed-stages)
  applySeedStages(seeds);

  // ---- write, and check the smallest sizes each connector promises
  mkdirSync(OUT, { recursive: true });
  for (const [id, seed] of seeds) {
    const definition: ConnectorFile = JSON.parse(readFileSync(path.join(OUT, id, 'connector.json'), 'utf8'));
    for (const [collection, minimum] of Object.entries(definition.minimums)) {
      const count = seed.collections[collection]?.length ?? 0;
      if (count < minimum) throw new Error(`${id}.${collection} has ${count} records; it must have at least ${minimum}`);
    }
    for (const collection of Object.keys(seed.collections)) if (!seed.provenance[collection]) throw new Error(`${id}.${collection} has no provenance`);
    writeFileSync(path.join(OUT, id, 'seed.json'), seedText(seed));
    writeFileSync(path.join(OUT, id, 'README.md'), readme(definition, seed));
    console.log(`  ${id.padEnd(17)} ${Object.entries(seed.collections).map(([name, rows]) => `${name} ${rows.length}`).join(', ')}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
