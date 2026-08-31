'use client';

import React, { useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

export default function ProjectPlanPanel() {
  const { state, dispatch } = useJourney();
  const cfg = useStorefrontConfig();
  const plan = state.projectPlan;
  const materials = Array.isArray(plan?.materials) ? plan.materials : [];
  const toolsNeeded = Array.isArray(plan?.toolsNeeded) ? plan.toolsNeeded : [];
  const nzBuildingNotes = Array.isArray(plan?.nzBuildingNotes) ? plan.nzBuildingNotes : [];

  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [selectedBranch, setSelectedBranch] = useState(plan?.branchAvailability?.recommendedBranch || 'PlaceMakers Mt Wellington (Auckland)');
  const [addedToCart, setAddedToCart] = useState(false);

  if (!plan || materials.length === 0) {
    return (
      <div className="p-8 text-center text-slate-500">
        <p>No project plan active. Ask the assistant to plan your project (e.g. &ldquo;Plan a 4m x 3m deck&rdquo;).</p>
      </div>
    );
  }

  const handleQtyChange = (idx: number, delta: number) => {
    const current = quantities[idx] !== undefined ? quantities[idx] : (materials[idx]?.quantity || 1);
    const next = Math.max(1, current + delta);
    setQuantities((prev) => ({ ...prev, [idx]: next }));
  };

  const calculatedTotal = materials.reduce((acc, m, idx) => {
    const qty = quantities[idx] !== undefined ? quantities[idx] : (m.quantity || 1);
    return acc + (m.estimatedUnitPriceNzd || 0) * qty;
  }, 0);

  const handleCreateOrder = () => {
    setAddedToCart(true);
    // Convert materials to authoritative quote lines
    const lines = materials.map((m, idx) => {
      const qty = quantities[idx] !== undefined ? quantities[idx] : (m.quantity || 1);
      const unitPrice = m.estimatedUnitPriceNzd || 0;
      return {
        sku: m.sku || `PM-${idx + 101}`,
        name: m.name,
        quantity: qty,
        unitPrice,
        lineTotal: parseFloat((qty * unitPrice).toFixed(2)),
        sourceOfPrice: 'catalogue' as const,
        inStock: true,
        category: m.category,
        reason: m.description,
      };
    });

    const subtotal = calculatedTotal;
    const discount = 0;
    const gst = subtotal * 0.15; // 15% NZ GST
    const total = subtotal + gst;

    dispatch({
      type: 'SET_SERVER_QUOTE',
      quote: {
        quoteId: `PM-PLAN-${Date.now().toString(36).toUpperCase()}`,
        title: plan.projectName || 'PlaceMakers Materials Plan',
        currency: 'NZD',
        symbol: '$',
        lines,
        subtotal: parseFloat(subtotal.toFixed(2)),
        discountRate: 0,
        discount: 0,
        taxRate: 0.15,
        tax: parseFloat(gst.toFixed(2)),
        total: parseFloat(total.toFixed(2)),
        status: 'draft',
        validation: { ok: true, errors: [], warnings: [] },
        leadTimeSummary: 'Materials available for same-day Click & Collect at PlaceMakers branch.',
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    });

    dispatch({
      type: 'ADD_MESSAGE',
      role: 'note',
      text: `Added ${materials.length} project materials to your PlaceMakers order summary for ${selectedBranch}.`,
      head: 'Materials Plan Confirmed',
    });
  };

  return (
    <div className="project-plan-panel flex flex-col h-full bg-slate-50 overflow-y-auto p-6 space-y-6">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-indigo-900 text-white rounded-2xl p-6 shadow-lg border border-blue-700/50">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-amber-400 text-blue-950 uppercase tracking-wider">
            PlaceMakers Project Plan
          </span>
          <span className="text-xs text-blue-200 font-mono">NZS 3604 Standard</span>
        </div>
        <h2 className="text-2xl font-bold mt-2 text-white">{plan.projectName || 'Materials Plan'}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-blue-100">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-white">📐 Dimensions:</span> {plan.dimensions}
          </div>
          {plan.areaM2 && (
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-white">📏 Area:</span> {plan.areaM2} m²
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-white">📦 Items:</span> {materials.length} components
          </div>
        </div>
      </div>

      {/* Materials Table Card */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Authoritative Bill of Materials</h3>
            <p className="text-xs text-slate-500">Calculated with 10% cutting waste allowance and structural spacing.</p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500 uppercase font-semibold">Estimated Total (excl. GST)</div>
            <div className="text-xl font-bold text-blue-900">${calculatedTotal.toFixed(2)} NZD</div>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {materials.map((m, idx) => {
            const qty = quantities[idx] !== undefined ? quantities[idx] : (m.quantity || 1);
            const lineTotal = (m.estimatedUnitPriceNzd || 0) * qty;

            return (
              <div key={`${m.name}-${idx}`} className="py-3.5 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700">
                      {m.category}
                    </span>
                    <span className="text-xs text-emerald-600 font-medium">✓ In Stock</span>
                  </div>
                  <h4 className="text-sm font-semibold text-slate-900 mt-1">{m.name}</h4>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{m.description}</p>
                </div>

                <div className="flex items-center gap-3 self-center">
                  <div className="flex items-center border border-slate-200 rounded-lg bg-slate-50">
                    <button
                      type="button"
                      onClick={() => handleQtyChange(idx, -1)}
                      className="px-2.5 py-1 text-slate-600 hover:text-slate-900 font-bold"
                    >
                      -
                    </button>
                    <span className="px-2 text-xs font-semibold text-slate-900 min-w-[2rem] text-center">
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleQtyChange(idx, 1)}
                      className="px-2.5 py-1 text-slate-600 hover:text-slate-900 font-bold"
                    >
                      +
                    </button>
                  </div>
                  <div className="text-right min-w-[4.5rem]">
                    <div className="text-xs text-slate-400">{m.unit}</div>
                    <div className="text-sm font-bold text-slate-900">${lineTotal.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Building Code & NZ Compliance Guidelines */}
      {nzBuildingNotes.length > 0 && (
        <div className="bg-amber-50/80 border border-amber-200/80 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-amber-700 text-base">📋</span>
            <h4 className="text-sm font-bold text-amber-900">NZ Building Code &amp; Safety Compliance</h4>
          </div>
          <ul className="space-y-1.5 text-xs text-amber-800 list-disc list-inside">
            {nzBuildingNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Tools & Hardware Needed */}
      {toolsNeeded.length > 0 && (
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200">
          <h4 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
            <span>🛠️</span> Recommended Tools &amp; Equipment
          </h4>
          <div className="flex flex-wrap gap-2">
            {toolsNeeded.map((tool, i) => (
              <span
                key={i}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200/60"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Branch Stock & Fulfillment Selector */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <span>📍</span> PlaceMakers Branch Fulfillment
          </h4>
          <span className="text-xs text-emerald-600 font-semibold">Ready in 60 Mins</span>
        </div>
        <label className="block text-xs text-slate-500 mb-1.5">Select your pickup branch:</label>
        <select
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium text-slate-800 focus:ring-2 focus:ring-blue-600 focus:outline-none"
        >
          <option value="PlaceMakers Mt Wellington (Auckland)">PlaceMakers Mount Wellington (106 Carbine Rd)</option>
          <option value="PlaceMakers Cook Street (Auckland Central)">PlaceMakers Cook Street (124 Cook St)</option>
          <option value="PlaceMakers Albany (North Shore)">PlaceMakers Albany (21 Corinthian Dr)</option>
          <option value="PlaceMakers Te Rapa (Hamilton)">PlaceMakers Te Rapa (Maui St)</option>
          <option value="PlaceMakers Petone (Wellington)">PlaceMakers Petone (43 Bouverie St)</option>
          <option value="PlaceMakers Riccarton (Christchurch)">PlaceMakers Riccarton (Mandeville St)</option>
        </select>
        <p className="text-xs text-slate-500 mt-2">
          🚚 Free branch collection or schedule a Hiab crane truck delivery directly to your job site.
        </p>
      </div>

      {/* Checkout / Order Action Bar */}
      <div className="pt-2 sticky bottom-0 bg-slate-50/95 backdrop-blur pb-2">
        <button
          type="button"
          onClick={handleCreateOrder}
          className="w-full py-3.5 px-6 rounded-xl font-bold text-sm bg-gradient-to-r from-blue-900 to-indigo-900 text-white shadow-lg hover:from-blue-800 hover:to-indigo-800 transition-all flex items-center justify-center gap-2"
        >
          <span>🛒</span>
          {addedToCart ? 'Order Summary Updated · View Quote' : `Add All to Order · $${calculatedTotal.toFixed(2)} NZD`}
        </button>
      </div>
    </div>
  );
}
