/** Stable, URL-safe identifier segment. `&` reads as "and" so "Tools & Guides" and "Tools and Guides" agree. */
export function slugify(value: string): string {
  const folded = value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/&/g, ' and ');
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unnamed';
}

/** Appends -2, -3 … until the slug is unused among its siblings. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${i}`;
  taken.add(candidate);
  return candidate;
}

export function normalizePhrase(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
