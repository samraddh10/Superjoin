/**
 * The Phase 8.3 freeze, enforced.
 *
 * Plan 8.3 requires prompts and normalization rules to be frozen before the held-out
 * collection is processed for the first time. A freeze that lives only in a sentence in a
 * README is not one: the whole point is that nobody can change a prompt between the
 * baseline and the generalization run without it being obvious, including by accident and
 * including me.
 *
 * So `evaluation/freeze.json` records the frozen values and this test compares them with
 * the constants the pipeline actually uses. Changing a prompt now fails the suite.
 *
 * The failure is not a defect to be silenced. Editing freeze.json to match a changed
 * constant is not a fix — it is a *new* freeze, and it invalidates any generalization
 * result measured under the old one until the held-out collection is processed again.
 */

import { readFile } from 'node:fs/promises';

import {
  CHECKS_VERSION,
  COMPARISON_METHOD_VERSION,
  ENTITY_MATCH_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  NORMALIZATION_VERSION,
  PARSER_VERSION,
  RELATIONSHIP_PROMPT_VERSION,
  TRANSCRIPTION_PROMPT_VERSION,
} from '@superjoin/pipeline';
import { describe, expect, it } from 'vitest';

const freeze = JSON.parse(await readFile('evaluation/freeze.json', 'utf8')) as {
  versions: Record<string, string>;
  model: { llm: string; embedding: string; embedding_dimensions: number };
};

/** Every version the pipeline stamps onto a run or a relationship. */
const live: Record<string, string> = {
  PARSER_VERSION,
  TRANSCRIPTION_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  NORMALIZATION_VERSION,
  ENTITY_MATCH_PROMPT_VERSION,
  CHECKS_VERSION,
  RELATIONSHIP_PROMPT_VERSION,
  COMPARISON_METHOD_VERSION,
};

describe('the generalization freeze', () => {
  it('covers every version the pipeline records', () => {
    // A constant added later but left out of the freeze would be silently unfrozen, which
    // is the one way this check could pass while meaning nothing.
    expect(Object.keys(freeze.versions).sort()).toEqual(Object.keys(live).sort());
  });

  it.each(Object.keys(live))('%s matches the frozen value', (name) => {
    expect(live[name]).toBe(freeze.versions[name]);
  });

  it('keeps the composed comparison version consistent with its parts', () => {
    // COMPARISON_METHOD_VERSION is built from the other two, so freezing it separately
    // would let the parts drift while the composite still matched a stale string.
    expect(COMPARISON_METHOD_VERSION).toBe(`${CHECKS_VERSION}+${RELATIONSHIP_PROMPT_VERSION}`);
  });

  it('records the models the baseline was measured under', () => {
    // Not asserted against the environment: a reviewer may point the system at another
    // model deliberately. It is recorded so a later result is comparable, or visibly not.
    expect(freeze.model.llm).toMatch(/:free$/);
    expect(freeze.model.embedding_dimensions).toBe(768);
  });
});
