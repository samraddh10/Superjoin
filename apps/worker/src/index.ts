/**
 * Processing worker.
 *
 * Phase 1.3 gives it only the exit condition: a separate process that reaches the same
 * database and the same files as the API. Durable job consumption through pg-boss is
 * Phase 2; parsing and extraction are Phases 3 and 4.
 *
 * This is the only process that will call Gemini, per the plan's service boundaries. The
 * API never holds the model key.
 */

import { loadConfig } from '@superjoin/config';
import { closeDatabase, createDatabase } from '@superjoin/db';
import { checkReadiness, ensureStorage } from '@superjoin/pipeline';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);

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

let shuttingDown = false;

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', 'shutting down', { signal });
  try {
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
  // files will consume jobs and fail every one of them; Compose restarting it is more
  // useful than a process that looks alive while being unable to do any work.
  log('error', 'not ready', {
    database: readiness.database.detail,
    storage: readiness.storage.detail,
  });
  await shutdown('startup', 1);
}

log('info', 'ready', {
  storageRoot: readiness.storage.root,
  migrationsApplied: readiness.database.migrationsApplied,
  modelMode: config.modelMode,
  llmModel: config.llmModel,
  llmConcurrency: config.llmConcurrency,
});

/**
 * Idles until stopped.
 *
 * There is no queue to consume yet, and the worker's purpose in this phase is to hold a
 * live connection to the shared database and volume so the exit condition can be
 * observed. Phase 2 replaces this with a pg-boss subscription.
 */
setInterval(() => {
  // Kept deliberately quiet: a heartbeat log every interval would bury the API's output.
}, 60_000);
