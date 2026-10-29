/**
 * The stages that extend a sample connector's finished seed. build-seeds.ts applies them once, after the full build and before writing;
 * extend-seeds.ts applies them to the committed seed files, so a connector can grow new fields without the PlaceMakers data folder.
 */
import type { SeedFile } from '../../src/types';
import { erpAccountKeys } from './erp-account-keys';
import { erpInvoices } from './erp-invoices';

/** A stage only adds: fields a row does not have yet, and the notes about them in the provenance. It never gives a field that is there a new value, so applying it again changes nothing. */
export interface SeedStage {
  /** What extend-seeds calls it. */
  name: string;
  /** The connector whose seed it extends. */
  connectorId: string;
  /** The seeds of other connectors it reads and never changes; they are given to apply, and extend-seeds loads them too. */
  reads?: string[];
  apply(seed: SeedFile, others?: ReadonlyMap<string, SeedFile>): void;
}

/** In the order they are applied: a later stage may rely on an earlier one. */
export const SEED_STAGES: SeedStage[] = [erpAccountKeys, erpInvoices];

/** Every connector a stage extends or reads. */
export function stageConnectorIds(): string[] {
  return [...new Set(SEED_STAGES.flatMap((stage) => [stage.connectorId, ...(stage.reads ?? [])]))];
}

/** Runs every stage, in order, on the seed it names. A stage whose connector, or a connector it reads, has no seed here is an error, not a skip. */
export function applySeedStages(seeds: Map<string, SeedFile>): void {
  for (const stage of SEED_STAGES) {
    const seed = seeds.get(stage.connectorId);
    if (!seed) throw new Error(`Seed stage '${stage.name}' extends '${stage.connectorId}', which has no seed`);
    const others = new Map<string, SeedFile>();
    for (const id of stage.reads ?? []) {
      const read = seeds.get(id);
      if (!read) throw new Error(`Seed stage '${stage.name}' reads '${id}', which has no seed`);
      others.set(id, read);
    }
    stage.apply(seed, others);
  }
}
