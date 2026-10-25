/**
 * The shape of a sample connector, as data. A connector is a `connector.json` (its tools, each with a small declarative `op` that says what
 * the tool does to the records) and a `seed.json` (the records). The server code knows nothing about any shop: everything that is about a
 * business lives in those two files.
 */
export type Rec = Record<string, any>;

export interface Filter {
  arg: string;
  field: string;
  /** Default `equals` (case-insensitive for text). */
  match?: 'equals' | 'contains' | 'gte' | 'lte';
}

export interface TextSearch {
  arg: string;
  fields: Array<{ field: string; weight?: number }>;
  /** `all`: every word must match somewhere (default). `any`: one word is enough. */
  mode?: 'all' | 'any';
}

export interface Limit { arg?: string; default: number; max: number }
export interface Sort { field: string; order?: 'asc' | 'desc' }

export interface Origin {
  /** Where the position comes from: two arguments... */
  latArg?: string;
  lngArg?: string;
  /** ...or a record found by key in another collection. */
  collection?: string;
  key?: string;
  arg?: string;
  latField?: string;
  lngField?: string;
}

export type Op =
  | { kind: 'find'; collection: string; text?: TextSearch; filters?: Filter[]; limit: Limit; sort?: Sort; select?: string[] }
  | { kind: 'get'; collection: string; key: string; arg: string; altKeys?: Array<{ key: string; arg: string }>; include?: Array<{ collection: string; foreignKey: string; as: string; limit?: number }>; select?: string[] }
  | { kind: 'create'; collection: string; idField: string; idPrefix: string; idWidth: number; fields: Record<string, { arg: string; required?: boolean }>; defaults?: Rec; stamp?: string[]; validate?: Array<{ arg: string; collection: string; field: string; message: string; copy?: Record<string, string> }> }
  | { kind: 'aggregate'; collection: string; groupBy?: string; filters?: Filter[]; metrics: Array<{ name: string; op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }>; sort?: Sort; limit?: Limit }
  | { kind: 'nearest'; collection: string; latField: string; lngField: string; from: Origin; limit: Limit }
  | { kind: 'drive'; from: Origin; to: Origin; roadFactor: number; avgKmh: number }
  | { kind: 'match'; collection: string; text: TextSearch; minScore: number; suggestions: number };

export interface ToolFile {
  name: string;
  description: string;
  inputSchema: Rec;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** Arguments that make a good call; the tests call every tool with them. */
  example: Rec;
  op: Op;
}

export interface ConnectorFile {
  connectorId: string;
  title: string;
  /** The system this stands in for. */
  standsInFor: string;
  description: string;
  /** The smallest number of records each named collection must hold. */
  minimums: Record<string, number>;
  tools: ToolFile[];
}

export interface CollectionProvenance {
  /** `real`: copied from the business's own data. `sample`: invented. `mixed`: a real thing with invented fields. */
  origin: 'real' | 'sample' | 'mixed';
  source: string;
  realFields: string[];
  madeUpFields: string[];
}

export interface SeedFile {
  connectorId: string;
  tenantId: string;
  builtFrom: string;
  collections: Record<string, Rec[]>;
  provenance: Record<string, CollectionProvenance>;
}

export class ToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
