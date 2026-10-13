import type { OkfReleaseContent } from './contracts';
import { tokenizeText } from './policy';

/**
 * A tapped answer reaches the server as text, one line per question card: "<the question> → <the answer>". Reading it needs no
 * model: the question and the answer are matched, exactly and by words, against the release's own fact definitions. A line that
 * matches nothing is ignored (it is just a customer's words); a line that matches is a certain answer, never a guess.
 *
 * The answer may be the option's value or its label. A named question must match the release exactly; only a bare arrow may fall
 * back to a unique option value. The caller supplies only questions open in the current session.
 */
export function readCardAnswers(message: string, factRegistry: OkfReleaseContent['factRegistry']): Record<string, string | string[]> {
  const words = (text: string) => tokenizeText(text).join(' ');
  const facts = factRegistry.filter((fact) => (fact.options?.length ?? 0) > 0 || (fact.allowedValues?.length ?? 0) > 0);
  const answers: Record<string, string | string[]> = {};
  for (const line of message.split(/\n+/)) {
    const arrow = /\s*(?:→|->)\s*/.exec(line);
    if (!arrow) continue;
    const question = words(line.slice(0, arrow.index));
    const given = line.slice(arrow.index + arrow[0].length).trim();
    if (!given) continue;
    const optionsOf = (fact: (typeof facts)[number]) => [
      ...(fact.options ?? []),
      ...(fact.allowedValues ?? []).map((value) => ({ value, label: value })),
    ];
    const matchOne = (fact: (typeof facts)[number], text: string): string | undefined =>
      optionsOf(fact).find((option) => words(option.value) === words(text) || words(option.label) === words(text))?.value;
    const asked = facts.filter((fact) => words(fact.question) === question || words(fact.factKey) === question);
    if (question && asked.length === 0) continue;
    const pool = asked.length > 0 ? asked : facts;
    for (const fact of pool) {
      const parts = fact.type === 'array' ? given.split(/\s*,\s*/) : [given];
      const values = parts.map((part) => matchOne(fact, part));
      if (values.some((value) => value === undefined)) continue;
      if (asked.length === 0 && facts.filter((other) => optionsOf(other).some((option) => values.includes(option.value))).length !== 1) continue;
      answers[fact.factKey] = fact.type === 'array' ? values as string[] : values[0] as string;
      break;
    }
  }
  return answers;
}
