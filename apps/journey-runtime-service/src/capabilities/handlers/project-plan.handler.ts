import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface ProjectPlanInput {
  projectType?: 'decking' | 'fencing' | 'lining' | 'retaining' | 'cladding' | string;
  material?: string;
  lengthM?: number | string;
  widthM?: number | string;
  heightM?: number | string;
  wallAreaM2?: number | string;
  dimensions?: string;
}

export class ProjectPlanHandler implements NativeCapabilityHandler {
  async execute(input: ProjectPlanInput, ctx: ExecutionContext): Promise<any> {
    const rawType = String(input.projectType || '').toLowerCase().trim();
    const material = String(input.material || 'Standard Pine H3.2').trim();

    let projectType: 'decking' | 'fencing' | 'lining' | 'retaining' | 'cladding' = 'decking';
    if (rawType.includes('fence')) projectType = 'fencing';
    else if (rawType.includes('lin') || rawType.includes('aqua') || rawType.includes('gib') || rawType.includes('wet')) projectType = 'lining';
    else if (rawType.includes('retain')) projectType = 'retaining';
    else if (rawType.includes('clad')) projectType = 'cladding';

    const l = Math.max(1, Number(input.lengthM) || 4);
    const w = Math.max(1, Number(input.widthM) || 3);
    const h = Math.max(0.5, Number(input.heightM) || 1.8);
    const area = Math.max(1, Number(input.wallAreaM2) || parseFloat((l * w).toFixed(1)));

    if (projectType === 'lining') {
      const sheetCount = Math.ceil((area / 2.88) * 1.1);
      const isAqua = material.toLowerCase().includes('aqua') || material.toLowerCase().includes('wet');
      const sheetPrice = isAqua ? 48.5 : 31.0;

      return {
        status: 'success',
        ok: true,
        projectName: `${area} m² ${isAqua ? 'Moisture-Resistant' : 'Standard'} Wall Lining Materials Plan`,
        projectType: 'lining',
        dimensions: `${area} m² Total Wall Surface Area`,
        areaM2: area,
        materials: [
          {
            category: 'Plasterboard Sheets',
            name: isAqua ? 'GIB Aqualine 10mm (2400 x 1200mm)' : 'Standard Plasterboard 10mm (2400 x 1200mm)',
            description: isAqua
              ? 'Water-resistant plasterboard core engineered for bathroom and kitchen wet areas per NZBC Clause E3.'
              : 'High quality wall and ceiling lining board suitable for standard interior residential spaces.',
            quantity: sheetCount,
            unit: 'sheets',
            estimatedUnitPriceNzd: sheetPrice,
            estimatedTotalPriceNzd: parseFloat((sheetCount * sheetPrice).toFixed(2)),
          },
          {
            category: 'Fasteners & Adhesives',
            name: 'Drywall Screws (32mm x 6g, Box of 500)',
            description: 'Fine thread drywall screws engineered for securing plasterboard to timber framing.',
            quantity: Math.ceil((sheetCount * 45) / 500),
            unit: 'box of 500',
            estimatedUnitPriceNzd: 26.5,
            estimatedTotalPriceNzd: parseFloat((Math.ceil((sheetCount * 45) / 500) * 26.5).toFixed(2)),
          },
          {
            category: 'Waterproofing & Protection',
            name: 'Waterproofing Membrane Under-Tile Kit (15L Pail + Bandage)',
            description: 'BRANZ-appraised waterproof membrane system required for wet areas under NZBC E3/AS1.',
            quantity: Math.max(1, Math.ceil(area / 15)),
            unit: 'pail kit',
            estimatedUnitPriceNzd: 185.0,
            estimatedTotalPriceNzd: parseFloat((Math.max(1, Math.ceil(area / 15)) * 185.0).toFixed(2)),
          },
        ],
        toolsNeeded: [
          'Drywall / Utility Knife & Spare Blades',
          'Broad Knife (150mm & 250mm Finishing Trowel)',
          'Cordless Screwdriver with Dimple Bit',
          'Sanding Block & 180-Grit Sandpaper',
        ],
        nzBuildingNotes: [
          'NZBC Clause E3 / AS1 requires an impervious, certified waterproof membrane under ceramic tiles in shower enclosures and wet areas.',
          'Use GIB Aqualine (10mm for walls at 400mm stud centers, or 13mm for 600mm centers).',
          'Ensure timber framing moisture content is under 18% before fixing plasterboard.',
        ],
        currency: 'NZD',
      };
    }

    // Default Decking Plan
    const boardPricePerM = material.toLowerCase().includes('hardwood') ? 14.5 : 8.5;
    const totalLinearM = Math.ceil((w / 0.095) * l * 1.1);

    return {
      status: 'success',
      ok: true,
      projectName: `${l}m × ${w}m ${material} Decking Materials Plan`,
      projectType: 'decking',
      dimensions: `${l}m × ${w}m (${area} m²)`,
      areaM2: area,
      materials: [
        {
          category: 'Decking Timber',
          name: `${material} Decking Timber (90x19mm Smooth/Grip)`,
          description: `Kiln-dried ${material} decking boards with 5mm spacing allowance and 10% cutting waste included.`,
          quantity: totalLinearM,
          unit: 'linear metres',
          estimatedUnitPriceNzd: boardPricePerM,
          estimatedTotalPriceNzd: parseFloat((totalLinearM * boardPricePerM).toFixed(2)),
        },
        {
          category: 'Sub-frame Framing',
          name: '140x45mm Structural Framing Joists H3.2',
          description: 'Treated structural framing timber for deck joists spaced at 450mm centers.',
          quantity: Math.ceil((l / 0.45 + 1) * w * 1.05),
          unit: 'linear metres',
          estimatedUnitPriceNzd: 9.8,
          estimatedTotalPriceNzd: parseFloat((Math.ceil((l / 0.45 + 1) * w * 1.05) * 9.8).toFixed(2)),
        },
        {
          category: 'Fasteners & Fixings',
          name: '316 Marine Grade Stainless Steel Decking Screws (10g x 65mm)',
          description: 'Corrosion-resistant decking screws with Torx drive to prevent timber splitting.',
          quantity: Math.ceil((area * 38) / 500),
          unit: 'box of 500',
          estimatedUnitPriceNzd: 74.5,
          estimatedTotalPriceNzd: parseFloat((Math.ceil((area * 38) / 500) * 74.5).toFixed(2)),
        },
      ],
      toolsNeeded: [
        'Compound Mitre Saw / Circular Saw',
        'Cordless Impact Driver & Drill Bits',
        'Spirit Level (1200mm)',
        'Tape Measure (8m)',
      ],
      nzBuildingNotes: [
        'NZS 3604:2011 Section 7: Max joist spacing 450mm centers.',
        'Decks under 1.5m fall height do not require a building consent, but must comply with the NZ Building Code.',
        'Use 316 Marine Grade stainless steel fixings in exposure zones C & D.',
      ],
      currency: 'NZD',
    };
  }
}
