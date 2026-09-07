/**
 * The document job handler.
 *
 * Phase 2 delivers the durable machinery around processing, not the processing itself:
 * claiming a run, moving it through stages, keeping progress in Postgres, classifying
 * failures and recording them. Parsing, extraction, normalization and comparison are
 * Phases 3 to 6, and are reached through the `stages` hook so they can be added without
 * touching any of this.
 *
 * Idempotence is the constraint throughout. pg-boss guarantees at-least-once delivery,
 * so this function must be safe to run twice over the same run: counters are set to
 * absolute values, issues increment an attempt count rather than accumulating rows, and
 * nothing here assumes it is the first attempt.
 */

import { eq } from 'drizzle-orm';

import type { DatabaseHandle } from '@superjoin/db';
import { documents, processingRuns } from '@superjoin/db';

import type { DocumentJob } from './queue.ts';
import {
  beginRun,
  enterStage,
  finishRun,
  recordIssue,
  resolveOpenIssues,
  type FailureClass,
  type RunStage,
} from './run-state.ts';
import { objectExists } from './storage.ts';

/**
 * An error carrying its own retry classification.
 *
 * Thrown by stage implementations so the decision is made where the cause is known,
 * rather than being guessed from a message here.
 */
export class ProcessingError extends Error {
  override readonly name = 'ProcessingError';

  constructor(
    message: string,
    readonly failureKind: string,
    readonly failureClass: FailureClass,
    readonly stage: RunStage,
    readonly physicalPage?: number,
  ) {
    super(message);
  }
}

/**
 * Classifies an error that did not arrive as a ProcessingError.
 *
 * Anything unrecognised is treated as transient. That is the safer default: retrying a
 * permanent failure wastes a bounded number of attempts and then reports honestly, while
 * treating a transient failure as permanent discards work that would have succeeded and
 * leaves a document wrongly marked failed.
 */
export function classifyFailure(error: unknown): {
  failureKind: string;
  failureClass: FailureClass;
} {
  if (error instanceof ProcessingError) {
    return { failureKind: error.failureKind, failureClass: error.failureClass };
  }

  const code = (error as { code?: string }).code ?? '';
  const message = (error as { message?: string }).message ?? '';

  // Provider rate limiting and timeouts are the transient cases worth naming explicitly,
  // since plan 2.3 asks for rate-limit responses to be respected rather than retried
  // blindly. The backoff itself lives in the queue policy.
  if (/rate.?limit|429|too many requests/i.test(message)) {
    return { failureKind: 'provider_rate_limited', failureClass: 'transient' };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timeout/i.test(message)) {
    return { failureKind: 'provider_timeout', failureClass: 'transient' };
  }
  if (code === 'ECONNREFUSED') {
    return { failureKind: 'dependency_unavailable', failureClass: 'transient' };
  }

  return { failureKind: 'unexpected_error', failureClass: 'transient' };
}

/** A processing stage. Phases 3 to 6 supply these. */
export interface StageHandler {
  readonly stage: RunStage;
  run(context: ProcessingContext): Promise<void>;
}

export interface ProcessingContext {
  readonly database: DatabaseHandle;
  readonly storageDir: string;
  readonly job: DocumentJob;
  /** Where the document's original bytes live, resolved from the document row. */
  readonly storageKey: string;
  readonly pageCount: number;
}

export interface ProcessorOptions {
  readonly database: DatabaseHandle;
  readonly storageDir: string;
  /** Ordered stages. Empty until Phase 3 supplies the first one. */
  readonly stages: readonly StageHandler[];
}

/**
 * What became of a job.
 *
 * `abandoned` is not a failure: the run it referred to no longer exists, so there is
 * nothing to fail and nothing to retry. Reporting it as `failed` would invent a run to
 * blame, and writing to one is impossible anyway.
 */
export type ProcessingOutcome =
  | { readonly runId: string; readonly status: 'finished'; readonly stage: RunStage }
  | { readonly runId: string; readonly status: 'abandoned'; readonly reason: 'run_deleted' };

/**
 * Runs one document job to a terminal stage.
 *
 * Throws when the failure is worth retrying, so pg-boss re-queues under the backoff
 * policy. Returns normally when the run reached a terminal stage, including `failed`:
 * a permanent failure is a finished run, not a job to try again.
 */
export async function processDocumentJob(
  options: ProcessorOptions,
  job: DocumentJob,
): Promise<ProcessingOutcome> {
  const { db } = options.database;

  // The run is checked first, and not only for the document's sake. Deleting a document
  // cascades its runs away, so a job can outlive both. Without this, recording the
  // failure violates a foreign key, the job throws, and pg-boss retries it forever
  // against a run that will never come back.
  const [run] = await db
    .select({ id: processingRuns.id })
    .from(processingRuns)
    .where(eq(processingRuns.id, job.runId))
    .limit(1);

  if (run === undefined) {
    return { runId: job.runId, status: 'abandoned', reason: 'run_deleted' };
  }

  const [document] = await db
    .select({
      storageKey: documents.storageKey,
      pageCount: documents.pageCount,
    })
    .from(documents)
    .where(eq(documents.id, job.documentId))
    .limit(1);

  if (document === undefined) {
    // The document was removed while the job waited. Nothing to process and nothing to
    // retry; finishing the run is more honest than leaving it queued forever.
    await recordIssue(db, job.runId, {
      stage: 'parsing',
      failureKind: 'document_missing',
      failureClass: 'permanent',
      message: `document ${job.documentId} no longer exists`,
    });
    const stage = await finishRun(db, job.runId, {
      failed: true,
      errorSummary: 'the document row was deleted before processing began',
    });
    return { runId: job.runId, status: 'finished', stage };
  }

  await beginRun(db, job.runId, 'parsing');

  // Fixed before any stage runs, so issues raised by this attempt can be told from those
  // left by earlier ones. Only the earlier ones may be resolved on success.
  const attemptStartedAt = new Date();

  // A stored file that is gone is permanent: no retry will restore it, and the run must
  // say so rather than failing repeatedly against the same absence.
  if (!(await objectExists(options.storageDir, document.storageKey))) {
    await recordIssue(db, job.runId, {
      stage: 'parsing',
      failureKind: 'stored_file_missing',
      failureClass: 'permanent',
      message: `no stored object at ${document.storageKey}`,
    });
    const stage = await finishRun(db, job.runId, {
      failed: true,
      errorSummary: 'the uploaded file is missing from storage',
    });
    return { runId: job.runId, status: 'finished', stage };
  }

  const context: ProcessingContext = {
    database: options.database,
    storageDir: options.storageDir,
    job,
    storageKey: document.storageKey,
    pageCount: document.pageCount ?? 0,
  };

  // A job may ask for a subset. Filtering here rather than at the call site keeps the
  // stage list one thing the worker builds once, and keeps the run's own bookkeeping —
  // stage transitions, issues, finishRun — identical either way.
  const stages =
    job.stages === undefined
      ? options.stages
      : options.stages.filter((handler) => job.stages!.includes(handler.stage));

  for (const handler of stages) {
    try {
      // The run says which stage it is in before the stage runs, so a progress poll
      // during a long extraction reports extraction rather than whatever ran before it.
      await enterStage(db, job.runId, handler.stage);
      await handler.run(context);
    } catch (error) {
      const { failureKind, failureClass } = classifyFailure(error);
      await recordIssue(db, job.runId, {
        stage: handler.stage,
        failureKind,
        failureClass,
        message: (error as Error).message,
      });

      if (failureClass === 'transient') {
        // Left non-terminal on purpose: pg-boss owns the retry, and marking the run
        // failed here would contradict the job that is about to run again.
        throw error;
      }

      const stage = await finishRun(db, job.runId, {
        failed: true,
        errorSummary: `${failureKind}: ${(error as Error).message}`,
      });
      return { runId: job.runId, status: 'finished', stage };
    }
  }

  // Every stage returned. Problems left by *earlier* attempts are no longer open, so
  // they are resolved; anything this attempt recorded stays open, because nothing fixed
  // it and the run should say so.
  await resolveOpenIssues(
    db,
    job.runId,
    'a later attempt completed this stage',
    attemptStartedAt,
  );

  const stage = await finishRun(db, job.runId, { failed: false });
  return { runId: job.runId, status: 'finished', stage };
}
