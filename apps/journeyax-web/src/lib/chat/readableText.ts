/** What the customer reads in their own bubble, as opposed to what is sent to the consultant. */

/**
 * The message a submitted question card sends ("My answers:" then one "question → answer" line each) is for the server and the
 * consultant; what the customer sees in their own bubble is what they chose, as one natural line ("Deck area, Natural timber look and 20").
 */
export function readableAnswers(text: string): string | undefined {
  const match = String(text || '').match(/^My answers:\s*\n([\s\S]+)$/);
  if (!match) return undefined;
  const chosen = match[1].split('\n').map((line) => line.split(' → ').slice(1).join(' → ').trim()).filter((answer) => answer && answer.toLowerCase() !== 'not answered');
  if (chosen.length === 0) return undefined;
  return chosen.length === 1 ? chosen[0] : `${chosen.slice(0, -1).join(', ')} and ${chosen[chosen.length - 1]}`;
}

/** A customer action the interface records as "[addToCart: Item]" is shown as a readable line ("Add to cart: Item"), never as a code-like tag. */
const ACTION_EVENT_RE = /^\[([A-Za-z][A-Za-z0-9_.]*)(?::\s*([\s\S]+))?\]$/;
export function readableUserText(text: string): string {
  const answers = readableAnswers(text);
  if (answers) return answers;
  const match = String(text || '').trim().match(ACTION_EVENT_RE);
  if (!match) return text;
  const words = match[1].replace(/[._]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return match[2] ? `${label}: ${match[2]}` : label;
}

