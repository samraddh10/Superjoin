import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bindToAxisLabels, columnPitch, type Positioned } from './axis-binding.ts';

const at = (text: string, centerX: number): Positioned => ({ text, centerX });

/** Five columns on a 20pt pitch, the shape of every FY chart in the collection. */
const FY_AXIS = [at('FY20', 100), at('FY21', 120), at('FY22', 140), at('FY23', 160), at('FY24', 180)];

describe('columnPitch', () => {
  it('measures the spacing of an evenly spaced axis', () => {
    assert.equal(columnPitch(FY_AXIS), 20);
  });

  it('ignores a single outlying gap rather than averaging it in', () => {
    // A label picked up from a neighbouring chart would drag a mean far enough to make
    // every threshold meaningless. The median holds.
    assert.equal(columnPitch([...FY_AXIS, at('FY25', 900)]), 20);
  });

  it('returns null when there is nothing to measure', () => {
    assert.equal(columnPitch([]), null);
    assert.equal(columnPitch([at('FY20', 100)]), null);
  });
});

describe('bindToAxisLabels', () => {
  it('binds values that sit over their columns', () => {
    const bound = bindToAxisLabels([at('(2,532)', 101), at('(4,039)', 159)], FY_AXIS);
    assert.equal(bound[0]?.label?.text, 'FY20');
    assert.equal(bound[0]?.ambiguous, false);
    assert.equal(bound[1]?.label?.text, 'FY23');
    assert.equal(bound[1]?.ambiguous, false);
  });

  it('refuses to guess when a value sits midway between two columns', () => {
    // The failure mode that matters. Returning FY20 here would be a coin flip presented
    // as a fact, which is exactly what F1 did.
    const [binding] = bindToAxisLabels([at('999', 110)], FY_AXIS);
    assert.equal(binding?.label, null);
    assert.equal(binding?.ambiguous, true);
    assert.match(binding?.reason ?? '', /sits between "FY20" and "FY21"/);
  });

  it('refuses a value that is not near any column', () => {
    const [binding] = bindToAxisLabels([at('999', 300)], FY_AXIS);
    assert.equal(binding?.label, null);
    assert.equal(binding?.ambiguous, true);
    assert.match(binding?.reason ?? '', /more than half the 20.0pt column pitch/);
  });

  it('flags every value when the page yielded no axis at all', () => {
    const [binding] = bindToAxisLabels([at('(2,532)', 101)], []);
    assert.equal(binding?.label, null);
    assert.equal(binding?.ambiguous, true);
    assert.match(binding?.reason ?? '', /no axis labels/);
  });

  it('reports a lone label as a match but never as an unambiguous one', () => {
    // One label gives no pitch, so the match cannot be qualified. It is surfaced for a
    // reviewer rather than discarded, but it must not read as verified.
    const [binding] = bindToAxisLabels([at('(2,532)', 101)], [at('FY20', 100)]);
    assert.equal(binding?.label?.text, 'FY20');
    assert.equal(binding?.ambiguous, true);
    assert.match(binding?.reason ?? '', /only one axis label/);
  });

  it('leaves the caller free to reject on delta as well as on the flag', () => {
    const [binding] = bindToAxisLabels([at('(2,532)', 101)], FY_AXIS);
    assert.equal(binding?.deltaX, 1);
  });
});
