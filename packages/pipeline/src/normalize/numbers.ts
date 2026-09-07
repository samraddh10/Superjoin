/**
 * Numbers and units.
 *
 * Plan section 5.1: deterministic TypeScript, decimal.js arithmetic over decimal strings,
 * both the raw and the normalized form stored, and the transformation recorded. Nothing
 * here is a model call, and nothing here goes through a JavaScript number.
 *
 * Three rules in that section are prohibitions rather than features, and they are the
 * reason this file is longer than a multiplication table would be:
 *
 *   - Currencies are never converted without an explicit rate, so a figure in INR and a
 *     figure in USD are incomparable, not merely different.
 *   - A percentage and a percentage point are different quantities. "Margin rose to 1.6%"
 *     and "margin rose by 1.6 pp" say different things, and treating either as the other
 *     manufactures agreement or conflict out of nothing.
 *   - Rounding compatibility comes from the precision of the source, not from a blanket
 *     tolerance. 8,142 Cr agrees with 81,415 million because the first is rounded to the
 *     crore; the same absolute gap between two figures each printed to the million would
 *     be a real difference.
 */

import { Decimal } from 'decimal.js';

/** Multipliers for the scale words the collections actually use. */
const SCALE_MULTIPLIERS = new Map<string, string>([
  ['hundred', '100'],
  ['thousand', '1000'],
  ['k', '1000'],
  ['lakh', '100000'],
  ['lakhs', '100000'],
  ['lac', '100000'],
  ['lacs', '100000'],
  ['million', '1000000'],
  ['mn', '1000000'],
  ['mln', '1000000'],
  ['m', '1000000'],
  ['crore', '10000000'],
  ['crores', '10000000'],
  ['cr', '10000000'],
  ['billion', '1000000000'],
  ['bn', '1000000000'],
  ['trillion', '1000000000000'],
  ['tn', '1000000000000'],
]);

/** Currency symbols and words, mapped to the ISO code recorded on a claim. */
const CURRENCY_TOKENS = new Map<string, string>([
  ['₹', 'INR'],
  ['rs', 'INR'],
  ['rs.', 'INR'],
  ['inr', 'INR'],
  ['rupees', 'INR'],
  ['$', 'USD'],
  ['us$', 'USD'],
  ['usd', 'USD'],
  ['€', 'EUR'],
  ['eur', 'EUR'],
  ['£', 'GBP'],
  ['gbp', 'GBP'],
]);

/**
 * Units that are proportions rather than quantities.
 *
 * Separated because their normalized form is themselves: multiplying a percentage by a
 * scale word is meaningless, and the distinction between the two members of this map is
 * the one plan 5.1 forbids collapsing.
 */
const PROPORTION_UNITS = new Map<string, string>([
  ['%', 'percent'],
  ['percent', 'percent'],
  ['pct', 'percent'],
  ['percentage', 'percent'],
  ['bps', 'basis_point'],
  ['basis points', 'basis_point'],
  ['pp', 'percentage_point'],
  ['ppt', 'percentage_point'],
  ['percentage point', 'percentage_point'],
  ['percentage points', 'percentage_point'],
]);

export type ValueKind = 'point' | 'range' | 'approximate';

export interface ParsedNumber {
  /** The figure as written, sign applied, before any scale multiplier. */
  readonly value: Decimal;
  readonly kind: ValueKind;
  /** Present when the source stated a span rather than a figure. */
  readonly rangeLow: Decimal | null;
  readonly rangeHigh: Decimal | null;
  /** Digits after the decimal point in the source, which is what sets rounding. */
  readonly decimalPlaces: number;
  /** Scale word found in the text itself, if any. Null leaves the claim's own value. */
  readonly scale: string | null;
  readonly currency: string | null;
  readonly unit: string | null;
  readonly negative: boolean;
}

/**
 * Reads a figure as the document printed it.
 *
 * Handles the Indian grouping (1,23,456), the western one (123,456), parentheses for
 * negatives, a leading or trailing currency token, a trailing scale word, a trailing
 * percent or percentage-point marker, an approximation marker, and a range.
 *
 * Returns null rather than guessing when the string carries no figure. A caller with a
 * `numeric_value` already in hand does not need this at all; it exists for the raw text,
 * where the units and the rounding actually live.
 */
export function parseNumeric(raw: string): ParsedNumber | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  // Parentheses around the whole figure are the accounting convention for a loss. The
  // gold set records these negative, and so does everything downstream.
  const parenthesised = /^\(.*\)$/.test(text);
  const body = parenthesised ? text.slice(1, -1) : text;

  const approximate = /\b(about|approx\.?|approximately|around|circa|~)\b|^~/.test(body);

  const currency = findCurrency(body);
  const proportion = findProportion(body);
  const scale = proportion === null ? findScale(body) : null;

  const numbers = [...body.matchAll(/-?\d+(?:[.,]\d+)*(?:\.\d+)?/g)].map((match) => match[0]);
  if (numbers.length === 0) return null;

  // A range needs a separator between the two figures, not merely two of them: "8,142 Cr
  // in FY24" contains a year as well as a value.
  const isRange =
    numbers.length >= 2 && /\d\s*(?:-|to|–|—)\s*\d/.test(body.replace(/,/g, ''));

  const first = toDecimal(numbers[0]!);
  if (first === null) return null;

  const second = isRange ? toDecimal(numbers[1]!) : null;

  const sign = parenthesised || /^-/.test(body.trim()) ? -1 : 1;
  const signed = first.times(sign);

  return {
    value: isRange && second !== null ? signed.plus(second.times(sign)).dividedBy(2) : signed,
    kind: isRange && second !== null ? 'range' : approximate ? 'approximate' : 'point',
    rangeLow: isRange && second !== null ? signed : null,
    rangeHigh: isRange && second !== null ? second.times(sign) : null,
    decimalPlaces: decimalPlacesOf(numbers[0]!),
    scale,
    currency,
    unit: proportion,
    negative: signed.isNegative(),
  };
}

function toDecimal(token: string): Decimal | null {
  // Grouping separators are dropped wholesale. Both the Indian and the western
  // conventions use the comma for grouping and the point for the fraction, so this is
  // unambiguous for the collections in scope; a locale that reverses them would need the
  // convention supplied rather than inferred.
  const cleaned = token.replace(/,/g, '');
  try {
    const value = new Decimal(cleaned);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

function decimalPlacesOf(token: string): number {
  const fraction = /\.(\d+)$/.exec(token.replace(/,/g, ''));
  return fraction?.[1]?.length ?? 0;
}

function findCurrency(text: string): string | null {
  for (const [token, code] of CURRENCY_TOKENS) {
    if (/^[a-z.$]+$/.test(token)) {
      if (new RegExp(`(^|\\s)${escape(token)}(\\s|\\d|$)`).test(text)) return code;
    } else if (text.includes(token)) {
      return code;
    }
  }
  return null;
}

function findProportion(text: string): string | null {
  // Longest first, so "percentage points" is not read as "percentage".
  const tokens = [...PROPORTION_UNITS.keys()].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const pattern = /^[a-z ]+$/.test(token)
      ? new RegExp(`(^|[\\s\\d])${escape(token)}(\\s|$)`)
      : new RegExp(escape(token));
    if (pattern.test(text)) return PROPORTION_UNITS.get(token)!;
  }
  return null;
}

function findScale(text: string): string | null {
  const tokens = [...SCALE_MULTIPLIERS.keys()].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    if (new RegExp(`(^|[\\s\\d])${escape(token)}\\b`).test(text)) return token;
  }
  return null;
}

function escape(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One step of the transformation, kept so the result is auditable (plan 5.1 and 6.4). */
export interface NormalizationStep {
  readonly step: string;
  readonly from: string;
  readonly to: string;
  readonly factor?: string;
}

export interface NormalizedValue {
  /** The figure in base units, as a decimal string. Never a JavaScript number. */
  readonly value: string;
  /**
   * What the figure is now in. A currency code for money, `percent` or
   * `percentage_point` for proportions, the source unit for a count of things, and
   * `count` when the source named nothing.
   */
  readonly unit: string;
  /** Half the last recorded digit, in base units: the width of the rounding interval. */
  readonly roundingHalfWidth: string;
  readonly steps: readonly NormalizationStep[];
}

export interface NormalizeInput {
  /** The value at source precision, as a decimal string. */
  readonly numericValue: string;
  readonly scale?: string | null;
  readonly unit?: string | null;
  readonly currency?: string | null;
}

/**
 * Converts a claim's value to a common basis.
 *
 * Scale words multiply; currencies never convert. The result carries the steps taken, so
 * a reviewer looking at a `corroborates` verdict can see that the agreement came from a
 * crore-to-rupee multiplication and not from a tolerance wide enough to swallow the
 * difference.
 */
export function normalizeValue(input: NormalizeInput): NormalizedValue | null {
  let value: Decimal;
  try {
    value = new Decimal(input.numericValue);
  } catch {
    return null;
  }
  if (!value.isFinite()) return null;

  const steps: NormalizationStep[] = [];
  const decimals = decimalPlacesOf(input.numericValue);
  const proportion = input.unit === null || input.unit === undefined
    ? null
    : (PROPORTION_UNITS.get(input.unit.trim().toLowerCase()) ?? null);

  if (proportion !== null) {
    // A proportion is already in its own basis. Basis points are converted to percent,
    // which is a change of unit within one quantity; a percentage point is left alone,
    // because it is a different quantity and has nowhere to be converted to.
    if (proportion === 'basis_point') {
      const converted = value.dividedBy(100);
      steps.push({ step: 'basis_points_to_percent', from: value.toString(), to: converted.toString(), factor: '0.01' });
      return {
        value: converted.toString(),
        unit: 'percent',
        roundingHalfWidth: halfWidth(decimals).dividedBy(100).toString(),
        steps,
      };
    }

    return {
      value: value.toString(),
      unit: proportion,
      roundingHalfWidth: halfWidth(decimals).toString(),
      steps,
    };
  }

  const scaleKey = input.scale?.trim().toLowerCase() ?? null;
  const multiplier = scaleKey === null ? null : (SCALE_MULTIPLIERS.get(scaleKey) ?? null);

  let scaled = value;
  if (multiplier !== null) {
    scaled = value.times(new Decimal(multiplier));
    steps.push({
      step: 'apply_scale',
      from: `${value.toString()} ${scaleKey}`,
      to: scaled.toString(),
      factor: multiplier,
    });
  } else if (scaleKey !== null && scaleKey !== '') {
    // An unrecognised scale word is left as part of the unit rather than ignored.
    // Silently dropping it would report a figure a million times too small as if it were
    // comparable, which is worse than declining to compare.
    return {
      value: value.toString(),
      unit: `${input.currency ?? input.unit ?? 'count'}/${scaleKey}`,
      roundingHalfWidth: halfWidth(decimals).toString(),
      steps: [{ step: 'unrecognised_scale', from: scaleKey, to: 'left unconverted' }],
    };
  }

  const unit =
    input.currency !== null && input.currency !== undefined && input.currency !== ''
      ? input.currency
      : input.unit !== null && input.unit !== undefined && input.unit !== ''
        ? input.unit
        : 'count';

  return {
    value: scaled.toString(),
    unit,
    roundingHalfWidth: halfWidth(decimals)
      .times(multiplier === null ? 1 : new Decimal(multiplier))
      .toString(),
    steps,
  };
}

/** Half of the smallest digit the source recorded: the most it could have been rounded by. */
function halfWidth(decimalPlaces: number): Decimal {
  return new Decimal(10).pow(-decimalPlaces).dividedBy(2);
}

export type ValueAgreement = 'agree' | 'disagree' | 'incomparable';

export interface ValueComparison {
  readonly agreement: ValueAgreement;
  /** Why, in a phrase, for the rationale and for the deterministic-checks record. */
  readonly reason: string;
  /** Absolute difference in base units, when one could be taken. */
  readonly difference: string | null;
  /** The gap as a share of the larger figure, when both are non-zero. */
  readonly relativeDifference: string | null;
  /** The intervals the two source precisions imply, when they were comparable. */
  readonly intervalA: readonly [string, string] | null;
  readonly intervalB: readonly [string, string] | null;
}

/**
 * Compares two normalized figures using the precision each source recorded.
 *
 * Agreement means the intervals the two roundings imply overlap, which is a claim about
 * the sources rather than about a tolerance we chose. Disagreement means they do not.
 * Neither verdict is a relationship label: plan 6.2 is explicit that these checks are
 * inputs to classification, not proof of either conclusion.
 */
export function compareValues(a: NormalizedValue, b: NormalizedValue): ValueComparison {
  if (a.unit !== b.unit) {
    return {
      agreement: 'incomparable',
      reason:
        isCurrency(a.unit) && isCurrency(b.unit)
          ? `${a.unit} and ${b.unit} need an explicit exchange-rate basis, which the documents do not supply`
          : `${a.unit} and ${b.unit} are different quantities`,
      difference: null,
      relativeDifference: null,
      intervalA: null,
      intervalB: null,
    };
  }

  const valueA = new Decimal(a.value);
  const valueB = new Decimal(b.value);
  const lowA = valueA.minus(a.roundingHalfWidth);
  const highA = valueA.plus(a.roundingHalfWidth);
  const lowB = valueB.minus(b.roundingHalfWidth);
  const highB = valueB.plus(b.roundingHalfWidth);

  // Closed intervals. Two figures whose rounding intervals meet exactly at one point are
  // consistent with each other, and the crore-to-million case in the collection is
  // precisely that: 8,142 Cr and 81,415 million touch and do not overlap.
  const overlap = lowA.lessThanOrEqualTo(highB) && lowB.lessThanOrEqualTo(highA);

  const difference = valueA.minus(valueB).abs();
  const larger = Decimal.max(valueA.abs(), valueB.abs());

  return {
    agreement: overlap ? 'agree' : 'disagree',
    reason: overlap
      ? 'the intervals implied by each source rounding overlap'
      : `the figures differ by ${difference.toString()} ${a.unit}, more than either rounding allows`,
    difference: difference.toString(),
    relativeDifference: larger.isZero() ? null : difference.dividedBy(larger).toString(),
    intervalA: [lowA.toString(), highA.toString()],
    intervalB: [lowB.toString(), highB.toString()],
  };
}

function isCurrency(unit: string): boolean {
  return [...CURRENCY_TOKENS.values()].includes(unit);
}

/**
 * Whether one figure is a clean power-of-ten multiple of the other.
 *
 * Reported as a check rather than acted on. A ratio of exactly 10, 100 or 10,000,000
 * between two otherwise identical claims is nearly always a scale word that was misread
 * on one side, and saying so gives the classifier something better to work with than
 * "these numbers differ".
 */
export function scaleRatio(a: NormalizedValue, b: NormalizedValue): string | null {
  const valueA = new Decimal(a.value);
  const valueB = new Decimal(b.value);
  if (valueA.isZero() || valueB.isZero()) return null;

  const ratio = valueA.dividedBy(valueB).abs();
  const log = Decimal.log10(ratio);

  return log.isInteger() && !log.isZero() ? ratio.toString() : null;
}

/**
 * Significant digits in a figure as the source wrote it.
 *
 * Leading zeros do not count and trailing zeros before the decimal point are ambiguous in
 * any notation, so "8,142" is four and "8,000" is read as four rather than one. The
 * ambiguity is real and is why rounding compatibility is decided by `roundingHalfWidth`,
 * which comes from the decimal places actually printed; this value is stored because plan
 * 1.2 asks for it and because it is the figure a reviewer expects to see.
 */
export function significantDigits(value: string): number {
  const digits = value.replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits.length;
}
