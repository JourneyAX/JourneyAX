/**
 * Reading the persona library from the project service, and saving the tools a person says one scenario needs. The browser never talks to
 * the project service itself: the web route calls these with the person's own token, and the project service checks the permission to
 * change the configuration (a person without it is told so, here, in plain words).
 */
import { parsePersonaLibraryAnswer } from './personas';

export interface PersonaDeps {
  /** `<project api>/api/v1/projects/<tenant>` */
  base: string;
  /** Authorization and tenant headers. */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}
export interface PersonaResult { status: number; body: Record<string, unknown> }

export interface ScenarioToolsOp { useCaseId: string; tools: string[]; expectedRevision: number }

const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const forbidden = (): PersonaResult => ({ status: 403, body: { error: 'The personas are shown to people who may change the configuration.' } });
const messageOf = async (res: Response, fallback: string): Promise<string> => {
  const detail: any = await res.json().catch(() => ({}));
  const message = Array.isArray(detail?.message) ? detail.message.join(' ') : detail?.message;
  return typeof message === 'string' && message ? message : fallback;
};

/** What the page asked to save, or why it cannot be saved. */
export function readScenarioOp(body: unknown): ScenarioToolsOp | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const useCaseId = typeof b.useCaseId === 'string' ? b.useCaseId.trim() : '';
  if (!useCaseId || useCaseId.length > 64) return { error: 'Say which use case the tools are for.' };
  if (typeof b.expectedRevision !== 'number' || !Number.isInteger(b.expectedRevision) || b.expectedRevision < 1) return { error: 'Say which version of the library you were looking at.' };
  if (!Array.isArray(b.tools) || b.tools.length > 40 || !b.tools.every((t) => typeof t === 'string' && TOOL_ID.test(t))) return { error: 'The tools must be a list of at most 40 tool names.' };
  return { useCaseId, tools: [...new Set(b.tools as string[])], expectedRevision: b.expectedRevision };
}

export async function readLibrary(deps: PersonaDeps): Promise<PersonaResult> {
  const call = deps.fetchImpl ?? fetch;
  let res: Response;
  try { res = await call(`${deps.base}/persona-library`, { headers: deps.headers, signal: AbortSignal.timeout(8000), cache: 'no-store' }); }
  catch { return { status: 502, body: { error: 'The persona library could not be read: the service did not answer.' } }; }
  if (res.status === 401 || res.status === 403) return forbidden();
  if (res.status === 404) return { status: 404, body: { error: await messageOf(res, 'This project does not exist.') } };
  if (!res.ok) return { status: 502, body: { error: 'The persona library could not be read just now.' } };
  const answer = parsePersonaLibraryAnswer(await res.json().catch(() => null));
  if (!answer) return { status: 502, body: { error: 'The persona library came back in a shape this page does not know.' } };
  return { status: 200, body: answer as unknown as Record<string, unknown> };
}

export async function saveScenarioTools(deps: PersonaDeps, op: ScenarioToolsOp): Promise<PersonaResult> {
  const call = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await call(`${deps.base}/persona-library/scenario-tools`, {
      method: 'PUT', headers: { ...deps.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(op), signal: AbortSignal.timeout(8000),
    });
  } catch { return { status: 502, body: { error: 'The tools could not be saved: the service did not answer.' } }; }
  if (res.status === 401 || res.status === 403) return { status: 403, body: { error: 'Saving the tools of a scenario needs permission to change the configuration.' } };
  if (res.status === 409) return { status: 409, body: { error: await messageOf(res, 'The persona library was changed since you loaded it. Reload and try again.') } };
  if (res.status === 400 || res.status === 404) return { status: res.status, body: { error: await messageOf(res, 'The tools could not be saved.') } };
  if (!res.ok) return { status: 502, body: { error: 'The tools could not be saved just now.' } };
  const done: any = await res.json().catch(() => ({}));
  return { status: 200, body: { ok: true, revision: typeof done.revision === 'number' ? done.revision : op.expectedRevision + 1, scenarioTools: Array.isArray(done.scenarioTools) ? done.scenarioTools : op.tools } };
}
