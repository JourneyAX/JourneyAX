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
  answer?: unknown;
}

export function answerLabel(question: AnswerQuestion, answer: unknown): string {
  const text = Array.isArray(answer) ? answer.map(String).join(', ') : String(answer ?? '');
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
