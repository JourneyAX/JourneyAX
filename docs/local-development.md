# Local development

From the repository root on `JourneyAX-Dev-V5`:

```sh
npm run dev
```

Go is at http://localhost:3008/?project=placemakers and Studio/back office is at http://localhost:3009. Use the existing persona logins. Ctrl+C stops this development stack.

This starts the existing application services and shared package watchers through Turbo. It includes real connectors, IQ, authentication, projects, products, the journey runtime, commerce, gateway, organizations, analytics and both web apps. Backend source changes compile with TypeScript (including Nest decorator metadata) and restart after successful compilation. The web apps use Next development mode. No separate V5 application or runtime is required.

## Private local settings

The ignored root `.env.development.local` supplies DEV scope, the existing database/model configuration, internal keys and local service ports. The ignored `.env.connectors.local` holds vendor credentials and is loaded only by the real connector process. Existing `.env` and `.env.connectors` files are preserved. Never commit any of these private files.

On another machine, obtain these settings through the team's secret-sharing process. Root startup intentionally refuses missing DEV configuration, production scope, live Stripe keys, disabled IQ, mismatched connector routes and occupied ports. It does not install dependencies, seed data, publish a Business Pack or deploy anything. Existing catalogue and document reads still use the configured data sources. Business mutations still require the normal approval flow.

The current private configuration keeps the already verified backend ports (gateway 3110, runtime 3112, commerce 3104, sources 4120, auth 8180, projects 8182, products 8183, IQ 8188), with organizations 8195 and analytics 8186. These are local routing settings, not separate applications.

## V5 verification tools

The IQ identity contract test imports `scripts/integrations/iq-identity-candidate.ts`. It builds a candidate in memory. The `scripts/fixtures` ERP tools support a synthetic test dataset. Review the fixture plan with `npx tsx scripts/fixtures/seed-demo-erp.ts --input demo-data/v5/erp/placemakers.json`.

Root startup replaces the old `scripts/v5` launcher. The relocation manifest at `docs/evidence/v5/root-dev-helper-relocation.json` maps the 51 local helpers to their new locations. The remaining 48 are local operator tools, diagnostic scripts, or evidence tooling. Application code lives in `apps/` and `packages/`.
