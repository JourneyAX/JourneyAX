import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AttributeDefinition } from '@journeyax/business-pack';

const root = path.resolve(__dirname, '../../../..');
const placemakersMapping = JSON.parse(
  readFileSync(path.join(root, 'docs/migrations/placemakers-catalog-mapping.json'), 'utf8')
).catalogMapping;

/**
 * Standard PlaceMakers attribute definitions loaded from real catalogue mapping data.
 */
export const PLACEMAKERS_ATTRIBUTE_DEFINITIONS: Record<string, AttributeDefinition> =
  placemakersMapping.attributeDefinitions || {};
