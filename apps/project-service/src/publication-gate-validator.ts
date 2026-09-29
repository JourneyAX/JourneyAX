import { ReleaseValidationPort, ReleaseValidationResult } from './release-validation.port';
import {
  publishBusinessPack,
  rollbackBusinessPack,
  PackRepository,
} from '@journeyax/business-pack';
import { CutoverRepository, connectToDatabase } from '@journeyax/database';
import { EvaluationRunner } from '@journeyax/pack-eval';

export type IsolatedStorageFactory = () => Promise<{
  db: any;
  client: any;
  cleanup: () => Promise<void> | void;
}>;

export class PublicationGateValidator implements ReleaseValidationPort {
  constructor(
    private readonly storageFactory?: IsolatedStorageFactory,
    private readonly gatewayUrl?: string
  ) {}

  private async getStorage(): Promise<{
    db: any;
    client: any;
    cleanup: () => Promise<void> | void;
  }> {
    if (this.storageFactory) {
      return await this.storageFactory();
    }

    const testUri = process.env.TEST_MONGODB_URI;
    if (testUri) {
      if (process.env.MONGODB_URI && testUri === process.env.MONGODB_URI) {
        throw new Error(
          '[PublicationGateValidator] TEST_MONGODB_URI matches production MONGODB_URI. Destructive publication validation requires an isolated test database.'
        );
      }
      const dbName = `journeyx_gate_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const { client, db } = await connectToDatabase(testUri, dbName);
      return {
        db,
        client,
        cleanup: async () => {
          try {
            await db.dropDatabase();
          } catch {
            // ignore cleanup errors
          }
        },
      };
    }

    throw new Error(
      '[PublicationGateValidator] Isolated test storage required for publication validation. Provide storageFactory or set TEST_MONGODB_URI. Never fall back to production MONGODB_URI.'
    );
  }

  async validateRelease(
    projectId: string,
    businessPack: any,
    version: string | number
  ): Promise<ReleaseValidationResult> {
    const { db: isolatedDb, client: isolatedClient, cleanup } = await this.getStorage();

    try {
      // 1. Stage baseline and candidate in isolated test storage with test environment
      const candidateVersion = businessPack.manifest?.version || `1.0.${version}`;
      const testCandidate = {
        ...businessPack,
        manifest: {
          ...businessPack.manifest,
          environmentId: 'test',
          version: candidateVersion,
        },
        environmentId: 'test',
        version: candidateVersion,
      };

      const baselineVersion = '0.9.0';
      const baselinePack = {
        ...testCandidate,
        manifest: {
          ...testCandidate.manifest,
          version: baselineVersion,
        },
        version: baselineVersion,
      };

      const basePubResult = await publishBusinessPack(isolatedDb, baselinePack, {
        publishedBy: 'publication-gate',
        notes: `Baseline staging for rollback proof`,
      });

      // 2. Publish candidate through real repository API with checksum verification
      const pubResult = await publishBusinessPack(isolatedDb, testCandidate, {
        publishedBy: 'publication-gate',
        notes: `Pre-flight staging verification for ${projectId}`,
      });
      const candidateChecksum = pubResult.checksum;

      const pointer = await isolatedDb.collection('business_pack_pointers').findOne({
        tenantId: projectId,
        environmentId: 'test',
      });
      if (!pointer || pointer.checksum !== candidateChecksum) {
        return {
          passed: false,
          error: `Staging pointer checksum mismatch: expected ${candidateChecksum}, got ${pointer?.checksum}`,
        };
      }

      // 3. Verify loading through the actual PackRepository from isolated DB
      const packRepo = new PackRepository('/non/existent/dev/dir', isolatedDb);
      const loadedActivePack = await packRepo.loadActivePack(projectId, 'test');
      if (!loadedActivePack || loadedActivePack.manifest.tenantId !== projectId) {
        return {
          passed: false,
          error: `PackRepository failed to load staged candidate from isolated storage for ${projectId}`,
        };
      }

      // 4. Activate through real CutoverRepository with CAS revision control
      const cutoverRepo = new CutoverRepository(async () => ({ db: isolatedDb, client: isolatedClient }));
      await cutoverRepo.promoteCutover(projectId, 'test' as any, {
        status: 'migrated',
        approvedReleaseVersion: candidateVersion,
        approvedReleaseChecksum: candidateChecksum,
        expectedRevision: 0,
        approvedBy: 'publication-gate',
        notes: 'Pre-flight cutover CAS validation',
      });

      const cutoverRecord = await cutoverRepo.getCutoverRecord(projectId, 'test');
      if (!cutoverRecord || cutoverRecord.status !== 'migrated' || cutoverRecord.revision !== 1) {
        return {
          passed: false,
          error: `Staging cutover CAS activation failed: status=${cutoverRecord?.status}, rev=${cutoverRecord?.revision}`,
        };
      }

      // 5. Execute candidate through API gateway HTTP/SSE path if configured or blocking evaluations
      let latestEvalResult: any = null;
      if (businessPack.evaluations && businessPack.evaluations.length > 0) {
        const blockingSuites = businessPack.evaluations.filter(
          (suite: any) => suite.blockingOnPublish !== false
        );
        if (blockingSuites.length > 0) {
          const evalMode = this.gatewayUrl ? 'http' : 'in_process';
          const evalRunner = new EvaluationRunner(this.gatewayUrl);

          for (const suite of blockingSuites) {
            try {
              const evalResult = await evalRunner.runSuite({
                tenantId: projectId,
                environmentId: 'test',
                mode: evalMode,
                release: testCandidate as any,
                suitePath: undefined,
                isolatedDb,
              });
              latestEvalResult = evalResult;
              if (!evalResult.passed) {
                return {
                  passed: false,
                  latestEvalSuiteResult: evalResult,
                  error: `Evaluation suite '${evalResult.suiteId}' failed ${evalResult.failedScenarios} scenario(s)`,
                };
              }
            } catch (evalErr: any) {
              return {
                passed: false,
                error: `Evaluation gate execution failure: ${evalErr.message}`,
              };
            }
          }
        }
      }

      // 6. Prove rollback through repository APIs and CAS verification
      await rollbackBusinessPack(isolatedDb, projectId, 'test' as any, {
        rolledBackBy: 'publication-gate',
        reason: 'Pre-flight rollback proof',
      });

      await cutoverRepo.promoteCutover(projectId, 'test' as any, {
        status: 'rollback',
        approvedReleaseVersion: baselineVersion,
        approvedReleaseChecksum: basePubResult.checksum,
        expectedRevision: 1,
        approvedBy: 'publication-gate',
        notes: 'Pre-flight rollback CAS proof',
      });

      const postRollbackRecord = await cutoverRepo.getCutoverRecord(projectId, 'test');
      if (!postRollbackRecord || postRollbackRecord.status !== 'rollback' || postRollbackRecord.revision !== 2) {
        return {
          passed: false,
          error: `Pre-flight rollback proof failed: status=${postRollbackRecord?.status}, rev=${postRollbackRecord?.revision}`,
        };
      }

      return {
        passed: true,
        latestEvalSuiteResult: latestEvalResult,
      };
    } catch (gateErr: any) {
      return {
        passed: false,
        error: `Publication gate failed: ${gateErr.message}`,
      };
    } finally {
      await cleanup();
    }
  }
}
