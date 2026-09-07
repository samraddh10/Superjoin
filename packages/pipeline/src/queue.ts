/**
 * Durable job queue.
 *
 * pg-boss keeps jobs in the same Postgres the application uses, which is what makes the
 * single-transaction enqueue in plan section 2.1 possible: the document row, the
 * processing run and the job all commit together or not at all. There is no window in
 * which a document exists but nothing will ever process it, and no outbox to reconcile.
 *
 * pg-boss owns and upgrades its own schema, so it is deliberately outside the Drizzle
 * migrations.
 */

import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';

/** The only queue for now. Parsing, extraction and comparison run as stages of one job. */
export const DOCUMENT_QUEUE = 'process-document';

/** What a worker needs to process a document. Everything else is read from the database. */
export interface DocumentJob {
  readonly runId: string;
  readonly documentId: string;
  readonly collectionId: string;
  /**
   * Stages to run, when only some of them should be.
   *
   * Absent means the whole pipeline, which is what an upload wants. Naming a subset
   * exists because the stages compete for one exhaustible resource: on a metered model,
   * extraction spends the day's quota before comparison is reached, and re-running a
   * document to get relationships spends it again on claims that are already stored.
   * Re-comparing an already-extracted collection is the case this serves.
   */
  readonly stages?: readonly string[];
}

export interface QueuePolicy {
  /** Attempts after the first. Sourced from PROVIDER_MAX_RETRIES. */
  readonly retryLimit: number;
  /** Seconds before the first retry; later attempts back off exponentially. */
  readonly retryDelaySeconds: number;
  /** Ceiling on the backoff, so a long-lived failure does not push the next try days out. */
  readonly retryDelayMaxSeconds: number;
  /**
   * How long a job may stay active before pg-boss reclaims it.
   *
   * This is the stalled-worker recovery plan 2.3 asks to be made explicit: a worker
   * killed mid-job never marks it complete, and the job returns to the queue when this
   * expires rather than being lost.
   */
  readonly expireInSeconds: number;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  retryLimit: 5,
  retryDelaySeconds: 5,
  retryDelayMaxSeconds: 300,
  // Generous: a 100-page document with visual-route pages is legitimately slow, and
  // reclaiming a job that is still running would duplicate work rather than recover it.
  expireInSeconds: 3600,
};

export function createQueueClient(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    // The API only sends and the worker only consumes; neither needs a large pool.
    max: 4,
  });
}

/**
 * Starts pg-boss and ensures the queue exists.
 *
 * Both the API and the worker call this. pg-boss guards its own schema installation, so
 * two processes starting at once is safe, and `createQueue` is idempotent.
 */
export async function startQueue(
  boss: PgBoss,
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY,
): Promise<void> {
  await boss.start();
  await boss.createQueue(DOCUMENT_QUEUE, {
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: policy.retryDelayMaxSeconds,
    expireInSeconds: policy.expireInSeconds,
  });
}

/** Anything that can execute Drizzle SQL: the pool wrapper or a transaction inside it. */
export interface DrizzleExecutor {
  execute(query: unknown): Promise<{ rows: unknown[] } | { rows: unknown[] }[] | unknown[]>;
}

/**
 * Enqueues a document job on the caller's transaction.
 *
 * The `db` option routes pg-boss's insert through the same transaction as the document
 * and run rows. If the caller rolls back, the job disappears with them.
 *
 * `singletonKey` is the document id, so a second enqueue for a document already waiting
 * is refused by pg-boss rather than creating a duplicate run. That is one half of the
 * duplicate protection plan 2.3 asks for; the database constraints are the other.
 */
export async function enqueueDocumentJob(
  boss: PgBoss,
  tx: DrizzleExecutor,
  job: DocumentJob,
): Promise<string | null> {
  return boss.send(DOCUMENT_QUEUE, job, {
    db: fromDrizzle(tx, sql as never),
    singletonKey: job.documentId,
  });
}
