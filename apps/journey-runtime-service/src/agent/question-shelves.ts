/**
 * Keeps a "what kind are you after?" question honest about the range.
 *
 * When the consultant asks the customer to choose between the groups of a department, the choices come from what it was shown of the
 * range, and a model that offers three of four groups silently drops the fourth: a customer who wants it has to tap "not sure". The
 * server knows the real groups and how many products each holds, so it checks the question against them: a group that holds a fair
 * share of the department must be among the choices, and the shop's own "something else" choice (its words, from the pack) is added.
 *
 * Nothing here knows a trade or a language: a choice names a group when they share words, and the words come from the catalogue.
 */

export interface Shelf { name: string; productCount: number }

export interface QuestionCardSettings {
  /** The shop's own words for "something that is not listed". Without it no such choice is added. */
  otherOptionLabel?: string;
  /** The smallest share of the department's products (0 to 1) a group needs to have to be required among the choices. */
  minShelfShare?: number;
}

/** A group holding at least this share of the department must be offered. */
export const DEFAULT_MIN_SHELF_SHARE = 0.08;
/** A choice names a group when this fraction of their words (the larger set) is shared. */
const NAMES_SHELF_AT = 0.5;

const wordsOf = (text: string, joiners: ReadonlySet<string>): string[] => {
  const raw = String(text || '').toLowerCase().replace(/[®™]/g, '').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2 && !joiners.has(word));
  return [...new Set(raw.map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)))];
};

/** 0 to 1: how much of the larger set of words the two share. */
const overlap = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const shared = a.filter((word) => b.includes(word)).length;
  return shared / Math.max(a.length, b.length);
};

const labelOf = (option: unknown): string => {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') {
    const entry = option as { label?: unknown; value?: unknown };
    if (typeof entry.label === 'string') return entry.label;
    if (typeof entry.value === 'string') return entry.value;
  }
  return '';
};

export interface ShelfQuestionCheck {
  /** Positions of the questions whose choices are the department's groups. */
  shelfQuestions: number[];
  /** Groups that hold a fair share of the department and are not among the choices of a question that offers its groups. */
  missing: Shelf[];
}

/** Which questions offer the groups, and which big groups they leave out. */
export function checkShelfQuestions(questions: unknown, shelves: Shelf[], settings: QuestionCardSettings = {}, joiners: ReadonlySet<string> = new Set()): ShelfQuestionCheck {
  const result: ShelfQuestionCheck = { shelfQuestions: [], missing: [] };
  const usable = shelves.filter((shelf) => shelf.name && shelf.productCount > 0);
  if (!Array.isArray(questions) || usable.length < 2) return result;
  const total = usable.reduce((sum, shelf) => sum + shelf.productCount, 0);
  const minShare = typeof settings.minShelfShare === 'number' && settings.minShelfShare > 0 ? settings.minShelfShare : DEFAULT_MIN_SHELF_SHARE;
  const shelfWords = usable.map((shelf) => wordsOf(shelf.name, joiners));
  const named = new Set<number>();
  questions.forEach((question: any, position: number) => {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length < 2) return;
    // Each choice is the group it shares the most words with, when that is enough to call it that group.
    const matched = new Set<number>();
    for (const option of options) {
      const words = wordsOf(labelOf(option), joiners);
      let best = -1;
      let bestScore = 0;
      shelfWords.forEach((candidate, index) => {
        const score = overlap(words, candidate);
        if (score > bestScore) { best = index; bestScore = score; }
      });
      if (best >= 0 && bestScore >= NAMES_SHELF_AT) matched.add(best);
    }
    if (matched.size < 2) return;
    result.shelfQuestions.push(position);
    matched.forEach((index) => named.add(index));
  });
  if (result.shelfQuestions.length === 0) return result;
  usable.forEach((shelf, index) => {
    if (!named.has(index) && shelf.productCount / total >= minShare) result.missing.push(shelf);
  });
  result.missing.sort((a, b) => b.productCount - a.productCount);
  return result;
}

/** The shop's "something else" choice, added at the end of each question that offers the department's groups and does not have it yet. */
export function addOtherOption(questions: any[], positions: number[], label: string | undefined): void {
  const text = String(label || '').trim();
  if (!text) return;
  for (const position of positions) {
    const question = questions[position];
    if (!question || !Array.isArray(question.options)) continue;
    if (question.options.some((option: unknown) => labelOf(option).trim().toLowerCase() === text.toLowerCase())) continue;
    question.options = [...question.options, text];
  }
}
