import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface ProjectPlanMaterialInput {
  sku: string;
  title?: string;
  name?: string;
  description?: string;
  category?: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  priceCents?: number;
  currency?: string;
  catalogVerified: boolean;
  pricingVerified?: boolean;
  attributes?: Record<string, unknown>;
}

export interface ProjectPlanInput {
  projectType?: string;
  projectName?: string;
  dimensions?: string;
  areaM2?: number;
  calculationRef?: string;
  calculationVersion?: string;
  currency?: string;
  materials?: ProjectPlanMaterialInput[];
  toolsNeeded?: string[];
  verifiedNotes?: string[];
}

/**
 * Domain-neutral project-plan assembler.
 *
 * Quantity rules, compatibility, SKUs, product copy, prices and compliance notes
 * must be supplied by published Business Pack capabilities and live commerce.
 * This platform handler only validates and assembles those verified inputs; it
 * deliberately contains no tenant products, formulas, prices or regulations.
 */
export class ProjectPlanHandler implements NativeCapabilityHandler {
  async execute(input: ProjectPlanInput, _ctx: ExecutionContext): Promise<any> {
    const projectType = typeof input.projectType === 'string' ? input.projectType.trim() : '';
    const calculationRef = typeof input.calculationRef === 'string' ? input.calculationRef.trim() : '';
    const materials = Array.isArray(input.materials) ? input.materials : [];

    if (!projectType || !calculationRef || materials.length === 0) {
      return {
        status: 'unavailable',
        ok: false,
        missingInputs: [
          ...(!projectType ? ['projectType'] : []),
          ...(!calculationRef ? ['calculationRef'] : []),
          ...(materials.length === 0 ? ['materials'] : []),
        ],
        message: 'A published calculation reference and verified catalog materials are required to build a project plan.',
      };
    }

    const invalid = materials.find((item) => {
      const title = String(item?.title || item?.name || '').trim();
      return (
        !item ||
        item.catalogVerified !== true ||
        !String(item.sku || '').trim() ||
        !title ||
        !Number.isFinite(Number(item.quantity)) ||
        Number(item.quantity) <= 0 ||
        !String(item.unit || '').trim() ||
        ((item.unitPrice != null || item.priceCents != null) && item.pricingVerified !== true)
      );
    });
    if (invalid) {
      return {
        status: 'unavailable',
        ok: false,
        message: 'Every project-plan line requires a verified SKU, title, positive quantity, unit, and verified pricing provenance when a price is present.',
      };
    }

    const currencies = new Set(
      [input.currency, ...materials.map((item) => item.currency)]
        .map((value) => String(value || '').trim().toUpperCase())
        .filter(Boolean)
    );
    if (currencies.size > 1) {
      return {
        status: 'unavailable',
        ok: false,
        message: 'Project-plan lines contain mixed currencies and cannot be totalled safely.',
      };
    }
    const currency = currencies.values().next().value as string | undefined;

    let hasCompletePricing = true;
    const assembledMaterials = materials.map((item) => {
      const unitPrice = item.priceCents != null
        ? Number(item.priceCents) / 100
        : item.unitPrice != null
        ? Number(item.unitPrice)
        : undefined;
      if (unitPrice == null || !Number.isFinite(unitPrice)) hasCompletePricing = false;
      return {
        sku: String(item.sku).trim(),
        title: String(item.title || item.name).trim(),
        description: item.description,
        category: item.category,
        quantity: Number(item.quantity),
        unit: String(item.unit).trim(),
        unitPrice,
        lineTotal: unitPrice == null ? undefined : Number((Number(item.quantity) * unitPrice).toFixed(2)),
        currency: item.currency ? String(item.currency).toUpperCase() : currency,
        attributes: item.attributes,
        catalogVerified: true,
        pricingVerified: unitPrice == null ? undefined : true,
      };
    });

    const total = hasCompletePricing
      ? Number(assembledMaterials.reduce((sum, item) => sum + (item.lineTotal || 0), 0).toFixed(2))
      : undefined;

    return {
      status: 'success',
      ok: true,
      projectType,
      projectName: input.projectName?.trim() || projectType,
      dimensions: input.dimensions,
      areaM2: input.areaM2,
      calculationRef,
      calculationVersion: input.calculationVersion,
      materials: assembledMaterials,
      toolsNeeded: Array.isArray(input.toolsNeeded) ? input.toolsNeeded : [],
      verifiedNotes: Array.isArray(input.verifiedNotes) ? input.verifiedNotes : [],
      currency,
      total,
      pricingComplete: hasCompletePricing,
    };
  }
}
