/**
 * CI Hardcoding Guard (Architecture Workstream C & JourneyAX Safety)
 *
 * Scans generic runtime directories to detect:
 * 1. Hardcoded tenant names ('placemakers', 'caroma', 'workweargroup', etc.)
 * 2. Fabricated branch identifiers or SKU hash generators
 * 3. Hardcoded pricing/tax numbers (e.g. fixed 0.15 GST without pack/config origin)
 * 4. Business-specific universal tools or vocabulary embedded in platform core
 * 5. Forbidden industry terms & attribute names from scripts/guard-config.json
 * 6. Array or set literals for word lists, units, or synonyms embedded in source code
 *
 * Uses a strict, narrow, documented allowlist for:
 * - Test specs (*.spec.ts, test/**)
 * - Test packs & JSON fixtures (packs/**, fixtures/**)
 * - Migration & audit scripts (scripts/**)
 * - Architectural freeze/migration documentation comments
 */

import * as fs from 'fs';
import * as path from 'path';

interface Violation {
  file: string;
  line: number;
  patternName: string;
  snippet: string;
  reason: string;
}

export interface GuardConfig {
  forbiddenIndustryTerms: string[];
  forbiddenAttributeNames: string[];
}

export function loadGuardConfig(workspaceRoot: string): GuardConfig {
  const configPath = path.join(workspaceRoot, 'scripts/guard-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Guard config not found at: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const GUARD_CONFIG = loadGuardConfig(path.resolve(__dirname, '..'));

// Discover all platform source directories under apps/*/src and packages/*/src
export function getPlatformSourceDirectories(workspaceRoot: string): string[] {
  const platformDirs: string[] = [];
  const excludedPackages = new Set([
    'packages/test-support',
    'packages/pack-eval',
    'packages/ingestion',
    'packages/integration',
    'packages/activepieces-piece-journeyax',
    'apps/product-service',
    'apps/backoffice-admin',
  ]);

  for (const base of ['apps', 'packages']) {
    const basePath = path.join(workspaceRoot, base);
    if (!fs.existsSync(basePath)) continue;
    for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const relPackage = `${base}/${entry.name}`;
        if (excludedPackages.has(relPackage)) continue;
        const srcPath = path.join(basePath, entry.name, 'src');
        if (fs.existsSync(srcPath)) {
          if (relPackage === 'apps/journeyax-web') {
            platformDirs.push('apps/journeyax-web/src/app/api/chat');
          } else {
            platformDirs.push(path.relative(workspaceRoot, srcPath).replace(/\\/g, '/'));
          }
        }
      }
    }
  }
  return platformDirs.sort();
}

// Documented narrow allowlist for files that are legitimate adapter bridges or freeze notices
const ALLOWLISTED_FILES = new Set([
  'apps/journey-runtime-service/src/kernel/presentation.port.ts',
  // Dev-only localhost defaults, rejected in production by validateProductionTargets().
  'apps/api-gateway/src/gateway.registry.ts',
  // Frozen legacy compatibility adapters for unmigrated tenants only - scheduled for decommissioning
  'apps/agent-commerce-service/src/legacy/legacy-journey-adapter.ts',
  'apps/agent-commerce-service/src/legacy/project-calculator.service.ts',
]);

// Violation check patterns
export const RULES: Array<{
  name: string;
  regex: RegExp;
  reason: string;
  ignoreIf?: (line: string) => boolean;
  matchFile?: (relPath: string) => boolean;
}> = [
  {
    name: 'Fake SKU/Document/Quote Defaults in Generic Runtime',
    regex: /['"](?:SKU-STD-001|DOC-STD-101|DOC-APP-202|DOC-SPEC-303|caroma-spec-01|PM-MAT-001|PM-FAS-002|item-std-01)['"]/,
    reason: 'Native handlers and generic runtime must not fabricate fallback SKUs, document IDs, or specification IDs.',
    ignoreIf: (line) => line.includes('test'),
  },
  {
    name: 'Fixed Branch, Price, Stock, Discount, Product, Provider, or Specification Values',
    regex: /(?:tradeDiscountPct\s*=\s*15\b|totalAmountCents:\s*125000\b|priceCents:\s*(?:4500|15000)\b|branch\s*\|\|\s*['"]Mt Wellington['"]|finish:\s*['"]matte black['"]|spaceType:\s*['"]ensuite['"])/,
    reason: 'Branch names, stock quantities, discounts, and specification values must come from connectors or Business Packs, never hardcoded.',
    ignoreIf: (line) => line.includes('test'),
  },
  {
    name: 'Tenant-Specific Generic Bootstrap Configuration',
    regex: /(?:JAX_PLACEMAKERS_MODEL_URL|jax-placemakers-1\.0|gcloud\s+auth\s+print-identity-token)/,
    reason: 'Tenant-specific GPU model URLs, model names, and gcloud CLI auth must not exist in generic application bootstrap.',
    ignoreIf: (line) => line.includes('test'),
  },
  {
    name: 'Duplicate Web Runtime Routing',
    regex: /(?:resolveTenantRouting|fetch\([^)]*\/runtime\/(?:turn|chat\/stream)\))/,
    reason: 'Web chat must not duplicate cutover routing or bypass Agent Commerce; all chat must route to Agent Commerce.',
    ignoreIf: (line) => line.includes('test'),
  },
  {
    name: 'Missing Turn/Correlation/Idempotency Propagation',
    regex: /(?:turnId:\s*`turn_\${Date\.now\(\)}`|correlationId:\s*`corr_\${Date\.now\(\)}`|idempotencyKey:\s*undefined\b)/,
    reason: 'Turn ID, Correlation ID, and Idempotency Key must not be unconditionally overwritten or dropped; supplied values must be preserved and propagated.',
    ignoreIf: (line) => line.includes('||') || line.includes('??') || line.includes('test'),
  },
  {
    name: 'Tenant-Named Provider Aliases',
    regex: /['"](?:jax-placemakers|placemaker|placemaker-gemma)['"]/,
    reason: 'Generic runtime must not reference tenant-specific provider aliases.',
  },
  {
    name: 'Model Environment Variables in Generic Code',
    regex: /\b(?:JAX_PLACEMAKERS_MODEL_URL|PLACEMAKER_MODEL_URL|PLACEMAKER_MODEL_TOKEN)\b/,
    reason: 'Tenant-specific model environment variables must not exist in generic provider code.',
  },
  {
    name: 'Fixed Fallback Credentials in Generic Code',
    regex: /['"](?:journeyax-l4-gpu|unconfigured-platform-key)['"]/,
    reason: 'Generic runtime must not contain hardcoded fixed fallback credentials.',
  },
  {
    name: 'Undeclared Cross-Provider Fallback',
    regex: /(?:falling back to OpenAI|getChatClient\(\s*['"]openai['"]\s*\))/,
    reason: 'Implicit cross-provider fallback to OpenAI is prohibited; fallback must be explicitly declared in model policy.',
  },
  {
    name: 'Hardcoded SKU Hash Generator',
    regex: /(?:hash\s*<<\s*5|charCodeAt\(i\)\s*;\s*hash\s*\|=\s*0)/,
    reason: 'Stock must NEVER be derived from SKU hash; use tenant-scoped inventory connector.',
  },
  {
    name: 'Hardcoded PlaceMakers Branches in Generic Runtime',
    regex: /\b(MT_WELLINGTON|COOK_ST|TE_RAPA|RICCARTON)\b/,
    reason: 'Branch list must be fetched from inventory connector, not hardcoded.',
  },
  {
    name: 'Hardcoded Fixed Tax Rate Fallback',
    regex: /taxRate:\s*0\.15\b/,
    reason: 'Tax rates must be server-authoritative from project config or pack pricing.',
    ignoreIf: (line) => line.includes('pricing ||'),
  },
  {
    name: 'Hardcoded Tenant Matching Logic in Generic Routing',
    regex: /(?:tenantId|projectId)\s*===\s*['"](placemakers|caroma|momentec|abercrombie|augusta|royalcyber)['"]/i,
    reason: 'Generic runtime must never branch on hardcoded tenant names.',
  },
  {
    name: 'Positional [0] Selection Fallbacks',
    regex: /(?:journeys|agents|policies|candidates|stages)\[0\]/,
    reason: 'Positional [0] selection is forbidden; resolve explicitly from pack or fail closed.',
    ignoreIf: (line) => line.includes('.length === 1') || line.includes('single-agent') || line.includes('single-journey') || line.includes('topCandidates[0]'),
  },
  {
    name: 'Fabricated Inventory or Fulfilment Claims',
    regex: /['"](?:Ready in 2 hours for collection|Transfer from DC|In Stock|Order Needed)['"]/,
    reason: 'Inventory statuses and pickup timeframes must come from the live connector, not hardcoded strings in generic runtime.',
    ignoreIf: (line) => line.includes('status:') || line.includes('type ') || line.includes('interface '),
  },
  {
    name: 'Hardcoded Material Defaults in Generic Runtime',
    regex: /\b(Kwila|GIB Aqualine|GIB Standard)\b/i,
    reason: 'Materials and building elements must be configured via Business Pack or connector, never hardcoded in generic runtime.',
  },
  {
    name: 'Hardcoded Currency Fallback in Generic Runtime',
    regex: /(?:currency\s*(?:\|\||\?\?|=)\s*['"](AUD|NZD|USD|EUR|GBP|CAD)['"]|currency:\s*['"](AUD|NZD|USD|EUR|GBP|CAD)['"]|currency\s*:\s*string\s*=\s*['"](AUD|NZD|USD|EUR|GBP|CAD)['"])/i,
    reason: 'Currency must come from project pricing, Business Pack, or live connector, never hardcoded.',
  },
  {
    name: 'Hardcoded AI Model Name in Generic Runtime',
    regex: /['"](?:gpt-4o|gpt-4o-mini|claude-3|claude-3-5|gemini-1\.5)['"]/,
    reason: 'Model names must be configured in Business Pack model-policy or projectConfig, never hardcoded in generic runtime.',
    ignoreIf: (line) =>
      line.includes('isReasoningModel') ||
      line.includes('type ') ||
      line.includes('interface ') ||
      line.includes('promptPerM') ||
      line.includes('completionPerM') ||
      line.includes('MODEL_PRICING'),
  },
  {
    name: 'Hardcoded Business Intent in Generic Runtime',
    regex: /['"](?:bathroom_remodel|leak_repair|decking_build|deck_building|timber_order|fashion_sizing)['"]/,
    reason: 'Business intents must be defined in Business Pack journey graph or loaded dynamically, never hardcoded in generic runtime.',
  },
  {
    name: 'Hardcoded Fallback Room Type in Generic Runtime',
    regex: /(?:effectiveRoomType\s*\|\|\s*['"]bathroom['"]|roomType:\s*['"]bathroom['"])/,
    reason: 'Room type must be supplied by caller or configured in pack; fallback defaults are prohibited.',
  },
  {
    name: 'Hardcoded Clarifying Question Text in Generic Runtime',
    regex: /['"](?:Who are you shopping for\?|What's the occasion\?|Which room are you working on\?)['"]/,
    reason: 'Clarification questions and option choices must come from published Business Pack, never hardcoded in generic runtime.',
  },
  {
    name: 'Fact Meaning Guessed From Key Spelling',
    regex: /\.includes\(\s*['"](?:size|dimension|budget|quantity)['"]\s*\)|(?:Key|key|slotKey|factKey)\s*===\s*['"](?:budget|quantity)['"]/,
    reason: 'What a fact means must come from the pack (fact role / entity type), not from how its key is spelled.',
  },
  {
    name: 'Invented Human Identity',
    regex: /\|\|\s*['"](?:studio|internal-service|authenticated-user|operator|system)['"]/,
    reason: 'Actors must be authenticated principals or explicitly namespaced system/service principals, never invented human-looking identities.',
  },
  {
    name: 'Localhost Service Fallback in Platform Code',
    regex: /\|\|\s*['"]https?:\/\/(?:localhost|127\.0\.0\.1)/,
    reason: 'Service endpoints must resolve through resolveServiceUrl (development-only fallback, fail fast in production).',
  },
  {
    name: 'Assumed Currency Symbol',
    regex: /`\$\$\{/,
    reason: 'Prices must be formatted from the declared currency (Intl), never with an assumed dollar sign.',
  },
  {
    name: 'Hardcoded Tenant Vocabulary in Generic Runtime',
    regex: /\b(?:Caroma|Abercrombie|Workwear\s+Group|PlaceMakers)\b/,
    reason: 'Tenant names and vocabulary must not appear in generic runtime source code.',
    ignoreIf: (line) => line.includes('@deprecated') || line.includes('title:'),
  },
  {
    name: 'Hardcoded Forbidden Industry Terms in Platform Source',
    regex: new RegExp(`\\b(?:${GUARD_CONFIG.forbiddenIndustryTerms.join('|')})\\b`, 'i'),
    reason: `Industry words (${GUARD_CONFIG.forbiddenIndustryTerms.join(', ')}) must not appear in platform source; wording must be neutral and capability mappings must come from pack bindings.`,
    matchFile: (relPath) => !relPath.startsWith('apps/agent-commerce-service/'),
    ignoreIf: (line) =>
      line.includes('trade-quote-create') ||
      line.includes('tradeQuote') ||
      line.includes('TradeQuote') ||
      line.includes('multi-trade-bom') ||
      line.includes('registerNativeHandler') ||
      line.toLowerCase().includes('installtype') ||
      line.toLowerCase().includes('spaceplanner') ||
      line.includes('primaryDimension') ||
      line.includes('trade-dispatch') ||
      line.includes('b2b-trade') ||
      line.includes('QuoteCreateHandler'),
  },
  {
    name: 'Hardcoded Product Attribute Names in Platform Source',
    regex: new RegExp(`\\b(?:${GUARD_CONFIG.forbiddenAttributeNames.join('|')})\\b`, 'i'),
    reason: `Product attribute names (${GUARD_CONFIG.forbiddenAttributeNames.join(', ')}) must come from Business Pack attribute definitions, never hardcoded in platform code.`,
    matchFile: (relPath) => !relPath.startsWith('apps/agent-commerce-service/'),
  },
  {
    name: 'Hardcoded Word List, Unit, or Synonym Literals in Platform Source',
    regex: /(?:\[\s*['"](?:mm|cm|m|km|inch|inches|ft|feet|yd|m2|sqm|m3|kg|g|lbs|oz)['"]\s*,\s*['"](?:mm|cm|m|km|inch|inches|ft|feet|yd|m2|sqm|m3|kg|g|lbs|oz)['"]|new\s+Set\(\s*\[\s*['"](?:mm|cm|m|km|inch|inches|ft|feet|yd|m2|sqm|m3|kg|g|lbs|oz)['"]|\b(?:synonyms?|units?|wordList|aliases|equivalents?|domainTerms?|industryTerms?|termList)\s*[:=]\s*(?:\[\s*['"][^'"]+['"]\s*,|new\s+Set\())/i,
    reason: 'Word lists, unit tables, and synonyms must be configured in Business Pack data, not hardcoded in platform code.',
  },
];

export function isWholeLineComment(lineText: string): boolean {
  const trimmed = lineText.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#') ||
    trimmed.endsWith('*/')
  );
}

export function stripComments(line: string): string {
  // Strip block comments /* ... */
  let s = line.replace(/\/\*.*?\*\//g, '');
  // Match single-line comments // only when NOT preceded by : (to avoid stripping http:// and https:// URLs)
  const commentIdx = s.search(/(?<!:)\/\//);
  if (commentIdx !== -1) {
    s = s.slice(0, commentIdx);
  }
  return s.trim();
}

function scanDirectory(dirPath: string, rootDir: string): Violation[] {
  const violations: Violation[] = [];
  if (!fs.existsSync(dirPath)) return violations;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }
      violations.push(...scanDirectory(fullPath, rootDir));
    } else if (entry.isFile()) {
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx') && !entry.name.endsWith('.js')) {
        continue;
      }

      // Ignore tests, eval suites, legacy boundary, fixtures, and allowlisted files
      if (
        entry.name.endsWith('.spec.ts') ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.spec.tsx') ||
        entry.name.endsWith('.test.tsx') ||
        relPath.includes('/test/') ||
        relPath.includes('/tests/') ||
        relPath.includes('/eval/') ||
        relPath.includes('/legacy/') ||
        relPath.includes('/fixtures/') ||
        relPath.includes('/test-support/') ||
        relPath.includes('/pack-eval/')
      ) {
        continue;
      }
      if (ALLOWLISTED_FILES.has(relPath)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      lines.forEach((lineText, idx) => {
        // Skip only whole-line comments; lines with real code and trailing comments will be evaluated
        if (isWholeLineComment(lineText)) {
          return;
        }

        // Accurately strip trailing/inline comments without treating URLs containing http:// or https:// as comments
        const codeOnly = stripComments(lineText);
        if (!codeOnly) {
          return;
        }

        for (const rule of RULES) {
          if (rule.matchFile && !rule.matchFile(relPath)) {
            continue;
          }
          if (rule.regex.test(codeOnly)) {
            if (rule.ignoreIf && rule.ignoreIf(codeOnly)) {
              continue;
            }
            violations.push({
              file: relPath,
              line: idx + 1,
              patternName: rule.name,
              snippet: codeOnly.slice(0, 100),
              reason: rule.reason,
            });
          }
        }
      });
    }
  }

  return violations;
}

export function runGuardSelfTest(): { ok: boolean; failedCases: string[] } {
  const currencyRule = RULES.find((r) => r.name === 'Hardcoded Currency Fallback in Generic Runtime');
  if (!currencyRule) {
    throw new Error('Hardcoded Currency Fallback rule not found for self-test');
  }

  const positiveSnippets = [
    `const c = currency || 'NZD';`,
    `const c = currency || 'USD';`,
    `const c = input.currency || 'NZD';`,
    `const c = pricing.currency || 'AUD';`,
    `const c = currency ?? 'NZD';`,
    `const c = currency ?? 'USD';`,
    `function foo(currency = 'USD') {}`,
    `function foo(currency: string = 'NZD') {}`,
    `const obj = { currency: 'USD' };`,
    `const obj = { currency: 'NZD' };`,
    `const obj = { currency: "AUD" };`,
    `function bar(currency = "EUR") {}`,
  ];

  const negativeSnippets = [
    `const c = currency || pack.pricing?.currency;`,
    `const c = input.currency ? input.currency.toUpperCase() : undefined;`,
    `const c = pricing.currency;`,
    `const obj = { currency: resolvedCurrency };`,
    `const obj = { currency: authoritativeCurrency };`,
    `const obj = { currency: doc.currency || doc.price?.currency };`,
  ];

  const failedCases: string[] = [];

  for (const snippet of positiveSnippets) {
    const matched = currencyRule.regex.test(snippet) && (!currencyRule.ignoreIf || !currencyRule.ignoreIf(snippet));
    if (!matched) {
      failedCases.push(`Expected currency violation but passed: "${snippet}"`);
    }
  }

  for (const snippet of negativeSnippets) {
    const matched = currencyRule.regex.test(snippet) && (!currencyRule.ignoreIf || !currencyRule.ignoreIf(snippet));
    if (matched) {
      failedCases.push(`Expected pass but flagged currency violation: "${snippet}"`);
    }
  }

  // Self-test: Config-driven Forbidden Industry Terms
  const industryRule = RULES.find((r) => r.name === 'Hardcoded Forbidden Industry Terms in Platform Source');
  if (industryRule) {
    const positiveIndustrySnippets = [
      `const prompt = 'trade specialist';`,
      `const type = 'decking boards';`,
      `const product = 'plasterboard lining';`,
      `const fixture = 'bathroom tapware';`,
      `const item = 'oversized hoodie';`,
      `const shirt = 'graphic tee';`,
      `const fabric = 'fleece jacket';`,
      `const hardware = 'deck fasteners';`,
      `const lumber = 'treated timber';`,
      `const fixing = 'metal screw';`,
    ];
    for (const snippet of positiveIndustrySnippets) {
      const matched = industryRule.regex.test(snippet) && (!industryRule.ignoreIf || !industryRule.ignoreIf(snippet));
      if (!matched) {
        failedCases.push(`Expected industry violation but passed: "${snippet}"`);
      }
    }
    const negativeIndustrySnippets = [
      `const prompt = 'quote specialist';`,
      `const type = 'flooring materials';`,
      `const product = 'wall lining';`,
      `const fixture = 'bathroom items';`,
    ];
    for (const snippet of negativeIndustrySnippets) {
      const matched = industryRule.regex.test(snippet) && (!industryRule.ignoreIf || !industryRule.ignoreIf(snippet));
      if (matched) {
        failedCases.push(`Expected pass but flagged industry violation: "${snippet}"`);
      }
    }
  } else {
    failedCases.push('Hardcoded Forbidden Industry Terms rule not found for self-test');
  }

  // Self-test: Config-driven Forbidden Product Attribute Names
  const attributeRule = RULES.find((r) => r.name === 'Hardcoded Product Attribute Names in Platform Source');
  if (attributeRule) {
    const positiveAttributeSnippets = [
      `const attr = 'treatment';`,
      `const a = 'rValue';`,
      `input.treatment = 'H3.2';`,
      `const spec = { rValue: 'R2.6' };`,
    ];
    for (const snippet of positiveAttributeSnippets) {
      const matched = attributeRule.regex.test(snippet) && (!attributeRule.ignoreIf || !attributeRule.ignoreIf(snippet));
      if (!matched) {
        failedCases.push(`Expected attribute violation but passed: "${snippet}"`);
      }
    }
    const negativeAttributeSnippets = [
      `const attr = 'category';`,
      `const a = 'attributes';`,
      `input.attributes = {};`,
    ];
    for (const snippet of negativeAttributeSnippets) {
      const matched = attributeRule.regex.test(snippet) && (!attributeRule.ignoreIf || !attributeRule.ignoreIf(snippet));
      if (matched) {
        failedCases.push(`Expected pass but flagged attribute violation: "${snippet}"`);
      }
    }
  } else {
    failedCases.push('Hardcoded Product Attribute Names rule not found for self-test');
  }

  // Self-test: Hardcoded Word List, Unit, or Synonym Literals
  const wordListRule = RULES.find((r) => r.name === 'Hardcoded Word List, Unit, or Synonym Literals in Platform Source');
  if (wordListRule) {
    const positiveWordListSnippets = [
      `const units = ['mm', 'cm', 'm'];`,
      `const u = ['kg', 'g', 'lbs'];`,
      `const unitSet = new Set(['mm', 'cm', 'm']);`,
      `const synonyms = ['timber', 'lumber'];`,
      `const wordList = ['board', 'plank'];`,
      `const aliases = ['sheet', 'panel'];`,
      `const equivalents = ['4x2', '100x50'];`,
    ];
    for (const snippet of positiveWordListSnippets) {
      const matched = wordListRule.regex.test(snippet) && (!wordListRule.ignoreIf || !wordListRule.ignoreIf(snippet));
      if (!matched) {
        failedCases.push(`Expected wordlist/unit violation but passed: "${snippet}"`);
      }
    }
    const negativeWordListSnippets = [
      `const stages = ['intro', 'clarify', 'products'];`,
      `const ids = [1, 2, 3];`,
      `const flags = ['active', 'pending'];`,
    ];
    for (const snippet of negativeWordListSnippets) {
      const matched = wordListRule.regex.test(snippet) && (!wordListRule.ignoreIf || !wordListRule.ignoreIf(snippet));
      if (matched) {
        failedCases.push(`Expected pass but flagged wordlist/unit violation: "${snippet}"`);
      }
    }
  } else {
    failedCases.push('Hardcoded Word List, Unit, or Synonym Literals rule not found for self-test');
  }

  // Self-test: Whole-line comments vs trailing comments handling
  const wholeLineComments = [
    `// const fixture = 'tapware';`,
    `/* const p = 'decking'; */`,
    ` * const mat = 'plasterboard';`,
  ];
  for (const line of wholeLineComments) {
    if (!isWholeLineComment(line)) {
      failedCases.push(`Expected whole-line comment to be detected: "${line}"`);
    }
  }

  const trailingCommentLine = `const fixture = 'tapware'; // trailing comment`;
  if (isWholeLineComment(trailingCommentLine)) {
    failedCases.push(`Expected code with trailing comment NOT to be treated as whole-line comment: "${trailingCommentLine}"`);
  }
  const strippedCode = stripComments(trailingCommentLine);
  if (!industryRule?.regex.test(strippedCode)) {
    failedCases.push(`Expected stripped code from trailing comment line to trigger violation: "${strippedCode}"`);
  }

  const neutralCodeWithCommentDomain = `const item = 'neutral'; // mentions decking in comment`;
  if (isWholeLineComment(neutralCodeWithCommentDomain)) {
    failedCases.push(`Expected line NOT to be whole-line comment: "${neutralCodeWithCommentDomain}"`);
  }
  const strippedNeutral = stripComments(neutralCodeWithCommentDomain);
  if (industryRule?.regex.test(strippedNeutral)) {
    failedCases.push(`Expected stripped comment to eliminate domain word: "${strippedNeutral}"`);
  }

  if (failedCases.length > 0) {
    console.error('❌ Guard Self-Test FAILED on cases:');
    failedCases.forEach((c) => console.error(`   - ${c}`));
    return { ok: false, failedCases };
  }

  console.log('✅ Guard Self-Test PASSED: All forbidden terms, attribute names, unit/wordlist literals, and comment skipping rules correctly verified.\n');
  return { ok: true, failedCases: [] };
}

export function runCiHardcodingGuard(workspaceRoot: string): { ok: boolean; violations: Violation[] } {
  console.log('🛡️  Running CI Hardcoding Guard across generic runtime directories...\n');

  const selfTest = runGuardSelfTest();
  if (!selfTest.ok) {
    return { ok: false, violations: [] };
  }

  const allViolations: Violation[] = [];
  const auditDirs = getPlatformSourceDirectories(workspaceRoot);

  for (const auditDir of auditDirs) {
    const dirAbs = path.join(workspaceRoot, auditDir);
    console.log(`  🔍 Scanning ${auditDir}...`);
    const violations = scanDirectory(dirAbs, workspaceRoot);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(`\n✅ PASS: No unauthorized hardcoding or fail-open fallbacks detected across ${auditDirs.length} platform source directories.`);
    return { ok: true, violations: [] };
  } else {
    console.error(`\n❌ FAIL: Detected ${allViolations.length} hardcoding violation(s):`);
    for (const v of allViolations) {
      console.error(`  - [${v.patternName}] ${v.file}:${v.line}`);
      console.error(`    Code: "${v.snippet}"`);
      console.error(`    Reason: ${v.reason}\n`);
    }
    return { ok: false, violations: allViolations };
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const result = runCiHardcodingGuard(root);
  if (!result.ok) {
    process.exit(1);
  }
}
