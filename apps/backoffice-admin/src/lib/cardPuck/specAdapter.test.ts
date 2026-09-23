/**
 * Round-trip: every platform default Spec survives spec → Puck → spec.
 *   npx tsx apps/backoffice-admin/src/lib/cardPuck/specAdapter.test.ts
 */
import { DEFAULT_TEMPLATES, CARD_TYPE_NAMES } from "@journeyax/ui-cards";
import { canonicalizeSpec, puckDataToSpec, specToPuckData } from "./specAdapter";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) {
    failures++;
    console.error(`✗ ${name}${extra ? `\n  ${extra}` : ""}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as any)[k]);
    return out;
  }
  return v;
}

for (const cardType of CARD_TYPE_NAMES) {
  const original = canonicalizeSpec(DEFAULT_TEMPLATES[cardType]);
  const puck = specToPuckData(original);
  const round = canonicalizeSpec(puckDataToSpec(puck));
  const a = JSON.stringify(sortKeys(original));
  const b = JSON.stringify(sortKeys(round));
  check(`${cardType} round-trips`, a === b, a === b ? undefined : `out:\n${b}\nwant:\n${a}`);
  check(`${cardType} has a root node`, puck.content.length === 1);
}

const empty = puckDataToSpec({ root: { props: {} }, content: [] });
check("empty puck data yields a Box root", empty.root === "root" && empty.elements.root?.type === "Box");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
