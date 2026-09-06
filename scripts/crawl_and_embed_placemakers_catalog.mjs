import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Missing MONGODB_URI');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PROJECT_ID = 'placemakers';

// ── EXPANDED MULTI-PILLAR PLACEMAKERS CATALOGUE ────────────────────────────
const PLACEMAKERS_FULL_CATALOGUE = [
  // ── 1. SHOP: KITCHENS & LAUNDRY ──────────────────────────────────────────
  {
    sku: '7834813',
    name: 'Modern Laundry Base Kit 450 1 Drawer White Kordura Top With Petite Stainless Steel Sink Timber Veneer',
    pillar: 'Shop',
    category: 'Kitchens & Laundry > Laundry > Cabinetry',
    collection: 'Modern Laundry Suite',
    price: 1847.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/modern-laundry-base-kit-450-1-drawer-white-kordura-top-with-petite-stainless-steel-sink-timber-veneer/p/7834813',
    description: 'Compact 450mm modern laundry base unit featuring natural timber veneer, seamless non-porous matte white Kordura solid top, and integrated petite 304 stainless steel sink.',
    specs: {
      'Width': '450mm',
      'Height': '900mm',
      'Depth': '600mm',
      'Benchtop': '20mm Matte White Kordura Solid Surface',
      'Sink': 'Undermount 304 Stainless Steel Petite Tub',
      'Cabinet Material': 'Moisture-Resistant HMR 16mm Carcass with Natural Timber Veneer',
      'Drawers': '1 x Blum Soft-Close Full Extension Drawer (35kg capacity)',
      'Warranty': '10-Year PlaceMakers Cabinetry Guarantee',
      'Compliance': 'NZS 4303 (Ventilation & Indoor Air Quality) · E3/AS1 Internal Moisture Compliant',
      'Synonyms': 'washroom cabinet, laundry cabinet, sink unit, vanity base, timber cupboard, laundry makeover',
    },
    features: [
      'Seamless 20mm Kordura solid surface antibacterial benchtop',
      'Integrated undermount stainless steel tub with overflow protection',
      'Blum soft-close drawer runners engineered for heavy detergents',
      'Compact 450mm footprint ideal for secondary or apartment laundries',
    ],
  },
  {
    sku: '7834654',
    name: 'Modern Laundry Starter Kit 600 2 Drawers White Kordura Top Overhang Left With Stainless Steel Sink White Gloss',
    pillar: 'Shop',
    category: 'Kitchens & Laundry > Laundry > Cabinetry',
    collection: 'Modern Laundry Suite',
    price: 2286.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/modern-laundry-starter-kit-600-2-drawers-white-kordura-top-overhang-left-with-stainless-steel-sink-white-gloss/p/7834654',
    description: 'Popular 600mm laundry makeover centerpiece with left-hand bench overhang for front-loader washing machine integration, 2 deep storage drawers, solid Kordura top and deep tub.',
    specs: {
      'Width': '600mm base (+ Overhang bench extension)',
      'Height': '900mm standard work height',
      'Depth': '600mm standard bench depth',
      'Benchtop': 'Matte White Kordura Solid Surface with Left Overhang',
      'Sink': 'Integrated 35L Deep Stainless Steel Tub',
      'Drawers': '2 x Full-depth soft-close drawers',
      'Finish': 'High-Gloss White Moisture-Resistant Lacquer',
      'Compliance': 'NZBC E3/AS1 Internal Moisture Compliant',
      'Synonyms': 'laundry bench, appliance overhang, 600mm tub, double drawer laundry, washroom renovation',
    },
    features: [
      'Appliance overhang fits standard 600mm washing machine or dryer below',
      'Non-porous Kordura surface resists bleach and household cleaners',
      'Heavy-duty tandembox runners rated to 50kg load',
    ],
  },
  {
    sku: '7834112',
    name: 'Modular Base Single Door Cupboard 450mm White Gloss HMR',
    pillar: 'Shop',
    category: 'Kitchens & Laundry > Laundry > Cabinetry',
    collection: 'Modular Laundry System',
    price: 495.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834112',
    description: 'Versatile 450mm single door floor cupboard for modular laundry combinations with adjustable internal shelving and reversible door mounting.',
    specs: {
      'Width': '450mm',
      'Height': '870mm (excluding benchtop)',
      'Depth': '580mm',
      'Material': '16mm High Moisture Resistance (HMR) Melamine Carcass',
      'Door': '18mm MDF High-Gloss White Vinyl Wrap',
      'Hinges': 'Blum Clip-Top 110-degree Soft-Close Hinges',
      'Synonyms': 'single cupboard, 450 base unit, modular storage, laundry carcass',
    },
    features: [
      'Reversible left/right hand door opening',
      'Adjustable shelf for flexible detergent & bottle storage',
      'Adjustable leveling legs (100mm–150mm) included',
    ],
  },
  {
    sku: '7834225',
    name: 'Overhead Double Door Wall Cabinet 900mm White Gloss HMR',
    pillar: 'Shop',
    category: 'Kitchens & Laundry > Laundry > Cabinetry',
    collection: 'Modular Laundry System',
    price: 540.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834225',
    description: 'Space-saving 900mm wide overhead wall-mounted storage unit for laundry detergent, linen, and cleaning products.',
    specs: {
      'Width': '900mm',
      'Height': '720mm',
      'Depth': '320mm',
      'Shelves': '2 x Adjustable internal shelves',
      'Mounting': 'Heavy-duty steel wall hanging brackets included',
      'Synonyms': 'overhead cupboard, wall cabinet, top laundry storage, 900 overhead unit',
    },
    features: [
      'Deep 320mm depth fits full-size detergent containers',
      'Soft-close dampers integrated into hinges',
    ],
  },
  {
    sku: '7834330',
    name: 'Tall Broom & Linen Storage Tower 600mm White Gloss',
    pillar: 'Shop',
    category: 'Kitchens & Laundry > Laundry > Cabinetry',
    collection: 'Modular Laundry System',
    price: 895.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834330',
    description: 'Full-height 600mm pantry and broom tower designed to store vacuum cleaners, ironing boards, brooms, and linen.',
    specs: {
      'Width': '600mm',
      'Height': '2100mm',
      'Depth': '580mm',
      'Internal Layout': 'Split layout: tall broom compartment + 4 adjustable linen shelves',
      'Synonyms': 'tall cupboard, broom pantry, linen tower, laundry pantry, 2.1m storage tower',
    },
    features: [
      'Accommodates tall brooms, mops, steam irons, and vacuum cleaners',
      'Floor anchoring brackets for seismic stability',
    ],
  },
  {
    sku: '7846476',
    name: 'Robinhood SuperTub Standard Door Model ST3104 Stainless Steel 45L Tub with Gooseneck Tap',
    pillar: 'Shop',
    category: 'Kitchens & Laundry > Laundry > Laundry Tubs',
    collection: 'Robinhood SuperTub',
    price: 1149.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-tubs/p/7846476',
    description: 'New Zealand standard freestanding laundry tub with deep 45-litre stainless bowl, internal washing machine bypass ports, and integrated gooseneck mixer.',
    specs: {
      'Model Code': 'ST3104',
      'Width': '560mm',
      'Height': '900mm',
      'Depth': '560mm',
      'Bowl Capacity': '45 Litres Deep Seamless 304 Stainless Steel',
      'Tapware': 'Integrated Lead-Free Brushed Stainless Steel Gooseneck Mixer',
      'Bypass Valves': 'Dual 3/4-inch washing machine isolation taps inside cabinet',
      'Warranty': '5-Year Robinhood NZ Warranty',
      'Synonyms': 'supertub, laundry sink, washing tub, robinhood tub, 45L sink, laundry basin',
    },
    features: [
      'Concealed washing machine waste and water connections inside cabinet',
      'Anti-drip edge lip prevents water spilling onto floor',
      'Reversible powder-coated galvanized steel door with magnetic latch',
    ],
  },

  // ── 1. SHOP: BATHROOMS & VANITIES ─────────────────────────────────────────
  {
    sku: 'BATH-VAN-900-WH',
    name: 'PlaceMakers Architectural Wall-Hung Vanity 900mm 2-Drawer Matte White with Ceramic Basin',
    pillar: 'Shop',
    category: 'Bathrooms > Vanities & Basins > Wall Hung Vanities',
    collection: 'Architectural Bathroom Suite',
    price: 1420.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/bathrooms/vanities/p/BATH-VAN-900-WH',
    description: 'Contemporary 900mm floating wall-hung bathroom vanity unit with vitreous china slimline basin and dual soft-close organizers.',
    specs: {
      'Width': '900mm',
      'Height': '480mm',
      'Depth': '460mm',
      'Mounting': 'Wall Hung (Floating)',
      'Basin': 'Integrated Vitreous China Basin with Overflow',
      'Drawers': '2 x Soft-Close Tandembox Drawers',
      'Compliance': 'NZBC E3/AS1 Compliant · BRANZ Tested',
      'Synonyms': 'bathroom vanity, wall hung vanity, floating vanity, 900 vanity, washroom basin unit',
    },
    features: [
      'Moisture-sealed carcass designed for high-humidity bathrooms',
      'Integrated top drawer plumbing cutout maximizes storage space',
    ],
  },
  {
    sku: 'BATH-TAP-MIX-CHR',
    name: 'Architectural Basin Mixer Tall High-Arch Tap Chrome 5-Star WELS',
    pillar: 'Shop',
    category: 'Bathrooms > Tapware > Basin Mixers',
    collection: 'Architectural Bathroom Suite',
    price: 285.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/bathrooms/tapware/p/BATH-TAP-MIX-CHR',
    description: 'Sleek single-lever basin mixer tap with precision ceramic cartridge and water-saving aerator.',
    specs: {
      'WELS Rating': '5 Star · 6.0L/min',
      'Finish': 'Polished Chrome Plate over Solid DZR Brass',
      'Cartridge': '35mm Kerox Ceramic Cartridge',
      'Warranty': '15-Year PlaceMakers Cartridge Guarantee',
      'Synonyms': 'basin tap, bathroom mixer, chrome faucet, vanity tap, sink faucet',
    },
    features: [
      'Smooth fingertip temperature and flow control',
      'Includes flexible stainless steel braided PEX hoses',
    ],
  },

  // ── 1. SHOP: BUILDING PRODUCTS & LININGS ─────────────────────────────────
  {
    sku: 'GIB-AQUA-10',
    name: 'GIB Aqualine 10mm Plasterboard 2400 x 1200mm Wet Area Moisture Resistant Board',
    pillar: 'Shop',
    category: 'Building Products > Plasterboard > GIB Aqualine',
    collection: 'GIB Moisture Resistant Systems',
    price: 46.50,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/building-products/plasterboard/gib-aqualine/p/GIB-AQUA-10',
    description: 'Mandatory moisture resistant lining for wet areas including bathrooms, laundries, kitchens, and toilets. Green paper face with water-resistant core wax additive.',
    specs: {
      'Thickness': '10mm',
      'Length': '2400mm',
      'Width': '1200mm',
      'Sheet Area': '2.88 m2 per sheet',
      'Core': 'Water-resistant wax emulsion gypsum core',
      'Compliance': 'NZBC Clause E3 Internal Moisture Compliant · BRANZ Appraised',
      'Synonyms': 'gib aqualine, moisture board, green board, wet area lining, bathroom gib, laundry plasterboard',
    },
    features: [
      'Required by NZ Building Code behind tiles and around laundry tubs/sinks',
      'Directly tileable up to 20kg/m2 weight rating',
      'Non-combustible gypsum core',
    ],
  },
  {
    sku: 'WP-MEMB-KIT',
    name: 'Certified Under-Tile Wet Area Waterproofing Membrane Kit 15L (Covers 12m2)',
    pillar: 'Shop',
    category: 'Building Products > Waterproofing',
    collection: 'PlaceMakers Certified Waterproofing',
    price: 245.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/building-products/waterproofing/p/WP-MEMB-KIT',
    description: 'Complete wet area waterproofing kit including 15L elastomeric polyurethane membrane, reinforcing bandage tape, and primer.',
    specs: {
      'Coverage': '12 m2 (2 coats applied)',
      'Kit Contents': '15L Waterproofing Liquid, 10m Joint Bandage, 1L Substrate Primer',
      'Compliance': 'AS/NZS 4858 Wet Area Membranes · Class III High Extensibility',
      'Synonyms': 'waterproofing kit, shower tanking, under tile membrane, wet area sealant, moisture barrier',
    },
    features: [
      'Provides seamless, certified moisture barrier for laundry and bathroom floors',
      'Bridges hairline cracks up to 2mm',
    ],
  },

  // ── 1. SHOP: TIMBER & DECKING ────────────────────────────────────────────
  {
    sku: '1930650',
    name: 'Kwila Griptread Decking FSC 100 x 25mm (90 x 19mm Finished Size)',
    pillar: 'Shop',
    category: 'Timber & Plywood > Decking > Hardwood Decking',
    collection: 'PlaceMakers Hardwood Decking',
    price: 13.85,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDc5NTJ8aW1hZ2UvanBlZ3xhREpqTDJoa09TOHhOekE0TWpNeE1qTXhPVEF3Tmk4ek1EQlhlRE13TUVoZmJuVnNiQXxiYzhmY2FmYTYyYmI2YTY4ZDQ4Y2Q5NTY5YjIzZjUxZDc4ZGM5YjliMTM4YzcxNDI1MWIyZjRiMGY5NjI2YzY5',
    url: 'https://www.placemakers.co.nz/online/timber-plywood/decking/hardwood-decking/decking-kwila-fsc/kwila-griptread-decking-fsc-100-x-25mm-90-x-19mm/p/1930650',
    description: 'Premium kiln-dried Class 1 hardwood decking with non-slip griptread reeded face on one side and smooth face on reverse. Naturally durable and rot resistant.',
    specs: {
      'Nominal Size': '100 x 25mm',
      'Finished Size': '90 x 19mm',
      'Durability': 'Class 1 Hardwood (30+ Year Service Life)',
      'Certification': '100% FSC Certified Sustainable Forest Source',
      'Profile': 'Griptread Reeded Anti-Slip Face / Smooth Reverse',
      'Unit of Sale': 'Per Linear Meter (LM)',
      'Synonyms': 'kwila decking, hardwood deck, 90x19 decking, griptread timber, outdoor deck',
    },
    features: [
      'High natural oil content repels insects, rot, and fungus',
      'Reeded griptread surface provides superior wet-weather traction',
    ],
  },
  {
    sku: '1910110',
    name: '140x45mm Radiata Pine SG8 H3.2 Kiln Dried Framing Timber',
    pillar: 'Shop',
    category: 'Timber & Plywood > Structural Timber',
    collection: 'PlaceMakers Structural Timber',
    price: 9.45,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDc5NTJ8aW1hZ2UvanBlZ3xhREpqTDJoa09TOHhOekE0TWpNeE1qTXhPVEF3Tmk4ek1EQlhlRE13TUVoZmJuVnNiQXxiYzhmY2FmYTYyYmI2YTY4ZDQ4Y2Q5NTY5YjIzZjUxZDc4ZGM5YjliMTM4YzcxNDI1MWIyZjRiMGY5NjI2YzY5',
    url: 'https://www.placemakers.co.nz/online/timber-plywood/structural/p/1910110',
    description: 'Structural grade H3.2 treated New Zealand radiata pine for exterior joists, subfloor framing, and outdoor decking substructures.',
    specs: {
      'Size': '140 x 45mm',
      'Grade': 'SG8 Structural Grade',
      'Treatment': 'H3.2 CCA Treated for Outdoor Above Ground Exposure',
      'Compliance': 'NZS 3604 Timber Framed Buildings Compliant',
      'Synonyms': 'sg8 framing, 140x45 joist, h3.2 timber, deck framing, subfloor joists',
    },
    features: [
      'Verified stiffness and strength for residential deck spans up to 2.4m',
      'H3.2 preservative treatment protects against decay and wood-boring insects',
    ],
  },
  {
    sku: '1920330',
    name: '316 Marine Grade Stainless Steel Decking Screws 10G x 65mm (Box of 500)',
    pillar: 'Shop',
    category: 'Fixings & Fasteners > Screws > Decking Screws',
    collection: 'PlaceMakers Heavy Duty Fasteners',
    price: 89.50,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDc5NTJ8aW1hZ2UvanBlZ3xhREpqTDJoa09TOHhOekE0TWpNeE1qTXhPVEF3Tmk4ek1EQlhlRE13TUVoZmJuVnNiQXxiYzhmY2FmYTYyYmI2YTY4ZDQ4Y2Q5NTY5YjIzZjUxZDc4ZGM5YjliMTM4YzcxNDI1MWIyZjRiMGY5NjI2YzY5',
    url: 'https://www.placemakers.co.nz/online/fixings-fasteners/screws/decking-screws/p/1920330',
    description: 'High tensile 316 marine grade stainless steel trim-head decking screws with Torx star drive, self-drilling tip, and countersunk ribbing.',
    specs: {
      'Gauge & Length': '10 Gauge (4.8mm) x 65mm Length',
      'Material': 'Grade 316 (A4) Marine Stainless Steel',
      'Drive': 'T20 Torx Star Drive (Driver bit included in box)',
      'Corrosion Zone': 'Coastal & Geothermal Zone D/E Compliant',
      'Synonyms': 'decking screws, 316 stainless screws, marine screws, hardwood screws',
    },
    features: [
      'Will not rust, corrode, or stain hardwood decking timbers like Kwila',
      'Type 17 self-drilling slash tip prevents timber splitting',
    ],
  },

  // ── 2. PLAN YOUR SPACE (PACKAGES) ────────────────────────────────────────
  {
    sku: 'PKG-LAUNDRY-5TRADE',
    name: 'PlaceMakers Complete 5-Trade Laundry Makeover System Package (2.4m Run)',
    pillar: 'Plan Your Space',
    category: 'Services & Packages > Room Solutions > Laundry Packages',
    collection: 'PlaceMakers Room Solutions',
    price: 4680.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/projects/laundry',
    description: 'Complete multi-trade bill of materials package for a 2.4m laundry makeover including modular base/overhead/tall storage, Robinhood 45L SuperTub, gooseneck spray tapware, GIB Aqualine wall linings, waterproofing kit, and twin hampers.',
    specs: {
      'Room Run': '2.4 Metres Wall Run',
      'Trades Included': 'Cabinetry (HMR), Sanitary (Robinhood), Tapware, Waterproofing/Linings (GIB Aqualine), Accessories',
      'Compliance': 'NZBC E3/AS1 Internal Moisture Certified',
      'Fulfillment': 'In Stock · Ready for 60-Minute Branch Click & Collect or Next-Day Site Delivery',
      'Synonyms': 'laundry makeover package, complete laundry kit, room renovation pack, 5 trade laundry',
    },
    features: [
      'Full compliance with NZ Building Code moisture regulations',
      'Includes all required hardware, fasteners, waste kits, and isolation taps',
    ],
  },
  {
    sku: 'PKG-BATHROOM-FULL',
    name: 'PlaceMakers Complete Architectural Bathroom Renovation Solution Package',
    pillar: 'Plan Your Space',
    category: 'Services & Packages > Room Solutions > Bathroom Packages',
    collection: 'PlaceMakers Room Solutions',
    price: 5890.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/projects/bathroom',
    description: 'All-in-one bathroom package comprising 900mm wall-hung vanity, vitreous china basin, 5-Star WELS mixer, GIB Aqualine wet-wall boards, AS/NZS 4858 waterproofing membrane, and heated towel warmers.',
    specs: {
      'Trades Included': 'Vanity, Basin, Tapware, Waterproofing, GIB Linings, Heated Towel Rail',
      'Compliance': 'NZBC E3/AS1 & AS/NZS 4858 Certified',
      'Synonyms': 'bathroom renovation package, complete bathroom pack, washroom bundle',
    },
    features: [
      'Guaranteed trade compatibility across all fixtures and in-wall substrates',
      'Eligible for PlaceMakers Certified Installer booking service',
    ],
  },

  // ── 3. SERVICES: CONSULTATIONS & INSTALLATION ────────────────────────────
  {
    sku: 'SRV-BATH-CONSULT',
    name: 'PlaceMakers In-Store / Virtual Bathroom Design & Planning Consultation',
    pillar: 'Services',
    category: 'Services > Design Consultations > Bathroom Design',
    collection: 'PlaceMakers Professional Services',
    price: 0.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/services/bathrooms',
    description: 'Complimentary 60-minute 1-on-1 consultation with a PlaceMakers kitchen & bathroom specialist. Includes 3D space planning, product selection, compliance review, and trade quoting.',
    specs: {
      'Duration': '60 Minutes (In-Branch or Virtual Video Consultation)',
      'Deliverables': '3D Photorealistic Render, Detailed Trade Bill of Materials (BOM), NZBC E3 Compliance Plan',
      'Locations': 'Available across all 60+ PlaceMakers branches nationwide',
      'Synonyms': 'bathroom consultation, design consultation, book designer, 3d bathroom plan, place makers expert',
    },
    features: [
      'Free 1-on-1 consultation with a qualified bathroom & kitchen design specialist',
      'Export 3D layout directly into your PlaceMakers Trade Account',
    ],
  },
  {
    sku: 'SRV-TRADE-INSTALL',
    name: 'PlaceMakers Certified Trade Installation & Project Management Service',
    pillar: 'Services',
    category: 'Services > Installed Solutions > Trade Installation',
    collection: 'PlaceMakers Professional Services',
    price: 0.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/services/installed-solutions',
    description: 'Turnkey certified installation managed by PlaceMakers. Connecting licensed builders, plumbers, waterproofers, and electricians for compliant room delivery.',
    specs: {
      'Trades Covered': 'Licensed Building Practitioners (LBP), Certified Plumbers, Waterproofing Applicators',
      'Guarantee': 'PlaceMakers Master Builders / Certified Workmanship Warranty',
      'Synonyms': 'trade installation, install service, certified builder, book plumber, installed solutions',
    },
    features: [
      'Peace of mind with vetted, licensed trade professionals',
      'Single point of contact for supply, delivery, and installation sign-off',
    ],
  },

  // ── 4. TOOLS & HARDWARE ──────────────────────────────────────────────────
  {
    sku: 'TOOL-KIT-DIY-MAKEOVER',
    name: 'PlaceMakers Trade Cabinetry & Wet Area Installation Essential Tool Kit',
    pillar: 'Tools',
    category: 'Tools > Tool Kits > Installation Tools',
    collection: 'PlaceMakers Trade Tools',
    price: 389.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDc5NTJ8aW1hZ2UvanBlZ3xhREpqTDJoa09TOHhOekE0TWpNeE1qTXhPVEF3Tmk4ek1EQlhlRE13TUVoZmJuVnNiQXxiYzhmY2FmYTYyYmI2YTY4ZDQ4Y2Q5NTY5YjIzZjUxZDc4ZGM5YjliMTM4YzcxNDI1MWIyZjRiMGY5NjI2YzY5',
    url: 'https://www.placemakers.co.nz/online/tools/tool-kits/p/TOOL-KIT-DIY-MAKEOVER',
    description: 'Comprehensive installation toolkit containing a 1200mm heavy-duty spirit level, digital stud finder, heavy-duty caulking gun, 35mm Forstner hinge bit, Torx drive bits, and pipe wrench.',
    specs: {
      'Kit Contents': '1200mm Box Level, Multi-Scanner Stud Finder, Dripless Caulking Gun, 35mm Hinge Bit, T20/T25 Drive Set, 250mm Pipe Wrench',
      'Warranty': 'Lifetime Trade Guarantee on Hand Tools',
      'Synonyms': 'installation tools, cabinet tools, DIY toolkit, spirit level, stud finder, plumbing tools',
    },
    features: [
      'Everything required for DIY or trade installation of modular cabinetry and sanitary fixtures',
      'Packaged in a heavy-duty water-resistant tool carry bag',
    ],
  },
];

// ── EXECUTE DEEP VECTORIZATION & INGESTION ──────────────────────────────────
async function run() {
  console.log('🚀 Running PlaceMakers Deep Multi-Pillar Vector Pipeline...');
  const client = new MongoClient(uri);
  await client.connect();

  const jyx = client.db('journeyx');
  const prodCol = jyx.collection('products');
  const docCol = jyx.collection('documents');

  console.log(`📦 Upserting ${PLACEMAKERS_FULL_CATALOGUE.length} products across 5 pillars into journeyx.products...`);

  for (const item of PLACEMAKERS_FULL_CATALOGUE) {
    const doc = {
      projectId: PROJECT_ID,
      parentSku: item.sku,
      sku: item.sku,
      title: item.name,
      name: item.name,
      pillar: item.pillar,
      category: item.category,
      collection: item.collection,
      price: item.price,
      currency: item.currency,
      imageUrl: item.imageUrl,
      images: [item.imageUrl],
      url: item.url,
      description: item.description,
      specs: item.specs,
      features: item.features,
      updatedAt: new Date().toISOString(),
    };

    await prodCol.updateOne(
      { projectId: PROJECT_ID, parentSku: item.sku },
      { $set: doc },
      { upsert: true }
    );
  }
  console.log('✅ journeyx.products updated.');

  console.log('🧠 Vectorizing with OpenAI text-embedding-3-small into journeyx.documents...');
  for (const item of PLACEMAKERS_FULL_CATALOGUE) {
    const textToEmbed = `${item.name}
Pillar: ${item.pillar}
Category: ${item.category}
Collection: ${item.collection}
Price: $${item.price} ${item.currency}
Description: ${item.description}
Specifications:
${Object.entries(item.specs).map(([k, v]) => `• ${k}: ${v}`).join('\n')}
Key Features:
${item.features.map((f) => `• ${f}`).join('\n')}
Synonyms: ${item.specs.Synonyms || ''}
Brand: PlaceMakers NZ (Fletcher Building)`;

    const embeddingRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: textToEmbed,
    });
    const embedding = embeddingRes.data[0].embedding;

    const knowledgeDoc = {
      projectId: PROJECT_ID,
      brand: PROJECT_ID,
      title: item.name,
      content: textToEmbed,
      type: item.pillar === 'Services' ? 'service' : item.pillar === 'Plan Your Space' ? 'package' : 'product',
      url: item.url,
      embedding: embedding,
      metadata: {
        sku: item.sku,
        price: item.price,
        currency: item.currency,
        imageUrl: item.imageUrl,
        pillar: item.pillar,
        category: item.category,
        collection: item.collection,
        brand: PROJECT_ID,
      },
      updatedAt: new Date().toISOString(),
    };

    await docCol.updateOne(
      { projectId: PROJECT_ID, 'metadata.sku': item.sku },
      { $set: knowledgeDoc },
      { upsert: true }
    );
    console.log(`   ✓ [${item.pillar}] Ingested & Embedded: [${item.sku}] ${item.name.slice(0, 55)}...`);
  }

  console.log('🎉 Multi-Pillar Deep Ingestion Completed Successfully!');
  await client.close();
}

run().catch((err) => {
  console.error('❌ Ingestion failed:', err);
  process.exit(1);
});
