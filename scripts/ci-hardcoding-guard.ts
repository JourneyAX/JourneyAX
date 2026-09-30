/**
 * CI Hardcoding Guard (Architecture Workstream C & JourneyAX Safety)
 *
 * Scans generic runtime directories to detect:
 * 1. Hardcoded tenant names ('placemakers', 'caroma', 'workweargroup', etc.)
 * 2. Fabricated branch identifiers or SKU hash generators
 * 3. Hardcoded pricing/tax numbers (e.g. fixed 0.15 GST without pack/config origin)
 * 4. Business-specific universal tools or vocabulary embedded in platform core
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

// Generic runtime directories to audit
const AUDIT_DIRECTORIES = [
  'apps/journey-runtime-service/src',
  'apps/agent-commerce-service/src',
  'packages/business-pack/src',
  'packages/capability-sdk/src',
  'packages/ui-cards/src',
  'apps/journeyax-web/src/app/api/chat',
];

// Documented narrow allowlist for files that are legitimate adapter bridges or freeze notices
const ALLOWLISTED_FILES = new Set([
  'apps/journey-runtime-service/src/kernel/presentation.port.ts',
  // Frozen legacy compatibility adapters for unmigrated tenants only - scheduled for decommissioning
  'apps/agent-commerce-service/src/legacy/legacy-journey-adapter.ts',
  'apps/agent-commerce-service/src/legacy/project-calculator.service.ts',
]);

// Violation check patterns
const RULES: Array<{
  name: string;
  regex: RegExp;
  reason: string;
  ignoreIf?: (line: string) => boolean;
}> = [
  {
    name: 'Fake SKU/Document/Quote Defaults in Generic Runtime',
    regex: /['"](?:SKU-STD-001|DOC-STD-101|DOC-APP-202|DOC-SPEC-303|caroma-spec-01|PM-MAT-001|PM-FAS-002|item-std-01)['"]/,
    reason: 'Native handlers and generic runtime must not fabricate fallback SKUs, document IDs, or specification IDs.',
    ignoreIf: (line) => line.includes('//') || line.includes('test') || line.includes('/*'),
  },
  {
    name: 'Fixed Branch, Price, Stock, Discount, Product, Provider, or Specification Values',
    regex: /(?:tradeDiscountPct\s*=\s*15\b|totalAmountCents:\s*125000\b|priceCents:\s*(?:4500|15000)\b|branch\s*\|\|\s*['"]Mt Wellington['"]|finish:\s*['"]matte black['"]|spaceType:\s*['"]ensuite['"])/,
    reason: 'Branch names, stock quantities, discounts, and specification values must come from connectors or Business Packs, never hardcoded.',
    ignoreIf: (line) => line.includes('//') || line.includes('test') || line.includes('/*'),
  },
  {
    name: 'Tenant-Specific Generic Bootstrap Configuration',
    regex: /(?:JAX_PLACEMAKERS_MODEL_URL|jax-placemakers-1\.0|gcloud\s+auth\s+print-identity-token)/,
    reason: 'Tenant-specific GPU model URLs, model names, and gcloud CLI auth must not exist in generic application bootstrap.',
    ignoreIf: (line) => line.includes('//') || line.includes('test') || line.includes('/*'),
  },
  {
    name: 'Duplicate Web Runtime Routing',
    regex: /(?:resolveTenantRouting|fetch\([^)]*\/runtime\/(?:turn|chat\/stream)\))/,
    reason: 'Web chat must not duplicate cutover routing or bypass Agent Commerce; all chat must route to Agent Commerce.',
    ignoreIf: (line) => line.includes('//') || line.includes('test') || line.includes('/*'),
  },
  {
    name: 'Missing Turn/Correlation/Idempotency Propagation',
    regex: /(?:turnId:\s*`turn_\${Date\.now\(\)}`|correlationId:\s*`corr_\${Date\.now\(\)}`|idempotencyKey:\s*undefined\b)/,
    reason: 'Turn ID, Correlation ID, and Idempotency Key must not be unconditionally overwritten or dropped; supplied values must be preserved and propagated.',
    ignoreIf: (line) => line.includes('||') || line.includes('??') || line.includes('test') || line.includes('//') || line.includes('/*'),
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
    ignoreIf: (line) => line.includes('isReasoningModel') || line.includes('type ') || line.includes('interface '),
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
    name: 'Hardcoded Tenant Vocabulary in Generic Runtime',
    regex: /\b(?:Caroma|Abercrombie|Workwear\s+Group|PlaceMakers)\b/,
    reason: 'Tenant names and vocabulary must not appear in generic runtime source code.',
    ignoreIf: (line) => line.includes('@deprecated') || line.includes('title:'),
  },
];

function stripComments(line: string): string {
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

      // Ignore tests, eval suites, legacy boundary, and allowlisted files
      if (
        entry.name.endsWith('.spec.ts') ||
        entry.name.endsWith('.test.ts') ||
        relPath.includes('/test/') ||
        relPath.includes('/eval/') ||
        relPath.includes('/legacy/') ||
        relPath.includes('/fixtures/')
      ) {
        continue;
      }
      if (ALLOWLISTED_FILES.has(relPath)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      lines.forEach((lineText, idx) => {
        const trimmed = lineText.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          return;
        }

        // Accurately strip comments without treating URLs containing http:// or https:// as comments
        const codeOnly = stripComments(lineText);
        if (!codeOnly) {
          return;
        }

        for (const rule of RULES) {
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
      failedCases.push(`Expected violation but passed: "${snippet}"`);
    }
  }

  for (const snippet of negativeSnippets) {
    const matched = currencyRule.regex.test(snippet) && (!currencyRule.ignoreIf || !currencyRule.ignoreIf(snippet));
    if (matched) {
      failedCases.push(`Expected pass but flagged violation: "${snippet}"`);
    }
  }

  if (failedCases.length > 0) {
    console.error('❌ Guard Self-Test FAILED on cases:');
    failedCases.forEach((c) => console.error(`   - ${c}`));
    return { ok: false, failedCases };
  }

  console.log('✅ Guard Self-Test PASSED: All forbidden currency fallbacks and legitimate patterns correctly verified.\n');
  return { ok: true, failedCases: [] };
}

export function runCiHardcodingGuard(workspaceRoot: string): { ok: boolean; violations: Violation[] } {
  console.log('🛡️  Running CI Hardcoding Guard across generic runtime directories...\n');

  const selfTest = runGuardSelfTest();
  if (!selfTest.ok) {
    return { ok: false, violations: [] };
  }

  const allViolations: Violation[] = [];

  for (const auditDir of AUDIT_DIRECTORIES) {
    const dirAbs = path.join(workspaceRoot, auditDir);
    console.log(`  🔍 Scanning ${auditDir}...`);
    const violations = scanDirectory(dirAbs, workspaceRoot);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log('\n✅ PASS: No unauthorized hardcoding or fail-open fallbacks detected in generic runtime.');
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
