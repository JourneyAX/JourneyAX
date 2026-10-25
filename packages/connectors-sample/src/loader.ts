import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Collections } from './engine';
import type { ConnectorFile, Rec, SeedFile } from './types';

export const DEFAULT_CONNECTORS_DIR = path.resolve(__dirname, '..', 'connectors');

export interface LoadedConnector {
  definition: ConnectorFile;
  seed: SeedFile;
}

export interface Manifest {
  /** The tenant the seeds were built for. */
  seedTenantId: string;
  connectors: string[];
}

export function readManifest(dir: string = DEFAULT_CONNECTORS_DIR): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

export function loadConnectors(dir: string = DEFAULT_CONNECTORS_DIR): Map<string, LoadedConnector> {
  const manifest = readManifest(dir);
  const out = new Map<string, LoadedConnector>();
  for (const id of manifest.connectors) {
    const folder = path.join(dir, id);
    if (!existsSync(path.join(folder, 'connector.json'))) throw new Error(`Connector '${id}' has no connector.json`);
    out.set(id, {
      definition: JSON.parse(readFileSync(path.join(folder, 'connector.json'), 'utf8')),
      seed: JSON.parse(readFileSync(path.join(folder, 'seed.json'), 'utf8')),
    });
  }
  return out;
}

export function connectorFolders(dir: string = DEFAULT_CONNECTORS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** One tenant's copy of a connector's records: the seed (copied, so nothing can change the seed itself) plus what tools created. */
export class TenantCollections implements Collections {
  private readonly records = new Map<string, Rec[]>();

  constructor(seed: SeedFile) {
    for (const [name, rows] of Object.entries(seed.collections)) this.records.set(name, structuredClone(rows));
  }

  all(collection: string): Rec[] {
    return this.records.get(collection) ?? [];
  }

  add(collection: string, record: Rec): void {
    const rows = this.records.get(collection);
    if (rows) rows.push(record); else this.records.set(collection, [record]);
  }
}
