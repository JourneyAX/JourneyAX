import { z } from 'zod';
import { SecretRefSchema } from './capability-binding.schema';

/**
 * Connectors the chat may reach (pack `extensions.connectors`).
 *
 * A connector is a named group of tools served by an MCP server, with a description, an owner and a rule for who may use each tool.
 * The pack holds *references* only: the name of the server (its address lives in the runtime's configuration) and a secret reference
 * (never a key). See docs/connectors/DESIGN.md.
 *
 * Who may use a tool is a table of rows, as for `extensions.agentAccess`. Three states, from least to most strict:
 *  - `allow`:   runs when the model calls it.
 *  - `ask`:     "ask first": runs only after a person has approved that exact call.
 *  - `blocked`: never runs, and is not shown to the model.
 * A person who matches several rows gets the **strictest**. A tool with no applicable row is blocked: new tools start blocked.
 */
export const CONNECTOR_STATES = ['allow', 'ask', 'blocked'] as const;
export const ConnectorStateSchema = z.enum(CONNECTOR_STATES);
export type ConnectorState = z.infer<typeof ConnectorStateSchema>;

/** A connector id: lower case, letters, digits and `-`. */
const ConnectorId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?$/, 'a connector id uses lower-case letters, digits and -');
/** A tool name as MCP servers write them. */
const ToolName = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_\-.]*$/, 'a tool name uses letters, digits and _ - .');
/** A group id as shared-types `normaliseGroupId` writes it. */
const GroupId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-.:]*[a-z0-9])?$/, 'a group id uses lower-case letters, digits and - . :');
/** A name that points at a stored connection (never a credential). */
const ConnectionRef = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\-]+$/, 'a connection reference uses letters, digits and _ . -');

export const ConnectorToolSchema = z.object({
  name: ToolName,
  /** `write` for a tool that changes something in the other system. The model is told, and the validator warns when one is set to allow. */
  sideEffect: z.enum(['read', 'write']).default('read'),
  summary: z.string().max(200).optional(),
}).strict();

export const ConnectorSchema = z.object({
  connectorId: ConnectorId,
  displayName: z.string().min(1).max(80),
  /** What the model sees in its short list of connectors: when to reach for this one. */
  description: z.string().min(1).max(400),
  /** The team or person who answers for this connector. */
  owner: z.string().min(1).max(80),
  /** The MCP server that serves it. Defaults to the connector id. The address is runtime configuration, not pack data. */
  mcpServerName: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_\-]+$/).optional(),
  /** A reference to the secret the server is called with: `tenant-secret://<tenant>/<environment>/<name>`. Never a key. */
  secretRef: SecretRefSchema.optional(),
  /** `shop`: one shared sign-in for the whole shop. `person`: each person's own sign-in (the connection is kept elsewhere, as a reference). */
  connectionScope: z.enum(['shop', 'person']).default('shop'),
  connectionRef: ConnectionRef.optional(),
  /** True when the connector runs on made-up or copied sample data: every result says so. */
  sample: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** The approved tools. A tool the server offers that is not listed here is new, and starts blocked. */
  tools: z.array(ConnectorToolSchema).min(1).max(100),
}).strict();

export const ConnectorPolicyRowSchema = z.object({
  connectorId: ConnectorId,
  /** A tool name, or `*` for every tool of the connector that has no row of its own. */
  tool: z.union([z.literal('*'), ToolName]),
  /** `shopper` rows apply to everyone (staff too); `staff` rows apply to members of staff only. */
  audience: z.enum(['shopper', 'staff']),
  /** For a `staff` row: the groups it applies to. Empty means every member of staff. Must be empty for a `shopper` row. */
  groups: z.array(GroupId).max(50).default([]),
  state: ConnectorStateSchema,
}).strict();

export const ConnectorsSchema = z.object({
  connectors: z.array(ConnectorSchema).max(50),
  policy: z.array(ConnectorPolicyRowSchema).max(2000).default([]),
}).strict();

export type ConnectorTool = z.infer<typeof ConnectorToolSchema>;
export type ConnectorDefinition = z.infer<typeof ConnectorSchema>;
export type ConnectorPolicyRow = z.infer<typeof ConnectorPolicyRowSchema>;
export type ConnectorsExtension = z.infer<typeof ConnectorsSchema>;
