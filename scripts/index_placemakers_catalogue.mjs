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

async function getEmbedding(text) {
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
    const call = openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 4000),
    });
    const res = await Promise.race([call, timeout]);
    return res.data[0].embedding;
  } catch (err) {
    console.warn('Embedding fallback for:', text.slice(0, 30), err.message);
    return new Array(1536).fill(0);
  }
}

const PLACEMAKERS_PRODUCTS = [
  // ── LAUNDRY CABINETRY & PACKAGES ──────────────────────────────────────────
  {
    sku: '7834813',
    name: 'Modern Laundry Base Kit 450 1 Drawer White Kordura Top With Petite Stainless Steel Sink Timber Veneer',
    category: 'Laundry Cabinetry & Modular Units',
    collection: 'Modern Laundry Suite',
    price: 1847.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/modern-laundry-base-kit-450-1-drawer-white-kordura-top-with-petite-stainless-steel-sink-timber-veneer/p/7834813',
    description: 'Compact 450mm modern laundry base unit featuring high quality timber veneer finish, seamless non-porous matte white Kordura solid top, and integrated petite 304 stainless steel sink.',
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
    category: 'Laundry Cabinetry & Modular Units',
    collection: 'Modern Laundry Suite',
    price: 2286.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/modern-laundry-starter-kit-600-2-drawers-white-kordura-top-overhang-left-with-stainless-steel-sink-white-gloss/p/7834654',
    description: 'Popular 600mm laundry makeover centerpiece with left-hand bench overhang for appliance integration, 2 deep storage drawers, solid Kordura top and deep tub.',
    specs: {
      'Width': '600mm base (+ Overhang bench extension)',
      'Height': '900mm standard work height',
      'Depth': '600mm standard bench depth',
      'Benchtop': 'Matte White Kordura Solid Surface with Left Overhang',
      'Sink': 'Integrated 35L Deep Stainless Steel Tub',
      'Finish': 'Ultra-Modern High Gloss Pure White',
      'Drawers': '2 x Deep Storage Soft-Close Blum Drawers',
      'Warranty': '10-Year Cabinetry Guarantee',
    },
    features: [
      'Left overhang design provides under-bench cavity for front load washing machine',
      'Heavy-duty drawer runners hold up to 35kg of laundry supplies',
      'Antibacterial Kordura benchtop resists household chemicals and staining',
      'Pre-assembled carcass with adjustable levelling legs',
    ],
  },
  {
    sku: '7834112',
    name: 'Modular Base Single Door Cupboard 450mm White Gloss',
    category: 'Laundry Cabinetry & Modular Units',
    collection: 'Modern Laundry Suite',
    price: 420.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834112',
    description: 'Versatile 450mm base cupboard with reversible soft-close door and adjustable height shelf for plumbing access and bucket storage.',
    specs: {
      'Width': '450mm',
      'Height': '870mm (900mm with benchtop)',
      'Depth': '580mm',
      'Finish': 'White Gloss Lacquered Moisture-Resistant MDF',
      'Hardware': 'Blum Soft-Close Concealed Hinges (110° opening)',
    },
    features: [
      'Reversible door can be hung left or right opening',
      'Includes adjustable shelf and 4 heavy-duty levelling legs',
    ],
  },
  {
    sku: '7834115',
    name: 'Modular Base 2-Drawer Storage Cabinet 600mm White Gloss',
    category: 'Laundry Cabinetry & Modular Units',
    collection: 'Modern Laundry Suite',
    price: 580.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834115',
    description: 'High capacity 600mm base unit with 2 deep soft-close drawers for organizing towels, baskets, and cleaning detergents.',
    specs: {
      'Width': '600mm',
      'Height': '870mm',
      'Depth': '580mm',
      'Finish': 'White Gloss',
      'Drawers': '2 x Full Extension Blum Soft-Close Metal Sided Drawers',
    },
    features: [
      'Deep lower drawer designed to fit tall bleach & detergent bottles standing up',
      'Heavy duty 35kg dynamic load rating per drawer',
    ],
  },
  {
    sku: '7834225',
    name: 'Overhead Double Door Wall Cabinet 900mm White Gloss',
    category: 'Laundry Cabinetry & Modular Units',
    collection: 'Modern Laundry Suite',
    price: 520.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834225',
    description: 'Generous 900mm wide overhead wall cabinet utilizing vertical space for laundry baskets and household storage.',
    specs: {
      'Width': '900mm',
      'Height': '720mm',
      'Depth': '350mm',
      'Shelves': '2 x Adjustable internal shelves',
      'Mounting': 'Heavy duty concealed wall hanging brackets included',
    },
    features: [
      'Twin soft-close doors with 110° wide opening angle',
      'Slim 350mm depth leaves clear bench workspace below',
    ],
  },
  {
    sku: '7834330',
    name: 'Tall Broom, Ironing & Linen Storage Tower 600mm (2100mm Height)',
    category: 'Laundry Cabinetry & Modular Units',
    collection: 'Modern Laundry Suite',
    price: 890.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-cabinetry/modular/p/7834330',
    description: 'Floor-to-ceiling utility tower featuring tall side compartment for brooms, mops and vacuum cleaner, plus upper shelves for bulk linen.',
    specs: {
      'Width': '600mm',
      'Height': '2100mm',
      'Depth': '600mm',
      'Internal Layout': 'Tall Broom Slot + 4 x Adjustable Linen Shelves',
      'Doors': 'Full height dual doors with Blum soft-close hinges',
    },
    features: [
      'Solves tall item storage (vacuum, ironing board, mop, steam cleaner)',
      'Integrated ventilation slots for damp broom storage',
    ],
  },

  // ── LAUNDRY TUBS, BENCHTOPS & TAPWARE ─────────────────────────────────────
  {
    sku: '7834650',
    name: 'Robinhood SuperTub Stainless Steel Deep Laundry Tub & Sink (45L Capacity)',
    category: 'Laundry Tubs & Sinkware',
    collection: 'Robinhood SuperTub',
    price: 640.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-tubs/p/7834650',
    description: 'Heavy gauge 304 stainless steel deep bowl laundry sink with dual washing machine bypass ports and basket waste.',
    specs: {
      'Bowl Capacity': '45 Litres extra deep soaking bowl',
      'Material': '1.2mm High Grade 304 Stainless Steel',
      'Waste': '90mm Basket Waste with Integrated Bypass Outlets',
      'Mounting': 'Undermount or Topmount Drop-In Compatible',
    },
    features: [
      'Full 45L soaking capacity accommodates large blankets and workwear',
      'Twin concealed bypass outlets prevent washing machine suds backing up',
    ],
  },
  {
    sku: '7834880',
    name: 'High-Arch Gooseneck Pull-Out Spray Laundry Sink Mixer (Matte Black)',
    category: 'Laundry Tapware & Plumbing',
    collection: 'PlaceMakers Trade Tapware',
    price: 320.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-tapware/p/7834880',
    description: 'Commercial quality 360° swivel gooseneck laundry tap with dual function pull-out spray head for thorough bucket and tub rinsing.',
    specs: {
      'WELS Rating': '4 Star (7.5 Litres/min) · WaterMark Certified',
      'Cartridge': '35mm European Ceramic Disc Cartridge',
      'Spout Reach': '225mm with 1.5m braided nylon pull-out hose',
      'Finish': 'PVD Electroplated Ultra-Durable Matte Black',
    },
    features: [
      'Dual spray function: Aerated stream for filling / Powerful needle spray for rinsing',
      'PVD finish resists scratching, cleaning chemicals, and water spotting',
    ],
  },

  // ── WET AREA LININGS & WATERPROOFING ──────────────────────────────────────
  {
    sku: 'GIB-AQUA-10',
    name: 'GIB Aqualine 10mm Wet Area Moisture Resistant Plasterboard (2400 x 1200mm)',
    category: 'Wet Wall Linings & Waterproofing',
    collection: 'Winstone Wallboards GIB',
    price: 48.50,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/building-products/plasterboard/gib-aqualine/p/GIB-AQUA-10',
    description: 'Specially formulated water-resistant core plasterboard engineered for laundry splash zones and bathroom wet areas according to NZ Building Code E3/AS1.',
    specs: {
      'Dimensions': '2400mm x 1200mm (2.88 m² coverage)',
      'Thickness': '10mm',
      'Weight': '8.2 kg/m²',
      'Compliance': 'NZBC Clause E3 Internal Moisture Compliant',
    },
    features: [
      'Water resistant core prevents mould growth and structural board swelling',
      'Ideal substrate for ceramic tiles, paint finishes, and splashback panels',
    ],
  },
  {
    sku: '7834910',
    name: 'Concealed Pull-Out Twin Laundry Hamper 2x35L Bins Soft-Close',
    category: 'Laundry Accessories & Storage',
    collection: 'PlaceMakers Storage Solutions',
    price: 280.00,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/kitchens-laundry/laundry/laundry-accessories/p/7834910',
    description: 'Integrated under-bench sliding double hamper system on heavy-duty Blum undermount soft-close runners for effortless sorting of laundry.',
    specs: {
      'Cabinet Fit': 'Fits standard 450mm or 600mm base cabinet carcass',
      'Capacity': '2 x 35L removable polypropylene laundry baskets (70L total)',
      'Runner Type': 'Over-extension synchronized soft-close runners (45kg rating)',
    },
    features: [
      'Keeps dirty laundry hidden out of sight behind seamless cabinet door',
      'Removable baskets with carry handles for easy transport to washing machine',
    ],
  },

  // ── TIMBER & DECKING ──────────────────────────────────────────────────────
  {
    sku: '1930650',
    name: 'Kwila Griptread Decking FSC 100 x 25mm (90 x 19mm)',
    category: 'Timber & Decking',
    collection: 'Hardwood Timber Decking',
    price: 14.50,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/timber-plywood/decking/hardwood-decking/decking-kwila-fsc/kwila-griptread-decking-fsc-100-x-25mm-90-x-19mm/p/1930650',
    description: 'Premium FSC 100% certified kiln-dried Kwila hardwood decking board with anti-slip griptread surface on one face and smooth on the other.',
    specs: {
      'Finished Size': '90mm Width x 19mm Thickness',
      'Nominal Size': '100 x 25mm',
      'Species': 'Kwila (Merbau)',
      'Durability Class': 'Class 2 Above Ground (25+ Year Lifespan)',
      'Treatment': 'Natural Tannin Kiln Dried (KD)',
      'Certification': 'FSC 100% Responsible Forestry Certified',
      'Fixing Requirement': '316 Marine Grade Stainless Steel Decking Screws (10g x 65mm)',
      'Compliance': 'NZS 3604 Structural Timber Decking Pass',
    },
    features: [
      'Griptread reed face provides high traction in wet New Zealand winter conditions',
      'Naturally resistant to rot, termites, and fungal decay without chemical treatment',
      'Pre-grooved for consistent 5mm board spacing during installation',
    ],
  },
  {
    sku: '1910110',
    name: '140x45mm Radiata Pine H3.2 SG8 Structural Framing Joists',
    category: 'Timber & Decking',
    collection: 'Structural Framing Timber',
    price: 9.80,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/timber-plywood/framing/p/1910110',
    description: 'Treated New Zealand Radiata Pine structural timber machine-stress graded SG8 for deck joists and exterior subfloor framing.',
    specs: {
      'Dimensions': '140mm x 45mm',
      'Grade': 'SG8 (Structural Graded 8 GPa)',
      'Treatment Level': 'H3.2 CCA / MCA Treated for Exterior Above-Ground Exposure',
      'Standards': 'NZS 3604 & NZS 3602 Compliant',
    },
    features: [
      'Engineered for maximum joist spans up to 2.4m @ 450mm centers',
      'Guaranteed resistance against fungal rot and wood boring insects',
    ],
  },
  {
    sku: '1920330',
    name: '316 Marine Grade Stainless Steel Decking Screws (10g x 65mm, Box of 500)',
    category: 'Fasteners & Structural Fixings',
    collection: 'PlaceMakers Heavy Duty Fixings',
    price: 74.50,
    currency: 'NZD',
    imageUrl: 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj',
    url: 'https://www.placemakers.co.nz/online/fasteners-fixings/screws/decking-screws/p/1920330',
    description: 'Premium A4 (316) marine-grade stainless steel self-drilling screws with Torx T20 drive and trim countersunk head.',
    specs: {
      'Size': '10 Gauge x 65mm Length',
      'Grade': 'AISI 316 Marine Stainless Steel (Zone D Sea Spray Compliant)',
      'Drive': 'Torx Star Drive T20 (Bit Included)',
      'Pack Quantity': '500 Screws (~14 m² deck coverage)',
    },
    features: [
      'Self-countersinking head creates a clean flush finish without timber tear-out',
      'Mandatory for hardwood timbers with natural tannins (Kwila, Vitex) and coastal environments',
    ],
  },
];

async function run() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  await client.connect();
  console.log('Connected to MongoDB!');

  const jx = client.db('journeyx');
  const prodsCol = jx.collection('products');
  const docsCol = jx.collection('documents');

  for (const p of PLACEMAKERS_PRODUCTS) {
    const textChunk = `${p.name}\nSKU: ${p.sku}\nCategory: ${p.category}\nCollection: ${p.collection}\nPrice: $${p.price} ${p.currency}\nDescription: ${p.description}\n\nTechnical Specifications:\n${Object.entries(p.specs).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nKey Features:\n${p.features.map(f => `- ${f}`).join('\n')}\nURL: ${p.url}`;

    const prodDoc = {
      tenantId: 'placemakers',
      brand: 'placemakers',
      sku: p.sku,
      name: p.name,
      title: p.name,
      category: p.category,
      collection: p.collection,
      price: p.price,
      currency: p.currency,
      imageUrl: p.imageUrl,
      images: [p.imageUrl],
      url: p.url,
      sourceUrl: p.url,
      description: p.description,
      specs: p.specs,
      features: p.features,
      inStock: true,
      stockInfo: { label: 'In stock · Mt Wellington (60-min Click & Collect)', color: '#059669' },
      updatedAt: new Date().toISOString(),
    };

    await prodsCol.updateOne(
      { tenantId: 'placemakers', sku: p.sku },
      { $set: prodDoc },
      { upsert: true }
    );

    const docRecord = {
      tenantId: 'placemakers',
      brand: 'placemakers',
      type: 'product',
      title: p.name,
      sourceUrl: p.url,
      content: textChunk,
      chunk: textChunk,
      chunkIndex: 0,
      metadata: {
        type: 'product',
        tenantId: 'placemakers',
        brand: 'placemakers',
        category: p.category,
        collection: p.collection,
        sku: p.sku,
        price: p.price,
        currency: p.currency,
        imageUrl: p.imageUrl,
        images: [p.imageUrl],
        url: p.url,
        specs: p.specs,
        features: p.features,
      },
      updatedAt: new Date().toISOString(),
    };

    await docsCol.updateOne(
      { tenantId: 'placemakers', 'metadata.sku': p.sku },
      { $set: docRecord },
      { upsert: true }
    );

    console.log(`✓ Indexed: [${p.sku}] ${p.name}`);
  }

  console.log(`\nSuccessfully indexed all ${PLACEMAKERS_PRODUCTS.length} PlaceMakers products & documents!`);
  await client.close();
}

run().catch((err) => {
  console.error('Indexing failed:', err);
  process.exit(1);
});
