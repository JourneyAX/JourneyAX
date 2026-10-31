/**
 * The shop's forms (pack `extensions.forms`) as the assistant uses them: find one, open it with what is already known filled in, and
 * check what comes back. The definition is the shop's data; nothing about any particular form is written here.
 */
import { FormsSchema, pluginGate, type FormDefinition } from '@journeyax/business-pack';
import { cleanText, validateFormValues, type FormCheck, type FormValues } from '@journeyax/ui-cards';

/** The forms of the pack that are well formed; a form that is not is left out (the publication check reports it). */
export function formsOf(release: unknown, person?: { audience: 'shopper' | 'staff'; groups: string[] }): FormDefinition[] {
  const raw = (release as any)?.extensions?.forms;
  if (!Array.isArray(raw)) return [];
  const parsed = FormsSchema.safeParse(raw);
  const all = parsed.success
    ? parsed.data
    // One broken form must not take the others with it.
    : raw.flatMap((entry) => {
        const single = FormsSchema.safeParse([entry]);
        return single.success ? single.data : [];
      });
  // A form a plugin names is this person's only if they have that plugin. Without a person every form is listed (the publication check).
  if (!person) return all;
  const gate = pluginGate((release as any)?.extensions?.plugins, person);
  return all.filter((form) => gate.allows('forms', form.formId));
}

export function findForm(release: unknown, formId: unknown, person?: { audience: 'shopper' | 'staff'; groups: string[] }): FormDefinition | undefined {
  const wanted = String(formId ?? '').trim();
  return wanted ? formsOf(release, person).find((form) => form.formId === wanted) : undefined;
}

/**
 * What goes in the boxes when the form opens: what the assistant passes (clipped and cleaned like anything typed), then any fact the
 * form says a field may be filled from. Only declared fields; a value that would not be accepted is left out so the person types it.
 */
export function prefillFor(form: FormDefinition, passed: unknown, facts: Record<string, { value?: unknown }> | undefined): FormValues {
  const given = passed && typeof passed === 'object' && !Array.isArray(passed) ? (passed as Record<string, unknown>) : {};
  const candidate: Record<string, unknown> = {};
  for (const field of form.fields) {
    const fromFact = field.prefillFrom ? facts?.[field.prefillFrom]?.value : undefined;
    const value = given[field.id] ?? (typeof fromFact === 'string' || typeof fromFact === 'number' ? fromFact : undefined);
    if (value !== undefined) candidate[field.id] = typeof value === 'string' ? cleanText(value, field.type === 'textarea') : value;
  }
  // Keep only what would pass on its own; required-ness is for the person to meet.
  const relaxed = { fields: form.fields.map((field) => ({ ...field, required: false })), messages: form.messages };
  return validateFormValues(relaxed as any, candidate).values;
}

/** The state of the form card, built from the shop's definition. */
export function formCardState(form: FormDefinition, values: FormValues): Record<string, unknown> {
  return {
    formId: form.formId,
    title: form.title,
    ...(form.intro ? { intro: form.intro } : {}),
    fields: form.fields.map((field) => ({
      id: field.id, label: field.label, type: field.type,
      ...(field.required ? { required: true } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
    })),
    ...(Object.keys(values).length > 0 ? { values } : {}),
    submitLabel: form.submitLabel || 'Send',
    ...(form.messages ? { messages: form.messages } : {}),
    status: 'open',
  };
}

/** Checks what came back against the shop's own definition (never the page's copy of it). */
export function checkSubmission(form: FormDefinition, raw: unknown): FormCheck {
  return validateFormValues({ fields: form.fields, messages: form.messages } as any, raw);
}

/** The line the person is told when the form is sent: the shop's words with the reference put in. */
export function thanksFor(form: FormDefinition, reference: string): string {
  const words = form.thanks || 'Thank you, we have received it. Your reference is {reference}.';
  return words.replace(/\{reference\}/g, reference);
}

const SUBMISSIONS_KEY = 'form_submission_times';
const MAX_PER_HOUR = 5;

/** A conversation may send a handful of forms an hour: enough for a person, too few for a script. */
export function submissionAllowed(workspace: { facts?: Record<string, any> } | undefined, now: Date = new Date()): boolean {
  const times = (workspace?.facts?.[SUBMISSIONS_KEY]?.value as number[] | undefined) || [];
  return times.filter((at) => typeof at === 'number' && now.getTime() - at < 3_600_000).length < MAX_PER_HOUR;
}

export function noteSubmission(workspace: { facts?: Record<string, any> } | undefined, now: Date = new Date()): void {
  if (!workspace) return;
  if (!workspace.facts) workspace.facts = {};
  const times = ((workspace.facts[SUBMISSIONS_KEY]?.value as number[] | undefined) || []).filter((at) => typeof at === 'number' && now.getTime() - at < 3_600_000);
  workspace.facts[SUBMISSIONS_KEY] = { value: [...times, now.getTime()].slice(-20), source: 'system', confidence: 1, extractedAt: now.toISOString() };
}
