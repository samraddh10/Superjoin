/**
 * The HTTP API.
 *
 * Phase 1.3 gives it only what the exit condition needs: it starts, reaches the database
 * and the shared volume, and says so. The upload and result endpoints in plan section 7.1
 * arrive with the phases that give them something to serve.
 */

import { loadConfig, type Config } from '@superjoin/config';
import { createDatabase, closeDatabase, type DatabaseHandle } from '@superjoin/db';
import { checkReadiness, ensureStorage } from '@superjoin/pipeline';
import Fastify, { type FastifyInstance } from 'fastify';

export interface Server {
  readonly app: FastifyInstance;
  readonly config: Config;
  readonly database: DatabaseHandle;
  close(): Promise<void>;
}

export async function buildServer(config: Config = loadConfig()): Promise<Server> {
  const database = createDatabase(config.databaseUrl);
  const app = Fastify({
    logger: {
      level: 'info',
      // Every log line carries the service name, so API and worker output is separable
      // once both are running under Compose.
      base: { service: 'api' },
    },
  });

  // Created at startup rather than on first upload, so a misconfigured mount fails here
  // where it is legible instead of half-way through ingesting a document.
  await ensureStorage(config.storageDir);

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
    const readiness = await checkReadiness('api', database, config.storageDir, config.modelMode);
    reply.code(readiness.ok ? 200 : 503);
    return readiness;
  });

  return {
    app,
    config,
    database,
    async close() {
      await app.close();
      await closeDatabase(database);
    },
  };
}
