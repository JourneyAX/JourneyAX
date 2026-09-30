'use client';

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import ThreeRoomViewer, { RoomPlacedItem } from './ThreeRoomViewer';
import {
  type RoomType,
  type CabinetItem,
  type AccessoryItem,
  ROOM_TYPES,
  validateRoomLayout,
  validateAccessorySafety,
} from './space-planner-domain';
import {
  SpacePlannerExtension,
  calculateMaterialQuantityFromPack,
} from '@journeyax/business-pack';

export {
  ROOM_TYPES,
  type RoomType,
  type CabinetItem,
  type AccessoryItem,
  validateRoomLayout,
  validateAccessorySafety,
};

const CABINET_CATEGORY_THEME: Record<string, { icon: string; label: string; bg: string }> = {
  base: { icon: '🗄️', label: 'Base / Vanity Unit', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  overhead: { icon: '📚', label: 'Overhead / Mirror Cabinet', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  tall: { icon: '🧹', label: 'Tall Storage / Tower', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  appliance: { icon: '🧺', label: 'Appliance Cavity', bg: 'linear-gradient(135deg, #0B2A56, #071A38)' },
  tub: { icon: '🚰', label: 'Tub & Basin', bg: 'linear-gradient(135deg, #00728A, #004D5E)' },
  lining: { icon: '📐', label: 'Wet-Wall Lining', bg: 'linear-gradient(135deg, #00728A, #004D5E)' },
};

function CabinetThumb({ item }: { item: CabinetItem }) {
  const [imgFailed, setImgFailed] = useState(false);
  const theme = CABINET_CATEGORY_THEME[item.category] || CABINET_CATEGORY_THEME.base;

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
    <div
      style={{
        width: '100%',
        height: '100%',
        background: theme.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.25rem',
        borderRadius: '0.5rem',
      }}
    >
      <span style={{ fontSize: '1.5rem' }}>{theme.icon}</span>
      <span
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#ffffff',
          textAlign: 'center',
          padding: '0 0.5rem',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        }}
      >
        {theme.label}
      </span>
    </div>
  );
}

interface SpacePlannerPanelProps {
  initialRoomType?: string;
  initialWallWidthMm?: number;
  initialAreaM2?: number;
  initialInstallType?: 'diy' | 'trade';
  initialFinishId?: string;
}

export default function SpacePlannerPanel({
  initialRoomType,
  initialWallWidthMm,
  initialAreaM2,
  initialInstallType,
  initialFinishId,
}: SpacePlannerPanelProps) {
  const { dispatch } = useJourney();
  const cfg = useStorefrontConfig();

  // ── 1. FAIL CLOSED IF ACTIVE PACK CONFIGURATION IS UNAVAILABLE ───────
  const packPlanner = (cfg?.spacePlanner || (cfg?.components as any)?.spacePlanner) as
    | SpacePlannerExtension
    | undefined;

  const isConfigured = Boolean(
    packPlanner &&
      packPlanner.enabled &&
      Array.isArray(packPlanner.roomTypes) &&
      packPlanner.roomTypes.length > 0
  );

  // Active labels and presets from pack
  const labels = packPlanner?.plannerLabels || {};
  const finishes = packPlanner?.defaults?.finishes || [
    { id: 'white-gloss', name: 'White Gloss', hex: '#FFFFFF', desc: 'Modern high gloss reflective finish' },
  ];
  const benchtops = packPlanner?.defaults?.benchtops || [
    { id: 'kordura-white', name: 'Solid Surface (20mm)', priceNzd: 420 },
  ];
  const handles = packPlanner?.defaults?.handles || [
    { id: 'black-pull', name: 'Matte Black Bar Pulls' },
  ];

  const primaryColor = cfg.theme?.primaryColor || '#002855';
  const accentColor = cfg.theme?.accentColor || '#E31E24';

  const defaultRoomFromPack = packPlanner?.defaults?.defaultRoomType || packPlanner?.roomTypes?.[0]?.id || 'bathroom';
  const validRoomType: string =
    initialRoomType && packPlanner?.roomTypes?.some((r) => r.id === initialRoomType)
      ? initialRoomType
      : defaultRoomFromPack;

  const validInstallType: 'diy' | 'trade' =
    initialInstallType === 'trade' || initialInstallType === 'diy'
      ? initialInstallType
      : (packPlanner?.defaults?.defaultInstallType as 'diy' | 'trade') || 'diy';

  const validFinish =
    finishes.find((f) => f.id === initialFinishId) || finishes[0];

  // Wizard Discovery State
  const [showSurvey, setShowSurvey] = useState<boolean>(true);
  const [surveyInstallType, setSurveyInstallType] = useState<'diy' | 'trade'>(validInstallType);

  // Space Settings
  const [roomType, setRoomType] = useState<string>(validRoomType);
  const [wallWidthMm, setWallWidthMm] = useState<number>(
    initialWallWidthMm ||
      (packPlanner?.roomTypes?.find((r) => r.id === validRoomType)?.defaultDimensions?.widthMm ?? 1800)
  );
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d');

  // Finishes
  const [selectedFinish, setSelectedFinish] = useState(validFinish);
  const [selectedBenchtop, setSelectedBenchtop] = useState(benchtops[0]);
  const [selectedHandle, setSelectedHandle] = useState(handles[0]);

  // Server quote states
  const [isQuoting, setIsQuoting] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // ── 2. DYNAMIC CATALOGUE RESOLUTION VIA RUNTIME CONNECTOR ───────────
  const [catalogMap, setCatalogMap] = useState<
    Record<string, { sku: string; name: string; priceNzd: number; imageUrl?: string; inStock: boolean }>
  >({});
  const [isLoadingCatalog, setIsLoadingCatalog] = useState<boolean>(true);

  const packSkus = useMemo(() => {
    if (!packPlanner) return [];
    const set = new Set<string>();
    (packPlanner.componentReferences || []).forEach((c) => {
      if (c.sku) set.add(c.sku);
    });
    (packPlanner.roomTypes || []).forEach((r) => {
      (r.defaultComponents || []).forEach((dc) => {
        if (dc.sku) set.add(dc.sku);
      });
    });
    (packPlanner.compatibilityClassifications || []).forEach((cc) => {
      (cc.skuPatternsOrIds || []).forEach((sku) => {
        if (sku && !sku.includes('*')) set.add(sku);
      });
    });
    return Array.from(set);
  }, [packPlanner]);

  useEffect(() => {
    let active = true;
    async function fetchCatalog() {
      if (packSkus.length === 0) {
        setIsLoadingCatalog(false);
        return;
      }
      setIsLoadingCatalog(true);
      try {
        const tenantId = (cfg.projectId || 'placemakers').toLowerCase();
        const res = await fetch('/api/products/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-ID': tenantId,
          },
          body: JSON.stringify({ skus: packSkus }),
        });
        if (res.ok) {
          const data = await res.json();
          const map: Record<
            string,
            { sku: string; name: string; priceNzd: number; imageUrl?: string; inStock: boolean }
          > = {};
          for (const item of data.items || []) {
            map[item.sku] = {
              sku: item.sku,
              name: item.name || item.sku,
              priceNzd: typeof item.price === 'number' ? item.price : 0,
              imageUrl: item.imageUrl,
              inStock: item.inStock !== false,
            };
          }
          if (active) {
            setCatalogMap(map);
          }
        }
      } catch (err) {
        console.warn('[SpacePlannerPanel] Catalogue resolution error:', err);
      } finally {
        if (active) setIsLoadingCatalog(false);
      }
    }
    fetchCatalog();
    return () => {
      active = false;
    };
  }, [packSkus, cfg.projectId]);

  // Helper to construct default items from pack
  const getPackDefaultItems = useCallback(
    (rType: string): RoomPlacedItem[] => {
      if (!packPlanner) return [];
      const rDef = packPlanner.roomTypes.find((r) => r.id === rType) || packPlanner.roomTypes[0];
      if (!rDef || !rDef.defaultComponents || rDef.defaultComponents.length === 0) {
        return [];
      }
      return rDef.defaultComponents.map((dc, idx) => {
        const ref = packPlanner.componentReferences.find(
          (c) => c.componentId === dc.componentId || c.sku === dc.sku
        );
        const catItem = catalogMap[dc.sku];
        let qty = dc.quantity || 1;
        // Formula calculation: e.g. dynamic wet-wall area calculation
        if (ref?.category === 'lining' && rType === 'bathroom') {
          const rH = rDef.defaultDimensions?.heightMm || 2400;
          const rW = rDef.defaultDimensions?.widthMm || 1800;
          const area = typeof initialAreaM2 === 'number' && initialAreaM2 > 0
            ? initialAreaM2
            : Number(((rW / 1000) * (rH / 1000)).toFixed(2));
          qty = calculateMaterialQuantityFromPack(area, 'lining', packPlanner);
        }
        return {
          uid: `${rType}-${dc.componentId || dc.sku}-${idx}-${Date.now()}`,
          item: {
            id: dc.componentId || dc.sku,
            name: catItem?.name || ref?.componentId || dc.sku,
            category: (ref?.category || 'base') as any,
            widthMm: ref?.dimensionsMm?.width || 600,
            heightMm: ref?.dimensionsMm?.height || 900,
            depthMm: ref?.dimensionsMm?.depth || 600,
            priceNzd: catItem?.priceNzd ?? 0,
            sku: dc.sku,
            imageUrl: catItem?.imageUrl,
          },
          quantity: qty,
        };
      });
    },
    [packPlanner, catalogMap]
  );

  // Placed modular layout
  const [placedItems, setPlacedItems] = useState<RoomPlacedItem[]>(() =>
    getPackDefaultItems(validRoomType)
  );

  // Re-hydrate items when catalogMap loads or props change
  useEffect(() => {
    if (Object.keys(catalogMap).length > 0) {
      setPlacedItems((prev) => {
        if (prev.length === 0) return getPackDefaultItems(roomType);
        return prev.map((p) => {
          const live = catalogMap[p.item.sku];
          if (!live) return p;
          return {
            ...p,
            item: {
              ...p.item,
              name: live.name || p.item.name,
              priceNzd: live.priceNzd ?? p.item.priceNzd,
              imageUrl: live.imageUrl || p.item.imageUrl,
            },
          };
        });
      });
    }
  }, [catalogMap, roomType, getPackDefaultItems]);

  // Sync if initial props change
  useEffect(() => {
    if (initialRoomType && packPlanner?.roomTypes?.some((r) => r.id === initialRoomType)) {
      setRoomType(initialRoomType);
      setPlacedItems(getPackDefaultItems(initialRoomType));
      if (initialWallWidthMm) {
        setWallWidthMm(initialWallWidthMm);
      } else {
        const defW =
          packPlanner.roomTypes.find((r) => r.id === initialRoomType)?.defaultDimensions?.widthMm ?? 1800;
        setWallWidthMm(defW);
      }
    }
  }, [initialRoomType, initialWallWidthMm, packPlanner, getPackDefaultItems]);

  // Current room catalog
  const activeCatalog: CabinetItem[] = useMemo(() => {
    if (!packPlanner) return [];
    return (packPlanner.componentReferences || [])
      .filter((ref) => ref.compatibleRoomTypes.includes(roomType))
      .map((ref) => {
        const catItem = catalogMap[ref.sku];
        return {
          id: ref.componentId,
          name: catItem?.name || ref.componentId || ref.sku,
          category: ref.category as any,
          widthMm: ref.dimensionsMm.width,
          heightMm: ref.dimensionsMm.height,
          depthMm: ref.dimensionsMm.depth,
          priceNzd: catItem?.priceNzd ?? 0,
          sku: ref.sku,
          description: catItem?.name || ref.componentId || '',
          imageUrl: catItem?.imageUrl || '',
          roomTypes: ref.compatibleRoomTypes as any,
        };
      });
  }, [packPlanner, roomType, catalogMap]);

  // Layout isolation validation
  const layoutErrors = useMemo(
    () => validateRoomLayout(placedItems, roomType as any, packPlanner),
    [placedItems, roomType, packPlanner]
  );

  // Calculations
  const baseItems = placedItems.filter(
    (p) =>
      p.item.category === 'base' ||
      p.item.category === 'tall' ||
      p.item.category === 'appliance' ||
      p.item.category === 'tub'
  );

  const totalBaseWidthMm = baseItems.reduce((sum, p) => sum + p.item.widthMm, 0);
  const widthRemainingMm = wallWidthMm - totalBaseWidthMm;
  const isWidthExceeded = widthRemainingMm < 0;

  const hasPlumbingItem = placedItems.some(
    (p) => p.item.category === 'tub' || (roomType === 'bathroom' && p.item.category === 'base')
  );

  // Suggested accessories dynamically filtered by pack classifications
  const suggestedAccessories = useMemo(() => {
    if (!packPlanner) return [];
    const classifications = packPlanner.compatibilityClassifications || [];
    const list: AccessoryItem[] = [];

    for (const c of classifications) {
      if (c.forbiddenRoomTypes.includes(roomType)) continue;
      if (!c.compatibleRoomTypes.includes(roomType)) continue;
      if (c.systemType === 'exterior_barrier') continue;

      for (const sku of c.skuPatternsOrIds) {
        if (!sku || sku.includes('*')) continue;
        const cat = catalogMap[sku];
        const acc: AccessoryItem = {
          id: `acc-${sku}`,
          name: cat?.name || `Sanitary / System Consumable (${sku})`,
          sku,
          priceNzd: cat?.priceNzd ?? 0,
          reason: c.classificationId.replace(/_/g, ' '),
          category: 'all',
          systemType: c.systemType as any,
          compatibleRooms: c.compatibleRoomTypes as any,
        };

        const safety = validateAccessorySafety(acc, roomType as any, packPlanner);
        if (safety.safe) {
          list.push(acc);
        }
      }
    }
    return list;
  }, [packPlanner, roomType, catalogMap]);

  const [selectedAccessoryIds, setSelectedAccessoryIds] = useState<Set<string>>(new Set());
  const accessoryIdsKey = suggestedAccessories.map((a) => a.id).join(',');
  const knownAccessoryIdsRef = useRef<string>('');
  if (knownAccessoryIdsRef.current !== accessoryIdsKey) {
    knownAccessoryIdsRef.current = accessoryIdsKey;
    setSelectedAccessoryIds(new Set(suggestedAccessories.map((a) => a.id)));
  }

  const toggleAccessory = (id: string) => {
    setSelectedAccessoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const accessoriesTotalNzd = useMemo(
    () =>
      suggestedAccessories
        .filter((a) => selectedAccessoryIds.has(a.id))
        .reduce((sum, a) => sum + (catalogMap[a.sku]?.priceNzd ?? a.priceNzd), 0),
    [suggestedAccessories, selectedAccessoryIds, catalogMap]
  );

  // Subtotal incorporates actual quantities & dynamic prices
  const subtotalNzd = useMemo(() => {
    const cabinetTotal = placedItems.reduce((sum, p) => {
      const unitPrice = catalogMap[p.item.sku]?.priceNzd ?? p.item.priceNzd;
      return sum + unitPrice * (p.quantity && p.quantity > 0 ? p.quantity : 1);
    }, 0);
    const benchtopTotal =
      roomType !== 'bathroom' &&
      baseItems.some((p) => p.item.id !== 'laundry-kit-600' && p.item.category === 'base')
        ? selectedBenchtop.priceNzd || 0
        : 0;
    return cabinetTotal + benchtopTotal + accessoriesTotalNzd;
  }, [placedItems, selectedBenchtop, baseItems, accessoriesTotalNzd, roomType, catalogMap]);

  const gstNzd = subtotalNzd * 0.15;
  const totalNzd = subtotalNzd + gstNzd;

  const effectiveAreaM2 = useMemo(() => {
    if (typeof initialAreaM2 === 'number' && initialAreaM2 > 0) return initialAreaM2;
    const rDef = packPlanner?.roomTypes?.find((r) => r.id === roomType);
    const heightMm = rDef?.defaultDimensions?.heightMm || 2400;
    return Number(((wallWidthMm / 1000) * (heightMm / 1000)).toFixed(2));
  }, [initialAreaM2, packPlanner, roomType, wallWidthMm]);

  // Add Item
  const addItem = (item: CabinetItem) => {
    const initialQty =
      item.category === 'lining'
        ? calculateMaterialQuantityFromPack(effectiveAreaM2, 'lining', packPlanner!)
        : 1;
    setPlacedItems((prev) => [
      ...prev,
      { uid: `${item.id}-${Date.now()}`, item, quantity: initialQty },
    ]);
    setQuoteError(null);
  };

  // Remove Item
  const removeItem = (uid: string) => {
    setPlacedItems((prev) => prev.filter((p) => p.uid !== uid));
    setQuoteError(null);
  };

  // Adjust item quantity
  const updateItemQuantity = (uid: string, delta: number) => {
    setPlacedItems((prev) =>
      prev.map((p) => {
        if (p.uid !== uid) return p;
        const currentQty = p.quantity && p.quantity > 0 ? p.quantity : 1;
        const nextQty = Math.max(1, currentQty + delta);
        return { ...p, quantity: nextQty };
      })
    );
  };

  // Switch Room Type cleanly
  const handleSelectRoomType = (newRoom: string) => {
    setRoomType(newRoom);
    const rDef = packPlanner?.roomTypes?.find((r) => r.id === newRoom);
    if (rDef?.defaultDimensions?.widthMm) {
      setWallWidthMm(rDef.defaultDimensions.widthMm);
    }
    setPlacedItems(getPackDefaultItems(newRoom));
    setQuoteError(null);
  };

  // Export to Server-Authoritative Quote Engine
  const handleExportQuote = async () => {
    if (layoutErrors.length > 0) {
      setQuoteError(layoutErrors[0]);
      return;
    }

    setIsQuoting(true);
    setQuoteError(null);

    const quoteItems: Array<{ sku: string; quantity: number; reason: string; required: boolean }> = [];

    // Placed room items
    placedItems
      .filter((p) => p.item.sku)
      .forEach((p) => {
        quoteItems.push({
          sku: p.item.sku,
          quantity: p.quantity && p.quantity > 0 ? p.quantity : 1,
          reason: `${p.item.name} (${selectedFinish.name})`,
          required: true,
        });
      });

    // Custom benchtop if modular base is used in non-bathroom room
    if (selectedBenchtop && baseItems.length > 1 && roomType !== 'bathroom') {
      quoteItems.push({
        sku: 'BENCH-CUST',
        quantity: 1,
        reason: `${selectedBenchtop.name} - Cut to ${totalBaseWidthMm}mm`,
        required: true,
      });
    }

    // Selected accessories
    suggestedAccessories
      .filter((a) => selectedAccessoryIds.has(a.id))
      .forEach((a) => {
        quoteItems.push({
          sku: a.sku,
          quantity: 1,
          reason: a.reason,
          required: false,
        });
      });

    const tenantId = (cfg.projectId || 'placemakers').toLowerCase();

    try {
      const res = await fetch(`/api/kit/quote?project=${encodeURIComponent(tenantId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': tenantId,
        },
        body: JSON.stringify({
          sessionId: typeof window !== 'undefined' ? (window as any).__journeySessionId : undefined,
          title: `${roomType.charAt(0).toUpperCase() + roomType.slice(1)} Space Plan (${(wallWidthMm / 1000).toFixed(1)}m Wall)`,
          items: quoteItems,
          roomType,
          plannerContext: {
            roomType,
            wallWidthMm,
            areaM2: effectiveAreaM2,
          },
        }),
      });

      const data = await res.json();
      if (data?.quote) {
        dispatch({ type: 'SET_SERVER_QUOTE', quote: data.quote });
        dispatch({ type: 'SET_PHASE', phase: 'quote' });
      } else {
        setQuoteError(data?.error || 'Server-authoritative quote generation failed.');
      }
    } catch (err: any) {
      setQuoteError(err?.message || 'Failed to connect to quote service.');
    } finally {
      setIsQuoting(false);
    }
  };

  // ── 3. FAIL CLOSED RENDER WHEN PACK EXTENSION IS UNAVAILABLE ─────────
  if (!isConfigured || !packPlanner) {
    return (
      <div
        data-testid="space-planner-unavailable"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '2.5rem 1.5rem',
          textAlign: 'center',
          background: '#f8fafc',
        }}
      >
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📐</div>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#0f172a', margin: '0 0 0.5rem' }}>
          Space Planner Unavailable
        </h3>
        <p style={{ fontSize: '0.875rem', color: '#64748b', maxWidth: '440px', lineHeight: 1.5, margin: 0 }}>
          {labels.unsupportedWarning ||
            'The active business pack for this storefront does not define an active space planner extension. The planner has failed closed to protect catalogue integrity and compliance.'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#f8fafc' }}>
      {/* Header Banner */}
      <div
        style={{
          background: primaryColor,
          color: '#ffffff',
          padding: '1rem 1.25rem',
          borderBottom: `3px solid ${accentColor}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 800,
                letterSpacing: '0.08em',
                color: '#FFB81C',
                textTransform: 'uppercase',
              }}
            >
              {labels.title || `${cfg.companyName || 'Trade'} 3D Space Planner`}
            </div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0.2rem 0 0', color: '#ffffff' }}>
              {labels.subtitlePrefix || 'Design Your'}{' '}
              {roomType.charAt(0).toUpperCase() + roomType.slice(1)} Space
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
                color: viewMode === '3d' ? primaryColor : '#ffffff',
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
                color: viewMode === '2d' ? primaryColor : '#ffffff',
                cursor: 'pointer',
              }}
            >
              📐 Architectural CAD
            </button>
          </div>
        </div>

        {/* Room Presets & Dimension Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.8 }}>
            {labels.roomType || 'Room Type'}:
          </span>
          {packPlanner.roomTypes.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => handleSelectRoomType(r.id)}
              style={{
                padding: '0.25rem 0.6rem',
                fontSize: '0.75rem',
                fontWeight: 700,
                borderRadius: '0.375rem',
                border: roomType === r.id ? '1px solid #00AEC7' : '1px solid rgba(255,255,255,0.2)',
                background: roomType === r.id ? '#00AEC7' : 'rgba(255,255,255,0.08)',
                color: roomType === r.id ? primaryColor : '#ffffff',
                cursor: 'pointer',
              }}
            >
              {r.label || r.id.charAt(0).toUpperCase() + r.id.slice(1)}
            </button>
          ))}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.8 }}>
              {labels.wallWidth || 'Wall Width'}:
            </span>
            <input
              type="range"
              min={packPlanner.layoutRules?.wallWidthConstraints?.minMm || 1200}
              max={packPlanner.layoutRules?.wallWidthConstraints?.maxMm || 4800}
              step={packPlanner.layoutRules?.wallWidthConstraints?.stepMm || 100}
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

      {/* Discovery Survey Card */}
      {showSurvey && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fef3c7', padding: '0.875rem 1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.8rem', color: '#92400e', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>📋</span> {labels.surveyTitle || `${cfg.companyName || 'Store'} Room Setup & Installation Guidance`}
            </strong>
            <button
              type="button"
              onClick={() => setShowSurvey(false)}
              style={{
                background: 'none',
                border: 'none',
                color: '#92400e',
                fontSize: '11px',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
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
                  Certified Trade
                </button>
              </div>
            </div>

            <div>
              <span style={{ color: '#78350f', fontWeight: 700 }}>3. Finish &amp; Materials:</span>
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                {finishes.map((f) => (
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
        {/* Isolation Violation Banner */}
        {layoutErrors.length > 0 && (
          <div
            style={{
              background: '#fef2f2',
              border: '2px solid #ef4444',
              borderRadius: '0.75rem',
              padding: '0.875rem 1rem',
              marginBottom: '1rem',
              color: '#991b1b',
            }}
          >
            <strong style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🚫</span> Room Isolation Violation
            </strong>
            {layoutErrors.map((err, idx) => (
              <div key={idx} style={{ fontSize: '0.8rem', marginTop: '0.35rem' }}>
                {err}
              </div>
            ))}
          </div>
        )}

        {/* Server Quote Error Banner */}
        {quoteError && (
          <div
            style={{
              background: '#fff1f2',
              border: '1px solid #f43f5e',
              borderRadius: '0.75rem',
              padding: '0.75rem 1rem',
              marginBottom: '1rem',
              color: '#9f1239',
              fontSize: '0.8rem',
            }}
          >
            <strong>Quote Notice:</strong> {quoteError}
          </div>
        )}

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
              benchtopPrice={selectedBenchtop.priceNzd || 0}
              handleStyle={selectedHandle.name}
              onRemoveItem={removeItem}
            />
          ) : (
            /* 2D Architectural CAD Blueprint View */
            <div
              style={{
                padding: '1.25rem',
                background: '#0f172a',
                borderRadius: '0.75rem',
                color: '#38bdf8',
                fontFamily: 'monospace',
              }}
            >
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                📐 ARCHITECTURAL BLUEPRINT ELEVATION · CODE VERIFIED
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
                    {p.quantity && p.quantity > 1 && (
                      <div style={{ fontSize: '0.65rem', color: '#FFB81C', fontWeight: 800 }}>Qty: {p.quantity}</div>
                    )}
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
              {placedItems.length} Unit/Lining Entry(s) Configured
            </div>
          </div>
        </div>

        {/* Configured Units & Quantities */}
        <div style={{ marginTop: '1.25rem', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '0.75rem', padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 800, color: primaryColor, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Configured Room Units &amp; Wall Linings ({roomType.toUpperCase()})
            </span>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              Quantities feed directly into server quote engine
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {placedItems.map((p) => {
              const qty = p.quantity && p.quantity > 0 ? p.quantity : 1;
              const isLining = p.item.category === 'lining';
              const unitPrice = catalogMap[p.item.sku]?.priceNzd ?? p.item.priceNzd;
              return (
                <div
                  key={p.uid}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.5rem',
                    background: isLining ? '#f0fdf4' : '#f8fafc',
                    border: isLining ? '1px solid #bbf7d0' : '1px solid #e2e8f0',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                    <span style={{ fontSize: '1.1rem' }}>
                      {CABINET_CATEGORY_THEME[p.item.category]?.icon || '📦'}
                    </span>
                    <div>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0f172a' }}>
                        {p.item.name}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                        SKU: {p.item.sku} · {p.item.widthMm}mm Width
                        {isLining && ` · ${qty} panel(s) covers ~${(qty * 2.88).toFixed(2)} m²`}
                      </div>
                    </div>
                  </div>

                  {/* Quantity Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '4px' }}>
                      <button
                        type="button"
                        onClick={() => updateItemQuantity(p.uid, -1)}
                        style={{ padding: '2px 8px', border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700 }}
                      >
                        -
                      </button>
                      <span style={{ fontSize: '0.8rem', fontWeight: 800, padding: '0 6px', color: primaryColor }}>
                        {qty}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateItemQuantity(p.uid, 1)}
                        style={{ padding: '2px 8px', border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700 }}
                      >
                        +
                      </button>
                    </div>

                    <span style={{ fontSize: '0.85rem', fontWeight: 800, color: primaryColor, minWidth: '75px', textAlign: 'right' }}>
                      {unitPrice > 0 ? `$${(unitPrice * qty).toFixed(2)}` : 'Included'}
                    </span>

                    <button
                      type="button"
                      onClick={() => removeItem(p.uid)}
                      title="Remove from layout"
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.9rem', padding: '2px 4px' }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Room-Scoped Component Library Picker */}
        <div style={{ marginTop: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 800, color: primaryColor, marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            + Add Pack Components for {roomType.toUpperCase()}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.875rem' }}>
            {activeCatalog.map((item) => {
              const livePrice = catalogMap[item.sku]?.priceNzd ?? item.priceNzd;
              return (
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
                    <span style={{ fontSize: '0.85rem', fontWeight: 800, color: primaryColor }}>
                      {livePrice > 0 ? `$${livePrice.toFixed(2)}` : 'Included'}
                    </span>
                    <button
                      type="button"
                      onClick={() => addItem(item)}
                      style={{
                        padding: '0.35rem 0.65rem',
                        background: primaryColor,
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
              );
            })}
          </div>
        </div>

        {/* Finishes & Customization */}
        <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
          {/* Cabinet Door Finish */}
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
              Cabinet Door &amp; Drawer Finish
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {finishes.map((f) => (
                <div
                  key={f.id}
                  onClick={() => setSelectedFinish(f)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.625rem',
                    padding: '0.5rem',
                    borderRadius: '0.375rem',
                    border: selectedFinish.id === f.id ? `2px solid ${primaryColor}` : '1px solid #e2e8f0',
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

          {/* Benchtop Surface (for modular base layouts) */}
          {roomType !== 'bathroom' && (
            <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
                Benchtop Surface Material
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {benchtops.map((b) => (
                  <div
                    key={b.id}
                    onClick={() => setSelectedBenchtop(b)}
                    style={{
                      padding: '0.5rem',
                      borderRadius: '0.375rem',
                      border: selectedBenchtop.id === b.id ? `2px solid ${primaryColor}` : '1px solid #e2e8f0',
                      background: selectedBenchtop.id === b.id ? '#f0f9ff' : '#ffffff',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0f172a' }}>{b.name}</div>
                    <div style={{ fontSize: '0.75rem', color: primaryColor, fontWeight: 800, marginTop: '0.125rem' }}>
                      +${b.priceNzd} NZD
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Handles & Hardware */}
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase', marginBottom: '0.625rem' }}>
              Handles &amp; Hardware Style
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {handles.map((h) => (
                <div
                  key={h.id}
                  onClick={() => setSelectedHandle(h)}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '0.375rem',
                    border: selectedHandle.id === h.id ? `2px solid ${primaryColor}` : '1px solid #e2e8f0',
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

        {/* Recommended Fixings & Accessories */}
        {suggestedAccessories.length > 0 && (
          <div style={{ background: '#ffffff', padding: '1rem', borderRadius: '0.75rem', border: '1px solid #e2e8f0', marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', textTransform: 'uppercase' }}>
                System-Compatible Consumables &amp; Accessories ({roomType.toUpperCase()})
              </div>
              <span style={{ fontSize: '0.7rem', color: '#059669', fontWeight: 700 }}>
                ✓ Code Verified Wet Area System
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {suggestedAccessories.map((a) => {
                const checked = selectedAccessoryIds.has(a.id);
                const price = catalogMap[a.sku]?.priceNzd ?? a.priceNzd;
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
                        <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#00728A', whiteSpace: 'nowrap' }}>
                          ${price.toFixed(2)}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '0.1rem' }}>
                        SKU: {a.sku} · {a.reason}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Plumbing Escalation Notice */}
        {hasPlumbingItem && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '0.75rem', padding: '0.875rem 1rem', marginTop: '1rem', display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
            <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>⚠️</span>
            <div style={{ fontSize: '0.78rem', color: '#78350f', lineHeight: 1.5 }}>
              <strong>Licensed plumber required under NZ law.</strong>{' '}
              {labels.safetyWarning ||
                'This layout includes water supply and waste connections (vanity/basin/tub) — this work must be performed by an NZ licensed plumber under NZBC G13/AS1.'}
            </div>
          </div>
        )}
      </div>

      {/* Footer Quote Total Bar */}
      <div style={{ background: '#ffffff', padding: '1rem 1.25rem', borderTop: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
            {labels.subtotalLabel || 'Estimated Subtotal (Includes 15% NZ GST)'}
          </div>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: primaryColor }}>${totalNzd.toFixed(2)} NZD</div>
          <div style={{ fontSize: '0.7rem', color: '#059669', fontWeight: 600 }}>
            Server-Authoritative Quote Engine (P0-04)
          </div>
        </div>

        <button
          type="button"
          disabled={isQuoting || layoutErrors.length > 0}
          onClick={handleExportQuote}
          style={{
            padding: '0.75rem 1.5rem',
            background: layoutErrors.length > 0 ? '#94a3b8' : primaryColor,
            color: '#ffffff',
            border: 'none',
            borderRadius: '0.5rem',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: layoutErrors.length > 0 ? 'not-allowed' : 'pointer',
            boxShadow: '0 4px 6px rgba(0,0,0,0.15)',
            opacity: isQuoting ? 0.7 : 1,
          }}
        >
          {isQuoting ? 'Building Server Quote...' : labels.exportQuoteButton || labels.quoteButton || 'Apply Layout & Build Server Quote →'}
        </button>
      </div>
    </div>
  );
}
