/**
 * What the empty chat says to this person: the first entry of the pack's `extensions.welcome` that fits them. Pure and tenant-neutral:
 * the words are the tenant's own (the pack), and nothing here grants anything, it only chooses which words to show.
 */
export interface WelcomeStarter { label: string; prompt: string; needs?: string[] }

export interface Welcome { headline?: string; subtitle?: string; placeholder?: string; starters?: WelcomeStarter[] }

interface WelcomeEntry extends Welcome { groups?: string[]; audience?: 'shopper' | 'staff'; companyRoles?: string[] }

/** `groups` are the person's normalised staff groups (empty for a shopper). */
export function welcomeFor(setting: unknown, person: { audience: string; groups: string[]; companyRoles?: string[] }): Welcome | undefined {
  const entries = (setting as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(entries)) return undefined;
  const mine = new Set(person.groups.map((group) => group.toLowerCase()));
  for (const raw of entries) {
    const entry = raw as WelcomeEntry | null;
    if (!entry || typeof entry !== 'object') continue;
    const groups = Array.isArray(entry.groups) ? entry.groups.map((group) => String(group).toLowerCase()) : [];
    // An entry for company roles fits a signed-in customer who holds one of them; it never fits an ordinary shopper.
    const fits = Array.isArray(entry.companyRoles) && entry.companyRoles.length
      ? person.audience === 'shopper' && entry.companyRoles.some((role) => (person.companyRoles ?? []).includes(role))
      : groups.length
        ? person.audience === 'staff' && groups.some((group) => mine.has(group))
        : entry.audience === person.audience;
    if (!fits) continue;
    return {
      ...(entry.headline ? { headline: entry.headline } : {}),
      ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
      ...(entry.placeholder ? { placeholder: entry.placeholder } : {}),
      ...(Array.isArray(entry.starters) ? { starters: entry.starters.map((s) => ({ label: s.label, prompt: s.prompt, ...(s.needs?.length ? { needs: s.needs } : {}) })) } : {}),
    };
  }
  return undefined;
}
