<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

This is a single Next.js 16 (App Router, Turbopack, React 19) app — an AI bathroom configurator ("Caroma JourneyAX"). Dependencies install with `npm install` (see `package.json` for scripts: `dev`, `build`, `start`, `lint`).

- **Dev server:** `npm run dev` serves on port 3000 (the README's mention of 3008 is stale; the `dev` script uses Next's default). The frontend (`/`) renders fully with no secrets.
- **Required secrets for chat:** `/api/chat` needs `OPENAI_API_KEY` (used for both `gpt-5.4-mini` chat completions and `text-embedding-3-small` embeddings) and `MONGODB_URI` (a MongoDB Atlas cluster whose `journeyx.documents` collection is populated with ingested Caroma data). Put them in `.env.local` (gitignored) or export them.
- **Gotcha — build needs an OpenAI key present:** `src/app/api/chat/route.ts` does `new OpenAI()` at module top-level, which throws `Missing credentials` if `OPENAI_API_KEY` is unset. Without it the route 500s at runtime and `next build` fails while collecting page data. A dummy value (e.g. `OPENAI_API_KEY=sk-dummy npm run build`) is enough to build; a real key is needed for the chat to actually respond.
- **Search fallback:** vector search needs an Atlas `vector_index`, but `src/services/knowledge/mongo.ts` falls back to regex search if the vector index or embeddings are unavailable, so the DB only needs documents (not necessarily a vector index) to return results.
- **Data ingestion:** `src/scripts/ingest-*.ts` (run via `tsx`) scrape/ingest Caroma data and additionally require `FIRECRAWL_API_KEY`. Not needed to run the app if `MONGODB_URI` already points at a populated cluster.
- **Lint:** `npm run lint` runs but currently reports pre-existing errors (incl. root-level `test-*.js`); these are not environment issues.
- **`/anf` route:** `src/app/anf` + `src/anf/*` is a self-contained "Abercrombie & Fitch AI Stylist" demo storefront. It is fully client-side (rule-based stylist in `src/anf/stylist.ts`, local catalog in `src/anf/catalog.ts`) and needs **no** `OPENAI_API_KEY` or `MONGODB_URI` — reachable at `http://localhost:3000/anf`. The Caroma configurator at `/` is unchanged.
