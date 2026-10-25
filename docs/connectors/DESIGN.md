# Connectors: how the chat reaches other systems

Branch `feat/agent-claude-connectors`. Written before the code, kept up to date as the code landed.

## In one paragraph

Like Claude, the chat is the **client** and the systems it needs (stock, orders, CRM, product content) sit behind **connectors**. A connector is a named group of tools with a description, an owner and a rule for who may use each tool. The chat talks to a connector with **MCP** (Model Context Protocol: one standard way to list a connector's tools and call them). The chat never holds a connector's secrets: it holds a *reference* to a secret, and the service that makes the call resolves it at the last moment. The model sees connectors **by name and description only**; it loads the tools of one connector when it needs them (the same idea as Claude's tool search), and every call goes through one gate that applies the three-state rule (allow, ask first, blocked).

## The path of one call

```
customer or staff message
   |
   v
agent loop (journey-runtime-service)
   |   the model sees a short list: "sap-commerce: products, carts, orders ..."
   |   tool 1: list_connectors            names + descriptions of connectors this person may use
   |   tool 2: get_connector_tools        loads ONE connector's tools (MCP tools/list), blocked ones left out
   |   tool 3: call_connector_tool        calls one tool
   v
ConnectorRuntime  (apps/journey-runtime-service/src/kernel/connector.runtime.ts)
   |  1. finds the connector in the pack registry   (extensions.connectors)
   |  2. works out this person's state for the tool (resolveConnectorPolicy)
   |  3. hands the call to the CapabilityDispatcher with that state
   v
CapabilityDispatcher -> PolicyGate           blocked => "denied", ask first => "requires_approval", allow => runs
   |
   v
executor "mcp_tool"  (packages/capability-sdk/src/mcp)
   |  resolves the server name to an address, resolves the secret reference, calls tools/call over HTTP
   |  caps the size of the result, hides secrets, times out
   v
an MCP server
      today: the sample connector server (packages/connectors-sample), one MCP endpoint per connector
      later: Activepieces, or our own service in front of Activepieces flows, with the same contract
```

What the model gets back is a normal tool result (`ok`, `connector`, `tool`, `sample`, the data) or a plain refusal (`blocked`, `needs_approval`, `failed`) that it can explain to the person.

## 1. The connector registry

A pack extension, `extensions.connectors`, built the same way as `extensions.agentAccess` (schema, validation rules, a project-service whitelist entry, and one pure function that every caller asks).

```json
{
  "connectors": [
    {
      "connectorId": "ace-erp",
      "displayName": "ACE ERP",
      "description": "Stock by branch, trade prices and delivery status.",
      "owner": "Supply chain team",
      "mcpServerName": "ace-erp",
      "secretRef": "tenant-secret://placemakers/dev/sample-connectors-key",
      "connectionScope": "shop",
      "sample": true,
      "enabled": true,
      "tools": [
        { "name": "stock_by_branch", "sideEffect": "read" },
        { "name": "reserve_stock", "sideEffect": "write" }
      ]
    }
  ],
  "policy": [
    { "connectorId": "ace-erp", "tool": "*", "audience": "staff", "groups": [], "state": "allow" },
    { "connectorId": "ace-erp", "tool": "reserve_stock", "audience": "staff", "groups": ["sales"], "state": "ask" }
  ]
}
```

- `tools` is the **approved list** of the connector's tools. The live server may offer more; any tool that is not on the list is treated as **new and starts blocked** until an admin adds it (Claude does the same: new tools start blocked until re-enabled).
- A tool may carry `claimClasses`: what kinds of statement its answer may support in the reply (the claim classes the reply checker already knows, for example the one for stock). Without one, the reply checker holds back a sentence that quotes the tool's figures, exactly as it holds back any figure no tool vouched for; a test shows the same sentence let through with the class and withheld without it.
- `sample: true` means the connector runs on made-up or copied data. Every result from it says so, so the chat can say "this is sample data".
- `secretRef` is a reference (`tenant-secret://<tenant>/<environment>/<name>`, the schemes the pack already allows). A raw key in the pack is refused by the schema, the validator and the pack-wide secret scan. The reference must name the pack's own tenant and environment.
- `connectionScope` and `connectionRef` are described under "Connections" below.
- The address of the server is **not** in the pack. The pack names the server (`mcpServerName`); the runtime's configuration says where it lives (`CONNECTOR_MCP_SERVERS` or `CONNECTOR_MCP_BASE_URL`). That keeps a pack the same in dev, test and production.

### When the model is offered the connector tools

Both must hold: the person has at least one usable connector (a tool that is allow or ask for them), **and** the agent's `allowedTools` names `list_connectors`, `get_connector_tools` and `call_connector_tool` (or allows everything). A pack without `extensions.connectors`, a shopper whose rows are all blocked, or an agent that does not name the tools sees no change at all: no tool, no prompt text. The server also refuses a call to a connector tool that was not offered, in the same place it refuses any other tool the agent may not use.

### Who may use what: the three states

A row says: *for this connector and this tool (or `*` for every tool without its own row), for this audience and these groups, the state is allow, ask or blocked.*

`resolveConnectorPolicy` (in `packages/business-pack/src/connector-policy.ts`) is the one place that decides. The rules, all copied from how Claude does it and from `resolveAccess`:

1. A shopper row applies to everyone; a staff row applies to staff, and only to the groups it names (none named: all staff). Groups on a shopper row are an error.
2. **Strictest wins** when several rows apply to a person: blocked beats ask first, ask first beats allow. (Claude combines roles the other way round, most permissive among roles, then an admin cap. Here the brief asked for strictest-wins per group, which is the safer reading; it can be loosened later without changing the shape.)
3. A row for a named tool is more specific than the `*` row of its connector, and wins over it. Among rows of the same kind, strictest wins.
4. **No applicable row means blocked.** A new tool, a new connector and a person in no listed group all start blocked.
5. A connector with `enabled: false` is blocked for everyone.
6. A connector is *usable* by a person if at least one of its tools is allow or ask for them. A connector nobody can use is not even listed to the model.

### How the state maps onto the existing PolicyGate

`PolicyGate` (`packages/capability-sdk/src/policy-gate.ts`) already answers "may this run?" with `allowed`, `requiresApproval` (the dispatcher turns that into `requires_approval`) or not allowed (`denied`). It decides today from the tool's side effect, risk and a confirmation flag. The connector state is an explicit decision by a person who administers the pack, so it takes over:

| State for this person | What the gate does | What the dispatcher returns |
|---|---|---|
| blocked | refuses; nothing is sent to the server | `denied` |
| ask first | refuses until the call carries a server-verified confirmation | `requires_approval` |
| allow | lets it through, including a tool that changes data (an admin chose that) | runs |

The state is passed on the request as `policyState`; it is set by server code only, never by the model, in the same way as `userConfirmationConfirmed`. When it is present, the old single-role check is replaced by the group rules above (a member of staff with the role `operator` must not be turned away by a rule written for the role `customer`). Without it, the gate behaves exactly as before, so nothing existing changes.

**Ask first, end to end.** The first call returns `needs_approval` and creates a pending approval through the existing `ApprovalService.createPending`, tied to the tool, the exact arguments (an input hash), the session and the person's role. A person decides it through the existing `POST /runtime/workspaces/:workspaceId/approvals/:approvalRequestId/decide`. When the agent repeats the call with that `approvalRequestId`, `consumeApproved` checks the tool, the arguments, the session and the role and spends the approval once; only then does the call run. The model cannot approve its own call: it never sets the confirmation, and a wrong or reused approval id changes nothing.

**What is not built:** the approval *card* in the web chat. The existing card system needs a new card type in `packages/ui-cards`, a renderer in `apps/journeyax-web`, and a button that calls the decide endpoint. That is a separate piece of work in the web app. The result of an ask-first call already carries everything the card needs (`approvalRequestId`, connector name, tool name, the arguments, the expiry), so adding the card changes no connector code.

## 2. Reaching Activepieces over MCP

**What I found.**

- Activepieces' own pages describe a built-in MCP server: one project-level endpoint (turned on in Settings, OAuth sign-in) that offers its pieces as tools, and they say it is available on all plans including self-hosted. I could not confirm from their pages which release introduced it.
- The dev stack here pins **Activepieces 0.39.1** (`deploy/activepieces/Dockerfile`, `docker-compose.yml`). I cannot say whether that release has the MCP server. `docs/` and `deploy/` contain no mention of an MCP server for Activepieces.
- **Activepieces is not running on this machine.** The Docker daemon is stopped, and the node processes listening on ports 3010 and 8080 are the live app, not Activepieces. Nothing in this branch has been tried against a real Activepieces.
- Today, Activepieces sits on the *outgoing* side only: the dispatcher's `activepieces_flow` executor posts to a flow's webhook, and the JourneyAX piece sends events out.

**What I did about it.** The MCP face is **our own small service with the standard MCP contract**: `packages/connectors-sample`. The runtime's MCP client speaks only the standard protocol (JSON-RPC 2.0 over HTTP POST, the "streamable HTTP" transport in its plain-JSON form; `initialize`, `tools/list` with paging, `tools/call`). Nothing in the client or in the pack knows that the server is ours. So the same client works against:

1. the sample connector server (today, fully tested here);
2. Activepieces' own MCP server, if the version we run has it (a configuration change: point `mcpServerName` at its address and give it a secret reference; one open question is that it offers one flat list of tools for a whole project, while we address one connector per MCP endpoint, so a thin filter in front may be needed);
3. our own service in front of Activepieces flows (each tool calls a flow by webhook, using the dispatcher code that already exists), which is the safer choice if the 0.39.1 image has no MCP server.

The choice between 2 and 3 needs a running Activepieces to test, so it is left open. See "Open decisions".

## 3. Connections: per person and per shop (references only)

Some connectors are used with one shared sign-in for the whole shop (stock, product content); some need each person's own sign-in (a CRM where records belong to a salesperson). The registry records which with `connectionScope: "shop" | "person"` and an optional `connectionRef` (a name, never a credential).

- `shop`: one `secretRef` for the whole tenant. This is what the sample connectors use.
- `person`: the dispatcher passes the person's id and the `connectionRef` on every call (`X-Principal-ID`, `X-Connection-Ref`) and the existing connection-ownership check (`validateConnectionOwnership`) must accept it. The place that *stores* who signed in to what (the sign-in screens, the token store) is not built; the schema and the call path are ready for it. This is deliberately left as references only, as asked.

## 4. Safety rules built into the path

- **Secrets by reference only.** The pack holds a reference. The pool resolves it at call time through an injected `SecretResolver` (the dev one reads an environment variable). The reference must carry the same tenant and environment as the call or the call is refused. Whatever the resolver returns is scrubbed from every result and error before it is returned. No secret ever enters the model's context or a trace.
- **Size cap.** A result is capped (default 32 KB as text) before it goes to the model. Lists are cut to the first items that fit and marked `truncated`, with how many were left out.
- **Timeouts and no redirects.** Each call has a timeout (default 15 s) and the HTTP client refuses redirects. In production the server address must be `https` and must not be a private, loopback or cloud-metadata address.
- **Tenant isolation.** The tenant comes from the server-side context, never from the model (any `tenantId` in the arguments is stripped, as for every other tool). The pool is keyed by tenant, environment and server, and the tenant travels to the server in `X-Tenant-ID`. The sample server serves each tenant from its own data and keeps writes per tenant.
- **Lazy loading.** The prompt holds one line per connector. Tool lists are fetched when the model asks for a connector and cached for a few minutes.
- **Audit without payloads.** One event per call: tenant, person, connector, tool, state, outcome, duration, error type, correlation id. Never the arguments or the result.

## 5. The sample connectors

`packages/connectors-sample` serves the 11 connectors of the plan (45 tools) from one process, one MCP endpoint per connector (`POST /mcp/<connector>`). The server code is generic (it knows nothing about any shop); each connector is data: a `connector.json` (its tools, each with a small declarative description of what it does to the records) and a `seed.json` (the records). A build script writes the seed files from the PlaceMakers data folder (read only); invented records carry `sample: true`. Each tenant the server is started for gets its own copy of the records, so a write by one is never seen by another. See `packages/connectors-sample/README.md` for how to run it and for the record counts, and each connector's README for which fields are real and which are made up.

The pack's draft (`docs/agent-instructions/placemakers-draft.json`) declares all 11 as data under `extensions.connectors`: every read tool is allow, every tool that writes (`add_to_cart`, `create_case`, `send_message`) is ask first, for staff only. The two staff-facing agents in the draft name the three connector tools in their `allowedTools`.

## 6. What is not needed

- **No connector secrets in the chat.** The browser and the model never see a key or a token.
- **No new database.** The registry is part of the pack. Sample data and writes are files and memory.
- **No change for shoppers' chats today.** With no `extensions.connectors` in a pack, none of the three tools is offered and the prompt is unchanged. The draft pack declares the connectors for staff only.
- **No OAuth screens, no connection store, no admin screen, no approval card, no "test this connector" button, no store for the audit events** in this branch. The audit hook exists (`connectorAudit` on the gateway) and a `connector_call` trace goes to the chat stream; nothing writes the events to a database yet.

## 7. Open decisions for the owner

1. **Activepieces: its own MCP server or our service in front of flows?** Needs a running Activepieces to settle (and a look at whether 0.39.1 has the feature).
2. **Strictest wins versus Claude's most-permissive-among-roles.** Built as asked (strictest). Say if you want Claude's way.
3. **Should shoppers get any connector?** The draft gives connectors to staff only. Giving a shopper the sample product connectors would put made-up stock next to the real catalogue.
4. **The approval card** in the web chat (needs the web app).
5. **Per-person sign-in**: the store for who signed in to what.
