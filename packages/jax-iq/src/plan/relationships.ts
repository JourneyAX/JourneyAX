import type { LinkDef } from '../model';

/** Expand merchant-declared operational relationships, not a conversational journey. */
export function relationshipPath(links: readonly LinkDef[], name: string, maxHops = 10): LinkDef[] | undefined {
  const byName = new Map(links.map(link => [link.link, link]));
  const expand = (id: string, seen: Set<string>): LinkDef[] | undefined => {
    const link = byName.get(id);
    if (!link || seen.has(id) || seen.size >= maxHops) return undefined;
    if (!link.via?.length) return [link];
    const nextSeen = new Set([...seen, id]);
    const path: LinkDef[] = [];
    let from = link.from;
    for (const child of link.via) {
      const part = expand(child, nextSeen);
      if (!part?.length || part[0].from !== from) return undefined;
      path.push(...part); if (path.length > maxHops) return undefined;
      from = part[part.length - 1].to;
    }
    return from === link.to ? path : undefined;
  };
  return expand(name, new Set());
}
