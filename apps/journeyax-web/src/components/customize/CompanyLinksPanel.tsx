'use client';

/**
 * Business customers and their companies: which login belongs to which company, set by hand by the team.
 *
 * A signed-in customer who is linked here can ask the assistant about their own company's deliveries, balance and prices; a customer who is
 * not linked is an ordinary shopper. The team checks who a person is before linking their login, so nothing about this is self-service.
 * Changing a link needs no publishing and changes no wording; it shows within a minute.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CloseIcon } from '@/components/shell/icons';
import { COMPANY_ROLES, parseLinks, roleLabel, type CompanyLinkRow, type CompanyRoleId } from '@/lib/customize/companyLinks';

const URL = (tenant: string | undefined) => `/api/customize/company-links?project=${encodeURIComponent(tenant || '')}`;

async function call(tenant: string | undefined, method: 'GET' | 'PUT' | 'DELETE', body?: unknown): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch(URL(tenant), {
      method, credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, error: res.ok ? '' : String(data?.error || 'That did not work just now.'), data };
  } catch {
    return { ok: false, error: 'The service did not answer.', data: {} };
  }
}

export default function CompanyLinksPanel({ tenant, onToast }: { tenant: string | undefined; onToast: (message: string) => void }) {
  const [links, setLinks] = useState<CompanyLinkRow[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CompanyLinkRow | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');

  const load = useCallback(async () => {
    const result = await call(tenant, 'GET');
    if (result.ok) { setLinks(parseLinks(result.data)); setError(''); } else setError(result.error);
  }, [tenant]);
  useEffect(() => { void load(); }, [load]);

  const save = async (row: { email: string; companyId: string; companyName: string; role: CompanyRoleId }) => {
    setBusy(true); setSaveError('');
    const result = await call(tenant, 'PUT', row);
    setBusy(false);
    if (!result.ok) { setSaveError(result.error); return; }
    setEditing(null);
    onToast(`Linked ${row.email} to ${row.companyName} as ${roleLabel(row.role).toLowerCase()}.`);
    void load();
  };
  const unlink = async (row: CompanyLinkRow) => {
    setBusy(true);
    const result = await call(tenant, 'DELETE', { email: row.email, companyId: row.companyId });
    setBusy(false);
    if (!result.ok) { onToast(result.error); return; }
    onToast(`${row.email} is no longer linked to ${row.companyName}.`);
    void load();
  };

  return (
    <section aria-label="Company links" style={{ marginTop: 28 }}>
      <h2 className="ax-listhead">Company links <span className="ax-muted">{links ? `${links.length} linked` : ''}</span></h2>
      <p className="ax-hint ax-teamnote">
        A customer who signs in can ask the assistant about their own company’s deliveries, balance and prices once their login is linked to the company here. You link
        people by hand, after checking who they are; a login that is not linked is an ordinary shopper. A link takes effect within a minute and needs no publishing.
      </p>
      {error && <div className="ax-notice ax-notice--error" role="alert">{error} <button type="button" className="ax-linkbtn" onClick={() => void load()}>Try again</button></div>}
      {!error && links === null && <ul className="ax-grid" aria-busy="true" aria-label="Loading"><li className="ax-skeleton" /></ul>}
      {links && links.length === 0 && <p className="ax-hint">No login is linked to a company yet.</p>}
      {links && links.length > 0 && (
        <div className="ax-rules__scroll">
          <table className="ax-ctable ax-ctable--links">
            <thead><tr><th scope="col">Login</th><th scope="col">Company</th><th scope="col">Account id</th><th scope="col">Role</th><th scope="col"><span className="ax-sr">Actions</span></th></tr></thead>
            <tbody>
              {links.map((row) => (
                <tr key={`${row.email}|${row.companyId}`}>
                  <td>{row.email}</td>
                  <td>{row.companyName}</td>
                  <td><code>{row.companyId}</code></td>
                  <td>{roleLabel(row.role)}</td>
                  <td>
                    <button type="button" className="ax-btn ax-btn--small ax-btn--quiet" onClick={() => { setSaveError(''); setEditing(row); }}>Change</button>{' '}
                    <button type="button" className="ax-btn ax-btn--small ax-btn--quiet" disabled={busy} onClick={() => void unlink(row)} aria-label={`Unlink ${row.email} from ${row.companyName}`}>Unlink</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button type="button" className="ax-btn ax-btn--primary" onClick={() => { setSaveError(''); setEditing('new'); }}>Link a login to a company</button>
      </div>
      {editing && (
        <LinkDialog
          key={editing === 'new' ? 'new' : `${editing.email}|${editing.companyId}`}
          row={editing === 'new' ? null : editing}
          busy={busy}
          error={saveError}
          onSave={save}
          onClose={() => { setEditing(null); setSaveError(''); }}
        />
      )}
    </section>
  );
}

function LinkDialog({ row, busy, error, onSave, onClose }: {
  row: CompanyLinkRow | null;
  busy: boolean;
  error: string;
  onSave: (row: { email: string; companyId: string; companyName: string; role: CompanyRoleId }) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(row?.email ?? '');
  const [companyId, setCompanyId] = useState(row?.companyId ?? '');
  const [companyName, setCompanyName] = useState(row?.companyName ?? '');
  const [role, setRole] = useState<CompanyRoleId>(row?.role ?? 'buyer');
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const valid = /^[^\s@]+@[^\s@]+$/.test(email.trim()) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(companyId.trim()) && companyName.trim().length > 0;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('input:not([disabled])')?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onSave({ email: email.trim().toLowerCase(), companyId: companyId.trim(), companyName: companyName.trim(), role });
  };

  return (
    <div className="ax-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ax-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="ax-dialog__head">
          <h2 id={titleId}>{row ? 'Change a link' : 'Link a login to a company'}</h2>
          <button type="button" className="ax-iconbtn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="ax-dialog__body">
            <p className="ax-hint" style={{ margin: 0 }}>Link a login only after you have checked who the person is. They will then see their own company’s deliveries, prices and (for some roles) balance in the chat, and nothing of any other company.</p>
            <div className="ax-formrow">
              <label htmlFor={`${titleId}-email`}>Login (the e-mail they sign in with)</label>
              <input id={`${titleId}-email`} type="email" className="ax-input" value={email} onChange={(e) => setEmail(e.target.value)} readOnly={!!row} autoComplete="off" />
            </div>
            <div className="ax-formrow">
              <label htmlFor={`${titleId}-name`}>Company name</label>
              <input id={`${titleId}-name`} className="ax-input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={160} autoComplete="off" />
            </div>
            <div className="ax-formrow">
              <label htmlFor={`${titleId}-id`}>Account id in the accounts system</label>
              <input id={`${titleId}-id`} className="ax-input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} maxLength={64} placeholder="for example ACC-0028" readOnly={!!row} autoComplete="off" />
              <span className="ax-hint">The id the accounts system uses for the company. The assistant reads the company’s data with it; the customer never types it.</span>
            </div>
            <div className="ax-formrow">
              <label htmlFor={`${titleId}-role`}>Role in the company</label>
              <select id={`${titleId}-role`} className="ax-input" value={role} onChange={(e) => setRole(e.target.value as CompanyRoleId)}>
                {COMPANY_ROLES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
              <span className="ax-hint">{COMPANY_ROLES.find((entry) => entry.id === role)?.hint}</span>
            </div>
            {error && <p className="ax-error" role="alert">{error}</p>}
          </div>
          <div className="ax-dialog__foot">
            <button type="button" className="ax-btn ax-btn--quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="ax-btn ax-btn--primary" disabled={busy || !valid}>{busy ? 'Saving…' : row ? 'Save the change' : 'Link the login'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
