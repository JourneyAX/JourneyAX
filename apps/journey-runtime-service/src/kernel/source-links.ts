/** Citations use actual returned source URLs. Shortening a display label must never shorten the destination. */
export function collectSourceUrls(target: Set<string>, tool: string, result: any): void {
  if (result?.ok === false || result?.found === false || ['needs_confirmation', 'needs_approval', 'blocked'].includes(result?.status) || ['present_card', 'remember_context', 'open_form', 'use_skill'].includes(tool)) return;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || target.size >= 256) return;
    if (typeof value === 'string') {
      for (const match of value.slice(0, 200_000).matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
        const raw = match[0].replace(/[),.;!?]+$/, '');
        try { const url = new URL(raw); if (!url.username && !url.password) target.add(raw); } catch { /* Not a source URL. */ }
      }
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value); for (const child of Object.values(value).slice(0, 512)) visit(child, depth + 1);
    }
  };
  visit(result, 0);
}

export function repairSourceLinks(text: string, urls: ReadonlySet<string>): string {
  const resolve = (raw: string): string | undefined => {
    if (urls.has(raw)) return raw;
    if (!/(?:\.\.\.|…)/.test(raw)) return undefined;
    try {
      const proposed = new URL(raw); const tail = proposed.pathname.split('/').filter(Boolean).pop();
      if (!tail || /(?:\.\.\.|…)/.test(tail)) return undefined;
      const matches = [...urls].filter(source => { try { const actual = new URL(source); return actual.origin === proposed.origin && actual.pathname.split('/').filter(Boolean).pop() === tail; } catch { return false; } });
      return matches.length === 1 ? matches[0] : undefined;
    } catch { return undefined; }
  };
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_whole, label, raw) => {
    const url = resolve(raw); return url ? `[${label}](${url})` : label;
  }).replace(/https?:\/\/[^\s<>"'`]+/g, raw => {
    const clean = raw.replace(/[),.;!?]+$/, ''); const suffix = raw.slice(clean.length);
    return (resolve(clean) || '') + suffix;
  });
}
