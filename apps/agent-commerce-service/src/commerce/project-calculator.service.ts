/**
 * PlaceMakers Deterministic Materials & Project Estimator Engine
 *
 * Implements authoritative, safe calculations for common New Zealand DIY and
 * trade building projects (Decking, Timber Fencing, Wall Lining, Retaining Walls)
 * according to NZ Building Code standards (NZS 3604).
 */

export interface MaterialItem {
  category: string;
  name: string;
  sku?: string;
  description: string;
  quantity: number;
  unit: string;
  estimatedUnitPriceNzd: number;
  estimatedTotalPriceNzd: number;
}

export interface ProjectPlanResult {
  ok: boolean;
  projectName: string;
  projectType: 'decking' | 'fencing' | 'lining' | 'retaining' | 'cladding';
  dimensions: string;
  areaM2: number;
  materials: MaterialItem[];
  toolsNeeded: string[];
  nzBuildingNotes: string[];
  totalEstimateNzd: number;
  currency: string;
  branchAvailability: {
    recommendedBranch: string;
    status: 'In Stock' | 'Order Needed';
    pickupTimeframe: string;
  };
}

export class ProjectCalculatorService {
  /**
   * Calculate timber decking materials plan
   * Standard NZ residential deck: Bearers (100x100 H4), Joists (140x45 / 100x50 H3.2 @ 450mm crs),
   * Decking boards (90mm or 140mm width with 5mm gap & 10% waste), Fasteners (stainless 10g x 65mm).
   */
  static calculateDecking(
    lengthM: number,
    widthM: number,
    material: string = 'Kwila',
    heightM: number = 0.4
  ): ProjectPlanResult {
    const l = Math.max(1, lengthM);
    const w = Math.max(1, widthM);
    const area = parseFloat((l * w).toFixed(1));

    // Board width & spacing (standard 90x19mm with 5mm gap = 95mm coverage)
    const is140 = material.toLowerCase().includes('140') || material.toLowerCase().includes('wide');
    const boardWidthM = is140 ? 0.145 : 0.095;
    const totalLinearM = Math.ceil((w / boardWidthM) * l * 1.1); // 10% cutting waste

    // Joists @ 450mm centers running along width
    const joistRuns = Math.ceil(l / 0.45) + 1;
    const joistLengthTotalM = Math.ceil(joistRuns * w * 1.05);

    // Bearers @ 1.5m spacing running along length
    const bearerRuns = Math.ceil(w / 1.5) + 1;
    const bearerLengthTotalM = Math.ceil(bearerRuns * l * 1.05);

    // Post holes & concrete (posts @ 1.5m grid)
    const postCount = Math.ceil(l / 1.5 + 1) * Math.ceil(w / 1.5 + 1);
    const concreteBags = postCount * 2; // 2x 20kg bags per footing

    // Decking screws: ~35 screws per m² (2 screws per board at each joist)
    const screwCount = Math.ceil(area * 38);
    const screwBoxes = Math.ceil(screwCount / 500); // 500 per box

    const boardPricePerM = material.toLowerCase().includes('kwila') ? 14.5 : material.toLowerCase().includes('composite') ? 22.0 : 8.5;

    const materials: MaterialItem[] = [
      {
        category: 'Decking Timber',
        name: `${material} Decking Timber (${is140 ? '140x32mm' : '90x19mm'} Smooth/Grip)`,
        description: `Premium kiln-dried ${material} decking boards with 5mm spacing allowance and 10% cutting waste included.`,
        quantity: totalLinearM,
        unit: 'linear metres',
        estimatedUnitPriceNzd: boardPricePerM,
        estimatedTotalPriceNzd: parseFloat((totalLinearM * boardPricePerM).toFixed(2)),
      },
      {
        category: 'Sub-frame Framing',
        name: '140x45mm Radiata Pine H3.2 SG8 Framing Joists',
        description: 'Treated structural framing timber for deck joists spaced at 450mm centers.',
        quantity: joistLengthTotalM,
        unit: 'linear metres',
        estimatedUnitPriceNzd: 9.8,
        estimatedTotalPriceNzd: parseFloat((joistLengthTotalM * 9.8).toFixed(2)),
      },
      {
        category: 'Sub-frame Framing',
        name: '100x100mm Radiata Pine H4 Bearers / Foundation',
        description: 'Ground-contact treated structural bearers for solid sub-floor support.',
        quantity: bearerLengthTotalM,
        unit: 'linear metres',
        estimatedUnitPriceNzd: 16.5,
        estimatedTotalPriceNzd: parseFloat((bearerLengthTotalM * 16.5).toFixed(2)),
      },
      {
        category: 'Fasteners & Fixings',
        name: '316 Marine Grade Stainless Steel Decking Screws (10g x 65mm)',
        description: 'Corrosion-resistant decking screws with Torx drive to prevent timber splitting.',
        quantity: screwBoxes,
        unit: 'box of 500',
        estimatedUnitPriceNzd: 74.5,
        estimatedTotalPriceNzd: parseFloat((screwBoxes * 74.5).toFixed(2)),
      },
      {
        category: 'Foundations & Concrete',
        name: 'Firth Rapid Set Concrete 20kg Bags',
        description: 'Fast-setting premixed concrete for setting deck foundation posts securely.',
        quantity: concreteBags,
        unit: '20kg bags',
        estimatedUnitPriceNzd: 13.9,
        estimatedTotalPriceNzd: parseFloat((concreteBags * 13.9).toFixed(2)),
      },
      {
        category: 'Hardware & Protection',
        name: 'Protecto Joist Tape / DPC Barrier 75mm x 25m',
        description: 'Waterproof self-adhesive flashing tape to protect top of timber joists from moisture rot.',
        quantity: Math.max(1, Math.ceil(joistLengthTotalM / 25)),
        unit: 'rolls',
        estimatedUnitPriceNzd: 38.0,
        estimatedTotalPriceNzd: parseFloat((Math.max(1, Math.ceil(joistLengthTotalM / 25)) * 38.0).toFixed(2)),
      },
    ];

    const totalEstimateNzd = parseFloat(materials.reduce((acc, m) => acc + m.estimatedTotalPriceNzd, 0).toFixed(2));

    return {
      ok: true,
      projectName: `${l}m × ${w}m ${material} Decking Materials Plan`,
      projectType: 'decking',
      dimensions: `${l}m × ${w}m (${area} m²)`,
      areaM2: area,
      materials,
      toolsNeeded: [
        'Compound Mitre Saw / Circular Saw',
        'Cordless Impact Driver & Drill Bits',
        'String Line & Line Level',
        'Spirit Level (1200mm)',
        'Tape Measure (8m)',
        'Safety Glasses & Hearing Protection',
      ],
      nzBuildingNotes: [
        heightM <= 1.5
          ? 'NZ Building Code: Decks under 1.5m high do NOT require a building consent, but must comply with NZS 3604.'
          : 'NZ Building Code Notice: Decks over 1.5m high require a building consent from your local council and safety barrier/handrail.',
        'Ground Clearance: Maintain at least 150mm ground clearance below timber framing for adequate sub-floor ventilation.',
        'Fixings Rule: Use 316 Stainless Steel fixings for timber containing high natural tannins (Kwila, Vitex) or within 500m of the coast.',
      ],
      totalEstimateNzd,
      currency: 'NZD',
      branchAvailability: {
        recommendedBranch: 'PlaceMakers Mt Wellington (Auckland)',
        status: 'In Stock',
        pickupTimeframe: 'Ready for 60-Minute Click & Collect or Next-Day Site Delivery',
      },
    };
  }

  /**
   * Calculate timber fencing materials plan
   * Standard 1.8m timber paling fence: 100x100 H4 posts @ 2.0m spacing, 3x 75x50 H3.2 rails, 150x19 H3.2 palings.
   */
  static calculateFencing(
    lengthM: number,
    heightM: number = 1.8,
    style: string = 'Timber Palings'
  ): ProjectPlanResult {
    const l = Math.max(1, lengthM);
    const h = Math.max(1.2, heightM);

    // Posts @ 2.0m spacing
    const postCount = Math.ceil(l / 2.0) + 1;
    const postLengthM = h >= 1.8 ? 2.7 : 2.4; // 1/3 buried into ground

    // Rails: 3 rails for >= 1.8m height, 2 rails for <= 1.5m
    const railsPerBay = h >= 1.8 ? 3 : 2;
    const totalRailsM = Math.ceil(l * railsPerBay * 1.1);

    // Palings (150mm width with 25mm overlap or batten = 125mm effective cover)
    const palingsCount = Math.ceil((l / 0.125) * 1.05);

    // Fasteners: 6 nails per paling (2 per rail)
    const nailCount = palingsCount * railsPerBay * 2;
    const nailBoxes = Math.ceil(nailCount / 1000);

    // Concrete: 2 bags per post
    const concreteBags = postCount * 2;

    const materials: MaterialItem[] = [
      {
        category: 'Fence Posts',
        name: `100x100mm Radiata Pine H4 Fence Posts (${postLengthM}m Length)`,
        description: 'Heavy duty H4 ground-contact treated square timber posts.',
        quantity: postCount,
        unit: 'posts',
        estimatedUnitPriceNzd: 32.5,
        estimatedTotalPriceNzd: parseFloat((postCount * 32.5).toFixed(2)),
      },
      {
        category: 'Fence Rails',
        name: '75x50mm Radiata Pine H3.2 Fence Rails (4.8m Lengths)',
        description: 'Kiln-dried treated structural timber rails spanning between fence posts.',
        quantity: Math.ceil(totalRailsM / 4.8),
        unit: '4.8m lengths',
        estimatedUnitPriceNzd: 18.2,
        estimatedTotalPriceNzd: parseFloat((Math.ceil(totalRailsM / 4.8) * 18.2).toFixed(2)),
      },
      {
        category: 'Fence Palings',
        name: `150x19mm Radiata Pine H3.2 Fence Palings (${h}m Length)`,
        description: 'Treated pine palings with rough sawn finish suitable for lap and cap or standard boundary fencing.',
        quantity: palingsCount,
        unit: 'palings',
        estimatedUnitPriceNzd: 4.8,
        estimatedTotalPriceNzd: parseFloat((palingsCount * 4.8).toFixed(2)),
      },
      {
        category: 'Foundations & Concrete',
        name: 'Firth Rapid Set Fence Post Concrete 20kg',
        description: 'Quick-setting concrete formulation for fast post anchoring without bracing.',
        quantity: concreteBags,
        unit: '20kg bags',
        estimatedUnitPriceNzd: 13.9,
        estimatedTotalPriceNzd: parseFloat((concreteBags * 13.9).toFixed(2)),
      },
      {
        category: 'Fasteners & Fixings',
        name: 'Paslode Hot Dipped Galvanised Fence Nails (65mm x 2.87mm, Box of 1000)',
        description: 'Rust-resistant hot dip galvanised ring shank nails for exterior timber fencing.',
        quantity: nailBoxes,
        unit: 'box of 1000',
        estimatedUnitPriceNzd: 42.0,
        estimatedTotalPriceNzd: parseFloat((nailBoxes * 42.0).toFixed(2)),
      },
    ];

    const totalEstimateNzd = parseFloat(materials.reduce((acc, m) => acc + m.estimatedTotalPriceNzd, 0).toFixed(2));

    return {
      ok: true,
      projectName: `${l}m × ${h}m ${style} Boundary Fencing Plan`,
      projectType: 'fencing',
      dimensions: `${l}m Length × ${h}m Height`,
      areaM2: l * h,
      materials,
      toolsNeeded: [
        'Post Hole Digger / Shovel',
        'String Line & Chalk',
        'Cordless Framing Nailer or Hammer',
        'Post Level & 1200mm Spirit Level',
        'Handsaw or Circular Saw',
        'Heavy-Duty Work Gloves',
      ],
      nzBuildingNotes: [
        h <= 2.0
          ? 'NZ Building Code: Boundary fences up to 2.0m high do NOT require a building consent in most NZ territorial authorities.'
          : 'Boundary Notice: Fences over 2.0m require local council consent.',
        'Post Depth: Dig post holes to at least 1/3 of the total post length (min 600mm depth for 1.8m fence) for wind load stability.',
        'Boundary Laws: Refer to the NZ Fencing Act 1978 for neighbour notification and shared cost sharing on boundary fences.',
      ],
      totalEstimateNzd,
      currency: 'NZD',
      branchAvailability: {
        recommendedBranch: 'PlaceMakers Cook Street (Auckland Central)',
        status: 'In Stock',
        pickupTimeframe: 'Ready for 60-Minute Click & Collect or Next-Day Hiab Delivery',
      },
    };
  }

  /**
   * Calculate Wall Lining & GIB plasterboard materials plan
   */
  static calculateWallLining(
    wallAreaM2: number,
    liningType: string = 'GIB Standard 10mm'
  ): ProjectPlanResult {
    const area = Math.max(5, wallAreaM2);
    // Standard GIB sheet is 2.4m x 1.2m = 2.88 m²
    const sheetCount = Math.ceil((area / 2.88) * 1.1); // 10% cutting allowance
    const screwCount = sheetCount * 45; // ~45 screws per sheet
    const screwBoxes = Math.ceil(screwCount / 500);
    const adhesiveTubes = Math.ceil(sheetCount / 3); // 1 tube per 3 sheets
    const compoundPails = Math.ceil(area / 25); // 1x 15kg pail per ~25 m²

    const isAqua = liningType.toLowerCase().includes('aqua') || liningType.toLowerCase().includes('wet');
    const sheetPrice = isAqua ? 48.5 : 31.0;

    const materials: MaterialItem[] = [
      {
        category: 'Plasterboard Sheets',
        name: isAqua ? 'GIB Aqualine 10mm Wet Area Plasterboard (2400 x 1200mm)' : 'GIB Standard 10mm Plasterboard (2400 x 1200mm)',
        description: isAqua
          ? 'Water-resistant plasterboard core engineered for bathroom and kitchen wet areas.'
          : 'High quality wall and ceiling lining board suitable for standard interior residential spaces.',
        quantity: sheetCount,
        unit: 'sheets',
        estimatedUnitPriceNzd: sheetPrice,
        estimatedTotalPriceNzd: parseFloat((sheetCount * sheetPrice).toFixed(2)),
      },
      {
        category: 'Fasteners & Adhesives',
        name: 'GIB Grabber Drywall Screws (32mm x 6g, Box of 500)',
        description: 'Fine thread drywall screws engineered for securing plasterboard to timber framing.',
        quantity: screwBoxes,
        unit: 'box of 500',
        estimatedUnitPriceNzd: 26.5,
        estimatedTotalPriceNzd: parseFloat((screwBoxes * 26.5).toFixed(2)),
      },
      {
        category: 'Fasteners & Adhesives',
        name: 'GIB Fix All-Bond Plasterboard Adhesive (375ml Cartridge)',
        description: 'High-strength structural adhesive reducing required screw density along studs.',
        quantity: adhesiveTubes,
        unit: 'cartridges',
        estimatedUnitPriceNzd: 14.2,
        estimatedTotalPriceNzd: parseFloat((adhesiveTubes * 14.2).toFixed(2)),
      },
      {
        category: 'Jointing & Finishing',
        name: 'GIB Plus 4 Jointing & Finishing Compound (15kg Pail)',
        description: 'Ready-mixed, lightweight compound for all 3 coats of plasterboard joint finishing.',
        quantity: compoundPails,
        unit: '15kg pail',
        estimatedUnitPriceNzd: 52.0,
        estimatedTotalPriceNzd: parseFloat((compoundPails * 52.0).toFixed(2)),
      },
      {
        category: 'Jointing & Finishing',
        name: 'GIB Paper Joint Tape (75m Roll)',
        description: 'Cross-fibre spark-perforated joint tape for maximum crack resistance along seams.',
        quantity: Math.max(1, Math.ceil(sheetCount / 10)),
        unit: 'rolls',
        estimatedUnitPriceNzd: 18.5,
        estimatedTotalPriceNzd: parseFloat((Math.max(1, Math.ceil(sheetCount / 10)) * 18.5).toFixed(2)),
      },
    ];

    const totalEstimateNzd = parseFloat(materials.reduce((acc, m) => acc + m.estimatedTotalPriceNzd, 0).toFixed(2));

    return {
      ok: true,
      projectName: `${area} m² ${liningType} Wall Lining Materials Plan`,
      projectType: 'lining',
      dimensions: `${area} m² Total Wall Surface Area`,
      areaM2: area,
      materials,
      toolsNeeded: [
        'Drywall / Utility Knife & Spare Blades',
        'Drywall T-Square (1200mm)',
        'Cordless Screwdriver with Dimple Bit',
        'Broad Knife (150mm & 250mm Finishing Trowel)',
        'Sanding Block & 180-Grit Sandpaper',
        'Dust Mask & Safety Goggles',
      ],
      nzBuildingNotes: [
        'NZ Building Code NZS 3604: Follow GIB site installation guide for fastener spacing (300mm centers on intermediate studs).',
        isAqua
          ? 'Wet Area Note: GIB Aqualine requires a certified waterproof membrane system under tiles in shower enclosures and wet areas.'
          : 'Fixing Rule: Ensure timber frame moisture content is below 18% before fixing plasterboard to avoid nail popping.',
      ],
      totalEstimateNzd,
      currency: 'NZD',
      branchAvailability: {
        recommendedBranch: 'PlaceMakers Albany (North Shore)',
        status: 'In Stock',
        pickupTimeframe: 'Ready for 60-Minute Click & Collect or Next-Day Van Delivery',
      },
    };
  }

  /**
   * Calculate complete PlaceMakers Laundry Room Makeover package
   * Includes 5 trades: Modular Cabinetry Suite, Deep Laundry Tub & Benchtop, Gooseneck Tapware & Waste, GIB Aqualine Moisture Linings, and Pull-out Laundry Accessories.
   */
  static calculateLaundryRoom(
    wallWidthM: number = 2.0,
    style: string = 'Modern White Gloss',
    budgetNzd: number = 5000
  ): ProjectPlanResult {
    const w = Math.max(1.2, wallWidthM || 2.0);
    const materials: MaterialItem[] = [
      {
        category: 'Cabinetry & Modular Storage',
        name: `Modern Laundry Modular Base Cabinet 600mm (2 Soft-Close Drawers, ${style})`,
        sku: '7834115',
        description: 'Moisture-resistant 16mm HMR carcass with Blum soft-close drawer runners for heavy detergent storage.',
        quantity: 1,
        unit: 'unit',
        estimatedUnitPriceNzd: 580,
        estimatedTotalPriceNzd: 580,
      },
      {
        category: 'Cabinetry & Modular Storage',
        name: `Modular Base Single Door Cabinet 450mm (${style})`,
        sku: '7834112',
        description: 'Compact base cupboard with adjustable shelf for plumbing access and bucket storage.',
        quantity: 1,
        unit: 'unit',
        estimatedUnitPriceNzd: 420,
        estimatedTotalPriceNzd: 420,
      },
      {
        category: 'Cabinetry & Modular Storage',
        name: `Overhead Wall Cabinet 900mm (Double Soft-Close Doors, ${style})`,
        sku: '7834225',
        description: 'Double overhead wall storage with concealed mounting rail and 2 adjustable shelves.',
        quantity: 1,
        unit: 'unit',
        estimatedUnitPriceNzd: 520,
        estimatedTotalPriceNzd: 520,
      },
      {
        category: 'Cabinetry & Modular Storage',
        name: `Tall Broom & Linen Storage Tower 600mm (2100mm Full Height)`,
        sku: '7834330',
        description: 'Full-height utility tower with dedicated broom slot, ironing board divider, and upper linen shelving.',
        quantity: 1,
        unit: 'unit',
        estimatedUnitPriceNzd: 890,
        estimatedTotalPriceNzd: 890,
      },
      {
        category: 'Laundry Tubs & Benchtops',
        name: 'White Kordura Solid Surface Seamless Benchtop (20mm, Custom Cut)',
        sku: 'BENCH-KORD-2000',
        description: 'Non-porous, antibacterial solid surface benchtop pre-rebated for undermount tub.',
        quantity: 1,
        unit: 'benchtop',
        estimatedUnitPriceNzd: 420,
        estimatedTotalPriceNzd: 420,
      },
      {
        category: 'Laundry Tubs & Benchtops',
        name: 'Robinhood SuperTub Deep Stainless Steel Laundry Tub & Sink (45L Capacity)',
        sku: '7834650',
        description: 'High-grade 304 stainless steel deep tub with side bypass waste for washing machine discharge.',
        quantity: 1,
        unit: 'tub',
        estimatedUnitPriceNzd: 640,
        estimatedTotalPriceNzd: 640,
      },
      {
        category: 'Tapware & Plumbing',
        name: 'High-Arch Gooseneck Pull-Out Spray Laundry Sink Mixer (Matte Black / Chrome)',
        sku: '7834880',
        description: 'WELS 4-Star (7.5L/min) swivel gooseneck mixer with dual spray pull-out aerator for easy tub cleaning.',
        quantity: 1,
        unit: 'mixer',
        estimatedUnitPriceNzd: 320,
        estimatedTotalPriceNzd: 320,
      },
      {
        category: 'Tapware & Plumbing',
        name: 'Dual Appliance Washing Machine Mini Ball Stop Taps & Waste Trap Kit',
        sku: 'PLUMB-WASH-KIT',
        description: 'Quarter-turn ceramic disc washing machine isolation valves and anti-siphon waste kit.',
        quantity: 1,
        unit: 'kit',
        estimatedUnitPriceNzd: 115,
        estimatedTotalPriceNzd: 115,
      },
      {
        category: 'Wet Wall Linings & Waterproofing',
        name: 'GIB Aqualine 10mm Moisture-Resistant Plasterboard (2400 x 1200mm, 4 Sheets)',
        sku: 'GIB-AQUA-10-4PK',
        description: 'Water-resistant core wall lining preventing mould and moisture ingress behind laundry wet zone.',
        quantity: 4,
        unit: 'sheets',
        estimatedUnitPriceNzd: 48.5,
        estimatedTotalPriceNzd: 194,
      },
      {
        category: 'Wet Wall Linings & Waterproofing',
        name: 'AquaStop Wet Area Waterproofing Under-tile Membrane Kit (15L + Bandage)',
        sku: 'AQUA-MEM-15L',
        description: 'Class III high-extensibility liquid waterproofing membrane complying with AS/NZS 4858.',
        quantity: 1,
        unit: 'kit',
        estimatedUnitPriceNzd: 185,
        estimatedTotalPriceNzd: 185,
      },
      {
        category: 'Accessories & Storage',
        name: 'Concealed Pull-Out Twin Laundry Hamper (2 x 35L Bins, Soft-Close)',
        sku: '7834910',
        description: 'Integrated base unit hamper on smooth undermount runners for sorting whites and colours.',
        quantity: 1,
        unit: 'unit',
        estimatedUnitPriceNzd: 280,
        estimatedTotalPriceNzd: 280,
      },
    ];

    const totalEstimateNzd = parseFloat(materials.reduce((acc, m) => acc + m.estimatedTotalPriceNzd, 0).toFixed(2));

    return {
      ok: true,
      projectName: `Complete PlaceMakers ${w.toFixed(1)}m Laundry Room Makeover Package`,
      projectType: 'laundry' as any,
      dimensions: `${w.toFixed(1)}m Wall Run (Full Multi-Trade Solution)`,
      areaM2: parseFloat((w * 2.4).toFixed(1)),
      materials,
      toolsNeeded: [
        'Cordless Drill & Driver Set (with 35mm hinge bit)',
        'Spirit Level (1200mm) & Stud Finder',
        'Caulking Gun (for sanitary silicone & adhesive)',
        'Adjustable Pipe Wrench & PTFE Thread Tape',
        'Jigsaw or Circular Saw (for benchtop cutouts)',
        'Heavy-Duty Dust Mask & Protective Eye Wear',
      ],
      nzBuildingNotes: [
        'NZ Building Code E3/AS1 (Internal Moisture): Laundry wet splashback zones require impervious wall linings (GIB Aqualine).',
        'AS/NZS 3500.2 (Sanitary Plumbing & Drainage): Washing machine waste pipe must terminate into an approved trapped waste or tundish.',
        'Electrical Safety: Ensure GPOs (power sockets) maintain at least 300mm horizontal separation from open water sources / tub rim.',
      ],
      totalEstimateNzd,
      currency: 'NZD',
      branchAvailability: {
        recommendedBranch: 'PlaceMakers Mt Wellington (Auckland)',
        status: 'In Stock',
        pickupTimeframe: 'Ready for 60-Minute Click & Collect or Next-Day Hiab Site Delivery',
      },
    };
  }
}
