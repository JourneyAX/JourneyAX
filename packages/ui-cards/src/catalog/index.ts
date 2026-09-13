import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { primitives } from './primitives';
import { actions } from './actions';

export * from './primitives';
export * from './actions';
export * from './card-types';

/**
 * The single json-render catalog for the whole platform.
 * `catalog.prompt()` can be handed to an LLM when we let the agent author
 * layout directly; in the CMS model the agent only produces DATA and the
 * template (from Mongo) produces the spec, so the prompt is rarely needed.
 */
export const catalog = defineCatalog(schema, {
  components: primitives,
  actions,
});

export type Catalog = typeof catalog;
