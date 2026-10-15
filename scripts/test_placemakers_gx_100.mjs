import fs from 'fs';
import path from 'path';

const API_URL = process.env.AGENT_SERVICE_URL
  ? `${process.env.AGENT_SERVICE_URL}/api/v1/placemakers/commerce/chat`
  : 'http://localhost:3004/api/v1/placemakers/commerce/chat';

const ARTIFACT_DIR = '/Users/mahaveer/.gemini/antigravity-ide/brain/70967f9f-4766-4b50-ad6e-0a46666d1ba5';
const REPORT_PATH = path.join(ARTIFACT_DIR, 'placemakers_100_test_report.md');
const JSON_PATH = path.join(ARTIFACT_DIR, 'placemakers_100_eval_results.json');

const PROMPTS = [
  // ── 1. Timber & Structural Framing (12) ──
  { id: 'GX-001', category: 'Timber & Structural Framing', prompt: 'Do you have 100x50 H3.2 treated timber in stock?' },
  { id: 'GX-002', category: 'Timber & Structural Framing', prompt: 'I need 4x2 timber for framing, what do you have?' },
  { id: 'GX-003', category: 'Timber & Structural Framing', prompt: "What's the difference between kiln dried and wet timber?" },
  { id: 'GX-004', category: 'Timber & Structural Framing', prompt: 'Looking for 150x50 treated pine for a deck frame' },
  { id: 'GX-005', category: 'Timber & Structural Framing', prompt: 'Do you sell untreated structural timber?' },
  { id: 'GX-006', category: 'Timber & Structural Framing', prompt: 'What size timber do I need for deck joists?' },
  { id: 'GX-007', category: 'Timber & Structural Framing', prompt: '9x15 timber for a fence rail - do you stock that?' },
  { id: 'GX-008', category: 'Timber & Structural Framing', prompt: 'Can I get H1.2 treated timber for interior framing?' },
  { id: 'GX-009', category: 'Timber & Structural Framing', prompt: "What's your cheapest 6x2 treated timber?" },
  { id: 'GX-010', category: 'Timber & Structural Framing', prompt: 'Do you have square dressed boards for skirting?' },
  { id: 'GX-011', category: 'Timber & Structural Framing', prompt: 'I need timber for retaining wall sleepers' },
  { id: 'GX-012', category: 'Timber & Structural Framing', prompt: 'What plywood thickness is best for flooring underlay?' },

  // ── 2. Decking & Pergolas (8) ──
  { id: 'GX-013', category: 'Decking & Pergolas', prompt: 'Show me your range of decking timber' },
  { id: 'GX-014', category: 'Decking & Pergolas', prompt: 'Do you have 100x100 treated posts for a pergola?' },
  { id: 'GX-015', category: 'Decking & Pergolas', prompt: 'What timber grade should I use for load-bearing beams?' },
  { id: 'GX-021', category: 'Decking & Pergolas', prompt: 'Show me composite decking options' },
  { id: 'GX-022', category: 'Decking & Pergolas', prompt: "What's needed to build a deck from scratch - framing, boards, fixings?" },
  { id: 'GX-023', category: 'Decking & Pergolas', prompt: 'Do you sell pergola kits?' },
  { id: 'GX-025', category: 'Decking & Pergolas', prompt: "What's the best decking board width for a small patio?" },
  { id: 'GX-052', category: 'Decking & Pergolas', prompt: 'Do you have brackets for a pergola build?' },

  // ── 3. Fencing & Boundary (8) ──
  { id: 'GX-016', category: 'Fencing & Boundary', prompt: 'I want to build a timber paling fence, what do I need?' },
  { id: 'GX-017', category: 'Fencing & Boundary', prompt: "What's the difference between palings and rails for fencing?" },
  { id: 'GX-018', category: 'Fencing & Boundary', prompt: 'Do you have fence trellis panels in stock?' },
  { id: 'GX-019', category: 'Fencing & Boundary', prompt: 'Looking for aluminium fence panels instead of timber' },
  { id: 'GX-020', category: 'Fencing & Boundary', prompt: "What's needed to build a basic backyard fence?" },
  { id: 'GX-024', category: 'Fencing & Boundary', prompt: 'I need fence posts and concrete for a new boundary fence' },
  { id: 'GX-047', category: 'Fencing & Boundary', prompt: 'I need paint for a fence - what do you recommend?' },
  { id: 'GX-090', category: 'Fencing & Boundary', prompt: 'I want to put up a new fence around my property' },

  // ── 4. Building Materials, Insulation & Boards (12) ──
  { id: 'GX-026', category: 'Building Materials & Insulation', prompt: 'Do you stock GIB plasterboard sheets?' },
  { id: 'GX-027', category: 'Building Materials & Insulation', prompt: 'Find me a jib board' },
  { id: 'GX-028', category: 'Building Materials & Insulation', prompt: 'What insulation do you recommend for ceiling, R2.2 or R2.6?' },
  { id: 'GX-029', category: 'Building Materials & Insulation', prompt: 'I need underfloor insulation for an old villa' },
  { id: 'GX-030', category: 'Building Materials & Insulation', prompt: 'Do you have Pink Batts in stock?' },
  { id: 'GX-031', category: 'Building Materials & Insulation', prompt: 'What wet wall lining do you have for a bathroom?' },
  { id: 'GX-032', category: 'Building Materials & Insulation', prompt: 'Looking for MDF panels for cabinetry' },
  { id: 'GX-033', category: 'Building Materials & Insulation', prompt: 'Do you sell roofing iron or steel roofing sheets?' },
  { id: 'GX-034', category: 'Building Materials & Insulation', prompt: "What's the R-value difference between wall and ceiling insulation?" },
  { id: 'GX-035', category: 'Building Materials & Insulation', prompt: 'I need concrete mix for a small footpath' },
  { id: 'GX-036', category: 'Building Materials & Insulation', prompt: 'Do you have noticeboard or pinboard panels?' },
  { id: 'GX-037', category: 'Building Materials & Insulation', prompt: 'What thickness plasterboard do I need for a garage wall?' },

  // ── 5. Paint, Woodcare & Finishes (10) ──
  { id: 'GX-038', category: 'Paint & Finishes', prompt: 'What woodcare paint do you recommend for an outdoor deck?' },
  { id: 'GX-039', category: 'Paint & Finishes', prompt: 'Do you have Resene paint in stock?' },
  { id: 'GX-040', category: 'Paint & Finishes', prompt: 'I want to build a pink colour cabinet from scratch, what paint?' },
  { id: 'GX-041', category: 'Paint & Finishes', prompt: "What's a good stain blocker for water marks before painting?" },
  { id: 'GX-042', category: 'Paint & Finishes', prompt: 'Do you sell aerosol/spray paint for small touch-ups?' },
  { id: 'GX-043', category: 'Paint & Finishes', prompt: 'What finish is best for exterior timber cladding?' },
  { id: 'GX-044', category: 'Paint & Finishes', prompt: 'Looking for a clear timber sealer for a deck' },
  { id: 'GX-045', category: 'Paint & Finishes', prompt: 'Do you have exterior paint in a range of colours?' },
  { id: 'GX-046', category: 'Paint & Finishes', prompt: 'What primer should I use before painting new MDF?' },
  { id: 'GX-087', category: 'Paint & Finishes', prompt: 'I want to build a pink colour cabinet from scratch' },

  // ── 6. Fasteners, Screws & Fixings (11) ──
  { id: 'GX-048', category: 'Fasteners & Hardware', prompt: 'What screw should I use for wallboard?' },
  { id: 'GX-049', category: 'Fasteners & Hardware', prompt: 'Do you stock cladding screws in stainless steel?' },
  { id: 'GX-050', category: 'Fasteners & Hardware', prompt: "What's the right screw size for decking boards?" },
  { id: 'GX-051', category: 'Fasteners & Hardware', prompt: 'I need nails for a Paslode nail gun' },
  { id: 'GX-053', category: 'Fasteners & Hardware', prompt: 'What fixings do I need for a timber retaining wall?' },
  { id: 'GX-054', category: 'Fasteners & Hardware', prompt: 'Looking for construction adhesive for skirting boards' },
  { id: 'GX-055', category: 'Fasteners & Hardware', prompt: 'What screws are safe to use near electrical wiring?' },
  { id: 'GX-056', category: 'Fasteners & Hardware', prompt: 'Do you sell galvanised nails for outdoor framing?' },
  { id: 'GX-057', category: 'Fasteners & Hardware', prompt: "What's the difference between coach screws and bolts?" },
  { id: 'GX-099', category: 'Fasteners & Hardware', prompt: 'What nails are safe to use near power outlets?' },
  { id: 'GX-060', category: 'Fasteners & Hardware', prompt: 'Do you sell cordless screw driving systems?' },

  // ── 7. Power Tools & Machinery (10) ──
  { id: 'GX-058', category: 'Tools & Machinery', prompt: 'What drill should I use for masonry walls?' },
  { id: 'GX-059', category: 'Tools & Machinery', prompt: 'What trimmer should I use for hedges?' },
  { id: 'GX-061', category: 'Tools & Machinery', prompt: 'What saw do I need to cut treated timber?' },
  { id: 'GX-062', category: 'Tools & Machinery', prompt: 'Do you have a Paslode Trim Master in stock?' },
  { id: 'GX-063', category: 'Tools & Machinery', prompt: "What's the best tool for driving batten and cradle deck systems?" },
  { id: 'GX-064', category: 'Tools & Machinery', prompt: 'I need a reciprocating saw blade for demolition work' },
  { id: 'GX-065', category: 'Tools & Machinery', prompt: 'What drill bit should I use for tiles?' },
  { id: 'GX-066', category: 'Tools & Machinery', prompt: 'Do you have hand tools for plumbing repairs?' },
  { id: 'GX-067', category: 'Tools & Machinery', prompt: 'What power tool is best for cutting plywood sheets?' },
  { id: 'GX-069', category: 'Tools & Machinery', prompt: 'What tool should I use to drive screws into GIB board?' },

  // ── 8. Plumbing, Kitchen & Bath (10) ──
  { id: 'GX-068', category: 'Plumbing & Sanitary', prompt: 'Looking for a multitap - do you have one chilled and brushed?' },
  { id: 'GX-070', category: 'Plumbing & Sanitary', prompt: 'Do you sell PVC piping and fittings?' },
  { id: 'GX-071', category: 'Plumbing & Sanitary', prompt: 'What plumbing tools do I need for a basic bathroom repair?' },
  { id: 'GX-072', category: 'Plumbing & Sanitary', prompt: 'Looking for bathroom accessories and fixtures' },
  { id: 'GX-073', category: 'Plumbing & Sanitary', prompt: 'Do you have piping systems for a kitchen renovation?' },
  { id: 'GX-074', category: 'Plumbing & Sanitary', prompt: 'What fittings do I need to join two pipes of different sizes?' },
  { id: 'GX-075', category: 'Plumbing & Sanitary', prompt: 'Do you sell kitchen benchtops?' },
  { id: 'GX-076', category: 'Plumbing & Sanitary', prompt: 'I need a tap for my kitchen sink' },
  { id: 'GX-077', category: 'Plumbing & Sanitary', prompt: 'What plumbing supplies do you stock for outdoor taps?' },
  { id: 'GX-089', category: 'Plumbing & Sanitary', prompt: "I'm renovating my bathroom, where do I start?" },

  // ── 9. Landscaping & Outdoor Living (8) ──
  { id: 'GX-078', category: 'Landscaping & Outdoor', prompt: 'Do you have pavers for a garden pathway?' },
  { id: 'GX-079', category: 'Landscaping & Outdoor', prompt: 'I need a clothesline for my backyard' },
  { id: 'GX-080', category: 'Landscaping & Outdoor', prompt: 'What products do you have for lawn and plant care?' },
  { id: 'GX-081', category: 'Landscaping & Outdoor', prompt: 'Do you sell translucent roofing for a carport?' },
  { id: 'GX-082', category: 'Landscaping & Outdoor', prompt: 'Looking for gardening tools - spades, rakes, etc.' },
  { id: 'GX-083', category: 'Landscaping & Outdoor', prompt: 'What do I need for a retaining wall in a sloped garden?' },
  { id: 'GX-084', category: 'Landscaping & Outdoor', prompt: 'Do you have plant and pest control products?' },
  { id: 'GX-085', category: 'Landscaping & Outdoor', prompt: "What's the best paving option for a driveway?" },

  // ── 10. Projects, Slang & Edge Cases (11) ──
  { id: 'GX-086', category: 'Projects & Edge Cases', prompt: 'I want to build a cabinet' },
  { id: 'GX-088', category: 'Projects & Edge Cases', prompt: 'Help me build a deck in my backyard' },
  { id: 'GX-091', category: 'Projects & Edge Cases', prompt: 'What do I need to build a garden shed?' },
  { id: 'GX-092', category: 'Projects & Edge Cases', prompt: "I'm doing a kitchen makeover, what should I look at?" },
  { id: 'GX-093', category: 'Projects & Edge Cases', prompt: 'I want to insulate my house before winter' },
  { id: 'GX-094', category: 'Projects & Edge Cases', prompt: 'Help me plan a small landscaping project' },
  { id: 'GX-095', category: 'Projects & Edge Cases', prompt: 'I want to build a pergola over my patio' },
  { id: 'GX-096', category: 'Projects & Edge Cases', prompt: 'Find me a jib' },
  { id: 'GX-097', category: 'Projects & Edge Cases', prompt: "What's a dwang and where do I find one?" },
  { id: 'GX-098', category: 'Projects & Edge Cases', prompt: "I need a nogging piece of timber, what's that called here?" },
  { id: 'GX-100', category: 'Projects & Edge Cases', prompt: 'asdkfj cabinet timber 4x2' },
];

async function runScenario(scenario, index, total, retry = 3) {
  const start = Date.now();
  const sessionId = `e2e_${scenario.id.toLowerCase()}_${Date.now()}`;
  const ip = `10.0.${Math.floor(index / 10)}.${(index % 10) + 1}`;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({
        tenantId: 'placemakers',
        projectId: 'placemakers',
        sessionId,
        message: scenario.prompt,
        messages: [{ role: 'user', content: scenario.prompt }],
      }),
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      if (retry > 0) {
        const waitMs = res.status === 429 ? 3000 : 1500;
        await new Promise((r) => setTimeout(r, waitMs));
        return runScenario(scenario, index, total, retry - 1);
      }
      const errText = await res.text().catch(() => '');
      return {
        ...scenario,
        ok: false,
        status: res.status,
        elapsed,
        error: `HTTP ${res.status}: ${errText.slice(0, 150)}`,
        messageSnippet: '',
        cardTypes: [],
        hasCards: false,
        productsCount: 0,
      };
    }

    const data = await res.json();
    const assistantMsg = data?.message?.content || '';
    const uiActions = Array.isArray(data?.uiActions) ? data.uiActions : [];
    const cardTypes = uiActions.map((a) => a?.arguments?.card?.cardType).filter(Boolean);
    const productsCount = uiActions
      .filter((a) => a?.arguments?.card?.cardType === 'products')
      .reduce((sum, a) => sum + (a?.arguments?.card?.state?.products?.length || 0), 0);

    const hasExplanation = assistantMsg.trim().length > 10;
    const hasValidOutput = (hasExplanation || cardTypes.length > 0) && !assistantMsg.includes('Failed to process message');

    return {
      ...scenario,
      ok: hasValidOutput,
      status: res.status,
      elapsed,
      messageSnippet: assistantMsg.replace(/\s+/g, ' ').slice(0, 140) + (assistantMsg.length > 140 ? '...' : ''),
      cardTypes,
      hasCards: cardTypes.length > 0,
      productsCount,
      fullResponse: assistantMsg,
    };
  } catch (err) {
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return runScenario(scenario, index, total, retry - 1);
    }
    const elapsed = Date.now() - start;
    return {
      ...scenario,
      ok: false,
      status: 0,
      elapsed,
      error: String(err?.message || err),
      messageSnippet: '',
      cardTypes: [],
      hasCards: false,
      productsCount: 0,
    };
  }
}

async function runAllWithPool(poolSize = 4) {
  console.log(`\n======================================================`);
  console.log(`🚀 PlaceMakers GX E2E 100-Prompt Evaluation`);
  console.log(`Target API: ${API_URL}`);
  console.log(`Total Prompts: ${PROMPTS.length} | Concurrency: ${poolSize}`);
  console.log(`======================================================\n`);

  const results = [];
  let nextIdx = 0;

  async function worker(workerId) {
    while (nextIdx < PROMPTS.length) {
      const i = nextIdx++;
      const scenario = PROMPTS[i];
      const r = await runScenario(scenario, i + 1, PROMPTS.length);
      results[i] = r;

      const cardTag = r.cardTypes.length ? `[Cards: ${r.cardTypes.join(', ')}]` : '[No Cards]';
      const prodTag = r.productsCount > 0 ? `(${r.productsCount} prods)` : '';
      const statusIcon = r.ok ? '✅' : '❌';
      console.log(
        `${statusIcon} [${String(i + 1).padStart(3, '0')}/${PROMPTS.length}] ${r.id.padEnd(7)} | ${r.category.padEnd(28)} | ${(r.elapsed / 1000).toFixed(1)}s | ${cardTag} ${prodTag} | "${r.prompt.slice(0, 36)}..."`
      );
    }
  }

  const workers = Array.from({ length: poolSize }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // Summarize
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;
  const totalElapsed = results.reduce((acc, r) => acc + r.elapsed, 0);
  const avgElapsed = (totalElapsed / total / 1000).toFixed(2);
  const withCards = results.filter((r) => r.hasCards).length;
  const totalProductsShown = results.reduce((acc, r) => acc + r.productsCount, 0);

  // Group by category
  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) categories[r.category] = { total: 0, passed: 0, withCards: 0, products: 0 };
    categories[r.category].total++;
    if (r.ok) categories[r.category].passed++;
    if (r.hasCards) categories[r.category].withCards++;
    categories[r.category].products += r.productsCount;
  }

  console.log(`\n======================================================`);
  console.log(`📊 EVALUATION SUMMARY`);
  console.log(`Total: ${total} | Passed: ${passed} (${((passed / total) * 100).toFixed(1)}%) | Failed: ${failed}`);
  console.log(`Avg Latency: ${avgElapsed}s | Scenarios with Cards: ${withCards} | Total Products: ${totalProductsShown}`);
  console.log(`======================================================\n`);

  // Write JSON
  fs.writeFileSync(
    JSON_PATH,
    JSON.stringify(
      {
        evaluatedAt: new Date().toISOString(),
        summary: { total, passed, failed, avgElapsedSec: avgElapsed, withCards, totalProductsShown },
        categories,
        results,
      },
      null,
      2
    )
  );
  console.log(`Saved JSON artifact: ${JSON_PATH}`);

  // Write Markdown Report
  let md = `# PlaceMakers GX 100-Prompt End-to-End Evaluation Report\n\n`;
  md += `**Evaluated At**: ${new Date().toISOString()}  \n`;
  md += `**Execution Target**: \`${API_URL}\`  \n`;
  md += `**Architecture**: Autonomous ReAct Loop Agent via Google OKF (\`TradeKnowledgeService\` + live MongoDB \`products\`)  \n\n`;

  md += `## 1. Executive Summary\n\n`;
  md += `| Metric | Result |\n`;
  md += `|---|---:|\n`;
  md += `| **Total Scenarios Evaluated** | **${total}** |\n`;
  md += `| **Passed (Valid Trade Guidance)** | **${passed}** (${((passed / total) * 100).toFixed(1)}%) |\n`;
  md += `| **Failed / Errored** | **${failed}** |\n`;
  md += `| **Interactive Cards Emitted** | **${withCards}** scenarios |\n`;
  md += `| **Products Presented** | **${totalProductsShown}** products |\n`;
  md += `| **Average Turn Latency** | **${avgElapsed}s** |\n\n`;

  md += `## 2. Results by Trade Domain Category\n\n`;
  md += `| Category | Total | Passed | Pass Rate | With UI Cards | Products Shown |\n`;
  md += `|---|---:|---:|---:|---:|---:|\n`;
  for (const [cat, stat] of Object.entries(categories)) {
    const rate = ((stat.passed / stat.total) * 100).toFixed(0);
    md += `| **${cat}** | ${stat.total} | ${stat.passed} | ${rate}% | ${stat.withCards} | ${stat.products} |\n`;
  }

  md += `\n## 3. Detailed Prompt-by-Prompt Breakdown\n\n`;
  md += `| ID | Category | Prompt | Latency | Cards | Explanation Snippet |\n`;
  md += `|---|---|---|---:|---|---|\n`;
  for (const r of results) {
    const cardStr = r.cardTypes.length ? r.cardTypes.join(', ') : '—';
    const cleanSnippet = (r.messageSnippet || r.error || '').replace(/\|/g, '\\|');
    md += `| \`${r.id}\` | ${r.category} | ${r.prompt} | ${(r.elapsed / 1000).toFixed(1)}s | \`${cardStr}\` | ${cleanSnippet} |\n`;
  }

  fs.writeFileSync(REPORT_PATH, md);
  console.log(`Saved Markdown Report: ${REPORT_PATH}`);
}

runAllWithPool(4);
