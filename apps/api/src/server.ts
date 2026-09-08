/**
 * The HTTP API.
 *
 * Phase 1.3 gives it only what the exit condition needs: it starts, reaches the database
 * and the shared volume, and says so. The upload and result endpoints in plan section 7.1
 * arrive with the phases that give them something to serve.
 */

import multipart from '@fastify/multipart';
import { loadConfig, type Config } from '@superjoin/config';
import { createDatabase, closeDatabase, type DatabaseHandle } from '@superjoin/db';
import {
  checkReadiness,
  createQueueClient,
  ensureStorage,
  limitsFromConfig,
  startQueue,
  type IngestionContext,
} from '@superjoin/pipeline';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';

import { registerCollectionRoutes } from './routes/collections.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerFactRoutes } from './routes/facts.ts';
import { registerRelationshipRoutes } from './routes/relationships.ts';
import { DEFAULT_STALLED_AFTER_MS, registerRunRoutes } from './routes/runs.ts';
import { registerSettingsRoutes } from './routes/settings.ts';

/**
 * Recorded on every run so an old result stays interpretable after the code moves on.
 * Bumped when a change alters what the pipeline produces, not on every commit.
 */
export const PIPELINE_VERSION = '0.1.0';

export interface Server {
  readonly app: FastifyInstance;
  readonly config: Config;
  readonly database: DatabaseHandle;
  readonly boss: PgBoss;
  close(): Promise<void>;
}

export interface ServerOptions {
  /**
   * Request logging. On by default; tests turn it off so assertions are not buried in
   * per-request output. An option rather than an environment check, so production code
   * carries no knowledge of the test runner.
   */
  readonly logger?: boolean;
}

export async function buildServer(
  config: Config = loadConfig(),
  options: ServerOptions = {},
): Promise<Server> {
  const database = createDatabase(config.databaseUrl);
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            // Every log line carries the service name, so API and worker output is
            // separable once both are running under Compose.
            base: { service: 'api' },
          },
  });

  // Created at startup rather than on first upload, so a misconfigured mount fails here
  // where it is legible instead of half-way through ingesting a document.
  await ensureStorage(config.storageDir);

  const maxUploadBytes = config.maxUploadMb * 1024 * 1024;
  await app.register(multipart, {
    // Enforced while the body streams in, so an oversized upload is cut off rather than
    // buffered to completion only to be rejected afterwards.
    limits: { fileSize: maxUploadBytes, files: 20 },
  });

  // The API sends jobs; only the worker consumes them. Starting pg-boss here also
  // ensures its schema exists, which it manages itself outside the Drizzle migrations.
  const boss = createQueueClient(config.databaseUrl);
  await startQueue(boss);

  const ingestion: IngestionContext = {
    database,
    boss,
    storageDir: config.storageDir,
    limits: limitsFromConfig(config.maxUploadMb, config.maxPdfPages),
    pipelineVersion: PIPELINE_VERSION,
  };

  await registerCollectionRoutes(app, { ingestion, maxUploadBytes });
  await registerRunRoutes(app, { ingestion, stalledAfterMs: DEFAULT_STALLED_AFTER_MS });
  await registerDocumentRoutes(app, { ingestion, stalledAfterMs: DEFAULT_STALLED_AFTER_MS });
  await registerFactRoutes(app, { ingestion });
  await registerRelationshipRoutes(app, { ingestion });

  /**
   * The provider toggle.
   *
   * The API reports which providers have credentials and records which one is selected;
   * it never calls a model itself and never returns a key. `configuredProviders` reads
   * the same config the worker does, so the two cannot disagree about what is available.
   */
  await registerSettingsRoutes(app, {
    ingestion,
    models: { bedrock: config.bedrockModelId, groq: config.groqModel },
  });

  /**
   * Liveness: the process is up and serving. Deliberately does no dependency work, so a
   * database outage does not make the container look dead and get restarted in a loop.
   */
  app.get('/health', async () => ({ status: 'ok', service: 'api' }));

  /**
   * Readiness: the process can actually do its job. Returns 503 when it cannot, so the
   * distinction is visible to a caller and not only in the body.
   */
  app.get('/ready', async (_request, reply) => {
    const readiness = await checkReadiness('api', database, config.storageDir);
    reply.code(readiness.ok ? 200 : 503);
    return readiness;
  });

  return {
    app,
    config,
    database,
    boss,
    async close() {
      await app.close();
      await boss.stop({ graceful: true, timeout: 5000 });
      await closeDatabase(database);
    },
  };
}
