import dotenv from 'dotenv';
dotenv.config();
import { MongoClient } from 'mongodb';
import * as crypto from 'crypto';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || 'journeyx');

  const pointerCol = db.collection('business_pack_pointers');
  const releaseCol = db.collection('business_pack_releases');

  const currentPointer = await pointerCol.findOne({
    tenantId: 'placemakers',
    environmentId: 'production',
  });

  console.log('Current pointer:', currentPointer?.activeVersion);

  const prevRelease = await releaseCol.findOne({
    tenantId: 'placemakers',
    environmentId: 'production',
    version: currentPointer?.activeVersion || '1.3.1',
  });

  if (!prevRelease) {
    throw new Error('Previous release not found');
  }

  const newVersion = '1.3.7';
  const newRelease = JSON.parse(JSON.stringify(prevRelease));
  delete newRelease._id;

  newRelease.version = newVersion;
  newRelease.manifest.version = newVersion;
  newRelease.publishedAt = new Date();
  newRelease.publishedBy = 'dynamic-pack-migration';

  // 1. Pack-Level Dynamic Routing Policy
  newRelease.routingPolicy = {
    defaultJourneyId: 'placemakers_materials_hardware',
    fallbackOnCatalogSearch: true,
  };
  newRelease.conversationPolicy = {
    ...newRelease.conversationPolicy,
    defaultJourneyId: 'placemakers_materials_hardware',
  };

  // 2. Vocabulary Enhancement for Bathroom, Plumbing, Pet Care, and Cleaning
  if (newRelease.vocabulary) {
    const existingTerms = newRelease.vocabulary.terms || [];
    const enrichedTerms = [
      { term: 'toilet', canonical: 'toilet', category: 'Bathroom', synonyms: ['suite', 'pan', 'cistern', 'commode', 'loo', 'wc'] },
      { term: 'vanity', canonical: 'vanity', category: 'Bathroom', synonyms: ['basin', 'sink', 'vanity unit'] },
      { term: 'tapware', canonical: 'tapware', category: 'Plumbing', synonyms: ['tap', 'mixer', 'faucet'] },
      { term: 'screws', canonical: 'screws', category: 'Fasteners', synonyms: ['fasteners', 'fixings', 'bolts'] },
      { term: 'timber', canonical: 'timber', category: 'Timber', synonyms: ['lumber', 'framing', 'decking'] },
      {
        term: 'pet',
        canonical: 'pet care',
        category: 'tradeCategory',
        synonyms: ['pets', 'pet care', 'pet food', 'animal feed', 'poultry', 'chicken feed', 'peck n lay', 'peck \'n\' lay', 'household pets', 'pet care products', 'pet supplies'],
        description: 'Pet care, animal feeds, and pet household supplies',
      },
      {
        term: 'pet care',
        canonical: 'pet care',
        category: 'tradeCategory',
        synonyms: ['pet care', 'pet supplies', 'pets', 'pet food', 'household pets', 'animal feed', 'explore pet care products'],
        description: 'PlaceMakers Pet Care & Household Consumables category',
      },
      {
        term: 'animal feed',
        canonical: 'pet care',
        category: 'tradeCategory',
        synonyms: ['peck n lay', 'poultry feed', 'chicken pellets', 'chicken feed', 'animal feed', 'peck n lay pellets'],
        description: 'NRM Peck n Lay pellets and animal nutrition',
      },
      {
        term: 'cleaning supplies',
        canonical: 'Cleaning & Consumables',
        category: 'tradeCategory',
        synonyms: [
          'cleaning supplies',
          'cleanning supplies',
          'cleanning',
          'cleaning',
          'cleaner',
          'cleaners',
          'cleaning consumables',
          'cleaning products',
          'cleaning chemicals',
          'mops',
          'mop',
          'buckets',
          'bucket',
          'rubbish bags',
          'garbage bags',
          'bin liners',
          'bins',
          'brooms',
          'indoor cleaners',
          'outdoor cleaners',
          'consumables',
          'household cleaning',
          'disinfectant',
        ],
        description: 'PlaceMakers Cleaning & Consumables category',
      },
      {
        term: 'cleaning consumables',
        canonical: 'Cleaning & Consumables',
        category: 'tradeCategory',
        synonyms: ['cleaning', 'cleanning', 'cleaning supplies', 'cleanning supplies', 'consumables', 'household', 'stain remover', 'odour remover', 'indoor cleaners'],
        description: 'Cleaning consumables and indoor cleaners',
      },
    ];
    for (const pt of enrichedTerms) {
      const idx = existingTerms.findIndex((t: any) => t.term === pt.term);
      if (idx >= 0) {
        existingTerms[idx] = pt;
      } else {
        existingTerms.push(pt);
      }
    }
    newRelease.vocabulary.terms = existingTerms;

    // Slot synonyms enhancement
    newRelease.vocabulary.slotSynonyms = newRelease.vocabulary.slotSynonyms || {};
    const petTradeSynonyms = ['pet', 'pets', 'pet care', 'pet food', 'animal feed', 'poultry', 'chicken feed', 'peck n lay', 'household pets'];
    const cleaningTradeSynonyms = [
      'cleaning',
      'cleanning',
      'cleaning supplies',
      'cleanning supplies',
      'cleaning consumables',
      'cleaning products',
      'cleaner',
      'cleaners',
      'mops',
      'mop',
      'buckets',
      'bucket',
      'rubbish bags',
      'garbage bags',
      'bins',
      'brooms',
    ];
    const currentTradeSyns = newRelease.vocabulary.slotSynonyms.tradeCategory || [];
    for (const s of [...petTradeSynonyms, ...cleaningTradeSynonyms]) {
      if (!currentTradeSyns.includes(s)) currentTradeSyns.push(s);
    }
    newRelease.vocabulary.slotSynonyms.tradeCategory = currentTradeSyns;

    newRelease.vocabulary.slotSynonyms.pet_product_type = [
      'poultry & animal feed',
      'poultry feed',
      'peck n lay',
      'animal feed',
      'chicken pellets',
      'pet stain & odour cleaners',
      'pet stain',
      'stain remover',
      'odour remover',
      'pet safety landscape gates & fencing',
      'pet gate',
      'landscape gate',
      'pet fencing',
      'pet barrier',
      'pet-safe weed & pest control',
    ];

    newRelease.vocabulary.slotSynonyms.cleaning_product_type = [
      'indoor & surface cleaners',
      'indoor cleaners',
      'surface cleaners',
      'disinfectants',
      'stain removers',
      'mops, buckets & brooms',
      'mops',
      'mop',
      'buckets',
      'bucket',
      'wringer buckets',
      'squeeze mops',
      'brooms',
      'rubbish bags & heavy duty bins',
      'rubbish bags',
      'garbage bags',
      'heavy duty bins',
      'bins',
      'outdoor & trade cleanup',
      'outdoor cleaners',
      'trade cleanup',
    ];

    newRelease.vocabulary.slotQuestions = newRelease.vocabulary.slotQuestions || {};
    newRelease.vocabulary.slotQuestions.pet_product_type = {
      text: 'What type of pet care or animal feed supplies do you need?',
      options: [
        'Poultry & Animal Feed (NRM Peck n Lay Pellets 20kg)',
        'Pet Stain & Odour Cleaners (Carpet & upholstery cleaners)',
        'Pet Safety Landscape Gates & Fencing (Aluminium pool & garden gates)',
        'Pet-Safe Weed & Pest Control',
      ],
      multi: false,
    };
    newRelease.vocabulary.slotQuestions.cleaning_product_type = {
      text: 'What type of cleaning or household supplies do you need?',
      options: [
        'Indoor & Surface Cleaners (Multi-surface, disinfectants, stain removers)',
        'Mops, Buckets & Brooms (Wringer buckets, squeeze mops, heavy duty tubs)',
        'Rubbish Bags & Heavy Duty Bins (Wheelie bin liners, garden sacks, 70L bins)',
        'Outdoor & Trade Cleanup (Exterior wash, concrete cleaner, thinners)',
      ],
      multi: false,
    };
  }

  // 3. Dynamic Journeys Configuration
  const matJourney = newRelease.journeys.find((j: any) => j.journeyId === 'placemakers_materials_hardware');
  if (matJourney) {
    matJourney.isDefaultConsultant = true;

    // Enriched Goals
    const additionalGoals = [
      'toilet',
      'toilets',
      'cistern',
      'bathroom',
      'plumbing',
      'vanity',
      'basin',
      'tapware',
      'shower',
      'plumbing ware',
      'sanitary ware',
      'pet',
      'pets',
      'pet care',
      'pet food',
      'poultry feed',
      'animal feed',
      'peck n lay',
      'household pets',
      'cleaning',
      'cleanning',
      'cleaning supplies',
      'cleanning supplies',
      'cleaning consumables',
      'cleaning products',
      'mops',
      'buckets',
      'rubbish bags',
      'household consumables',
      'explore pet care products',
      'pet care products',
    ];
    for (const g of additionalGoals) {
      if (!matJourney.goals.includes(g)) {
        matJourney.goals.push(g);
      }
    }

    // Enriched Trigger Intents
    const triggerIntents = matJourney.metadata?.triggerIntents || matJourney.triggerIntents || [];
    const additionalTriggers = [
      'toilet',
      'toilets',
      'discussing_toilet_options',
      'Discussing toilet options or requirements',
      'plumbing',
      'bathroom',
      'sanitary',
      'tapware',
      'product_inquiry',
      'catalog_search',
      'pet',
      'pets',
      'pet_care',
      'pet care',
      'explore pet care products',
      'animal_feed',
      'animal feed',
      'poultry_feed',
      'poultry feed',
      'household_pets',
      'household pets',
      'cleaning',
      'cleanning',
      'cleaning_supplies',
      'cleaning supplies',
      'cleanning_supplies',
      'cleanning supplies',
      'cleaning_consumables',
      'cleaning consumables',
      'cleaning_products',
      'mops',
      'buckets',
      'rubbish_bags',
    ];
    for (const t of additionalTriggers) {
      if (!triggerIntents.includes(t)) {
        triggerIntents.push(t);
      }
    }
    matJourney.triggerIntents = triggerIntents;
    if (matJourney.metadata) {
      matJourney.metadata.triggerIntents = triggerIntents;
    }

    // 4. Multi-Stage Architectural Configuration: Intake -> Recommendation -> Quote
    matJourney.initialStage = 'materials_intake';
    matJourney.stages = {
      materials_intake: {
        stageId: 'materials_intake',
        displayName: 'Material & Hardware Intake',
        description: 'Understand customer project requirements and trade category before presenting products.',
        requiredFacts: [
          {
            key: 'material_category',
            priority: 100,
            question: 'What type of project materials or hardware do you need?',
            options: [
              'Plumbing & Bathroomware (Toilets, vanities, tapware)',
              'Screws & Timber Fasteners (Decking, cladding, framing)',
              'Framing & Structural Timber (Radiata, treated H3.2/H4)',
              'Cleaning, Consumables & Household (Mops, rubbish bags, indoor cleaners)',
              'Pet Care Supplies (Animal feeds, stain removers, pet gates)',
              'General Building Supplies & Hardware',
            ],
            dependencies: [],
            required: true,
            inputType: 'single_select',
          },
        ],
        conditionalFacts: [
          {
            when: "facts.tradeCategory == 'Pet Care' || facts.tradeCategory == 'pet care' || facts.tradeCategory == 'pet' || facts.tradeCategory == 'pets' || facts.tradeCategory == 'animal feed' || facts.tradeCategory == 'poultry feed' || facts.tradeCategory == 'Household & Pets' || facts.material_category == 'Pet Care' || facts.productQuery == 'pet' || facts.Pet_Care != null",
            facts: [
              {
                key: 'pet_product_type',
                priority: 200,
                question: 'What type of pet care or animal feed supplies do you need?',
                options: [
                  'Poultry & Animal Feed (NRM Peck n Lay Pellets 20kg)',
                  'Pet Stain & Odour Cleaners (Carpet & upholstery cleaners)',
                  'Pet Safety Landscape Gates & Fencing (Aluminium pool & garden gates)',
                  'Pet-Safe Weed & Pest Control',
                ],
                dependencies: [],
                required: true,
                inputType: 'single_select',
              },
            ],
          },
          {
            when: "facts.tradeCategory == 'Cleaning & Consumables' || facts.tradeCategory == 'cleaning' || facts.tradeCategory == 'cleanning' || facts.tradeCategory == 'cleaning supplies' || facts.tradeCategory == 'cleanning supplies' || facts.tradeCategory == 'cleaning consumables' || facts.tradeCategory == 'cleaning products' || facts.tradeCategory == 'cleaner' || facts.tradeCategory == 'cleaners' || facts.tradeCategory == 'mops' || facts.tradeCategory == 'mop' || facts.tradeCategory == 'buckets' || facts.tradeCategory == 'bucket' || facts.tradeCategory == 'rubbish bags' || facts.tradeCategory == 'bins' || facts.tradeCategory == 'brooms' || facts.tradeCategory == 'Cleaning' || facts.tradeCategory == 'Household' || facts.cleaning_product_type != null",
            facts: [
              {
                key: 'cleaning_product_type',
                priority: 200,
                question: 'What type of cleaning or household supplies do you need?',
                options: [
                  'Indoor & Surface Cleaners (Multi-surface, disinfectants, stain removers)',
                  'Mops, Buckets & Brooms (Wringer buckets, squeeze mops, heavy duty tubs)',
                  'Rubbish Bags & Heavy Duty Bins (Wheelie bin liners, garden sacks, 70L bins)',
                  'Outdoor & Trade Cleanup (Exterior wash, concrete cleaner, thinners)',
                ],
                dependencies: [],
                required: true,
                inputType: 'single_select',
              },
            ],
          },
          {
            when: "facts.tradeCategory == 'Bathroom' || facts.tradeCategory == 'Plumbing'",
            facts: [
              {
                key: 'suite_style',
                priority: 200,
                question: 'What style and configuration do you prefer for your space?',
                options: [
                  'Back-to-Wall Suite (floor mounted, streamlined)',
                  'Wall-Hung Toilet (in-wall concealed cistern, modern floating look)',
                  'Close-Coupled Suite (classic two-piece suite)',
                  'Toilet seat or replacement pan only',
                ],
                dependencies: [],
                required: true,
                inputType: 'single_select',
              },
            ],
          },
          {
            when: "facts.tradeCategory == 'Fasteners' || facts.tradeCategory == 'Timber'",
            facts: [
              {
                key: 'fastener_grade',
                priority: 200,
                question: 'What environmental exposure or grade do you require?',
                options: [
                  'Internal / Standard Zinc (Dry interior spaces)',
                  'Hot Dip Galvanized / Technoguard (Exterior general)',
                  '304 Grade Stainless Steel (Exterior coastal/exposed)',
                  '316 Marine Grade Stainless (Severe marine environment NZS 3604)',
                ],
                dependencies: [],
                required: true,
                inputType: 'single_select',
              },
            ],
          },
        ],
        allowedCapabilities: ['knowledge.search'],
        capabilityPlan: [
          {
            toolId: 'knowledge.search',
            when: { factsPresent: ['tradeCategory'] },
            producesFacts: ['knowledge_verified'],
            sameTurnContinuation: true,
          },
        ],
        nextDecisionPolicy: 'rule-first',
        exitConditions: [
          {
            ruleExpression: "facts.pet_product_type != null || facts.cleaning_product_type != null || facts.material_category != null || facts.suite_style != null || facts.fastener_grade != null",
            nextStage: 'materials_recommendation',
          },
        ],
      },
      materials_recommendation: {
        stageId: 'materials_recommendation',
        displayName: 'Product Recommendations & Advisory',
        description: 'Search catalog, present verified matching products, and provide detailed technical explanations.',
        requiredFacts: [],
        optionalFacts: [
          {
            key: 'pack_quantity',
            priority: 100,
            question: 'What quantity or pack size do you need?',
            options: [
              '1 pack / bag (standard 20kg bag or 650ml spray)',
              '2 - 5 bags / bulk project supply',
              'Master pallet / trade bulk quantity',
            ],
            dependencies: [],
            required: false,
            inputType: 'single_select',
          },
        ],
        allowedCapabilities: ['catalog.search', 'knowledge.search', 'trade.quote_create'],
        capabilityPlan: [
          {
            toolId: 'catalog.search',
            when: {},
            producesFacts: ['catalog_results'],
            sameTurnContinuation: true,
          },
          {
            toolId: 'knowledge.search',
            when: {},
            producesFacts: ['knowledge_verified'],
            sameTurnContinuation: true,
          },
        ],
        nextDecisionPolicy: 'capability-first',
        exitConditions: [
          {
            ruleExpression: "facts.quote_requested == true || facts.bom_confirmed == true",
            nextStage: 'materials_quote',
          },
        ],
      },
      materials_quote: {
        stageId: 'materials_quote',
        displayName: 'Trade Quote & Fulfilment',
        description: 'Generate trade estimate, verify branch stock, and deliver quote.',
        requiredFacts: [],
        allowedCapabilities: ['trade.quote_create', 'branch.stock_check'],
        capabilityPlan: [
          {
            toolId: 'trade.quote_create',
            when: {},
            producesFacts: ['quote_generated'],
          },
        ],
        nextDecisionPolicy: 'capability-first',
        exitConditions: [],
      },
    };
  }

  // 5. Update Capabilities Stage Bindings
  newRelease.capabilities = newRelease.capabilities || {};
  const existingBindings = (newRelease.capabilities.stageBindings || []).filter(
    (sb: any) => sb.journeyId !== 'placemakers_materials_hardware'
  );
  existingBindings.push(
    {
      journeyId: 'placemakers_materials_hardware',
      stageId: 'materials_intake',
      tools: [
        {
          toolId: 'knowledge.search',
          inputMapping: { query: 'query' },
          outputFactMapping: { knowledge_verified: 'verified' },
        },
      ],
    },
    {
      journeyId: 'placemakers_materials_hardware',
      stageId: 'materials_recommendation',
      tools: [
        {
          toolId: 'catalog.search',
          inputMapping: { query: 'query' },
          outputFactMapping: { catalog_results: 'items' },
        },
        {
          toolId: 'knowledge.search',
          inputMapping: { query: 'query' },
          outputFactMapping: { knowledge_verified: 'verified' },
        },
      ],
    },
    {
      journeyId: 'placemakers_materials_hardware',
      stageId: 'materials_quote',
      tools: [
        {
          toolId: 'trade.quote_create',
          inputMapping: {},
          outputFactMapping: { quote_generated: 'quoteId' },
        },
      ],
    }
  );
  newRelease.capabilities.stageBindings = existingBindings;

  // Use canonical publishBusinessPack
  const { publishBusinessPack } = await import('@journeyax/business-pack');
  const result = await publishBusinessPack(db, newRelease, {
    publishedBy: 'dynamic-pack-migration',
    notes: 'Dynamic multi-stage materials & hardware journey with consultative intake and targeted recommendation',
  });

  // Sync tenant_cutovers
  await db.collection('tenant_cutovers').updateOne(
    { tenantId: 'placemakers', environmentId: 'production' },
    {
      $set: {
        activeReleaseVersion: newVersion,
        activeReleaseChecksum: result.checksum,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  console.log(`Successfully published version ${newVersion} with checksum ${result.checksum} (revision ${result.revision})`);
  await client.close();
}

main().catch(console.error);
