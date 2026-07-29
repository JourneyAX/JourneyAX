/**
 * authedFetch (P0-02 R2/R4) — calls the back-office's own same-origin `/api/*`
 * routes. Auth now rides an HttpOnly cookie the browser attaches automatically,
 * so there is no token to read in JS; we just ensure same-origin credentials.
 * The guarded routes read the cookie server-side via requireAuth.
 *
 * GETs are de-duplicated and briefly cached (see below). Everything else goes
 * straight to the network and clears the cache, because a write means the
 * figures on screen are now out of date.
 */

/* Why a cache lives in the client at all.
 *
 * The console is a set of tabs people move between, and every tab refetched
 * from scratch on every visit — going back to Dashboard after ten seconds paid
 * the full round trip again. Worse, tabs mount several components that ask for
 * the same URL at once: the catalogue was measured issuing three identical
 * requests per visit, analytics two. Those are pure waste, and they land on the
 * server simultaneously so nothing else can absorb them.
 *
 * Kept deliberately short. This is a console showing live operational figures,
 * and the server holds the longer cache; this layer exists to make navigation
 * feel instant, not to serve yesterday's numbers. Any write clears it, and
 * Refresh bypasses it. */
const TTL_MS = 45_000;

type Entry = { at: number; body: string; status: number; contentType: string };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry>>();

function replay(e: Entry): Response {
  return new Response(e.body, { status: e.status, headers: { 'Content-Type': e.contentType } });
}

async function load(input: string, init?: RequestInit): Promise<Entry> {
  const res = await fetch(input, { credentials: 'same-origin', ...init });
  return {
    at: Date.now(),
    body: await res.text(),
    status: res.status,
    contentType: res.headers.get('content-type') || 'application/json',
  };
}

export function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();

  if (method !== 'GET') {
    // A write invalidates every cached read: after saving a project you must
    // never be shown the values from before the save.
    cache.clear();
    inFlight.clear();
    return fetch(input, { credentials: 'same-origin', ...init });
  }

  // An explicit refresh must reach the server, and must not be served from — or
  // stored in — the cache under the same key as the normal read.
  const bypass = input.includes('refresh=1');
  if (bypass) {
    cache.delete(input);
    return fetch(input, { credentials: 'same-origin', ...init });
  }

  const hit = cache.get(input);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(replay(hit));

  const pending = inFlight.get(input);
  if (pending) return pending.then(replay);

  const work = load(input, init)
    .then((entry) => {
      // Only successful responses are worth repeating; an error should be
      // retried on the next attempt, not pinned for the next 45 seconds.
      if (entry.status >= 200 && entry.status < 300) cache.set(input, entry);
      return entry;
    })
    .finally(() => inFlight.delete(input));

  inFlight.set(input, work);
  return work.then(replay);
}

/** Drop every cached read — used when switching workspace/project. */
export function clearFetchCache(): void {
  cache.clear();
  inFlight.clear();
}
