import type { AuthoredKnowledge, WorklistEntry } from './authoring';

export interface WorklistSummary {
  entries: number;
  byClaimClass: Record<string, { entries: number; concepts: number; candidateDocuments: number }>;
  conceptsWithCandidates: number;
  gaps: number;
  verified: number;
}

const n = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function summarizeWorklist(authored: Pick<AuthoredKnowledge, 'worklist'>): WorklistSummary {
  const byClaimClass: WorklistSummary['byClaimClass'] = {};
  for (const entry of authored.worklist.entries) {
    const bucket = byClaimClass[entry.claimClass] ?? (byClaimClass[entry.claimClass] = { entries: 0, concepts: 0, candidateDocuments: 0 });
    bucket.entries++;
    bucket.candidateDocuments += entry.candidates.length;
  }
  for (const claimClass of Object.keys(byClaimClass)) {
    byClaimClass[claimClass].concepts = new Set(authored.worklist.entries.filter((entry) => entry.claimClass === claimClass).map((entry) => entry.conceptId)).size;
  }
  return {
    entries: authored.worklist.entries.length, byClaimClass,
    conceptsWithCandidates: new Set(authored.worklist.entries.map((entry) => entry.conceptId)).size,
    gaps: authored.worklist.gaps.length,
    verified: 0,
  };
}

/**
 * The verified-sources register: every claim the assistant could eventually make, the candidate documents that might
 * support it, and what stays switched off until a person confirms them. Nothing here is verified.
 */
export function renderWorklistMarkdown(authored: Pick<AuthoredKnowledge, 'worklist' | 'snapshot'>): string {
  const summary = summarizeWorklist(authored);
  const lines = [
    `# ${authored.snapshot.tenantId} verification worklist`, '',
    `Snapshot ${authored.snapshot.snapshotAt}. **Verified claims: ${summary.verified}.** Every item below is a *candidate*: a crawled document that names a product in the category. Until a qualified person confirms that a document applies (or supplies their own statement), the assistant makes no such claim and the matching customer capability stays off.`, '',
    '## Summary', '', '| Claim class | Worklist items | Concepts | Candidate documents | Stays off until verified |', '|---|---:|---:|---:|---|',
    ...Object.entries(summary.byClaimClass).sort((a, b) => b[1].entries - a[1].entries).map(([claim, bucket]) => {
      const blocks = authored.worklist.entries.find((entry) => entry.claimClass === claim)?.blocks ?? '';
      return `| ${claim} | ${n(bucket.entries)} | ${n(bucket.concepts)} | ${n(bucket.candidateDocuments)} | ${blocks} |`;
    }), '',
  ];
  if (authored.worklist.gaps.length) {
    lines.push('## No document can support these (a person must author and verify them)', '', '| Concept | Claim class | Why |', '|---|---|---|');
    for (const gap of authored.worklist.gaps) lines.push(`| ${gap.conceptName} | ${gap.claimClass} | ${gap.reason} |`);
    lines.push('');
  }
  const byDepartment = new Map<string, WorklistEntry[]>();
  for (const entry of authored.worklist.entries) byDepartment.set(entry.department, [...(byDepartment.get(entry.department) || []), entry]);
  for (const [department, entries] of [...byDepartment.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${department}`, '', '| Concept | Claim class | Candidate documents (kind: title) |', '|---|---|---|');
    for (const entry of entries) {
      lines.push(`| ${entry.conceptName} | ${entry.claimClass} | ${entry.candidates.map((doc) => `${doc.kind}: [${doc.title.replace(/\|/g, '/')}](${doc.url})`).join('<br>')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
