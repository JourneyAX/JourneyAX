import type { ConversationPolicy } from './policy';
import { stem, tokens } from './text';

export interface Needs { terms: string[]; surfaces: Record<string, string> }

const ARROW = /→|->/;

/** True when a line is a tapped card answer ("question → answer"); those carry answers, not new needs. */
export const isCardAnswerLine = (line: string): boolean => ARROW.test(line);

/**
 * What the customer is asking for, as the words that say it. The words that only name the shelf they are standing at
 * (the concept), shopping filler, and function words are removed; what is left is the need ("oil", "stain", "driveway").
 * Works the same in every department: nothing here knows what a product is.
 */
export function extractNeeds(message: string, conceptWords: Set<string>, policy: ConversationPolicy): Needs {
  const skip = new Set([...policy.stopwords, ...policy.fillerWords].map((word) => stem(word, policy)));
  const concept = new Set([...conceptWords].map((word) => stem(word, policy)));
  const terms: string[] = [];
  const surfaces: Record<string, string> = {};
  for (const line of message.split(/\n+/)) {
    if (isCardAnswerLine(line)) continue;
    for (const word of tokens(line)) {
      const root = stem(word, policy);
      if (root.length < 2 || skip.has(root) || skip.has(word) || concept.has(root)) continue;
      if (!terms.includes(root)) { terms.push(root); surfaces[root] = word; }
    }
  }
  return { terms, surfaces };
}

/** Words that name the concept the customer is standing at: its id's own words and its overview groups' labels. */
export function conceptWordsOf(gate: { conceptId?: string; retrieval?: { groups?: Array<{ label: string }>; categoryPaths?: string[][] } } | null | undefined): Set<string> {
  const words = new Set<string>();
  const add = (text: string) => tokens(text.replace(/-/g, ' ')).forEach((word) => words.add(word));
  if (gate?.conceptId) gate.conceptId.replace(/^concept:\/\//, '').split('/').slice(1).forEach(add);
  for (const group of gate?.retrieval?.groups ?? []) add(group.label);
  for (const path of gate?.retrieval?.categoryPaths ?? []) path.forEach(add);
  return words;
}
