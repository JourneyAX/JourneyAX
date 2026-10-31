# Sample connectors

A small server that stands in for the systems a business keeps its data in, so the whole path *chat → connector → tool → result* can be shown and tested without a real SAP, Salesforce or ERP. It speaks **MCP** (the standard way to list a connector's tools and call them) over HTTP, one endpoint per connector: `POST /mcp/<connector>`.

It is **sample data**. Every record says so (`sample: true`) unless it was copied whole from the PlaceMakers data. Where a real system exists later (a trial Salesforce, a real Activepieces MCP server), it replaces the sample connector by changing where the connector's server name points; nothing in the chat changes. See `docs/connectors/DESIGN.md`.

## The eleven connectors

| Connector | Stands in for | Records (main collections) | Real | Made up |
|---|---|---|---|---|
| `sap-commerce` | SAP Commerce Cloud | 100 products, 30 carts, 48 orders | products, prices, product pages | carts, orders, quantities |
| `salesforce` | Salesforce Sales and Service Cloud | 30 trade accounts, 44 cases, 32 order reviews | branch codes | everything else |
| `ace-erp` | SAP ERP | 65 branches, 800 stock rows (100 products × 8 branches), 100 price rows, 27 deliveries, 30 balances | branch names, codes, phones; products; retail prices | stock counts, tier discounts, deliveries, balances, branch coordinates (approximate) |
| `mulesoft` | MuleSoft | 38 integration runs | none | all |
| `salsify` | Salsify | 100 products with specifications and documents | everything | none |
| `bloomreach` | Bloomreach | 100 catalogue entries, 34 popular searches | catalogue, search words, results | how often a search is typed |
| `marketing-cloud` | Salesforce Marketing Cloud | 34 messages, 30 contacts, 8 templates | none | all |
| `power-bi` | Power BI | 6 reports, 437 rows | a few product SKUs | all figures (three reports are computed from the sample orders and cases) |
| `google-analytics` | GA4, Tag Manager, Search Console | 60 days, 41 pages, 32 searches, 30 channel rows | page paths, search words | all figures |
| `uxcam` | UXCam | 42 sessions, 30 screens, 25 funnel steps | none | all |
| `location` | Cotality location APIs | 32 addresses, 65 branches | branch names, codes, phones | addresses, branch coordinates (approximate) |

Each connector folder holds `connector.json` (the tools), `seed.json` (the records) and a README (generated: record counts and, collection by collection, which fields are real and which are made up). A test fails if any connector falls below the number of records it promises.

## Run it

```bash
# start the server (port 4010; set a key for anything that is not a laptop)
SAMPLE_CONNECTORS_API_KEY=some-key npx tsx packages/connectors-sample/src/cli.ts

# point the runtime at it
CONNECTOR_MCP_BASE_URL=http://127.0.0.1:4010
CONNECTOR_SECRET_SAMPLE_CONNECTORS_KEY=some-key     # what tenant-secret://<tenant>/<env>/sample-connectors-key resolves to
```

The runtime finds a server by the name in the pack (`mcpServerName`): `CONNECTOR_MCP_BASE_URL` plus `/mcp/<name>`, or an entry in `CONNECTOR_MCP_SERVERS` (`{"name": "https://..."}`) for a server that lives apart.

Every request carries `X-Tenant-ID` (the server holds a separate copy of the data for each tenant it is started for; `SAMPLE_CONNECTORS_TENANTS`, default the tenant the seeds were built for) and, if a key is set, `Authorization: Bearer <key>`.

## Tests

```bash
cd packages/connectors-sample && npm test
```

- `seeds.spec.ts`: record counts, the sample flag, real data really from the data, records that point at each other, no real email addresses or keys.
- `engine.spec.ts`: each operation (find, get, create, aggregate, nearest, drive, match) and the argument checks.
- `contract.spec.ts`: through the runtime's own MCP client: every connector lists its tools, every tool returns a stable shape, tenants are kept apart, a caller without the key is refused, writes create sample records and never touch the seeds, the key never appears in an answer.

The agent-loop test with a scripted model is `apps/journey-runtime-service/test/connectors-e2e.spec.ts`.

## Rebuild the seeds

```bash
npx tsx packages/connectors-sample/scripts/build-seeds.ts
```

Reads the PlaceMakers data folder (read only; set `PLACEMAKERS_DATA_DIR` if it is not beside the repository) and rewrites every `seed.json` and README. A seeded generator makes the invented records, so the same data gives the same files. No customer data is read and none exists in the folder. The data folder's text for branch street addresses has lost characters, so addresses are not copied.

## How it is built

The server code is generic: it knows nothing about any shop. A tool in `connector.json` carries a small declarative `op` (`find`, `get`, `create`, `aggregate`, `nearest`, `drive`, `match`) over a named collection of the seed; everything about a business lives in the two JSON files. To add a connector, add a folder and an entry in `connectors/manifest.json`.
