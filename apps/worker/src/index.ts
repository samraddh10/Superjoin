/**
 * Processing worker.
 *
 * Consumes document jobs from pg-boss and runs them to a terminal stage. This is the only
 * process that calls OpenRouter and the only one that loads the local embedding model,
 * per the plan's service boundaries; the API holds neither.
 *
 * The full pipeline is registered here: parsing, the visual route, extraction,
 * normalization and comparison. A stage that cannot do its work does not fail the
 * document — a throttled chunk costs that chunk, an unavailable embedding model costs
 * semantic retrieval and not the exact channel — and every one of those degradations is
 * recorded against the run, so a document that finished with less than it should have
 * says so rather than looking complete.
 */

// Before anything reads configuration. Node does not load .env on its own.
import { loadConfig, loadDotEnvFile, requireOpenRouterKey } from '@superjoin/config';

loadDotEnvFile();
import { closeDatabase, createDatabase } from '@superjoin/db';

import { documents } from '@superjoin/db';
import {
  DOCUMENT_QUEUE,
  checkReadiness,
  createComparisonStage,
  createEmbeddingProvider,
  createExtractionStage,
  createModelClient,
  createNormalizationStage,
  createQueueClient,
  createVisualStage,
  ensureStorage,
  parsingStage,
  processDocumentJob,
  startQueue,
  type DocumentJob,
  type StageHandler,
} from '@superjoin/pipeline';
import { eq } from 'drizzle-orm';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const boss = createQueueClient(config.databaseUrl);

/** Structured, so worker output stays separable from the API's in one Compose log stream. */
function log(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: 'worker',
    message,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/**
 * The model client. Only the worker holds one, per the plan's service boundaries.
 *
 * Live OpenRouter access is the only mode there is, so a missing key stops the process
 * here rather than at the first document. Whether the key *works* is settled by the
 * first call; a run whose calls fail is reported failed, never completed on substituted
 * answers.
 */
const openRouterApiKey = ((): string => {
  try {
    return requireOpenRouterKey(config);
  } catch (error) {
    log('error', 'not configured', { detail: (error as Error).message });
    process.exit(1);
  }
})();

const modelClient = createModelClient({ ...config, openRouterApiKey });

/**
 * The embedding model, loaded lazily on first use.
 *
 * Only the worker holds one, and constructing it costs nothing: the package and its
 * model download are pulled in when the first claim is embedded, so a worker that never
 * reaches comparison never pays for them.
 */
const embeddings = createEmbeddingProvider(config);

/**
 * The ordered pipeline stages.
 *
 * Parsing reads the text layer; the visual stage re-reads the pages parsing marked as
 * structured; extraction asks what each chunk asserts and grounds every answer in the
 * stored text; normalization makes the surviving claims comparable; comparison retrieves
 * candidate pairs and explains each one. The order is the dependency order, and each
 * stage moves the run into its own stage name so a progress poll says where the work is.
 */
const STAGES: readonly StageHandler[] = [
  parsingStage,
  createVisualStage({
    client: modelClient,
    async documentHash(context) {
      const [row] = await context.database.db
        .select({ contentHash: documents.contentHash })
        .from(documents)
        .where(eq(documents.id, context.job.documentId))
        .limit(1);
      return row?.contentHash ?? '0'.repeat(64);
    },
  }),
  createExtractionStage({
    client: modelClient,
    tokenBudget: config.documentTokenBudget,
    concurrency: config.llmConcurrency,
  }),
  createNormalizationStage({ client: modelClient }),
  createComparisonStage({
    client: modelClient,
    embeddings,
    topK: config.candidateTopK,
  }),
];

let shuttingDown = false;

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', 'shutting down', { signal });
  try {
    // Graceful: an in-flight job is allowed to finish rather than being abandoned
    // mid-run, which would leave it to be reclaimed on expiry instead of completing.
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeDatabase(database);
  } catch (error) {
    log('error', 'shutdown failed', { error: (error as Error).message });
    process.exit(1);
  }
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

await ensureStorage(config.storageDir);

const readiness = await checkReadiness('worker', database, config.storageDir);

if (!readiness.ok) {
  // Exiting non-zero rather than idling. A worker that cannot reach its database or its
  // files will consume jobs and fail every one of them; being restarted is more useful
  // than a process that looks alive while being unable to do any work.
  log('error', 'not ready', {
    database: readiness.database.detail,
    storage: readiness.storage.detail,
  });
  await shutdown('startup', 1);
}

await startQueue(boss);

await boss.work<DocumentJob>(
  DOCUMENT_QUEUE,
  // One document at a time per worker. Concurrency is bounded by LLM_CONCURRENCY once
  // model calls exist; until then a single slot keeps ordering easy to reason about.
  { batchSize: 1 },
  async ([job]) => {
    if (job === undefined) return;

    const started = Date.now();
    log('info', 'processing', { runId: job.data.runId, documentId: job.data.documentId });

    try {
      const outcome = await processDocumentJob(
        { database, storageDir: config.storageDir, stages: STAGES },
        job.data,
      );
      if (outcome.status === 'abandoned') {
        // The run was deleted while the job waited. Logged rather than retried: there is
        // nothing left to process and nothing to write to.
        log('info', 'abandoned', { runId: outcome.runId, reason: outcome.reason });
      } else {
        log('info', 'finished', {
          runId: outcome.runId,
          stage: outcome.stage,
          durationMs: Date.now() - started,
        });
      }
    } catch (error) {
      // Rethrown so pg-boss applies the retry policy. The issue is already recorded
      // against the run, so the failure is visible even while the job waits to retry.
      log('error', 'job failed, will retry if attempts remain', {
        runId: job.data.runId,
        error: (error as Error).message,
      });
      throw error;
    }
  },
);

log('info', 'ready', {
  queue: DOCUMENT_QUEUE,
  stages: STAGES.length,
  storageRoot: readiness.storage.root,
  migrationsApplied: readiness.database.migrationsApplied,
  llmModel: config.llmModel,
  llmConcurrency: config.llmConcurrency,
  embeddingModel: config.embeddingModel,
  candidateTopK: config.candidateTopK,
});
