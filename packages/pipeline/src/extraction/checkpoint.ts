/**
 * Extraction's memory of what it already paid for.
 *
 * A retried job re-enters this stage from the beginning. That is deliberate — the stage
 * has no idea which chunks the previous attempt reached — but until now "from the
 * beginning" meant asking the model about every chunk again, at full price, to arrive
 * back at claims the unique index refuses to duplicate. On a hundred-page document with
 * one throttled chunk in the middle, the second attempt cost as much as the first and
 * changed almost nothing.
 *
 * So a chunk that came back and was written records that fact. The next attempt looks the
 * chunk up before it calls, and a hit skips the call while still counting what the chunk
 * produced.
 *
 * The identity is the thing to get right. It is not the chunk index, and not the document
 * hash: it is everything the model's answer depended on. Change the chunk's text, the
 * handles its citations use, the vocabulary shown beside it, the prompt, or the model, and
 * the fingerprint changes and the chunk is read again. A cache that outlived its inputs
 * would be worse than no cache, because it would look like an answer.
 */

import { createHash } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { chunkExtractions } from '@superjoin/db';

import type { Chunk } from '../parsing/chunk.ts';

/** What a resumed chunk contributed, replayed from the record rather than recomputed. */
export interface ChunkOutcome {
  readonly claimsExtracted: number;
  readonly claimsAccepted: number;
  readonly claimsNeedingReview: number;
  readonly claimsRejected: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** Everything outside the chunk that changes what the model is asked. */
export interface ExtractionIdentity {
  readonly promptVersion: string;
  readonly modelName: string;
  /** The registry text rendered into every prompt for this document. */
  readonly vocabulary: string;
}

/**
 * A stable identity for one chunk under one set of instructions.
 *
 * The block handles are folded in as well as the text. Two chunks can carry the same
 * words while `B2` resolves to different blocks — a re-parse that renumbers blocks does
 * exactly that — and a citation verified against the wrong block is a grounding failure
 * that would be inherited silently from the cache.
 */
export function chunkFingerprint(chunk: Chunk, identity: ExtractionIdentity): string {
  const hash = createHash('sha256');

  // An explicit separator between the parts, so two different splits of the same
  // characters cannot hash alike.
  const field = (value: string): void => {
    hash.update(value);
    hash.update('\u001f');
  };

  field(chunk.text);
  field(chunk.heading ?? '');

  for (const ref of chunk.blockRefs) {
    field(`${ref.ref}=${ref.sourceBlockId}`);
  }

  field(identity.vocabulary);
  // Columns on the row as well, and filtered on there. Folded in here too, so the hash
  // alone is the whole identity and a lookup that forgot one of them cannot match.
  field(identity.promptVersion);
  field(identity.modelName);

  return hash.digest('hex');
}

/**
 * Which of this document's chunks have already been extracted under this identity.
 *
 * One query for the whole document rather than one per chunk: the workers run
 * concurrently, and a lookup per chunk would put the database in the path of every call
 * the cache is meant to avoid.
 */
export async function loadCompletedChunks(
  db: Database,
  documentId: string,
  fingerprints: readonly string[],
  identity: ExtractionIdentity,
): Promise<Map<string, ChunkOutcome>> {
  if (fingerprints.length === 0) return new Map();

  const rows = await db
    .select({
      chunkFingerprint: chunkExtractions.chunkFingerprint,
      claimsExtracted: chunkExtractions.claimsExtracted,
      claimsAccepted: chunkExtractions.claimsAccepted,
      claimsNeedingReview: chunkExtractions.claimsNeedingReview,
      claimsRejected: chunkExtractions.claimsRejected,
      promptTokens: chunkExtractions.promptTokens,
      completionTokens: chunkExtractions.completionTokens,
    })
    .from(chunkExtractions)
    .where(
      and(
        eq(chunkExtractions.documentId, documentId),
        eq(chunkExtractions.promptVersion, identity.promptVersion),
        eq(chunkExtractions.modelName, identity.modelName),
        inArray(chunkExtractions.chunkFingerprint, [...fingerprints]),
      ),
    );

  const completed = new Map<string, ChunkOutcome>();

  for (const row of rows) {
    completed.set(row.chunkFingerprint, {
      claimsExtracted: row.claimsExtracted,
      claimsAccepted: row.claimsAccepted,
      claimsNeedingReview: row.claimsNeedingReview,
      claimsRejected: row.claimsRejected,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    });
  }

  return completed;
}

/**
 * Records that a chunk was read and its claims written.
 *
 * Called after `persistClaim`, never before: a row written first would let a crash
 * between the two mark a chunk done whose claims are not in the database, and the next
 * attempt would skip it forever. In the other order the worst case is a repeated call,
 * which is what the stage did on every retry anyway.
 *
 * `onConflictDoNothing` because two attempts can finish the same chunk, and the first
 * record of it is as good as the second.
 */
export async function recordCompletedChunk(
  db: Database,
  documentId: string,
  chunk: Chunk,
  fingerprint: string,
  identity: ExtractionIdentity,
  outcome: ChunkOutcome,
): Promise<void> {
  await db
    .insert(chunkExtractions)
    .values({
      documentId,
      chunkFingerprint: fingerprint,
      chunkIndex: chunk.index,
      promptVersion: identity.promptVersion,
      modelName: identity.modelName,
      ...outcome,
    })
    .onConflictDoNothing();
}
