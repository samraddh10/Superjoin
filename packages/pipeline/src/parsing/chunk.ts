/**
 * Chunking for extraction.
 *
 * Plan section 3.3: chunk on headings and paragraph boundaries at roughly 1,000 to 2,000
 * tokens, carry section headings into each chunk, split large tables by rows while
 * repeating headers, and keep every chunk mapped back to its source blocks.
 *
 * There is no chunks table, deliberately. The plan's data model does not define one, and
 * a chunk is an input to extraction rather than evidence in its own right: what a claim
 * cites is a source block. Chunking is therefore a pure function over stored blocks and
 * can be re-run, re-tuned or replaced without a migration or a rewrite of stored rows.
 *
 * The heading carried into each chunk is the part that matters for correctness. A table
 * row reading "72,236" means nothing without "Revenue from services" above it and
 * "₹ million" beside it, and a chunk that drops the heading invites the model to invent
 * the context it needs.
 */

export interface ChunkSourceBlock {
  readonly id: string;
  readonly physicalPage: number;
  readonly printedPageLabel: string | null;
  readonly blockType: string;
  readonly content: string;
}

export interface Chunk {
  /** Ordinal within the document, for progress reporting and stable ordering. */
  readonly index: number;
  /** The text handed to the model, heading context included. */
  readonly text: string;
  /** Heading in force, repeated into the text as well so the model cannot miss it. */
  readonly heading: string | null;
  /** Every block this chunk drew from, so a claim can cite the right one. */
  readonly sourceBlockIds: readonly string[];
  /**
   * The short handles the chunk text labels its blocks with, and what each resolves to.
   *
   * Extraction cites `B2`, not a UUID. Two reasons, both practical: a model asked to
   * copy a 36-character identifier gets it wrong often enough to matter, and every one
   * of them it echoes back is spent tokens. The mapping stays here, so a citation is
   * resolved by lookup rather than trusted.
   */
  readonly blockRefs: readonly BlockRef[];
  /** Pages covered. Usually one; a chunk never spans a page silently. */
  readonly physicalPages: readonly number[];
  readonly estimatedTokens: number;
}

/** One `[B1]`-style handle and the source block it stands for. */
export interface BlockRef {
  readonly ref: string;
  readonly sourceBlockId: string;
}

export interface ChunkOptions {
  /** Target size in tokens. The plan's range is 1,000 to 2,000. */
  readonly targetTokens?: number;
  /** Hard ceiling, above which a block is split even mid-table. */
  readonly maxTokens?: number;
}

const DEFAULTS = {
  targetTokens: 1200,
  maxTokens: 2000,
} as const;

/**
 * Rough token count.
 *
 * Four characters per token is the usual English approximation and is deliberate here:
 * an exact count would need the model's tokenizer, and chunk sizing does not warrant
 * loading one. Being wrong by a fifth costs a slightly smaller chunk, not a wrong answer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Renders a chunk's text with its heading and page context in front of it. */
function render(heading: string | null, page: number, label: string | null, body: string): string {
  const location = label !== null ? `page ${page} (printed ${label})` : `page ${page}`;
  const parts = [`[${location}]`];
  if (heading !== null) parts.push(`[section: ${heading}]`);
  parts.push('', body);
  return parts.join('\n');
}

/**
 * Splits an oversized block into pieces on line boundaries.
 *
 * Lines, not characters, because the oversized blocks in this collection are tables and a
 * row cut in half is worse than useless: it produces a value with no row header and a
 * header with no value, both of which read as complete.
 */
function splitOversized(content: string, maxTokens: number): string[] {
  const lines = content.split('\n');
  const pieces: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const candidate = [...current, line].join('\n');
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      pieces.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) pieces.push(current.join('\n'));
  return pieces;
}

/**
 * Groups a document's source blocks into chunks.
 *
 * Blocks must arrive in reading order: by physical page, then by block index. A heading
 * block starts a new chunk and stays in force until the next heading, which is what keeps
 * a table attached to the section that names it.
 */
export function chunkSourceBlocks(
  blocks: readonly ChunkSourceBlock[],
  options: ChunkOptions = {},
): Chunk[] {
  const targetTokens = options.targetTokens ?? DEFAULTS.targetTokens;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;

  const chunks: Chunk[] = [];
  let heading: string | null = null;

  let buffer: string[] = [];
  let bufferIds: string[] = [];
  let bufferRefs: BlockRef[] = [];
  let bufferPage: number | null = null;
  let bufferLabel: string | null = null;

  const flush = () => {
    if (buffer.length === 0 || bufferPage === null) return;
    const body = buffer.join('\n\n');
    const text = render(heading, bufferPage, bufferLabel, body);
    chunks.push({
      index: chunks.length,
      text,
      heading,
      sourceBlockIds: [...bufferIds],
      blockRefs: [...bufferRefs],
      physicalPages: [bufferPage],
      estimatedTokens: estimateTokens(text),
    });
    buffer = [];
    bufferIds = [];
    bufferRefs = [];
  };

  /**
   * The handle this block carries inside the chunk being built.
   *
   * Numbered per chunk rather than per document, so a block split across two chunks is
   * `B1` in one and whatever its position makes it in the other. Nothing outside a
   * chunk reads these, and `blockRefs` travels with the text that uses them.
   */
  const refFor = (blockId: string): string => {
    const existing = bufferRefs.find((entry) => entry.sourceBlockId === blockId);
    if (existing !== undefined) return existing.ref;
    const ref = `B${bufferRefs.length + 1}`;
    bufferRefs.push({ ref, sourceBlockId: blockId });
    return ref;
  };

  for (const block of blocks) {
    const content = block.content.trim();
    if (content === '') continue;

    // A chunk never spans a page. Evidence keys off the physical page, and a chunk
    // covering two of them makes a claim's page ambiguous at exactly the moment it
    // matters.
    if (bufferPage !== null && block.physicalPage !== bufferPage) flush();

    bufferPage = block.physicalPage;
    bufferLabel = block.printedPageLabel;

    if (block.blockType === 'heading') {
      // The heading closes the previous chunk and opens the next, so a section boundary
      // is never buried in the middle of one.
      flush();
      heading = content;
      bufferPage = block.physicalPage;
      bufferLabel = block.printedPageLabel;
      continue;
    }

    for (const piece of splitOversized(content, maxTokens)) {
      const projected = estimateTokens([...buffer, piece].join('\n\n'));
      if (buffer.length > 0 && projected > targetTokens) flush();
      bufferPage = block.physicalPage;
      bufferLabel = block.printedPageLabel;
      // The handle is resolved after the possible flush, so a block carried into a new
      // chunk is renumbered there rather than referring to a label that chunk never used.
      buffer.push(`[${refFor(block.id)}]\n${piece}`);
      if (!bufferIds.includes(block.id)) bufferIds.push(block.id);
    }
  }

  flush();
  return chunks;
}
