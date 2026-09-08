/**
 * When extraction should stop early, and when it should keep going.
 *
 * The stage has two give-up ceilings because it faces two different failures. A run
 * against the Delhivery prospectus collapsed the distinction: four scattered schema
 * violations tripped a ceiling meant for rate limiting, and seventeen chunks — including
 * the restated financial statements, the densest pages in the document — were never
 * attempted. These tests fix the two runs of failures apart.
 */

import { describe, expect, it } from 'vitest';

import { ModelError } from '../model/index.ts';
import { classifyFailure } from './stage.ts';

describe('classifyFailure', () => {
  it('counts a rate limit as throttling, where further calls only burn quota', () => {
    const error = new ModelError('429 Too Many Requests', 'provider_rate_limited', true, 30, 429);
    expect(classifyFailure(error)).toBe('throttled');
  });

  it('counts an unreadable reply separately, because the next chunk may still succeed', () => {
    // The exact shape observed: Gemini answers a dense financial table with a null
    // claims field rather than the array the schema asks for.
    const error = new ModelError(
      'extraction did not match the schema after one repair: claims: Invalid input: expected array, received null',
      'schema_violation_after_repair',
      false,
    );
    expect(classifyFailure(error)).toBe('malformed');
  });

  it('counts a first-pass schema violation as malformed too', () => {
    const error = new ModelError('extraction did not match the schema', 'schema_violation', true);
    expect(classifyFailure(error)).toBe('malformed');
  });

  it('treats anything else as an ordinary failure, which keeps the stricter ceiling', () => {
    expect(classifyFailure(new ModelError('502 Bad Gateway', 'http_502', true, undefined, 502))).toBe(
      'other',
    );
    expect(classifyFailure(new Error('socket hang up'))).toBe('other');
    expect(classifyFailure('not an error at all')).toBe('other');
  });

  /**
   * The regression itself.
   *
   * Against the old code every one of these incremented the same counter, so the fourth
   * abandoned the document. Only the backstop may count them now.
   */
  it('does not let a run of schema flakes reach the throttle ceiling', () => {
    const flakes = Array.from(
      { length: 4 },
      () =>
        new ModelError(
          'extraction did not match the schema after one repair: claims: Invalid input: expected array, received null',
          'schema_violation_after_repair',
          false,
        ),
    );

    const strictRun = flakes.filter((error) => classifyFailure(error) !== 'malformed').length;

    expect(strictRun).toBe(0);
  });

  /**
   * The gap the first version of this fix opened.
   *
   * Two independent counters let a document alternating between throttling and bad JSON
   * fill neither, so it would work through every remaining chunk making calls that could
   * not succeed. This is the shape document 2 of the Delhivery collection actually hit:
   * three 429s and two schema violations interleaved.
   */
  it('counts a mixed run of failures somewhere, so alternating kinds still terminate', () => {
    const mixed = [
      new ModelError('429', 'provider_rate_limited', true, 51, 429),
      new ModelError('bad json', 'schema_violation_after_repair', false),
      new ModelError('429', 'provider_rate_limited', true, 51, 429),
      new ModelError('bad json', 'schema_violation_after_repair', false),
    ];

    // Every failure feeds the backstop, whatever kind it is.
    const backstopRun = mixed.filter((error) => classifyFailure(error) !== undefined).length;
    expect(backstopRun).toBe(mixed.length);

    // And the strict counter still sees the throttles, so quota protection is unchanged.
    const strictRun = mixed.filter((error) => classifyFailure(error) !== 'malformed').length;
    expect(strictRun).toBe(2);
  });
});
