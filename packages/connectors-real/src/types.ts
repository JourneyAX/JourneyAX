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

/** Source-side metadata from the verified command grant. Never model arguments. */
export interface ToolExecutionContext {
  actionId: string;
  tenantId: string;
  environmentId: string;
  principalId: string;
  workspaceId?: string;
  releaseChecksum: string;
}

export interface ToolSpec {
  /** Reserved server-owned workflow grant, never derived from model arguments. */
  requiredWorkflowGrant?: string;
  name: string;
  description: string;
  /** JSON Schema for the arguments (an object). The server checks the arguments against it before the tool runs. */
  inputSchema: Rec;
  /** False for a tool that changes something in the vendor's system. */
  readOnly: boolean;
  /** Tool returns staff-only fields, irrespective of a mistakenly broad dictionary mapping. */
  staffOnly?: boolean;
  /** For a shopper, these flat inputs must equal the identity in the signed caller grant. */
  shopperIdentityFields?: string[];
  /** Only the provider-confirmed payment workflow may record a paid commerce order. */
  requiresPaymentReceipt?: boolean;
  /** Returns what goes into the result next to `ok` and `connector`. Throws a {@link ToolError} for anything the model should be told. */
  run(args: Rec, execution?: ToolExecutionContext): Promise<Rec>;
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
