/**
 * The extraction stage.
 *
 * Reads the source blocks parsing wrote, chunks them, asks the model what each chunk
 * asserts, verifies every citation against the stored text, and writes what survives.
 *
 * Three choices here are worth stating, because the obvious alternative is wrong in each
 * case.
 *
 * A page that was transcribed by the visual route has its native table blocks left out of
 * the chunks, not deleted. The transcription is the better reading of a table whose text
 * layer arrives as column soup, so it is what the model is asked about; the native blocks
 * stay available to `verifyClaim`, which needs them as the independent witness that lets
 * a visual-only claim be accepted at all.
 *
 * A chunk that fails costs that chunk. The document keeps every other chunk's claims and
 * the run ends `completed_with_issues`, which is the same trade parsing makes for an
 * unreadable page and for the same reason: on the free pool, throttling is ordinary
 * traffic and a document is not a failure because one call was refused.
 *
 * A token budget bounds the run. Without one, a hundred-page document spends the whole
 * shared quota on its own tables and every later document gets nothing.
 */

import { asc, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claims, processingRuns, sourceBlocks } from '@superjoin/db';

import { ModelError, type CompletionProvider } from '../model/index.ts';
import { chunkSourceBlocks, type Chunk, type ChunkSourceBlock } from '../parsing/chunk.ts';
import type { ProcessingContext, StageHandler } from '../processor.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { loadRegistry, registerPredicates, renderRegistry } from '../normalize/registry.ts';
import { EXTRACTION_PROMPT_VERSION } from './contract.ts';
import { extractChunk } from './extract.ts';
import { persistClaim } from './persist.ts';
import { verifyClaim, type EvidenceBlock } from './verify.ts';

export interface ExtractionStageOptions {
  readonly client: CompletionProvider;
  /** Prompt and completion tokens this stage may spend on one document. */
  readonly tokenBudget?: number;
  /** Chunks in flight at once. Sourced from LLM_CONCURRENCY. */
  readonly concurrency?: number;
  /** Give up after this many consecutive throttled chunks. */
  readonly maxConsecutiveFailures?: number;
  /**
   * Give up after this many consecutive failed chunks of any kind.
   *
   * The backstop to `maxConsecutiveFailures`, and deliberately looser. Backing off from a
   * rate limit protects a quota that further calls would only burn, so that ceiling stays
   * strict. A malformed reply is usually a flake — the dense financial pages that return
   * `claims: null` in one run extract cleanly in the next — so the chunks queued behind
   * one are worth attempting, and malformed replies count only here.
   *
   * Counting every kind rather than only malformed ones is what makes this a backstop: a
   * document failing alternately on throttling and bad JSON would otherwise fill neither
   * counter and grind through every remaining chunk making doomed calls.
   */
  readonly maxConsecutiveAny?: number;
}

const DEFAULTS = {
  tokenBudget: 1_500_000,
  concurrency: 2,
  maxConsecutiveFailures: 4,
  maxConsecutiveAny: 12,
} as const;

/** How a failed chunk should be counted against the two give-up ceilings. */
export type FailureRun = 'throttled' | 'malformed' | 'other';

/**
 * Which run of failures a thrown error belongs to.
 *
 * The distinction is the whole point of counting them separately: a provider refusing to
 * serve us and a provider serving something unreadable look alike at the call site and
 * call for opposite responses.
 */
export function classifyFailure(error: unknown): FailureRun {
  const kind = error instanceof ModelError ? error.kind : null;
  if (kind === 'provider_rate_limited') return 'throttled';
  if (kind === 'schema_violation' || kind === 'schema_violation_after_repair') {
    return 'malformed';
  }
  return 'other';
}

export interface ExtractionSummary {
  readonly chunksTotal: number;
  readonly chunksProcessed: number;
  readonly chunksFailed: number;
  readonly claimsExtracted: number;
  readonly claimsAccepted: number;
  readonly claimsNeedingReview: number;
  readonly claimsRejected: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly stoppedEarly: boolean;
}

/** A stored block as this stage reads it, before it is split between roles. */
interface StoredBlock extends EvidenceBlock, ChunkSourceBlock {
  readonly blockType: string;
  readonly blockIndex: number;
  readonly printedPageLabel: string | null;
}

/**
 * Loads every block of a document in reading order.
 *
 * Ordered by page then block index, which is the order chunking requires. Block index is
 * the parser's own ordering and is not semantic sequence — the chart on `doc-02` page 5
 * arrives with two fiscal years inverted — but it is stable, and stability is what
 * chunking needs from it.
 */
async function loadBlocks(db: Database, documentId: string): Promise<StoredBlock[]> {
  const rows = await db
    .select({
      id: sourceBlocks.id,
      documentId: sourceBlocks.documentId,
      physicalPage: sourceBlocks.physicalPage,
      printedPageLabel: sourceBlocks.printedPageLabel,
      blockType: sourceBlocks.blockType,
      blockIndex: sourceBlocks.blockIndex,
      content: sourceBlocks.content,
      extractionMethod: sourceBlocks.extractionMethod,
    })
    .from(sourceBlocks)
    .where(eq(sourceBlocks.documentId, documentId))
    .orderBy(asc(sourceBlocks.physicalPage), asc(sourceBlocks.blockIndex));

  return rows.map((row) => ({
    id: row.id,
    documentId: row.documentId,
    physicalPage: row.physicalPage,
    printedPageLabel: row.printedPageLabel,
    blockType: row.blockType,
    blockIndex: row.blockIndex,
    content: row.content,
    extractionMethod: row.extractionMethod,
  }));
}

/**
 * Chooses which blocks the model is asked about.
 *
 * On a page the visual route reached, the native table and chart blocks are dropped in
 * favour of the transcription: they describe the same table, and asking about both spends
 * twice the tokens to produce two readings of one thing that then have to be reconciled.
 * Narrative blocks on that page are kept, because a transcription covers only its tables.
 */
export function selectExtractionBlocks(blocks: readonly StoredBlock[]): StoredBlock[] {
  const transcribedPages = new Set(
    blocks
      .filter((block) => block.extractionMethod === 'model_transcription')
      .map((block) => block.physicalPage),
  );

  return blocks.filter((block) => {
    if (block.extractionMethod === 'model_transcription') return true;
    if (!transcribedPages.has(block.physicalPage)) return true;
    return block.blockType !== 'table' && block.blockType !== 'chart';
  });
}

/** Native-text blocks by page, for the independence cross-check in plan 4.3. */
function nativeBlocksByPage(
  blocks: readonly StoredBlock[],
): Map<number, readonly EvidenceBlock[]> {
  const byPage = new Map<number, EvidenceBlock[]>();

  for (const block of blocks) {
    if (block.extractionMethod !== 'native_text') continue;
    const existing = byPage.get(block.physicalPage);
    if (existing === undefined) byPage.set(block.physicalPage, [block]);
    else existing.push(block);
  }

  return byPage;
}

export async function extractDocument(
  context: ProcessingContext,
  options: ExtractionStageOptions,
): Promise<ExtractionSummary> {
  const { db } = context.database;
  const tokenBudget = options.tokenBudget ?? DEFAULTS.tokenBudget;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const maxConsecutive = options.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures;
  const maxAny = options.maxConsecutiveAny ?? DEFAULTS.maxConsecutiveAny;

  const blocks = await loadBlocks(db, context.job.documentId);
  const blocksById = new Map(blocks.map((block) => [block.id, block as EvidenceBlock]));
  const byPage = nativeBlocksByPage(blocks);

  const chunks = chunkSourceBlocks(selectExtractionBlocks(blocks));

  /**
   * What this collection already calls things, read once and shown to every chunk.
   *
   * Read before extraction rather than per chunk so one document sees a stable
   * vocabulary: letting it grow mid-document would have later chunks reusing names
   * earlier chunks of the same file had just coined, which is how a near-duplicate
   * becomes entrenched instead of being caught as an alias afterwards.
   */
  const vocabulary = renderRegistry(await loadRegistry(db, context.job.collectionId));

  await recordProgress(db, context.job.runId, { chunksTotal: chunks.length, chunksProcessed: 0 });

  // Recorded before any call, so a run interrupted halfway still says which prompt and
  // which model produced the claims it did manage to write.
  await db
    .update(processingRuns)
    .set({ modelName: options.client.model, promptVersion: EXTRACTION_PROMPT_VERSION })
    .where(eq(processingRuns.id, context.job.runId));

  if (chunks.length === 0) {
    return {
      chunksTotal: 0,
      chunksProcessed: 0,
      chunksFailed: 0,
      claimsExtracted: 0,
      claimsAccepted: 0,
      claimsNeedingReview: 0,
      claimsRejected: 0,
      promptTokens: 0,
      completionTokens: 0,
      stoppedEarly: false,
    };
  }

  let next = 0;
  let processed = 0;
  let failed = 0;
  let extracted = 0;
  let accepted = 0;
  let needsReview = 0;
  let rejected = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  /**
   * Two runs of failures, counted apart.
   *
   * `consecutive` is the strict one: the provider refusing to serve us, where every
   * further call is wasted quota. `consecutiveAny` is the backstop across all kinds.
   * A reply that arrived and could not be read increments only the backstop, because the
   * next chunk may well succeed — counting it as a refusal is what let four scattered
   * schema flakes abandon seventeen unattempted chunks, including the restated financial
   * statements, the densest pages in the set.
   */
  let consecutive = 0;
  let consecutiveAny = 0;
  let stoppedEarly = false;

  const stop = async (reason: string, failureKind: string): Promise<void> => {
    if (stoppedEarly) return;
    stoppedEarly = true;
    await recordIssue(db, context.job.runId, {
      stage: 'extracting',
      failureKind,
      failureClass: 'transient',
      message: reason,
    });
  };

  const runOne = async (chunk: Chunk): Promise<void> => {
    const result = await extractChunk(chunk, { client: options.client, vocabulary });

    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    extracted += result.claims.length;

    const refToBlockId = new Map(
      chunk.blockRefs.map((entry) => [entry.ref, entry.sourceBlockId]),
    );

    for (const claim of result.claims) {
      const verification = verifyClaim(claim, {
        documentId: context.job.documentId,
        refToBlockId,
        blocksById,
        nativeBlocksByPage: byPage,
      });

      const stored = await persistClaim(db, claim, verification.evidence, {
        documentId: context.job.documentId,
        runId: context.job.runId,
      });

      if (stored.status === 'accepted') accepted += 1;
      else if (stored.status === 'needs_review') needsReview += 1;
      else rejected += 1;
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stoppedEarly) return;

      if (promptTokens + completionTokens >= tokenBudget) {
        await stop(
          `stopped after ${promptTokens + completionTokens} tokens, the per-document budget; ${chunks.length - processed - failed} chunks were not attempted`,
          'token_budget_exhausted',
        );
        return;
      }

      if (consecutive >= maxConsecutive) {
        await stop(
          `stopped after ${consecutive} consecutive chunks the provider would not serve; ${chunks.length - processed - failed} chunks were not attempted`,
          'extraction_abandoned',
        );
        return;
      }

      if (consecutiveAny >= maxAny) {
        await stop(
          `stopped after ${consecutiveAny} consecutive failed chunks; ${chunks.length - processed - failed} chunks were not attempted`,
          'extraction_abandoned',
        );
        return;
      }

      const index = next;
      next += 1;
      const chunk = chunks[index];
      if (chunk === undefined) return;

      try {
        await runOne(chunk);
        processed += 1;
        consecutive = 0;
        consecutiveAny = 0;
      } catch (error) {
        failed += 1;

        const modelError = error instanceof ModelError ? error : null;
        const run = classifyFailure(error);
        const throttled = run === 'throttled';

        consecutiveAny += 1;
        if (run !== 'malformed') consecutive += 1;

        // Recorded, not thrown. The chunk's blocks are already stored as evidence and
        // the other chunks keep their claims; failing the document here would discard
        // work that succeeded because one call did not.
        await recordIssue(db, context.job.runId, {
          stage: 'extracting',
          failureKind: throttled
            ? 'extraction_throttled'
            : (modelError?.kind ?? 'extraction_failed'),
          failureClass: throttled ? 'transient' : 'permanent',
          message: `chunk ${chunk.index} (page ${chunk.physicalPages.join(', ')}): ${(error as Error).message.slice(0, 300)}`,
          ...(chunk.physicalPages[0] !== undefined
            ? { physicalPage: chunk.physicalPages[0] }
            : {}),
        });
      }

      await recordProgress(db, context.job.runId, {
        chunksProcessed: processed,
        claimsExtracted: extracted,
        claimsAccepted: accepted,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
  );

  // Absolute, not incremental: a retried job re-enters this stage from the beginning and
  // an increment would report the second pass on top of the first.
  await db
    .update(processingRuns)
    .set({ inputTokens: promptTokens, outputTokens: completionTokens })
    .where(eq(processingRuns.id, context.job.runId));

  await recordProgress(db, context.job.runId, {
    chunksProcessed: processed,
    claimsExtracted: extracted,
    claimsAccepted: accepted,
  });

  /**
   * Record what this document actually used, so the next one can reuse it.
   *
   * After the loop rather than during it, for the same reason the vocabulary is read
   * before: a name coined in chunk 3 should not be offered back in chunk 4 of the same
   * document, where it has not yet been seen often enough to be worth entrenching.
   */
  const used = await db
    .selectDistinct({ predicate: claims.predicate, unit: claims.unit })
    .from(claims)
    .where(eq(claims.documentId, context.job.documentId));

  if (used.length > 0) {
    await registerPredicates(
      db,
      context.job.collectionId,
      used.map((row) => ({ name: row.predicate, unit: row.unit })),
    );
  }

  return {
    chunksTotal: chunks.length,
    chunksProcessed: processed,
    chunksFailed: failed,
    claimsExtracted: extracted,
    claimsAccepted: accepted,
    claimsNeedingReview: needsReview,
    claimsRejected: rejected,
    promptTokens,
    completionTokens,
    stoppedEarly,
  };
}

/**
 * Builds the stage.
 *
 * A factory rather than a constant, because the stage needs the model client and the
 * worker is the only process that may hold one.
 */
export function createExtractionStage(options: ExtractionStageOptions): StageHandler {
  return {
    stage: 'extracting',
    async run(context) {
      await extractDocument(context, options);
    },
  };
}
