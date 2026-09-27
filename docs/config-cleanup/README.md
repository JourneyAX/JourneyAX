# Commerce Agent Configuration and Tool Cleanup

This folder records the staged migration of the commerce agent toward Back Office configuration and separated tool execution.

## Phase documents

1. [Phase 1 — Runtime configuration](phase-1-runtime-config.md)
2. [Phase 2 — Configuration safety](phase-2-config-safety.md)
3. [Phase 3 — Tool architecture](phase-3-tool-architecture.md)
4. [Next — Orchestration extraction](next-orchestration.md)

## Overall result

- Tenant and business behavior is read from published Back Office configuration wherever an existing configuration field supports it.
- Tool definitions, policies, contracts, and execution modules are separated from the main agent service.
- Synchronous and streaming paths share the extracted commerce executors.
- AgentService still owns model-loop orchestration, journey-state sequencing, persistence, and response finalisation.

## Verification

- npm run build --workspace=agent-commerce-service
- git diff --check
- No duplicate or legacy executor implementations remain.

No new tenant-specific configuration schema was added in this migration.
