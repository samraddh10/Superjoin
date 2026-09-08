/**
 * The extraction stage.
 *
 * Reads the source blocks parsing wrote, chunks them, asks the model what each chunk
 * asserts, verifies every citation against the stored text, and writes what survives.
 *
 * Four choices here are worth stating, because the obvious alternative is wrong in each
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
 *
 * A retry resumes rather than restarts. The claim writer was already idempotent, so a
 * second attempt could not duplicate anything — but it re-asked the model about every
 * chunk to get there, which made the price of a document its length times its attempts.
 * A chunk that succeeded now records that it did, keyed on everything the answer depended
 * on, and the next attempt skips the call while still counting what the chunk produced.
 */

import { asc, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claims, processingRuns, sourceBlocks } from '@superjoin/db';

import { ModelError, type CompletionProvider } from '../model/index.ts';
import { chunkSourceBlocks, type Chunk, type ChunkSourceBlock } from '../parsing/chunk.ts';
import { ProcessingError, type ProcessingContext, type StageHandler } from '../processor.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { loadRegistry, registerPredicates, renderRegistry } from '../normalize/registry.ts';
import {
  chunkFingerprint,
  loadCompletedChunks,
  recordCompletedChunk,
  type ExtractionIdentity,
} from './checkpoint.ts';
import { EXTRACTION_PROMPT_VERSION } from './contract.ts';
import { apportion, planBatches, type ChunkBatch } from './batch.ts';
import { extractBatch } from './extract.ts';
import { persistClaim } from './persist.ts';
import { verifyClaim, type EvidenceBlock } from './verify.ts';

export interface ExtractionStageOptions {
  readonly client: CompletionProvider;
  /** Prompt and completion tokens this stage may spend on one document. */
  readonly tokenBudget?: number;
  /** Requests in flight at once. Sourced from LLM_CONCURRENCY. */
  readonly concurrency?: number;
  /**
   * Input tokens one request may carry across its passages. Sourced from
   * EXTRACTION_BATCH_TOKENS.
   *
   * Chunking flushes at every heading and page, which is right for citations and leaves a
   * tail of very small chunks. Each used to pay the full fixed cost of a request — system
   * prompt, rules, the collection's whole predicate vocabulary, schema — to ask about a
   * few dozen words. Setting this to zero effectively turns batching off, one passage per
   * request, which is what the stage did before.
   */
  readonly batchInputTokens?: number;
  /** Passages one request may carry. Sourced from EXTRACTION_BATCH_CHUNKS. */
  readonly batchMaxChunks?: number;
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
  /**
   * Chunks a previous attempt had already extracted, counted but not re-asked.
   *
   * Part of `chunksProcessed`, not additional to it: the document was read, and by which
   * attempt is bookkeeping. Reported separately because it is the difference between a
   * retry that cost a document's worth of tokens and one that cost a chunk's.
   */
  readonly chunksResumed: number;
  readonly chunksFailed: number;
  readonly claimsExtracted: number;
  readonly claimsAccepted: number;
  readonly claimsNeedingReview: number;
  readonly claimsRejected: number;
  /** What the document cost in total, resumed chunks included. */
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * What this attempt itself spent.
   *
   * Separate from the totals because the two answer different questions, and conflating
   * them is how a retry that cost nothing came to be reported as a document extracted for
   * free. The budget is spent against these; the run is costed against the totals.
   */
  readonly spentPromptTokens: number;
  readonly spentCompletionTokens: number;
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

  /**
   * What a chunk's answer depended on, and therefore what a cached one is only valid for.
   *
   * The vocabulary is in here rather than beside it because it is part of the prompt: two
   * runs of the same chunk under two registries are two different questions, and the
   * second must not be answered from the first.
   */
  const identity: ExtractionIdentity = {
    promptVersion: EXTRACTION_PROMPT_VERSION,
    modelName: options.client.model,
    vocabulary,
  };

  const fingerprints = new Map(chunks.map((chunk) => [chunk.index, chunkFingerprint(chunk, identity)]));
  const completed = await loadCompletedChunks(
    db,
    context.job.documentId,
    [...fingerprints.values()],
    identity,
  );

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
      chunksResumed: 0,
      chunksFailed: 0,
      claimsExtracted: 0,
      claimsAccepted: 0,
      claimsNeedingReview: 0,
      claimsRejected: 0,
      promptTokens: 0,
      completionTokens: 0,
      spentPromptTokens: 0,
      spentCompletionTokens: 0,
      stoppedEarly: false,
    };
  }

  /**
   * The chunks a previous attempt already finished, settled before any request is planned.
   *
   * Separated here rather than skipped inside the worker so batching never packs a chunk
   * that is not going to be asked. A batch built around one is a request carrying content
   * nobody needed, which is the cost this whole path exists to remove.
   */
  const pending: Chunk[] = [];
  let next = 0;
  let processed = 0;
  let resumed = 0;
  let failed = 0;
  let extracted = 0;
  let accepted = 0;
  let needsReview = 0;
  let rejected = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  /** The share of the totals this attempt actually paid for. Only these meet the budget. */
  let spentPromptTokens = 0;
  let spentCompletionTokens = 0;
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

  /**
   * Runs one batch: one request, however many passages it carries.
   *
   * Claims come back as one list and are attributed to a chunk by the block each cites,
   * not by anything the model says about which passage it read. Handles are unique across
   * a batch, so that attribution is a lookup rather than a judgement, and a model that
   * confuses two passages still produces a claim grounded in the block it actually quoted.
   */
  const runBatch = async (batch: ChunkBatch): Promise<void> => {
    const result = await extractBatch(batch, { client: options.client, vocabulary });

    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    spentPromptTokens += result.promptTokens;
    spentCompletionTokens += result.completionTokens;
    extracted += result.claims.length;

    const chunkOfBlock = new Map<string, number>();
    for (const passage of batch.passages) {
      for (const ref of passage.chunk.blockRefs) {
        chunkOfBlock.set(ref.sourceBlockId, passage.chunk.index);
      }
    }

    const tally = new Map<number, { extracted: number; accepted: number; review: number; rejected: number }>();
    for (const passage of batch.passages) {
      tally.set(passage.chunk.index, { extracted: 0, accepted: 0, review: 0, rejected: 0 });
    }

    /**
     * A claim whose citations resolve to nothing belongs to no passage in particular.
     *
     * It is a rejection either way — `verifyClaim` refuses a citation it cannot resolve —
     * but there is no honest way to say which chunk produced it, so the whole batch is
     * left unrecorded and asked again on a retry. Costing a few extra passages is the
     * right side to err on against marking a chunk done on someone else's evidence.
     */
    let unattributed = 0;

    for (const claim of result.claims) {
      const verification = verifyClaim(claim, {
        documentId: context.job.documentId,
        refToBlockId: batch.refToBlockId,
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

      const owner = claim.evidence_block_ids
        .map((ref) => batch.refToBlockId.get(ref))
        .find((blockId) => blockId !== undefined && chunkOfBlock.has(blockId));
      const counts = owner === undefined ? undefined : tally.get(chunkOfBlock.get(owner) ?? -1);

      if (counts === undefined) {
        unattributed += 1;
        continue;
      }

      counts.extracted += 1;
      if (stored.status === 'accepted') counts.accepted += 1;
      else if (stored.status === 'needs_review') counts.review += 1;
      else counts.rejected += 1;
    }

    // Apportioned by each passage's share of the batch's text. The per-chunk figure is an
    // apportionment rather than a measurement — a request is billed once — but the shares
    // add back up to what was spent, which is what a resumed run has to be able to report.
    const weights = batch.passages.map((passage) => passage.chunk.estimatedTokens);
    const promptShares = apportion(result.promptTokens, weights);
    const completionShares = apportion(result.completionTokens, weights);

    for (const [position, passage] of batch.passages.entries()) {
      const counts = tally.get(passage.chunk.index);
      if (counts === undefined || counts.rejected > 0 || unattributed > 0) continue;

      const fingerprint =
        fingerprints.get(passage.chunk.index) ?? chunkFingerprint(passage.chunk, identity);

      // After the claims are written, so a crash between the two costs a repeated call
      // rather than marking a chunk done whose claims never landed.
      await recordCompletedChunk(db, context.job.documentId, passage.chunk, fingerprint, identity, {
        claimsExtracted: counts.extracted,
        claimsAccepted: counts.accepted,
        claimsNeedingReview: counts.review,
        claimsRejected: 0,
        promptTokens: promptShares[position] ?? 0,
        completionTokens: completionShares[position] ?? 0,
      });
    }
  };

  /**
   * Everything a previous attempt already finished, counted from the record.
   *
   * Done in one pass before any request, so the batches are planned over the work that
   * actually remains.
   */
  for (const chunk of chunks) {
    const fingerprint = fingerprints.get(chunk.index) ?? chunkFingerprint(chunk, identity);
    const cached = completed.get(fingerprint);

    if (cached === undefined) {
      pending.push(chunk);
      continue;
    }

    promptTokens += cached.promptTokens;
    completionTokens += cached.completionTokens;
    extracted += cached.claimsExtracted;
    accepted += cached.claimsAccepted;
    needsReview += cached.claimsNeedingReview;
    rejected += cached.claimsRejected;
    processed += 1;
    resumed += 1;
  }

  const batches = planBatches(pending, {
    ...(options.batchInputTokens !== undefined ? { maxInputTokens: options.batchInputTokens } : {}),
    ...(options.batchMaxChunks !== undefined ? { maxChunks: options.batchMaxChunks } : {}),
  });

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stoppedEarly) return;

      // Measured on what this attempt spent, not on the document's total. A resumed
      // chunk's tokens were paid for by an earlier attempt and charging them again here
      // would let a long document exhaust its budget without making a single call.
      if (spentPromptTokens + spentCompletionTokens >= tokenBudget) {
        await stop(
          `stopped after ${spentPromptTokens + spentCompletionTokens} tokens, the per-document budget; ${chunks.length - processed - failed} chunks were not attempted`,
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
      const batch = batches[index];
      if (batch === undefined) return;

      const first = batch.passages[0]?.chunk;
      const pages = [...new Set(batch.passages.flatMap((passage) => passage.chunk.physicalPages))];

      try {
        await runBatch(batch);
        processed += batch.passages.length;
        consecutive = 0;
        consecutiveAny = 0;
      } catch (error) {
        // A batch fails as a unit. Its passages shared one request, and there is no way
        // to tell which of them the model choked on — nor is it usually one of them.
        failed += batch.passages.length;

        const modelError = error instanceof ModelError ? error : null;
        // The provider refusing to serve and a provider that answered badly are counted
        // apart: only the first means every further call is wasted quota.
        const run = classifyFailure(error);

        consecutiveAny += 1;
        if (run !== 'malformed') consecutive += 1;

        await recordIssue(db, context.job.runId, {
          stage: 'extracting',
          failureKind: modelError?.kind ?? 'extraction_failed',
          failureClass: modelError !== null && modelError.retryable ? 'transient' : 'permanent',
          message: `${batch.passages.length === 1 ? `chunk ${first?.index}` : `chunks ${batch.passages.map((passage) => passage.chunk.index).join(', ')}`} (page ${pages.join(', ')}): ${(error as Error).message.slice(0, 300)}`,
          ...(pages[0] !== undefined ? { physicalPage: pages[0] } : {}),
        });

        // A provider that did not answer fails the document. Keeping the other chunks'
        // claims would report a document as extracted when part of it was never read,
        // and nothing downstream could tell the difference. A chunk that failed for its
        // own reasons — a malformed response from a provider that did reply — still
        // costs only that chunk.
        if (modelError !== null) {
          throw new ProcessingError(
            `extraction call failed on chunk ${first?.index ?? 0}: ${modelError.message}`,
            modelError.kind,
            modelError.retryable ? 'transient' : 'permanent',
            'extracting',
            pages[0],
          );
        }
      }

      await recordProgress(db, context.job.runId, {
        chunksProcessed: processed,
        claimsExtracted: extracted,
        claimsAccepted: accepted,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
  );

  // Absolute, not incremental: a retried job re-enters this stage from the beginning and
  // an increment would report the second pass on top of the first. The figure includes
  // resumed chunks, so it stays the cost of reading the document rather than the cost of
  // whichever attempt happened to finish it.
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
    chunksResumed: resumed,
    chunksFailed: failed,
    claimsExtracted: extracted,
    claimsAccepted: accepted,
    claimsNeedingReview: needsReview,
    claimsRejected: rejected,
    promptTokens,
    completionTokens,
    spentPromptTokens,
    spentCompletionTokens,
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
