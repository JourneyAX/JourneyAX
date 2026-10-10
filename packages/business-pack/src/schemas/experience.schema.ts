import { z } from 'zod';

/** Platform card vocabulary. Tenant packs choose a subset; no tenant-specific
 * component is introduced in runtime code. */
export const DEFAULT_PLATFORM_CARD_TYPES = [
  'products',
  'productDetail',
  'comparison',
  'bundle',
  'quote',
  'cart',
  'orderStatus',
  'guide',
  'plan',
  'clarify',
  'suggestions',
  'accessories',
  'warranty',
  'fitment',
  'disclosure',
  'hero',
  'working',
  'action_button_group',
  'order_confirmation',
] as const;

export const ExperienceThemeSchema = z.object({
  primaryColor: z.string().default('#0F172A'),
  accentColor: z.string().default('#3B82F6'),
  fontFamily: z.string().default('Inter, sans-serif'),
  borderRadius: z.string().default('8px'),
  logoUrl: z.string().url().optional(),
  faviconUrl: z.string().url().optional(),
  customCssVars: z.record(z.string(), z.string()).optional(),
});

export const ExperienceCardsSchema = z.object({
  allowedCardTypes: z.array(z.string()).default([...DEFAULT_PLATFORM_CARD_TYPES]),
  defaultCardRenderer: z.string().default('@journeyax/ui-cards'),
  allowedActions: z.array(z.string()).optional(),
  templates: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const ExperienceSchema = z.object({
  version: z.string().default('1.0.0'),
  theme: ExperienceThemeSchema.default({
    primaryColor: '#0F172A',
    accentColor: '#3B82F6',
    fontFamily: 'Inter, sans-serif',
    borderRadius: '8px',
  }),
  cards: ExperienceCardsSchema.default({
    allowedCardTypes: [...DEFAULT_PLATFORM_CARD_TYPES],
    defaultCardRenderer: '@journeyax/ui-cards',
  }),
});

export type Experience = z.infer<typeof ExperienceSchema>;
