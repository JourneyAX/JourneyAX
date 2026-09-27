/** Runtime configuration contract used by the Backoffice-first agent. */
export type { EffectiveAgentConfig, AgentContextDimension } from './schema/agent-config';
export { PLATFORM_DEFAULT_AGENT_CONFIG } from './defaults-platform';
export {
  GENERIC_BUSINESS_CONFIG,
  mergeGenericBusinessConfig,
  renderGenericBusinessConfig,
} from './generic-business-config';
