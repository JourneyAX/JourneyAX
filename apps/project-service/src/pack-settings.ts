import { CatalogMappingSchema } from '@journeyax/business-pack';

export type PackSettingsResult =
  | { ok: true; set: Record<string, unknown | null> }
  | { ok: false; message: string };

const MONEY_KEYS = ['symbols', 'leadPhrases', 'capPhrases'];

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * Validates tenant pack settings before they are stored. `null` removes a setting (back to platform defaults);
 * the returned map is keyed by the stored project-document path.
 */
export function validatePackSettings(dto: {
  catalogMapping?: unknown;
  interpretationPolicy?: unknown;
  workspacePinPolicy?: unknown;
  routingPolicy?: unknown;
}): PackSettingsResult {
  const set: Record<string, unknown | null> = {};

  if (dto.catalogMapping !== undefined) {
    if (dto.catalogMapping === null) {
      set.catalogMapping = null;
    } else {
      const parsed = CatalogMappingSchema.safeParse(dto.catalogMapping);
      if (!parsed.success) return { ok: false, message: `Invalid catalogMapping: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}` };
      set.catalogMapping = parsed.data;
    }
  }

  if (dto.interpretationPolicy !== undefined) {
    const policy = dto.interpretationPolicy as any;
    if (policy === null) {
      set['extensions.interpretationPolicy'] = null;
    } else {
      if (typeof policy !== 'object' || Array.isArray(policy)) return { ok: false, message: 'Invalid interpretationPolicy: expected an object' };
      const allowed = ['quantity', 'money', 'grounding', 'promptRules', 'messages', 'replyStyle'];
      const unknown = Object.keys(policy).filter((key) => !allowed.includes(key));
      if (unknown.length) return { ok: false, message: `Invalid interpretationPolicy: unknown key(s) ${unknown.join(', ')}` };
      if (policy.promptRules !== undefined && !isStringArray(policy.promptRules)) return { ok: false, message: 'Invalid interpretationPolicy: promptRules must be a list of non-empty strings' };
      if (policy.messages !== undefined && (typeof policy.messages !== 'object' || Object.values(policy.messages).some((m) => typeof m !== 'string' || !m))) {
        return { ok: false, message: 'Invalid interpretationPolicy: messages must map ids to non-empty strings' };
      }
      if (policy.replyStyle !== undefined) {
        const style = policy.replyStyle;
        if (!style || typeof style !== 'object' || Array.isArray(style)) return { ok: false, message: 'Invalid interpretationPolicy: replyStyle must be an object' };
        const unknownStyle = Object.keys(style).filter((key) => !['maxSentences', 'dropListLines', 'dropCompanyName', 'forbiddenPhrases', 'rules'].includes(key));
        if (unknownStyle.length) return { ok: false, message: `Invalid interpretationPolicy: replyStyle has unknown key(s) ${unknownStyle.join(', ')}` };
        if (style.maxSentences !== undefined && (!Number.isInteger(style.maxSentences) || style.maxSentences < 1 || style.maxSentences > 8)) return { ok: false, message: 'Invalid interpretationPolicy: replyStyle.maxSentences must be a whole number from 1 to 8' };
        for (const flag of ['dropListLines', 'dropCompanyName']) if (style[flag] !== undefined && typeof style[flag] !== 'boolean') return { ok: false, message: `Invalid interpretationPolicy: replyStyle.${flag} must be true or false` };
        for (const list of ['forbiddenPhrases', 'rules']) if (style[list] !== undefined && !isStringArray(style[list])) return { ok: false, message: `Invalid interpretationPolicy: replyStyle.${list} must be a list of non-empty strings` };
      }
      for (const key of MONEY_KEYS) {
        if (policy.money?.[key] !== undefined && !isStringArray(policy.money[key])) return { ok: false, message: `Invalid interpretationPolicy: money.${key} must be a list of non-empty strings` };
      }
      for (const key of ['unitWords', 'verbs']) {
        if (policy.quantity?.[key] !== undefined && !isStringArray(policy.quantity[key])) return { ok: false, message: `Invalid interpretationPolicy: quantity.${key} must be a list of non-empty strings` };
      }
      if (policy.grounding?.ignoredOptionWords !== undefined && !isStringArray(policy.grounding.ignoredOptionWords)) {
        return { ok: false, message: 'Invalid interpretationPolicy: grounding.ignoredOptionWords must be a list of non-empty strings' };
      }
      set['extensions.interpretationPolicy'] = policy;
    }
  }

  if (dto.workspacePinPolicy !== undefined) {
    const policy = dto.workspacePinPolicy as any;
    if (policy === null) {
      set['extensions.workspacePinPolicy'] = null;
    } else {
      const hours = policy?.idleRepinAfterHours;
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
        return { ok: false, message: 'Invalid workspacePinPolicy: idleRepinAfterHours must be a positive number of hours (at most one year)' };
      }
      set['extensions.workspacePinPolicy'] = { idleRepinAfterHours: hours };
    }
  }

  // Which journey answers a request that matches none. A project with several journeys cannot be published without one, and the
  // publisher never guesses it. Whether the id names a real journey is checked at publication, where the journeys are known.
  if (dto.routingPolicy !== undefined) {
    const policy = dto.routingPolicy as any;
    if (policy === null) {
      set.routingPolicy = null;
    } else {
      if (typeof policy !== 'object' || Array.isArray(policy)) return { ok: false, message: 'Invalid routingPolicy: expected an object' };
      const unknown = Object.keys(policy).filter((key) => !['defaultJourneyId', 'fallbackOnCatalogSearch'].includes(key));
      if (unknown.length) return { ok: false, message: `Invalid routingPolicy: unknown key(s) ${unknown.join(', ')}` };
      if (typeof policy.defaultJourneyId !== 'string' || !policy.defaultJourneyId.trim()) {
        return { ok: false, message: 'Invalid routingPolicy: defaultJourneyId must name a journey' };
      }
      if (policy.fallbackOnCatalogSearch !== undefined && typeof policy.fallbackOnCatalogSearch !== 'boolean') {
        return { ok: false, message: 'Invalid routingPolicy: fallbackOnCatalogSearch must be true or false' };
      }
      set.routingPolicy = {
        defaultJourneyId: policy.defaultJourneyId.trim(),
        ...(policy.fallbackOnCatalogSearch === undefined ? {} : { fallbackOnCatalogSearch: policy.fallbackOnCatalogSearch }),
      };
    }
  }

  return { ok: true, set };
}
