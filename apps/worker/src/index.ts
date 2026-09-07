/**
 * Processing worker.
 *
 * Consumes document jobs from pg-boss and runs them to a terminal stage. This is the only
 * process that will call OpenRouter, per the plan's service boundaries; the API never holds
 * the model key.
 *
 * The pipeline stages themselves arrive in Phases 3 to 6. Until then the worker registers
 * no stages, which means a job verifies the document and its stored file and then
 * completes. That is deliberately visible rather than disguised: a run that completes
 * having extracted nothing reports zero claims, and the plan's own progress counters say
 * so.
 */

import { loadConfig } from '@superjoin/config';
import { closeDatabase, createDatabase } from '@superjoin/db';
import {
  DOCUMENT_QUEUE,
  checkReadiness,
  createQueueClient,
  ensureStorage,
  processDocumentJob,
  startQueue,
  type DocumentJob,
  type StageHandler,
} from '@superjoin/pipeline';

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
 * The ordered pipeline stages.
 *
 * Empty until Phase 3.1 adds parsing. Kept as an explicit, named empty list rather than
 * an implicit absence, so the gap is legible in the code that runs jobs.
 */
const STAGES: readonly StageHandler[] = [];

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

const readiness = await checkReadiness('worker', database, config.storageDir, config.modelMode);

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
  modelMode: config.modelMode,
  llmModel: config.llmModel,
  llmConcurrency: config.llmConcurrency,
});
