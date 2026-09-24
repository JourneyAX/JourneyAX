import { z } from 'zod';
import { ManifestSchema } from './manifest.schema';
import { BusinessProfileSchema } from './business-profile.schema';
import { VocabularySchema } from './vocabulary.schema';
import { EntitiesSchema } from './entities.schema';
import { ModelPolicySchema } from './model-policy.schema';
import { AgentDefinitionSchema } from './agent.schema';
import { JourneyDefinitionSchema } from './journey.schema';
import { RuleDefinitionSchema } from './rule.schema';
import { CapabilityBindingsCollectionSchema } from './capability-binding.schema';
import { ExperienceSchema } from './experience.schema';
import { EvaluationSuiteSchema } from './evaluation.schema';

export const ConversationPolicySchema = z.object({
  fencingRules: z.array(z.string()).default([]),
  prohibitedTopics: z.array(z.string()).default([]),
  escalationThresholds: z.object({
    sentimentFloor: z.number().min(-1).max(1).default(-0.6),
    maxTurnsWithoutProgress: z.number().int().default(4),
  }).default({
    sentimentFloor: -0.6,
    maxTurnsWithoutProgress: 4,
  }),
});

export const BusinessPackReleaseSchema = z.object({
  manifest: ManifestSchema,
  profile: BusinessProfileSchema,
  vocabulary: VocabularySchema.default({
    version: '1.0.0',
    terms: [],
    acronyms: {},
    slotSynonyms: {},
    slotMappings: {},
    prohibitedTerms: [],
  }),
  entities: EntitiesSchema.default({ version: '1.0.0', entities: [] }),
  conversationPolicy: ConversationPolicySchema.default({
    fencingRules: [],
    prohibitedTopics: [],
    escalationThresholds: {
      sentimentFloor: -0.6,
      maxTurnsWithoutProgress: 4,
    },
  }),
  modelPolicy: ModelPolicySchema,
  agents: z.array(AgentDefinitionSchema).min(1),
  journeys: z.array(JourneyDefinitionSchema).min(1),
  rules: z.array(RuleDefinitionSchema).default([]),
  capabilities: CapabilityBindingsCollectionSchema,
  experience: ExperienceSchema.default({
    version: '1.0.0',
    theme: {
      primaryColor: '#0F172A',
      accentColor: '#3B82F6',
      fontFamily: 'Inter, sans-serif',
      borderRadius: '8px',
      customCssVars: {},
    },
    cards: {
      allowedCardTypes: [
        'bundle',
        'products',
        'productDetail',
        'quote',
        'comparison',
        'plan',
        'cart',
        'orderStatus',
        'guide',
      ],
      defaultCardRenderer: '@journeyax/ui-cards',
    },
  }),
  evaluations: z.array(EvaluationSuiteSchema).default([]),
});

export type BusinessPackRelease = z.infer<typeof BusinessPackReleaseSchema>;
export type ConversationPolicy = z.infer<typeof ConversationPolicySchema>;
