/**
 * PlaceMakers Space Planner Domain Logic & Multi-Trade Room Catalogues
 *
 * Defines room-type component catalogs, default layouts, NZBC E3/AS1 isolation rules,
 * accessory safety filtering, and quantity calculations.
 */

import {
  SpacePlannerExtension,
  validateRoomLayoutAgainstPack,
  validateAccessoryCompatibilityAgainstPack,
  calculateMaterialQuantityFromPack,
} from '@journeyax/business-pack';

export const ROOM_TYPES = ['laundry', 'kitchen', 'bathroom', 'utility'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export interface CabinetItem {
  id: string;
  name: string;
  category: 'base' | 'overhead' | 'tall' | 'appliance' | 'tub' | 'lining';
  widthMm: number;
  heightMm: number;
  depthMm: number;
  priceNzd: number;
  sku: string;
  description: string;
  imageUrl: string;
  colorHex?: string;
  roomTypes?: RoomType[];
}

export interface RoomPlacedItem {
  uid: string;
  item: {
    id: string;
    name: string;
    category: 'base' | 'overhead' | 'tall' | 'appliance' | 'tub' | 'lining';
    widthMm: number;
    heightMm: number;
    depthMm: number;
    priceNzd: number;
    sku: string;
    imageUrl?: string;
  };
  quantity?: number;
}

export const PM_IMAGE_BASE =
  'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj';

export const IMG_LAUNDRY_KIT_600 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQ1MTl8aW1hZ2UvanBlZ3xhR1kxTDJneVpDOHhOekF5TXpBNU5UVXdORGt5Tmk4ek1EQlhlRE13TUVoZmJuVnNiQXwyZWQ0MDU4ZTRlOWMyOWViZTEwYmU5M2IxM2I1MzMxNzI4MjY2YTQzYjBjNTZkYmVlOTk3Zjk4MzdhODQ1ZDE0';
export const IMG_BASE_450_DOOR = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRFV3TDJoa01pOHhOekF5TXpFd016TXdNemN4TUM4ek1EQlhlRE13TUVoZmJuVnNiQXxkODdmZDM4YTlhMGY5MzVlYTgzNTRhMzUwNDY2N2ZhZWNiMzgzMTdkNzNhNjgxY2VlZDUzOGEzZmQ1ODhlNGY3';
export const IMG_BASE_600_DRAWERS = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDU2NDd8aW1hZ2UvanBlZ3xhRGxrTDJnMFpTOHhOalU1TURZeU1UWTNNVFExTkM4ek1EQlhlRE13TUVoZmJuVnNiQXwyMzI0MmEyMzNjMmM3ODJmMjBiZjQ2M2ZhZWIyN2Y2NjI2YjNhZDczYjhiZDkyOWNlMGNhMjIzN2MwOTM5MmIz';
export const IMG_ROBINHOOD_SUPERTUB = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDUyOTl8aW1hZ2UvanBlZ3xhR00yTDJneFppOHhOekl3TWpFek1ERXlORGd6TUM4ek1EQlhlRE13TUVoZmJuVnNiQXwxZmY1NTkyNGJmYjM1OWEwNWU5NzQ3OTdhYTU1ODAwM2NhNTNiOWQwZGE5OTYzYzgwYjMxMmM5MjVmNTVkM2My';
export const IMG_APPLIANCE_SPACE = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDEwMDEwfGltYWdlL2pwZWd8YUdSa0wyZzBNaTh4Tmpjek5ERTFOakk1TWpFeU5pOHpNREJYZURNd01FaGZiblZzYkF8N2Y3MWY2NjFmOGQ3NzEzM2M1MDEzOTA3MTQyYzliMDNhZDU1OWVlZGQ2NDYzZmU0ZjVjZmUzNDI4ODVmZDcyMw';
export const IMG_OVERHEAD_600 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDUwMDB8aW1hZ2UvanBlZ3xhRFJpTDJoaVl5OHhOalUyT0Rnek5qVXlNakF4TkM4ek1EQlhlRE13TUVoZmJuVnNiQXwwYzRiMzdlNjgzZTBlNDZkMTNmZmI3ZDlmOGUyMzRjNWYzNDU1YmE0NjZhOTQ2NjA3MzI1MDJhODlmMTJlNjY1';
export const IMG_OVERHEAD_900 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDE0NDk1fGltYWdlL2pwZWd8YUdRNEwyZzBNQzh4TlRrM09ETTBNVFEyTmpFME1pOHpNREJYZURNd01FaGZiblZzYkF8MDdkN2IzNDgwYjFmMDJhYWRhNjNjMjllYmNlODVjMjU0YmFhZWY1Mjc3YjhmYWU0MmFiOWUzNzdmOWI5ZTQ3OA';
export const IMG_TALL_TOWER = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQ3Mzl8aW1hZ2UvanBlZ3xhREEzTDJnd1pDOHhOalUyT0RJM056TTJPRGcyTWk4ek1EQlhlRE13TUVoZmJuVnNiQXxiOTVhYTlkNzdiOGEzY2EyOWNjOGE0NWI0MTBmZGY0Y2ZmNTczMzU0YTlhODgxYjg0OTc1ZjlhMjJhYWNkN2Yz';
export const IMG_VANITY_900 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDI2NjJ8aW1hZ2UvanBlZ3xhRE00TDJneU5DOHhOVFF3TXpRMk5UQTBPREE1TkM4ek1EQlhlRE13TUVoZmJuVnNiQXxjMWI5ZjA4OWFmMjM0ZjEyMTQ0NjZiNzRjZjcxMmU3OGIyNDY1NzIyZmJkMWM3Yjc3MjhmZDc3ZDc0ZDlhMmI0';
export const IMG_VANITY_600 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDE0ODEzfGltYWdlL2pwZWd8YURCbUwyZzNaUzh4TlRFNE56YzVORGM0T0RNNE1pOHpNREJYZURNd01FaGZiblZzYkF8NzI0YjdjNTI2Nzk1MTEyMjVkOTA4NTY4NGM5ZjUwMjc4ZWQ2NGFlNzVjNjJhZTYyYmI3MThkOTViZjVmMmRhNQ';
export const IMG_VANITY_1200 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDE1NTY4fGltYWdlL2pwZWd8YURKaEwyZzBNUzh4TlRFNE56YzRPVGMwTWpFeE1DOHpNREJYZURNd01FaGZiblZzYkF8YzQwMjdjMzU5ZjFjNDgyYTNkMTViMTU5MjM2ODg2YTIzMmUyODQyMDc0ZGZmZTU5ODNiYTM5NTAzZDdjM2FmZg';
export const IMG_GIB_AQUALINE = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDI0MTY3fGltYWdlL2pwZWd8YURneEwyZ3pPUzh4TnpBNU1ERTVOelUxTXpFNE1pOHpNREJYZURNd01FaGZiblZzYkF8YTJkMjRkMmFmMzJjZDljMmJmM2RjYTE1NDk5MDEwNDI0NDk0ZTIyYmRmNGIxYjliNzFmYzExNWMwZmMyMzQwNw';

/** Pack-defined component catalogues per room type.
 *  Crucial rule: A bathroom must NEVER inherit laundry products (e.g. SuperTub, washer cavities).
 */
export const ROOM_CATALOGS: Record<RoomType, CabinetItem[]> = {
  laundry: [
    {
      id: 'laundry-kit-600',
      name: 'Modern Laundry Starter Kit 600 (2 Drawers, Kordura Top & Sink)',
      category: 'base',
      widthMm: 600,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 2286,
      sku: '7834654',
      description: 'White Kordura solid top with integrated stainless steel sink and 2 soft-close drawers.',
      imageUrl: IMG_LAUNDRY_KIT_600,
      roomTypes: ['laundry'],
    },
    {
      id: 'robinhood-supertub-45',
      name: 'Robinhood SuperTub Standard 45L Stainless Tub with Gooseneck Tap',
      category: 'tub',
      widthMm: 560,
      heightMm: 900,
      depthMm: 560,
      priceNzd: 1149,
      sku: '7846476',
      description: 'Deep 45-litre stainless bowl with internal washing machine bypass ports and mixer.',
      imageUrl: IMG_ROBINHOOD_SUPERTUB,
      roomTypes: ['laundry'],
    },
    {
      id: 'appliance-space-600',
      name: 'Under-bench Washer / Dryer Cavity (600mm)',
      category: 'appliance',
      widthMm: 600,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 0,
      sku: 'APP-CAV-600',
      description: 'Dedicated under-bench opening for front loader washing machine or condenser dryer.',
      imageUrl: IMG_APPLIANCE_SPACE,
      roomTypes: ['laundry'],
    },
    {
      id: 'base-450-door',
      name: 'Modular Base Cabinet 450mm (Single Door)',
      category: 'base',
      widthMm: 450,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 420,
      sku: '7834112',
      description: 'Moisture-resistant 16mm HMR carcass with adjustable shelf and soft-close Blum hinges.',
      imageUrl: IMG_BASE_450_DOOR,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'base-600-drawers',
      name: 'Modular Base Cabinet 600mm (2 Deep Drawers)',
      category: 'base',
      widthMm: 600,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 580,
      sku: '7834115',
      description: 'Heavy-duty soft-close drawers with 35kg load capacity for laundry supplies.',
      imageUrl: IMG_BASE_600_DRAWERS,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'overhead-600',
      name: 'Overhead Wall Cabinet 600mm (Double Doors)',
      category: 'overhead',
      widthMm: 600,
      heightMm: 720,
      depthMm: 350,
      priceNzd: 380,
      sku: '7834220',
      description: 'Wall-mounted storage unit with 2 adjustable shelves and concealed mounting brackets.',
      imageUrl: IMG_OVERHEAD_600,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'overhead-900',
      name: 'Overhead Wall Cabinet 900mm (Double Doors)',
      category: 'overhead',
      widthMm: 900,
      heightMm: 720,
      depthMm: 350,
      priceNzd: 520,
      sku: '7834225',
      description: 'Wide wall cabinet with soft-close doors and high-capacity storage.',
      imageUrl: IMG_OVERHEAD_900,
      roomTypes: ['laundry', 'kitchen'],
    },
    {
      id: 'tall-tower-600',
      name: 'Tall Broom & Linen Tower 600mm (2100mm Height)',
      category: 'tall',
      widthMm: 600,
      heightMm: 2100,
      depthMm: 600,
      priceNzd: 890,
      sku: '7834330',
      description: 'Full-height cabinet with broom divider, ironing board slot, and top linen shelving.',
      imageUrl: IMG_TALL_TOWER,
      roomTypes: ['laundry', 'utility'],
    },
    {
      id: 'gib-aqualine-10',
      name: 'GIB Aqualine 10mm Plasterboard 2400 x 1200mm (2.88 m²)',
      category: 'lining',
      widthMm: 1200,
      heightMm: 2400,
      depthMm: 10,
      priceNzd: 46.50,
      sku: '2801884',
      description: 'Mandatory moisture-resistant wet area plasterboard with water-resistant core wax additive (NZBC E3/AS1).',
      imageUrl: IMG_GIB_AQUALINE,
      roomTypes: ['laundry', 'bathroom', 'kitchen', 'utility'],
    },
  ],
  bathroom: [
    {
      id: 'vanity-900-wall',
      name: 'Valencia Wall-Hung Vanity 900mm Single Bowl White',
      category: 'base',
      widthMm: 900,
      heightMm: 470,
      depthMm: 465,
      priceNzd: 1529.01,
      sku: '3601297',
      description: 'Modern moisture-resistant wall-hung bathroom vanity with integrated basin and deep soft-close drawers.',
      imageUrl: IMG_VANITY_900,
      roomTypes: ['bathroom'],
    },
    {
      id: 'vanity-600-wall',
      name: 'Valencia Wall-Hung Vanity 600mm Single Bowl White',
      category: 'base',
      widthMm: 600,
      heightMm: 470,
      depthMm: 465,
      priceNzd: 1029.00,
      sku: '3601299',
      description: 'Compact 600mm wall-hung vanity with vitreous basin and soft-close storage for en-suites and small bathrooms.',
      imageUrl: IMG_VANITY_600,
      roomTypes: ['bathroom'],
    },
    {
      id: 'vanity-1200-wall',
      name: 'Valencia Wall-Hung Vanity 1200mm Single Bowl White',
      category: 'base',
      widthMm: 1200,
      heightMm: 470,
      depthMm: 465,
      priceNzd: 1949.00,
      sku: '3601296',
      description: 'Generous 1200mm single bowl wall-hung vanity offering expansive bench space and double drawer storage.',
      imageUrl: IMG_VANITY_1200,
      roomTypes: ['bathroom'],
    },
    {
      id: 'shaving-cab-600',
      name: 'Shaving Cabinet & Overhead Mirror 600mm',
      category: 'overhead',
      widthMm: 600,
      heightMm: 720,
      depthMm: 150,
      priceNzd: 380,
      sku: '7834220',
      description: 'Concealed wall-mounted mirrored shaving cabinet with moisture-resistant carcass and internal shelves.',
      imageUrl: IMG_OVERHEAD_600,
      roomTypes: ['bathroom'],
    },
    {
      id: 'tall-linen-450',
      name: 'Tall Bathroom Linen Tower 450mm (2100mm Height)',
      category: 'tall',
      widthMm: 450,
      heightMm: 2100,
      depthMm: 450,
      priceNzd: 890,
      sku: '7834330',
      description: 'Full-height slimline linen tower with adjustable shelving for towel and toiletry storage.',
      imageUrl: IMG_TALL_TOWER,
      roomTypes: ['bathroom'],
    },
    {
      id: 'gib-aqualine-10',
      name: 'GIB Aqualine 10mm Plasterboard 2400 x 1200mm (2.88 m²)',
      category: 'lining',
      widthMm: 1200,
      heightMm: 2400,
      depthMm: 10,
      priceNzd: 46.50,
      sku: '2801884',
      description: 'Mandatory moisture-resistant wet area plasterboard with water-resistant core wax additive (NZBC E3/AS1).',
      imageUrl: IMG_GIB_AQUALINE,
      roomTypes: ['laundry', 'bathroom', 'kitchen', 'utility'],
    },
  ],
  kitchen: [
    {
      id: 'base-450-door',
      name: 'Modular Base Cabinet 450mm (Single Door)',
      category: 'base',
      widthMm: 450,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 420,
      sku: '7834112',
      description: 'Moisture-resistant 16mm HMR carcass with adjustable shelf and soft-close Blum hinges.',
      imageUrl: IMG_BASE_450_DOOR,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'base-600-drawers',
      name: 'Modular Base Cabinet 600mm (2 Deep Drawers)',
      category: 'base',
      widthMm: 600,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 580,
      sku: '7834115',
      description: 'Heavy-duty soft-close drawers with 35kg load capacity for kitchen cookware.',
      imageUrl: IMG_BASE_600_DRAWERS,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'dishwasher-space-600',
      name: 'Under-bench Dishwasher Cavity (600mm)',
      category: 'appliance',
      widthMm: 600,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 0,
      sku: 'APP-CAV-600',
      description: 'Standard 600mm under-bench space for integrated or freestanding dishwasher.',
      imageUrl: IMG_APPLIANCE_SPACE,
      roomTypes: ['kitchen'],
    },
    {
      id: 'overhead-600',
      name: 'Overhead Wall Cabinet 600mm (Double Doors)',
      category: 'overhead',
      widthMm: 600,
      heightMm: 720,
      depthMm: 350,
      priceNzd: 380,
      sku: '7834220',
      description: 'Wall-mounted storage unit with 2 adjustable shelves.',
      imageUrl: IMG_OVERHEAD_600,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'overhead-900',
      name: 'Overhead Wall Cabinet 900mm (Double Doors)',
      category: 'overhead',
      widthMm: 900,
      heightMm: 720,
      depthMm: 350,
      priceNzd: 520,
      sku: '7834225',
      description: 'Wide wall cabinet with soft-close doors.',
      imageUrl: IMG_OVERHEAD_900,
      roomTypes: ['laundry', 'kitchen'],
    },
    {
      id: 'tall-pantry-600',
      name: 'Tall Kitchen Pantry Tower 600mm (2100mm Height)',
      category: 'tall',
      widthMm: 600,
      heightMm: 2100,
      depthMm: 600,
      priceNzd: 890,
      sku: '7834330',
      description: 'Full-height 2100mm pantry cabinet with heavy duty shelves for dry goods.',
      imageUrl: IMG_TALL_TOWER,
      roomTypes: ['kitchen'],
    },
    {
      id: 'gib-aqualine-10',
      name: 'GIB Aqualine 10mm Plasterboard 2400 x 1200mm (2.88 m²)',
      category: 'lining',
      widthMm: 1200,
      heightMm: 2400,
      depthMm: 10,
      priceNzd: 46.50,
      sku: '2801884',
      description: 'Moisture-resistant wet area plasterboard for splashback zones (NZBC E3/AS1).',
      imageUrl: IMG_GIB_AQUALINE,
      roomTypes: ['laundry', 'bathroom', 'kitchen', 'utility'],
    },
  ],
  utility: [
    {
      id: 'base-450-door',
      name: 'Modular Base Cabinet 450mm (Single Door)',
      category: 'base',
      widthMm: 450,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 420,
      sku: '7834112',
      description: 'Moisture-resistant 16mm HMR carcass with adjustable shelf.',
      imageUrl: IMG_BASE_450_DOOR,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'base-600-drawers',
      name: 'Modular Base Cabinet 600mm (2 Deep Drawers)',
      category: 'base',
      widthMm: 600,
      heightMm: 900,
      depthMm: 600,
      priceNzd: 580,
      sku: '7834115',
      description: 'Heavy-duty soft-close drawers for utility storage.',
      imageUrl: IMG_BASE_600_DRAWERS,
      roomTypes: ['laundry', 'kitchen', 'utility'],
    },
    {
      id: 'tall-tower-600',
      name: 'Tall Storage Tower 600mm (2100mm Height)',
      category: 'tall',
      widthMm: 600,
      heightMm: 2100,
      depthMm: 600,
      priceNzd: 890,
      sku: '7834330',
      description: 'Full-height utility cabinet.',
      imageUrl: IMG_TALL_TOWER,
      roomTypes: ['utility'],
    },
    {
      id: 'overhead-600',
      name: 'Overhead Wall Cabinet 600mm (Double Doors)',
      category: 'overhead',
      widthMm: 600,
      heightMm: 720,
      depthMm: 350,
      priceNzd: 380,
      sku: '7834220',
      description: 'Wall-mounted storage unit.',
      imageUrl: IMG_OVERHEAD_600,
      roomTypes: ['utility'],
    },
    {
      id: 'gib-aqualine-10',
      name: 'GIB Aqualine 10mm Plasterboard 2400 x 1200mm (2.88 m²)',
      category: 'lining',
      widthMm: 1200,
      heightMm: 2400,
      depthMm: 10,
      priceNzd: 46.50,
      sku: '2801884',
      description: 'Moisture-resistant plasterboard (NZBC E3/AS1).',
      imageUrl: IMG_GIB_AQUALINE,
      roomTypes: ['utility'],
    },
  ],
};

export function getDefaultPlacedItems(r: RoomType): RoomPlacedItem[] {
  const cat = ROOM_CATALOGS[r] || ROOM_CATALOGS.laundry;
  if (r === 'bathroom') {
    const vanity = cat.find((i) => i.id === 'vanity-900-wall') || cat[0];
    const shaving = cat.find((i) => i.id === 'shaving-cab-600');
    const tower = cat.find((i) => i.id === 'tall-linen-450');
    const lining = cat.find((i) => i.id === 'gib-aqualine-10');
    const items: RoomPlacedItem[] = [];
    if (vanity) items.push({ uid: `bath-vanity-${Date.now()}-1`, item: vanity, quantity: 1 });
    if (shaving) items.push({ uid: `bath-shaving-${Date.now()}-2`, item: shaving, quantity: 1 });
    if (tower) items.push({ uid: `bath-tower-${Date.now()}-3`, item: tower, quantity: 1 });
    // Req 4: For demonstrated 7 m² wet area, 3 panels (7 m² / 2.88 m² = 2.43 -> 3 panels)
    if (lining) items.push({ uid: `bath-lining-${Date.now()}-4`, item: lining, quantity: 3 });
    return items;
  }
  if (r === 'kitchen') {
    const b600 = cat.find((i) => i.id === 'base-600-drawers') || cat[0];
    const dw = cat.find((i) => i.id === 'dishwasher-space-600');
    const b450 = cat.find((i) => i.id === 'base-450-door');
    const o900 = cat.find((i) => i.id === 'overhead-900');
    const lining = cat.find((i) => i.id === 'gib-aqualine-10');
    const items: RoomPlacedItem[] = [];
    if (b600) items.push({ uid: `kitch-b600-${Date.now()}-1`, item: b600, quantity: 1 });
    if (dw) items.push({ uid: `kitch-dw-${Date.now()}-2`, item: dw, quantity: 1 });
    if (b450) items.push({ uid: `kitch-b450-${Date.now()}-3`, item: b450, quantity: 1 });
    if (o900) items.push({ uid: `kitch-o900-${Date.now()}-4`, item: o900, quantity: 1 });
    if (lining) items.push({ uid: `kitch-lining-${Date.now()}-5`, item: lining, quantity: 3 });
    return items;
  }
  if (r === 'utility') {
    const b450 = cat.find((i) => i.id === 'base-450-door') || cat[0];
    const b600 = cat.find((i) => i.id === 'base-600-drawers');
    const o600 = cat.find((i) => i.id === 'overhead-600');
    const tower = cat.find((i) => i.id === 'tall-tower-600');
    const lining = cat.find((i) => i.id === 'gib-aqualine-10');
    const items: RoomPlacedItem[] = [];
    if (b450) items.push({ uid: `util-b450-${Date.now()}-1`, item: b450, quantity: 1 });
    if (b600) items.push({ uid: `util-b600-${Date.now()}-2`, item: b600, quantity: 1 });
    if (o600) items.push({ uid: `util-o600-${Date.now()}-3`, item: o600, quantity: 1 });
    if (tower) items.push({ uid: `util-tower-${Date.now()}-4`, item: tower, quantity: 1 });
    if (lining) items.push({ uid: `util-lining-${Date.now()}-5`, item: lining, quantity: 3 });
    return items;
  }
  // default laundry
  const kit = cat.find((i) => i.id === 'laundry-kit-600') || cat[0];
  const app = cat.find((i) => i.id === 'appliance-space-600');
  const b450 = cat.find((i) => i.id === 'base-450-door');
  const o900 = cat.find((i) => i.id === 'overhead-900');
  const lining = cat.find((i) => i.id === 'gib-aqualine-10');
  const items: RoomPlacedItem[] = [];
  if (kit) items.push({ uid: `laundry-kit-${Date.now()}-1`, item: kit, quantity: 1 });
  if (app) items.push({ uid: `laundry-app-${Date.now()}-2`, item: app, quantity: 1 });
  if (b450) items.push({ uid: `laundry-b450-${Date.now()}-3`, item: b450, quantity: 1 });
  if (o900) items.push({ uid: `laundry-o900-${Date.now()}-4`, item: o900, quantity: 1 });
  if (lining) items.push({ uid: `laundry-lining-${Date.now()}-5`, item: lining, quantity: 3 });
  return items;
}

export function validateRoomLayout(
  items: RoomPlacedItem[],
  currentRoom: RoomType,
  packExtension?: SpacePlannerExtension
): string[] {
  const errors: string[] = [];

  if (packExtension) {
    const packErrors = validateRoomLayoutAgainstPack(
      items.map((p) => ({
        sku: p.item.sku,
        category: p.item.category,
        componentId: p.item.id,
        quantity: p.quantity,
      })),
      currentRoom,
      packExtension
    );
    if (packErrors.length > 0) {
      if (currentRoom === 'bathroom') {
        const laundry = items.find(
          (p) =>
            p.item.category === 'tub' ||
            p.item.sku === '7846476' ||
            p.item.sku === '7834654' ||
            p.item.id === 'appliance-space-600' ||
            p.item.id === 'robinhood-supertub-45'
        );
        if (laundry) {
          errors.push(
            `A bathroom must never inherit laundry products: "${laundry.item.name}" (${laundry.item.sku}) is prohibited in bathroom layouts.`
          );
        }
      }
      errors.push(...packErrors);
      return errors;
    }
  }

  const laundrySkus = new Set(['7834654', '7846476', '7846479', 'APP-CAV-600', '7001402', 'PM-CAV-650']);
  
  if (currentRoom === 'bathroom') {
    for (const p of items) {
      if (
        laundrySkus.has(p.item.sku) ||
        p.item.category === 'tub' ||
        p.item.id === 'appliance-space-600' ||
        p.item.id === 'laundry-kit-600' ||
        p.item.id === 'robinhood-supertub-45'
      ) {
        errors.push(
          `A bathroom must never inherit laundry products: "${p.item.name}" (${p.item.sku}) is prohibited in bathroom layouts.`,
        );
      }
    }
  }
  return errors;
}

export interface AccessoryItem {
  id: string;
  name: string;
  sku: string;
  priceNzd: number;
  reason: string;
  category: CabinetItem['category'] | 'all';
  systemType: 'interior_wet' | 'general_hardware' | 'exterior_barrier';
  compatibleRooms: RoomType[];
  manufacturerMapping?: string;
}

export const MASTER_ACCESSORIES: AccessoryItem[] = [
  {
    id: 'silicone-sealant',
    name: 'Sanitary Silicone Sealant (Clear, 300ml)',
    sku: '7712045',
    priceNzd: 18.5,
    reason: 'Seals vanity, basin, tub and wet area joins (NZBC E3/AS1)',
    category: 'all',
    systemType: 'interior_wet',
    compatibleRooms: ['bathroom', 'laundry', 'kitchen', 'utility'],
    manufacturerMapping: 'Selleys Wet Area Silicone',
  },
  {
    id: 'p-trap-basin',
    name: 'Eurostyle Bottle Trap 32mm / 40mm Inlet',
    sku: '3649999',
    priceNzd: 159.33,
    reason: 'NZBC G13 compliant chrome bottle trap for bathroom vanity basin',
    category: 'base',
    systemType: 'interior_wet',
    compatibleRooms: ['bathroom'],
    manufacturerMapping: 'Aqualine Eurostyle Sanitary Waste',
  },
  {
    id: 'p-trap-kit',
    name: 'P-Trap Waste & Overflow Kit',
    sku: '7712310',
    priceNzd: 34.9,
    reason: 'Connects laundry tub or kitchen sink waste to drainage',
    category: 'tub',
    systemType: 'interior_wet',
    compatibleRooms: ['laundry', 'kitchen', 'utility'],
  },
  {
    id: 'gib-joint-tape',
    name: 'GIB Paper Jointing Tape 52mm x 150m Roll',
    sku: '2801181',
    priceNzd: 26.9,
    reason: 'Certified interior drywall jointing tape for GIB Aqualine moisture systems',
    category: 'lining',
    systemType: 'interior_wet',
    compatibleRooms: ['bathroom', 'laundry', 'kitchen', 'utility'],
    manufacturerMapping: 'GIB Interior Aqualine Jointing System',
  },
  {
    id: 'gib-roctape',
    name: 'GIB RocTape Matt Fibreglass Jointing Tape 50mm x 75m',
    sku: '2801182',
    priceNzd: 14.57,
    reason: 'Fibreglass joint tape for moisture-resistant interior wet wall linings',
    category: 'lining',
    systemType: 'interior_wet',
    compatibleRooms: ['bathroom', 'laundry', 'kitchen', 'utility'],
    manufacturerMapping: 'GIB Interior Aqualine Jointing System',
  },
  {
    id: 'wp-membrane-kit',
    name: 'Certified Under-Tile Wet Area Waterproofing Membrane Kit 15L',
    sku: 'WP-MEMB-KIT',
    priceNzd: 245.0,
    reason: 'AS/NZS 4858 Class III wet area membrane mandatory under bathroom tiles',
    category: 'lining',
    systemType: 'interior_wet',
    compatibleRooms: ['bathroom', 'laundry'],
    manufacturerMapping: 'Certified Wet Area Tanking System',
  },
  {
    id: 'fixing-screws',
    name: 'Cabinet Fixing Screw Pack (100pk)',
    sku: '7834900',
    priceNzd: 12.9,
    reason: 'Secures base and tall cabinets to wall framing studs',
    category: 'base',
    systemType: 'general_hardware',
    compatibleRooms: ['bathroom', 'laundry', 'kitchen', 'utility'],
  },
  {
    id: 'construction-adhesive',
    name: 'No More Nails Construction Adhesive',
    sku: '7834901',
    priceNzd: 14.2,
    reason: 'Extra bond for vanity top and cabinet-to-wall fixing',
    category: 'base',
    systemType: 'general_hardware',
    compatibleRooms: ['bathroom', 'laundry', 'kitchen', 'utility'],
  },
  {
    id: 'wall-brackets',
    name: 'Heavy-Duty Wall Cabinet Brackets (Pair)',
    sku: '7834902',
    priceNzd: 22.4,
    reason: 'Rated wall fixing brackets to carry overhead and shaving cabinet load',
    category: 'overhead',
    systemType: 'general_hardware',
    compatibleRooms: ['bathroom', 'laundry', 'kitchen', 'utility'],
  },
  // Exterior tapes strictly forbidden in interior wet areas without exact manufacturer mapping:
  {
    id: 'weatherline-flashing-tape',
    name: 'GIB Weatherline Flashing Tape 150mm x 30m',
    sku: '2800871',
    priceNzd: 120.0,
    reason: 'Exterior rigid air barrier flashing only - NOT FOR INTERIOR BATHROOM USE',
    category: 'lining',
    systemType: 'exterior_barrier',
    compatibleRooms: [],
  },
  {
    id: 'weatherline-sill-tape',
    name: 'GIB Weatherline Sill Tape 150mm x 20m',
    sku: '2800873',
    priceNzd: 110.0,
    reason: 'Exterior window sill tape only - NOT FOR INTERIOR BATHROOM USE',
    category: 'lining',
    systemType: 'exterior_barrier',
    compatibleRooms: [],
  },
  {
    id: 'masons-40-below',
    name: '40 Below Flashing Tape 100mm x 20m',
    sku: '3410067',
    priceNzd: 98.49,
    reason: 'Exterior secondary weather defence - NOT FOR INTERIOR BATHROOM USE',
    category: 'lining',
    systemType: 'exterior_barrier',
    compatibleRooms: [],
  },
];

export function validateAccessorySafety(
  acc: AccessoryItem,
  room: RoomType,
  packExtension?: SpacePlannerExtension
): { safe: boolean; reason?: string } {
  if (packExtension) {
    const packResult = validateAccessoryCompatibilityAgainstPack(
      [{ sku: acc.sku, systemType: acc.systemType, category: acc.category }],
      room,
      packExtension
    );
    if (!packResult.valid) {
      return {
        safe: false,
        reason: packResult.errors[0] || `Exterior weathertight tape (${acc.name} - SKU ${acc.sku}) cannot be used as an interior ${room} membrane or joint tape without an exact manufacturer mapping.`,
      };
    }
  }

  if (acc.systemType === 'exterior_barrier') {
    return {
      safe: false,
      reason: `Exterior weathertight tape (${acc.name} - SKU ${acc.sku}) cannot be used as an interior ${room} membrane or joint tape without an exact manufacturer mapping.`,
    };
  }
  if (!acc.compatibleRooms.includes(room)) {
    return {
      safe: false,
      reason: `Accessory ${acc.name} (${acc.sku}) is not compatible with room type ${room}.`,
    };
  }
  return { safe: true };
}
