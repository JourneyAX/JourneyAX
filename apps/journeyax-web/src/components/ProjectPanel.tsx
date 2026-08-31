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

  return (
    <div className="project-panel">
      {state.phase === 'intro' && <HeroPanel />}
      {state.phase === 'research' && <ResearchPanel />}
      {state.phase === 'clarify' && <ClarifyPanel />}
      {state.phase === 'validating' && <ValidatingPanel />}
      {state.phase === 'products' && <ProductsPanel />}
      {state.phase === 'accessories' && <AccessoriesPanel />}
      {state.phase === 'choice' && <ChoicePanel />}
      {state.phase === 'install' && <InstallGuidePanel />}
      {state.phase === 'warranty' && <WarrantyPanel />}
      {state.phase === 'guide' && <GuidePanel />}
      {state.phase === 'quote' && (isCart ? <RetailCartPanel /> : <QuotePanel />)}
      {state.phase === 'ordered' && <OrderedPanel />}
      {state.phase === 'concepts' && <ConceptsPanel />}
      {state.phase === 'configurator' && (isCandy ? <CandyDesignPanel /> : <ConfiguratorPanel />)}
      {state.phase === 'designEditor' && <DesignEditorPanel />}
      {state.phase === 'teamDesign' && <TeamDesignPanel />}
      {state.phase === 'teamRoster' && <TeamRosterPanel />}
      {state.phase === 'teamPreview' && <ConfiguratorPanel />}
      {state.phase === 'sizeRecommendation' && <SizeRecommendationPanel />}
      {state.phase === 'photoUploadDesign' && <PhotoUploadDesignPanel />}
      {state.phase === 'projectPlan' && <ProjectPlanPanel />}
      {state.phase === 'spacePlanner' && <SpacePlannerPanel />}
    </div>
  );
}
