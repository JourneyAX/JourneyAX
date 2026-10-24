/**
 * What a tapped answer says in the customer's own chat message. A tapped option is stored by its value, which can be an internal code
 * (a category slug such as "interior-paint"); the message the customer reads, and the server reads back, uses the words on the button.
 * The server matches an answer by value or by label, so the label is always understood.
 *
 * A multi-select keeps its values: its answers are joined with commas, and a label may itself contain one.
 */
export interface AnswerQuestion {
  id?: string;
  text?: string;
  title?: string;
  options?: unknown;
  multi?: boolean;
  inputType?: string;
  unit?: string;
  answer?: unknown;
}

export function answerLabel(question: AnswerQuestion, answer: unknown): string {
  const text = Array.isArray(answer) ? answer.map(String).join(', ') : String(answer ?? '');
  // A number asked for with a unit ("20" on an area question in m²) is said with it, so "20 m²" is what the customer and the consultant read.
  if (typeof question.unit === 'string' && question.unit.trim() && /^-?\d+(\.\d+)?$/.test(text.trim())) return `${text.trim()} ${question.unit.trim()}`;
  if (question.multi === true || question.inputType === 'multi_select' || Array.isArray(answer)) return text;
  const options = Array.isArray(question.options) ? question.options : [];
  const hit = options.find((option: any) => option && typeof option === 'object' && String(option.value) === text.trim());
  const label = hit && typeof (hit as any).label === 'string' ? (hit as any).label.trim() : '';
  return label || text;
}

/** One "question → answer" line per question, as the server reads a tapped answer. */
export function answerSummary(questions: AnswerQuestion[], answers: Record<string, string | undefined>): string {
  return questions
    .map((question) => {
      const given = (question.id !== undefined ? answers[question.id] : undefined) ?? question.answer;
      return `${question.text || question.title || question.id} → ${given === undefined || given === null ? 'Not answered' : answerLabel(question, given)}`;
    })
    .join('\n');
}

/**
 * A number outside the usual range, moved a decimal place or two to land inside it (18 for 1.8, 0.24 for 2.4); undefined when no
 * shift does. The customer is asked "did you mean…?" once and may keep what they typed.
 */
export function nearbyInRange(value: number, min?: number, max?: number): number | undefined {
  if (!Number.isFinite(value) || value === 0) return undefined;
  const inside = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);
  if (inside(value)) return undefined;
  const tooBig = max !== undefined && value > max;
  for (const shift of tooBig ? [0.1, 0.01] : [10, 100]) {
    const moved = Math.round(value * shift * 1000) / 1000;
    if (inside(moved)) return moved;
  }
  return undefined;
}
