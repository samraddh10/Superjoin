/**
 * Processing run state: stage transitions, progress counters and recorded issues.
 *
 * All of it lives in Postgres, so progress survives an API or worker restart and is the
 * same answer whichever process is asked. Plan section 2.2 requires that; section 2.3
 * requires interrupted work to be recoverable rather than silently stuck.
 *
 * Every write here is idempotent or additive. A job that is retried re-enters these
 * functions, and none of them may double-count or corrupt a run that a previous attempt
 * partly advanced.
 */

import { eq, sql } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { processingIssues, processingRuns } from '@superjoin/db';

/** The stages a run moves through, in order. Mirrors the run_stage enum. */
export type RunStage =
  | 'queued'
  | 'parsing'
  | 'extracting'
  | 'normalizing'
  | 'comparing'
  | 'completed'
  | 'completed_with_issues'
  | 'failed';

/**
 * How a failure should be treated.
 *
 * Plan 2.3 requires transient provider failures to be told apart from an invalid PDF or
 * unsupported input: the first is worth retrying, the second never will be. Getting this
 * wrong in either direction is costly — retrying a permanent failure burns the retry
 * budget and delays the honest answer, while giving up on a rate limit loses work that
 * would have succeeded.
 */
export type FailureClass = 'transient' | 'permanent';

export interface FailureRecord {
  readonly stage: RunStage;
  /** Open vocabulary, so a new kind of failure needs no migration. */
  readonly failureKind: string;
  readonly failureClass: FailureClass;
  readonly message: string;
  readonly physicalPage?: number;
  readonly detail?: Record<string, unknown>;
}

/** Marks a run as started and moves it to its first working stage. */
export async function beginRun(db: Database, runId: string, stage: RunStage): Promise<void> {
  await db
    .update(processingRuns)
    .set({
      stage,
      startedAt: sql`coalesce(${processingRuns.startedAt}, now())`,
      heartbeatAt: new Date(),
      finishedAt: null,
    })
    .where(eq(processingRuns.id, runId));
}

/**
 * Moves a run to a stage and touches its heartbeat.
 *
 * The heartbeat is what separates a stalled run from a slow one. Without it, a run that
 * spends twenty minutes on a hundred-page document is indistinguishable from one whose
 * worker was killed.
 */
export async function enterStage(db: Database, runId: string, stage: RunStage): Promise<void> {
  await db
    .update(processingRuns)
    .set({ stage, heartbeatAt: new Date() })
    .where(eq(processingRuns.id, runId));
}

/** Touches the heartbeat without changing stage, for use inside a long stage. */
export async function heartbeat(db: Database, runId: string): Promise<void> {
  await db
    .update(processingRuns)
    .set({ heartbeatAt: new Date() })
    .where(eq(processingRuns.id, runId));
}

export interface ProgressUpdate {
  readonly pagesProcessed?: number;
  readonly chunksTotal?: number;
  readonly chunksProcessed?: number;
  readonly claimsExtracted?: number;
  readonly claimsAccepted?: number;
  readonly relationshipsCreated?: number;
}

/**
 * Sets progress counters to absolute values.
 *
 * Absolute rather than incremental, deliberately. A retried job reprocesses from the
 * beginning, and an increment would add its second pass to its first, reporting more
 * pages processed than the document contains. Setting the count means a replay converges
 * on the truth instead of drifting from it.
 */
export async function recordProgress(
  db: Database,
  runId: string,
  progress: ProgressUpdate,
): Promise<void> {
  const values: Record<string, unknown> = { heartbeatAt: new Date() };
  for (const [key, value] of Object.entries(progress)) {
    if (value !== undefined) values[key] = value;
  }

  await db.update(processingRuns).set(values).where(eq(processingRuns.id, runId));
}

/**
 * Records an issue against a run.
 *
 * Issues are never deleted. Acceptance requires a real observed failure to be shown with
 * how the system handled it, and this table is that record. A repeated failure of the
 * same kind at the same place increments its attempt count rather than adding a row, so
 * five retries of one page read as one problem tried five times.
 */
export async function recordIssue(
  db: Database,
  runId: string,
  failure: FailureRecord,
): Promise<string> {
  const existing = await db
    .select({ id: processingIssues.id, attemptCount: processingIssues.attemptCount })
    .from(processingIssues)
    .where(
      sql`${processingIssues.runId} = ${runId}
        and ${processingIssues.failureKind} = ${failure.failureKind}
        and ${processingIssues.physicalPage} is not distinct from ${failure.physicalPage ?? null}`,
    )
    .limit(1);

  const first = existing[0];
  if (first !== undefined) {
    await db
      .update(processingIssues)
      .set({
        attemptCount: first.attemptCount + 1,
        lastAttemptAt: new Date(),
        message: failure.message,
        resolution: 'retrying',
      })
      .where(eq(processingIssues.id, first.id));
    return first.id;
  }

  const [created] = await db
    .insert(processingIssues)
    .values({
      runId,
      stage: failure.stage,
      failureKind: failure.failureKind,
      isTransient: failure.failureClass === 'transient',
      message: failure.message,
      lastAttemptAt: new Date(),
      ...(failure.physicalPage !== undefined ? { physicalPage: failure.physicalPage } : {}),
      ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
    })
    .returning({ id: processingIssues.id });

  return created!.id;
}

/**
 * Marks issues from *earlier* attempts as resolved, once a later attempt succeeds.
 *
 * The cutoff is the point of this function. Resolving every open issue would also clear
 * the ones recorded during the successful pass itself — pages that were throttled or
 * unreadable while the rest of the document processed fine — and the run would then
 * report `completed` rather than `completed_with_issues`. That is partial failure hidden
 * behind a green status, which is precisely what the stage distinction exists to prevent.
 *
 * Issues raised during this attempt are left open, because nothing has fixed them.
 */
export async function resolveOpenIssues(
  db: Database,
  runId: string,
  note: string,
  attemptStartedAt: Date,
): Promise<void> {
  await db
    .update(processingIssues)
    .set({ resolution: 'resolved', resolutionNote: note })
    .where(
      // The cutoff is when the issue was last *seen*, not when it was first recorded.
      //
      // recordIssue deduplicates on (run, kind, page) and updates the existing row rather
      // than inserting a second one, so a failure that recurs keeps its original
      // createdAt. Cutting on createdAt therefore resolved issues this very attempt had
      // just re-recorded, and the run then finished `completed` with nothing extracted:
      // every chunk throttled, every issue marked "a later attempt completed this stage",
      // and no unresolved issue left for finishRun to notice.
      sql`${processingIssues.runId} = ${runId}
        and ${processingIssues.resolution} in ('open', 'retrying')
        and coalesce(${processingIssues.lastAttemptAt}, ${processingIssues.createdAt}) < ${attemptStartedAt}`,
    );
}

/**
 * Finishes a run.
 *
 * `completed_with_issues` rather than `completed` whenever anything was recorded against
 * the run. The distinction is the point: a document that produced usable output *and*
 * failed on four pages is not the same as one that succeeded, and collapsing them would
 * hide partial failure behind a green status.
 */
export async function finishRun(
  db: Database,
  runId: string,
  outcome: { readonly failed: boolean; readonly errorSummary?: string },
): Promise<RunStage> {
  const [counts] = await db
    .select({
      unresolved: sql<number>`count(*) filter (where ${processingIssues.resolution} in ('open', 'retrying', 'abandoned'))`,
    })
    .from(processingIssues)
    .where(eq(processingIssues.runId, runId));

  const hasIssues = Number(counts?.unresolved ?? 0) > 0;
  const stage: RunStage = outcome.failed
    ? 'failed'
    : hasIssues
      ? 'completed_with_issues'
      : 'completed';

  await db
    .update(processingRuns)
    .set({
      stage,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
      errorSummary: outcome.errorSummary ?? null,
    })
    .where(eq(processingRuns.id, runId));

  return stage;
}

/**
 * Marks an issue abandoned once retries are exhausted.
 *
 * Kept rather than deleted: a failure the system could not recover from is precisely the
 * evidence the observed-failure requirement asks for.
 */
export async function abandonIssue(db: Database, issueId: string, note: string): Promise<void> {
  await db
    .update(processingIssues)
    .set({ resolution: 'abandoned', resolutionNote: note })
    .where(eq(processingIssues.id, issueId));
}
