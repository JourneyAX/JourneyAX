import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { loadProjectSeeds, resolveSeedDirectory } from '../src/seed-loader';
import { ProjectService } from '../src/project.service';

const suite = createSuite('project-service: seed data is opt-in JSON');

async function main() {
  await suite.test('no seed data is loaded unless explicitly enabled', () => {
    assert.equal(resolveSeedDirectory({}), undefined);
    assert.deepEqual(loadProjectSeeds({}), { projects: [], rules: [] });
    const service: any = new ProjectService();
    assert.deepEqual(service.SEEDS, []);
  });

  await suite.test('bundled development seeds load only when PROJECT_SEED_ENABLED=true', () => {
    const seeds = loadProjectSeeds({ PROJECT_SEED_ENABLED: 'true' } as any);
    assert.ok(seeds.projects.length > 0 && seeds.rules.length > 0);
    assert.ok(seeds.projects.every((project) => typeof project.projectId === 'string'));
  });

  await suite.test('a custom directory is read and validated', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'seeds-'));
    writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([{ projectId: 'acme', name: 'Acme' }]));
    const seeds = loadProjectSeeds({ PROJECT_SEED_DIR: dir } as any);
    assert.deepEqual(seeds.projects.map((p) => p.projectId), ['acme']);
    assert.deepEqual(seeds.rules, []);
    writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([{ name: 'no id' }]));
    assert.throws(() => loadProjectSeeds({ PROJECT_SEED_DIR: dir } as any), /needs a string 'projectId'/);
    writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ not: 'an array' }));
    assert.throws(() => loadProjectSeeds({ PROJECT_SEED_DIR: dir } as any), /must contain a JSON array/);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
