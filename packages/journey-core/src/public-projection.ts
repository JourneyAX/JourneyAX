import projection from './defaults/public-projection.json';

/**
 * The customer-facing view of a turn. The runtime and the commerce service speak a richer language to each other
 * (decision internals, the knowledge trace with release ids and checksums, the whole policy wording, model routes);
 * a browser gets only what the storefront renders. The allow-list is data (`defaults/public-projection.json`): an event
 * or field that is not on it is not sent, so a new internal field is private by default.
 */

type Json = Record<string, any>;

interface ProjectionSpec {
  events: Record<string, { fields: string[]; message?: 'from_code' }>;
  dropEvents: string[];
  unknownEvents: 'drop' | 'pass';
  errorMessages: { default: string; byCode: Record<string, string> };
  turnResult: { fields: string[]; workspace: string[]; decision: string[]; uiInstruction: string[] };
}

const SPEC = projection as unknown as ProjectionSpec;

const pick = (source: Json, fields: string[]): Json => {
  const out: Json = {};
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field];
  return out;
};

/** The message a customer may see for an error: chosen from the error's code, never taken from the error itself. */
export function publicErrorMessage(code?: unknown, spec: ProjectionSpec = SPEC): string {
  return (typeof code === 'string' && spec.errorMessages.byCode[code]) || spec.errorMessages.default;
}

/** One stream event as the public sees it, or `null` when it must not be sent at all. */
export function projectPublicEvent(event: string, data: unknown, spec: ProjectionSpec = SPEC): { event: string; data: unknown } | null {
  if (spec.dropEvents.includes(event)) return null;
  const rule = spec.events[event];
  if (!rule) return spec.unknownEvents === 'pass' ? { event, data } : null;
  const source: Json = data && typeof data === 'object' ? (data as Json) : { value: data };
  const out = pick(source, rule.fields);
  if (event === 'done') {
    // The reply and the cards the customer sees; the decision's type alone, never its payload or trace.
    if (typeof out.message === 'object' && out.message) out.message = pick(out.message, ['role', 'content']);
  }
  if (event === 'error') {
    out.message = publicErrorMessage(source.code, spec);
  }
  return { event, data: out };
}

/** A buffered turn result as the public sees it. */
export function projectPublicTurnResult(result: unknown, spec: ProjectionSpec = SPEC): Json {
  const source = (result && typeof result === 'object' ? result : {}) as Json;
  const rules = spec.turnResult;
  const out = pick(source, rules.fields.filter((field) => !['workspace', 'decision', 'uiInstructions'].includes(field)));
  if (source.workspace) out.workspace = pick(source.workspace, rules.workspace);
  if (source.decision) out.decision = pick(source.decision, rules.decision);
  if (Array.isArray(source.uiInstructions)) out.uiInstructions = source.uiInstructions.map((instruction: Json) => pick(instruction, rules.uiInstruction));
  return out;
}

/** Wraps an emitter so everything written through it is projected. */
export function publicEmitter(emit: (event: string, data: any) => void, spec: ProjectionSpec = SPEC): (event: string, data: any) => void {
  return (event, data) => {
    const projected = projectPublicEvent(event, data, spec);
    if (projected) emit(projected.event, projected.data);
  };
}
