import { MemoryDb } from '@journeyax/test-support';
import { TurnApplicationService } from '../../src/kernel/turn-application.service';
import { PackRepository } from '../../src/kernel/pack.repository';
import { WorkspaceRepository } from '../../src/kernel/workspace.repository';
import { WorkspaceStore } from '../../src/workspace/workspace.store';
import { JourneyResolver } from '../../src/kernel/journey.resolver';
import { ModelGateway } from '../../src/kernel/model.gateway';
import { CapabilityGateway } from '../../src/kernel/capability.gateway';
import { CatalogSearchHandler } from '../../src/capabilities/handlers/catalog-search.handler';
import { ExecutionRepository } from '../../src/kernel/execution.repository';
import { OutboxRepository } from '../../src/kernel/outbox.repository';
import { PresentationPort } from '../../src/kernel/presentation.port';
import { TurnInterpreter } from '../../src/turn/interpret-event';
import { OutcomeValidator } from '../../src/turn/validate-outcome';
import { OkfKnowledgeControlPlane } from '../../src/kernel/knowledge-control-plane';
import { KnowledgeGapRepository } from '../../src/kernel/knowledge-gap.repository';
import { publishBusinessPack, type BusinessPackRelease } from '@journeyax/business-pack';
import { FixedGateway } from './placemakers-stack';

export const ABERCROMBIE_TENANT = 'abercrombie';
export const ABERCROMBIE_ENV = 'test';

export const abercrombieProducts: any[] = [
  {
    projectId: ABERCROMBIE_TENANT,
    sku: 'ANF-HOODIE-BLK',
    name: 'Essential Popover Hoodie',
    title: 'Essential Popover Hoodie - Black',
    category: 'Hoodies & Sweatshirts',
    categoryPath: ['Men', 'Tops', 'Hoodies & Sweatshirts'],
    priceUSD: { min: 70 },
    currency: 'USD',
    inStock: true,
    color: 'black',
  },
  {
    projectId: ABERCROMBIE_TENANT,
    sku: 'ANF-HOODIE-GRY',
    name: 'Essential Popover Hoodie - Heather Grey',
    title: 'Essential Popover Hoodie - Heather Grey',
    category: 'Hoodies & Sweatshirts',
    categoryPath: ['Men', 'Tops', 'Hoodies & Sweatshirts'],
    priceUSD: { min: 70 },
    currency: 'USD',
    inStock: true,
    color: 'grey',
  },
  {
    projectId: ABERCROMBIE_TENANT,
    sku: 'ANF-TEE-WHT',
    name: 'Essential Tee - White',
    title: 'Essential Tee - White',
    category: 'T-Shirts',
    categoryPath: ['Men', 'Tops', 'T-Shirts'],
    priceUSD: { min: 30 },
    currency: 'USD',
    inStock: true,
    color: 'white',
  },
  {
    projectId: ABERCROMBIE_TENANT,
    sku: 'ANF-HOODIE-DISC',
    name: 'Vintage Arch Logo Hoodie',
    title: 'Vintage Arch Logo Hoodie - Navy',
    category: 'Hoodies & Sweatshirts',
    categoryPath: ['Men', 'Tops', 'Hoodies & Sweatshirts'],
    priceUSD: { min: 80 },
    currency: 'USD',
    inStock: false,
    discontinued: true,
    status: 'Discontinued',
    color: 'navy',
  },
  {
    projectId: ABERCROMBIE_TENANT,
    sku: 'ANF-TEE-OOS',
    name: 'Curve Love Graphic Tee',
    title: 'Curve Love Graphic Tee - Green',
    category: 'T-Shirts',
    categoryPath: ['Men', 'Tops', 'T-Shirts'],
    priceUSD: { min: 35 },
    currency: 'USD',
    inStock: false,
    color: 'green',
  },
];

export function createAbercrombieRelease(): BusinessPackRelease {
  return {
    manifest: {
      packId: 'bp_abercrombie_v1',
      tenantId: ABERCROMBIE_TENANT,
      name: 'Abercrombie & Fitch Digital Experience Pack',
      description: 'Unified commerce pack for Abercrombie & Fitch retail apparel and cart flows.',
      version: '1.0.0',
      environmentId: ABERCROMBIE_ENV,
      publishedAt: '2026-09-25T17:00:00.000Z',
      publishedBy: 'admin@journeyax.io',
      status: 'active',
      checksum: '',
    },
    profile: {
      companyName: 'Abercrombie & Fitch',
      industry: 'Retail Apparel & Fashion',
      primaryCurrency: 'USD',
      supportedCurrencies: ['USD', 'EUR'],
      primaryLocale: 'en-US',
      supportedLocales: ['en-US'],
    },
    vocabulary: {
      version: '1.0.0',
      terms: [
        { term: 'Hoodie', canonical: 'hoodie', category: 'apparel', synonyms: ['hoodie', 'sweatshirt', 'popover'] },
        { term: 'Tee', canonical: 't-shirt', category: 'apparel', synonyms: ['tee', 't-shirt', 'shirt'] },
      ],
      acronyms: {},
      slotSynonyms: {},
      slotQuestions: {},
      slotMappings: {},
      prohibitedTerms: [],
    },
    entities: {
      version: '1.0.0',
      entities: [],
    },
    conversationPolicy: {
      fencingRules: [],
      prohibitedTopics: [],
      escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 },
      customerEvents: {
        autoTurnEvents: ['addToCart', 'cart.added'],
        recordOnlyEvents: ['removeFromCart', 'cart.removed', 'like'],
      },
    },
    modelPolicy: {
      version: '1.0.0',
      defaultPolicy: 'fast_intent',
      policies: [
        {
          policyId: 'fast_intent',
          description: 'High-speed intent classification',
          candidates: [{ provider: 'openai', model: 'gpt-4o-mini', priority: 1 }],
          dataResidency: 'us',
          maxInputTokens: 8000,
          maxOutputTokens: 1000,
          fallbackAllowed: true,
          timeoutMs: 5000,
        },
      ],
    },
    rules: [],
    evaluations: [],
    experience: {
      version: '1.0.0',
      theme: {
        primaryColor: '#1A365D',
        accentColor: '#2B6CB0',
        fontFamily: 'Inter, sans-serif',
        borderRadius: '8px',
      },
      cards: {
        allowedCardTypes: ['products', 'cart'],
        defaultCardRenderer: '@journeyax/ui-cards',
        templates: {},
      },
    },
    capabilities: {
      version: '1.0.0',
      toolDefinitions: [
        {
          toolId: 'catalog.search',
          version: '1.0.0',
          displayName: 'Catalog Search',
          description: 'Search product catalog',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'search_products',
          version: '1.0.0',
          displayName: 'Search Products',
          description: 'Search product catalog',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'present_card',
          version: '1.0.0',
          displayName: 'Present Card',
          description: 'Present interactive UI card',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'get_journey_checklist',
          version: '1.0.0',
          displayName: 'Journey Checklist',
          description: 'Inspect journey progress and playbook checklist',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'check_stock',
          version: '1.0.0',
          displayName: 'Check Stock',
          description: 'Verify inventory stock availability',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'update_cart',
          version: '1.0.0',
          displayName: 'Update Cart',
          description: 'Add or update items in cart',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'transactional',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'consult_business_knowledge',
          version: '1.0.0',
          displayName: 'Consult Knowledge',
          description: 'Look up verified business knowledge',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
        {
          toolId: 'get_warranty',
          version: '1.0.0',
          displayName: 'Get Warranty',
          description: 'Get verified warranty certificate',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'internal',
        },
      ],
      toolBindings: [
        {
          toolId: 'catalog.search',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'catalog-search' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'search_products',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'catalog-search' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'present_card',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'present-card' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'get_journey_checklist',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'journey-checklist' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'check_stock',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'branch-stock-check' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'update_cart',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'cart-update' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'consult_business_knowledge',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'knowledge-search' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        {
          toolId: 'get_warranty',
          tenantId: ABERCROMBIE_TENANT,
          environmentId: ABERCROMBIE_ENV,
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'knowledge-search' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
      ],
      stageBindings: [
        {
          journeyId: 'cart_shop',
          stageId: 'shop_stage',
          tools: [{ toolId: 'catalog.search' }, { toolId: 'search_products' }, { toolId: 'present_card' }],
        },
      ],
    },
    agents: [
      {
        agentId: 'cart_assistant',
        name: 'Cart & Selection Assistant',
        purpose: 'Guides users through item selection, configuration, and cart update.',
        modelPolicyRef: 'fast_intent',
        inputSchema: {},
        outputSchema: {},
        maxTurns: 5,
        handoffConditions: [],
        allowedTools: [
          'catalog.search',
          'search_products',
          'get_journey_checklist',
          'check_stock',
          'update_cart',
          'present_card',
          'consult_business_knowledge',
          'get_warranty',
        ],
        journeyPlaybook: [
          {
            id: 'stage_style_fit',
            name: 'Style & Fit Discovery',
            goal: 'Help the customer explore apparel matching preferred colour, size, and fit.',
            tools: ['catalog.search', 'search_products', 'get_journey_checklist'],
            exitCondition: 'Apparel piece is chosen and added to cart.',
          },
          {
            id: 'stage_coordinates',
            name: 'Outfit Pairing & Accessories',
            goal: 'Suggest matching coordinates, layering pieces, or accessories.',
            tools: ['search_products', 'present_card'],
            exitCondition: 'Complementary pieces or coordinates are viewed or chosen.',
          },
          {
            id: 'stage_stock_fit',
            name: 'Size Availability & Fit Confidence',
            goal: 'Verify inventory availability and fit guidance for the selected sizes.',
            tools: ['check_stock'],
            exitCondition: 'Stock availability is verified for selected items.',
          },
          {
            id: 'stage_cart_checkout',
            name: 'Bag Review & Checkout Readiness',
            goal: 'Confirm bag items, quantities, and provide single clear checkout next step.',
            tools: ['update_cart', 'present_card'],
            exitCondition: 'Cart is updated and checkout link/step is presented.',
          },
        ],
        systemPromptTemplate: 'You are the cart and selection assistant. Guide the user through item choices and checkout.',
      },
    ],
    journeys: [
      {
        journeyId: 'cart_shop',
        version: '1.0.0',
        displayName: 'Shopping Flow',
        description: 'Guided selection and cart addition',
        goals: ['select_item'],
        initialStage: 'shop_stage',
        stages: {
          shop_stage: {
            displayName: 'Shop Stage',
            description: 'Item discovery',
            requiredFacts: [],
            allowedCapabilities: ['catalog.search', 'search_products', 'present_card'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [],
          },
        },
      },
    ],
    extensions: {
      agentMode: {
        enabled: true,
      },
      dialoguePolicy: {
        agentMode: true,
      },
    },
  };
}

export async function buildAbercrombieStack() {
  const db = new MemoryDb();
  await db.collection('products').insertMany(abercrombieProducts.map((p) => ({ ...p })));

  const release = createAbercrombieRelease();
  await publishBusinessPack(db as any, release, {
    publishedBy: 'test-runner@journeyax.io',
    notes: 'Abercrombie test pack for multi-turn history eval',
  });

  const serviceFor = (options: { reply?: string; calls?: string[]; modelGateway?: ModelGateway } = {}) => {
    const modelGateway = options.modelGateway || new FixedGateway(options.reply, options.calls);
    const capabilityGateway = new CapabilityGateway();
    capabilityGateway.registerCustomAdapter(
      'catalog.search',
      new CatalogSearchHandler(undefined, async () => db as any)
    );

    return new TurnApplicationService(
      new PackRepository(db),
      new WorkspaceRepository(new WorkspaceStore({ forceInMemory: true })),
      new JourneyResolver(),
      undefined,
      modelGateway,
      capabilityGateway,
      undefined,
      new ExecutionRepository(),
      new OutboxRepository({ forceInMemory: true }),
      new PresentationPort(modelGateway),
      new TurnInterpreter(modelGateway),
      undefined,
      new OutcomeValidator(),
      new OkfKnowledgeControlPlane(async () => db as any),
      undefined,
      new KnowledgeGapRepository(db)
    );
  };

  return { db, release, serviceFor };
}
