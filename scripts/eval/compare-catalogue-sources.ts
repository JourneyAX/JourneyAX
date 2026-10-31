/**
 * Same-answer check for the in-memory catalogue index.
 *
 * Runs the product tools the agent really called (taken from saved eval results) and a sample of single-product lookups twice
 * against the LIVE catalogue: once through the database and once through the in-memory copy, and lists every request whose answer
 * differs. Read-only: it changes nothing in the database or the running services.
 *
 * Usage (from the repo root):
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/eval/compare-catalogue-sources.ts <tenant> \
 *     --calls <eval-results.json> [<more.json> ...] [--skus 300] [--max-calls 400] [--report <out.md>]
 */
import * as fs from 'fs';
import { PackRepository } from '../../apps/journey-runtime-service/src/kernel/pack.repository';
import { OkfKnowledgeControlPlane } from '../../apps/journey-runtime-service/src/kernel/knowledge-control-plane';
import { CatalogSearchHandler } from '../../apps/journey-runtime-service/src/capabilities/handlers/catalog-search.handler';
import { CatalogueIndexRegistry, openCatalogueDatabase } from '../../apps/journey-runtime-service/src/capabilities/catalogue-index';
import { executeAgentTool, type AgentToolContext } from '../../apps/journey-runtime-service/src/agent/agent-tools';
import { resolveCatalogMapping } from '../../packages/business-pack/src';

const PRODUCT_TOOLS = new Set(['search_products', 'get_product', 'get_related_products']);
const DATABASE_CONCURRENCY = 4;

interface Call { tool: string; args: Record<string, any>; origin: string }
interface Outcome { ms: number; json: string; skus: string[]; titles: Map<string, string>; relaxed: string[]; error?: string }

function parseArgs() {
  const argv = process.argv.slice(2);
  const tenant = argv[0];
  if (!tenant || tenant.startsWith('--')) throw new Error('usage: compare-catalogue-sources.ts <tenant> --calls <eval-results.json ...> [--skus N] [--max-calls N] [--report out.md]');
  const calls: string[] = [];
  let skus = 300;
  let maxCalls = 400;
  let report: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--calls') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) calls.push(argv[++i]); }
    else if (argv[i] === '--skus') skus = Number(argv[++i]);
    else if (argv[i] === '--max-calls') maxCalls = Number(argv[++i]);
    else if (argv[i] === '--report') report = argv[++i];
  }
  return { tenant, calls, skus, maxCalls, report };
}

const canonical = (value: any): any =>
  Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;

/** The title every product id carries in a tool answer. */
function titlesIn(answer: any, found = new Map<string, string>(), depth = 0): Map<string, string> {
  if (!answer || typeof answer !== 'object' || depth > 4) return found;
  if (Array.isArray(answer)) { answer.forEach((entry) => titlesIn(entry, found, depth + 1)); return found; }
  if (typeof answer.sku === 'string') found.set(answer.sku, String(answer.title ?? answer.name ?? ''));
  for (const key of Object.keys(answer)) if (key !== 'sku') titlesIn(answer[key], found, depth + 1);
  return found;
}

/** Every product id a tool answer names, in the order it names them. */
function skusIn(answer: any, found: string[] = [], depth = 0): string[] {
  if (!answer || typeof answer !== 'object' || depth > 4) return found;
  if (Array.isArray(answer)) { answer.forEach((entry) => skusIn(entry, found, depth + 1)); return found; }
  if (typeof answer.sku === 'string') found.push(answer.sku);
  for (const key of Object.keys(answer)) if (key !== 'sku') skusIn(answer[key], found, depth + 1);
  return found;
}

function collectCalls(files: string[], maxCalls: number): Call[] {
  const seen = new Set<string>();
  const calls: Call[] = [];
  for (const file of files) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const invocation of row.toolInvocations || []) {
        if (!PRODUCT_TOOLS.has(invocation.name) || !invocation.arguments) continue;
        const key = `${invocation.name}:${JSON.stringify(canonical(invocation.arguments))}`;
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ tool: invocation.name, args: invocation.arguments, origin: `${file.split('/').pop()}#${row.id}` });
      }
    }
  }
  return calls.slice(0, maxCalls);
}

async function main() {
  const { tenant, calls: files, skus: skuCount, maxCalls, report } = parseArgs();
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (run with --env-file=.env)');
  const release: any = await new PackRepository().loadActivePack(tenant, 'production');
  const okfContent: any = release.knowledgeModel?.type === 'okf_release'
    ? await (new OkfKnowledgeControlPlane() as any).getReleaseContent(tenant, 'production', release.knowledgeModel)
    : null;
  const mapping = resolveCatalogMapping(release.catalogMapping);
  const handler = new CatalogSearchHandler();
  const makeContext = (): AgentToolContext => ({
    tenantId: tenant, environmentId: 'production', correlationId: 'compare-catalogue-sources', release, okfContent, catalogSearchHandler: handler,
    turnProductSkus: new Set(), catalogProductCache: new Map(), readSourceIds: new Set(), allowedClaimClasses: new Set(),
    presentedCards: [], isHumanHandoffRequested: false,
  } as any);
  const run = async (call: Call): Promise<Outcome> => {
    const started = Date.now();
    try {
      const answer = await executeAgentTool(call.tool, JSON.parse(JSON.stringify(call.args)), makeContext());
      return { ms: Date.now() - started, json: JSON.stringify(canonical(answer)), skus: skusIn(answer), titles: titlesIn(answer), relaxed: answer?.relaxedConstraints || [] };
    } catch (err: any) {
      return { ms: Date.now() - started, json: `error:${err?.message || err}`, skus: [], titles: new Map(), relaxed: [], error: String(err?.message || err) };
    }
  };

  const registry = CatalogueIndexRegistry.shared();
  // The copy first, so the sampled single-product lookups can name products that are in it.
  process.env.CATALOGUE_INDEX = 'on';
  const loadStarted = Date.now();
  await registry.warm({ tenantId: tenant, mapping, getDb: () => openCatalogueDatabase() });
  const copy = registry.productsFor({ tenantId: tenant, mapping, getDb: () => openCatalogueDatabase() });
  if (!copy) throw new Error(`the copy for ${tenant} did not load: ${JSON.stringify(registry.status())}`);
  console.log(`copy loaded: ${copy.length} products in ${Date.now() - loadStarted} ms`);

  const calls = collectCalls(files, maxCalls);
  const identifierPath = mapping.identifierPaths[0];
  const step = Math.max(1, Math.floor(copy.length / Math.max(1, skuCount)));
  for (let i = 0; i < copy.length && calls.filter((c) => c.origin === 'sample').length < skuCount; i += step) {
    const sku = (identifierPath ? copy[i]?.[identifierPath.split('.')[0]] : undefined) ?? copy[i]?.sku;
    if (typeof sku === 'string' && sku) calls.push({ tool: 'get_product', args: { sku }, origin: 'sample' });
  }
  console.log(`${calls.length} requests (${calls.filter((c) => c.origin !== 'sample').length} the agent made, ${calls.filter((c) => c.origin === 'sample').length} sampled lookups)`);

  const viaIndex: Outcome[] = [];
  for (const call of calls) viaIndex.push(await run(call));
  process.env.CATALOGUE_INDEX = 'off';
  const viaDatabase: Outcome[] = new Array(calls.length);
  let next = 0;
  await Promise.all(Array.from({ length: DATABASE_CONCURRENCY }, async () => {
    while (next < calls.length) { const at = next++; viaDatabase[at] = await run(calls[at]); }
  }));

  const rows = calls.map((call, i) => {
    const a = viaDatabase[i];
    const b = viaIndex[i];
    const verdict = a.json === b.json ? 'identical'
      : a.skus.join() === b.skus.join() ? 'same products, other detail'
        : [...a.skus].sort().join() === [...b.skus].sort().join() ? 'same products, other order'
          : 'different products';
    return { call, a, b, verdict };
  });
  const tally = rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.verdict]: (acc[row.verdict] || 0) + 1 }), {});
  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;
  const p95 = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length * 0.95)] ?? 0;
  const lines: string[] = [
    `# Catalogue source comparison: ${tenant}`,
    '',
    `Copy: ${copy.length} products. Requests: ${rows.length}.`,
    '',
    '| Verdict | Requests |',
    '|---|---|',
    ...Object.entries(tally).map(([verdict, count]) => `| ${verdict} | ${count} |`),
    '',
    `Time per request, database: median ${median(viaDatabase.map((o) => o.ms))} ms, p95 ${p95(viaDatabase.map((o) => o.ms))} ms (${DATABASE_CONCURRENCY} at a time). Copy: median ${median(viaIndex.map((o) => o.ms))} ms, p95 ${p95(viaIndex.map((o) => o.ms))} ms.`,
    '',
  ];
  const differing = rows.filter((row) => row.verdict !== 'identical');
  if (differing.length > 0) {
    lines.push('## Requests whose answers differ', '');
    for (const row of differing) {
      lines.push(`- **${row.verdict}**: \`${row.call.tool}\` ${JSON.stringify(row.call.args)} (${row.call.origin})`);
      lines.push(`  - database: ${row.a.error ? `ERROR ${row.a.error}` : row.a.skus.slice(0, 8).join(', ') || '(none)'}${row.a.relaxed.length ? ` relaxed ${row.a.relaxed.join('+')}` : ''}`);
      lines.push(`  - copy: ${row.b.error ? `ERROR ${row.b.error}` : row.b.skus.slice(0, 8).join(', ') || '(none)'}${row.b.relaxed.length ? ` relaxed ${row.b.relaxed.join('+')}` : ''}`);
      const onlyDatabase = row.a.skus.filter((sku) => !row.b.skus.includes(sku));
      const onlyCopy = row.b.skus.filter((sku) => !row.a.skus.includes(sku));
      if (onlyDatabase.length > 0) lines.push(`  - only in the database answer: ${onlyDatabase.map((sku) => `${sku} ${row.a.titles.get(sku) || ''}`.trim()).join('; ')}`);
      if (onlyCopy.length > 0) lines.push(`  - only in the copy's answer: ${onlyCopy.map((sku) => `${sku} ${row.b.titles.get(sku) || ''}`.trim()).join('; ')}`);
    }
  }
  const text = lines.join('\n');
  console.log(`\n${text}`);
  if (report) { fs.writeFileSync(report, `${text}\n`); console.log(`\nreport written to ${report}`); }
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
