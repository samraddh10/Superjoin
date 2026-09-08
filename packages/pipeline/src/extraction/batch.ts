/**
 * Packing several chunks into one extraction call.
 *
 * Chunking flushes at every heading and every page, because a table has to stay attached
 * to the section that names it and a claim's page has to be unambiguous. Those are the
 * right boundaries and this does not move them. What they produce, though, is a long tail
 * of small chunks — a heading with two sentences under it, the last three rows of a table
 * on a page of its own — and each one used to cost a full request: the system prompt, the
 * rules, the collection's whole predicate vocabulary, the schema, all resent to ask about
 * forty words.
 *
 * So the chunks stay as they are and several travel together. Each is a separate passage
 * in the request, keeps its own page and section header, and produces its own claims.
 *
 * The one thing a batch must not do is make a citation ambiguous. Handles are numbered per
 * chunk, so two passages in one request would both offer a `B1` standing for different
 * blocks. Every handle is therefore rewritten to carry its passage — `P2B1` — and the
 * lookup is built over the batch. A claim is then attributed back to a chunk by the block
 * it cites rather than by where the model filed it, so grounding does not depend on the
 * model keeping the passages straight.
 */

import type { Chunk } from '../parsing/chunk.ts';
import { estimateTokens } from '../parsing/chunk.ts';

export interface BatchOptions {
  /**
   * Input tokens one request may carry, across all its passages.
   *
   * Not a model limit — well under one — but the point past which batching stops paying.
   * The saving is the fixed cost of a request divided over more content; a batch large
   * enough to risk the model losing track of a passage has spent that saving on a worse
   * answer.
   */
  readonly maxInputTokens?: number;
  /** Passages one request may carry, whatever their size. */
  readonly maxChunks?: number;
}

const DEFAULTS = {
  maxInputTokens: 3000,
  maxChunks: 4,
} as const;

/** One chunk as it appears inside a batch, with its handles made batch-unique. */
export interface BatchPassage {
  /** `P1`, `P2` — the passage's label in the request. */
  readonly label: string;
  readonly chunk: Chunk;
  /** The chunk's text with every `[B1]` rewritten to its batch-unique form. */
  readonly text: string;
  /** Batch-unique handles, in the order the passage introduces them. */
  readonly handles: readonly string[];
}

export interface ChunkBatch {
  readonly passages: readonly BatchPassage[];
  /** Every handle in the batch, resolved. One map, because handles no longer collide. */
  readonly refToBlockId: ReadonlyMap<string, string>;
  readonly estimatedTokens: number;
}

/**
 * Groups chunks into batches in reading order.
 *
 * Order is preserved rather than optimized. A bin-packing that put page 40 beside page 3
 * would fit marginally more into each request and would make the passages in it unrelated,
 * which is the opposite of what helps a model read them. Adjacent chunks usually share a
 * section, so the batch reads as a continuation.
 *
 * A chunk larger than the budget travels alone rather than being refused: the budget is
 * about what to add to a request, not about what may be asked.
 */
export function planBatches(
  chunks: readonly Chunk[],
  options: BatchOptions = {},
): ChunkBatch[] {
  const maxInputTokens = options.maxInputTokens ?? DEFAULTS.maxInputTokens;
  const maxChunks = Math.max(1, options.maxChunks ?? DEFAULTS.maxChunks);

  const batches: ChunkBatch[] = [];
  let current: Chunk[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push(buildBatch(current));
    current = [];
    currentTokens = 0;
  };

  for (const chunk of chunks) {
    const full = current.length >= maxChunks;
    const wouldOverflow = current.length > 0 && currentTokens + chunk.estimatedTokens > maxInputTokens;

    if (full || wouldOverflow) flush();

    current.push(chunk);
    currentTokens += chunk.estimatedTokens;
  }

  flush();
  return batches;
}

/** Numbers a batch's passages and rewrites their handles so none collide. */
function buildBatch(chunks: readonly Chunk[]): ChunkBatch {
  const refToBlockId = new Map<string, string>();
  const passages: BatchPassage[] = [];

  chunks.forEach((chunk, index) => {
    // A single-chunk batch keeps the chunk's own handles. The rewrite exists to stop two
    // passages colliding, and renaming handles when there is nothing to collide with
    // would change what a lone chunk is asked without changing what it means.
    const prefix = chunks.length === 1 ? '' : `P${index + 1}`;
    const handles: string[] = [];

    for (const ref of chunk.blockRefs) {
      const handle = `${prefix}${ref.ref}`;
      refToBlockId.set(handle, ref.sourceBlockId);
      handles.push(handle);
    }

    passages.push({
      label: `P${index + 1}`,
      chunk,
      text: prefix === '' ? chunk.text : rewriteHandles(chunk.text, prefix),
      handles,
    });
  });

  return {
    passages,
    refToBlockId,
    estimatedTokens: chunks.reduce((total, chunk) => total + chunk.estimatedTokens, 0),
  };
}

/**
 * Rewrites the handle labels a chunk's text carries.
 *
 * Anchored to a whole line, which is how chunking writes them: a handle sits alone above
 * the block it labels. A table cell containing the characters `[B1]` mid-sentence is left
 * alone, because it is content rather than a label.
 */
function rewriteHandles(text: string, prefix: string): string {
  return text.replace(/^\[(B\d+)\]$/gm, (_match, ref: string) => `[${prefix}${ref}]`);
}

/**
 * Splits one call's token usage across the chunks that shared it.
 *
 * An apportionment, not a measurement, and only ever used for bookkeeping: the stored
 * per-chunk figures exist so a resumed run can report what the document cost, and what
 * matters there is that they add back up to what was actually spent. They are divided by
 * each chunk's share of the batch's text, with the remainder given to the last chunk so
 * the total is exact rather than nearly right.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((running, weight) => running + weight, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    // Nothing to weigh by. Even shares, remainder last, same invariant.
    const even = Math.floor(total / weights.length);
    return weights.map((_weight, index) =>
      index === weights.length - 1 ? total - even * (weights.length - 1) : even,
    );
  }

  const shares = weights.map((weight) => Math.floor((total * weight) / sum));
  const assigned = shares.reduce((running, share) => running + share, 0);
  const last = shares.length - 1;
  shares[last] = (shares[last] ?? 0) + (total - assigned);
  return shares;
}

/** Re-exported so callers sizing a batch do not have to reach into the chunker. */
export { estimateTokens };
