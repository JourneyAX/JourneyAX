import {
  SpacePlannerExtension,
  RoomTypeDefinition,
  ComponentReference,
} from './schemas/space-planner.schema';
import { BusinessPackRelease } from './schemas/business-pack.schema';

export interface LayoutValidationItem {
  sku: string;
  category?: string;
  componentId?: string;
  quantity?: number;
  [key: string]: any;
}

export interface AccessoryValidationItem {
  sku: string;
  systemType?: string;
  category?: string;
  [key: string]: any;
}

/**
 * Extracts SpacePlannerExtension from a BusinessPackRelease if present.
 */
export function getSpacePlannerExtension(
  pack: BusinessPackRelease | any
): SpacePlannerExtension | null {
  if (!pack) return null;
  if (pack.extensions?.spacePlanner) {
    return pack.extensions.spacePlanner as SpacePlannerExtension;
  }
  if (pack.experience?.spacePlanner) {
    return pack.experience.spacePlanner as SpacePlannerExtension;
  }
  return null;
}

/**
 * Validates room component layout against the Business Pack space planner extension.
 * Strictly enforces room isolation rules (e.g. no laundry tubs or washer cavities in bathrooms).
 */
export function validateRoomLayoutAgainstPack(
  items: LayoutValidationItem[],
  roomType: string,
  extension: SpacePlannerExtension
): string[] {
  const errors: string[] = [];
  const normalizedRoom = String(roomType || '').toLowerCase().trim();

  const roomDef = extension.roomTypes.find((r) => r.id.toLowerCase() === normalizedRoom);
  if (!roomDef) {
    errors.push(`[Layout Violation] Room type '${roomType}' is not supported by active Business Pack`);
    return errors;
  }

  // Lookup map for component definitions in the pack
  const componentMap = new Map<string, ComponentReference>();
  for (const comp of extension.componentReferences || []) {
    componentMap.set(comp.sku, comp);
    componentMap.set(comp.componentId, comp);
  }

  // Check forbidden component categories
  const forbiddenCats = new Set((roomDef.forbiddenComponentCategories || []).map((c) => c.toLowerCase()));

  for (const item of items) {
    const ref = componentMap.get(item.sku) || (item.componentId ? componentMap.get(item.componentId) : null);
    const category = (item.category || ref?.category || '').toLowerCase();

    // 1. Direct forbidden category check
    if (category && forbiddenCats.has(category)) {
      errors.push(
        `[Isolation Violation] Category '${category}' (SKU: ${item.sku}) is strictly prohibited in ${roomDef.label || roomType} layouts`
      );
      continue;
    }

    // 2. Compatible room types check on component reference
    if (ref && ref.compatibleRoomTypes && ref.compatibleRoomTypes.length > 0) {
      const allowedRooms = ref.compatibleRoomTypes.map((r) => r.toLowerCase());
      if (!allowedRooms.includes(normalizedRoom)) {
        errors.push(
          `[Isolation Violation] Component ${item.sku} (${ref.category}) is only permitted in [${allowedRooms.join(', ')}], not in ${roomType}`
        );
      }
    }
  }

  // 3. Layout isolation rules
  for (const rule of extension.layoutRules?.isolationRules || []) {
    if (rule.targetRoomType.toLowerCase() === normalizedRoom) {
      const forbiddenInRule = new Set(rule.forbiddenCategories.map((c) => c.toLowerCase()));
      for (const item of items) {
        const ref = componentMap.get(item.sku);
        const cat = (item.category || ref?.category || '').toLowerCase();
        if (cat && forbiddenInRule.has(cat)) {
          errors.push(`[Isolation Rule: ${rule.ruleId}] ${rule.errorMessage} (Found SKU: ${item.sku})`);
        }
      }
    }
  }

  return errors;
}

/**
 * Validates accessory safety and compatibility against the Business Pack space planner extension.
 * Strictly forbids exterior weathertight barrier products (e.g. Weatherline, Barrier Sill, 40 Below)
 * from interior bathroom/wet area applications.
 */
export function validateAccessoryCompatibilityAgainstPack(
  accessories: (string | AccessoryValidationItem)[],
  roomType: string,
  extension: SpacePlannerExtension
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const normalizedRoom = String(roomType || '').toLowerCase().trim();

  const classifications = extension.compatibilityClassifications || [];

  for (const acc of accessories) {
    const sku = typeof acc === 'string' ? acc : acc.sku;
    const itemSystemType = typeof acc === 'object' ? acc.systemType : undefined;

    // Check each classification rule
    for (const rule of classifications) {
      const matchesSku = rule.skuPatternsOrIds.some((pat) => pat === sku || sku.startsWith(pat));
      const matchesSystem = itemSystemType && rule.systemType === itemSystemType;

      if (matchesSku || matchesSystem) {
        // Check if forbidden in current room
        const forbiddenRooms = (rule.forbiddenRoomTypes || []).map((r) => r.toLowerCase());
        if (forbiddenRooms.includes(normalizedRoom)) {
          errors.push(
            `[Compatibility Violation: ${rule.classificationId}] ${rule.rejectionMessage} (SKU: ${sku})`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Calculates material quantity based on active Business Pack calculation formulas.
 * For example, 7 m² wet-wall area with 2.88 m² unit coverage -> Math.ceil(7 / 2.88) = 3 panels.
 */
export function calculateMaterialQuantityFromPack(
  metricValue: number,
  targetCategoryOrSku: string,
  extension: SpacePlannerExtension
): number {
  const formulas = extension.calculationFormulas || [];
  const formula =
    formulas.find(
      (f) =>
        f.targetCategory.toLowerCase() === targetCategoryOrSku.toLowerCase() ||
        f.formulaId.toLowerCase() === targetCategoryOrSku.toLowerCase()
    ) || formulas[0];

  if (!formula || !formula.unitCoverageM2) {
    return Math.max(1, Math.ceil(metricValue));
  }

  const rawQty = metricValue / formula.unitCoverageM2;
  switch (formula.rounding) {
    case 'floor':
      return Math.max(1, Math.floor(rawQty));
    case 'round':
      return Math.max(1, Math.round(rawQty));
    case 'ceil':
    default:
      return Math.max(1, Math.ceil(rawQty));
  }
}
