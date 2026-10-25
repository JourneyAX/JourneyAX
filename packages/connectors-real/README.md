# Real connectors

The same tools as the sample connectors (`packages/connectors-sample`), backed by the vendors' own systems: **commercetools**, **Salesforce**, **Google Analytics 4** and **Power BI**. One small server (`POST /mcp/<connector>`, MCP over HTTP) holds the vendors' credentials; the chat's runtime reaches it with one key and knows nothing else.

Start here: [`docs/connectors/REAL-SETUP.md`](../../docs/connectors/REAL-SETUP.md) (what to sign up for, what to fill in, how to prove each connection, how to put it live).

```bash
cp packages/connectors-real/connectors.env.example .env.connectors     # fill in what you have
bash packages/connectors-real/start.sh                                  # the server, on :4020
npx tsx --env-file=.env.connectors packages/connectors-real/scripts/live-check.ts [connector] [--writes]
npm test --workspace packages/connectors-real                           # 77 tests against pretend vendors
```

| | |
|---|---|
| `src/connectors/*.ts` | one adapter per vendor; the header of each lists its settings and the permissions it needs |
| `src/server.ts` | the MCP server: key, tenant check, argument checks, plain-words failures; a connector without its settings is served but "not connected" |
| `src/http.ts` | sign-in tokens cached and renewed once on a 401, redirects refused, secrets removed from every message |
| `scripts/live-check.ts` | harmless reads (and, with `--writes`, one labelled test change) against the real accounts |
| `scripts/loaders/*.ts` | fill a trial account with PlaceMakers-style data; dry run by default; separate admin credentials |
| `test/` | pretend vendors that record every request; `contract.spec.ts` keeps the servers and the draft pack in agreement |

Rules the adapters keep: names and ids are checked against a strict pattern before they go into a query; a tool that changes data is marked so in the server and in the pack, and the pack makes the person confirm first; only a town and postcode of a delivery address reach the model; the vendors' own error words are shortened and have any secret removed.
