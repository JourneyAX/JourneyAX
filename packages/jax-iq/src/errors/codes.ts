/**
 * The error codes JAX IQ speaks, in layers. A request code fails the whole call with an HTTP status and no data. A system code never fails
 * the call by itself: it makes the facts that system holds "not available" and the outcome `partial`. A resolve code is an answer about
 * who was meant, and a signal code says why one signal was not worked out.
 *
 * The first twenty-seven are the specification's table, in its order. `not_read_only`, `principal_not_staff` and `source_not_set_up`
 * were added by the build plan.
 */
export const JAX_IQ_ERROR_CODES = [
  'invalid_request', 'principal_missing', 'service_unauthorised', 'scope_mismatch',
  'release_unavailable', 'release_mismatch', 'not_configured', 'refused_by_rule',
  'no_match', 'ambiguous', 'key_table_unavailable', 'deadline_exceeded',
  'source_not_connected', 'source_not_authorised', 'source_not_found', 'source_rate_limited',
  'source_timeout', 'source_unavailable', 'source_rejected', 'source_bad_arguments',
  'source_internal', 'source_shape_mismatch', 'source_truncated',
  'signal_input_unavailable', 'signal_setting_missing', 'signal_divisor_zero',
  'internal_error',
  'not_read_only', 'principal_not_staff', 'source_not_set_up',
] as const;

export type JaxIqErrorCode = (typeof JAX_IQ_ERROR_CODES)[number];

export type JaxIqErrorLayer = 'request' | 'resolve' | 'system' | 'signal';

/** `later`: try again after the release is back. `cool_down`: leave that system alone for a while, do not retry at once. */
export type JaxIqRetry = 'no' | 'yes' | 'later' | 'cool_down';

export interface JaxIqErrorInfo {
  layer: JaxIqErrorLayer;
  retry: JaxIqRetry;
  /** The HTTP status when the call fails with this code. `null`: the code never fails a call by itself. */
  httpStatus: number | null;
  /** The status instead, when part of the call had already answered. */
  partialHttpStatus?: number;
  /** The binding or the dictionary is wrong, not the vendor. */
  defect: boolean;
  /** Someone should be told: a defect, or a sign-in the vendor refuses. */
  alert: boolean;
  /** What the assistant is told, in plain words. `<System>`, `<input>` and `<setting>` stand for the name. `null`: nothing is said. */
  said: string | null;
}

const row = (layer: JaxIqErrorLayer, retry: JaxIqRetry, httpStatus: number | null, said: string | null, more: Partial<JaxIqErrorInfo> = {}): JaxIqErrorInfo =>
  ({ layer, retry, httpStatus, defect: false, alert: false, said, ...more });

const RECORDS_UNREACHABLE = 'I cannot reach the business records just now.';
const CANNOT_LOOK_UP = 'I cannot look that up just now.';

export const JAX_IQ_ERROR_TABLE: Readonly<Record<JaxIqErrorCode, JaxIqErrorInfo>> = {
  invalid_request: row('request', 'no', 400, 'That is not something I can look up.'),
  principal_missing: row('request', 'no', 401, null),
  service_unauthorised: row('request', 'no', 401, null),
  scope_mismatch: row('request', 'no', 403, null),
  release_unavailable: row('request', 'later', 503, RECORDS_UNREACHABLE),
  release_mismatch: row('request', 'later', 409, RECORDS_UNREACHABLE),
  not_configured: row('request', 'no', 503, RECORDS_UNREACHABLE),
  refused_by_rule: row('request', 'no', 200, 'You are not able to see that.'),
  no_match: row('resolve', 'no', 200, 'Nothing matches that.'),
  ambiguous: row('resolve', 'no', 200, 'Which one do you mean?'),
  key_table_unavailable: row('request', 'yes', 503, CANNOT_LOOK_UP),
  deadline_exceeded: row('request', 'yes', 504, 'Time ran out before <System> answered.', { partialHttpStatus: 200 }),
  source_not_connected: row('system', 'no', null, '<System> is not connected yet.'),
  source_not_authorised: row('system', 'no', null, '<System> would not let us in.', { alert: true }),
  source_not_found: row('system', 'no', null, '<System> has no record of it.'),
  source_rate_limited: row('system', 'cool_down', null, '<System> is busy; try again shortly.'),
  source_timeout: row('system', 'yes', null, '<System> took too long.'),
  source_unavailable: row('system', 'yes', null, '<System> is not answering.'),
  source_rejected: row('system', 'no', null, '<System> could not answer that.'),
  source_bad_arguments: row('system', 'no', null, 'I could not ask <System> that.', { defect: true, alert: true }),
  source_internal: row('system', 'no', null, '<System> could not answer.'),
  source_shape_mismatch: row('system', 'no', null, '<System> gave an answer I cannot rely on.', { defect: true, alert: true }),
  source_truncated: row('system', 'no', null, 'Showing part of the list.'),
  signal_input_unavailable: row('signal', 'no', null, 'Not worked out: <input> is not available.'),
  signal_setting_missing: row('signal', 'no', null, 'Not worked out: no <setting> has been set.'),
  signal_divisor_zero: row('signal', 'no', null, 'Not worked out: <input> is zero or missing.'),
  internal_error: row('request', 'yes', 500, CANNOT_LOOK_UP),
  not_read_only: row('system', 'no', null, 'I could not ask <System> that.'),
  principal_not_staff: row('request', 'no', 403, null),
  source_not_set_up: row('system', 'no', null, '<System> has not been set up for that yet.'),
};

export function isJaxIqErrorCode(value: unknown): value is JaxIqErrorCode {
  return typeof value === 'string' && (JAX_IQ_ERROR_CODES as readonly string[]).includes(value);
}
