/**
 * A product's own guide: the supplier's specification guide, installation guide or instruction manual, kept with the
 * catalogue as text so the agent can read what it says instead of only knowing that a guide exists.
 *
 * Nothing here knows a language, a product or a trade: a guide is cut into passages, the passages that share the most
 * uncommon words with the customer's question come first, and the agent is handed those passages with the guide they
 * came from. What the agent may then say about them is the tenant's choice (pack `extensions.productGuides`).
 */
import { createHash } from 'node:crypto';

/** One guide as stored (collection `product_guides`): the same file is shared by every product that carries it. */
export interface ProductGuideRecord {
  tenantId: string;
  /** A stable id of the file: the same address always gives the same id. */
  docId: string;
  title: string;
  /** What the catalogue calls the kind of file (for example "pdf"). */
  kind?: string;
  url?: string;
  pages?: number;
  text: string;
  textChars: number;
  /** True when the file was longer than the store keeps and the text stops short of its end. */
  truncated?: boolean;
  /** The identifiers of the products that carry this guide. */
  skus: string[];
  updatedAt?: Date;
}

export interface GuidePassage { guideId: string; guide: string; n: number; of: number; text: string }

export interface GuideReading {
  guides: Array<{ guideId: string; title: string; kind?: string; pages?: number; url?: string; passages: number; truncated?: boolean; outline?: Array<{ n: number; heading: string }> }>;
  passages: GuidePassage[];
  /** True when the passages were chosen because they share words with the question. */
  matched: boolean;
  /** Where to continue reading the one guide that was read in order, when there is more of it. */
  next?: { guideId: string; from: number };
  /** Other guides of the product that have no readable words, so the reader can say they exist and give their links. */
  unreadable?: UnreadableGuide[];
}

/** A guide the shop holds only as a file (a scan): its link and details are kept, but there are no words to read. */
export interface UnreadableGuide { guideId: string; title: string; kind?: string; pages?: number; url?: string }

export interface ReadOptions {
  question?: string;
  /** Limits the reading to one guide: part of its title, its kind, or the start of its id. */
  guide?: string;
  /** With one guide, the passage number (1 is the first) to read from. */
  from?: number;
  maxPassages?: number;
  passageChars?: number;
  /** A single guide up to this many characters comes back whole, in its own order, instead of the best few passages: a short guide read whole is a better answer than a skim. 0 (the default here) never does. */
  wholeGuideChars?: number;
}

export const DEFAULT_MAX_PASSAGES = 8;
export const DEFAULT_PASSAGE_CHARS = 900;

export function guideDocId(url: string | undefined, title: string, text: string): string {
  return createHash('sha1').update(url && url.trim() ? url.trim() : `${title}\n${text.slice(0, 2000)}`).digest('hex').slice(0, 32);
}

/** The guides a catalogue product record carries as readable text (a link to the maker's home page is not a guide). */
export function guidesFromProductRecord(product: any): Array<{ title: string; kind?: string; url?: string; pages?: number; text: string }> {
  const out: Array<{ title: string; kind?: string; url?: string; pages?: number; text: string }> = [];
  for (const entry of Array.isArray(product?.documents) ? product.documents : []) {
    if (!entry || String(entry.type || '').toLowerCase() === 'supplier') continue;
    const text = tidyGuideText(entry.text);
    if (!text) continue;
    const title = String(entry.title || '').replace(/\s+/g, ' ').trim() || 'Guide';
    out.push({
      title,
      ...(entry.type ? { kind: String(entry.type) } : {}),
      ...(typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url.trim()) ? { url: entry.url.trim() } : {}),
      ...(Number.isFinite(Number(entry.pages)) && Number(entry.pages) > 0 ? { pages: Number(entry.pages) } : {}),
      text,
    });
  }
  return out;
}

/** Text as a person reads it: no control or private-use characters (a PDF's bullets arrive as those), tabs and runs of spaces collapsed. */
export function tidyGuideText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[-]/g, '•')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A line a file extraction leaves for a page it could not read ("-- 3 of 16 --"): digits around a short word, and nothing else.
 * A scanned manual comes through as page markers alone.
 */
const PAGE_MARKER = /^[\s\-–—_*#.[\]()]*\p{N}+\s*\p{L}{0,4}\s*\p{N}+[\s\-–—_*#.[\]()]*$/u;
/** Fewer letters than this, once page markers are taken out, is not a guide anyone can read. */
export const MIN_READABLE_LETTERS = 60;

/** True when the text holds real words, not only page markers or a few stray characters. */
export function hasReadableText(text: string): boolean {
  let letters = 0;
  for (const line of String(text || '').split('\n')) {
    if (PAGE_MARKER.test(line.trim())) continue;
    letters += (line.match(/\p{L}/gu) || []).length;
    if (letters >= MIN_READABLE_LETTERS) return true;
  }
  return false;
}

const looksLikeHeading = (line: string) => line.length <= 60 && !/[.,;]$/.test(line);

/** The text cut into passages of at most `maxChars`, at line ends; a new passage starts at a heading once the last one is well filled. */
export function splitPassages(text: string, maxChars = DEFAULT_PASSAGE_CHARS): string[] {
  const limit = Math.max(200, Math.floor(maxChars));
  const passages: string[] = [];
  let current = '';
  const flush = () => { if (current.trim()) passages.push(current.trim()); current = ''; };
  for (const sourceLine of tidyGuideText(text).split('\n')) {
    let line = sourceLine.trim();
    if (!line) { if (current.length >= limit * 0.6) flush(); continue; }
    while (line.length > limit) {
      let cut = line.lastIndexOf(' ', limit);
      if (cut < limit * 0.5) cut = limit;
      if (current) flush();
      passages.push(line.slice(0, cut).trim());
      line = line.slice(cut).trim();
    }
    if (current && current.length + line.length + 1 > limit) flush();
    else if (current.length >= limit * 0.6 && looksLikeHeading(line)) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return passages;
}

const tokensOf = (value: string): string[] => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((token) => token.length > 2);

/** Two words are the same word when they are equal, or when the shorter is the start of the longer and adds only an ending (fix, fixed, fixing; fastener, fasteners; reposition, repositionable). */
const sameWord = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.length - short.length <= 5 && long.startsWith(short);
};

/** Passage numbers (0-based) ordered best first: each word of the question counts for more the fewer passages hold it. */
export function rankPassages(passages: string[], question: string): number[] {
  const wanted = [...new Set(tokensOf(question))];
  if (wanted.length === 0 || passages.length === 0) return [];
  const words = passages.map((passage) => [...new Set(tokensOf(passage))]);
  const holds = words.map((own) => new Map(wanted.map((token) => [token, own.some((word) => sameWord(word, token))] as const)));
  const weight = new Map<string, number>();
  for (const token of wanted) {
    const holding = holds.filter((held) => held.get(token)).length;
    if (holding > 0) weight.set(token, Math.log(1 + passages.length / holding));
  }
  return holds
    .map((held, index) => ({ index, score: [...weight].reduce((sum, [token, w]) => sum + (held.get(token) ? w : 0), 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.index);
}

const MAX_OUTLINE = 80;

/** Lines of a passage that read as headings: numbered section titles ("6.9 Sheet fixing", level = how many numbers) or short lines in capitals (level 0); contents-page lines that end in a page number are not headings. */
export function headingsOf(passage: string): Array<{ text: string; level: number }> {
  const out: Array<{ text: string; level: number }> = [];
  for (const raw of passage.split('\n')) {
    const line = raw.trim().replace(/^[•\s]+/, '');
    if (line.length < 4 || line.length > 80 || /[.,;:]$/.test(line) || /\s\d{1,3}$/.test(line)) continue;
    const numbered = /^(\d{1,2}(?:\.\d{1,2}){0,3})\s+\p{L}/u.exec(line);
    if (numbered) { out.push({ text: line, level: numbered[1].split('.').length }); continue; }
    const letters = line.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && /\s/.test(line) && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) out.push({ text: line, level: 0 });
  }
  return out;
}

/** The headings of a long guide with the passage each is in: running page headers (the same words on many pages) are left out, and a guide with numbered sections is outlined by those. */
function outlineOf(passages: string[]): Array<{ n: number; heading: string }> {
  const found = passages.flatMap((passage, index) => headingsOf(passage).map((heading) => ({ n: index + 1, heading: heading.text, level: heading.level })));
  const key = (text: string) => text.replace(/^\d+\s+/, '').toLowerCase();
  const seen = new Map<string, number>();
  for (const entry of found) seen.set(key(entry.heading), (seen.get(key(entry.heading)) || 0) + 1);
  let list = found.filter((entry) => (seen.get(key(entry.heading)) || 0) < 3);
  const numbered = list.filter((entry) => entry.level > 0);
  if (numbered.length >= 8) list = numbered;
  if (list.length > MAX_OUTLINE) list = list.filter((entry) => entry.level <= 2);
  return list.slice(0, MAX_OUTLINE).map(({ n, heading }) => ({ n, heading }));
}

/** Reads the guides a product carries: the passages that answer the question, or the start of the guide when nothing in it does. */
export function readGuides(records: ProductGuideRecord[], options: ReadOptions = {}): GuideReading | { error: 'no_such_guide'; available: string[] } | { error: 'no_readable_text'; unreadable: UnreadableGuide[] } {
  const maxPassages = Math.min(20, Math.max(1, Math.floor(options.maxPassages ?? DEFAULT_MAX_PASSAGES)));
  const passageChars = options.passageChars ?? DEFAULT_PASSAGE_CHARS;
  const readable = records.filter((record) => hasReadableText(record.text));
  const asUnreadable = (record: ProductGuideRecord): UnreadableGuide => ({
    guideId: record.docId, title: record.title, ...(record.kind ? { kind: record.kind } : {}), ...(record.pages ? { pages: record.pages } : {}), ...(record.url ? { url: record.url } : {}),
  });
  const unreadable = records.filter((record) => !hasReadableText(record.text)).map(asUnreadable);
  let books = readable.map((record) => ({ record, passages: splitPassages(record.text, passageChars) })).filter((book) => book.passages.length > 0);
  const wantedGuide = String(options.guide || '').trim().toLowerCase();
  const named = (record: { title: string; kind?: string; docId?: string; guideId?: string }) =>
    record.title.toLowerCase().includes(wantedGuide) || String(record.kind || '').toLowerCase() === wantedGuide || String(record.docId ?? record.guideId ?? '').startsWith(wantedGuide);
  if (wantedGuide) {
    const chosen = books.filter(({ record }) => named(record));
    if (chosen.length === 0) {
      const asked = unreadable.filter((guide) => named(guide));
      if (asked.length > 0) return { error: 'no_readable_text', unreadable: asked };
      return { error: 'no_such_guide', available: [...books.map(({ record }) => record.title), ...unreadable.map((guide) => guide.title)] };
    }
    books = chosen;
  }
  if (books.length === 0) return { error: 'no_readable_text', unreadable };
  const guides = books.map(({ record, passages }) => ({
    guideId: record.docId, title: record.title, kind: record.kind, pages: record.pages, url: record.url, passages: passages.length,
    ...(record.truncated ? { truncated: true } : {}),
    // A long guide comes with the headings it holds and the passage each is in, so the reader can go straight to a section.
    ...(passages.length > maxPassages && outlineOf(passages).length > 0 ? { outline: outlineOf(passages) } : {}),
  }));
  const passageOf = (book: (typeof books)[number], index: number): GuidePassage => ({ guideId: book.record.docId, guide: book.record.title, n: index + 1, of: book.passages.length, text: book.passages[index] });

  const from = Number(options.from);
  if (books.length > 0 && Number.isFinite(from) && from >= 1 && (books.length === 1 || wantedGuide)) {
    const book = books[0];
    const start = Math.min(book.passages.length - 1, Math.floor(from) - 1);
    const end = Math.min(book.passages.length, start + maxPassages);
    return {
      guides: [guides[0]],
      passages: Array.from({ length: end - start }, (_, offset) => passageOf(book, start + offset)),
      matched: false,
      ...(unreadable.length > 0 ? { unreadable } : {}),
      ...(end < book.passages.length ? { next: { guideId: book.record.docId, from: end + 1 } } : {}),
    };
  }

  // A short guide is read whole: every passage, in the guide's own order, so the steps are not skipped by a ranking on the question's words.
  const wholeLimit = Math.max(0, Math.floor(options.wholeGuideChars ?? 0));
  if (books.length === 1 && wholeLimit > 0 && books[0].record.text.length <= wholeLimit && books[0].passages.length <= 20) {
    return {
      guides: [guides[0]],
      passages: books[0].passages.map((_, index) => passageOf(books[0], index)),
      matched: true,
      ...(unreadable.length > 0 ? { unreadable } : {}),
    };
  }

  const scored = books.map((book) => rankPassages(book.passages, options.question || ''));
  if (scored.some((order) => order.length > 0)) {
    // The best passages across every guide of the product, shown in the order the guides give them.
    const picks = new Map<number, number[]>();
    let taken = 0;
    for (let rank = 0; taken < maxPassages; rank++) {
      let any = false;
      scored.forEach((order, bookIndex) => {
        if (taken >= maxPassages || rank >= order.length) return;
        any = true;
        picks.set(bookIndex, [...(picks.get(bookIndex) || []), order[rank]]);
        taken++;
      });
      if (!any) break;
    }
    const passages = [...picks].sort((a, b) => a[0] - b[0]).flatMap(([bookIndex, indexes]) => indexes.sort((a, b) => a - b).map((index) => passageOf(books[bookIndex], index)));
    return { guides, passages, matched: true, ...(unreadable.length > 0 ? { unreadable } : {}) };
  }

  // Nothing in the guides shares a word with the question (or there was none): the start of each guide, in turn.
  const passages: GuidePassage[] = [];
  const reading: number[] = books.map(() => 0);
  while (passages.length < maxPassages && books.some((book, i) => reading[i] < book.passages.length)) {
    books.forEach((book, i) => { if (passages.length < maxPassages && reading[i] < book.passages.length) passages.push(passageOf(book, reading[i]++)); });
  }
  const single = books.length === 1 ? books[0] : undefined;
  return {
    guides,
    passages,
    matched: false,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    ...(single && reading[0] < single.passages.length ? { next: { guideId: single.record.docId, from: reading[0] + 1 } } : {}),
  };
}
