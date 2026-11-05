import { ReleaseValidationPort, ReleaseValidationResult } from './release-validation.port';
import {
  publishBusinessPack,
  rollbackBusinessPack,
  PackRepository,
} from '@journeyax/business-pack';
import { CutoverRepository, connectToDatabase } from '@journeyax/database';
import { EvaluationRunner, type RunEvaluationOptions } from '@journeyax/pack-eval';
import { createPublicEvaluationStorage, type EvaluationStorageRequest } from './publication-evaluation-storage';

export type IsolatedStorageFactory = (request: EvaluationStorageRequest) => Promise<{
  db: any;
  client: any;
  cleanup: () => Promise<void> | void;
}>;

/**
 * A secret is named per environment ("tenant-secret://<tenant>/<environment>/<name>"). The gate stages the candidate as a test release, and
 * a test release carries test-environment secret names, so the staged copy is retargeted to the environment it is staged in; otherwise a
 * pack that names its production secrets could never pass the cross-environment rule here. Only the environment part changes: another
 * tenant, a different name or a malformed reference is left as it is and still fails. The real production publication is not touched.
 */
export function retargetSecretRefs<T>(value: T, environmentId: string): T {
  if (typeof value === 'string') {
    return value.replace(/^(tenant-secret:\/\/[^/\s]+\/)[^/\s]+(\/[^\s]+)$/, `$1${environmentId}$2`) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => retargetSecretRefs(entry, environmentId)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, retargetSecretRefs(entry, environmentId)])) as T;
  }
  return value;
}

export class PublicationGateValidator implements ReleaseValidationPort {
  constructor(
    private readonly storageFactory?: IsolatedStorageFactory,
    private readonly gatewayUrl?: string,
    private readonly inProcessFactory?: RunEvaluationOptions['inProcessFactory']
  ) {}

  private async getStorage(request: EvaluationStorageRequest): Promise<{
    db: any;
    client: any;
    cleanup: () => Promise<void> | void;
  }> {
    if (this.storageFactory) {
      return await this.storageFactory(request);
    }

    if (process.env.PUBLICATION_EVALUATION_STORAGE === 'public-source-memory') {
      if (process.env.NODE_ENV === 'production' || !['dev', 'test'].includes(process.env.COMMERCE_ENVIRONMENT || '') || process.env.PUBLICATION_EVALUATION_TENANT !== request.projectId) throw new Error('Public-source memory evaluation is limited to its explicitly configured local tenant and environment.');
      if (!process.env.MONGODB_URI || !process.env.RUNTIME_MONGODB_DB_NAME) throw new Error('The explicit public-source evaluation database is unavailable.');
      const { db } = await connectToDatabase(process.env.MONGODB_URI, process.env.RUNTIME_MONGODB_DB_NAME);
      return createPublicEvaluationStorage(db, request);
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
    let storage: Awaited<ReturnType<PublicationGateValidator['getStorage']>>;
    try {
      storage = await this.getStorage({ projectId, businessPack });
    } catch (storageErr: any) {
      // No isolated store means no pre-flight; the publication is refused cleanly rather than failing with an exception.
      return { passed: false, error: `Publication gate failed: ${storageErr.message}` };
    }
    const { db: isolatedDb, client: isolatedClient, cleanup } = storage;

    try {
      // 1. Stage baseline and candidate in isolated test storage with test environment
      const candidateVersion = businessPack.manifest?.version || `1.0.${version}`;
      const testCandidate = retargetSecretRefs({
        ...businessPack,
        manifest: {
          ...businessPack.manifest,
          environmentId: 'test',
          version: candidateVersion,
        },
        environmentId: 'test',
        version: candidateVersion,
      }, 'test');

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
                release: loadedActivePack,
                suitePath: undefined,
                suiteId: suite.suiteId,
                isolatedDb,
                inProcessFactory: this.inProcessFactory,
              });
              latestEvalResult = evalResult;
              if (!evalResult.passed || evalResult.suiteId !== suite.suiteId) {
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

      // A live activation follows the rollback as a numbered revision, back to the baseline release by its checksum.
      const followed = await cutoverRepo.getCutoverRecord(projectId, 'test');
      if (
        !followed || followed.status !== 'migrated' ||
        followed.approvedReleaseVersion !== baselineVersion || followed.approvedReleaseChecksum !== basePubResult.checksum ||
        followed.revision !== cutoverRecord.revision + 1
      ) {
        return {
          passed: false,
          error: `Pre-flight rollback proof failed: the activation did not follow the rollback (status=${followed?.status}, version=${followed?.approvedReleaseVersion}, rev=${followed?.revision})`,
        };
      }

      await cutoverRepo.promoteCutover(projectId, 'test' as any, {
        status: 'rollback',
        approvedReleaseVersion: baselineVersion,
        approvedReleaseChecksum: basePubResult.checksum,
        expectedRevision: followed.revision,
        approvedBy: 'publication-gate',
        notes: 'Pre-flight rollback CAS proof',
      });

      const postRollbackRecord = await cutoverRepo.getCutoverRecord(projectId, 'test');
      if (!postRollbackRecord || postRollbackRecord.status !== 'rollback' || postRollbackRecord.revision !== followed.revision + 1) {
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
