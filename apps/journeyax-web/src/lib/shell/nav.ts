/**
 * Links inside the shell keep the query that selects the tenant (`?project=`) and the embed flag, and drop everything else
 * (checkout return params, one-off flags), so moving between Chats and Customize never loses which storefront this is.
 */
const KEEP = ['project', 'embed'];

export function preservedQuery(search: string | undefined | null): string {
  const incoming = new URLSearchParams(String(search || ''));
  const out = new URLSearchParams();
  for (const key of KEEP) {
    const value = incoming.get(key);
    if (value) out.set(key, value);
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

export function shellHref(path: string, search: string | undefined | null): string {
  return `${path}${preservedQuery(search)}`;
}
