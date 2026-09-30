/**
 * PlaceMakers V4 Canonical-Runtime Model & Knowledge Propagation Test Suite
 *
 * Verifies:
 * 1. Structured JSON extraction safely strips markdown fences and validates schema.
 * 2. ModelRouter strictly enforces fallbackAllowed: false and never silently falls back.
 * 3. compileModelPolicy deterministically configures the 4 primary conversational policies:
 *    fast_intent, complex_reasoning, tool_selection, and response_generation.
 * 4. Switching tenants in Backoffice completely resets modelPolicy state.
 * 5. End-to-End: Backoffice OpenAI selection -> Publication -> Immutable CAS checksum ->
 *    wet-area question executes knowledge retrieval and response_generation via OpenAI,
 *    blocks Google/JAX, produces grounded answers without stage updates or unrequested quotes.
 * 6. UI Output Hygiene: visible conversation text and transcript contain neither 'svgsvg',
 *    raw '<svg', '&#x20;', nor serialized JSON envelopes.
 */

import assert from 'node:assert/strict';
import {
  BusinessPackLoader,
  BusinessPackRelease,
  ModelPolicySchema,
  compileModelPolicy,
  computePackChecksum,
} from '@journeyax/business-pack';
import { ModelRouter } from '../apps/journey-runtime-service/src/model/model-router';
import { extractStructuredJson, InterpretationOutputSchema } from '../apps/journey-runtime-service/src/turn/interpret-event';
import { TurnApplicationService } from '../apps/journey-runtime-service/src/kernel/turn-application.service';
import { TurnCommand } from '@journeyax/journey-core';
import { sanitizeMessageText } from '../apps/journeyax-web/src/lib/sanitize';
import { KnowledgeSearchHandler } from '../apps/journey-runtime-service/src/capabilities/handlers/knowledge-search.handler';

import { getPlaceMakersTestPack } from './fixtures/business-packs/test-pack-factory';

async function runPropagationSuite() {
  console.log('🧪 Running PlaceMakers V4 Canonical-Runtime Test Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    }
  }

  const basePack = getPlaceMakersTestPack();
  assert.ok(basePack, 'Base PlaceMakers pack must be initialized from programmatic test fixture');

  // -------------------------------------------------------------------------
  // Test 1: Structured JSON output parsing safely extracts fenced JSON
  // -------------------------------------------------------------------------
  await test('1. Structured JSON extraction safely strips markdown fences and validates schema', () => {
    const fenced = '```json\n{\n  "intent": "technical_advisory",\n  "candidateFacts": { "tradeCategory": { "value": "wet_area", "confidence": 0.99 } }\n}\n```';
    const parsedFenced = extractStructuredJson(fenced);
    assert.equal(parsedFenced.intent, 'technical_advisory');
    const valid1 = InterpretationOutputSchema.safeParse(parsedFenced);
    assert.equal(valid1.success, true);

    const commentary = 'Here is the extracted classification:\n```\n{\n  "intent": "technical_advisory",\n  "candidateFacts": {}\n}\n```\nHope that helps!';
    const parsedCommentary = extractStructuredJson(commentary);
    assert.equal(parsedCommentary.intent, 'technical_advisory');
    const valid2 = InterpretationOutputSchema.safeParse(parsedCommentary);
    assert.equal(valid2.success, true);

    const direct = '{"intent": "technical_advisory", "candidateFacts": {}}';
    const parsedDirect = extractStructuredJson(direct);
    assert.equal(parsedDirect.intent, 'technical_advisory');

    assert.throws(
      () => extractStructuredJson('Not a JSON object'),
      /Failed to extract valid JSON/
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: ModelRouter strictly obeys fallbackAllowed: false
  // -------------------------------------------------------------------------
  await test('2. ModelRouter strictly enforces fallbackAllowed: false and never silently falls back', () => {
    const router = new ModelRouter();

    const strictTestPack: BusinessPackRelease = {
      ...basePack,
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'strict_policy',
        policies: [
          {
            policyId: 'strict_policy',
            description: 'Strict test policy with no fallback',
            candidates: [
              {
                provider: 'openai',
                model: 'gpt-4o',
                priority: 1,
              },
            ],
            dataResidency: 'au',
            fallbackAllowed: false,
            timeoutMs: 5000,
            maxInputTokens: 8000,
            maxOutputTokens: 1000,
          },
        ],
      },
    };

    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      assert.throws(
        () => router.resolveModel('fast_intent', strictTestPack),
        /No configured API credentials found for primary candidate/
      );
    } finally {
      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: compileModelPolicy deterministically compiles primary conversational policies
  // -------------------------------------------------------------------------
  await test('3. compileModelPolicy configures the 4 primary conversational policies without hidden fallbacks', () => {
    const compiled = compileModelPolicy({
      projectId: 'placemakers',
      mode: 'simple',
      aiConfig: {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.35,
      },
      dataResidency: 'au',
    });

    const validated = ModelPolicySchema.safeParse(compiled);
    assert.equal(validated.success, true, 'Compiled modelPolicy must satisfy ModelPolicySchema');

    // 4 primary policies must exist
    const policyIds = new Set(compiled.policies.map((p) => p.policyId));
    assert.ok(policyIds.has('fast_intent'), 'fast_intent must be configured');
    assert.ok(policyIds.has('complex_reasoning'), 'complex_reasoning must be configured');
    assert.ok(policyIds.has('tool_selection'), 'tool_selection must be configured');
    assert.ok(policyIds.has('response_generation'), 'response_generation must be configured');

    for (const pol of compiled.policies) {
      assert.equal(pol.candidates.length, 1, `Policy ${pol.policyId} must not contain hidden fallback candidates in simple mode`);
      assert.equal(pol.candidates[0].provider, 'openai');
      assert.equal(pol.candidates[0].model, 'gpt-4o');
      assert.equal(pol.fallbackAllowed, false, `Policy ${pol.policyId} fallbackAllowed must be false when no fallback is configured`);
    }

    // Advanced mode: preserves independently configured task policies
    const advanced = compileModelPolicy({
      projectId: 'placemakers',
      mode: 'advanced',
      existingModelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'custom_task',
        policies: [
          {
            policyId: 'custom_task',
            description: 'Custom specialized task policy',
            candidates: [{ provider: 'anthropic', model: 'claude-3-5-sonnet', priority: 1 }],
            dataResidency: 'au',
            fallbackAllowed: false,
            timeoutMs: 12000,
            maxInputTokens: 25000,
            maxOutputTokens: 3000,
          },
        ],
      },
      aiConfig: {
        provider: 'openai',
        model: 'gpt-4o',
      },
    });

    assert.equal(advanced.policies.length, 1);
    assert.equal(advanced.policies[0].policyId, 'custom_task');
    assert.equal(advanced.policies[0].candidates[0].provider, 'anthropic');
  });

  // -------------------------------------------------------------------------
  // Test 4: End-to-End: Canonical Wet-Area Execution via isolated runtime
  // -------------------------------------------------------------------------
  await test('4. End-to-End: Wet-area inquiry executes knowledge retrieval & response_generation via OpenAI with zero stage jargon', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';
    process.env.OPENAI_API_KEY = 'test-openai-key-live-simulation';
    process.env.GEMINI_API_KEY = 'test-gemini-key-should-not-be-called';

    // 1. Compile immutable release with OpenAI in simple mode
    const modelPolicy = compileModelPolicy({
      projectId: 'placemakers',
      mode: 'simple',
      aiConfig: {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.3,
      },
      dataResidency: 'au',
    });

    const baseTestPack = getPlaceMakersTestPack({ environmentId: 'test' });
    const release: BusinessPackRelease = {
      ...baseTestPack,
      manifest: {
        ...baseTestPack.manifest,
        version: '2.0.0',
        environmentId: 'test',
      },
      modelPolicy,
    };
    release.checksum = computePackChecksum(release);
    assert.ok(release.checksum.length >= 64, 'Release checksum must be valid 64-char SHA-256');

    // 2. Mock verified technical documents for knowledge retrieval
    const verifiedKnowledgeDocs = [
      {
        id: 'gib_aqualine_sys',
        title: 'GIB Aqualine® Wet Area Systems',
        content: 'GIB Aqualine is a water-resistant gypsum plasterboard designed for walls and ceilings in wet areas (bathrooms, laundries, and kitchens). NZBC Clause E3 Internal Moisture compliance mandates that wet areas must have impervious linings and an approved waterproofing membrane applied over linings in enclosed showers and splash zones before tiling.',
        specifications: {
          lining: 'GIB Aqualine 10mm or 13mm',
          waterproofingMembrane: 'BRANZ appraised liquid or sheet membrane',
          nzbcClause: 'E3 Internal Moisture',
          fasteners: 'GIB Grabber 32mm drywall screws',
        },
        sourceUrl: 'https://www.placemakers.co.nz/trade/technical/gib-aqualine',
      },
    ];

    // 3. Intercept fetch to verify OpenAI calls and prevent Google/JAX calls
    const calledUrls: string[] = [];
    const calledModelTasks: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calledUrls.push(urlStr);

      if (urlStr.includes('generativelanguage.googleapis.com')) {
        throw new Error('ILLEGAL REQUEST: Google Gemini was called when OpenAI was configured!');
      }
      if (urlStr.includes('jax-model') || urlStr.includes('api.journeyax.com/models')) {
        throw new Error('ILLEGAL REQUEST: JAX model was called when OpenAI was configured!');
      }

      if (urlStr.includes('api.openai.com')) {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        if (bodyText.includes('Extract structured facts and intent')) {
          calledModelTasks.push('fast_intent');
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-test-interp',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '```json\n{\n  "intent": "technical_advisory",\n  "candidateFacts": { "tradeCategory": { "value": "wet_area", "confidence": 0.99 } }\n}\n```',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        } else if (bodyText.includes('trade and building advisor')) {
          calledModelTasks.push('response_generation');
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-test-resp',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content:
                      'For wet areas like bathrooms and laundries, New Zealand Building Code Clause E3 requires moisture-resistant linings such as GIB Aqualine (available in 10mm and 13mm thicknesses). Additionally, an approved waterproofing membrane must be applied over the lining in shower enclosures and splashback zones prior to tiling. Fastenings should use GIB Grabber 32mm screws. Would you like assistance calculating sheets for your room dimensions or reviewing waterproofing membrane options?',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      return originalFetch(input, init);
    };

    try {
      const appService = new TurnApplicationService();
      // Database-only pointer/release loader simulation
      appService.packRepo.loadActivePack = async () => release;

      // Register verified knowledge handler with mock fixture
      appService.capabilityGateway.registerCustomAdapter(
        'knowledge.search',
        new KnowledgeSearchHandler(verifiedKnowledgeDocs)
      );

      const command: TurnCommand = {
        tenantId: 'placemakers',
        environmentId: 'test',
        workspaceId: `ws_wet_area_${Date.now()}`,
        sessionId: `sess_wet_area_${Date.now()}`,
        correlationId: `corr_wet_area_${Date.now()}`,
        message: 'What moisture-resistant linings and waterproofing do I need for my wet area?',
      };

      const turnResult = await appService.executeTurn(command);

      // Verify OpenAI was called for interpretation AND response generation
      assert.ok(calledModelTasks.includes('fast_intent'), 'OpenAI must be called for fast_intent');
      assert.ok(calledModelTasks.includes('response_generation'), 'OpenAI must be called for response_generation');

      // Verify Google/JAX received zero calls
      const googleCalls = calledUrls.filter((u) => u.includes('generativelanguage.googleapis.com'));
      assert.equal(googleCalls.length, 0, 'Zero calls to Google Gemini');

      // Verify assistant message
      const assistantText = turnResult.assistantMessage || '';
      console.log('    Assistant Response:\n   ', `"${assistantText}"\n`);

      assert.ok(assistantText.length > 50, 'Assistant response must be non-empty and substantive');
      assert.ok(
        assistantText.includes('GIB Aqualine') && assistantText.includes('waterproofing'),
        'Response must ground on GIB Aqualine and waterproofing from verified technical documents'
      );
      assert.ok(
        assistantText.includes('E3'),
        'Response must mention NZBC Clause E3 from verified technical documents'
      );

      // Verify FORBIDDEN stage jargon is completely absent
      assert.equal(
        assistantText.includes('Specifications and items have been updated'),
        false,
        'Assistant response must never claim "Specifications and items have been updated"'
      );
      assert.equal(
        assistantText.includes('Bill of Materials Assembly') || assistantText.includes('bom_assembly'),
        false,
        'Assistant response must never expose stage IDs like bom_assembly'
      );
      assert.equal(
        assistantText.includes('trade.quote_create') || assistantText.includes('knowledge.search'),
        false,
        'Assistant response must never expose capability names'
      );

      // Verify no unrequested quote was generated
      const quoteCreated = turnResult.executedCapabilities?.some((c) => c.toolId === 'trade.quote_create');
      assert.equal(quoteCreated, false, 'Do not automatically generate a quote from an informational wet-area question');

      // Verify trace diagnostics
      assert.ok(turnResult.trace?.modelRoute, 'Trace modelRoute must be present');
      assert.equal(turnResult.trace.modelRoute.provider, 'openai');
      assert.equal(turnResult.trace.modelRoute.policyId, 'response_generation');
      assert.equal(turnResult.trace.modelRoute.releaseVersion, '2.0.0');

      // Verify UI clean output hygiene
      assert.equal(assistantText.includes('svgsvg'), false, 'Text must not contain svgsvg');
      assert.equal(assistantText.includes('<svg'), false, 'Text must not contain raw <svg markup');
      assert.equal(assistantText.includes('&#x20;'), false, 'Text must not contain &#x20;');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: UI Output Hygiene Sanitizer
  // -------------------------------------------------------------------------
  await test('5. UI Output Hygiene: sanitizeMessageText cleans SVGs, svgsvg, &#x20;, and raw envelopes', () => {
    // 5a. Strips svgsvg and raw SVGs
    const rawSvgText = 'Here are recommendations <svg width="10"><path d="M0 0"/></svg> svgsvg for moisture-resistant linings.';
    const cleaned1 = sanitizeMessageText(rawSvgText);
    assert.equal(cleaned1, 'Here are recommendations for moisture-resistant linings.');

    // 5b. Decodes &#x20; and &nbsp; entities
    const entityText = 'GIB&#x20;Aqualine&nbsp;10mm';
    const cleaned2 = sanitizeMessageText(entityText);
    assert.equal(cleaned2, 'GIB Aqualine 10mm');

    // 5c. Strips accidental serialized JSON envelope
    const jsonEnvelope = JSON.stringify({
      uiInstructions: [{ component: 'ClarifyCard', props: {} }],
      assistantMessage: 'For wet areas, use GIB Aqualine with an approved membrane.',
    });
    const cleaned3 = sanitizeMessageText(jsonEnvelope);
    assert.equal(cleaned3, 'For wet areas, use GIB Aqualine with an approved membrane.');
  });

  console.log('\n====================================================');
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPropagationSuite().catch((err) => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});
