import { z } from 'zod';

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
  allowedCardTypes: z.array(z.string()).default([
    'bundle',
    'products',
    'productDetail',
    'quote',
    'comparison',
    'plan',
    'cart',
    'orderStatus',
    'guide',
  ]),
  defaultCardRenderer: z.string().default('@journeyax/ui-cards'),
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
  }),
});

export type Experience = z.infer<typeof ExperienceSchema>;
