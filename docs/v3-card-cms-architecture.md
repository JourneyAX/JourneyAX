# JourneyAX v3 — Card CMS architecture (integration contract)

Branch: `JourneyAX-dev-v3-dragonshield`. Status: foundation build, 2026-09-12.

## Why
One shared storefront component tree served every tenant with `cfg.projectId === 'placemakers'` style
branches inside ProductsPanel, QuotePanel, OrderedPanel and ChatPanel. Fixing one tenant broke another.
Data was segregated by projectId; code was not.

## The model (decided with Mahaveer)
1. **Cards are JSON in MongoDB, per project** — CMS style. Not React components per tenant.
2. **`@journeyax/ui-cards`** (packages/ui-cards, built to `dist/`) holds:
   - `catalog/primitives.ts` — 24 neutral primitives (Box, Card, Grid, Text, Image, Price, Badge, StatusDot,
     Button, Link, Icon, Divider, Spacer, Chips, KeyValue, Table, Steps, Progress, Alert, Rating, Swatches,
     Quantity, Select, Markdown). **Nothing tenant-specific ever goes here.**
   - `catalog/actions.ts` — 13 named actions a card may raise (selectItem, viewProduct, addToCart,
     addAllToCart, removeFromCart, setQuantity, sendMessage, openPanel, checkout, chooseOption,
     selectBranch, openUrl, setState).
   - `catalog/card-types.ts` — 17 card types + zod state contracts: hero, clarify, products, productDetail,
     comparison, bundle, quote, cart, orderStatus, guide, plan, accessories, warranty, fitment, disclosure,
     suggestions, working. `CardInstance = { id, cardType, state, variant?, streamId?, createdAt? }`.
   - `templates/defaults.ts` — `DEFAULT_TEMPLATES: Record<CardType, Spec>` (json-render flat specs).
   - `theme/tokens.ts` — `ThemeTokens`, `DEFAULT_TOKENS`, `mergeTokens`, `tokensToCssVars` (`--jx-*`),
     `applyTokens`, `CardSettings`, `UiTheme`.
   - `react.tsx` — `CardRenderer({ template, state, settings?, onAction?, loading?, stateKey? })`,
     `CatalogRenderer`, `JxIcon`. Import from `@journeyax/ui-cards/react`.
   - `styles.css` — base styles for primitives; import once per app: `import '@journeyax/ui-cards/styles.css'`.
3. **json-render** (`@json-render/core`, `@json-render/react` 0.20) renders `template + state` at runtime.
   Bindings: `{ "$state": "/path" }`, `{ "$item": "field" }` inside `repeat`, `{ "$template": "…${/path}…" }`,
   `visible: [{ "$state": "/x" }]`, `on: { press: { action, params } }`, `repeat: { statePath, key }`.
4. **Three theme layers** per project, all in `ProjectConfig` (Mongo `journeyax.projects`, published through
   the existing draft → publish → `config_versions` flow):
   - `uiTheme.tokens` (Partial<ThemeTokens>) → emitted as `--jx-*` CSS vars.
   - `uiTheme.cards[cardType]` (`CardSettings`: enabled, variant, labels, options) → exposed to the template at
     `$state: /settings/...`.
   - `cardTemplates[cardType]` (`CardTemplateDoc`) → overrides the platform default spec wholesale.
5. **Agent contract (from anthropics/commerce-agents):** the model picks ids + reasons; the server joins every
   fact (title, price, image, stock) from records seen this session or the catalogue; ids with no provenance are
   dropped. The `uiAction` SSE frame carries `card: { cardType, state, streamId }`.
6. **Storefront layout:** intro/chat = existing 40/60 split. Once a card is on stage, the chat column collapses
   and the conversation lives in a floating command/voice bar docked ABOVE the stage footer (never over the
   CTA), with a "Working for Ns" strip that expands into trace + "Heard" + last reply
   (artboards: PlaceMakers Voice Bar canvas, Main.dc.html / Expanded.dc.html).
7. **Skills** (commerce-agents naming): `apps/agent-commerce-service/skills/_platform/<skill>/SKILL.md` and
   `skills/<projectId>/<skill>/SKILL.md`, front-matter `name`, `description` ending with "Not needed when …".

## Shapes (authoritative)

```ts
// project-service: ProjectConfig additions (project.types.ts)
uiTheme?: UiTheme;                                  // from @journeyax/ui-cards
cardTemplates?: Record<string, CardTemplateDoc>;    // key = cardType
fulfilment?: {
  mode?: 'delivery' | 'collect' | 'both';
  label?: string;              // "Branch fulfilment & pickup"
  badge?: string;              // "60-min Click & Collect"
  branches?: { id: string; name: string; address?: string }[];
};
interface CardTemplateDoc { cardType: string; variant?: string; spec: Spec; updatedAt: string; updatedBy?: string; note?: string }
```

```ts
// storefront: JourneyState additions (lib/types.ts)
cards: CardInstance[];        // stack; last pushed = active unless activeCardId set
activeCardId?: string;
working?: { startedAt: number; label?: string; heard?: string; steps: { title: string; detail?: string; status?: 'done'|'running'|'pending' }[]; lastReply?: string } | null;
// reducer actions (context/JourneyContext.tsx)
| { type: 'PUSH_CARD'; card: CardInstance }          // replaces an existing card of the same cardType unless card.variant === 'append'
| { type: 'SET_ACTIVE_CARD'; id: string }
| { type: 'POP_CARD'; id?: string }
| { type: 'PATCH_CARD'; id: string; state: Record<string, unknown> }   // shallow merge into card.state
| { type: 'SET_WORKING'; working: JourneyState['working'] }
| { type: 'CLEAR_CARDS' }
// adapter (lib/cards/uiActionToCards.ts)
export function uiActionToCards(name: string, args: any, ctx: { cfg: StorefrontConfig; state: JourneyState }): CardInstance[];
// template resolver (lib/cards/resolveTemplate.ts)
export function resolveTemplate(cfg: StorefrontConfig, cardType: CardType): Spec;  // tenant override → DEFAULT_TEMPLATES
```

```ts
// agent-commerce-service: SSE `uiAction` payload
{ name: string; arguments: any; card?: { cardType: CardType; state: Record<string, unknown>; streamId: string } }
```

## project-service endpoints
- `GET    /api/v1/projects/:id/cards`            → `{ cards: { cardType, source: 'tenant'|'default', spec, settings }[] }` (draft)
- `PUT    /api/v1/projects/:id/cards/:cardType`  body `{ spec, note? }` → validates (types ∈ primitives, children exist, root exists) → draft `cardTemplates[cardType]`; `@RequirePermission('config.edit')`
- `DELETE /api/v1/projects/:id/cards/:cardType`  → removes override (back to default); `config.edit`
- `PATCH  /api/v1/projects/:id`                  already accepts partial config → add `uiTheme`, `fulfilment` to `UpdateProjectDto`
- `POST   /api/v1/projects/:id/publish`          unchanged; snapshot now carries the three layers
- `GET    /api/v1/projects/:id/published`        unchanged (whole snapshot) — storefront `/api/config` maps `uiTheme`, `cardTemplates`, `fulfilment` through

## Storefront action → behaviour map (CardStage)
| action | behaviour |
|---|---|
| sendMessage {text} | `window.__journeySend(text)` |
| chooseOption {questionId, value} | `SET_DYNAMIC_ANSWER`; when every question answered → `window.__handleClarifySubmit()` |
| viewProduct {sku} | push `productDetail` card from the product already in the active card's state |
| addToCart {sku, qty} / addAllToCart {skus?} | quote-mode: `window.__handleBuildQuote(skus)`; cart-mode: existing RetailCart add path |
| setQuantity {sku, qty} / removeFromCart | PATCH_CARD on the quote/cart lines + existing server re-quote path |
| selectBranch {branchId} | existing `/api/branch-stock` call → `APPLY_QUOTE_BRANCH_STOCK` + PATCH_CARD fulfilment |
| checkout | `handleApprove()` (Stripe) |
| openPanel {panel, sku} | `SET_PHASE` to the legacy panel phase |
| openUrl {url} | `window.open(url, '_blank', 'noopener')` |

Legacy phases that stay as React panels for now (no card type yet): configurator, designEditor, concepts,
teamDesign, teamRoster, teamPreview, photoUploadDesign, spacePlanner (+ candy configurator). Everything else
renders through `CardStage`.

## Rules
- No `projectId ===` / tenant name literals in `apps/journeyax-web/src/components/**` (ESLint `no-restricted-syntax`).
- Charts (backoffice analytics) stay outside the card system.
- Every scraped / retrieved string is fenced before it enters a prompt.
- Prices and totals on any card come from the server; the model never authors a number that renders.
