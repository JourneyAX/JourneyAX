import { z } from 'zod';

/**
 * The forms a shop offers inside the conversation (pack `extensions.forms`): a contact-us or enquiry form, a callback request, a
 * "tell us about your project" form. The shop writes the fields and the words; the assistant opens the form when a person asks to
 * get in touch, and the page validates what the person types against the same definition the server checks it against.
 *
 * What a form never does by itself: it does not send mail or write to another system. A sent form is kept as a submission with a
 * reference, and the shop's own flows (or the people who read the submissions) take it from there.
 */
export const FORM_FIELD_TYPES = ['text', 'email', 'phone', 'textarea', 'select', 'checkbox'] as const;
export const FormFieldTypeSchema = z.enum(FORM_FIELD_TYPES);

const Slug = z.string().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/, 'use lower-case letters, digits, "-" or "_", starting with a letter');

export const FormFieldSchema = z.object({
  id: Slug,
  label: z.string().min(1).max(100),
  type: FormFieldTypeSchema,
  required: z.boolean().optional(),
  placeholder: z.string().max(120).optional(),
  /** The choices of a `select`. */
  options: z.array(z.string().min(1).max(80)).min(1).max(30).optional(),
  /** The longest answer kept; defaults by type (a line 200, a message 2000). */
  maxLength: z.number().int().min(1).max(5000).optional(),
  /** A fact the assistant already knows (a conversation fact key) that may be put in the box ahead of time. */
  prefillFrom: z.string().min(1).max(80).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.type === 'select' && !field.options) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'A select field needs its options.' });
  if (field.type !== 'select' && field.options) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Only a select field has options.' });
});

export const FormDefinitionSchema = z.object({
  formId: Slug,
  title: z.string().min(1).max(100),
  /** A line or two above the fields. */
  intro: z.string().max(400).optional(),
  fields: z.array(FormFieldSchema).min(1).max(20),
  submitLabel: z.string().min(1).max(40).optional(),
  /** What the assistant says once the form is sent, in the shop's words; `{reference}` is replaced by the submission's reference. */
  thanks: z.string().max(400).optional(),
  /** Who reads it, as the shop says it ("our customer service team"); the assistant tells the person. */
  routeTo: z.string().min(1).max(100).optional(),
  /** The shop's own words for a mistake in a field; `{label}` is replaced by the field's label. */
  messages: z.object({ required: z.string().max(160), email: z.string().max(160), phone: z.string().max(160), tooLong: z.string().max(160), choose: z.string().max(160) }).partial().strict().optional(),
  /** What the form is for, so the assistant opens it at the right moment ("the person wants to contact us or make an enquiry"). */
  whenToOffer: z.string().min(1).max(300).optional(),
}).strict().superRefine((form, ctx) => {
  const seen = new Set<string>();
  form.fields.forEach((field, index) => {
    if (seen.has(field.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'id'], message: `Two fields are called '${field.id}'.` });
    seen.add(field.id);
  });
});

export const FormsSchema = z.array(FormDefinitionSchema).max(20);

export type FormField = z.infer<typeof FormFieldSchema>;
export type FormDefinition = z.infer<typeof FormDefinitionSchema>;
