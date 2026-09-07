import { describe, expect, it } from 'vitest';

import { chunkSourceBlocks, estimateTokens, type ChunkSourceBlock } from './chunk.ts';

const block = (
  id: string,
  content: string,
  overrides: Partial<ChunkSourceBlock> = {},
): ChunkSourceBlock => ({
  id,
  physicalPage: 5,
  printedPageLabel: '10-11',
  blockType: 'paragraph',
  content,
  ...overrides,
});

describe('carrying context into a chunk', () => {
  it('puts the section heading in the chunk text', () => {
    // A row reading "72,236" means nothing without the heading above it. Dropping the
    // heading invites the model to invent the context it needs.
    const chunks = chunkSourceBlocks([
      block('h', 'Consolidated performance', { blockType: 'heading' }),
      block('b', 'Revenue from services was 72,236 million.'),
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe('Consolidated performance');
    expect(chunks[0]?.text).toContain('[section: Consolidated performance]');
    expect(chunks[0]?.text).toContain('72,236');
  });

  it('names the physical page and the printed label', () => {
    // Evidence keys off the physical page; the printed label is what a reader holding
    // the original filing will actually look for.
    const chunks = chunkSourceBlocks([block('b', 'Some narrative text.')]);
    expect(chunks[0]?.text).toContain('page 5');
    expect(chunks[0]?.text).toContain('printed 10-11');
  });

  it('omits the printed label when there is none', () => {
    const chunks = chunkSourceBlocks([block('b', 'Text.', { printedPageLabel: null })]);
    expect(chunks[0]?.text).toContain('page 5');
    expect(chunks[0]?.text).not.toContain('printed');
  });

  it('keeps a heading in force across the blocks that follow it', () => {
    const chunks = chunkSourceBlocks([
      block('h', 'Directors', { blockType: 'heading' }),
      block('a', 'First entry.'),
      block('b', 'Second entry.'),
    ]);
    expect(chunks.every((chunk) => chunk.heading === 'Directors')).toBe(true);
  });

  it('replaces the heading when a new one appears', () => {
    const chunks = chunkSourceBlocks([
      block('h1', 'Board of Directors', { blockType: 'heading' }),
      block('a', 'Deepak Kapoor, Chairperson.'),
      block('h2', 'Key Managerial Personnel', { blockType: 'heading' }),
      block('b', 'Amit Agarwal, Chief Financial Officer.'),
    ]);

    // The section boundary is what stops the CFO being read under the board heading,
    // which is failure F2 arriving by a different route.
    const cfoChunk = chunks.find((chunk) => chunk.text.includes('Amit Agarwal'));
    expect(cfoChunk?.heading).toBe('Key Managerial Personnel');
  });
});

describe('mapping back to sources', () => {
  it('records every block a chunk drew from', () => {
    const chunks = chunkSourceBlocks([block('a', 'First.'), block('b', 'Second.')]);
    expect(chunks[0]?.sourceBlockIds).toEqual(['a', 'b']);
  });

  it('never spans two pages in one chunk', () => {
    // A chunk covering two pages makes a claim's page ambiguous at exactly the moment it
    // matters.
    const chunks = chunkSourceBlocks([
      block('a', 'On page five.', { physicalPage: 5 }),
      block('b', 'On page six.', { physicalPage: 6 }),
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.physicalPages).toEqual([5]);
    expect(chunks[1]?.physicalPages).toEqual([6]);
  });
});

describe('sizing', () => {
  it('starts a new chunk once the target is passed', () => {
    const long = 'word '.repeat(400); // roughly 500 tokens
    const chunks = chunkSourceBlocks(
      [block('a', long), block('b', long), block('c', long)],
      { targetTokens: 600 },
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits an oversized block on line boundaries, not mid-row', () => {
    // The oversized blocks in this collection are tables. A row cut in half produces a
    // value with no header and a header with no value, and both read as complete.
    const rows = Array.from({ length: 60 }, (_, i) => `Row ${i} | 1,234 | 5,678 | 9,012`);
    const chunks = chunkSourceBlocks([block('t', rows.join('\n'), { blockType: 'table' })], {
      targetTokens: 100,
      maxTokens: 150,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const body = chunk.text.split('\n').filter((line) => line.startsWith('Row '));
      for (const line of body) {
        // Every row that appears, appears whole.
        expect(line).toMatch(/^Row \d+ \| 1,234 \| 5,678 \| 9,012$/);
      }
    }
  });

  it('reports an estimated token count', () => {
    const chunks = chunkSourceBlocks([block('a', 'x'.repeat(400))]);
    expect(chunks[0]?.estimatedTokens).toBeGreaterThan(80);
  });

  it('skips blocks with no content', () => {
    expect(chunkSourceBlocks([block('a', '   ')])).toHaveLength(0);
  });

  it('returns nothing for no blocks', () => {
    expect(chunkSourceBlocks([])).toEqual([]);
  });
});

describe('estimateTokens', () => {
  it('approximates four characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});
