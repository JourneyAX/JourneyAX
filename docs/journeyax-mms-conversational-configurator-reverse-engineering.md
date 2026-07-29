# JourneyAX M&M’S Conversational Configurator

**Live reverse engineering, current-code audit, target experience, requirements, and implementation plan**

Date: 24 July 2026  
Status: Architecture and product recommendation  
Scope: M&M’S-style personalized confectionery, D2C and business ordering

---

## 1. Executive decision

JourneyAX should not recreate the M&M’S website as another four-step form.

It should create a single conversational **Personalization Studio**:

- The left 40% is the conversation and a compact order brief.
- The right 60% is a continuously live candy scene.
- The agent converts natural language into structured configuration patches.
- Clicking a candy opens a small editor anchored to that candy.
- Colors, text, icons, photos, logos, packaging, quantity, delivery, price, and approval remain visible aspects of one saved creation.
- The customer sees one recommended next action, not a catalog of 92 choices.
- Business rules and product constraints come from published project configuration and catalog APIs, not React constants or prompt rules.

The live M&M’S configurator is not a 3D/WebGL implementation. It is a Next.js application using DOM/SVG presentation, CDN product imagery, GraphQL-backed catalog operations, server-side text moderation, and a separate commerce journey. JourneyAX should therefore use a lightweight interactive 2D/SVG candy renderer for the candies. Optional 3D should be reserved for package products where rotation materially improves the decision, such as jars, bottles, dispensers, or gift boxes.

The existing JourneyAX `CandyDesignPanel` is a useful prototype, but it is not yet a complete or generic SaaS implementation. It hardcodes a confectionery UI component, represents only one printable design, stores customer artwork in browser memory, and has no authoritative server-side configuration aggregate.

---

## 2. What was inspected

### 2.1 Live configurator

The live page was inspected interactively:

- [M&M’S configurator](https://www.mms.com/en-us/configurator?customerType=D2C&step=1)
- Every visible stage was opened.
- Three colors were selected.
- A text design was created and rendered.
- The image-upload requirements were inspected without uploading personal data.
- Packaging categories and results were inspected.
- A bulk package was selected.
- Weight, quantity, SKU, price, delivery control, and final review were inspected.
- The cart action was deliberately not submitted.

### 2.2 Official supporting pages

- [M&M’S corporate products](https://www.mms.com/en-us/business/corporate-products-c.html)
- [M&M’S business personalization](https://www.mms.com/en-us/for-your-business)
- [M&M’S personalization FAQs](https://www.mms.com/en-us/corporate-faqs)
- [M&M’S personalized packaging](https://www.mms.com/en-us/corporate/d2b-personalized-packaging-c.html)
- [M&M’S request a quote](https://www.mms.com/en-us/for-your-business/request-a-quote)

### 2.3 JourneyAX implementation

The review included:

- `CandyDesignPanel`
- `ProjectPanel`
- `StorefrontConfigContext`
- project configuration types
- `showConfigurator` tool schema and enforcement
- session and journey memory
- artwork storage and approval
- product/renderer services
- quote handoff and client journey state
- back-office capability configuration

---

## 3. Live M&M’S journey: reconstructed behavior

## 3.1 Step 1 — Colors

The configurator offers eighteen shell colors and allows up to three selections.

Observed colors:

- White
- Blue
- Light blue
- Pink
- Red
- Yellow
- Light purple
- Orange
- Cream
- Dark pink
- Green
- Aqua
- Grey
- Lime
- Dark green
- Dark blue
- Purple
- Black

Dark green, dark blue, purple, and black are explicitly marked non-printable. They may be included in a mix, but personalized printing is placed on printable shells.

Behavior:

- Selecting a color immediately changes the live candy field.
- Selecting it again removes it.
- The primary next action remains disabled until at least one valid color is selected.
- The visual field is the dominant confirmation mechanism.

### JourneyAX interpretation

Color selection is not a page. It is a structured patch:

```json
{
  "operation": "replace",
  "path": "/mix/colors",
  "value": ["blue", "red", "white"]
}
```

The agent should be able to produce that patch from:

> “Use our red, white, and blue brand colors.”

The same change must also be possible by clicking swatches in the right panel.

The panel and conversation must operate on the same server-owned configuration version.

---

## 3.2 Step 2 — Designs

The live configurator permits up to four printable designs. A design may be:

- Image/photo
- Text
- Icon

Each created design becomes one slot. The candy mixture distributes those designs across printable candies while retaining standard “m” candies.

### Text

Observed constraints:

- Two text lines
- Up to nine characters per line
- Four styles: bold, regular, light, script
- Text is moderated through a server API before acceptance
- Print is black

### Image/photo

Observed requirements:

- JPG, JPEG, or PNG
- Maximum 15 MB
- First uploaded image is free
- A second image adds $4.99
- Background is removed
- Output is printed in black
- One or two forward-facing faces are recommended
- The customer must accept terms before upload
- Copyrighted or trademarked material requires authorization
- Business-logo assistance is routed to business consultants

### Icon

The live journey supports icon selection as a first-class design type. It is not merely an uploaded image.

### JourneyAX interpretation

The model must be an array of design slots:

```json
{
  "designSlots": [
    {
      "slotId": "slot-1",
      "type": "text",
      "lines": ["GO TEAM"],
      "font": "bold",
      "printColor": "black",
      "status": "valid"
    },
    {
      "slotId": "slot-2",
      "type": "artwork",
      "artworkId": "art_...",
      "treatment": "one-color-black",
      "backgroundRemoval": true,
      "status": "awaiting-proof"
    }
  ]
}
```

The maximum number, permitted types, character counts, fonts, pricing, and moderation policies must come from the product configuration schema.

---

## 3.3 Step 3 — Packaging discovery

The inspected journey displayed 92 packaging results.

Top-level categories:

- All packages
- Gifts
- Favors
- Bulk

The results include:

- Bulk candy bags
- Clear party favors
- Favor tins
- Gift jars
- Gift bottles
- Gift boxes
- Dispensers
- DIY favor kits
- Custom packaging variants
- Seasonal packages
- Business-logo packages

The grid mixes:

- Fixed-price products
- Per-unit products
- Promotions
- Minimum quantities
- Variant choices
- Ratings and review counts
- Products with additional package personalization

### Product detail inspected

For personalized bulk candy:

- SKU was shown.
- Weight choices were 2 lb, 5 lb, and 10 lb.
- Quantity was independently adjustable.
- Unit price per pound was displayed.
- ZIP-code delivery estimation was available.
- A package-specific price was shown before continuation.

### JourneyAX interpretation

Showing 92 items is the opposite of the requested simple experience.

The agent should first understand:

- Occasion
- Audience
- Number of recipients or servings
- Individual favors versus shared display
- Desired presentation level
- Budget
- Event date and destination
- D2C versus business purchase

It should then recommend one package.

Example:

> “For 200 trade-show visitors, individual clear favors are the cleanest fit and stay close to your $600 budget. I’ve put your logo mix into that package.”

The right panel shows that package in context with a small **Change package** action. It must not show a broad catalog unless the customer explicitly asks to browse.

---

## 3.4 Step 4 — Review

The final review contains:

- Selected colors
- Created designs
- Chosen packaging
- Weight or product options
- Quantity
- Final price
- Edit actions
- Add to cart
- Large-order quote handoff

The top progress indicator shows only colors, designs, and packaging, while the content reports four stages. This is a small information-architecture inconsistency in the live implementation.

### JourneyAX interpretation

Review should be a persistent compact brief rather than a new page:

```text
Launch event · 200 guests · Aug 28
Red / White / Blue
Logo + “GO TEAM”
200 clear favors
$598 estimated · delivery check pending
```

The customer should be able to say:

> “Make it 250 and use silver tins instead.”

The agent applies a patch, reprices, revalidates delivery, and updates the same canvas.

---

## 4. DOM, rendering, and service reverse engineering

## 4.1 Application architecture

Observed:

- Next.js application with `#__next`
- No canvas element during the inspected candy journey
- No WebGL canvas
- No Three.js, GLTF, OBJ, or comparable 3D asset path observed
- Large use of inline SVG and DOM elements
- Responsive product imagery from Amplience CDN
- Persisted GraphQL queries
- Server-side text moderation
- PowerReviews for product review data
- Datadog browser telemetry

### Conclusion

The live candy scene behaves like a visual configurator but is not a 3D product configurator.

JourneyAX should not equate “immersive” with “3D.” The right technology is:

- SVG/DOM for candy scatter, rotation, lighting, design placement, and direct manipulation
- Image-composition or server proof service for production-faithful output
- Optional WebGL/GLB only for package objects when a rotatable package view adds value

## 4.2 Observed service responsibilities

### Product and content

Catalog/product information is requested through persisted GraphQL operations.

### Text moderation

A `GetTextModerationResult` GraphQL operation is called with the original entered text before the design is accepted.

### Media

Product and packaging images are served through Amplience delivery URLs with responsive transformation parameters.

### Reviews

Reviews are obtained from PowerReviews by product identifiers.

### Rendering

The live candy visualization is client-rendered. Production fidelity still requires a separate proof/composition capability; a visually plausible browser preview must not be treated as approved print artwork.

---

## 5. Recommended 40/60 customer experience

## 5.1 One screen

```text
┌────────────────────── 40% ──────────────────────┬──────────────────────── 60% ────────────────────────┐
│ M&M’S Design Concierge                         │ LIVE CREATION                                      │
│                                                │                                                     │
│ “What are we creating?”                        │      interactive candy field                        │
│                                                │   red / white / blue candies                        │
│ Customer:                                      │   logo + text rendered live                         │
│ “200 favors for a client launch. Use our       │                                                     │
│  logo and red, white and blue.”                │   click any printable candy to edit its design      │
│                                                │                                                     │
│ Agent:                                         │ ┌─────────────────────────────────────────────────┐ │
│ “I’ve created a branded launch mix and put it  │ │ 200 clear favors · $598 · delivery checking    │ │
│  into individual clear favors. Upload the logo │ │ Change package                 Review order →   │ │
│  and I’ll place it on the candies.”            │ └─────────────────────────────────────────────────┘ │
│                                                │                                                     │
│ [Upload logo]                                  │                                                     │
│                                                │                                                     │
│ Brief: Launch · 200 · Aug 28 · Chicago         │                                                     │
│ [message input________________________] [send]  │                                                     │
└────────────────────────────────────────────────┴─────────────────────────────────────────────────────┘
```

## 5.2 Interaction principle

There is no “Step 1 / Step 2 / Step 3” requirement imposed on the customer.

Internally, capabilities still have validation dependencies. The agent decides what is needed next and asks only for missing information that materially affects the result.

Example:

1. Customer describes the full need in one message.
2. Agent extracts the brief and immediately renders a viable first creation.
3. If no logo is available, the agent asks for it while everything else is already visible.
4. Agent recommends one package from quantity, occasion, deadline, and budget.
5. Customer revises naturally or directly manipulates the candy field.
6. System validates artwork, moderation, price, minimum quantity, and delivery.
7. Customer approves the proof and adds to cart or requests a quote.

## 5.3 Clicking candies

Clicking a candy must:

- Identify the design slot currently rendered on that candy.
- Select the candy without changing the mixture.
- Open a small popover anchored next to the clicked candy.
- Offer only relevant actions:
  - Edit text
  - Replace logo/photo
  - Choose icon
  - Duplicate design
  - Remove design
- Update the canvas while the customer types.
- Preserve focus and avoid a full-screen modal.

Color belongs to the overall mix, not an individual candy, unless the tenant configuration explicitly supports per-color design mapping.

---

## 6. One recommended conversational flow

## 6.1 Opening

Agent:

> “What are these for, and roughly how many people are you treating?”

The first customer message may provide the entire brief:

> “We need 200 favors for a Chicago product launch on August 28. Use our red, white, and blue colors, our logo, and ‘GO TEAM.’ Keep it around $600.”

JourneyAX immediately:

- Creates the occasion and quantity context.
- Matches colors to configured printable shells.
- Creates a text design slot.
- Requests the logo upload.
- Recommends an individual-favor package.
- Checks minimum order and estimated pricing.
- Displays the live scene.

## 6.2 Logo upload

After upload:

- File is placed in project-scoped object storage.
- Malware scan runs.
- File type and size are validated.
- Background is removed in a derivative, never by overwriting the original.
- One-color print treatment is generated.
- Copyright/trademark authorization is recorded.
- Automated printability checks run.
- A proof is generated.
- Human/customer approval is required before production.

The agent says:

> “The logo is clean and will reproduce well in black. I removed the white background and placed it on one of the four design faces.”

If uncertain:

> “The fine tagline will disappear at candy size. I kept the main symbol and set the full logo aside for the package label.”

## 6.3 Package recommendation

The agent uses:

- Recipients
- Servings/weight
- Distribution method
- Occasion
- Desired experience
- Budget
- Deadline
- Destination
- Minimum order
- Pricing tiers
- Inventory and production time

It presents one recommendation and one reason.

## 6.4 Final approval

Two approvals are distinct:

1. **Design proof approval** — confirms printable appearance.
2. **Commercial order approval** — confirms package, quantity, delivery, and price.

Neither approval may be inferred from casual language or executed by the agent.

---

## 7. Generic JourneyAX capability architecture

JourneyAX must not add tools named `chooseMmsColor` or `designCandy`.

Use generic configuration capabilities:

```text
Conversation Orchestrator
    │
    ├── getConfigurationSchema
    ├── createConfiguration
    ├── patchConfiguration
    ├── renderConfiguration
    ├── validateConfiguration
    ├── recommendCompatibleItem
    ├── uploadArtwork
    ├── validateArtwork
    ├── moderateContent
    ├── calculateConfigurationPrice
    ├── checkConfigurationDelivery
    ├── presentProof
    ├── recordApproval
    ├── requestQuote
    └── addConfiguredItemToCart
```

The tool implementations come from runtime connectors selected by published project configuration.

## 7.1 Rendering adapter

```ts
interface PresentationRenderer {
  render(input: RenderConfigurationRequest): Promise<RenderConfigurationResult>;
  capabilities(): Promise<RendererCapabilities>;
}
```

Supported implementations may include:

- `dom-svg`
- `image-composite`
- `webgl-3d`
- `vendor-embed`
- `vendor-render-api`

The renderer type is configuration. The agent never needs to know whether the panel uses SVG or GLB.

## 7.2 Product schema adapter

```ts
interface ConfigurationSchemaProvider {
  getSchema(projectId: string, productKey: string): Promise<ConfigurationSchema>;
  validate(projectId: string, configuration: Configuration): Promise<ValidationResult>;
}
```

This provides the option model, dependencies, constraints, display hints, and connector mappings.

## 7.3 Commercial adapter

```ts
interface ConfigurationCommercePort {
  price(configurationId: string, version: number): Promise<PriceResult>;
  checkDelivery(configurationId: string, postalCode: string): Promise<DeliveryResult>;
  quote(configurationId: string, version: number): Promise<QuoteResult>;
  addToCart(configurationId: string, approvedVersion: number): Promise<CartResult>;
}
```

Money, minimum quantities, promotions, and orderability must never be calculated in the browser or by the LLM.

---

## 8. Authoritative configuration state

## 8.1 Aggregate

```ts
interface ConfigurationProject {
  configurationId: string;
  projectId: string;
  sessionId: string;
  customerId?: string;
  channel: 'web' | 'mobile' | 'sales-console' | 'partner-portal';

  intent: {
    occasion?: string;
    audience?: string;
    eventDate?: string;
    destinationPostalCode?: string;
    recipientCount?: number;
    budget?: { amount: number; currency: string };
    notes?: string[];
  };

  product: {
    productKey: string;
    family: string;
    schemaVersion: string;
  };

  selections: Record<string, unknown>;
  designSlots: DesignSlot[];
  packaging?: {
    productKey: string;
    variantKey?: string;
    quantity: number;
    options: Record<string, string | number>;
  };

  validation: ValidationResult;
  price?: PriceResult;
  delivery?: DeliveryResult;
  proof?: ProofRecord;
  approval?: ApprovalRecord;

  status:
    | 'draft'
    | 'needs-input'
    | 'validating'
    | 'proof-ready'
    | 'approved'
    | 'quoted'
    | 'carted'
    | 'ordered';

  version: number;
  createdAt: string;
  updatedAt: string;
}
```

## 8.2 Command model

Every chat instruction or panel interaction becomes a command:

```ts
interface ConfigurationCommand {
  commandId: string;
  configurationId: string;
  expectedVersion: number;
  actor: { type: 'customer' | 'agent' | 'sales' | 'system'; id?: string };
  operation: string;
  payload: unknown;
}
```

The server:

1. Checks tenant and project scope.
2. Enforces expected version.
3. Validates the command against the schema.
4. Applies it once using `commandId` idempotency.
5. Recalculates affected validation, rendering, price, and delivery state.
6. Persists the new version.
7. Publishes an event to the right panel.

This supports undo, redo, replay, audit, channel continuity, and conflict handling.

---

## 9. Back-office configuration requirements

The entire experience must be publishable per tenant.

## 9.1 Product family

- Product-family key and label
- Catalog connector
- Configuration schema version
- Enabled channels
- Renderer adapter
- Commerce adapter
- Pricing adapter
- Delivery adapter
- Artwork adapter
- Moderation adapter

## 9.2 Selection rules

- Maximum selected colors
- Minimum selected colors
- Available colors
- Display name and hex value
- Printable/non-printable status
- Print color
- Per-color design eligibility
- Default mix
- Color compatibility rules

## 9.3 Design slots

- Maximum number of slots
- Allowed slot types
- Text lines
- Character limit by line
- Fonts
- Icons/libraries
- Image count and pricing
- Supported file types and size
- Required terms
- Moderation policy
- Trademark authorization requirements
- Background-removal policy
- Print treatment

## 9.4 Packaging

- Categories
- Package products
- Product variants
- Unit/weight model
- Minimum quantity
- Quantity increments
- Package-personalization schema
- Recommendation features
- Price tiers
- Lead time
- inventory/orderability

## 9.5 Conversation

- Persona
- Opening prompt
- Required intent dimensions
- Tone
- Recommendation strategy
- D2C versus business thresholds
- Quote escalation threshold
- Human-handoff conditions
- Explanation templates

## 9.6 Presentation

- 40/60 ratio
- Stage background
- Candy geometry
- Candy count and density
- Lighting recipe
- Motion level
- Reduced-motion behavior
- Click action
- Editor placement
- Summary-bar fields
- Primary action

---

## 10. Current JourneyAX implementation audit

## 10.1 What is already good

- There is a dedicated visual candy field.
- The requested 40/60 storefront architecture already supports a large right panel.
- Candy geometry uses deterministic placement, preventing visual reshuffling.
- The design reacts immediately to colors and entered content.
- Printable versus non-printable shell behavior is represented.
- Text limits and fonts are intended to be config-driven.
- There is an existing server-side `ArtworkService` with provenance and human approval.
- Session storage and the journey capability ledger are now server-owned.
- The agent capability registry is project-configurable.
- The platform already has a renderer abstraction for garment tenants.

These are valuable foundations.

## 10.2 P0 — Config schema does not describe the component

`CandyDesignPanel` reads:

- `configurator.shells`
- `configurator.text.fonts`
- `configurator.text.maxChars`
- `configurator.text.lines`
- `configurator.maxColours`
- `configurator.logoRule`

The typed `ConfiguratorConfig` in project service and storefront context does not define these fields. The panel bypasses the mismatch with `as any`.

Consequences:

- Back-office users cannot reliably configure the experience.
- Validation cannot guarantee a complete configuration.
- Published configuration contracts can drift silently.
- Other tenants cannot safely reuse the panel.

Required fix:

- Replace the garment-oriented `ConfiguratorConfig` with a versioned generic configuration schema.
- Validate drafts and published snapshots.
- Generate or share TypeScript types from the schema.
- Add the corresponding back-office editor.

## 10.3 P0 — Empty configuration can crash rendering

If `shells` is missing, the default `pileColours` array is empty. The renderer indexes it with `i % pileColours.length`, producing `undefined`, and `shade()` calls `.replace()` on that value.

Required fix:

- Reject incomplete configuration at publish time.
- Provide a safe render fallback.
- Add a startup/configuration health check.
- Never allow a customer session to discover malformed project configuration.

## 10.4 P0 — Only one design is represented

The live product supports up to four designs. JourneyAX stores:

- One first line
- One second line
- One photo

It cannot represent:

- Four independent designs
- A combination of logo, text, icon, and photo
- Editing a specific printed face
- Per-slot pricing
- Per-slot validation

Required fix:

- Introduce `designSlots[]`.
- Give each clickable candy a `designSlotId`.
- Distribute slots according to a configured rendering policy.

## 10.5 P0 — Artwork upload is browser-only

The current panel reads the file into a data URL using `FileReader`.

It does not:

- Upload to project-scoped object storage
- Register the file with `ArtworkService`
- Scan for malware
- Enforce server file type/size
- Record authorization
- Produce immutable derivatives
- Persist across devices/sessions
- Create a proof
- Require human approval

The existing `ArtworkService` should be integrated instead of bypassed.

## 10.6 P0 — Client-side “audit” is not production validation

The pixel sampling is a useful UX hint but cannot be a production gate.

It cannot reliably determine:

- Trademark ownership
- Face/image acceptability
- Actual background-removal quality
- Print-line thickness
- Production rasterization
- Legibility at final print dimensions
- Manufacturing acceptance

Required fix:

- Keep client checks as early guidance.
- Run authoritative server validation.
- Return machine-readable issues and remediations.
- Generate a production proof for approval.

## 10.7 P0 — Agent tool schema is garment-specific

`showConfigurator` tells the model it is opening a 3D garment configurator and exposes:

- SKU
- Base/accent garment colors
- Name
- Number
- Design line
- Lettering and outline colors

This is incompatible with candy:

- Up to three mix colors
- Four design slots
- Text/image/icon types
- Package selection
- Weight
- Quantity
- Artwork and moderation

The special `configuratorType === 'candy'` branch is another vertical-specific code path.

Required fix:

- Replace the vertical payload with `configurationId`, `schemaKey`, and generic patches.
- Allow a renderer adapter to interpret the configuration.
- Keep tenant-specific vocabulary in schema/display metadata.

## 10.8 P0 — Generic no-SKU enforcement can block candy

The forced configurator path suppresses `showConfigurator` when there is no SKU and no active SKU. That rule is valid for a garment mesh, but a customer should be able to begin an M&M’S mix before selecting packaging.

Required fix:

- Ask the schema whether an initial product key is required.
- Do not branch on the string `candy`.

## 10.9 P1 — Package flow is incomplete

Current packaging cards contain only a name and price.

Missing:

- Category and recommendation rationale
- Package image
- Weight/options
- Quantity
- Minimum and increment
- Per-unit or per-weight pricing
- Price tiers
- Package personalization
- Inventory
- Delivery estimate
- Promotion validity
- D2C versus quote route

## 10.10 P1 — UI does not match the requested direct manipulation

The code comments say the popup opens “on” the candy. The implementation opens a centered overlay after clicking anywhere in the entire field.

Required fix:

- Make individual rendered candies interactive.
- Preserve clicked-candy coordinates.
- Anchor a small popover to the selected candy.
- Keep the visual stage unobscured.

## 10.11 P1 — Configuration remains client-local

The new server journey state stores capability completion and active SKU, but not the confectionery configuration aggregate.

The current panel sends a generated natural-language sentence back into chat to build a quote. This loses structured fidelity and makes the LLM reconstruct commercial state.

Required fix:

- Persist configuration directly through a typed API.
- Send only `configurationId` and version to the agent and quote service.
- Do not serialize customer selections into prose as the system of record.

## 10.12 P1 — Hardcoded visual and vertical language remains

Examples:

- Candy-specific component selection in `ProjectPanel`
- Fixed lentil aspect ratio
- Fixed scatter rows and columns
- Fixed default colors
- “m” glyph
- “candy size” copy
- Fixed black-print assumptions
- `productType === 'candy'`

Some of these are valid M&M’S tenant configuration, but they are not platform behavior.

Required fix:

- Move tenant/product vocabulary and visual recipes into schema/presentation config.
- Select generic panel modules from declared renderer capabilities.

## 10.13 P1 — Back office exposes only “3D configurator”

The back office capability label describes only a 3D product designer and has no configurator-schema management surface.

Required fix:

- Rename the capability to **Interactive product configuration**.
- Provide schema, renderer, validation, artwork, pricing, packaging, and journey configuration.
- Add draft validation, preview, publish, versioning, and rollback.

---

## 11. Functional requirements

### MMS-FR-001 — Natural-language brief

The agent shall extract occasion, audience, quantity, event date, destination, budget, colors, design intent, packaging intent, and customer type from one message.

### MMS-FR-002 — Immediate first render

The right panel shall display a valid initial candy scene as soon as the minimum schema requirements are known.

### MMS-FR-003 — Bidirectional editing

Chat commands and direct panel interactions shall update the same configuration aggregate.

### MMS-FR-004 — Multiple design slots

The platform shall support a schema-configured number of independent text, image, artwork, or icon slots.

### MMS-FR-005 — Anchored candy editing

Selecting a rendered candy shall open an editor anchored to that candy and associated with its design slot.

### MMS-FR-006 — Server artwork workflow

Artwork shall be uploaded, scanned, stored, validated, transformed, proofed, and approved through server services.

### MMS-FR-007 — Content moderation

Text and uploaded content shall pass tenant-configured moderation before approval or production.

### MMS-FR-008 — Recommendation-first packaging

The agent shall present one best-fit package unless the customer asks to browse or the recommendation confidence is insufficient.

### MMS-FR-009 — Authoritative pricing

All prices shall come from the commerce/pricing adapter using the complete configuration, quantity, customer type, promotion, and project context.

### MMS-FR-010 — Delivery validation

Delivery estimates shall consider destination, production lead time, cutoff, inventory, and approval status.

### MMS-FR-011 — Approval separation

Proof approval and commercial order approval shall be distinct auditable actions.

### MMS-FR-012 — Large-order route

Configurable thresholds shall route eligible orders to quote/sales without discarding the customer’s completed creation.

### MMS-FR-013 — Resume and share

A saved configuration shall resume from another device or channel subject to identity and authorization.

### MMS-FR-014 — Accessibility

Every visual selection shall have an equivalent keyboard, screen-reader, and conversational operation.

### MMS-FR-015 — Reduced motion

Candy motion and transitions shall honor reduced-motion preferences.

---

## 12. Non-functional requirements

### Performance

- First useful scene: under 1.5 seconds on a normal broadband connection.
- Configuration patch acknowledgement: under 250 ms at p95, excluding external vendor latency.
- Visual patch: under 100 ms after accepted state.
- Pricing response: under 1 second at p95.
- Image transformation must be asynchronous with visible progress.

### Reliability

- Commands must be idempotent.
- Configuration writes must be optimistic-versioned.
- Renderer failure must not lose configuration.
- Pricing failure must never display a guessed price.
- External connector failures must expose a retryable state.

### Security

- Every configuration, artwork, proof, and quote query must include project/tenant scope.
- Client-supplied tenant IDs are never authoritative.
- Uploads use short-lived signed URLs.
- Original and derivative artwork are private by default.
- MIME signature, extension, and file size are validated server-side.
- SVG is sanitized or rasterized before display.
- Personally identifiable imagery follows retention and deletion policy.

### Compliance

- Terms version and acceptance timestamp are recorded.
- Authorization basis for trademarks/logos is recorded.
- Customer approval includes configuration version and proof hash.
- “Right to delete” removes or anonymizes associated customer artwork according to policy.

### Observability

Trace:

- Conversation turn
- Tool/capability selection
- Configuration command
- Validation
- Renderer
- Pricing
- Delivery
- Proof
- Approval
- Quote/cart

Do not log raw artwork, full user-entered text, access tokens, or signed URLs.

---

## 13. Back-office experience

The product owner should be able to:

1. Choose **Interactive product configuration**.
2. Connect a catalog.
3. Select a product family.
4. Import or author the configuration schema.
5. Map catalog attributes to schema options.
6. Configure the renderer.
7. Configure artwork and moderation rules.
8. Configure package recommendations.
9. Configure D2C/quote thresholds.
10. Preview a test creation.
11. Run validation.
12. Publish a version.
13. Monitor conversion and errors.
14. Roll back.

No developer should be required to add another `if (productType === ...)` branch to onboard a confectionery, footwear, vehicle, furniture, or apparel configurator.

---

## 14. Implementation sequence

## Phase 1 — Correct the platform contract

- Create versioned `ConfigurationSchema`.
- Create server-owned `ConfigurationProject`.
- Create command and event APIs.
- Add tenant-scoped persistence and optimistic versioning.
- Replace the garment-specific agent payload with generic configuration patches.
- Add back-office schema validation.

**Exit criterion:** a configuration can be created, patched, resumed, audited, and rendered without the LLM reconstructing it from prose.

## Phase 2 — Production-ready M&M’S capabilities

- Implement color mix schema.
- Implement multiple design slots.
- Add text and icon designs.
- Connect text moderation.
- Integrate `ArtworkService`.
- Add background-removal and one-color proof derivatives.
- Add proof and customer approval.

**Exit criterion:** a valid four-design creation survives refresh and can be approved.

## Phase 3 — Packaging and commerce

- Ingest package products and variants.
- Add recommendation features.
- Add minimum quantities and increments.
- Add authoritative pricing.
- Add weight/options.
- Add delivery estimation.
- Add D2C cart and business quote routes.

**Exit criterion:** the same approved configuration can be priced and routed without manual re-entry.

## Phase 4 — 40/60 wow experience

- Replace the centered modal with anchored candy editing.
- Add smooth, reduced-motion-aware transitions.
- Add compact persistent brief and commercial summary.
- Add a single recommended package stage.
- Add optional 3D package adapter for supported packages.
- Add save/share/resume.

**Exit criterion:** usability tests complete a typical personalized order without navigating a form wizard or viewing a broad package grid.

## Phase 5 — Evaluation and rollout

- Contract tests for schemas/connectors.
- Visual regression tests for renderers.
- Configuration command/idempotency tests.
- Moderation and artwork security tests.
- Price and delivery parity tests.
- Conversation scenario suite.
- D2C and sales-assisted user testing.
- Accessibility audit.
- Gradual tenant rollout with feature flags.

---

## 15. Required evaluation scenarios

1. “200 client favors for a launch, red/white/blue, logo, $600, Chicago by Aug 28.”
2. “Birthday gift for one person, pink and yellow, photo plus HAPPY 30.”
3. “Use black, purple, and dark blue and print the logo on every candy.”
4. Text exceeds the configured line limit.
5. Offensive or prohibited text.
6. Trademarked logo without authorization.
7. Low-resolution logo with fine text.
8. Two-face photo with a busy background.
9. Package quantity below minimum.
10. Quantity not in the required increment.
11. Event date cannot be met.
12. Customer changes colors after proof generation.
13. Customer changes quantity after quote generation.
14. Customer asks to see all packages.
15. Customer resumes on another device.
16. Two commands arrive with the same expected version.
17. Pricing vendor times out.
18. Renderer fails after state is saved.
19. Customer requests deletion of uploaded artwork.
20. Sales representative opens the customer’s creation and prepares a quote.

---

## 16. Acceptance measures

Product quality:

- At least 90% of test customers reach a valid first creation in under two minutes.
- At least 80% do so without opening a full catalog.
- Repeated questions under 1% of sessions.
- Configuration loss after refresh: zero in tested flows.
- Price mismatch against commerce: zero.
- Unapproved artwork reaching order creation: zero.
- Unsupported print/color combinations reaching approval: zero.

Experience:

- One dominant customer action at a time.
- Right panel changes in the same turn as the agent response.
- The customer can edit by chat or direct manipulation without divergence.
- The agent explains constraints in plain language and offers a remedy.
- The customer never needs to understand product SKUs, schema keys, or renderer technology.

---

## 17. Final architecture principle

The LLM understands the customer’s intent.  
The configuration schema defines what is possible.  
The server owns the configuration state.  
The renderer makes it tangible.  
The validators protect production.  
The commerce system owns price and orderability.  
The customer owns approval.

That separation is what allows JourneyAX to produce an M&M’S experience with a “wow” effect without hardcoding M&M’S into the platform.
