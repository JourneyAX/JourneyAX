'use client';

import { useJourney } from '@/context/JourneyContext';
import HeroPanel from './panels/HeroPanel';
import ClarifyPanel from './panels/ClarifyPanel';
import ValidatingPanel from './panels/ValidatingPanel';
import ProductsPanel from './panels/ProductsPanel';
import QuotePanel from './panels/QuotePanel';
import OrderedPanel from './panels/OrderedPanel';
import GuidePanel from './panels/GuidePanel';
import AccessoriesPanel from './panels/AccessoriesPanel';
import ChoicePanel from './panels/ChoicePanel';
import InstallGuidePanel from './panels/InstallGuidePanel';
import WarrantyPanel from './panels/WarrantyPanel';
import ConceptsPanel from './panels/ConceptsPanel';
import ConfiguratorPanel from './panels/ConfiguratorPanel';
import CandyDesignPanel from './panels/CandyDesignPanel';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import ResearchPanel from './panels/ResearchPanel';

export default function ProjectPanel() {
  const { state } = useJourney();
  const cfg = useStorefrontConfig() as any;
  // The design step is per-project: a garment opens the 3D configurator, a
  // candy opens the 2D candy designer. Driven by configurator.productType so
  // one phase serves every kind of personalised product.
  const isCandy = cfg?.configurator?.productType === 'candy';

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
      {state.phase === 'quote' && <QuotePanel />}
      {state.phase === 'ordered' && <OrderedPanel />}
      {state.phase === 'concepts' && <ConceptsPanel />}
      {state.phase === 'configurator' && (isCandy ? <CandyDesignPanel /> : <ConfiguratorPanel />)}
    </div>
  );
}
