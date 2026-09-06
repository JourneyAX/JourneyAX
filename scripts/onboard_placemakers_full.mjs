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

// ── 1. COMPREHENSIVE PLACEMAKERS CATALOGUE ─────────────────────────────────
const PLACEMAKERS_CATALOGUE = [
  // ── LAUNDRY CABINETRY & PACKAGES ──────────────────────────────────────────
  {
    sku: '7834813',
    name: 'Modern Laundry Base Kit 450 1 Drawer White Kordura Top With Petite Stainless Steel Sink Timber Veneer',
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
    sku: '7834115',
    name: 'Modular Base 2-Drawer Storage Cabinet 600mm White Gloss',
    category: 'Kitchens & Laundry > Laundry > Cabinetry',
    collection: 'Modular Laundry System',
    price: 685.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834115',
    description: 'Sturdy 600mm double-drawer modular base cabinet engineered for laundry hamper, towel, and cleaning supply organization.',
    specs: {
      'Width': '600mm',
      'Height': '870mm',
      'Depth': '580mm',
      'Drawers': '2 x Deep soft-close drawers',
      'Load Rating': '40kg per drawer',
      'Synonyms': '600 drawer unit, deep laundry drawers, modular base cabinet',
    },
    features: [
      'Full extension runners for complete access to rear of drawer',
      'Moisture-sealed edging on all exposed panel faces',
    ],
  },
  {
    sku: '7834225',
    name: 'Overhead Double Door Wall Cabinet 900mm White Gloss HMR',
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

  // ── LAUNDRY TUBS & SANITARYWARE ──────────────────────────────────────────
  {
    sku: '7846476',
    name: 'Robinhood SuperTub Standard Door Model ST3104 Stainless Steel 45L Tub with Gooseneck Tap',
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
  {
    sku: '7846479',
    name: 'Robinhood SuperTub Slim Door Model STSLIMTAP4 Stainless Steel 30L Tub with Gooseneck Tap',
    category: 'Kitchens & Laundry > Laundry > Laundry Tubs',
    collection: 'Robinhood SuperTub',
    price: 998.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-tubs/p/7846479',
    description: 'Slimline 350mm wide freestanding laundry tub ideal for compact laundries, garages, or tight alcoves.',
    specs: {
      'Model Code': 'STSLIMTAP4',
      'Width': '350mm',
      'Height': '900mm',
      'Depth': '560mm',
      'Bowl Capacity': '30 Litres 304 Stainless Steel',
      'Synonyms': 'slim supertub, narrow laundry tub, 350mm tub, compact wash tub',
    },
    features: [
      'Ultra-compact 350mm width fits narrow laundry corridors',
      'Complete with washing machine bypass ports and stainless mixer',
    ],
  },

  // ── TAPWARE & PLUMBING ───────────────────────────────────────────────────
  {
    sku: '7834880',
    name: 'High-Arch Gooseneck Pull-Out Spray Laundry Mixer Chrome 4-Star WELS',
    category: 'Kitchens & Laundry > Laundry > Laundry Taps',
    collection: 'PlaceMakers Architectural Tapware',
    price: 349.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-taps/p/7834880',
    description: 'High clearance 360-degree swivel gooseneck tap featuring dual-function pull-out spray head for bucket filling and sink rinsing.',
    specs: {
      'WELS Rating': '4 Star · 7.5 Litres/min',
      'Material': 'Solid DZR Brass with Polished Chrome Plating',
      'Cartridge': '35mm European Ceramic Disc Cartridge',
      'Spray Modes': 'Aerated Stream & High-Velocity Needle Spray',
      'Warranty': '15-Year PlaceMakers Cartridge Warranty',
      'Synonyms': 'laundry tap, gooseneck mixer, pull out spray, laundry faucet, sink mixer, washroom tap',
    },
    features: [
      'Pull-out hose extends 600mm to fill buckets on the floor easily',
      'Swivel spout rotates 360 degrees for double-tub accessibility',
    ],
  },

  // ── WALL LININGS & WATERPROOFING ─────────────────────────────────────────
  {
    sku: 'GIB-AQUA-10',
    name: 'GIB Aqualine 10mm Plasterboard 2400 x 1200mm Wet Area Moisture Resistant Board',
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

  // ── ACCESSORIES & HARDWARE ───────────────────────────────────────────────
  {
    sku: '7834910',
    name: 'Concealed Pull-Out Twin Laundry Sorting Hamper 2x35L Soft-Close for 450mm Base',
    category: 'Kitchens & Laundry > Laundry > Accessories',
    collection: 'PlaceMakers Storage Solutions',
    price: 289.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/accessories/p/7834910',
    description: 'Door-mounted pull-out twin laundry sorting system with dual 35-litre vented buckets on heavy-duty soft-closing slides.',
    specs: {
      'Fits Cabinet': '450mm external width base cupboard',
      'Capacity': '70 Litres total (2 x 35L removable bins with handles)',
      'Runners': 'Full extension synchronised soft-close (45kg rating)',
      'Synonyms': 'pull out hamper, laundry bin, sorting hamper, hidden basket, twin hamper',
    },
    features: [
      'Pre-sort whites and darks inside cabinet out of sight',
      'Vented bucket design prevents moisture and odour buildup',
    ],
  },

  // ── TIMBER & DECKING ─────────────────────────────────────────────────────
  {
    sku: '1930650',
    name: 'Kwila Griptread Decking FSC 100 x 25mm (90 x 19mm Finished Size)',
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
      'Kiln Dried': 'KD 14–16% Moisture Content',
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
];

// ── 2. DYNAMIC PROJECT CONFIG (TENANT_CONFIGS) ──────────────────────────────
const PLACEMAKERS_PROJECT_CONFIG = {
  tenantId: PROJECT_ID,
  projectId: PROJECT_ID,
  name: 'PlaceMakers',
  companyName: 'PlaceMakers (Fletcher Building)',
  projectName: 'PlaceMakers NZ',
  slug: 'placemakers-nz',
  domain: 'placemakers.journeyax.com',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 2,
  channels: { web: true, mobile: false, email: false, whatsapp: false, voice: false, kiosk: false, partner: false, csr: false },
  pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 },
  scope: {
    rooms: ['Laundry', 'Bathroom', 'Kitchen', 'Decking', 'Outdoor Living'],
    finishes: ['Timber Veneer', 'Gloss White', 'Matte White Kordura', 'Polished Chrome', 'Brushed Stainless'],
    categories: ['Kitchens & Laundry', 'Building Products', 'Timber & Plywood', 'Fixings & Fasteners', 'Plumbing & Tapware'],
    complianceTags: ['NZBC E3/AS1 Internal Moisture', 'NZS 3604 Timber Framing', 'BRANZ Appraised', 'WELS 4-Star'],
    excludedSkus: [],
  },
  theme: {
    primaryColor: '#E31E24',
    accentColor: '#111111',
    fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
    logoUrl: '/brands/placemakers.png',
    visualizerEnabled: true,
    sidebarStyle: 'light',
    sidebarColor: '#ffffff',
  },
  labels: {
    items: 'Trade Building Products',
    itemsSingular: 'Product',
    headerTitle: 'PlaceMakers Project & Materials Consultant',
  },
  commerceMode: 'quote',
  components: {
    productCard: {
      layout: 'technical',
      showBranchStock: true,
      showSpecs: true,
      badgeFields: ['Compliance', 'Warranty', 'Branch Stock'],
    },
    quoteCard: {
      layout: 'multi-trade-bom',
      showTradeDiscounts: true,
      fulfillmentOptions: ['branch-pickup', 'delivery', 'trade-dispatch'],
      defaultBranch: 'Mount Wellington / Cook Street (Auckland)',
    },
    spacePlanner: {
      enabled: true,
      roomTypes: ['laundry', 'bathroom', 'decking'],
      defaultRoom: 'laundry',
    },
    discoveryQuestions: [
      {
        id: 'laundry-discovery',
        trigger: 'laundry room makeover',
        questions: [
          'What are the approximate dimensions of your laundry space (e.g. 2.4m x 2.0m)?',
          'Do you prefer a Modern Timber Veneer look or a Minimalist Gloss White finish?',
          'Will you be DIY installing, or would you like certified PlaceMakers Trade installation?',
        ],
      },
      {
        id: 'deck-discovery',
        trigger: 'decking project',
        questions: [
          'What are your deck dimensions (length x width in meters)?',
          'What height is the deck off the ground (low level <1m or elevated)?',
          'Are you in a coastal exposure zone requiring 316 Marine Grade stainless fixings?',
        ],
      },
    ],
  },
  multiTradeBundles: [
    {
      id: 'laundry-5-trade-package',
      name: 'Complete 5-Trade Laundry Makeover Solution',
      category: 'Kitchens & Laundry',
      description: 'Fully compliant 5-trade laundry makeover package meeting NZBC E3/AS1 Internal Moisture standards.',
      trades: [
        { tradeName: 'Modular Cabinetry & Benchtops', tradeCode: 'CAB-01', required: true, defaultSkus: ['7834654', '7834225', '7834330'] },
        { tradeName: 'Sanitaryware & SuperTub', tradeCode: 'PLUMB-SAN', required: true, defaultSkus: ['7846476'] },
        { tradeName: 'Tapware & Plumbing Valves', tradeCode: 'PLUMB-TAP', required: true, defaultSkus: ['7834880'] },
        { tradeName: 'Wet-Wall Linings & Waterproofing', tradeCode: 'LINING-WP', required: true, defaultSkus: ['GIB-AQUA-10', 'WP-MEMB-KIT'] },
        { tradeName: 'Storage Hardware & Accessories', tradeCode: 'ACC-ORG', required: false, defaultSkus: ['7834910'] },
      ],
    },
    {
      id: 'kwila-decking-package',
      name: 'PlaceMakers Kwila Hardwood Decking Complete System',
      category: 'Timber & Plywood',
      description: 'Premium FSC Kwila decking package with SG8 framing, 316 marine stainless fasteners, and 10% cutting wastage.',
      trades: [
        { tradeName: 'Hardwood Decking Boards', tradeCode: 'DECK-BOARDS', required: true, defaultSkus: ['1930650'] },
        { tradeName: 'Subfloor Framing & Joists', tradeCode: 'TIMBER-FRAMING', required: true, defaultSkus: ['1910110'] },
        { tradeName: 'Marine Fastenings & Screws', tradeCode: 'FASTENERS', required: true, defaultSkus: ['1920330'] },
      ],
    },
  ],
  persona: {
    systemName: 'PlaceMakers Consultant',
    greetingMessage:
      "Kia ora! I'm your PlaceMakers project and materials consultant. Whether you're planning a complete laundry or bathroom makeover, building a compliant deck, or estimating materials across our branches, how can I help you today?",
    systemPromptOverrides:
      "You are the official PlaceMakers Project & Materials Consultant for PlaceMakers NZ. Ground every response in PlaceMakers NZ products, trade standards, and NZ Building Code compliance. " +
      "When a customer asks for a room makeover (like a laundry or bathroom), NEVER suggest a single cabinet in isolation! A room makeover is a complete 5-trade project covering Cabinetry, SuperTubs/Sanitary, Tapware/Plumbing, GIB Aqualine Linings & Waterproofing, and Accessories. " +
      "Always ask guided discovery questions (room size, style, DIY vs Trade) and call buildProjectPlan / openSpacePlanner to present the complete package with 60-Minute Branch Pickup at Mt Wellington / Cook St.",
    journeyGuidance:
      "1. Identify project scope: room makeover (laundry/bathroom), decking, framing, or product enquiry.\n" +
      "2. Ask guided discovery questions to confirm dimensions and style.\n" +
      "3. Generate complete multi-trade bill of materials (BOM) with GIB Aqualine and NZBC E3 compliance.\n" +
      "4. Launch interactive 3D Space Planner for visual room layout.\n" +
      "5. Offer 60-Minute Branch Pickup or Trade Dispatch across PlaceMakers NZ branch network.",
  },
  intro: {
    heroHeadline: 'Build it right with PlaceMakers.',
    heroSubtitle: 'Instant multi-trade material estimation, compliant project packs, and 60-minute branch pickup.',
    inputPlaceholder: 'e.g. I want to plan a complete laundry makeover for a 2.4m space...',
    starters: [
      { label: '🧺 Laundry Room Makeover', prompt: 'I want to do a complete laundry room makeover with cabinetry, tub, and wall linings.' },
      { label: '🪵 Kwila Deck Estimator', prompt: 'Estimate Kwila decking, SG8 framing, and stainless screws for a 5m x 4m deck.' },
      { label: '🛁 GIB Aqualine & Wet Walls', prompt: 'What moisture-resistant linings and waterproofing do I need for my wet area?' },
      { label: '📍 Branch Stock Check', prompt: 'Check stock availability for Robinhood SuperTub and GIB Aqualine at Mt Wellington branch.' },
    ],
  },
};

// ── 3. SEEDING EXECUTION ───────────────────────────────────────────────────
async function run() {
  console.log('🚀 Starting PlaceMakers Complete Enterprise Onboarding...');
  const client = new MongoClient(uri);
  await client.connect();

  const jax = client.db('journeyax');
  const jyx = client.db('journeyx');

  // 1. Upsert Project Configuration in tenant_configs
  console.log('📦 Upserting tenant_configs for "placemakers"...');
  await jax.collection('tenant_configs').updateOne(
    { projectId: PROJECT_ID },
    { $set: PLACEMAKERS_PROJECT_CONFIG },
    { upsert: true }
  );
  console.log('✅ tenant_configs successfully updated with CMS component & journey schemas.');

  // 2. Index Products in journeyx.products
  const prodCol = jyx.collection('products');
  console.log(`📦 Upserting ${PLACEMAKERS_CATALOGUE.length} products in journeyx.products...`);

  for (const item of PLACEMAKERS_CATALOGUE) {
    const doc = {
      projectId: PROJECT_ID,
      parentSku: item.sku,
      sku: item.sku,
      title: item.name,
      name: item.name,
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
  console.log('✅ journeyx.products populated.');

  // 3. Index Vector Knowledge Documents in journeyx.documents
  const docCol = jyx.collection('documents');
  console.log(`🧠 Generating OpenAI vector embeddings and indexing in journeyx.documents...`);

  for (const item of PLACEMAKERS_CATALOGUE) {
    const textToEmbed = `${item.name}
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
      type: 'product',
      url: item.url,
      embedding: embedding,
      metadata: {
        sku: item.sku,
        price: item.price,
        currency: item.currency,
        imageUrl: item.imageUrl,
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
    console.log(`   ✓ Embedded & Indexed: [${item.sku}] ${item.name.slice(0, 50)}...`);
  }

  console.log('🎉 PlaceMakers Complete Enterprise Onboarding Finished Successfully!');
  await client.close();
}

run().catch((err) => {
  console.error('❌ Onboarding failed:', err);
  process.exit(1);
});
