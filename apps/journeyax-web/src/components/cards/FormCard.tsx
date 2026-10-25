'use client';

/**
 * A form the shop offers (contact us, an enquiry), filled in and sent from the chat. The fields and the words are the shop's; what is
 * typed is checked here as it is typed with the same function the server uses (@journeyax/ui-cards validateFormValues), and the server
 * checks it again, because it never trusts the page. It sends one action, `submitForm`, with the form's id and the values.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { validateFormValues, type FormFieldLike, type FormValues } from '@journeyax/ui-cards';

type Action = (name: string, params?: Record<string, unknown>) => void;

interface FormState {
  formId: string;
  title: string;
  intro?: string;
  fields: FormFieldLike[];
  values?: FormValues;
  submitLabel?: string;
  messages?: Record<string, string>;
  status?: 'open' | 'sent';
  sentText?: string;
}

const box: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--ax-border, #E4DFD5)', borderRadius: 8, background: 'var(--ax-surface, #fff)', color: 'var(--ax-text, #211E1A)', font: 'inherit' };

export default function FormCard({ state, onAction }: { state: FormState; onAction: Action }) {
  const base = useId();
  const [values, setValues] = useState<FormValues>(() => ({ ...(state.values || {}) }));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const sent = state.status === 'sent';
  // When the assistant reopens the form with more filled in, what the person already typed is kept.
  useEffect(() => { setValues((current) => ({ ...(state.values || {}), ...current })); }, [state.values]);

  const check = validateFormValues({ fields: state.fields, messages: state.messages }, values);
  const showError = (id: string) => (tried || touched[id]) && check.errors[id];
  const set = (id: string, value: string | boolean) => setValues((current) => ({ ...current, [id]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setTried(true);
    if (!check.ok || sent) return;
    onAction('submitForm', { formId: state.formId, values: check.values });
  };

  return (
    <form className="ax-form" noValidate onSubmit={submit} aria-label={state.title} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 18 }}>{state.title}</h3>
        {state.intro ? <p style={{ margin: '6px 0 0', color: 'var(--ax-muted, #7D7466)' }}>{state.intro}</p> : null}
      </div>
      {state.fields.map((field) => {
        const id = `${base}-${field.id}`;
        const error = showError(field.id);
        const value = values[field.id];
        const describedBy = error ? `${id}-error` : undefined;
        return (
          <div key={field.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {field.type === 'checkbox' ? (
              <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input id={id} type="checkbox" checked={value === true} disabled={sent} aria-describedby={describedBy} onChange={(e) => set(field.id, e.target.checked)} onBlur={() => setTouched((t) => ({ ...t, [field.id]: true }))} />
                <span>{field.label}{field.required ? ' *' : ''}</span>
              </label>
            ) : (
              <>
                <label htmlFor={id} style={{ fontWeight: 600, fontSize: 14 }}>{field.label}{field.required ? ' *' : ''}</label>
                {field.type === 'textarea' ? (
                  <textarea id={id} rows={4} value={typeof value === 'string' ? value : ''} placeholder={field.placeholder} maxLength={field.maxLength ?? 2000} disabled={sent} aria-invalid={!!error} aria-describedby={describedBy} style={{ ...box, resize: 'vertical' }} onChange={(e) => set(field.id, e.target.value)} onBlur={() => setTouched((t) => ({ ...t, [field.id]: true }))} />
                ) : field.type === 'select' ? (
                  <select id={id} value={typeof value === 'string' ? value : ''} disabled={sent} aria-invalid={!!error} aria-describedby={describedBy} style={box} onChange={(e) => set(field.id, e.target.value)} onBlur={() => setTouched((t) => ({ ...t, [field.id]: true }))}>
                    <option value="">Choose…</option>
                    {(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <input id={id} type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'} inputMode={field.type === 'phone' ? 'tel' : undefined} autoComplete={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : undefined} value={typeof value === 'string' ? value : ''} placeholder={field.placeholder} maxLength={field.maxLength ?? 200} disabled={sent} aria-invalid={!!error} aria-describedby={describedBy} style={box} onChange={(e) => set(field.id, e.target.value)} onBlur={() => setTouched((t) => ({ ...t, [field.id]: true }))} />
                )}
              </>
            )}
            {error ? <span id={`${id}-error`} role="alert" style={{ color: 'var(--ax-danger, #b3261e)', fontSize: 13 }}>{error}</span> : null}
          </div>
        );
      })}
      {sent ? (
        <p role="status" style={{ margin: 0, color: 'var(--ax-muted, #7D7466)' }}>{state.sentText || 'Sent.'}</p>
      ) : (
        <div>
          <button type="submit" className="ax-btn ax-btn--primary">{state.submitLabel || 'Send'}</button>
        </div>
      )}
    </form>
  );
}
