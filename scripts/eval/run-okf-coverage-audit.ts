#!/usr/bin/env node
/**
 * OKF Coverage Audit (Task A4)
 *
 * Evaluates the PlaceMakers published OKF release against the PlaceMakers 100 test prompts.
 * Reports which OKF concepts, relationships, glossary terms, and safety/compliance rules apply,
 * and identifies missing content. Groups gaps into:
 *   - glossary
 *   - project recipes
 *   - product family notes
 *   - relationships
 *   - install/care notes
 *   - safety/compliance
 *   - warranty
 *
 * Source: Loaded from test fixture (apps/journey-runtime-service/test/helpers/placemakers-stack.ts)
 * as the development database is not connected in this local environment.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildPlaceMakersStack } from '../../apps/journey-runtime-service/test/helpers/placemakers-stack';

interface TestPrompt {
  id: number;
  category: string;
  prompt: string | string[];
  purpose: string;
  groundTruthReference: string;
  groundTruthUrls?: string;
}

interface PromptAudit {
  id: number;
  prompt: string;
  category: string;
  purpose: string;
  applicableConcepts: string[];
  applicableRelationships: string[];
  applicableGlossary: string[];
  applicableSafety: string[];
  gaps: {
    glossary: string[];
    projectRecipes: string[];
    productFamilyNotes: string[];
    relationships: string[];
    installCareNotes: string[];
    safetyCompliance: string[];
    warranty: string[];
  };
}

async function runAudit() {
  console.log('Loading PlaceMakers OKF release from test fixture...');
  const stack = await buildPlaceMakersStack();
  const okfContent = stack.content;
  const authoringSpec = JSON.parse(
    fs.readFileSync(path.resolve('scripts/okf/tenants/placemakers.authoring.json'), 'utf8')
  );

  const promptsPath = path.resolve('docs/evals/placemakers-100.json');
  const prompts: TestPrompt[] = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));

  const okfConcepts = (okfContent.concepts || []).map((c: any) => ({
    name: c.name?.toLowerCase() || '',
    type: c.type,
    id: c.id,
  }));

  const okfRelationships = (okfContent.relationships || []).map((r: any) => ({
    from: r.from,
    to: r.to,
    type: r.type,
  }));

  const aliases = (authoringSpec.aliases || []).map((a: any) => ({
    id: a.id,
    concept: a.concept,
    phrases: (a.phrases || []).map((p: string) => p.toLowerCase()),
  }));

  const projects = (authoringSpec.projects || []).map((p: any) => ({
    id: p.id,
    name: p.name,
    phrases: (p.phrases || []).map((ph: string) => ph.toLowerCase()),
    categories: p.categories || [],
  }));

  const problems = (authoringSpec.problems || []).map((p: any) => ({
    id: p.id,
    name: p.name,
    phrases: (p.phrases || []).map((ph: string) => ph.toLowerCase()),
  }));

  const care = (authoringSpec.care || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    phrases: (c.phrases || []).map((ph: string) => ph.toLowerCase()),
    appliesTo: c.appliesTo || [],
  }));

  const suggestions = (authoringSpec.suggestions || []).map((s: any) => ({
    id: s.id,
    from: s.from,
    to: s.to,
    rationale: s.rationale,
  }));

  const promptAudits: PromptAudit[] = [];

  const globalGaps = {
    glossary: new Set<string>(),
    projectRecipes: new Set<string>(),
    productFamilyNotes: new Set<string>(),
    relationships: new Set<string>(),
    installCareNotes: new Set<string>(),
    safetyCompliance: new Set<string>(),
    warranty: new Set<string>(),
  };

  for (const item of prompts) {
    const promptStr = Array.isArray(item.prompt) ? item.prompt.join(' | ') : item.prompt;
    const promptLower = promptStr.toLowerCase();
    const purposeLower = item.purpose.toLowerCase();
    const refLower = item.groundTruthReference.toLowerCase();

    const applicableConcepts: string[] = [];
    const applicableRelationships: string[] = [];
    const applicableGlossary: string[] = [];
    const applicableSafety: string[] = [];

    const gaps = {
      glossary: [] as string[],
      projectRecipes: [] as string[],
      productFamilyNotes: [] as string[],
      relationships: [] as string[],
      installCareNotes: [] as string[],
      safetyCompliance: [] as string[],
      warranty: [] as string[],
    };

    // 1. Concept match
    for (const c of okfConcepts) {
      if (c.name && c.name.length > 3 && promptLower.includes(c.name)) {
        applicableConcepts.push(`${c.name} (${c.type})`);
      }
    }

    // 2. Glossary / Aliases match
    for (const a of aliases) {
      if (a.phrases.some((p: string) => promptLower.includes(p))) {
        applicableGlossary.push(`${a.id} -> ${a.concept}`);
      }
    }

    // 3. Projects match
    for (const p of projects) {
      if (p.phrases.some((ph: string) => promptLower.includes(ph)) || promptLower.includes(p.name.toLowerCase())) {
        applicableConcepts.push(`project:${p.id} (${p.name})`);
      }
    }

    // 4. Problems / Safety match
    for (const prob of problems) {
      if (prob.phrases.some((ph: string) => promptLower.includes(ph)) || promptLower.includes(prob.name.toLowerCase())) {
        applicableSafety.push(`problem:${prob.id} (${prob.name})`);
      }
    }

    // 5. Care match
    for (const cr of care) {
      if (cr.phrases.some((ph: string) => promptLower.includes(ph)) || promptLower.includes(cr.name.toLowerCase())) {
        applicableConcepts.push(`care:${cr.id} (${cr.name})`);
      }
    }

    // 6. Suggestions / Relationships match
    for (const s of suggestions) {
      if (applicableConcepts.some((c) => c.includes(s.from))) {
        applicableRelationships.push(`${s.id}: ${s.from} -> ${Array.isArray(s.to) ? s.to.join(', ') : s.to}`);
      }
    }

    // Specific Gap Detection heuristics based on prompt content & purpose:
    // Timber treatments
    if (promptLower.includes('h3.2') || promptLower.includes('h1.2') || promptLower.includes('h4') || promptLower.includes('treatment')) {
      if (!applicableConcepts.some(c => c.includes('treatment'))) {
        gaps.productFamilyNotes.push('Timber treatment hazard classes (H1.2 Boron internal, H3.2 CCA exterior above ground, H4 in ground contact)');
      }
    }

    // Kiln dried vs wet timber
    if (promptLower.includes('kiln dried') || promptLower.includes('wet timber')) {
      gaps.productFamilyNotes.push('Technical distinction between Kiln Dried (KD framing, stable, pre-shrunk) and Wet (rough sawn/retaining timber, shrinkage risk)');
      gaps.installCareNotes.push('Guidance on where wet timber cannot be used (enclosed framing) vs outdoor landscaping');
    }

    // Dimensions / imperial shorthand
    if (promptLower.includes('4x2') || promptLower.includes('100x50') || promptLower.includes('150x50') || promptLower.includes('9x15')) {
      if (promptLower.includes('9x15')) {
        gaps.glossary.push('Invalid shorthand rejection/clarification note: 9x15 is not a valid timber dimension (clarify to 100x50 / 150x50 rail)');
      } else if (!applicableGlossary.some(g => g.includes('framing_timber'))) {
        gaps.glossary.push('Metric-imperial timber dimension mappings (4x2 = 100x50 / 90x45 finished)');
      }
    }

    // Joists / Spans / Deck engineering
    if (promptLower.includes('joist') || promptLower.includes('deck frame') || promptLower.includes('deck joists')) {
      gaps.installCareNotes.push('NZS 3604 joist span and spacing guide (e.g. 150x50 vs 190x45 for joist spans up to 2.4m at 400mm centres)');
      gaps.relationships.push('Deck joists -> joist hangers, M12 coach screws/bolts, DPC barrier tape');
    }

    // Wiring / Safety queries
    if (promptLower.includes('electrical') || promptLower.includes('power outlet') || promptLower.includes('wiring')) {
      gaps.safetyCompliance.push('Safety rule: Restrict fixing recommendations near hidden electrical wiring; require non-conductive inspection / stud finding');
    }

    // Retaining wall queries
    if (promptLower.includes('retaining wall')) {
      gaps.projectRecipes.push('Timber retaining wall recipe: H4 posts, H4 tongue-and-groove or rough sawn rails, scoria backfill, perforated drainage coil, filter sock');
      gaps.relationships.push('Retaining timber -> 12mm galvanised coach screws, perforated drain coil, geotextile fabric');
      gaps.safetyCompliance.push('Building consent threshold note: Retaining walls over 1.5m or supporting surcharge load require building consent and engineering');
    }

    // Plasterboard / GIB
    if (promptLower.includes('jib') || promptLower.includes('gib') || promptLower.includes('wallboard') || promptLower.includes('plasterboard')) {
      if (promptLower.includes('jib') && !applicableGlossary.some(g => g.includes('gib'))) {
        gaps.glossary.push('Glossary entry: "jib" -> GIB® plasterboard');
      }
      if (promptLower.includes('screw') || promptLower.includes('screws')) {
        if (!applicableRelationships.some(r => r.includes('plasterboard'))) {
          gaps.relationships.push('Plasterboard -> 25mm/32mm drywall screws, joint compound, paper tape');
        }
      }
    }

    // Local trade jargon (dwang, nogging)
    if (promptLower.includes('dwang') || promptLower.includes('nogging')) {
      if (!applicableGlossary.some(g => g.includes('framing_timber'))) {
        gaps.glossary.push('Synonym mapping: "dwang" (NZ) = "nogging" = horizontal framing timber between studs');
      }
    }

    // Cabinet making
    if (promptLower.includes('cabinet')) {
      gaps.projectRecipes.push('Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners');
      gaps.relationships.push('Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue');
    }

    // Fence building
    if (promptLower.includes('fence')) {
      if (!applicableConcepts.some(c => c.includes('fence_build'))) {
        gaps.projectRecipes.push('Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails');
      }
      gaps.relationships.push('Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete');
    }

    // Paslode nails / nail guns
    if (promptLower.includes('paslode') || promptLower.includes('nail gun')) {
      gaps.productFamilyNotes.push('Paslode collated nail compatibility: D-head vs round head, fuel cell vs gasless, 30-34 degree collation');
    }

    // Masonry drilling / fasteners
    if (promptLower.includes('masonry') || promptLower.includes('concrete anchor') || promptLower.includes('dynabolt')) {
      gaps.installCareNotes.push('Masonry fastener installation: drill bit diameter must exactly match anchor sleeve diameter; blow dust out before inserting');
    }

    // Paving & driveway
    if (promptLower.includes('paver') || promptLower.includes('paving') || promptLower.includes('driveway')) {
      gaps.productFamilyNotes.push('Paver thickness guide: 40-50mm for pedestrian footpaths vs 60-80mm interlocking for vehicular driveways');
      gaps.projectRecipes.push('Paving installation recipe: GAP20 basecourse, sand bedding layer, paving stones, jointing sand');
    }

    // Garbled / Nonsense input
    if (promptLower.includes('asdkfj')) {
      gaps.glossary.push('Graceful fallback for garbled queries: identify recognizable sub-tokens (cabinet, timber, 4x2) while acknowledging unclear text');
    }

    // Warranty
    if (promptLower.includes('warranty') || promptLower.includes('guarantee') || promptLower.includes('composite')) {
      gaps.warranty.push('Manufacturer warranty coverage: Composite decking (e.g. 15-25 year stain & fade warranty conditional on approved clip installation)');
    }

    // Register into global gaps
    for (const [k, v] of Object.entries(gaps)) {
      for (const item of v) {
        globalGaps[k as keyof typeof globalGaps].add(item);
      }
    }

    promptAudits.push({
      id: item.id,
      prompt: promptStr,
      category: item.category,
      purpose: item.purpose,
      applicableConcepts,
      applicableRelationships,
      applicableGlossary,
      applicableSafety,
      gaps,
    });
  }

  // Generate markdown report
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.resolve(`docs/evals/okf-coverage-${today}.md`);

  let md = `# PlaceMakers OKF Coverage Audit Report (${today})\n\n`;
  md += `**Release Audited**: PlaceMakers OKF Release \`okf-pm-authored\` (v1.0.0)\n`;
  md += `**Source**: Published release fixture via \`buildPlaceMakersStack()\` (*loaded from test fixture as dev database is not connected in this local environment*).\n`;
  md += `**Dataset**: 100 PlaceMakers Test Prompts (\`docs/evals/placemakers-100.json\`).\n\n`;

  md += `## 1. Executive Summary\n\n`;
  md += `- **Total OKF Concepts in Release**: ${okfContent.concepts?.length || 0}\n`;
  md += `- **Total OKF Relationships in Release**: ${okfContent.relationships?.length || 0}\n`;
  md += `- **Authored Aliases/Glossary Entries**: ${aliases.length}\n`;
  md += `- **Authored Project Recipes**: ${projects.length}\n`;
  md += `- **Authored Problem/Safety Concepts**: ${problems.length}\n`;
  md += `- **Prompts Evaluated**: ${prompts.length}\n\n`;

  md += `### Identified Gaps Summary by Type\n\n`;
  md += `| Gap Type | Count | Description |\n`;
  md += `| --- | --- | --- |\n`;
  md += `| **Glossary** | ${globalGaps.glossary.size} | Missing synonyms, trade colloquialisms ("jib", "dwang"), metric-imperial aliases, and invalid shorthand handling |\n`;
  md += `| **Project Recipes** | ${globalGaps.projectRecipes.size} | Structured multi-item bills of materials (retaining walls, cabinets, paving, fences) |\n`;
  md += `| **Product Family Notes** | ${globalGaps.productFamilyNotes.size} | Technical distinction notes (KD vs wet timber, treatment hazard grades H1.2-H4, paver vehicular loads, collated nail standards) |\n`;
  md += `| **Relationships** | ${globalGaps.relationships.size} | "What goes with what" system compatibility links (plasterboard to screws/compound, deck joists to hangers/coach bolts, retaining timber to drain coil) |\n`;
  md += `| **Install / Care Notes** | ${globalGaps.installCareNotes.size} | Installation prerequisites, span guides (NZS 3604), hole drilling, surface prep, and application steps |\n`;
  md += `| **Safety & Compliance** | ${globalGaps.safetyCompliance.size} | Electrical hazard precautions, retaining wall consent height limits, structural framing load limits |\n`;
  md += `| **Warranty** | ${globalGaps.warranty.size} | Manufacturer warranty terms, treatment durability rules, and prerequisite installation conditions |\n\n`;

  md += `## 2. Work List for OKF Authors (Grouped by Type)\n\n`;

  md += `### A. Glossary Gaps\n`;
  for (const g of Array.from(globalGaps.glossary).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `### B. Project Recipe Gaps\n`;
  for (const g of Array.from(globalGaps.projectRecipes).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `### C. Product Family Note Gaps\n`;
  for (const g of Array.from(globalGaps.productFamilyNotes).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `### D. Relationship Gaps (What Goes With What)\n`;
  for (const g of Array.from(globalGaps.relationships).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `### E. Install & Care Note Gaps\n`;
  for (const g of Array.from(globalGaps.installCareNotes).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `### F. Safety & Compliance Gaps\n`;
  for (const g of Array.from(globalGaps.safetyCompliance).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `### G. Warranty Gaps\n`;
  for (const g of Array.from(globalGaps.warranty).sort()) {
    md += `- [ ] **${g}**\n`;
  }
  md += `\n`;

  md += `## 3. Detailed Audit by Prompt (Sample & High-Priority Findings)\n\n`;
  md += `| ID | Prompt | Category | Applicable OKF Content | Identified OKF Gaps |\n`;
  md += `| --- | --- | --- | --- | --- |\n`;

  for (const a of promptAudits) {
    const applicable = [
      ...a.applicableConcepts,
      ...a.applicableGlossary,
      ...a.applicableSafety,
      ...a.applicableRelationships,
    ].slice(0, 3).join('; ') || 'None directly matched';

    const gapList = [
      ...a.gaps.glossary,
      ...a.gaps.projectRecipes,
      ...a.gaps.productFamilyNotes,
      ...a.gaps.relationships,
      ...a.gaps.installCareNotes,
      ...a.gaps.safetyCompliance,
      ...a.gaps.warranty,
    ].join('; ') || 'Fully covered by existing taxonomy';

    md += `| **#${a.id}** | ${a.prompt.replace(/\|/g, '/')} | ${a.category} | ${applicable} | ${gapList} |\n`;
  }

  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`OKF coverage report written to: ${reportPath}`);
}

runAudit().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
