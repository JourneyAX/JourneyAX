/** Tools that are safe platform primitives and therefore always available. */
export const UNIVERSAL_TOOL_NAMES = new Set([
  'searchKnowledge', 'findRelated', 'getProductOptions', 'findEntity',
  'registerEntity', 'requestArtwork', 'checkArtworkApproval', 'setPhase',
  'buildProjectPlan', 'checkBranchStock', 'openSpacePlanner',
  'presentSuggestions', 'loadSkill',
]);

/** Tools that cause a client-side presentation action. */
export const UI_TOOL_NAMES = new Set([
  'setPhase', 'updateQuote', 'presentBundle', 'researchSchool', 'showItems',
  'showGuide', 'showAddons', 'presentChoice', 'showDocuments', 'showInfo',
  'showConfigurator', 'generateTeamDesign', 'recommendSize',
  'uploadPhotosFor3D', 'buildProjectPlan', 'checkBranchStock',
  'openSpacePlanner', 'presentComparison', 'presentSuggestions',
]);

/** Back Office capability id → model tools made available by that capability. */
export const CAPABILITY_TO_TOOL: Record<string, string | string[]> = {
  products: ['showItems', 'presentComparison', 'presentBundle', 'recommendStorage'],
  customerHistory: ['getMyOrders', 'getMyLatestOrder', 'getMyOrder', 'getCurrentOffer', 'getStaffInventory'],
  steps: 'showGuide',
  quote: 'updateQuote',
  accessories: 'showAddons',
  choice: 'presentChoice',
  installGuide: 'showDocuments',
  warranty: 'showInfo',
  configurator: 'showConfigurator',
  roster: 'readRoster',
  teamColours: 'getTeamColours',
  customDesign: ['analyzeDesign', 'generateDesign', 'showConfigurator', 'submitForReview', 'checkReviewStatus'],
  teamOrder: ['generateTeamDesign', 'submitTeamOrder'],
  photoUpload3D: 'uploadPhotosFor3D',
  fitmentGuide: 'recommendSize',
};

export const AVAILABLE_CAPABILITIES = Object.keys(CAPABILITY_TO_TOOL);
