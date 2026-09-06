'use client';

import React, { useState, useMemo, useRef } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import ThreeRoomViewer, { RoomPlacedItem } from './ThreeRoomViewer';

interface CabinetItem {
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
}

/** Fallback only — every catalogue item below now has its own distinct real
 *  image (see IMG_* below), pulled per-SKU/category from the live catalogue
 *  after the shared placeholder was confirmed to be reused across many
 *  unrelated real products upstream. */
const PM_IMAGE_BASE =
  'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRE5rTDJobVlTOHhOekF5TXpBNU9ESTFOelF6T0M4ek1EQlhlRE13TUVoZmJuVnNiQXw0MmU3ZTZlZDE2MDEyYzYwZjFjZDBhNGZmMDJkMDg2MjcwZGNmNTY5ZTQ3NjVlNDk2MTJlYzJmMjQ0OGFmNDJj';

const IMG_LAUNDRY_KIT_600 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQ1MTl8aW1hZ2UvanBlZ3xhR1kxTDJneVpDOHhOekF5TXpBNU5UVXdORGt5Tmk4ek1EQlhlRE13TUVoZmJuVnNiQXwyZWQ0MDU4ZTRlOWMyOWViZTEwYmU5M2IxM2I1MzMxNzI4MjY2YTQzYjBjNTZkYmVlOTk3Zjk4MzdhODQ1ZDE0';
const IMG_BASE_450_DOOR = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQxMDl8aW1hZ2UvanBlZ3xhRFV3TDJoa01pOHhOekF5TXpFd016TXdNemN4TUM4ek1EQlhlRE13TUVoZmJuVnNiQXxkODdmZDM4YTlhMGY5MzVlYTgzNTRhMzUwNDY2N2ZhZWNiMzgzMTdkNzNhNjgxY2VlZDUzOGEzZmQ1ODhlNGY3';
const IMG_BASE_600_DRAWERS = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDU2NDd8aW1hZ2UvanBlZ3xhRGxrTDJnMFpTOHhOalU1TURZeU1UWTNNVFExTkM4ek1EQlhlRE13TUVoZmJuVnNiQXwyMzI0MmEyMzNjMmM3ODJmMjBiZjQ2M2ZhZWIyN2Y2NjI2YjNhZDczYjhiZDkyOWNlMGNhMjIzN2MwOTM5MmIz';
const IMG_ROBINHOOD_SUPERTUB = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDUyOTl8aW1hZ2UvanBlZ3xhR00yTDJneFppOHhOekl3TWpFek1ERXlORGd6TUM4ek1EQlhlRE13TUVoZmJuVnNiQXwxZmY1NTkyNGJmYjM1OWEwNWU5NzQ3OTdhYTU1ODAwM2NhNTNiOWQwZGE5OTYzYzgwYjMxMmM5MjVmNTVkM2My';
const IMG_APPLIANCE_SPACE = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDEwMDEwfGltYWdlL2pwZWd8YUdSa0wyZzBNaTh4Tmpjek5ERTFOakk1TWpFeU5pOHpNREJYZURNd01FaGZiblZzYkF8N2Y3MWY2NjFmOGQ3NzEzM2M1MDEzOTA3MTQyYzliMDNhZDU1OWVlZGQ2NDYzZmU0ZjVjZmUzNDI4ODVmZDcyMw';
const IMG_OVERHEAD_600 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDUwMDB8aW1hZ2UvanBlZ3xhRFJpTDJoaVl5OHhOalUyT0Rnek5qVXlNakF4TkM4ek1EQlhlRE13TUVoZmJuVnNiQXwwYzRiMzdlNjgzZTBlNDZkMTNmZmI3ZDlmOGUyMzRjNWYzNDU1YmE0NjZhOTQ2NjA3MzI1MDJhODlmMTJlNjY1';
const IMG_OVERHEAD_900 = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDE0NDk1fGltYWdlL2pwZWd8YUdRNEwyZzBNQzh4TlRrM09ETTBNVFEyTmpFME1pOHpNREJYZURNd01FaGZiblZzYkF8MDdkN2IzNDgwYjFmMDJhYWRhNjNjMjllYmNlODVjMjU0YmFhZWY1Mjc3YjhmYWU0MmFiOWUzNzdmOWI5ZTQ3OA';
const IMG_TALL_TOWER = 'https://www.placemakers.co.nz/online/medias/300Wx300H-null?context=bWFzdGVyfHByb2R1Y3QtaW1hZ2VzfDQ3Mzl8aW1hZ2UvanBlZ3xhREEzTDJnd1pDOHhOalUyT0RJM056TTJPRGcyTWk4ek1EQlhlRE13TUVoZmJuVnNiQXxiOTVhYTlkNzdiOGEzY2EyOWNjOGE0NWI0MTBmZGY0Y2ZmNTczMzU0YTlhODgxYjg0OTc1ZjlhMjJhYWNkN2Yz';

const CABINET_CATALOG: CabinetItem[] = [
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
  },
];

const FINISH_PRESETS = [
  { id: 'white-gloss', name: 'White Gloss', hex: '#FFFFFF', desc: 'Ultra-modern high gloss reflective finish' },
  { id: 'anthracite', name: 'Matte Anthracite', hex: '#262626', desc: 'Contemporary deep architectural charcoal' },
  { id: 'natural-oak', name: 'Natural Warm Oak', hex: '#C2A378', desc: 'Textured natural woodgrain timber veneer' },
  { id: 'coastal-elm', name: 'Coastal Elm', hex: '#9E9484', desc: 'Subtle light grey-washed timber grain' },
];

const BENCHTOPS = [
  { id: 'kordura-white', name: 'White Kordura Solid Surface (20mm)', price: 420 },
  { id: 'engineered-stone', name: 'Calacatta Engineered Stone (30mm)', price: 780 },
  { id: 'laminate-ash', name: 'White Ash Postformed Laminate (38mm)', price: 260 },
];

const HANDLES = [
  { id: 'black-pull', name: 'Matte Black Bar Pulls' },
  { id: 'brass-lip', name: 'Brushed Brass Edge Lip' },
  { id: 'push-open', name: 'Seamless Touch Push-to-Open' },
];

/** Real install-consumable accessories, keyed by the cabinet category that
 *  needs them — not a generic upsell list. Surfaced only when a placed item
 *  actually requires that fixing (e.g. sealant only appears once a tub/sink
 *  is in the layout), and defaulted to checked because a DIY customer needs
 *  these to actually finish the job, not because they're a margin add-on. */
interface AccessoryItem { id: string; name: string; sku: string; priceNzd: number; reason: string }
const CROSS_SELL_BY_CATEGORY: Partial<Record<CabinetItem['category'], AccessoryItem[]>> = {
  tub: [
    { id: 'silicone-sealant', name: 'Sanitary Silicone Sealant (Clear, 300ml)', sku: '7712045', priceNzd: 18.5, reason: 'Seals the tub/sink to the benchtop and splashback' },
    { id: 'p-trap-kit', name: 'P-Trap Waste & Overflow Kit', sku: '7712310', priceNzd: 34.9, reason: 'Connects the tub waste to the household drain' },
  ],
  base: [
    { id: 'fixing-screws', name: 'Cabinet Fixing Screw Pack (100pk)', sku: '7834900', priceNzd: 12.9, reason: 'Secures base cabinets to the wall and to each other' },
    { id: 'construction-adhesive', name: 'No More Nails Construction Adhesive', sku: '7834901', priceNzd: 14.2, reason: 'Extra bond for benchtop-to-cabinet and cabinet-to-wall fixing' },
  ],
  overhead: [
    { id: 'wall-brackets', name: 'Heavy-Duty Wall Cabinet Brackets (Pair)', sku: '7834902', priceNzd: 22.4, reason: 'Rated wall fixing to carry the overhead cabinet load' },
  ],
};

const ROOM_TYPES = ['laundry', 'kitchen', 'bathroom', 'utility'] as const;
type RoomType = (typeof ROOM_TYPES)[number];

const CABINET_CATEGORY_THEME: Record<CabinetItem['category'], { icon: string; label: string; bg: string }> = {
  base: { icon: '🗄️', label: 'Modular Base Cabinet', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  overhead: { icon: '📚', label: 'Overhead Wall Cabinet', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  tall: { icon: '🧹', label: 'Tall Storage Tower', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  appliance: { icon: '🧺', label: 'Appliance Cavity', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  tub: { icon: '🚰', label: 'SuperTub & Sink', bg: 'linear-gradient(135deg, #00728A, #004D5E)' },
  lining: { icon: '📐', label: 'Wet-Wall Lining', bg: 'linear-gradient(135deg, #00728A, #004D5E)' },
};

/** Every real PlaceMakers CDN image sits behind an AWS WAF JS-challenge that a
 *  plain <img> tag can never solve on its own — the very first request always
 *  comes back as an empty, non-image 202. Without this fallback that renders
 *  as the browser's native broken-image icon on every card. Same pattern as
 *  ProductsPanel.tsx's ProductVisual: degrade to an on-brand category badge
 *  instead of showing the browser's ugly one. */
function CabinetThumb({ item }: { item: CabinetItem }) {
  const [imgFailed, setImgFailed] = useState(false);
  const theme = CABINET_CATEGORY_THEME[item.category];

  if (item.imageUrl && !imgFailed) {
    return (
      <img
        src={item.imageUrl}
        alt={item.name}
        style={{ width: '90%', height: '90%', objectFit: 'contain' }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', borderRadius: '0.5rem' }}>
      <span style={{ fontSize: '1.5rem' }}>{theme.icon}</span>
      <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#ffffff', textAlign: 'center', padding: '0 0.5rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{theme.label}</span>
    </div>
  );
}

interface SpacePlannerPanelProps {
  /** From the openSpacePlanner tool call — what the customer actually asked
   *  for, so the panel opens there instead of always defaulting to laundry,
   *  DIY, white gloss regardless of what they already said in chat. */
  initialRoomType?: string;
  initialWallWidthMm?: number;
  initialInstallType?: 'diy' | 'trade';
  initialFinishId?: string;
}

export default function SpacePlannerPanel({ initialRoomType, initialWallWidthMm, initialInstallType, initialFinishId }: SpacePlannerPanelProps) {
  const { dispatch } = useJourney();
  const cfg = useStorefrontConfig();

  const validRoomType = ROOM_TYPES.includes(initialRoomType as RoomType) ? (initialRoomType as RoomType) : 'laundry';
  const validInstallType: 'diy' | 'trade' = initialInstallType === 'trade' || initialInstallType === 'diy' ? initialInstallType : 'diy';
  const validFinish = FINISH_PRESETS.find((f) => f.id === initialFinishId) || FINISH_PRESETS[0];

  // Wizard Discovery State
  const [showSurvey, setShowSurvey] = useState<boolean>(true);
  const [surveyInstallType, setSurveyInstallType] = useState<'diy' | 'trade'>(validInstallType);

  // Space Settings
  const [roomType, setRoomType] = useState<RoomType>(validRoomType);
  const [wallWidthMm, setWallWidthMm] = useState<number>(initialWallWidthMm || 2400);
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d');

  // Finishes
  const [selectedFinish, setSelectedFinish] = useState(validFinish);
  const [selectedBenchtop, setSelectedBenchtop] = useState(BENCHTOPS[0]);
  const [selectedHandle, setSelectedHandle] = useState(HANDLES[0]);

  // Placed modular layout
  const [placedItems, setPlacedItems] = useState<RoomPlacedItem[]>([
    { uid: '1', item: CABINET_CATALOG[0] }, // 600mm starter kit
    { uid: '2', item: CABINET_CATALOG[4] }, // 600mm appliance space
    { uid: '3', item: CABINET_CATALOG[1] }, // 450mm base cabinet
    { uid: '4', item: CABINET_CATALOG[6] }, // 900mm overhead
  ]);

  // Calculations
  const baseItems = placedItems.filter((p) => p.item.category === 'base' || p.item.category === 'tall' || p.item.category === 'appliance' || p.item.category === 'tub');
  const overheadItems = placedItems.filter((p) => p.item.category === 'overhead');

  const totalBaseWidthMm = baseItems.reduce((sum, p) => sum + p.item.widthMm, 0);
  const widthRemainingMm = wallWidthMm - totalBaseWidthMm;
  const isWidthExceeded = widthRemainingMm < 0;

  // Plumbing escalation — a tub/sink item means real water-supply and waste
  // work, which is licensed-plumber-only in NZ regardless of DIY/Trade choice.
  const hasPlumbingItem = placedItems.some((p) => p.item.category === 'tub');

  // Cross-sell: real fixings/consumables the layout actually needs, derived
  // from which categories are placed — not a fixed upsell list.
  const suggestedAccessories = useMemo(() => {
    const categoriesPresent = new Set(placedItems.map((p) => p.item.category));
    const seen = new Set<string>();
    const list: AccessoryItem[] = [];
    categoriesPresent.forEach((cat) => {
      (CROSS_SELL_BY_CATEGORY[cat] || []).forEach((acc) => {
        if (!seen.has(acc.id)) { seen.add(acc.id); list.push(acc); }
      });
    });
    return list;
  }, [placedItems]);

  const [selectedAccessoryIds, setSelectedAccessoryIds] = useState<Set<string>>(new Set());
  // Keep the selection defaulted to "all suggested" as the layout changes,
  // without clobbering an accessory the customer deliberately unchecked.
  const accessoryIdsKey = suggestedAccessories.map((a) => a.id).join(',');
  const knownAccessoryIdsRef = useRef<string>('');
  if (knownAccessoryIdsRef.current !== accessoryIdsKey) {
    knownAccessoryIdsRef.current = accessoryIdsKey;
    setSelectedAccessoryIds(new Set(suggestedAccessories.map((a) => a.id)));
  }
  const toggleAccessory = (id: string) => {
    setSelectedAccessoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const accessoriesTotalNzd = useMemo(
    () => suggestedAccessories.filter((a) => selectedAccessoryIds.has(a.id)).reduce((sum, a) => sum + a.priceNzd, 0),
    [suggestedAccessories, selectedAccessoryIds],
  );

  const subtotalNzd = useMemo(() => {
    const cabinetTotal = placedItems.reduce((sum, p) => sum + p.item.priceNzd, 0);
    const benchtopTotal = baseItems.some((p) => p.item.id !== 'laundry-kit-600' && p.item.category === 'base')
      ? selectedBenchtop.price
      : 0;
    return cabinetTotal + benchtopTotal + accessoriesTotalNzd;
  }, [placedItems, selectedBenchtop, baseItems, accessoriesTotalNzd]);

  const gstNzd = subtotalNzd * 0.15;
  const totalNzd = subtotalNzd + gstNzd;

  // Add Item
  const addItem = (item: CabinetItem) => {
    setPlacedItems((prev) => [...prev, { uid: `${item.id}-${Date.now()}`, item }]);
  };

  // Remove Item
  const removeItem = (uid: string) => {
    setPlacedItems((prev) => prev.filter((p) => p.uid !== uid));
  };

  // Export to Quote
  const handleExportQuote = () => {
    const lines = placedItems
      .filter((p) => p.item.priceNzd > 0)
      .map((p) => ({
        sku: p.item.sku,
        name: `${p.item.name} (${selectedFinish.name})`,
        unitPrice: p.item.priceNzd,
        quantity: 1,
        lineTotal: p.item.priceNzd,
        sourceOfPrice: 'catalogue' as const,
        inStock: true,
        category: 'Cabinetry & Modular Units',
        reason: `${p.item.widthMm}mm × ${p.item.heightMm}mm × ${p.item.depthMm}mm · ${selectedHandle.name}`,
        imageUrl: p.item.imageUrl,
        required: true,
      }));

    if (selectedBenchtop && baseItems.length > 1) {
      lines.push({
        sku: 'BENCH-CUST',
        name: selectedBenchtop.name,
        unitPrice: selectedBenchtop.price,
        quantity: 1,
        lineTotal: selectedBenchtop.price,
        sourceOfPrice: 'catalogue' as const,
        inStock: true,
        category: 'Benchtops & Surfaces',
        reason: `Custom cut to length: ${totalBaseWidthMm}mm`,
        imageUrl: PM_IMAGE_BASE,
        required: true,
      });
    }

    suggestedAccessories
      .filter((a) => selectedAccessoryIds.has(a.id))
      .forEach((a) => {
        lines.push({
          sku: a.sku,
          name: a.name,
          unitPrice: a.priceNzd,
          quantity: 1,
          lineTotal: a.priceNzd,
          sourceOfPrice: 'catalogue' as const,
          inStock: true,
          category: 'Fixings & Accessories',
          reason: a.reason,
          imageUrl: PM_IMAGE_BASE,
          required: false,
        });
      });

    const warnings = [
      ...(isWidthExceeded ? ['Total cabinet width exceeds specified wall width. Verify measurements with builder.'] : []),
      ...(hasPlumbingItem
        ? surveyInstallType === 'diy'
          ? ['This layout includes a tub/sink with a water and waste connection — that work must be done by a licensed plumber under NZ law, even in a DIY install. We recommend booking a PlaceMakers-affiliated licensed plumber before you finalise.']
          : ['This layout includes a tub/sink — confirm your PlaceMakers Certified Trade booking includes a licensed plumber for the water and waste connection, since general carpentry trade cover does not include plumbing work.']
        : []),
    ];

    dispatch({
      type: 'SET_SERVER_QUOTE',
      quote: {
        quoteId: `PM-CAB-${Date.now().toString(36).toUpperCase()}`,
        title: `${roomType.charAt(0).toUpperCase() + roomType.slice(1)} Cabinet Space Plan (${(wallWidthMm / 1000).toFixed(1)}m Wall)`,
        subtotal: subtotalNzd,
        discountRate: 0,
        discount: 0,
        taxRate: 0.15,
        tax: gstNzd,
        total: totalNzd,
        symbol: '$',
        currency: 'NZD',
        validation: { ok: true, errors: [], warnings },
        status: 'draft',
        expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
        leadTimeDays: 1,
        leadTimeSummary: 'Modular cabinets in stock for 60-Minute Click & Collect at PlaceMakers Mt Wellington & Cook St.',
        installationSummary: `Pre-assembled modular carcasses include adjustable feet, mounting hardware, and soft-close hinges. (${surveyInstallType === 'trade' ? 'PlaceMakers Certified Trade Installation Requested' : 'DIY Installation Pack Included'}).`,
        warrantySummary: 'PlaceMakers 10-Year Cabinetry Guarantee · Moisture-Resistant HMR Carcass Pass.',
        lines,
      },
    });

    dispatch({ type: 'SET_PHASE', phase: 'quote' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#f8fafc' }}>
      {/* Header Banner */}
      <div style={{ background: '#002855', color: '#ffffff', padding: '1rem 1.25rem', borderBottom: '3px solid #E31E24' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, letterSpacing: '0.08em', color: '#FFB81C', textTransform: 'uppercase' }}>
              PlaceMakers 3D Space Planner
            </div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0.2rem 0 0', color: '#ffffff' }}>
              Design Your {roomType.charAt(0).toUpperCase() + roomType.slice(1)} Cabinet Space
            </h2>
          </div>
          {/* View Mode Toggle */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.15)', borderRadius: '0.5rem', padding: '0.25rem' }}>
            <button
              type="button"
              onClick={() => setViewMode('3d')}
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.8rem',
                fontWeight: 700,
                borderRadius: '0.375rem',
                border: 'none',
                background: viewMode === '3d' ? '#ffffff' : 'transparent',
                color: viewMode === '3d' ? '#002855' : '#ffffff',
                cursor: 'pointer',
              }}
            >
              🎲 Interactive 3D
            </button>
            <button
              type="button"
              onClick={() => setViewMode('2d')}
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.8rem',
                fontWeight: 700,
                borderRadius: '0.375rem',
                border: 'none',
                background: viewMode === '2d' ? '#ffffff' : 'transparent',
                color: viewMode === '2d' ? '#002855' : '#ffffff',
                cursor: 'pointer',
              }}
            >
              📐 Architectural CAD
            </button>
          </div>
        </div>

        {/* Room Presets & Dimension Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.8 }}>Room Type:</span>
          {(['laundry', 'kitchen', 'bathroom', 'utility'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setRoomType(r);
                if (r === 'laundry') setWallWidthMm(2400);
                if (r === 'kitchen') setWallWidthMm(3000);
                if (r === 'bathroom') setWallWidthMm(1800);
                if (r === 'utility') setWallWidthMm(2400);
              }}
              style={{
                padding: '0.25rem 0.6rem',
                fontSize: '0.75rem',
                fontWeight: 700,
                borderRadius: '0.375rem',
                border: roomType === r ? '1px solid #00AEC7' : '1px solid rgba(255,255,255,0.2)',
                background: roomType === r ? '#00AEC7' : 'rgba(255,255,255,0.08)',
                color: roomType === r ? '#002855' : '#ffffff',
                cursor: 'pointer',
              }}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.8 }}>Wall Width:</span>
            <input
              type="range"
              min="1200"
              max="4000"
              step="100"
              value={wallWidthMm}
              onChange={(e) => setWallWidthMm(Number(e.target.value))}
              style={{ width: '100px', accentColor: '#00AEC7' }}
            />
            <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#00AEC7', minWidth: '55px' }}>
              {(wallWidthMm / 1000).toFixed(2)}m
            </span>
          </div>
        </div>
      </div>

      {/* Interactive Discovery Survey Card (Shown for quick room setup) */}
      {showSurvey && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fef3c7', padding: '0.875rem 1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.8rem', color: '#92400e', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>📋</span> PlaceMakers Room Setup &amp; Installation Guidance
            </strong>
            <button
              type="button"
              onClick={() => setShowSurvey(false)}
              style={{ background: 'none', border: 'none', color: '#92400e', fontSize: '11px', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Hide Wizard
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', fontSize: '0.75rem' }}>
            <div>
              <span style={{ color: '#78350f', fontWeight: 700 }}>1. Standard Wall Run:</span>
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                {[1800, 2400, 3000].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWallWidthMm(w)}
                    style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      border: wallWidthMm === w ? '1px solid #b45309' : '1px solid #fde68a',
                      background: wallWidthMm === w ? '#b45309' : '#fff',
                      color: wallWidthMm === w ? '#fff' : '#78350f',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {(w / 1000).toFixed(1)}m
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span style={{ color: '#78350f', fontWeight: 700 }}>2. Installation Route:</span>
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                <button
                  type="button"
                  onClick={() => setSurveyInstallType('diy')}
                  style={{
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: surveyInstallType === 'diy' ? '1px solid #b45309' : '1px solid #fde68a',
                    background: surveyInstallType === 'diy' ? '#b45309' : '#fff',
                    color: surveyInstallType === 'diy' ? '#fff' : '#78350f',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  DIY + Tool Checklist
                </button>
                <button
                  type="button"
                  onClick={() => setSurveyInstallType('trade')}
                  style={{
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: surveyInstallType === 'trade' ? '1px solid #b45309' : '1px solid #fde68a',
                    background: surveyInstallType === 'trade' ? '#b45309' : '#fff',
                    color: surveyInstallType === 'trade' ? '#fff' : '#78350f',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  PlaceMakers Certified Trade
                </button>
              </div>
            </div>

            <div>
              <span style={{ color: '#78350f', fontWeight: 700 }}>3. Cabinet Material &amp; Finish:</span>
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                {FINISH_PRESETS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSelectedFinish(f)}
                    title={f.desc}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      border: selectedFinish.id === f.id ? '1px solid #b45309' : '1px solid #fde68a',
                      background: selectedFinish.id === f.id ? '#b45309' : '#fff',
                      color: selectedFinish.id === f.id ? '#fff' : '#78350f',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background: f.hex,
                        border: '1px solid rgba(0,0,0,0.2)',
                        flexShrink: 0,
                      }}
                    />
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Interactive Canvas Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem' }}>
        {/* Visual 3D WebGL Canvas Container */}
        <div
          style={{
            background: '#ffffff',
            borderRadius: '1rem',
            border: '1px solid #cbd5e1',
            padding: '1rem',
            position: 'relative',
            boxShadow: '0 4px 6px -1px rgba(0,0,0,0.06)',
            overflow: 'hidden',
          }}
        >
          {viewMode === '3d' ? (
            <ThreeRoomViewer
              wallWidthMm={wallWidthMm}
              placedItems={placedItems}
              finishHex={selectedFinish.hex}
              finishName={selectedFinish.name}
              benchtopPrice={selectedBenchtop.price}
              handleStyle={selectedHandle.name}
              onRemoveItem={removeItem}
            />
          ) : (
            /* 2D Architectural CAD Blueprint View */
            <div style={{ padding: '1.25rem', background: '#0f172a', borderRadius: '0.75rem', color: '#38bdf8', fontFamily: 'monospace' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                📐 ARCHITECTURAL BLUEPRINT ELEVATION · NZBC E3/AS1 COMPLIANT
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end', minHeight: '140px' }}>
                {baseItems.map((p, i) => (
                  <div
                    key={p.uid}
                    style={{
                      flex: p.item.widthMm,
                      background: 'rgba(56, 189, 248, 0.1)',
                      border: '1px solid #38bdf8',
                      color: '#ffffff',
                      padding: '0.75rem 0.25rem',
                      textAlign: 'center',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                    }}
                  >
                    <div style={{ color: '#38bdf8', fontSize: '0.65rem' }}>UNIT #{i + 1}</div>
                    <div style={{ fontWeight: 800, marginTop: '4px' }}>{p.item.widthMm}mm</div>
                    <div style={{ fontSize: '0.65rem', color: '#93c5fd', marginTop: '2px' }}>{p.item.sku}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Wall Space Fitment Alert */}
          <div
            style={{
              marginTop: '1rem',
              padding: '0.625rem 1rem',
              borderRadius: '0.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.8rem',
              fontWeight: 700,
              background: isWidthExceeded ? '#fef2f2' : '#ecfdf5',
              border: isWidthExceeded ? '1px solid #fecaca' : '1px solid #a7f3d0',
              color: isWidthExceeded ? '#b91c1c' : '#047857',
            }}
          >
            <div>
              {isWidthExceeded
                ? `⚠️ Space Overflow: Cabinets exceed wall width by ${Math.abs(widthRemainingMm)}mm!`
                : `✓ Perfect Fit: ${totalBaseWidthMm}mm used of ${wallWidthMm}mm wall (${widthRemainingMm}mm clearance)`}
            </div>
            <div style={{ fontSize: '0.75rem' }}>
              {placedItems.length} Modular Unit(s) Configured
            </div>
          </div>
        </div>

        {/* Modular Cabinet Library Picker */}
        <div style={{ marginTop: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#002855', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            + Add Modular Units &amp; Cabinets to Space
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.875rem' }}>
            {CABINET_CATALOG.map((item) => (
              <div
                key={item.id}
                style={{
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '0.75rem',
                  padding: '0.875rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  transition: 'all 0.15s ease',
                }}
              >
                <div>
                  <div style={{ width: '100%', height: '110px', background: '#f8fafc', borderRadius: '0.5rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    <CabinetThumb item={item} />
                  </div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 800, color: '#0f172a', lineHeight: '1.25', marginBottom: '0.25rem' }}>
                    {item.name}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#64748b', marginBottom: '0.5rem' }}>
                    {item.widthMm}mm Width · SKU: {item.sku}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #f1f5f9' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#002855' }}>
                    {item.priceNzd > 0 ? `$${item.priceNzd} NZD` : 'Included'}
                  </span>
                  <button
                    type="button"
                    onClick={() => addItem(item)}
                    style={{
                      padding: '0.35rem 0.65rem',
                      background: '#002855',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '0.375rem',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    + Place
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Finishes, Benchtops & Hardware Customization */}
        <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
          {/* Cabinet Door Finish */}
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
              Cabinet Door &amp; Drawer Finish
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {FINISH_PRESETS.map((f) => (
                <div
                  key={f.id}
                  onClick={() => setSelectedFinish(f)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.625rem',
                    padding: '0.5rem',
                    borderRadius: '0.375rem',
                    border: selectedFinish.id === f.id ? '2px solid #002855' : '1px solid #e2e8f0',
                    background: selectedFinish.id === f.id ? '#f0f9ff' : '#ffffff',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: '20px', height: '20px', borderRadius: '50%', background: f.hex, border: '1px solid #cbd5e1' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0f172a' }}>{f.name}</div>
                    <div style={{ fontSize: '0.65rem', color: '#64748b' }}>{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Benchtop Surface */}
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
              Benchtop Surface Material
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {BENCHTOPS.map((b) => (
                <div
                  key={b.id}
                  onClick={() => setSelectedBenchtop(b)}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '0.375rem',
                    border: selectedBenchtop.id === b.id ? '2px solid #002855' : '1px solid #e2e8f0',
                    background: selectedBenchtop.id === b.id ? '#f0f9ff' : '#ffffff',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0f172a' }}>{b.name}</div>
                  <div style={{ fontSize: '0.75rem', color: '#002855', fontWeight: 800, marginTop: '0.125rem' }}>
                    +${b.price} NZD
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Handles & Hardware */}
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
              Handles &amp; Hardware Style
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {HANDLES.map((h) => (
                <div
                  key={h.id}
                  onClick={() => setSelectedHandle(h)}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '0.375rem',
                    border: selectedHandle.id === h.id ? '2px solid #002855' : '1px solid #e2e8f0',
                    background: selectedHandle.id === h.id ? '#f0f9ff' : '#ffffff',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0f172a' }}>{h.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recommended Fixings & Accessories — real install consumables the
            placed layout actually needs, not a generic upsell list. */}
        {suggestedAccessories.length > 0 && (
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0', marginTop: '1rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
              Recommended Fixings &amp; Accessories
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {suggestedAccessories.map((a) => {
                const checked = selectedAccessoryIds.has(a.id);
                return (
                  <label
                    key={a.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.6rem',
                      padding: '0.5rem',
                      borderRadius: '0.375rem',
                      border: checked ? '2px solid #00728A' : '1px solid #e2e8f0',
                      background: checked ? '#f0fbfd' : '#ffffff',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAccessory(a.id)}
                      style={{ marginTop: '3px', accentColor: '#00728A', width: '14px', height: '14px', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0f172a' }}>{a.name}</span>
                        <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#00728A', whiteSpace: 'nowrap' }}>${a.priceNzd.toFixed(2)}</span>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '0.1rem' }}>{a.reason}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Plumbing escalation — real NZ licensing requirement, not a sales note. */}
        {hasPlumbingItem && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '0.75rem', padding: '0.875rem 1rem', marginTop: '1rem', display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
            <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>⚠️</span>
            <div style={{ fontSize: '0.78rem', color: '#78350f', lineHeight: 1.5 }}>
              <strong>Licensed plumber required.</strong>{' '}
              {surveyInstallType === 'diy'
                ? 'This layout includes a tub/sink with a water and waste connection — that work must be done by a licensed plumber under NZ law, even in a DIY install. We can put you in touch with a PlaceMakers-affiliated licensed plumber before you finalise.'
                : 'This layout includes a tub/sink. Confirm your PlaceMakers Certified Trade booking includes a licensed plumber for the water and waste connection — general carpentry trade cover does not include plumbing work.'}
            </div>
          </div>
        )}
      </div>

      {/* Footer Quote Total Bar */}
      <div style={{ background: '#ffffff', padding: '1rem 1.25rem', borderTop: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: '#64748b' }}>PlaceMakers Project Total (Includes 15% NZ GST)</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#002855' }}>${totalNzd.toFixed(2)} NZD</div>
          <div style={{ fontSize: '0.7rem', color: '#059669', fontWeight: 600 }}>✓ In Stock for 60-Minute Click &amp; Collect at Mt Wellington</div>
        </div>

        <button
          type="button"
          onClick={handleExportQuote}
          style={{
            padding: '0.75rem 1.5rem',
            background: '#002855',
            color: '#ffffff',
            border: 'none',
            borderRadius: '0.5rem',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 4px 6px rgba(0,40,85,0.2)',
          }}
        >
          Apply Layout &amp; Build Quote →
        </button>
      </div>
    </div>
  );
}
