/**
 * The shape of a real connector. Like a sample connector it is a named group of tools with a description; unlike one it holds no records:
 * each tool asks the vendor's own system and shapes the answer the way the sample connector's answer was shaped (`records` with a `total`
 * for a list, one `record` for a get, `created: true` for a write), so the pack's rules, claim classes and prompts need not change.
 */
export type Rec = Record<string, any>;
export type Env = Record<string, string | undefined>;
export type Fetch = typeof fetch;

export interface Deps {
  fetchImpl: Fetch;
  now: () => number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments (an object). The server checks the arguments against it before the tool runs. */
  inputSchema: Rec;
  /** False for a tool that changes something in the vendor's system. */
  readOnly: boolean;
  /** Returns what goes into the result next to `ok` and `connector`. Throws a {@link ToolError} for anything the model should be told. */
  run(args: Rec): Promise<Rec>;
}

export interface RealConnector {
  connectorId: string;
  title: string;
  description: string;
  /** The names (never the values) of the settings this connector needs. */
  required: string[];
  /** The required settings that are not set. Empty when the connector can run. */
  missing(): string[];
  tools: ToolSpec[];
}

/** A failure the model may be told about, in plain words. `code` is stable (`not_found`, `not_authorised`, `rate_limited`, ...). */
export class ToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
