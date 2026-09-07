/**
 * Binds chart values to their category labels by horizontal position.
 *
 * Failure F1 in `docs/difficult-pages.md`: on the adjusted-EBITDA chart of
 * `doc-02-annual-report` physical page 5, reading order yields FY20 = (2,533) and
 * FY21 = (2,532). The x-coordinates give the opposite, and `doc-01-prospectus`
 * physical page 43 confirms the coordinate answer independently, reporting (2,531.93)
 * for Fiscal 2020 and (2,532.83) for Fiscal 2021.
 *
 * What makes that failure dangerous is that it is silent. The two values differ by one
 * unit, so the wrong answer is entirely plausible and nothing downstream would question
 * it. Binding therefore reports its own ambiguity: a value that does not sit clearly in
 * one column is flagged, and the claim built from it is held at `needs_review` rather
 * than presented as verified.
 */

/** Anything carrying a horizontal midpoint can be bound. Keeps this independent of the PDF layer. */
export interface Positioned {
  readonly text: string;
  readonly centerX: number;
}

export interface Binding<L extends Positioned, V extends Positioned> {
  readonly value: V;
  /** Null when no label is a defensible match. */
  readonly label: L | null;
  /** Horizontal distance between the two midpoints, in PDF points. */
  readonly deltaX: number;
  /**
   * True when the binding should not be trusted on its own: either the value sits
   * between two columns, or it is too far from any of them.
   */
  readonly ambiguous: boolean;
  readonly reason: string | null;
}

/** A value must sit within this fraction of the column pitch to belong to a column. */
const MAX_DELTA_AS_PITCH_FRACTION = 0.5;

/** The runner-up must be at least this fraction of the pitch further away, or the choice is a coin flip. */
const MIN_SEPARATION_AS_PITCH_FRACTION = 0.25;

/**
 * Median gap between adjacent label midpoints.
 *
 * The median rather than the mean, because a chart with a gap in its categories, or a
 * stray label picked up from a neighbouring chart, would drag a mean far enough to
 * make every threshold meaningless.
 */
export function columnPitch(labels: readonly Positioned[]): number | null {
  if (labels.length < 2) return null;

  const centers = labels.map((label) => label.centerX).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < centers.length; i += 1) {
    gaps.push((centers[i] ?? 0) - (centers[i - 1] ?? 0));
  }

  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const pitch =
    gaps.length % 2 === 1
      ? (gaps[middle] ?? 0)
      : ((gaps[middle - 1] ?? 0) + (gaps[middle] ?? 0)) / 2;

  return pitch > 0 ? pitch : null;
}

/**
 * Binds each value to the label whose midpoint is nearest.
 *
 * Midpoints, not left edges: a chart centres a value over its column, and a value
 * string is usually wider than its label, so left edges are offset by half the
 * difference in width. On the F1 chart that offset is about 2 points against a column
 * pitch of 23, which is harmless there but not in general.
 */
export function bindToAxisLabels<L extends Positioned, V extends Positioned>(
  values: readonly V[],
  labels: readonly L[],
): Binding<L, V>[] {
  if (labels.length === 0) {
    return values.map((value) => ({
      value,
      label: null,
      deltaX: Number.POSITIVE_INFINITY,
      ambiguous: true,
      reason: 'no axis labels were found on this page',
    }));
  }

  const pitch = columnPitch(labels);

  return values.map((value) => {
    const ranked = labels
      .map((label) => ({ label, deltaX: Math.abs(value.centerX - label.centerX) }))
      .sort((a, b) => a.deltaX - b.deltaX);

    const nearest = ranked[0];
    if (nearest === undefined) {
      return { value, label: null, deltaX: Number.POSITIVE_INFINITY, ambiguous: true, reason: 'no axis labels were found on this page' };
    }

    // A single label gives nothing to measure a pitch against, so the match cannot be
    // qualified. Report it, but never as unambiguous.
    if (pitch === null) {
      return {
        value,
        label: nearest.label,
        deltaX: nearest.deltaX,
        ambiguous: true,
        reason: 'only one axis label was found, so column spacing could not be established',
      };
    }

    if (nearest.deltaX > pitch * MAX_DELTA_AS_PITCH_FRACTION) {
      return {
        value,
        label: null,
        deltaX: nearest.deltaX,
        ambiguous: true,
        reason: `nearest label ${JSON.stringify(nearest.label.text)} is ${nearest.deltaX.toFixed(1)}pt away, more than half the ${pitch.toFixed(1)}pt column pitch`,
      };
    }

    const runnerUp = ranked[1];
    if (runnerUp !== undefined && runnerUp.deltaX - nearest.deltaX < pitch * MIN_SEPARATION_AS_PITCH_FRACTION) {
      return {
        value,
        label: null,
        deltaX: nearest.deltaX,
        ambiguous: true,
        reason: `value sits between ${JSON.stringify(nearest.label.text)} and ${JSON.stringify(runnerUp.label.text)}, ${nearest.deltaX.toFixed(1)}pt and ${runnerUp.deltaX.toFixed(1)}pt away`,
      };
    }

    return { value, label: nearest.label, deltaX: nearest.deltaX, ambiguous: false, reason: null };
  });
}
