'use client';

import React, { useState, useMemo } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { BOMLine } from '@/lib/types';

interface CabinetItem {
  id: string;
  name: string;
  category: 'base' | 'overhead' | 'tall' | 'appliance';
  widthMm: number;
  heightMm: number;
  depthMm: number;
  priceNzd: number;
  sku: string;
  description: string;
  icon: string;
  colorHex?: string;
}

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
    icon: '🚰',
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
    icon: '🚪',
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
    icon: '🗄️',
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
    icon: '🧺',
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
    icon: '🪟',
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
    icon: '🪟',
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
    icon: '🏛️',
  },
];

const FINISH_PRESETS = [
  { id: 'white-gloss', name: 'White Gloss', hex: '#FFFFFF', desc: 'Ultra-modern high gloss reflective finish' },
  { id: 'anthracite', name: 'Matte Anthracite', hex: '#262626', desc: 'Contemporary deep architectural charcoal' },
  { id: 'natural-oak', name: 'Natural Warm Oak', hex: '#C2A378', desc: 'Textured natural woodgrain laminate' },
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

export default function SpacePlannerPanel() {
  const { dispatch } = useJourney();
  const cfg = useStorefrontConfig();

  // Space Settings
  const [roomType, setRoomType] = useState<'laundry' | 'kitchen' | 'bathroom' | 'utility'>('laundry');
  const [wallWidthMm, setWallWidthMm] = useState<number>(2000);
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d');

  // Finishes
  const [selectedFinish, setSelectedFinish] = useState(FINISH_PRESETS[0]);
  const [selectedBenchtop, setSelectedBenchtop] = useState(BENCHTOPS[0]);
  const [selectedHandle, setSelectedHandle] = useState(HANDLES[0]);

  // Placed modular layout
  const [placedItems, setPlacedItems] = useState<{ uid: string; item: CabinetItem }[]>([
    { uid: '1', item: CABINET_CATALOG[0] }, // 600mm starter kit
    { uid: '2', item: CABINET_CATALOG[3] }, // 600mm appliance space
    { uid: '3', item: CABINET_CATALOG[1] }, // 450mm base cabinet
    { uid: '4', item: CABINET_CATALOG[4] }, // 600mm overhead
  ]);

  // Calculations
  const baseItems = placedItems.filter((p) => p.item.category === 'base' || p.item.category === 'tall' || p.item.category === 'appliance');
  const overheadItems = placedItems.filter((p) => p.item.category === 'overhead');

  const totalBaseWidthMm = baseItems.reduce((sum, p) => sum + p.item.widthMm, 0);
  const totalOverheadWidthMm = overheadItems.reduce((sum, p) => sum + p.item.widthMm, 0);

  const widthRemainingMm = wallWidthMm - totalBaseWidthMm;
  const isWidthExceeded = widthRemainingMm < 0;

  const subtotalNzd = useMemo(() => {
    const cabinetTotal = placedItems.reduce((sum, p) => sum + p.item.priceNzd, 0);
    const benchtopTotal = baseItems.some((p) => p.item.id !== 'laundry-kit-600' && p.item.category === 'base')
      ? selectedBenchtop.price
      : 0;
    return cabinetTotal + benchtopTotal;
  }, [placedItems, selectedBenchtop, baseItems]);

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
        required: true,
      });
    }

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
        validation: { ok: true, errors: [], warnings: isWidthExceeded ? ['Total cabinet width exceeds specified wall width. Verify measurements with builder.'] : [] },
        status: 'draft',
        expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
        leadTimeDays: 1,
        leadTimeSummary: 'Modular cabinets in stock for 60-Minute Click & Collect at PlaceMakers Mt Wellington & Cook St.',
        installationSummary: 'Pre-assembled modular carcasses include adjustable feet, mounting hardware, and soft-close hinges.',
        warrantySummary: 'PlaceMakers 10-Year Cabinetry Guarantee · Moisture-Resistant HMR Carcass Pass.',
        lines,
      },
    });

    dispatch({ type: 'SET_PHASE', phase: 'quote' });
  };

  return (
    <div className="space-planner-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#f8fafc', color: '#0f172a' }}>
      {/* Top Header */}
      <div style={{ padding: '1.25rem 1.5rem', background: '#002855', color: '#ffffff', borderBottom: '3px solid #FFB81C' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#FFB81C', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              PlaceMakers Space Planner &amp; 3D Visualizer
            </div>
            <h2 style={{ fontSize: '1.35rem', fontWeight: 800, margin: '0.25rem 0 0', letterSpacing: '-0.02em' }}>
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
              🎲 3D View
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
              📐 2D Elevation
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
                if (r === 'laundry') setWallWidthMm(2000);
                if (r === 'kitchen') setWallWidthMm(3000);
                if (r === 'bathroom') setWallWidthMm(1800);
                if (r === 'utility') setWallWidthMm(2400);
              }}
              style={{
                padding: '0.25rem 0.6rem',
                fontSize: '0.75rem',
                fontWeight: 700,
                borderRadius: '0.375rem',
                border: roomType === r ? '1px solid #FFB81C' : '1px solid rgba(255,255,255,0.2)',
                background: roomType === r ? '#FFB81C' : 'rgba(255,255,255,0.08)',
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
              style={{ width: '100px', accentColor: '#FFB81C' }}
            />
            <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#FFB81C', minWidth: '55px' }}>
              {(wallWidthMm / 1000).toFixed(2)}m
            </span>
          </div>
        </div>
      </div>

      {/* Main Interactive Canvas Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem' }}>
        {/* Visual 3D / 2D Canvas Container */}
        <div
          style={{
            background: viewMode === '3d' ? 'linear-gradient(180deg, #e2e8f0 0%, #cbd5e1 100%)' : '#ffffff',
            borderRadius: '1rem',
            border: '1px solid #cbd5e1',
            padding: '1.5rem',
            minHeight: '260px',
            position: 'relative',
            boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.06)',
            overflow: 'hidden',
          }}
        >
          {/* Wall Width Indicator */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', borderBottom: '2px dashed #94a3b8', paddingBottom: '0.25rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>◀ Left Wall</span>
            <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#002855', background: '#e2e8f0', padding: '0.15rem 0.5rem', borderRadius: '0.25rem' }}>
              Total Wall Width: {wallWidthMm}mm ({(wallWidthMm / 1000).toFixed(2)}m)
            </span>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>Right Wall ▶</span>
          </div>

          {/* 3D Isometric Elevation Canvas */}
          {viewMode === '3d' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', margin: '1rem 0' }}>
              {/* Overhead Cabinets Row */}
              <div style={{ display: 'flex', gap: '0.5rem', paddingLeft: '1rem', minHeight: '60px' }}>
                {overheadItems.map((p) => (
                  <div
                    key={p.uid}
                    style={{
                      width: `${(p.item.widthMm / wallWidthMm) * 85}%`,
                      minWidth: '70px',
                      height: '70px',
                      background: selectedFinish.hex,
                      border: '2px solid #64748b',
                      borderRadius: '0.375rem',
                      boxShadow: '0 8px 12px rgba(0,0,0,0.15)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                      color: selectedFinish.id === 'white-gloss' ? '#1e293b' : '#ffffff',
                    }}
                  >
                    <span style={{ fontSize: '1rem' }}>{p.item.icon}</span>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, textAlign: 'center', padding: '0 0.25rem' }}>
                      {p.item.widthMm}mm Wall
                    </span>
                    <button
                      type="button"
                      onClick={() => removeItem(p.uid)}
                      style={{
                        position: 'absolute',
                        top: '-6px',
                        right: '-6px',
                        background: '#ef4444',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {/* Base Cabinets & Sink Row */}
              <div style={{ display: 'flex', gap: '0.5rem', paddingLeft: '1rem', alignItems: 'flex-end', minHeight: '120px' }}>
                {baseItems.map((p) => {
                  const isSink = p.item.id === 'laundry-kit-600';
                  const isAppliance = p.item.category === 'appliance';

                  return (
                    <div
                      key={p.uid}
                      style={{
                        width: `${(p.item.widthMm / wallWidthMm) * 85}%`,
                        minWidth: '80px',
                        height: p.item.category === 'tall' ? '140px' : '100px',
                        background: isAppliance ? 'transparent' : selectedFinish.hex,
                        border: isAppliance ? '2px dashed #94a3b8' : '2px solid #334155',
                        borderRadius: '0.375rem',
                        boxShadow: isAppliance ? 'none' : '0 10px 15px rgba(0,0,0,0.18)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative',
                        color: selectedFinish.id === 'white-gloss' || isAppliance ? '#1e293b' : '#ffffff',
                      }}
                    >
                      {/* Integrated Sink Basin Rendering */}
                      {isSink && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '4px',
                            width: '70%',
                            height: '14px',
                            background: '#94a3b8',
                            borderRadius: '3px',
                            border: '1px solid #475569',
                          }}
                        />
                      )}

                      <span style={{ fontSize: '1.25rem', marginTop: isSink ? '12px' : '0' }}>{p.item.icon}</span>
                      <span style={{ fontSize: '0.7rem', fontWeight: 800, textAlign: 'center', padding: '0 0.25rem' }}>
                        {p.item.widthMm}mm
                      </span>
                      <span style={{ fontSize: '0.6rem', opacity: 0.85 }}>${p.item.priceNzd}</span>

                      {/* Handle preview */}
                      {!isAppliance && selectedHandle.id !== 'push-open' && (
                        <div
                          style={{
                            width: '24px',
                            height: '3px',
                            background: selectedHandle.id === 'black-pull' ? '#000000' : '#d97706',
                            borderRadius: '2px',
                            marginTop: '4px',
                          }}
                        />
                      )}

                      <button
                        type="button"
                        onClick={() => removeItem(p.uid)}
                        style={{
                          position: 'absolute',
                          top: '-6px',
                          right: '-6px',
                          background: '#ef4444',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '50%',
                          width: '18px',
                          height: '18px',
                          fontSize: '10px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}

                {/* Remaining Wall Space Indicator */}
                <div
                  style={{
                    flex: 1,
                    height: '90px',
                    border: '1px dashed #cbd5e1',
                    borderRadius: '0.375rem',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.7rem',
                    color: '#64748b',
                    background: 'rgba(255,255,255,0.4)',
                  }}
                >
                  <span>Remaining</span>
                  <strong>{Math.max(0, widthRemainingMm)}mm</strong>
                </div>
              </div>
            </div>
          ) : (
            /* 2D Elevation View */
            <div style={{ padding: '1rem', background: '#f1f5f9', borderRadius: '0.5rem', fontFamily: 'monospace' }}>
              <div style={{ fontSize: '0.75rem', color: '#475569', marginBottom: '0.5rem' }}>
                WALL ELEVATION MATRIX (NZS 4303 STANDARDS)
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                {baseItems.map((p, i) => (
                  <div
                    key={p.uid}
                    style={{
                      flex: p.item.widthMm,
                      background: '#002855',
                      color: '#ffffff',
                      padding: '0.75rem 0.25rem',
                      textAlign: 'center',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                    }}
                  >
                    <div>#{i + 1}</div>
                    <div style={{ fontWeight: 800 }}>{p.item.widthMm}mm</div>
                    <div style={{ fontSize: '0.65rem', color: '#93c5fd' }}>{p.item.sku}</div>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
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
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                    <span style={{ fontSize: '1.25rem' }}>{item.icon}</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#0f172a', lineHeight: '1.2' }}>
                      {item.name}
                    </span>
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
                  <div style={{ fontSize: '0.65rem', color: '#059669', fontWeight: 600, marginTop: '0.125rem' }}>
                    Included with modular pack
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Sticky Bottom Order Bar */}
      <div
        style={{
          background: '#ffffff',
          borderTop: '2px solid #e2e8f0',
          padding: '1rem 1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 -4px 10px rgba(0,0,0,0.05)',
        }}
      >
        <div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>
            PlaceMakers Project Total (Includes 15% NZ GST)
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 900, color: '#002855' }}>
            ${totalNzd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} NZD
          </div>
          <div style={{ fontSize: '0.75rem', color: '#059669', fontWeight: 700 }}>
            ✓ In Stock for 60-Minute Click &amp; Collect at Mt Wellington
          </div>
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
            fontSize: '0.95rem',
            fontWeight: 800,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            boxShadow: '0 4px 6px rgba(0,40,85,0.25)',
          }}
        >
          Apply Layout &amp; Build Quote →
        </button>
      </div>
    </div>
  );
}
