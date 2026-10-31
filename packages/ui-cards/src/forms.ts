/**
 * Checking what a person typed into a form against the form's definition. One function, used by the page (so mistakes are shown as they
 * type) and by the server (which never trusts the page): they cannot disagree about what is acceptable.
 *
 * Only the fields the form declares are kept; anything else in the submission is dropped. Text is trimmed and stripped of control
 * characters; a select answer must be one of its options.
 */
export type FormFieldType = 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'checkbox';

export interface FormFieldLike {
  id: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
  maxLength?: number;
  placeholder?: string;
}

export interface FormLike {
  fields: FormFieldLike[];
  /** The shop's own words for the mistakes; `{label}` is replaced by the field's label. */
  messages?: Partial<Record<'required' | 'email' | 'phone' | 'tooLong' | 'choose', string>>;
}

export type FormValues = Record<string, string | boolean>;

export interface FormCheck {
  ok: boolean;
  /** What is kept: only declared fields, cleaned; empty optional answers are left out. */
  values: FormValues;
  /** One plain sentence per field that is not acceptable, by field id. */
  errors: Record<string, string>;
}

const DEFAULT_MESSAGES = {
  required: 'Please fill in {label}.',
  email: 'Please enter a full email address for {label}.',
  phone: 'Please enter a phone number for {label}.',
  tooLong: '{label} is too long.',
  choose: 'Please choose one of the options for {label}.',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_CHARS = /^\+?[0-9 ()-]+$/;
const DEFAULT_LIMIT: Record<FormFieldType, number> = { text: 200, email: 254, phone: 40, textarea: 2000, select: 80, checkbox: 5 };

/** Control characters out; a single-line answer has its runs of spaces and line breaks folded to single spaces. */
export function cleanText(value: unknown, multiline: boolean): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  const noControls = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return (multiline ? noControls.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : noControls.replace(/\s+/g, ' ')).trim();
}

export function validateFormValues(form: FormLike, raw: unknown): FormCheck {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const messages = { ...DEFAULT_MESSAGES, ...(form.messages || {}) };
  const say = (template: string, field: FormFieldLike) => template.replace(/\{label\}/g, field.label);
  const values: FormValues = {};
  const errors: Record<string, string> = {};

  for (const field of form.fields) {
    const given = input[field.id];
    if (field.type === 'checkbox') {
      const checked = given === true || given === 'true' || given === 'on';
      if (checked) values[field.id] = true;
      else if (field.required) errors[field.id] = say(messages.required, field);
      continue;
    }
    const text = cleanText(given, field.type === 'textarea');
    if (text === '') {
      if (field.required) errors[field.id] = say(messages.required, field);
      continue;
    }
    if (text.length > (field.maxLength ?? DEFAULT_LIMIT[field.type])) { errors[field.id] = say(messages.tooLong, field); continue; }
    if (field.type === 'email' && !EMAIL.test(text)) { errors[field.id] = say(messages.email, field); continue; }
    if (field.type === 'phone') {
      const digits = text.replace(/\D/g, '');
      if (!PHONE_CHARS.test(text) || digits.length < 6 || digits.length > 15) { errors[field.id] = say(messages.phone, field); continue; }
    }
    if (field.type === 'select' && !(field.options || []).includes(text)) { errors[field.id] = say(messages.choose, field); continue; }
    values[field.id] = text;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}
