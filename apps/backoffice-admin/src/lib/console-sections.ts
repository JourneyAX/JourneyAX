/**
 * Console section catalog + per-project resolver.
 *
 * The back-office nav is NOT hardcoded — it is resolved from the active project so a
 * bathroom brand and a fashion retailer get different, sensibly-labelled menus with
 * no code change (docs §Phase 5 P5-01/P5-02/P5-10). The platform ships a fixed catalog
 * of *possible* sections; each project chooses which to show and how to label them via
 * its optional `console` config (stored in the project, edited in the back office).
 *
 * `status` marks whether a section is wired to a live backend or still a demo surface,
 * so the shell can honestly badge the demo ones instead of passing mock data off as real.
 */
export type SectionGroup = 'Main' | 'Platform' | 'Admin';

export interface SectionDef {
  id: string;            // must match the activeTab key in page.tsx
  defaultLabel: string;  // generic, vertical-neutral label
  group: SectionGroup;
  status: 'live' | 'demo';
}

/** All sections the platform knows about, with vertical-neutral default labels. */
export const SECTION_CATALOG: SectionDef[] = [
  { id: 'dashboard',    defaultLabel: 'Dashboard',            group: 'Main',     status: 'live' },
  { id: 'builder',      defaultLabel: 'Journey Builder',      group: 'Main',     status: 'live' },
  { id: 'catalog',      defaultLabel: 'Catalogue',            group: 'Main',     status: 'live' },
  { id: 'orders',       defaultLabel: 'Orders',               group: 'Main',     status: 'live' },
  { id: 'analytics',    defaultLabel: 'Analytics',            group: 'Main',     status: 'live' },
  { id: 'embed',        defaultLabel: 'Agent Embed',          group: 'Platform', status: 'live' },
  { id: 'channels',     defaultLabel: 'Channels',             group: 'Platform', status: 'live' },
  { id: 'integrations', defaultLabel: 'Integrations & Adapters', group: 'Platform', status: 'live' },
  { id: 'business', defaultLabel: 'Business Profile', group: 'Platform', status: 'live' },
  { id: 'orchestration',defaultLabel: 'AI Orchestration',     group: 'Platform', status: 'live' },
  { id: 'rules',        defaultLabel: 'Business Rules',       group: 'Platform', status: 'live' },
  { id: 'knowledge',    defaultLabel: 'Knowledge Base',       group: 'Platform', status: 'live' },
  { id: 'platform-ops', defaultLabel: 'Platform & Ops',       group: 'Platform', status: 'live' },
  { id: 'users-roles',  defaultLabel: 'Users & Roles',        group: 'Admin',    status: 'live' },
  { id: 'notifications',defaultLabel: 'Notifications',        group: 'Admin',    status: 'live' },
];

/** Per-project console overrides (stored on the project as `console`). */
export interface ConsoleConfig {
  labels?: Record<string, string>; // sectionId → label override (e.g. catalog → "Collection")
  hidden?: string[];               // sectionIds to hide for this project
  order?: string[];                // optional custom ordering of sectionIds
}

export interface ResolvedSection {
  id: string;
  label: string;
  group: SectionGroup;
  status: 'live' | 'demo';
}

/**
 * Resolve the ordered, visible sections for a project. Unset = the full catalog with
 * default labels (sensible superset). Projects narrow + relabel via `console`.
 */
export function resolveConsoleSections(project?: { console?: ConsoleConfig } | null): ResolvedSection[] {
  const cfg = project?.console || {};
  const hidden = new Set(cfg.hidden || []);
  let defs = SECTION_CATALOG.filter((s) => !hidden.has(s.id));
  if (cfg.order?.length) {
    const rank = new Map(cfg.order.map((id, i) => [id, i] as const));
    defs = [...defs].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  }
  return defs.map((s) => ({ id: s.id, label: cfg.labels?.[s.id] || s.defaultLabel, group: s.group, status: s.status }));
}

export const SECTION_GROUPS: SectionGroup[] = ['Main', 'Platform', 'Admin'];

export function sectionStatus(id: string): 'live' | 'demo' {
  return SECTION_CATALOG.find((s) => s.id === id)?.status || 'demo';
}
