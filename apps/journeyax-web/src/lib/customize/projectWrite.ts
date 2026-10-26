/**
 * Writing a change to the project's settings and making it live, safely: the one routine every Customize editor uses.
 *
 *   read the settings -> (the caller works out the change) -> save it with the project's own update route -> publish through the
 *   publication gate -> if the gate refuses (or does not answer), put the settings back exactly as they were.
 *
 * Nothing here knows what a skill or a rule is. It never talks to a database or the runtime, and it writes nothing unless the caller has
 * already checked the person's permission to publish.
 */
type Rec = Record<string, any>;

export interface WriteDeps {
  /** `<project api>/api/v1/projects/<tenant>` */
  base: string;
  /** Authorization and tenant headers (and the JSON content type). */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  environmentId?: string;
}

export interface ChangeResult { status: number; body: Rec }

export const ok = (body: Rec): ChangeResult => ({ status: 200, body });
export const fail = (status: number, error: string, extra: Rec = {}): ChangeResult => ({ status, body: { error, ...extra } });

export async function readProjectSettings(deps: WriteDeps): Promise<{ project: Rec } | { error: ChangeResult }> {
  const call = deps.fetchImpl ?? fetch;
  try {
    const current = await call(deps.base, { headers: deps.headers, signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!current.ok) return { error: fail(502, 'The project could not be read.') };
    return { project: await current.json() };
  } catch {
    return { error: fail(502, 'The project could not be read: the service did not answer.') };
  }
}

/**
 * Saves `patch`, publishes with `note`, and on a refused or unanswered publish saves `undo`. `subject` is what the person calls the thing
 * being changed ("skill", "rules"), for the messages.
 */
export async function saveAndPublish(deps: WriteDeps, change: { patch: Rec; undo: Rec; note: string; subject: string }): Promise<{ ok: true; version?: string } | { ok: false; result: ChangeResult }> {
  const call = deps.fetchImpl ?? fetch;
  const put = (payload: Rec) => call(deps.base, { method: 'PATCH', headers: deps.headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  const restore = async (): Promise<boolean> => { try { return (await put(change.undo)).ok; } catch { return false; } };
  const unrestored = ' The settings could not be put back; check them in the back office.';

  let saved: Response;
  try { saved = await put(change.patch); } catch { return { ok: false, result: fail(502, `The ${change.subject} could not be saved: the service did not answer.`) }; }
  if (!saved.ok) {
    const detail: Rec = await saved.json().catch(() => ({}));
    return { ok: false, result: fail(saved.status === 400 || saved.status === 422 ? 422 : 502, `The ${change.subject} could not be saved to the project${detail?.message ? `: ${String(detail.message).slice(0, 300)}` : '.'}`) };
  }

  try {
    const published = await call(`${deps.base}/publish`, {
      method: 'POST', headers: deps.headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ environmentId: deps.environmentId ?? 'production', note: change.note }),
    });
    if (published.ok) {
      const result: Rec = await published.json().catch(() => ({}));
      return { ok: true, ...(result?.version ? { version: String(result.version) } : {}) };
    }
    const detail: Rec = await published.json().catch(() => ({}));
    return { ok: false, result: fail(422, `The configuration was not published: ${String(detail?.message || published.status)}${(await restore()) ? '' : unrestored}`) };
  } catch {
    return { ok: false, result: fail(502, `The configuration could not be published: the service did not answer.${(await restore()) ? '' : unrestored}`) };
  }
}
