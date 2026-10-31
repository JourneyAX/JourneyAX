import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyPrompt,
  extractExpectedSkus,
  checkNoInternalIds,
  extractRequestedAttributes,
  checkProductLookupMatch,
  checkGroundTruthRequirements,
  loadPlacemakersCsvProducts,
} from '../../../scripts/eval/run-conversation-eval';

describe('Evaluation Harness & Validity Checks (Task S4)', () => {
  it('correctly classifies prompts and distinguishes lookups from advisory/safety/project', () => {
    // 1. Direct product lookup with specific SKU expectation
    const lookupTc = {
      id: 1,
      category: 'Timber & Dimensions',
      prompt: 'Do you have 100x50 H3.2 treated timber in stock?',
      purpose: 'Numeric dimension code + treatment grade recognition',
      groundTruthReference: '[FEED-VERIFIED] VERIFIED — e.g. SKU 1002835',
    };
    const lookupClass = classifyPrompt(lookupTc);
    assert.equal(lookupClass.type, 'product_lookup');
    assert.equal(lookupClass.expectsSpecificSku, true);

    // 2. Safety prompt
    const safetyTc = {
      id: 55,
      category: 'Fixings & Fasteners',
      prompt: 'What screws are safe to use near electrical wiring?',
      purpose: 'Safety-adjacent query',
      groundTruthReference: '[FEED-VERIFIED] NO SINGLE SKU — genuine safety-judgement question',
    };
    const safetyClass = classifyPrompt(safetyTc);
    assert.equal(safetyClass.type, 'safety');
    assert.equal(safetyClass.expectsSpecificSku, false);

    // 3. Project prompt
    const projectTc = {
      id: 86,
      category: 'Vague DIY Project Prompts',
      prompt: 'I want to build a cabinet',
      purpose: 'Baseline vague prompt from the live demo',
      groundTruthReference: '[FEED-VERIFIED] Baseline vague prompt — real cabinetry components exist',
    };
    const projectClass = classifyPrompt(projectTc);
    assert.equal(projectClass.type, 'project');
    assert.equal(projectClass.expectsSpecificSku, false);

    // 4. Advisory prompt
    const adviceTc = {
      id: 58,
      category: 'Tools',
      prompt: 'What drill should I use for masonry walls?',
      purpose: 'Classic tool-for-task query',
      groundTruthReference: '[FEED-VERIFIED] VERIFIED (as masonry drill BITS, not a drill tool itself)',
    };
    const adviceClass = classifyPrompt(adviceTc);
    assert.equal(adviceClass.type, 'advice');
    assert.equal(adviceClass.expectsSpecificSku, false);

    // 5. Unstocked / Not-in-feed query
    const notInFeedTc = {
      id: 62,
      category: 'Tools',
      prompt: 'Do you have a Paslode Trim Master in stock?',
      purpose: 'Known out-of-catalogue brand search',
      groundTruthReference: '[FEED-VERIFIED] NOT IN FEED — zero Paslode hits anywhere',
    };
    const notInFeedClass = classifyPrompt(notInFeedTc);
    assert.equal(notInFeedClass.expectsSpecificSku, false);
  });

  it('extracts expected SKUs from reference and URL fields', () => {
    const ref = 'VERIFIED — e.g. SKU 1002835 and SKU 1003586';
    const urls = 'https://www.placemakers.co.nz/online/timber/p/1003591\nhttps://www.placemakers.co.nz/online/timber/p/1015613';
    const skus = extractExpectedSkus(ref, urls);
    assert.deepEqual(skus.sort(), ['1002835', '1003586', '1003591', '1015613']);
  });

  it('extracts requested attributes and normalizes with equivalence definitions', () => {
    const attrDefs = {
      size: {
        normalizer: 'remove_spaces',
        equivalenceTable: {
          '100x50': ['100x50', '100 x 50', '4x2', '90x45', '90 x 45mm'],
        },
      },
      treatment: {
        normalizer: 'uppercase',
        equivalenceTable: {
          'H3.2': ['H3.2', 'H32', 'H3 2', 'H 3.2'],
        },
      },
    };

    const req = extractRequestedAttributes(
      'Do you have 100x50 H3.2 treated timber in stock?',
      undefined,
      attrDefs
    );
    assert.ok(req.sizeVariants.includes('100x50'));
    assert.ok(req.sizeVariants.includes('4x2'));
    assert.ok(req.sizeVariants.includes('90x45'));
    assert.ok(req.treatmentVariants.includes('H3.2'));
    assert.equal(req.keyword, 'timber');
  });

  it('scores product lookups by matching product attributes instead of requiring exact example SKUs', async () => {
    const mockDb = {
      collection: () => ({
        find: () => ({
          toArray: async () => [
            {
              sku: '9999999', // A different SKU than the 1 or 2 listed in ground truth
              name: 'Radiata Structural Grade 8 Planer Gauged Kiln Dried H3.2 CCA Treated 100 x 50mm (90 x 45mm)',
              category: 'Structural Grade Timber',
              attributes: {
                size: '100x50',
                treatment: 'H3.2',
              },
            },
          ],
        }),
      }),
    };

    const tc = {
      id: 1,
      category: 'Timber & Dimensions',
      prompt: 'Do you have 100x50 H3.2 treated timber in stock?',
      purpose: 'Numeric dimension code + treatment grade recognition',
      groundTruthReference: '[FEED-VERIFIED] VERIFIED — e.g. SKU 1002835',
    };

    const attrDefs = {
      size: {
        normalizer: 'remove_spaces',
        equivalenceTable: {
          '100x50': ['100x50', '100 x 50', '90x45', '4x2'],
        },
      },
      treatment: {
        normalizer: 'uppercase',
        equivalenceTable: {
          'H3.2': ['H3.2', 'H32', 'H3 2'],
        },
      },
    };

    // Agent returned SKU 9999999 which was NOT in expectedSkus (1002835), but has exact matching attributes
    const matchOutcome = await checkProductLookupMatch({
      tc,
      expectedSkus: ['1002835'],
      assistantMessage: 'We have 100x50 H3.2 timber in stock.',
      uiInstructions: [{ card: { sku: '9999999' } }],
      toolProductSkus: ['9999999'],
      db: mockDb,
      attributeDefinitions: attrDefs,
    });

    assert.equal(matchOutcome.matched, true, 'Product with matching size and treatment should pass');
    assert.equal(matchOutcome.matchedSku, '9999999');
  });

  it('scores advice prompts against ground-truth requirements rather than merely non-empty', () => {
    const adviceTc = {
      id: 58,
      category: 'Tools',
      prompt: 'What drill should I use for masonry walls?',
      purpose: 'Tool-for-task query',
      groundTruthReference: '[FEED-VERIFIED] VERIFIED (as masonry drill BITS, not a drill tool itself) — e.g. SKU 4732206 "Reo Buster 6.5 x 160mm SDS Plus Masonry Drill Bit"',
    };

    // Valid response mentioning SDS/hammer/masonry
    const validRes = checkGroundTruthRequirements({
      tc: adviceTc,
      promptType: 'advice',
      assistantMessage: 'For masonry walls, you will want a hammer drill or rotary hammer with an SDS Plus masonry drill bit.',
      cards: [],
      toolProductSkus: [],
    });
    assert.equal(validRes.met, true, 'Grounded advice should meet requirements');

    // Generic irrelevant response that is non-empty should fail requirement check
    const invalidRes = checkGroundTruthRequirements({
      tc: adviceTc,
      promptType: 'advice',
      assistantMessage: 'Hello, how can I help you today with your shopping?',
      cards: [],
      toolProductSkus: [],
    });
    assert.equal(invalidRes.met, false, 'Irrelevant non-empty message should not meet advisory requirements');
  });

  it('scores safety prompts against hazard awareness and disclaimer requirements', () => {
    const safetyTc = {
      id: 55,
      category: 'Fixings & Fasteners',
      prompt: 'What screws are safe to use near electrical wiring?',
      purpose: 'Safety-adjacent query',
      groundTruthReference: '[FEED-VERIFIED] NO SINGLE SKU — genuine safety-judgement question (risk of hitting live wiring)',
    };

    // Response with safety disclaimer passes
    const safeRes = checkGroundTruthRequirements({
      tc: safetyTc,
      promptType: 'safety',
      assistantMessage: 'WARNING: Screwing near electrical wiring carries a serious hazard of electric shock or hitting live wires. Please shut off mains power and consult a certified electrician before drilling or driving fasteners.',
      cards: [],
      toolProductSkus: [],
    });
    assert.equal(safeRes.met, true);

    // Response without safety warning fails
    const unsafeRes = checkGroundTruthRequirements({
      tc: safetyTc,
      promptType: 'safety',
      assistantMessage: 'You can use 30mm screws.',
      cards: [],
      toolProductSkus: [],
    });
    assert.equal(unsafeRes.met, false);
  });

  it('scores project prompts requiring scoping clarification or component recommendations', () => {
    const projectTc = {
      id: 86,
      category: 'Vague DIY Project Prompts',
      prompt: 'I want to build a cabinet',
      purpose: 'Baseline vague prompt',
      groundTruthReference: '[FEED-VERIFIED] Baseline vague prompt — real cabinetry components exist (MDF panels, cabinet handles/knobs, wood glue)',
    };

    // Asking clarifying questions passes
    const clarifyingRes = checkGroundTruthRequirements({
      tc: projectTc,
      promptType: 'project',
      assistantMessage: 'Building a cabinet is a great project! What dimensions and materials (such as MDF or solid timber) do you have in mind?',
      cards: [],
      toolProductSkus: [],
    });
    assert.equal(clarifyingRes.met, true);

    // Recommending components passes
    const componentRes = checkGroundTruthRequirements({
      tc: projectTc,
      promptType: 'project',
      assistantMessage: 'To build a cabinet, you will need MDF or plywood panels, cabinet hinges, handles, and wood glue.',
      cards: [],
      toolProductSkus: [],
    });
    assert.equal(componentRes.met, true);
  });

  it('loads CSV products with MSRP, image URL, attribute extraction, and excludes discontinued items', async () => {
    let inserted: any[] = [];
    const mockDb = {
      collection: (name: string) => {
        assert.equal(name, 'products');
        return {
          insertMany: async (docs: any[]) => {
            inserted = docs;
          },
        };
      },
    };

    const count = await loadPlacemakersCsvProducts(mockDb);
    assert.ok(count > 30000, `Expected over 30,000 active products loaded, got ${count}`);
    assert.equal(inserted.length, count);

    // Verify discontinued exclusion
    const discontinued = inserted.filter((p) => p.status === 'Discontinued' || p.variants?.[0]?.status === 'Discontinued');
    assert.equal(discontinued.length, 0, 'No discontinued products should be loaded into active catalogue');

    // Verify price mapped from MSRP and imageUrl mapped from Main_Image_URL
    const sampleWithImageAndPrice = inserted.find((p) => p.imageUrl && p.priceUSD?.min);
    assert.ok(sampleWithImageAndPrice, 'Expected products with imageUrl and priceUSD.min');
    assert.ok(sampleWithImageAndPrice.imageUrl.startsWith('https://'), 'imageUrl should be a valid URL');
    assert.ok(typeof sampleWithImageAndPrice.priceUSD.min === 'number', 'Price should be a number');

    // Verify index-time attribute extraction
    const timberSample = inserted.find((p) => p.attributes?.size && p.attributes?.treatment);
    assert.ok(timberSample, 'Expected timber products with size and treatment attributes');
    assert.ok(timberSample.attributes.size, 'Size attribute should be populated');
    assert.ok(timberSample.attributes.treatment, 'Treatment attribute should be populated');

    // Verify stock field is not blindly true
    assert.equal(inserted[0].inStock, undefined, 'inStock should be omitted when stock fields are absent');
  });
});

