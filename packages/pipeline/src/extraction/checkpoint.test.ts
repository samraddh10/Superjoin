/**
 * What the resume key is allowed to ignore.
 *
 * The cache is only safe if a hit means the question is the same question. These check the
 * dimensions where a stale hit would be a wrong answer rather than a missing one: the
 * words, the blocks the citations resolve to, the vocabulary in the prompt, the prompt
 * itself, and the model asked.
 */

import { describe, expect, it } from 'vitest';

import type { Chunk } from '../parsing/chunk.ts';
import { chunkFingerprint, type ExtractionIdentity } from './checkpoint.ts';

const chunk = (overrides: Partial<Chunk> = {}): Chunk => ({
  index: 0,
  text: '[B1] Revenue from services was 8,142 Cr in FY24.',
  heading: 'Financial highlights',
  sourceBlockIds: ['block-1'],
  blockRefs: [{ ref: 'B1', sourceBlockId: 'block-1' }],
  physicalPages: [4],
  estimatedTokens: 12,
  ...overrides,
});

const identity = (overrides: Partial<ExtractionIdentity> = {}): ExtractionIdentity => ({
  promptVersion: 'claim-extract@2',
  modelName: 'test/model',
  vocabulary: 'revenue_from_services (INR crore)',
  ...overrides,
});

describe('chunkFingerprint', () => {
  it('is stable across two readings of the same chunk', () => {
    expect(chunkFingerprint(chunk(), identity())).toBe(chunkFingerprint(chunk(), identity()));
  });

  it('changes when the text does', () => {
    expect(chunkFingerprint(chunk({ text: 'something else' }), identity())).not.toBe(
      chunkFingerprint(chunk(), identity()),
    );
  });

  it('changes when a handle resolves to a different block', () => {
    // The words can be identical while `B1` points somewhere else — a re-parse that
    // renumbers blocks does exactly that. Serving the old claims would attach verified
    // citations to material they were never checked against.
    const moved = chunk({ blockRefs: [{ ref: 'B1', sourceBlockId: 'block-9' }] });

    expect(chunkFingerprint(moved, identity())).not.toBe(chunkFingerprint(chunk(), identity()));
  });

  it('changes when the vocabulary shown alongside it does', () => {
    // The registry is part of the prompt, so two runs under two registries are two
    // different questions however alike the chunk looks.
    expect(chunkFingerprint(chunk(), identity({ vocabulary: 'revenue (INR)' }))).not.toBe(
      chunkFingerprint(chunk(), identity()),
    );
  });

  it('changes with the prompt version and the model', () => {
    // A cached answer is only an answer to the question that was asked. A new prompt or a
    // different model is a different question, however identical the chunk.
    const base = chunkFingerprint(chunk(), identity());

    expect(chunkFingerprint(chunk(), identity({ promptVersion: 'claim-extract@3' }))).not.toBe(base);
    expect(chunkFingerprint(chunk(), identity({ modelName: 'other/model' }))).not.toBe(base);
  });

  it('ignores the chunk index, which a re-parse may renumber', () => {
    // Identity is what the model was shown, not where it happened to sit in the document.
    expect(chunkFingerprint(chunk({ index: 7 }), identity())).toBe(
      chunkFingerprint(chunk(), identity()),
    );
  });
});
