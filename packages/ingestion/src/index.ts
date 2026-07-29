/**
 * @journeyax/ingestion — interface-driven, adapter-based ingestion.
 *
 * Ports:      IngestionSourcePort, Converter<S,T>, Populator<S,T>, ArtifactStorePort
 * Registry:   SourceConnectorRegistry (resolve connectors by configured type)
 * Converters: FeedRowToProductConverter (in) / ProductToExportDtoConverter (out)
 * Populators: identity, images, colour+size, price, variants
 *
 * The pipeline depends on the ports only — never on a concrete connector, tenant
 * or brand. New tenant = configuration. New source type = one registration.
 */
export * from './ports';
export * from './registry';
export * from './converters/base.converter';
export * from './converters/product.converter';
export * from './populators/product.populators';
export * from './storage/artifact-store';
