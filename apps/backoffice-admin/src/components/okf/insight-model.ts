/**
 * Plain-language shaping for the Knowledge Base insight views. The service computes every figure; this only chooses
 * words, orders rows and formats numbers, so the screen and the service cannot disagree about what is true.
 */
import type { KnowledgeCoverage, KnowledgeLifecycle, MappingIssue } from "../../lib/api";

export const count = (value: number): string => new Intl.NumberFormat().format(value);

export const percent = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.round((part / whole) * 100));

/** Money is always shown in the currency it was declared in; nothing is assumed when it is missing. */
export function formatMoney(cents: number | null | undefined, currency?: string): string {
  if (cents === null || cents === undefined) return "No price";
  if (!currency) return `${(cents / 100).toFixed(2)} (currency not declared)`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export const shortChecksum = (value?: string | null): string => (value ? `${value.replace(/^sha256:/, "").slice(0, 10)}…` : "—");

export const NEXT_STEP: Record<KnowledgeLifecycle["nextStep"], { label: string; detail: string; tone: "ok" | "warn" | "neutral" }> = {
  write_draft: { label: "Write or import a draft", detail: "There is no business knowledge yet. Import an OKF bundle or generate a draft from the catalogue.", tone: "warn" },
  publish_release: { label: "Publish an immutable release", detail: "The draft has changes that no release contains. Publish it to make a release customers can be held to.", tone: "warn" },
  stage_release: { label: "Stage the latest release", detail: "A newer release exists than the one this project is bound to. Stage it, then publish the Business Pack.", tone: "warn" },
  publish_pack: { label: "Publish the Business Pack", detail: "The staged release is not what customers are served. Publishing the pack activates the journeys and the knowledge together.", tone: "warn" },
  none: { label: "Nothing waiting", detail: "Customers are served exactly the knowledge in the staged release, and the draft has no unpublished changes.", tone: "ok" },
};

export type StepState = "done" | "current" | "todo" | "blocked";
export interface LifecycleStep { id: "draft" | "release" | "staged" | "active"; title: string; state: StepState; summary: string; detail?: string }

/** The four places knowledge can be, left to right, each with where it stands. */
export function lifecycleSteps(lifecycle: KnowledgeLifecycle): LifecycleStep[] {
  const latest = lifecycle.releases.find((release) => release.status === "ready");
  const draft = lifecycle.draft;
  return [
    {
      id: "draft", title: "Draft",
      state: !draft ? "todo" : !draft.valid ? "blocked" : lifecycle.state.draftHasChanges ? "current" : "done",
      summary: draft ? `Revision ${draft.revision} · ${draft.concepts} concepts` : "None yet",
      detail: !draft ? undefined : !draft.valid ? `${draft.issues} validation issue${draft.issues === 1 ? "" : "s"} to fix` : lifecycle.state.draftHasChanges ? "Has changes no release contains" : "Matches the staged release",
    },
    {
      id: "release", title: "Release",
      state: latest ? (lifecycle.state.stagedIsLatestRelease === false ? "current" : "done") : "todo",
      summary: latest ? `${latest.version} · ${shortChecksum(latest.checksum)}` : "None published",
      detail: latest ? "Immutable and checksum-bound" : undefined,
    },
    {
      id: "staged", title: "Staged for the pack",
      state: lifecycle.staged ? (lifecycle.state.stagedIsLatestRelease === false ? "current" : "done") : "todo",
      summary: lifecycle.staged ? `${lifecycle.staged.version} · ${shortChecksum(lifecycle.staged.checksum)}` : "Nothing staged",
      detail: lifecycle.staged ? (lifecycle.staged.required ? "Required: customers get no answer if it cannot load" : "Optional") : undefined,
    },
    {
      id: "active", title: "Live in the Business Pack",
      state: lifecycle.active?.knowledge ? (lifecycle.state.activeIsStaged ? "done" : "current") : lifecycle.staged ? "current" : "todo",
      summary: lifecycle.active ? `Pack ${lifecycle.active.packVersion}${lifecycle.active.knowledge ? ` · knowledge ${lifecycle.active.knowledge.version}` : " · no knowledge attached"}` : "No pack published here",
      detail: lifecycle.active?.knowledge ? shortChecksum(lifecycle.active.knowledge.checksum) : undefined,
    },
  ];
}

export function diffSentence(diff: { identical: boolean; concepts: { added: { name: string }[]; removed: { name: string }[]; changed: { name: string }[]; total: number }; relationships: { added: number; removed: number; changed: number } } | null, from: string, to: string): string {
  if (!diff) return "";
  if (diff.identical) return `${to} is identical to ${from}.`;
  const parts: string[] = [];
  const named = (label: string, list: { name: string }[], total: number) => {
    if (list.length === 0) return;
    parts.push(`${label} ${list.slice(0, 3).map((entry) => entry.name).join(", ")}${total > 3 ? ` and ${total - 3} more` : ""}`);
  };
  named("changed", diff.concepts.changed, diff.concepts.changed.length);
  named("added", diff.concepts.added, diff.concepts.added.length);
  named("removed", diff.concepts.removed, diff.concepts.removed.length);
  const relationships = diff.relationships.added + diff.relationships.removed + diff.relationships.changed;
  if (relationships) parts.push(`${relationships} relationship${relationships === 1 ? "" : "s"} differ`);
  return `${to} differs from ${from}: ${parts.join("; ") || "supporting records differ"}.`;
}

export const MODE_COPY: Record<string, string> = {
  direct_results: "Shows matching products straight away.",
  overview_then_ask: "Shows examples from each category and asks what the customer needs.",
  clarify_then_search: "Asks a question first and shows no products until it is answered.",
  safety_then_diagnose: "Treats this as a problem: no products or checkout, no advice that is not verified, a professional is named.",
  project_journey: "Hands the customer to the project's journey.",
  evidence_answer: "Answers only from verified evidence. Without any, it says so and shows nothing.",
  operational_journey: "Routes to the operational journey (orders, returns, delivery…).",
  service_intake: "Starts a service request; no products.",
  legacy_search: "Searches the catalogue only, with no knowledge-based claims.",
  no_match: "No concept covers this. Nothing is retrieved and nothing is claimed.",
  knowledge_unavailable: "The required knowledge release could not be loaded, so the assistant does not answer.",
};

export const COMMERCE_COPY = {
  addToCart: { allowed: "Add to cart allowed", allowed_with_warning: "Add to cart allowed, with a warning", blocked: "Add to cart blocked" },
  checkout: {
    allowed: "Checkout allowed", requires_compatibility_resolution: "Checkout needs compatibility confirmed",
    requires_professional_confirmation: "Checkout needs a qualified professional to confirm", blocked: "Checkout blocked",
  },
} as const;

export const SEVERITY_ORDER: Record<MappingIssue["severity"], number> = { error: 0, warning: 1, info: 2 };
export const sortIssues = (issues: MappingIssue[]): MappingIssue[] =>
  [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.affected - a.affected);

export const READABLE_LABELS: Record<string, string> = {
  identifier: "Product code", title: "Name", description: "Description", brand: "Brand", category: "Category", categoryPath: "Category path",
  price: "Price", currency: "Currency", stock: "Stock", image: "Image",
};

export function coverageHeadline(coverage: KnowledgeCoverage): { covered: number | null; text: string } {
  if (!coverage.catalogue) return { covered: null, text: "Catalogue figures are not available." };
  const covered = percent(coverage.catalogue.covered, coverage.catalogue.products);
  return {
    covered,
    text: `${count(coverage.catalogue.covered)} of ${count(coverage.catalogue.products)} listed products (${covered}%) are inside a concept's scope.`,
  };
}
