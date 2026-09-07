/**
 * Processing machinery: stage transitions, failure classification and recovery.
 *
 * These run against the real database because the properties are about persisted state:
 * whether a retried job double-counts, whether a permanent failure stops retrying, and
 * whether a run that succeeds on a later attempt still reports the earlier problem.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  collections,
  createDatabase,
  documents,
  processingIssues,
  processingRuns,
} from '@superjoin/db';
import type { DatabaseHandle } from '@superjoin/db';

import {
  ProcessingError,
  classifyFailure,
  processDocumentJob,
  type StageHandler,
} from './processor.ts';
import { heartbeat, recordIssue, recordProgress } from './run-state.ts';
import { contentHash, documentStorageKey, writeObject } from './storage.ts';

const THREE_PAGES = 'tests/fixtures/three-blank-pages.pdf';
const connectionString =
  process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin';

const database: DatabaseHandle = createDatabase(connectionString);
const reachable = await database.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) await closeDatabase(database);

let storageDir: string;

beforeAll(async () => {
  if (!reachable) return;
  storageDir = await mkdtemp(join(tmpdir(), 'superjoin-proc-'));
});

afterAll(async () => {
  if (!reachable) return;
  await closeDatabase(database);
  await rm(storageDir, { recursive: true, force: true });
});

/** Creates a collection, a document with its file on disk, and a queued run. */
async function seedRun(options: { withFile?: boolean } = {}) {
  const { db } = database;
  const [collection] = await db
    .insert(collections)
    .values({ name: `proc-${randomUUID()}` })
    .returning({ id: collections.id });

  const bytes = new Uint8Array(await readFile(THREE_PAGES));
  const marker = new TextEncoder().encode(`\n% ${randomUUID()}\n`);
  const unique = new Uint8Array(bytes.byteLength + marker.byteLength);
  unique.set(bytes, 0);
  unique.set(marker, bytes.byteLength);

  const hash = contentHash(unique);
  const storageKey = documentStorageKey(hash);
  if (options.withFile !== false) {
    await writeObject(storageDir, storageKey, unique);
  }

  const [document] = await db
    .insert(documents)
    .values({
      collectionId: collection!.id,
      filename: 'seed.pdf',
      contentHash: hash,
      storageKey,
      byteSize: unique.byteLength,
      pageCount: 3,
    })
    .returning({ id: documents.id });

  const [run] = await db
    .insert(processingRuns)
    .values({
      documentId: document!.id,
      stage: 'queued',
      pipelineVersion: 'test-0',
      pagesTotal: 3,
    })
    .returning({ id: processingRuns.id });

  return {
    job: { runId: run!.id, documentId: document!.id, collectionId: collection!.id },
  };
}

const readRun = async (runId: string) => {
  const [row] = await database.db
    .select()
    .from(processingRuns)
    .where(eq(processingRuns.id, runId));
  return row!;
};

const readIssues = async (runId: string) =>
  database.db.select().from(processingIssues).where(eq(processingIssues.runId, runId));

describe.skipIf(!reachable)('processDocumentJob', () => {
  it('completes a run when every stage succeeds', async () => {
    const { job } = await seedRun();
    const ran: string[] = [];
    const stages: StageHandler[] = [
      { stage: 'parsing', run: async () => void ran.push('parsing') },
      { stage: 'extracting', run: async () => void ran.push('extracting') },
    ];

    const outcome = await processDocumentJob({ database, storageDir, stages }, job);

    expect(ran).toEqual(['parsing', 'extracting']);
    expect(outcome).toMatchObject({ status: 'finished', stage: 'completed' });

    const run = await readRun(job.runId);
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
  });

  it('fails permanently when the stored file is gone, without retrying', async () => {
    const { job } = await seedRun({ withFile: false });

    const outcome = await processDocumentJob({ database, storageDir, stages: [] }, job);

    // Returned rather than thrown: no retry will restore a missing file, so the run is
    // finished honestly instead of failing repeatedly against the same absence.
    expect(outcome).toMatchObject({ status: 'finished', stage: 'failed' });

    const issues = await readIssues(job.runId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.failureKind).toBe('stored_file_missing');
    expect(issues[0]?.isTransient).toBe(false);
  });

  it('rethrows a transient failure so the queue can retry it', async () => {
    const { job } = await seedRun();
    const stages: StageHandler[] = [
      {
        stage: 'extracting',
        run: async () => {
          throw new Error('429 rate limit exceeded');
        },
      },
    ];

    await expect(processDocumentJob({ database, storageDir, stages }, job)).rejects.toThrow();

    // Left non-terminal on purpose: marking it failed would contradict the job that is
    // about to run again.
    const run = await readRun(job.runId);
    expect(['parsing', 'extracting']).toContain(run.stage);
    expect(run.finishedAt).toBeNull();

    const issues = await readIssues(job.runId);
    expect(issues[0]?.failureKind).toBe('provider_rate_limited');
    expect(issues[0]?.isTransient).toBe(true);
  });

  it('finishes as failed on a permanent stage error, without rethrowing', async () => {
    const { job } = await seedRun();
    const stages: StageHandler[] = [
      {
        stage: 'parsing',
        run: async () => {
          throw new ProcessingError('page 4 is not a page', 'invalid_page', 'permanent', 'parsing');
        },
      },
    ];

    const outcome = await processDocumentJob({ database, storageDir, stages }, job);
    expect(outcome).toMatchObject({ status: 'finished', stage: 'failed' });

    const run = await readRun(job.runId);
    expect(run.errorSummary).toContain('invalid_page');
  });

  it('counts repeated attempts as one issue rather than many rows', async () => {
    const { job } = await seedRun();
    const stages: StageHandler[] = [
      {
        stage: 'extracting',
        run: async () => {
          throw new Error('ETIMEDOUT contacting provider');
        },
      },
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(processDocumentJob({ database, storageDir, stages }, job)).rejects.toThrow();
    }

    // Three retries of one problem should read as one problem tried three times.
    const issues = await readIssues(job.runId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.attemptCount).toBe(3);
  });

  it('resolves an earlier failure when a later attempt succeeds', async () => {
    const { job } = await seedRun();
    let shouldFail = true;
    const stages: StageHandler[] = [
      {
        stage: 'extracting',
        run: async () => {
          if (shouldFail) throw new Error('ECONNRESET');
        },
      },
    ];

    await expect(processDocumentJob({ database, storageDir, stages }, job)).rejects.toThrow();
    shouldFail = false;
    const outcome = await processDocumentJob({ database, storageDir, stages }, job);

    // The retry worked, so the run is not permanently branded with a problem that is no
    // longer true; the issue survives as a resolved record of what happened.
    expect(outcome).toMatchObject({ status: 'finished', stage: 'completed' });
    const issues = await readIssues(job.runId);
    expect(issues[0]?.resolution).toBe('resolved');
  });

  it('keeps issues raised during a successful pass open', async () => {
    const { job } = await seedRun();
    // A stage that succeeds overall while recording a per-page problem, which is exactly
    // what the visual route does when one page is throttled and the rest parse fine.
    const stages: StageHandler[] = [
      {
        stage: 'parsing',
        run: async (context) => {
          await recordIssue(context.database.db, context.job.runId, {
            stage: 'parsing',
            failureKind: 'visual_route_throttled',
            failureClass: 'transient',
            message: 'physical page 7 was throttled',
            physicalPage: 7,
          });
        },
      },
    ];

    const outcome = await processDocumentJob({ database, storageDir, stages }, job);

    // Resolving these would report a clean success for a document that half-processed.
    // The stage distinction exists precisely to stop that.
    expect(outcome).toMatchObject({ status: 'finished', stage: 'completed_with_issues' });

    const issues = await readIssues(job.runId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.resolution).toBe('open');
  });

  it('does not double-count progress when a job is replayed', async () => {
    const { job } = await seedRun();
    const stages: StageHandler[] = [
      {
        stage: 'parsing',
        run: async (context) => {
          await recordProgress(context.database.db, context.job.runId, { pagesProcessed: 3 });
        },
      },
    ];

    await processDocumentJob({ database, storageDir, stages }, job);
    await processDocumentJob({ database, storageDir, stages }, job);

    // Counters are absolute, not incremental. An increment would report six pages
    // processed for a three-page document after one replay.
    const run = await readRun(job.runId);
    expect(run.pagesProcessed).toBe(3);
    expect(run.pagesTotal).toBe(3);
  });

  it('abandons a job whose run was deleted, without throwing', async () => {
    const { job } = await seedRun();
    // Deleting the document cascades its runs away, so the job now refers to neither.
    await database.db.delete(documents).where(eq(documents.id, job.documentId));

    const outcome = await processDocumentJob({ database, storageDir, stages: [] }, job);

    // Not a failure: there is no run to mark failed, and recording one against a
    // vanished run violates a foreign key. Before this was handled the job threw and
    // pg-boss retried it forever against a run that would never come back.
    expect(outcome.status).toBe('abandoned');
    if (outcome.status !== 'abandoned') return;
    expect(outcome.reason).toBe('run_deleted');
  });
});

describe('classifyFailure', () => {
  it('reads the classification off a ProcessingError', () => {
    const error = new ProcessingError('bad', 'invalid_page', 'permanent', 'parsing');
    expect(classifyFailure(error)).toEqual({
      failureKind: 'invalid_page',
      failureClass: 'permanent',
    });
  });

  it('names rate limiting, timeouts and refused connections as transient', () => {
    expect(classifyFailure(new Error('HTTP 429 Too Many Requests')).failureKind).toBe(
      'provider_rate_limited',
    );
    expect(classifyFailure({ code: 'ETIMEDOUT' }).failureKind).toBe('provider_timeout');
    expect(classifyFailure({ code: 'ECONNREFUSED' }).failureKind).toBe('dependency_unavailable');
  });

  it('defaults an unrecognised error to transient', () => {
    // The safer direction: a bounded number of wasted retries beats discarding work that
    // would have succeeded and marking a document failed when it was not.
    expect(classifyFailure(new Error('something odd')).failureClass).toBe('transient');
  });
});

/**
 * A failure that keeps happening must keep being reported.
 *
 * This is the regression for a real defect. `recordIssue` deduplicates on (run, kind,
 * page) and updates the existing row rather than inserting a second one, so an issue that
 * recurs keeps its original `createdAt`. `resolveOpenIssues` cut on `createdAt`, so it
 * resolved issues the current attempt had just re-recorded, and the run finished
 * `completed` having extracted nothing: every chunk throttled, every issue marked "a later
 * attempt completed this stage", and nothing unresolved for `finishRun` to notice.
 *
 * Observed on the earnings deck against a throttled provider: stage `completed`, 0 of 26
 * chunks, no claims, and four issues all marked resolved with an attempt count of four.
 */
describe.skipIf(!reachable)('an issue that recurs on a later attempt', () => {
  it('stays open, so the run still reports completed_with_issues', async () => {
    const { job } = await seedRun();
    const { db } = database;

    // Attempt one records the failure and fails the stage.
    let attempt = 0;
    const alwaysThrottled: StageHandler = {
      stage: 'extracting',
      async run(context) {
        attempt += 1;
        await recordIssue(db, context.job.runId, {
          stage: 'extracting',
          failureKind: 'extraction_throttled',
          failureClass: 'transient',
          physicalPage: 2,
          message: `chunk 0: throttled on attempt ${attempt}`,
        });
      },
    };

    await processDocumentJob({ database, storageDir, stages: [alwaysThrottled] }, job);
    const first = await readRun(job.runId);
    expect(first.stage).toBe('completed_with_issues');

    // The same failure again on a second attempt. recordIssue updates the row it already
    // has, which leaves createdAt pointing at the first attempt.
    await processDocumentJob({ database, storageDir, stages: [alwaysThrottled] }, job);

    const issues = await db
      .select()
      .from(processingIssues)
      .where(eq(processingIssues.runId, job.runId));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.attemptCount).toBe(2);
    // The failure is still happening, so it is not resolved and the run says so.
    expect(issues[0]!.resolution).not.toBe('resolved');

    const second = await readRun(job.runId);
    expect(second.stage).toBe('completed_with_issues');
  });

  it('still resolves an issue that stops recurring', async () => {
    const { job } = await seedRun();
    const { db } = database;

    const failsOnce: StageHandler = {
      stage: 'extracting',
      async run(context) {
        const [existing] = await db
          .select()
          .from(processingIssues)
          .where(eq(processingIssues.runId, context.job.runId));
        if (existing !== undefined) return;

        await recordIssue(db, context.job.runId, {
          stage: 'extracting',
          failureKind: 'extraction_throttled',
          failureClass: 'transient',
          physicalPage: 2,
          message: 'chunk 0: throttled',
        });
      },
    };

    await processDocumentJob({ database, storageDir, stages: [failsOnce] }, job);
    expect((await readRun(job.runId)).stage).toBe('completed_with_issues');

    // The second attempt does not hit the problem, so the earlier record is stale and is
    // cleared. Without this the cutoff would never resolve anything.
    await processDocumentJob({ database, storageDir, stages: [failsOnce] }, job);

    const issues = await db
      .select()
      .from(processingIssues)
      .where(eq(processingIssues.runId, job.runId));
    expect(issues[0]!.resolution).toBe('resolved');
    expect((await readRun(job.runId)).stage).toBe('completed');
  });
});

/**
 * A long stage must keep saying it is alive.
 *
 * `heartbeat_at` is the only thing distinguishing a stalled run from a working one, which
 * plan 2.3 requires to be distinguishable. Most stages refresh it as a side effect of
 * `recordProgress`, but normalization and the visual route have no per-item counter to
 * report and so refreshed nothing: on a document with hundreds of claims the interface
 * showed a healthy run as "stalled in normalizing", with a Retry button beside it that
 * would have restarted work that was progressing fine.
 */
describe.skipIf(!reachable)('a long-running stage', () => {
  it('refreshes the heartbeat while it works', async () => {
    const { job } = await seedRun();
    const { db } = database;

    const before = await readRun(job.runId);

    const slowStage: StageHandler = {
      stage: 'normalizing',
      async run(context) {
        // Far enough past enterStage's write that a stage touching nothing would leave a
        // measurably stale timestamp.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await heartbeat(db, context.job.runId);
      },
    };

    await processDocumentJob({ database, storageDir, stages: [slowStage] }, job);

    const after = await readRun(job.runId);
    expect(after.heartbeatAt).not.toBeNull();
    expect(after.heartbeatAt!.getTime()).toBeGreaterThan(
      before.heartbeatAt?.getTime() ?? 0,
    );
  });
});
