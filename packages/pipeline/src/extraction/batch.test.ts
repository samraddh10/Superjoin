/**
 * What packing chunks together is allowed to change, and what it is not.
 *
 * The saving is real but small; a citation resolved to the wrong block is not small. So
 * most of these are about the handles: that they stop colliding when several passages
 * share a request, that they still resolve to the block the chunk meant, and that a lone
 * passage is left exactly as it was.
 */

import { describe, expect, it } from 'vitest';

import type { Chunk } from '../parsing/chunk.ts';
import { apportion, planBatches } from './batch.ts';

const chunk = (index: number, tokens: number, blocks = 1): Chunk => ({
  index,
  text: [
    `[page ${index}]`,
    '',
    ...Array.from({ length: blocks }, (_unused, block) => `[B${block + 1}]\nRevenue was ${index}.`),
  ].join('\n'),
  heading: null,
  sourceBlockIds: Array.from({ length: blocks }, (_unused, block) => `block-${index}-${block}`),
  blockRefs: Array.from({ length: blocks }, (_unused, block) => ({
    ref: `B${block + 1}`,
    sourceBlockId: `block-${index}-${block}`,
  })),
  physicalPages: [index],
  estimatedTokens: tokens,
});

describe('planBatches', () => {
  it('packs small chunks together and stops at the token ceiling', () => {
    const batches = planBatches(
      [chunk(1, 400), chunk(2, 400), chunk(3, 400), chunk(4, 400)],
      { maxInputTokens: 900, maxChunks: 10 },
    );

    expect(batches.map((batch) => batch.passages.length)).toEqual([2, 2]);
  });

  it('stops at the passage ceiling even when the tokens would fit', () => {
    const batches = planBatches(
      [chunk(1, 10), chunk(2, 10), chunk(3, 10)],
      { maxInputTokens: 100_000, maxChunks: 2 },
    );

    expect(batches.map((batch) => batch.passages.length)).toEqual([2, 1]);
  });

  it('sends an oversized chunk on its own rather than refusing it', () => {
    // The ceiling governs what may be added to a request, not what may be asked at all.
    const batches = planBatches([chunk(1, 9000), chunk(2, 100)], { maxInputTokens: 1000 });

    expect(batches.map((batch) => batch.passages.length)).toEqual([1, 1]);
  });

  it('keeps chunks in reading order', () => {
    // Not bin-packed. A batch whose passages come from page 3 and page 40 would fit
    // marginally more into a request and would read as unrelated fragments.
    const batches = planBatches([chunk(1, 100), chunk(2, 100), chunk(3, 100)], {
      maxInputTokens: 250,
    });

    expect(batches.flatMap((batch) => batch.passages.map((passage) => passage.chunk.index))).toEqual([
      1, 2, 3,
    ]);
  });

  it('leaves a lone passage exactly as the chunk wrote it', () => {
    const only = chunk(1, 100, 2);
    const [batch] = planBatches([only], { maxChunks: 1 });

    expect(batch?.passages[0]?.text).toBe(only.text);
    expect(batch?.passages[0]?.handles).toEqual(['B1', 'B2']);
    expect(batch?.refToBlockId.get('B1')).toBe('block-1-0');
  });

  it('makes handles unique across a batch, in the text and in the lookup', () => {
    // Both chunks call their first block B1. Sent together, one of those has to give, or
    // a citation to B1 resolves to whichever block happened to be registered last.
    const [batch] = planBatches([chunk(1, 100, 2), chunk(2, 100)], { maxInputTokens: 1000 });

    expect(batch?.passages[0]?.handles).toEqual(['P1B1', 'P1B2']);
    expect(batch?.passages[1]?.handles).toEqual(['P2B1']);

    expect(batch?.refToBlockId.get('P1B1')).toBe('block-1-0');
    expect(batch?.refToBlockId.get('P2B1')).toBe('block-2-0');
    expect(batch?.refToBlockId.has('B1')).toBe(false);

    expect(batch?.passages[0]?.text).toContain('[P1B1]');
    expect(batch?.passages[0]?.text).not.toContain('\n[B1]\n');
    expect(batch?.passages[1]?.text).toContain('[P2B1]');
  });

  it('rewrites only the handle labels, not text that happens to look like one', () => {
    const withProse: Chunk = {
      ...chunk(1, 100),
      text: '[page 1]\n\n[B1]\nThe note marked [B1] in the table is not a handle.',
    };

    const [batch] = planBatches([withProse, chunk(2, 100)], { maxInputTokens: 1000 });

    expect(batch?.passages[0]?.text).toContain('[P1B1]\nThe note');
    expect(batch?.passages[0]?.text).toContain('marked [B1] in the table');
  });
});

describe('apportion', () => {
  it('splits by weight and keeps the total exact', () => {
    const shares = apportion(100, [1, 1, 2]);

    expect(shares.reduce((total, share) => total + share, 0)).toBe(100);
    expect(shares[0]).toBe(25);
    expect(shares[1]).toBe(25);
  });

  it('gives the rounding remainder to the last share rather than losing it', () => {
    // The per-chunk figure is bookkeeping; what has to hold is that the shares add back
    // up to what the request actually cost.
    const shares = apportion(10, [1, 1, 1]);

    expect(shares).toEqual([3, 3, 4]);
  });

  it('falls back to even shares when there is nothing to weigh by', () => {
    expect(apportion(9, [0, 0, 0])).toEqual([3, 3, 3]);
    expect(apportion(0, [5, 5])).toEqual([0, 0]);
  });
});
