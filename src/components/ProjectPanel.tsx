'use client';

import { useJourney } from '@/context/JourneyContext';
import HeroPanel from './panels/HeroPanel';
import ClarifyPanel from './panels/ClarifyPanel';
import ValidatingPanel from './panels/ValidatingPanel';
import ProductsPanel from './panels/ProductsPanel';
import QuotePanel from './panels/QuotePanel';
import OrderedPanel from './panels/OrderedPanel';
import GuidePanel from './panels/GuidePanel';
import FitAdvisorPanel from './panels/FitAdvisorPanel';
import TryOnPanel from './panels/TryOnPanel';
import BagPanel from './panels/BagPanel';
import ReturnsPanel from './panels/ReturnsPanel';

export default function ProjectPanel() {
  const { state } = useJourney();

  return (
    <div className="project-panel">
      {state.phase === 'intro' && <HeroPanel />}
      {state.phase === 'clarify' && <ClarifyPanel />}
      {state.phase === 'validating' && <ValidatingPanel />}
      {state.phase === 'products' && <ProductsPanel />}
      {state.phase === 'fit' && <FitAdvisorPanel />}
      {state.phase === 'tryon' && <TryOnPanel />}
      {state.phase === 'bag' && <BagPanel />}
      {state.phase === 'returns' && <ReturnsPanel />}
      {state.phase === 'guide' && <GuidePanel />}
      {state.phase === 'quote' && <QuotePanel />}
      {state.phase === 'ordered' && <OrderedPanel />}
    </div>
  );
}
