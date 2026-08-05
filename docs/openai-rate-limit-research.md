# OpenAI key keeps hitting the limit — research + options (no code)

**Symptom:** the OpenAI key "always" 429s / limit-reached, blocking the agent + retrieval.
**Scope:** research + recommendations only. Grounded in the actual code + OpenAI's 2025/26 rate-limit model.

---

## Why it keeps happening (root causes, from the code)

1. **Every search embeds the query via OpenAI, uncached.** `product.service.ts:457` calls `embedText(query)` → `openai.embeddings.create` on *every* retrieval. Product embeddings are stored in Mongo (good), but the **query** embedding is recomputed for every single search. This is your highest-frequency OpenAI call and it has no cache.
2. **No 429 handling.** There is **no retry / backoff / `Retry-After`** logic anywhere (grep found none). A brief burst → hard failure (falls back to regex search, which is why retrieval sometimes "goes dumb").
3. **One key does everything.** The same OpenAI key serves **embeddings + agent chat (gpt-4o) + ingestion**. Their combined RPM/TPM saturates the account's tier limit far faster than any one workload would.
4. **Almost certainly a low usage tier.** OpenAI gates limits by cumulative spend (see table). **Tier 1 = 5 RPM and 30,000 TPM for gpt-4o** — brutally low. If this key is on a fresh/low-spend account, a couple of searches + one agent turn exhausts it instantly. This is the single most likely cause.
5. **Per-project keys + multi-provider exist but aren't distributing load.** `config-loader.ts` reads `ai.provider` and a per-project `ai.apiKey`, but the known gaps (AUG-63 "per-project key never reaches the agent", AUG-65 "true multi-provider") mean traffic still funnels through the one platform OpenAI key with no fallback.

## OpenAI's tier system (why "add money" is the real fix)

Limits scale with **cumulative spend**; you graduate tiers automatically.

| Tier | Unlocks at | gpt-4o (approx) | Effect |
|---|---|---|---|
| Free / Tier 1 | $5 spent | ~**5 RPM**, 30k TPM | You hit this in seconds |
| Tier 2 | ~$50 spent | ~5,000 RPM, 450k TPM | Comfortable for a demo |
| Tier 3 | ~$100 | ~5,000+ RPM, higher TPM | Fine for real traffic |
| Tier 4–5 | $250–$1,000 | 10k–100k RPM | Production scale |

A **429** is two different things: `rate_limit_exceeded` (RPM/TPM/RPD/TPD — transient, retry) **vs** billing/quota cap reached (hard stop until you raise the monthly budget or the month resets). Check which you're getting in the error `type`.

---

## What to do — ranked by impact ÷ effort (all researched; none require code today)

### Tier A — account/ops, zero code (do first, unblocks immediately)
1. **Check the tier + raise it.** OpenAI dashboard → Limits. If you're Tier 1 (5 RPM), **add ~$50 of credits** → you jump to Tier 2 (~5,000 RPM). This alone likely ends the problem. This is the fastest, highest-leverage fix.
2. **Check the monthly budget cap.** Settings → Limits → "monthly budget." If the 429 is a *quota* stop (not RPM), the tier won't help — you must **raise the budget cap** or wait for reset.
3. **Move embeddings off the OpenAI account entirely.** Embeddings are your #1 call volume. Point `embeddingModel` at a **non-OpenAI** option — the schema already lists `voyage-3-large` / `voyage-3.5`, or run **Ollama `nomic-embed-text` locally** (free, unlimited). This is a **config change**, not code, and it removes the biggest, most frequent drain on the OpenAI key so chat has the whole budget.
4. **Split keys per workload.** Use one key for embeddings, one for chat, one for ingestion (or per-project keys). A burst in ingestion then can't starve the live agent. Config/env only.

### Tier B — small resilience additions (code, later, not now)
5. **429 retry with exponential backoff + `Retry-After`.** The OpenAI Node SDK has `maxRetries` (set it) and honors `Retry-After`; add jitter. Turns transient 429s into a brief pause instead of a failed turn.
6. **Cache the query embedding.** Wrap `embedText(query)` in `@journeyax/cache` (`getOrSet`, keyed by the normalized query, short TTL). Repeated/similar searches then cost **zero** OpenAI calls. Big volume reduction with the cache you already have.
7. **Batch embeddings on ingest.** OpenAI accepts up to 2,048 inputs per embeddings call — batch instead of one call per doc.

### Tier C — the real architecture answer (later, AUG-63/65)
8. **Wire per-project keys to the agent** so each tenant's traffic uses its own key/quota (spreads load, isolates blast radius).
9. **Multi-provider fallback:** on OpenAI 429, automatically route the turn to Anthropic / Gemini (the platform is already multi-LLM). Removes the single-point OpenAI dependency for good.

---

## Recommendation (fastest path, no code)

1. **Open the OpenAI dashboard, read the current tier and the error `type`.** That tells you *which* limit you're hitting.
2. If **RPM/tier** → **add ~$50 credit** (Tier 1→2) — usually ends it same day.
3. If **quota/budget** → **raise the monthly budget cap.**
4. **Switch embeddings to Voyage or local Ollama** (config) — takes the highest-volume workload off the OpenAI key so it stops competing with the agent.
5. Then, when you're doing code again: add SDK `maxRetries`/backoff (Tier B #5) and cache the query embedding (#6). Multi-provider fallback (#9) is the durable fix.

**Bottom line:** you're not doing anything wrong in usage — the key is almost certainly on a **low OpenAI tier (5 RPM)** *and* it's carrying **every embedding on every search with no cache and no retry**. The zero-code unblock is **tier up (add credit) + move embeddings off OpenAI**; the durable fix is **retry + query-embedding cache + multi-provider fallback**.

Sources:
- [OpenAI Rate Limits — official docs](https://developers.openai.com/api/docs/guides/rate-limits)
- [OpenAI rate limits: TPM/RPM & tier limits guide](https://inference.net/content/openai-rate-limits-guide/)
- [How to fix OpenAI 429 rate-limit errors](https://markaicode.com/errors/openai-api-rate-limit-fix/)
- [OpenAI 429 handling — engineer's guide](https://www.respan.ai/articles/openai-api-rate-limits)
