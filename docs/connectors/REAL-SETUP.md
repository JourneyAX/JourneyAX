# Connecting the real systems

The chat can use four real systems: **commercetools** (the online shop), **Salesforce** (the CRM), **Google Analytics** (web traffic) and **Power BI** (reports). Marketing Cloud stays on sample data until a real one exists. This guide is the order to do things in, what you do, and what the code does.

Everything here is built and tested against pretend vendors that answer in each vendor's documented format. **None of it has been run against a real account yet**, because that needs your sign-ups. Section 7 says exactly what is proven and what is not.

## 1. How it fits together

```
 the chat (web)  ->  gateway  ->  commerce service  ->  runtime (the assistant)
                                                              |  asks "who is this person, and may their team use this tool?"
                                                              |  (the pack's rules; a change asks the person first, on a card)
                                                              v
                                                    MCP over HTTP, with a key
                                                              |
                                         real connector server  (port 4020, its own process, its own settings file)
                                          |           |            |             |
                                    commercetools  Salesforce  Google Analytics  Power BI      (the vendors' own APIs)
```

- The chat side does not change. A connector is switched from sample to real by pointing its name at the real server and marking it real in the pack.
- **The vendors' credentials live in one file, `.env.connectors`, read by one process.** The runtime, the gateway and the web app never see them. The runtime only holds the key that lets it talk to the connector server.
- Each system can be real or sample on its own. If a trial ends, point that one system back at the sample server.
- Reading never changes anything. Two tools can change data: `add_to_cart` (commercetools) and `create_case` (Salesforce). The pack makes both ask the person first, and only some teams may use them at all.

## 2. What you do and what I do

| | You | I (the code) |
|---|---|---|
| Accounts | Sign up for each vendor trial. I cannot create accounts or type passwords. | |
| Credentials | Create the API client / app / service account, copy the values into `.env.connectors` (never into chat). | Read them from that file only. |
| Data | Run the loader (dry run first). | Provide loaders that fill each trial with PlaceMakers-style records. |
| Proof | Run the live check. | Provide it, with plain-words output. |
| Going live | Say yes to each step in section 6. | Do the steps, one at a time, with a rollback for each. |

Start with the vendors that cost nothing and have no clock: Salesforce Developer Edition and a Google Analytics property. Start the 60-day clocks (commercetools, Power BI) only when you are ready to use them.

## 3. Step 0: the connector server

```bash
cp packages/connectors-real/connectors.env.example .env.connectors     # it is ignored by git
openssl rand -hex 32                                                    # paste the result as REAL_CONNECTORS_API_KEY
npx tsx --env-file=.env.connectors packages/connectors-real/src/cli.ts  # or: bash packages/connectors-real/start.sh
```

It prints, for each connector, `connected` or `not connected` and which settings are still missing (names only). A connector that is not set up is still served; it offers no tools and says it is not connected. `curl http://127.0.0.1:4020/health` shows the same.

## 4. The four systems

### commercetools (the online shop) — 60-day trial

1. Start the trial at commercetools.com ("Get started"). The sign-up link is valid for 72 hours, so be ready to finish it.
2. In the Merchant Center make a project. Note its **project key** and its **region** (for example `australia-southeast1.gcp`; it is in the API client's host address).
3. Settings > Developer settings > **Create new API client**. You can paste the block the Merchant Center gives you (`CTP_PROJECT_KEY`, `CTP_CLIENT_ID`, `CTP_CLIENT_SECRET`, `CTP_API_URL`, `CTP_AUTH_URL`, `CTP_SCOPES`) into `.env.connectors` exactly as it is; the region is read from the address. That client is usually the wide "admin" one (`manage_project`), which is right for **loading** but too much for the chat.
4. For the chat make a **second, narrow** client with only `view_products`, `view_customer_groups`, `view_business_units`, `view_customers`, `view_orders` and `manage_orders` (carts are kept under the orders scopes), and put its id and secret in `COMMERCETOOLS_CLIENT_ID` and `COMMERCETOOLS_CLIENT_SECRET`. Those names win over the pasted block for the chat; the loader keeps using the wide one. (Until you do, the chat connection uses the wide client.)
5. Also set, in `.env.connectors` (not secrets): `COMMERCETOOLS_CURRENCY=NZD`, `COMMERCETOOLS_LOCALE=en-NZ` (the language the names were written in; a name search finds nothing in any other) and `COMMERCETOOLS_ACCOUNT_KIND=businessUnit` (an account is then a business unit key such as `acc-0001`).
6. Load the PlaceMakers trade business (a **B2B** project: business units, associate roles and people):
   ```bash
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/commercetools-b2b.ts            # dry run
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/commercetools-b2b.ts --apply    # for real
   ```
   It adds the NZD currency, the NZ country and the en-NZ language to the project (it only adds), then 80 categories, 100 products with a retail price and Bronze / Silver / Gold prices, 65 branch channels with 800 stock entries, 4 associate roles, 30 business units (+12 divisions for the biggest), 82 people, and one order and one open cart per unit. It looks each account up in Salesforce, records the Salesforce id on the unit, and writes the account number into the Salesforce description (`--no-salesforce` skips that). Running it again changes nothing.
   For a shop that is not B2B, the older `loaders/commercetools.ts` loads products, customers, orders and carts only.
7. Switch on product search: commercetools no longer allows the old "Product Projection Search" for projects made after 2026-09-01, so the connector uses **Product Search**, which needs the project's *products search* indexing on: `changeProductSearchIndexingEnabled` with `mode: ProductsSearch` (Merchant Center > Project settings > Search, or the Project API). The connector says so in plain words if it is off.
8. Prove it: `npx tsx --env-file=.env.connectors packages/connectors-real/scripts/live-check.ts commercetools` (set `CHECK_COMMERCETOOLS_ACCOUNT_ID=acc-0001`, `CHECK_COMMERCETOOLS_ORDER_ID=DEMO-ORD-0001` and a cart id to include those reads).

Notes: the assistant is shown only the town and postcode of a delivery address, never the street. The trade-tier prices come back as `tierPrices` next to the retail price; a customer's own tier decides which one a cart uses.

### Salesforce (the CRM) — free Developer Edition, no clock

1. developer.salesforce.com/signup makes a free Developer Edition org.
2. Note the **My Domain address** (Setup > My Domain), for example `https://yourname-dev-ed.my.salesforce.com`. That is `SALESFORCE_INSTANCE_URL`.
3. Setup > App Manager > **New External Client App** (older orgs: Connected App). Switch on OAuth with the **client credentials flow** and choose a **run as** user. Salesforce's menus change between releases; the thing to find is "client credentials". The connection can do exactly what the run-as user can do, so use a user that can read accounts, contacts and cases and create cases, and nothing more.
4. Copy the client id and secret into `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET`.
   *Quick first try instead:* with the Salesforce CLI, `sf org display --target-org <alias>` shows an access token. Put it in `SALESFORCE_ACCESS_TOKEN`. It lasts a couple of hours and is not renewed.
5. Load the trade accounts, contacts and cases (this uses your own session token, not the chat's connection):
   ```bash
   # SALESFORCE_LOADER_ACCESS_TOKEN=<the token from sf org display>
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/salesforce.ts            # dry run
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/salesforce.ts --apply
   ```
6. Prove it: `... live-check.ts salesforce` (add `--writes` to open one clearly-labelled test case).

Notes: a standard org has no "customer tier" or "home branch" fields. If you add custom fields on Account for them, name them in `SALESFORCE_TIER_FIELD` and `SALESFORCE_BRANCH_FIELD` and the assistant can filter on them. The sample's "order review" tool does not exist in a standard org, so it is not offered.

### Google Analytics — free, no clock

1. analytics.google.com: make a **test** property (not one that measures a live site) and a web data stream. Note the **Measurement ID** (`G-...`) and the numeric **property id** (Admin > Property details).
2. console.cloud.google.com: make a project, switch on the **Google Analytics Data API**, make a **service account** and a JSON key for it. Save the file somewhere private and set `GA4_SERVICE_ACCOUNT_FILE` to its path.
3. In Google Analytics, Admin > Property access management: add the service account's email as **Viewer**. Set `GA4_PROPERTY_ID`.
4. A new property is empty. To give it traffic: Admin > Data streams > your stream > Measurement Protocol API secrets > create one, then:
   ```bash
   # GA4_MEASUREMENT_ID=G-...   GA4_API_SECRET=...
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/google-analytics.ts --debug --apply   # Google checks the events, records nothing
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/google-analytics.ts --apply
   ```
   Google only accepts events up to 3 days old, so this makes the last 3 days of traffic; run it again on later days and the history grows. Reports can take several hours to show new events. Mark `generate_lead` as a **key event** (Admin > Events) or the "conversions" column stays empty.
5. Prove it: `... live-check.ts google-analytics`.

### Power BI — about 60 days, needs a work or school Microsoft account

1. Power BI cannot be started with a personal email address. If you have no work or school account, a Microsoft 365 developer sandbox gives you one (check Microsoft's current terms). Start the Power BI trial from it and make a **workspace**.
2. Entra admin center > App registrations > **New registration**. Note the **tenant id** and the **application (client) id**; make a **client secret** (Certificates & secrets).
3. Power BI admin portal > Tenant settings: switch on **Service principals can use Power BI APIs** (limit it to a security group that holds the app) and **Dataset Execute Queries REST API**.
4. Open the workspace > Access: add the app (through that security group if the portal asks for one) as a **Member**. Fill `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET`, `POWERBI_WORKSPACE_ID`.
5. Load a dataset with PlaceMakers-style orders and cases, and write the list of figures the assistant may read:
   ```bash
   # POWERBI_LOADER_CLIENT_ID / POWERBI_LOADER_CLIENT_SECRET: the same app, or a second one that is a Member of the workspace
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/power-bi.ts --figures ./powerbi-figures.json            # dry run shows the figures
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/power-bi.ts --figures ./powerbi-figures.json --apply
   # then set POWERBI_REPORTS_FILE=./powerbi-figures.json
   ```
6. Prove it: `... live-check.ts power-bi`.

How figures work: Power BI only lets a program read data by running a DAX query against a dataset. The assistant never sends a query. The administrator's figures file lists each figure, its dataset and its DAX; the connector runs only those. To offer another report, add an entry to that file (the top of `packages/connectors-real/src/connectors/power-bi.ts` shows the format).

### Zendesk (the customer-service ticket desk) — 14-day trial

Zendesk is the ticket desk for the customer-service team: tickets are the conversations with customers (an order that has not arrived, a quote request, a warranty question). Salesforce cases stay the CRM's record of the same customers' problems.

1. Start the trial at zendesk.com. Note the **subdomain** (the part before `.zendesk.com`).
2. Admin Center > Apps and integrations > APIs > **API configuration**: read and accept Zendesk's developer terms (your decision), then switch on token access.
3. **API tokens are gone for new accounts**: Zendesk stopped issuing them on 28 July 2026 and switches every one off on 30 April 2027. Connect with an **OAuth client** instead: APIs > **OAuth clients** > Add OAuth client. Name "JourneyAX connector", Identifier `journeyax_connector`, **Client kind: Confidential**. The page shows the generated **Secret once**, before you save: copy it then. Put the subdomain, identifier and secret in `.env.connectors` as `ZENDESK_SUBDOMAIN`, `ZENDESK_CLIENT_ID`, `ZENDESK_CLIENT_SECRET`. The connector gets a 30-minute access token with the client credentials grant and asks again when it runs out. The client acts as the administrator who made it.
4. Load sample tickets (dry run first):
   ```bash
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/zendesk.ts            # dry run
   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/zendesk.ts --apply    # for real
   ```
   36 tickets and 120 messages, with their real dates: delivery questions about the orders of the won deals (tagged with the account and the order number), tickets for the service cases, quote requests from the launch's leads, and everyday shopper questions. It uses Zendesk's ticket import, which sends no e-mail and runs no trigger. Running it again changes nothing.
5. Prove it: `... live-check.ts zendesk` (add `--writes` to raise one clearly-labelled test ticket and add an internal note to it). Zendesk's search can take a few minutes to find tickets that were just imported.

What the assistant can do: find tickets, read one with its conversation, raise a ticket (asks first), and add an **internal** note (asks first). It cannot send a public reply, close or edit a ticket. The trial is 14 days; the connector and the loader are the same on a paid plan.

### Marketing Cloud — stays sample for now

There is no confirmed free trial and a Developer Edition does not include it. Ask a Salesforce representative (or your company's Salesforce partner contact) for a Marketing Cloud trial or demo org. Until then it keeps its sample data, is labelled "Sample data" in the "+" menu, and nothing it "sends" goes anywhere. When a real org exists, a fifth adapter is added to this package the same way as the four above.

## 5. Who may do what (the personas)

Each person is in exactly one team, and the pack's rows are written per team. The full table is in `apps/project-service/test/persona-access.spec.ts`, which checks the real rule engine against it. In short:

| | commercetools | Salesforce | Google Analytics | Power BI | Marketing Cloud (sample) |
|---|---|---|---|---|---|
| Administrator | read, add to cart asks | read, create case asks | read | read | read, send asks |
| Customer service | read, add to cart asks | read, create case asks | none | none | read |
| Sales | read, add to cart asks | read | none | none | read |
| Sales manager | read, add to cart asks | read | none | read | read |
| Marketing | products only | find accounts only | read | read | read, send asks |
| Insights | none | none | read | read | none |
| Leadership | read | read | read | read | read |
| Shopper | none | none | none | none | none |

If the table is wrong for the business, say so and it is one change to the pack plus one line in that test.

## 6. Putting it live, one step at a time

Each step needs your yes; each has a way back.

1. **Code** (the gateway fixes, the real connector package, the reply fixes). Fast-forward the live folder; rollback is a tag.
2. **The runtime's two settings** in the app's `.env`: `CONNECTOR_SECRET_REAL_CONNECTORS_KEY=<the same value as REAL_CONNECTORS_API_KEY>` and
   `CONNECTOR_MCP_SERVERS={"commercetools":"http://127.0.0.1:4020/mcp/commercetools","salesforce":"http://127.0.0.1:4020/mcp/salesforce","google-analytics":"http://127.0.0.1:4020/mcp/google-analytics","power-bi":"http://127.0.0.1:4020/mcp/power-bi"}`
   then restart the runtime. (A backup of `.env` first, as before.)
3. **The logins**: `seed-demo-staff.ts --users-db journeyx --project-db journeyax --apply` (six staff in six teams and one shopper); `--remove` undoes it.
4. **The pack** (1.3.32): `apply-agent-pack.ts placemakers` for the dry run, then `--apply`. Rollback: `apply-tenant-release.ts placemakers --rollback 60 --apply`. Before publishing, switch off (`"enabled": false`) any real connector whose vendor is not set up yet, so it is not offered and then found empty.
5. **Check as each person**: sign in as each demo login and look at the "+" menu and one call.

## 7. What is proven, and what is not

**Proven by tests (77 in the connector package, plus the rest of the repository):**
- Each adapter sends the requests the vendor's documentation describes, with the right sign-in, and turns the answers into the shape the chat expects.
- Names and ids that could break out of a query (a sku, an account id, a status, a date) are refused before anything is sent.
- A vendor outage, a refused sign-in, a used-up limit, a missing record and an expired session each become a plain message the assistant can explain. No secret appears in any message, result, log or audit line.
- The whole path (the real agent loop, the pack's rules, the MCP client, the real server) with pretend vendors: each team is offered the right systems, a change asks first and reaches the vendor only after the person taps Allow, a blocked tool never reaches the vendor, a shopper is offered nothing.
- The loaders: dry run sends nothing, a second run changes nothing, and the figures file they write is one the Power BI connector accepts.

**Not proven, because it needs your accounts:**
- That each vendor behaves exactly as its documentation says on your account (trial limits, a renamed menu, a setting that is off by default).
- Power BI: that DAX queries run against a push dataset in your tenant, and the data type names. If a figure fails, the live check shows Power BI's own explanation.
- Google Analytics: the standard "search term" dimension needs the site to report searches.
- commercetools: with a narrow chat client, that every tool still works (the scopes in step 4 are my reading of what each call needs).
- Salesforce and commercetools **were** proven against real accounts on 2026-10-25 (see the live checks); Google Analytics and Power BI have no account yet.

The live check (`scripts/live-check.ts`) is how you find out, one system at a time, in plain words.
