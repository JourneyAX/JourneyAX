import { z } from 'zod';

export const RoomTypeDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  defaultDimensions: z.object({
    widthMm: z.number().positive(),
    depthMm: z.number().positive(),
    heightMm: z.number().positive(),
  }),
  allowedComponentCategories: z.array(z.string()),
  forbiddenComponentCategories: z.array(z.string()).default([]),
  defaultComponents: z
    .array(
      z.object({
        componentId: z.string(),
        sku: z.string(),
        x: z.number(),
        z: z.number(),
        rotation: z.number().default(0),
        quantity: z.number().default(1),
      })
    )
    .default([]),
});

export const ComponentReferenceSchema = z.object({
  componentId: z.string(),
  sku: z.string(),
  category: z.string(),
  compatibleRoomTypes: z.array(z.string()),
  dimensionsMm: z.object({
    width: z.number().positive(),
    depth: z.number().positive(),
    height: z.number().positive(),
  }),
  coverageM2: z.number().positive().optional(),
  unitOfMeasure: z.string().optional(),
});

export const IsolationRuleSchema = z.object({
  ruleId: z.string(),
  targetRoomType: z.string(),
  forbiddenCategories: z.array(z.string()),
  errorMessage: z.string(),
});

export const LayoutRulesSchema = z.object({
  isolationRules: z.array(IsolationRuleSchema).default([]),
  wallWidthConstraints: z
    .object({
      minMm: z.number().positive().default(1200),
      maxMm: z.number().positive().default(4800),
      stepMm: z.number().positive().default(100),
    })
    .default({
      minMm: 1200,
      maxMm: 4800,
      stepMm: 100,
    }),
});

export const CompatibilityClassificationSchema = z.object({
  classificationId: z.string(),
  systemType: z.enum(['exterior_barrier', 'interior_lining', 'sanitary_plumbing', 'general']),
  compatibleRoomTypes: z.array(z.string()),
  forbiddenRoomTypes: z.array(z.string()).default([]),
  skuPatternsOrIds: z.array(z.string()),
  requiresExplicitMapping: z.boolean().default(false),
  rejectionMessage: z.string(),
});

export const CalculationFormulaSchema = z.object({
  formulaId: z.string(),
  targetCategory: z.string(),
  unitCoverageM2: z.number().positive(),
  rounding: z.enum(['ceil', 'floor', 'round']).default('ceil'),
  formulaExpression: z.string().optional(),
});

export const FinishPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  hex: z.string(),
  desc: z.string().optional(),
});

export const BenchtopOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceNzd: z.number().nonnegative(),
});

export const HandleOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const SpacePlannerDefaultsSchema = z.object({
  defaultRoomType: z.string().default('laundry'),
  defaultFinish: z.string().default('white-gloss'),
  defaultInstallType: z.enum(['diy', 'trade']).default('diy'),
  finishes: z.array(FinishPresetSchema).default([]),
  benchtops: z.array(BenchtopOptionSchema).default([]),
  handles: z.array(HandleOptionSchema).default([]),
});

export const SpacePlannerExtensionSchema = z.object({
  version: z.string().default('1.0.0'),
  enabled: z.boolean().default(true),
  roomTypes: z.array(RoomTypeDefinitionSchema).min(1),
  plannerLabels: z.record(z.string(), z.string()).default({}),
  componentReferences: z.array(ComponentReferenceSchema).default([]),
  layoutRules: LayoutRulesSchema.default({
    isolationRules: [],
    wallWidthConstraints: { minMm: 1200, maxMm: 4800, stepMm: 100 },
  }),
  compatibilityClassifications: z.array(CompatibilityClassificationSchema).default([]),
  calculationFormulas: z.array(CalculationFormulaSchema).default([]),
  defaults: SpacePlannerDefaultsSchema.default({
    defaultRoomType: 'laundry',
    defaultFinish: 'white-gloss',
    defaultInstallType: 'diy',
    finishes: [],
    benchtops: [],
    handles: [],
  }),
});

export type RoomTypeDefinition = z.infer<typeof RoomTypeDefinitionSchema>;
export type ComponentReference = z.infer<typeof ComponentReferenceSchema>;
export type IsolationRule = z.infer<typeof IsolationRuleSchema>;
export type LayoutRules = z.infer<typeof LayoutRulesSchema>;
export type CompatibilityClassification = z.infer<typeof CompatibilityClassificationSchema>;
export type CalculationFormula = z.infer<typeof CalculationFormulaSchema>;
export type SpacePlannerDefaults = z.infer<typeof SpacePlannerDefaultsSchema>;
export type SpacePlannerExtension = z.infer<typeof SpacePlannerExtensionSchema>;
