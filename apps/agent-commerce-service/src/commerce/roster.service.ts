import { Injectable } from '@nestjs/common';
import type { QuoteLineInput } from './quote.types';

/**
 * Roster (AUG-32) — turn a list of players into an order.
 *
 * This is where a design becomes a purchase, and it is the step the industry
 * actually spends its labour on: a dealer with 24 players wants to paste a
 * spreadsheet, not drag a logo. Everything here is built around one rule —
 *
 *   NOTHING IS COMMITTED WITHOUT THE CUSTOMER SEEING IT FIRST.
 *
 * Column mapping is PROPOSED and returned for confirmation, never applied
 * silently. A misread column is not a cosmetic bug: it prints the wrong name on
 * a child's shirt, or orders 24 of the wrong size.
 *
 * Money is not computed here. Rows are aggregated into SKU + quantity and handed
 * to the quote engine, which owns every monetary field (P0-04).
 */

export interface RosterRow {
  /** 1-based position as it appeared in the source, for talking about a row. */
  line: number;
  name?: string;
  number?: string;
  /** Size per garment key, e.g. { jersey: 'L', pants: 'M' }. */
  sizes: Record<string, string>;
  /** Anything we could not interpret, kept so nothing is silently dropped. */
  issues: string[];
}

export interface ColumnMapping {
  /** Source column index → what we think it is. */
  index: number;
  header: string;
  role: 'name' | 'number' | 'size' | 'ignore';
  /** For role 'size', which garment it sizes. */
  garment?: string;
  /** Why we think so — shown to the customer so the guess is auditable. */
  because: string;
  confidence: 'high' | 'low';
}

export interface RosterParse {
  /** Proposed, NOT applied. The caller must confirm before saving. */
  mapping: ColumnMapping[];
  rows: RosterRow[];
  playerCount: number;
  /** Rows we could read but that need a human decision. */
  needsReview: RosterRow[];
  /** True when any mapping is a guess — the UI must ask before proceeding. */
  needsConfirmation: boolean;
  notes: string[];
}

/** Header words that identify a column. Order matters: first match wins. */
const HEADER_HINTS: { role: ColumnMapping['role']; garment?: string; words: string[] }[] = [
  { role: 'number', words: ['number', 'num', 'no', '#', 'jersey number', 'player number'] },
  { role: 'name', words: ['name', 'player', 'player name', 'athlete', 'full name'] },
  { role: 'size', garment: 'jersey', words: ['jersey', 'top', 'shirt', 'jersey size'] },
  { role: 'size', garment: 'pants', words: ['pant', 'pants', 'bottom', 'short', 'shorts'] },
  { role: 'size', garment: 'cap', words: ['cap', 'hat', 'headwear'] },
  { role: 'size', garment: 'socks', words: ['sock', 'socks'] },
  { role: 'size', garment: 'jersey', words: ['size'] },   // bare "size" ⇒ the main garment
];

@Injectable()
export class RosterService {
  /**
   * Split a pasted block into a grid.
   *
   * Dealers paste from Excel (tabs), from a CSV export (commas), or from an
   * email (multiple spaces). Guessing wrong turns one column into three, so the
   * delimiter is chosen by which one yields a CONSISTENT column count, not by
   * which appears most often.
   */
  private splitGrid(text: string): string[][] {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const candidates: { delim: RegExp; grid: string[][] }[] = [
      { delim: /\t/, grid: [] },
      { delim: /,(?=(?:[^"]*"[^"]*")*[^"]*$)/, grid: [] },   // commas outside quotes
      { delim: /\s{2,}/, grid: [] },
      { delim: /\s*\|\s*/, grid: [] },
    ];
    for (const c of candidates) {
      c.grid = lines.map((l) => l.split(c.delim).map((v) => v.trim().replace(/^"|"$/g, '')));
    }
    // Prefer the delimiter giving >1 column and the most uniform row width.
    const score = (g: string[][]) => {
      const widths = g.map((r) => r.length);
      const max = Math.max(...widths);
      if (max < 2) return -1;
      const consistent = widths.filter((w) => w === max).length / widths.length;
      return consistent * 10 + max * 0.1;
    };
    const best = candidates.map((c) => ({ ...c, s: score(c.grid) })).sort((a, b) => b.s - a.s)[0];
    return best.s > 0 ? best.grid : lines.map((l) => [l]);
  }

  private looksLikeSize(v: string): boolean {
    return /^(?:Y?(?:XS|S|M|L|XL|2XL|3XL|4XL|XXL|XXXL)|\d{1,2})$/i.test(v.trim());
  }
  private looksLikeNumber(v: string): boolean {
    return /^\d{1,3}$/.test(v.trim());
  }
  private looksLikeName(v: string): boolean {
    return /[A-Za-z]{2,}/.test(v) && !this.looksLikeSize(v);
  }

  /**
   * Propose a column mapping.
   *
   * Headers are used when present. When they are not — a dealer pastes rows with
   * no header line all the time — the shape of the DATA decides, and every such
   * guess is marked low-confidence so the UI asks rather than assumes.
   */
  private proposeMapping(grid: string[][], garments: string[]): { mapping: ColumnMapping[]; hasHeader: boolean } {
    const first = grid[0] || [];
    const rest = grid.slice(1);

    // A header row is text that does not look like player data.
    const hasHeader = first.length > 1
      && first.every((c) => c && !this.looksLikeNumber(c))
      && first.some((c) => HEADER_HINTS.some((h) => h.words.includes(c.toLowerCase().trim())));

    const mapping: ColumnMapping[] = [];
    const usedGarments = new Set<string>();

    for (let i = 0; i < first.length; i++) {
      const header = hasHeader ? first[i] : '';
      const key = header.toLowerCase().trim();
      const hint = hasHeader ? HEADER_HINTS.find((h) => h.words.includes(key)) : undefined;

      if (hint) {
        let garment = hint.garment;
        // Two "size" columns mean two garments; assign in the kit's own order.
        if (hint.role === 'size' && (!garment || usedGarments.has(garment))) {
          garment = garments.find((g) => !usedGarments.has(g)) || garment;
        }
        if (hint.role === 'size' && garment && usedGarments.has(garment)) {
          mapping.push({ index: i, header, role: 'ignore',
                         because: `"${header}" duplicates a size column already mapped to ${garment}`,
                         confidence: 'low' });
          continue;
        }
        if (garment) usedGarments.add(garment);
        mapping.push({ index: i, header, role: hint.role, garment,
                       because: `header "${header}"`, confidence: 'high' });
        continue;
      }

      // No usable header — infer from the column's values.
      const sample = (hasHeader ? rest : grid).map((r) => (r[i] || '').trim()).filter(Boolean).slice(0, 12);
      const ratio = (fn: (v: string) => boolean) =>
        sample.length ? sample.filter(fn).length / sample.length : 0;

      /* A column of bare digits is ambiguous: "24" is both a plausible player
         number and a numeric size. Repetition separates them — a squad's numbers
         are nearly all distinct, whereas sizes come from a handful of values
         reused across the roster. Getting this backwards orders two dozen
         garments in one size, so the ambiguity is resolved explicitly rather
         than by whichever test happens to run first. */
      const distinct = new Set(sample.map((v) => v.toUpperCase())).size;
      const uniqueness = sample.length ? distinct / sample.length : 0;
      const allDigits = ratio((v) => /^\d{1,3}$/.test(v)) > 0.9;
      const digitsAreNumbers = allDigits && uniqueness > 0.8;

      // Letter sizes (S/M/L/XL/YM) are unambiguous; digit columns must pass the
      // uniqueness test before being read as sizes.
      const looksSized = ratio((v) => this.looksLikeSize(v)) > 0.7 && !digitsAreNumbers;

      if (looksSized) {
        const garment = garments.find((g) => !usedGarments.has(g));
        if (!garment) {
          // Every garment in the kit already has a size column. Another one is
          // for something we were not told about — flag it rather than silently
          // overwrite a garment's sizes with the wrong column.
          mapping.push({ index: i, header, role: 'ignore',
                         because: 'looks like sizes, but every garment already has a size column',
                         confidence: 'low' });
        } else {
          usedGarments.add(garment);
          mapping.push({ index: i, header, role: 'size', garment,
                         because: 'values look like sizes', confidence: 'low' });
        }
      } else if ((digitsAreNumbers || ratio((v) => this.looksLikeNumber(v)) > 0.7)
                 && !mapping.some((m) => m.role === 'number')) {
        mapping.push({ index: i, header, role: 'number',
                       because: allDigits ? 'digits, nearly all distinct — reads as player numbers'
                                          : 'values are 1–3 digit numbers',
                       confidence: 'low' });
      } else if (ratio((v) => this.looksLikeName(v)) > 0.6
                 && !mapping.some((m) => m.role === 'name')) {
        mapping.push({ index: i, header, role: 'name',
                       because: 'values look like names', confidence: 'low' });
      } else {
        mapping.push({ index: i, header, role: 'ignore',
                       because: 'could not tell what this column is', confidence: 'low' });
      }
    }
    return { mapping, hasHeader };
  }

  /**
   * Parse a pasted roster. Returns a PROPOSAL — nothing is stored.
   *
   * `garments` is the kit being ordered, so a two-size sheet maps to the right
   * two items rather than to a fixed jersey/pants assumption.
   */
  parse(text: string, garments: string[] = ['jersey']): RosterParse {
    const grid = this.splitGrid(text || '');
    const notes: string[] = [];
    if (!grid.length) {
      return { mapping: [], rows: [], playerCount: 0, needsReview: [],
               needsConfirmation: false, notes: ['Nothing to read.'] };
    }

    const { mapping, hasHeader } = this.proposeMapping(grid, garments);
    const body = hasHeader ? grid.slice(1) : grid;

    const rows: RosterRow[] = body.map((cells, i) => {
      const row: RosterRow = { line: i + 1, sizes: {}, issues: [] };
      for (const m of mapping) {
        const raw = (cells[m.index] || '').trim();
        if (!raw || m.role === 'ignore') continue;
        if (m.role === 'name') row.name = raw;
        else if (m.role === 'number') {
          if (this.looksLikeNumber(raw)) row.number = raw;
          else row.issues.push(`"${raw}" is not a player number`);
        } else if (m.role === 'size' && m.garment) {
          row.sizes[m.garment] = raw.toUpperCase();
        }
      }
      if (!row.name) row.issues.push('no player name');
      for (const g of garments) if (!row.sizes[g]) row.issues.push(`no ${g} size`);
      return row;
    }).filter((r) => r.name || r.number || Object.keys(r.sizes).length);

    if (!hasHeader) notes.push('No header row found — columns were identified from the data.');
    const guessed = mapping.filter((m) => m.role !== 'ignore' && m.confidence === 'low');
    if (guessed.length) {
      notes.push(`${guessed.length} column${guessed.length === 1 ? '' : 's'} identified by guesswork.`);
    }

    // Duplicate numbers are a real ordering problem, not a formatting nit.
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (!r.number) continue;
      const prev = seen.get(r.number);
      if (prev) r.issues.push(`number ${r.number} is already used on row ${prev}`);
      else seen.set(r.number, r.line);
    }

    return {
      mapping,
      rows,
      playerCount: rows.length,
      needsReview: rows.filter((r) => r.issues.length),
      needsConfirmation: guessed.length > 0 || !hasHeader,
      notes,
    };
  }

  /**
   * Validate sizes against what the project actually sells.
   *
   * `scale` comes from project config. With no scale configured we CANNOT verify
   * a size, and say so rather than nodding it through — an unverified size is
   * how a team receives 24 garments nobody can wear.
   */
  validate(rows: RosterRow[], scale: string[] | undefined, garments: string[]): RosterRow[] {
    const known = new Set((scale || []).map((s) => s.trim().toUpperCase()));
    return rows.map((r) => {
      const issues = r.issues.filter((i) => !i.startsWith('size '));
      for (const g of garments) {
        const v = r.sizes[g];
        if (!v) continue;
        if (!known.size) issues.push(`size ${v} could not be checked — no size list configured`);
        else if (!known.has(v)) issues.push(`size ${v} is not one this brand stocks`);
      }
      return { ...r, issues };
    });
  }

  /**
   * Aggregate a roster into quote lines: one line per (garment SKU, size),
   * quantity = how many players need it.
   *
   * Returns SKU + quantity ONLY. Every price, discount and tax figure is the
   * quote engine's to compute (P0-04) — a roster must never be able to influence
   * money.
   */
  toQuoteLines(rows: RosterRow[], skuByGarment: Record<string, string>): QuoteLineInput[] {
    const counts = new Map<string, { sku: string; size: string; qty: number }>();
    for (const r of rows) {
      // A row may arrive with no sizes (a player not yet measured, or a
      // malformed request). Skip it rather than throwing — a bad line must not
      // 500 the whole quote.
      for (const [garment, size] of Object.entries(r?.sizes ?? {})) {
        const sku = skuByGarment[garment];
        if (!sku || !size) continue;
        const key = `${sku}::${size}`;
        const hit = counts.get(key);
        if (hit) hit.qty += 1;
        else counts.set(key, { sku, size, qty: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => a.sku.localeCompare(b.sku) || a.size.localeCompare(b.size))
      .map((c) => ({ sku: c.sku, quantity: c.qty, reason: `Size ${c.size}` }));
  }
}
