/**
 * One-line plain descriptions of the platform's built-in tools, for the Customize page's Connectors tab.
 *
 * Copied (shortened) from the tool definitions in `apps/journey-runtime-service/src/agent/agent-tools.ts`, which stay the source
 * of truth for what a tool does. Lives on the server side of the overview route so the page components carry no tool wording:
 * the route puts the words in its response. A tool this list does not know is described generically.
 */
export const PLATFORM_TOOLS: Record<string, { name: string; description: string }> = {
  consult_business_knowledge: { name: 'Business knowledge', description: 'Looks up verified business knowledge: recipes, product family notes, what goes with what, care and installation notes.' },
  search_products: { name: 'Search products', description: 'Searches the product catalogue by keyword, category, brand and product attributes.' },
  browse_range: { name: 'Browse the range', description: 'Explains how a group of products is organised, with real examples and sizes of each group.' },
  explore_options: { name: 'Explore options', description: 'Finds the real brands, sizes and variants a group of products comes in, so questions only offer options the shop has.' },
  get_product: { name: 'Product details', description: 'Reads the full specifications, details and price of one product.' },
  get_related_products: { name: 'Related products', description: 'Finds companion items, accessories, system parts and alternatives for a product.' },
  search_guides: { name: 'Guides and documents', description: 'Searches verified installation guides, technical documents and how-tos.' },
  read_product_guide: { name: 'Product guides', description: 'Reads the supplier\'s own guide kept with a product (specification guide, installation guide, manual) and answers from its words.' },
  read_content_page: { name: 'Shop pages', description: 'Reads the shop\'s own web pages (project how-tos, inspiration, compliance notes, trade-tool pages) and the real products they feature.' },
  open_form: { name: 'Forms', description: 'Opens one of the shop\'s own forms (contact us, an enquiry, a call-back request) for the customer to fill in and send; the shop reads what is sent.' },
  get_warranty: { name: 'Warranty', description: 'Reads verified warranty periods, terms and certificates for a product or brand.' },
  calculate_quantity: { name: 'Quantity calculator', description: 'Works out how much of a product a job needs, from the customer\'s measurements and the shop\'s own formulas.' },
  check_stock: { name: 'Check stock', description: 'Checks real stock of a product at a branch or location.' },
  present_card: { name: 'Show a card', description: 'Shows an interactive card (products, details, comparison, guide, plan...) built from approved catalogue data.' },
  hand_off_to_human: { name: 'Hand off to a person', description: 'Passes the conversation to a staff member when asked or when a question is out of scope.' },
  create_quote: { name: 'Create a quote', description: 'Creates a quote from items and quantities; the server checks prices and approvals.' },
  update_quote: { name: 'Update a quote', description: 'Changes an existing quote; larger changes may need approval.' },
  add_to_quote: { name: 'Add to a quote', description: 'Adds items or specifications to an existing quote.' },
  get_cart: { name: 'View the cart', description: 'Reads the customer\'s current cart: items, quantities and totals.' },
  update_cart: { name: 'Update the cart', description: 'Adds, changes or removes items in the customer\'s cart.' },
  get_journey_checklist: { name: 'Journey checklist', description: 'Reports what the customer\'s journey still has to cover.' },
  estimate_quantity: { name: 'How many to buy', description: 'Works out how many pieces or packs a customer needs for their area, from the product\'s own size or stated coverage.' },
  generate_visual: { name: 'Picture of the finished job', description: 'Makes an illustration of the customer\'s project with the products they are considering, labelled as an illustration.' },
  use_skill: { name: 'Use a skill', description: 'Reads the instructions of an on-demand skill when a request calls for it.' },
};

/** A readable name for a tool id this list does not know ("get_thing_now" → "Get thing now"). */
export function humaniseToolId(id: string): string {
  const words = String(id || '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Tool';
}

export function describeTool(id: string): { name: string; description: string } {
  return PLATFORM_TOOLS[id] || { name: humaniseToolId(id), description: 'A tool of the platform that agents can be allowed to call.' };
}
