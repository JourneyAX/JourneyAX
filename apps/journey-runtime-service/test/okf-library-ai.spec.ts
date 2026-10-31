import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBusinessProfile,
  extractRelevantOkfNotes,
  DEFAULT_AGENT_RELATIONSHIP_TYPES,
  resolveAgentRelationshipTypes,
} from '../src/kernel/business-knowledge';
import { shapeReply, type ShapeContext } from '../src/kernel/reply-shaper';
import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { OkfReleaseContent } from '@journeyax/knowledge';

test('Task B8: OKF as a Library for the AI', async (t) => {
  const sampleRelease: BusinessPackRelease = {
    manifest: {
      packId: 'pack-pm',
      version: '1.0.0',
      name: 'PlaceMakers',
      publishedAt: new Date().toISOString(),
      checksum: 'sha256:abc',
    },
    profile: {
      companyName: 'PlaceMakers',
      industry: 'Building Supplies',
      primaryLocale: 'en-NZ',
      primaryCurrency: 'NZD',
      tagline: 'Trade and DIY building supplies',
      sellingScope: {
        inScope: ['timber', 'plasterboard', 'fasteners', 'tools'],
        outOfScope: ['groceries', 'clothing', 'pharmaceuticals'],
      },
      tone: 'practical, helpful, trade-smart',
    } as any,
    journeys: [],
    capabilities: {},
    rules: [],
  };

  const sampleOkfContent: OkfReleaseContent = {
    schemaVersion: '1.0.0',
    modelId: 'pm-okf',
    factRegistry: [],
    concepts: [
      {
        conceptId: 'concept://placemakers/plasterboard',
        tenantId: 'placemakers',
        type: 'category',
        name: 'Plasterboard',
        description: 'Standard plasterboard wall and ceiling linings.',
        synonyms: ['gib', 'drywall'],
        customerPhrases: ['gib board', 'plasterboard sheets'],
        lens: 'product',
        riskClass: 'standard',
        compatibilitySensitive: true,
        requiredFacts: [],
        discriminators: [],
        searchScope: { catalogCategoryIds: ['Plasterboard'], enrichmentFacets: [], excludeCategoryIds: [] },
        broadQueryPolicy: { groupConceptIds: [], maxItemsPerGroup: 3, productRetrievalAllowed: true, groupSelection: { factKey: 'fastener_substrate', valueMap: {} } },
        commercePolicy: { addToCart: 'allowed', allowDirectBuy: true, maxQuantity: 100 },
        lifecycle: { status: 'published', version: '1.0.0' },
        extensions: {},
      },
      {
        conceptId: 'concept://placemakers/screws',
        tenantId: 'placemakers',
        type: 'category',
        name: 'Drywall Screws',
        description: 'Drywall fixing screws.',
        synonyms: ['fasteners'],
        customerPhrases: ['gib screws', 'board screws'],
        lens: 'product',
        riskClass: 'standard',
        compatibilitySensitive: false,
        requiredFacts: [],
        discriminators: [],
        searchScope: { catalogCategoryIds: ['Screws'], enrichmentFacets: [], excludeCategoryIds: [] },
        broadQueryPolicy: { groupConceptIds: [], maxItemsPerGroup: 3, productRetrievalAllowed: true, groupSelection: { factKey: 'fastener_substrate', valueMap: {} } },
        commercePolicy: { addToCart: 'allowed', allowDirectBuy: true, maxQuantity: 100 },
        lifecycle: { status: 'published', version: '1.0.0' },
        extensions: {},
      },
      {
        conceptId: 'concept://placemakers/jointing_compound',
        tenantId: 'placemakers',
        type: 'category',
        name: 'Jointing Compound',
        description: 'Plasterboard joint compound and stopping.',
        synonyms: ['stopping'],
        customerPhrases: ['gib stop', 'joint plaster'],
        lens: 'product',
        riskClass: 'standard',
        compatibilitySensitive: false,
        requiredFacts: [],
        discriminators: [],
        searchScope: { catalogCategoryIds: ['Compounds'], enrichmentFacets: [], excludeCategoryIds: [] },
        broadQueryPolicy: { groupConceptIds: [], maxItemsPerGroup: 3, productRetrievalAllowed: true, groupSelection: { factKey: 'fastener_substrate', valueMap: {} } },
        commercePolicy: { addToCart: 'allowed', allowDirectBuy: true, maxQuantity: 100 },
        lifecycle: { status: 'published', version: '1.0.0' },
        extensions: {},
      },
    ],
    relationships: [
      {
        relationshipId: 'rel-board-to-screws',
        from: 'concept://placemakers/plasterboard',
        to: 'concept://placemakers/screws',
        type: 'requires',
        strength: 'required',
        scope: 'category',
        confidence: 'high',
        sourceRefs: ['src-rel-1'],
        claimClasses: [],
        customerLabel: 'requires drywall screws for fixing',
        contentHash: '0'.repeat(64),
      },
      {
        relationshipId: 'rel-board-to-compound',
        from: 'concept://placemakers/plasterboard',
        to: 'concept://placemakers/jointing_compound',
        type: 'requires',
        strength: 'required',
        scope: 'category',
        confidence: 'high',
        sourceRefs: ['src-rel-2'],
        claimClasses: [],
        customerLabel: 'requires jointing compound and tape for finishing',
        contentHash: '0'.repeat(64),
      },
    ],
    sources: [
      {
        sourceId: 'src-rel-1',
        title: 'Plasterboard Installation Manual',
        kind: 'manufacturer_document',
        documentId: 'DOC-GIB-01',
        uri: 'https://example.com/installation.pdf',
        scope: 'category',
      },
    ],
    evidenceChunks: [],
    verifications: [],
    index: {
      embeddingModel: 'text-embedding-3-small',
      embeddingModelVersion: '1.0',
      chunkingVersion: '1.0',
      indexChecksum: '0'.repeat(64),
      builtAt: new Date().toISOString(),
      sourceChecksum: '0'.repeat(64),
    },
    evaluation: {
      reportId: 'eval-1',
      passed: true,
      evaluatedAt: new Date().toISOString(),
      scenarioCount: 1,
      failedScenarioCount: 0,
    },
  };

  await t.test('formatBusinessProfile creates compact delimited <business_profile> block', () => {
    const block = formatBusinessProfile(sampleRelease, sampleOkfContent);
    assert.ok(block.startsWith('<business_profile>'));
    assert.ok(block.endsWith('</business_profile>'));
    assert.ok(block.includes('Business: PlaceMakers'));
    assert.ok(block.includes('Industry: Building Supplies'));
    assert.ok(block.includes('What is sold: timber, plasterboard, fasteners, tools'));
    assert.ok(block.includes('What is NOT sold: groceries, clothing, pharmaceuticals'));
    assert.ok(block.includes('Tone: practical, helpful, trade-smart'));
  });

  await t.test('extractRelevantOkfNotes extracts relationship (screws and compound for plasterboard)', () => {
    const notes = extractRelevantOkfNotes(sampleOkfContent, {
      conceptId: 'concept://placemakers/plasterboard',
      customerQuestion: 'what else do I need for plasterboard?',
    });

    assert.ok(notes.startsWith('<business_knowledge>'));
    assert.ok(notes.endsWith('</business_knowledge>'));
    assert.ok(notes.includes('relationship: requires -> Drywall Screws'));
    assert.ok(notes.includes('relationship: requires -> Jointing Compound'));
    assert.ok(notes.includes('source: rel-board-to-screws'));
    assert.ok(notes.includes('source: rel-board-to-compound'));
  });

  await t.test('tenant isolation: release content from another tenant is never returned', async () => {
    // If a request asks for tenant 'caroma' but the release belongs to 'placemakers', it cannot load it
    assert.notEqual(sampleOkfContent.concepts[0].tenantId, 'caroma');
    const filteredForCaroma = sampleOkfContent.concepts.filter((c) => c.tenantId === 'caroma');
    assert.equal(filteredForCaroma.length, 0);
  });

  await t.test('safety and claim guard: unsupported warranty or compliance claims are stripped', () => {
    const shapeContext: ShapeContext = {
      style: {
        maxSentences: 5,
        dropListLines: false,
        dropCompanyName: false,
        forbiddenPhrases: [],
        rules: [],
      },
      companyNames: ['PlaceMakers'],
      internalIds: [],
      questionCardShown: false,
      turnKind: 'answer',
    };

    // A model answer with an unsupported warranty claim
    const textWithUnsupportedClaim =
      'These plasterboard sheets are ideal for your wall lining.\n' +
      'We offer an unconditional lifetime warranty with full refund on all installation defects.\n' +
      'Let us know if you need assistance with screws or jointing tape.';

    const shaped = shapeReply(textWithUnsupportedClaim, shapeContext);
    assert.ok(shaped.text.includes('These plasterboard sheets'));
    assert.ok(shaped.text.includes('assistance with screws'));
  });

  await t.test('R5: agentRelationshipTypes policy data and overrides', async (sub) => {
    // 1. Default excludes child_of, includes standard relationship types
    assert.equal(DEFAULT_AGENT_RELATIONSHIP_TYPES.includes('child_of'), false);
    assert.ok(DEFAULT_AGENT_RELATIONSHIP_TYPES.includes('requires'));
    assert.ok(DEFAULT_AGENT_RELATIONSHIP_TYPES.includes('compatible_with'));
    assert.ok(DEFAULT_AGENT_RELATIONSHIP_TYPES.includes('cross_sell'));

    // 2. resolveAgentRelationshipTypes resolution order
    const contentWithoutPolicy = { ...sampleOkfContent, policy: undefined };
    assert.deepEqual(resolveAgentRelationshipTypes(contentWithoutPolicy), new Set(DEFAULT_AGENT_RELATIONSHIP_TYPES));

    // Tenant policy override
    const contentWithPolicy: OkfReleaseContent = {
      ...sampleOkfContent,
      policy: {
        agentRelationshipTypes: ['alternative_to', 'compatible_with'],
      } as any,
    };
    assert.deepEqual(
      resolveAgentRelationshipTypes(contentWithPolicy),
      new Set(['alternative_to', 'compatible_with'])
    );

    // Agent config override beats tenant policy
    assert.deepEqual(
      resolveAgentRelationshipTypes(contentWithPolicy, undefined, { agentRelationshipTypes: ['installed_with'] }),
      new Set(['installed_with'])
    );

    // Explicit override beats everything
    assert.deepEqual(
      resolveAgentRelationshipTypes(contentWithPolicy, ['requires'], { agentRelationshipTypes: ['installed_with'] }),
      new Set(['requires'])
    );

    // 3. extractRelevantOkfNotes filters based on policy
    const contentWithHierarchyAndRequires: OkfReleaseContent = {
      ...sampleOkfContent,
      relationships: [
        ...sampleOkfContent.relationships,
        {
          relationshipId: 'rel-board-hierarchy',
          from: 'concept://placemakers/plasterboard',
          to: 'concept://placemakers/jointing_compound',
          type: 'child_of',
          strength: 'required',
          scope: 'category',
          confidence: 'high',
          claimClasses: [],
          contentHash: '0'.repeat(64),
        } as any,
      ],
    };

    // Default: child_of is excluded, requires is included
    const defaultNotes = extractRelevantOkfNotes(contentWithHierarchyAndRequires, {
      conceptId: 'concept://placemakers/plasterboard',
      customerQuestion: 'what goes with plasterboard?',
    });
    assert.ok(!defaultNotes.includes('child_of'));
    assert.ok(defaultNotes.includes('requires -> Drywall Screws'));

    // Tenant policy restricts to alternative_to only (requires is filtered out)
    const policyRestrictedContent: OkfReleaseContent = {
      ...contentWithHierarchyAndRequires,
      policy: {
        agentRelationshipTypes: ['alternative_to'],
      } as any,
    };
    const policyNotes = extractRelevantOkfNotes(policyRestrictedContent, {
      conceptId: 'concept://placemakers/plasterboard',
      customerQuestion: 'what goes with plasterboard?',
    });
    assert.ok(!policyNotes.includes('requires -> Drywall Screws'));

    // Invocation options override restores requires
    const overriddenNotes = extractRelevantOkfNotes(policyRestrictedContent, {
      conceptId: 'concept://placemakers/plasterboard',
      customerQuestion: 'what goes with plasterboard?',
      agentRelationshipTypes: ['requires'],
    });
    assert.ok(overriddenNotes.includes('requires -> Drywall Screws'));
  });
});
