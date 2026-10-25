import type { Deps, Env, RealConnector } from './types';
import { commercetools } from './connectors/commercetools';
import { salesforce } from './connectors/salesforce';
import { googleAnalytics } from './connectors/google-analytics';
import { powerBi } from './connectors/power-bi';

export * from './types';
export * from './server';
export * from './validate';
export { commercetools, salesforce, googleAnalytics, powerBi };

/** Every real connector, built from the given settings. A connector whose settings are missing is still in the list; it just says it is not connected. */
export function createRealConnectors(env: Env = process.env, deps: Partial<Deps> = {}): RealConnector[] {
  const full: Deps = { fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? Date.now };
  return [commercetools(env, full), salesforce(env, full), googleAnalytics(env, full), powerBi(env, full)];
}
