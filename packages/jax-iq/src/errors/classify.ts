import type { FailedConnectorOutcome } from '../ports/outcome';
import type { JaxIqErrorCode } from './codes';

/**
 * What a failed call leaves behind: how it failed when that is known, the connector's own code when it has been read, and its words. A
 * failed `ConnectorOutcome` fits as it is; so do the text of an `isError` answer and the message of a thrown error on their own.
 */
export interface ConnectorFailureInput {
  kind?: FailedConnectorOutcome['kind'];
  code?: string;
  message: string;
}

/** The codes the connector servers send in an `isError` answer, and the JAX IQ code each one becomes. */
const CONNECTOR_CODES = new Map<string, JaxIqErrorCode>([
  ['invalid_arguments', 'source_bad_arguments'],
  ['not_found', 'source_not_found'],
  ['not_connected', 'source_not_connected'],
  ['rejected', 'source_rejected'],
  ['rate_limited', 'source_rate_limited'],
  ['not_authorised', 'source_not_authorised'],
  ['unavailable', 'source_unavailable'],
  ['timeout', 'source_timeout'],
  ['conflict', 'source_rejected'],
  ['not_set_up', 'source_not_set_up'],
  ['internal_error', 'source_internal'],
]);

/** A code the connector did not name before, or named in a way we do not know, is a failure it did not explain. */
const fromConnectorCode = (code: string): JaxIqErrorCode => CONNECTOR_CODES.get(code) ?? 'source_internal';

/** The text of an `isError` answer is the connector's whole JSON answer: `{ ok: false, connector, error: { code, message } }`. */
function codeInJson(text: string): string | undefined {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The same code read out of text that is not clean JSON: an answer cut at the size cap, or one quoted inside a longer message. */
const codeInText = (text: string): string | undefined => /"error"\s*:\s*\{\s*"code"\s*:\s*"([A-Za-z_]+)"/.exec(text)?.[1];

/**
 * The messages the MCP client, its transport and the server directory throw, read the way the runtime reads them for its own connector
 * audit. A status in the message is read first, so words in a response body cannot change it.
 */
function fromTransportMessage(message: string): JaxIqErrorCode | undefined {
  const status = Number(/\bHTTP (\d{3})\b/.exec(message)?.[1]);
  if (status >= 500) return 'source_unavailable';
  if (status >= 400) return 'source_rejected';
  if (/did not answer within/i.test(message)) return 'source_timeout';
  if (/Could not reach/i.test(message)) return 'source_unavailable';
  if (/not configured|secret reference refused|MCP server address/i.test(message)) return 'not_configured';
  if (/sent no answer|answer that is not JSON/i.test(message)) return 'source_unavailable';
  return undefined;
}

/**
 * Turns a failed connector call into a JAX IQ error code.
 *
 * The kind decides first where it says enough. Otherwise the connector's own code is read, from `code` or from the JSON text of the
 * answer, and mapped. Only when there is none do the transport message patterns apply, then a code quoted inside the message. Anything
 * that is still unexplained is `source_internal`: the system failed in a way it did not name.
 */
export function classifyConnectorFailure(failure: ConnectorFailureInput): JaxIqErrorCode {
  switch (failure.kind) {
    case 'timeout': return 'source_timeout';
    case 'not_configured': return 'not_configured';
    case 'not_read_only': return 'not_read_only';
    case 'protocol': return 'source_internal';
    case 'transport': return fromTransportMessage(failure.message) ?? 'source_unavailable';
    default: break;
  }
  const code = failure.code ?? codeInJson(failure.message);
  if (code !== undefined) return fromConnectorCode(code);
  // The dispatcher's own wording carries the tool's answer inside it: the code in there is the one to read.
  const quoted = /reported an error/i.test(failure.message);
  const transport = quoted ? undefined : fromTransportMessage(failure.message);
  if (transport) return transport;
  const inside = codeInText(failure.message);
  return inside === undefined ? 'source_internal' : fromConnectorCode(inside);
}
