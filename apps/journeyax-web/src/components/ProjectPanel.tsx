'use client';

import { useJourney } from '@/context/JourneyContext';
import HeroPanel from './panels/HeroPanel';
import ClarifyPanel from './panels/ClarifyPanel';
import ValidatingPanel from './panels/ValidatingPanel';
import ProductsPanel from './panels/ProductsPanel';
import QuotePanel from './panels/QuotePanel';
import RetailCartPanel from './panels/RetailCartPanel';
import OrderedPanel from './panels/OrderedPanel';
import GuidePanel from './panels/GuidePanel';
import AccessoriesPanel from './panels/AccessoriesPanel';
import ChoicePanel from './panels/ChoicePanel';
import InstallGuidePanel from './panels/InstallGuidePanel';
import WarrantyPanel from './panels/WarrantyPanel';
import ConceptsPanel from './panels/ConceptsPanel';
import ConfiguratorPanel from './panels/ConfiguratorPanel';
import CandyDesignPanel from './panels/CandyDesignPanel';
import DesignEditorPanel from './panels/DesignEditorPanel';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import ResearchPanel from './panels/ResearchPanel';
import TeamDesignPanel from './panels/TeamDesignPanel';
import TeamRosterPanel from './panels/TeamRosterPanel';
import SizeRecommendationPanel from './panels/SizeRecommendationPanel';
import PhotoUploadDesignPanel from './panels/PhotoUploadDesignPanel';
import ProjectPlanPanel from './panels/ProjectPlanPanel';
import SpacePlannerPanel from './panels/SpacePlannerPanel';
import { LEGACY_CARD_PHASES } from '@/lib/types';

/**
 * The non-card fallback surface (docs/v3-card-cms-architecture.md).
 *
 * Cards now render INLINE in ChatPanel's own conversation thread (see
 * CardStage.tsx's CardTile + ChatPanel's timeline builder) — this component
 * no longer picks between a card stage and a legacy panel. It renders ONLY
 * the phases that are still a bespoke React experience (3D configurator,
 * team design, space planner, …; LEGACY_CARD_PHASES) — ChatPanel mounts it
 * inline, as the thread's current turn, when `state.phase` is one of those —
 * plus the pre-first-card-push fallback for every other phase, for the
 * brief render before a tenant's first card-sync effect fires, or a card
 * type a tenant has disabled in Cards & Theme.
 */
export default function ProjectPanel() {
  const { state } = useJourney();
  const cfg = useStorefrontConfig() as any;
  // The design step is per-project: a garment opens the 3D configurator, a
  // candy opens the 2D candy designer. Driven by configurator.productType so
  // one phase serves every kind of personalised product.
  const isCandy = cfg?.configurator?.productType === 'candy';
  // The closing surface is DECLARED per brand: 'cart' → a B2C retail bag (sizes,
  // checkout); 'quote' → the B2B project quote (BOM, finishes). A retail tenant
  // never inherits the fixtures/quote template. Default 'quote' (Caroma/Augusta).
  const isCart = cfg?.commerceMode === 'cart';
  const useCards = state.cards.length > 0 && !LEGACY_CARD_PHASES.includes(state.phase);

  return (
    <div className="project-panel">
      {!useCards && state.phase === 'intro' && <HeroPanel />}
      {!useCards && state.phase === 'research' && <ResearchPanel />}
      {!useCards && state.phase === 'clarify' && <ClarifyPanel />}
      {!useCards && state.phase === 'validating' && <ValidatingPanel />}
      {!useCards && state.phase === 'products' && <ProductsPanel />}
      {!useCards && state.phase === 'accessories' && <AccessoriesPanel />}
      {!useCards && state.phase === 'choice' && <ChoicePanel />}
      {!useCards && state.phase === 'install' && <InstallGuidePanel />}
      {!useCards && state.phase === 'warranty' && <WarrantyPanel />}
      {!useCards && state.phase === 'guide' && <GuidePanel />}
      {!useCards && state.phase === 'quote' && (isCart ? <RetailCartPanel /> : <QuotePanel />)}
      {!useCards && state.phase === 'ordered' && <OrderedPanel />}
      {state.phase === 'concepts' && <ConceptsPanel />}
      {state.phase === 'configurator' && (isCandy ? <CandyDesignPanel /> : <ConfiguratorPanel />)}
      {state.phase === 'designEditor' && <DesignEditorPanel />}
      {state.phase === 'teamDesign' && <TeamDesignPanel />}
      {state.phase === 'teamRoster' && <TeamRosterPanel />}
      {state.phase === 'teamPreview' && <ConfiguratorPanel />}
      {!useCards && state.phase === 'sizeRecommendation' && <SizeRecommendationPanel />}
      {state.phase === 'photoUploadDesign' && <PhotoUploadDesignPanel />}
      {!useCards && state.phase === 'projectPlan' && <ProjectPlanPanel />}
      {state.phase === 'spacePlanner' && (
        <SpacePlannerPanel
          // Keyed on the params themselves: a later openSpacePlanner call (the
          // customer refining "actually make it dark charcoal, trade install")
          // must re-initialize the panel's state, not silently no-op because
          // React sees the same component instance already mounted from the
          // first call.
          key={JSON.stringify(state.spacePlannerParams || {})}
          initialRoomType={state.spacePlannerParams?.roomType}
          initialWallWidthMm={state.spacePlannerParams?.wallWidthMm}
          initialInstallType={state.spacePlannerParams?.installType}
          initialFinishId={state.spacePlannerParams?.finish}
        />
      )}
    </div>
  );
}
