/**
 * Resolve the json-render spec for a card type: a tenant override
 * (`cfg.cardTemplates[cardType]`, set via the backoffice "Cards & Theme"
 * studio) if one exists, else the platform default from `@journeyax/ui-cards`.
 * This is the ONLY place that decides which template renders — CardStage and
 * the theming studio's preview both call it so they never disagree.
 */
import { DEFAULT_TEMPLATES, type CardType } from '@journeyax/ui-cards';
import type { Spec } from '@json-render/core';
import type { StorefrontConfig } from '@/context/StorefrontConfigContext';

export function resolveTemplate(cfg: Pick<StorefrontConfig, 'cardTemplates'>, cardType: CardType): Spec {
  const override = cfg.cardTemplates?.[cardType];
  if (override?.spec) return override.spec as Spec;
  return DEFAULT_TEMPLATES[cardType];
}
