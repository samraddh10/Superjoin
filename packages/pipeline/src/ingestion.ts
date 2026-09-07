/**
 * Ingestion: from uploaded bytes to a queued processing run.
 *
 * The ordering here is the whole point, and plan section 2.1 states the hazard directly:
 * a failure between writing the file and enqueueing work must not leave a falsely
 * successful document.
 *
 *   1. Validate, so nothing unreadable reaches storage or the database.
 *   2. Write the bytes. A file with no row is invisible, which is recoverable.
 *   3. Insert the document, the run and the job in one transaction.
 *   4. If that transaction fails, delete the file just written.
 *
 * The reverse order would be worse: a committed document row pointing at a file that was
 * never written looks successful and fails only when something tries to parse it.
 */

import { rm } from 'node:fs/promises';

import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Database, DatabaseHandle } from '@superjoin/db';
import { documents, processingRuns } from '@superjoin/db';

import { enqueueDocumentJob } from './queue.ts';
import { documentStorageKey, resolvePath, writeObject } from './storage.ts';
import { validateUpload, type RejectionReason, type ValidationLimits } from './validation.ts';

export interface IngestionRequest {
  readonly collectionId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface IngestionContext {
  readonly database: DatabaseHandle;
  readonly boss: PgBoss;
  readonly storageDir: string;
  readonly limits: ValidationLimits;
  /** Recorded on the run so an old result stays interpretable. See plan 1.2. */
  readonly pipelineVersion: string;
}

export type IngestionOutcome =
  | {
      readonly status: 'accepted';
      readonly documentId: string;
      readonly runId: string;
      readonly contentHash: string;
      readonly pageCount: number;
    }
  | {
      /**
       * The same bytes are already in this collection. Reported, never silently
       * reprocessed, per plan 2.1. The existing document is named so a caller can link
       * to it rather than being told only that something went wrong.
       */
      readonly status: 'duplicate';
      readonly documentId: string;
      readonly contentHash: string;
      readonly filename: string;
    }
  | {
      readonly status: 'rejected';
      readonly reason: RejectionReason;
      readonly message: string;
    };

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === UNIQUE_VIOLATION;
}

async function findExisting(db: Database, collectionId: string, hash: string) {
  const [existing] = await db
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(and(eq(documents.collectionId, collectionId), eq(documents.contentHash, hash)))
    .limit(1);
  return existing;
}

export async function ingestDocument(
  context: IngestionContext,
  request: IngestionRequest,
): Promise<IngestionOutcome> {
  const validation = await validateUpload(request.bytes, context.limits);
  if (!validation.ok) {
    return { status: 'rejected', reason: validation.reason, message: validation.message };
  }

  const { db } = context.database;
  const { contentHash: hash, pageCount, byteSize } = validation;

  // Cheap path: an obvious duplicate is answered without touching storage. The unique
  // constraint below is what actually makes this correct under concurrency; this only
  // avoids the wasted write in the common case.
  const alreadyPresent = await findExisting(db, request.collectionId, hash);
  if (alreadyPresent !== undefined) {
    return {
      status: 'duplicate',
      documentId: alreadyPresent.id,
      filename: alreadyPresent.filename,
      contentHash: hash,
    };
  }

  const storageKey = documentStorageKey(hash);
  await writeObject(context.storageDir, storageKey, request.bytes);

  try {
    return await db.transaction(async (tx) => {
      const [document] = await tx
        .insert(documents)
        .values({
          collectionId: request.collectionId,
          filename: request.filename,
          contentHash: hash,
          storageKey,
          byteSize,
          pageCount,
        })
        .returning({ id: documents.id });

      const [run] = await tx
        .insert(processingRuns)
        .values({
          documentId: document!.id,
          stage: 'queued',
          pipelineVersion: context.pipelineVersion,
          pagesTotal: pageCount,
        })
        .returning({ id: processingRuns.id });

      // Same transaction as the two rows above. A rollback takes the job with it, so a
      // document can never exist with nothing scheduled to process it.
      await enqueueDocumentJob(context.boss, tx, {
        runId: run!.id,
        documentId: document!.id,
        collectionId: request.collectionId,
      });

      return {
        status: 'accepted' as const,
        documentId: document!.id,
        runId: run!.id,
        contentHash: hash,
        pageCount,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a race against a concurrent upload of the same bytes. The winner's file is
      // identical, since the key is the content hash, so the file is left alone and this
      // upload is reported as the duplicate it turned out to be.
      const winner = await findExisting(db, request.collectionId, hash);
      if (winner !== undefined) {
        return {
          status: 'duplicate',
          documentId: winner.id,
          filename: winner.filename,
          contentHash: hash,
        };
      }
    }

    // The transaction rolled back, so nothing references this file. Removing it keeps
    // storage from accumulating uploads no run will ever read. Failing to remove it is
    // not worth surfacing over the original error, which is what the caller needs.
    await removeQuietly(context.storageDir, storageKey);
    throw error;
  }
}

async function removeQuietly(storageDir: string, key: string): Promise<void> {
  try {
    await rm(resolvePath(storageDir, key), { force: true });
  } catch {
    // Deliberately swallowed: an orphaned file is harmless next to losing the real error.
  }
}
