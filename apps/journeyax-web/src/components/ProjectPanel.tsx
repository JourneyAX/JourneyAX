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
import CardStage from './cards/CardStage';
import { LEGACY_CARD_PHASES } from '@/lib/types';

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

  // Card CMS (v3): once the agent's output has been mirrored into a card
  // (see JourneyContext's card-sync effects) it renders through CardStage —
  // a tenant's json-render template, not this file's hardcoded panels — for
  // every phase that isn't still a bespoke React experience (3D configurator,
  // team design, space planner, …; see LEGACY_CARD_PHASES). This is additive:
  // the panels below stay as the fallback for those phases and for the one
  // render before the first card-sync effect fires.
  const useCardStage = state.cards.length > 0 && !LEGACY_CARD_PHASES.includes(state.phase);

  return (
    <div className="project-panel">
      {useCardStage && <CardStage />}
      {!useCardStage && state.phase === 'intro' && <HeroPanel />}
      {!useCardStage && state.phase === 'research' && <ResearchPanel />}
      {!useCardStage && state.phase === 'clarify' && <ClarifyPanel />}
      {!useCardStage && state.phase === 'validating' && <ValidatingPanel />}
      {!useCardStage && state.phase === 'products' && <ProductsPanel />}
      {!useCardStage && state.phase === 'accessories' && <AccessoriesPanel />}
      {!useCardStage && state.phase === 'choice' && <ChoicePanel />}
      {!useCardStage && state.phase === 'install' && <InstallGuidePanel />}
      {!useCardStage && state.phase === 'warranty' && <WarrantyPanel />}
      {!useCardStage && state.phase === 'guide' && <GuidePanel />}
      {!useCardStage && state.phase === 'quote' && (isCart ? <RetailCartPanel /> : <QuotePanel />)}
      {!useCardStage && state.phase === 'ordered' && <OrderedPanel />}
      {state.phase === 'concepts' && <ConceptsPanel />}
      {state.phase === 'configurator' && (isCandy ? <CandyDesignPanel /> : <ConfiguratorPanel />)}
      {state.phase === 'designEditor' && <DesignEditorPanel />}
      {state.phase === 'teamDesign' && <TeamDesignPanel />}
      {state.phase === 'teamRoster' && <TeamRosterPanel />}
      {state.phase === 'teamPreview' && <ConfiguratorPanel />}
      {!useCardStage && state.phase === 'sizeRecommendation' && <SizeRecommendationPanel />}
      {state.phase === 'photoUploadDesign' && <PhotoUploadDesignPanel />}
      {!useCardStage && state.phase === 'projectPlan' && <ProjectPlanPanel />}
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
