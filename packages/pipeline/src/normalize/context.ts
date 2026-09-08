/**
 * Context: periods, scopes and the differences between them.
 *
 * Plan section 5.2 asks for the reporting period to be tracked separately from the
 * publication date, for quarter and year, standalone and consolidated, geography,
 * segment, actual and estimate to be preserved, and for fiscal dates to be resolved
 * "only when the convention is supported by the document".
 *
 * That last clause is the one that shapes this file. An Indian filing's FY2024 runs from
 * April 2023 to March 2024, a US filer's may run to September, and a document that never
 * says which is not asking to be guessed at. So `resolvePeriod` takes the convention as an
 * argument, `detectFiscalConvention` reads it out of the document's own words, and a
 * period whose convention is unknown keeps its label and gets no dates. A null date here
 * is a recorded absence, and downstream code compares labels instead.
 *
 * The comparison side matters as much as the parsing. A difference of period or scope is
 * exactly what turns an apparent contradiction into a reconciliation, so
 * `compareContext` reports every dimension that differs rather than reducing them to a
 * single verdict.
 */

import type { AssertionStatus, PeriodType, Qualifier } from '../extraction/contract.ts';

/** Which months a fiscal year covers. Only what the collections in scope require. */
export type FiscalConvention = 'april-march' | 'january-december';

export interface ResolvedPeriod {
  readonly periodType: PeriodType;
  /** The label as the document wrote it, normalized in form but not in meaning. */
  readonly label: string | null;
  readonly start: Date | null;
  readonly end: Date | null;
  /** Why the dates are absent, when they are. Never a guess. */
  readonly note: string | null;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/**
 * Reads the fiscal convention out of the document's own text.
 *
 * "for the year ended March 31, 2024" states it; a bare "FY24" does not. Only sentences
 * that name the closing month count, which is why this looks for the phrase rather than
 * for the year.
 */
export function detectFiscalConvention(text: string): FiscalConvention | null {
  const lower = text.toLowerCase();

  if (/year\s+end(?:ed|ing)?[^.]{0,20}march\s*31/.test(lower)) return 'april-march';
  if (/year\s+end(?:ed|ing)?[^.]{0,20}december\s*31/.test(lower)) return 'january-december';
  // The Indian statutory phrasing, which names the span rather than the close.
  if (/april\s*1[^.]{0,30}march\s*31/.test(lower)) return 'april-march';

  return null;
}

interface ParsedLabel {
  readonly kind: PeriodType;
  /** The year the label ends in, on the fiscal convention it was written under. */
  readonly year: number | null;
  readonly quarter: number | null;
  readonly half: number | null;
  readonly month: number | null;
  readonly day: number | null;
}

/**
 * Reads the shape of a period label.
 *
 * Deliberately tolerant about form and strict about meaning: FY24, FY2024, fiscal 2024
 * and 2023-24 are the same label written four ways, while "2024" on its own is a calendar
 * year and is not silently promoted to a fiscal one.
 */
export function parsePeriodLabel(label: string): ParsedLabel | null {
  const text = label.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  const twoToFour = (value: string): number =>
    value.length === 2 ? 2000 + Number(value) : Number(value);

  const quarter = /\bq([1-4])\b/.exec(text);
  const half = /\bh([12])\b/.exec(text);
  const fiscal = /\b(?:fy|fiscal(?: year)?)\s*'?(\d{4}|\d{2})\b/.exec(text);
  // "2023-24" and "2023-2024" are the Indian filing form for one fiscal year.
  const span = /\b(\d{4})\s*[-–/]\s*(\d{2,4})\b/.exec(text);

  const monthName = MONTHS.findIndex((month) => text.includes(month));
  const dayMatch = /\b(\d{1,2})\b/.exec(text.replace(/\bq[1-4]\b|\bh[12]\b/g, ''));
  const calendar = /\b(?:cy)?\s*(\d{4})\b/.exec(text);

  const fiscalYear =
    fiscal !== null
      ? twoToFour(fiscal[1]!)
      : span !== null
        ? twoToFour(span[2]!)
        : null;

  if (quarter !== null) {
    return {
      kind: 'quarter',
      year: fiscalYear ?? (calendar !== null ? Number(calendar[1]) : null),
      quarter: Number(quarter[1]),
      half: null,
      month: null,
      day: null,
    };
  }

  if (half !== null) {
    return {
      kind: 'half_year',
      year: fiscalYear ?? (calendar !== null ? Number(calendar[1]) : null),
      quarter: null,
      half: Number(half[1]),
      month: null,
      day: null,
    };
  }

  if (monthName !== -1 && /\d{1,2}/.test(text) && calendar !== null) {
    return {
      kind: 'as_of_date',
      year: Number(calendar[1]),
      quarter: null,
      half: null,
      month: monthName + 1,
      day: dayMatch !== null ? Number(dayMatch[1]) : null,
    };
  }

  if (fiscalYear !== null) {
    return { kind: 'fiscal_year', year: fiscalYear, quarter: null, half: null, month: null, day: null };
  }

  if (calendar !== null) {
    return {
      kind: 'calendar_year',
      year: Number(calendar[1]),
      quarter: null,
      half: null,
      month: null,
      day: null,
    };
  }

  return null;
}

const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

/**
 * Resolves a period label to dates, when the document supports doing so.
 *
 * The convention is a parameter and not a default. Assuming April to March would be right
 * for the Delhivery collection and wrong the first time an unfamiliar PDF arrives, which
 * is exactly the case the whole exercise is about.
 */
export function resolvePeriod(
  label: string | null,
  declaredType: PeriodType | null,
  convention: FiscalConvention | null,
): ResolvedPeriod {
  if (label === null || label.trim() === '') {
    return {
      periodType: declaredType ?? 'unknown',
      label: null,
      start: null,
      end: null,
      note: 'the source states no period',
    };
  }

  const parsed = parsePeriodLabel(label);
  if (parsed === null || parsed.year === null) {
    return {
      periodType: declaredType ?? 'unknown',
      label,
      start: null,
      end: null,
      note: 'the period label could not be resolved to a span',
    };
  }

  if (parsed.kind === 'as_of_date') {
    return {
      periodType: 'as_of_date',
      label,
      start: utc(parsed.year, parsed.month ?? 1, parsed.day ?? 1),
      end: utc(parsed.year, parsed.month ?? 1, parsed.day ?? 1),
      note: null,
    };
  }

  if (parsed.kind === 'calendar_year') {
    return {
      periodType: 'calendar_year',
      label,
      start: utc(parsed.year, 1, 1),
      end: utc(parsed.year, 12, 31),
      note: null,
    };
  }

  if (convention === null) {
    // The document never said where its fiscal year begins, so neither will we. The
    // label is kept and comparison falls back to matching labels, which is weaker and
    // honest rather than stronger and invented.
    return {
      periodType: parsed.kind,
      label,
      start: null,
      end: null,
      note: 'the document does not state where its fiscal year begins, so no dates were resolved',
    };
  }

  const startMonth = convention === 'april-march' ? 4 : 1;
  const yearOfStart = convention === 'april-march' ? parsed.year - 1 : parsed.year;

  if (parsed.kind === 'fiscal_year') {
    return {
      periodType: 'fiscal_year',
      label,
      start: utc(yearOfStart, startMonth, 1),
      end: endOfMonth(yearOfStart + (convention === 'april-march' ? 1 : 0), startMonth === 1 ? 12 : 3),
      note: null,
    };
  }

  if (parsed.kind === 'quarter' && parsed.quarter !== null) {
    const offset = (parsed.quarter - 1) * 3;
    const month = ((startMonth - 1 + offset) % 12) + 1;
    const year = yearOfStart + Math.floor((startMonth - 1 + offset) / 12);
    return {
      periodType: 'quarter',
      label,
      start: utc(year, month, 1),
      end: endOfMonth(year + (month + 2 > 12 ? 1 : 0), ((month + 1) % 12) + 1),
      note: null,
    };
  }

  if (parsed.kind === 'half_year' && parsed.half !== null) {
    const offset = (parsed.half - 1) * 6;
    const month = ((startMonth - 1 + offset) % 12) + 1;
    const year = yearOfStart + Math.floor((startMonth - 1 + offset) / 12);
    return {
      periodType: 'half_year',
      label,
      start: utc(year, month, 1),
      end: endOfMonth(year + (month + 5 > 12 ? 1 : 0), ((month + 4) % 12) + 1),
      note: null,
    };
  }

  return { periodType: parsed.kind, label, start: null, end: null, note: 'unsupported period shape' };
}

function endOfMonth(year: number, month: number): Date {
  // Day zero of the next month is the last day of this one, which avoids a table of
  // month lengths and gets February right in a leap year.
  return new Date(Date.UTC(year, month, 0));
}

/**
 * Scope, reduced to a comparable form while keeping what the document said.
 *
 * The mapping is narrow on purpose. `consolidated` and `standalone` are terms of art with
 * one meaning each; a segment or a geography is not, so anything unrecognised keeps its
 * own words and compares equal only to itself.
 */
export function normalizeScope(scope: string | null): string | null {
  if (scope === null) return null;
  const text = scope.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  if (/\bconsolidated\b/.test(text)) return 'consolidated';
  if (/\bstandalone\b|\bseparate\b|\bunconsolidated\b/.test(text)) return 'standalone';

  return text;
}

export interface ClaimContext {
  readonly periodLabel: string | null;
  readonly periodType: PeriodType | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly scope: string | null;
  readonly assertionStatus: AssertionStatus | null;
  readonly qualifiers: readonly Qualifier[];
  readonly unit: string | null;
  readonly currency: string | null;
}

export interface ContextDifference {
  readonly dimension:
    | 'period'
    | 'period_type'
    | 'scope'
    | 'assertion_status'
    | 'unit'
    | 'currency'
    | 'qualifier';
  readonly a: string | null;
  readonly b: string | null;
  /**
   * Whether this difference could account for a numerical gap.
   *
   * A different period or scope could; a different currency makes the figures
   * incomparable rather than explaining them. Marked rather than acted on, because plan
   * 6.2 keeps these as inputs to classification.
   */
  readonly couldExplainGap: boolean;
}

/**
 * Lists every context dimension on which two claims differ.
 *
 * Two periods count as the same when their labels match after normalization or when their
 * resolved spans coincide. Labels alone are enough for the collections in scope, and
 * spans are used when both sides have them, which happens only where the documents stated
 * their convention.
 */
export function compareContext(
  a: ClaimContext,
  b: ClaimContext,
): ContextDifference[] {
  const differences: ContextDifference[] = [];

  if (!samePeriod(a, b)) {
    differences.push({
      dimension: 'period',
      a: a.periodLabel,
      b: b.periodLabel,
      couldExplainGap: true,
    });
  }

  if (a.periodType !== b.periodType && a.periodType !== null && b.periodType !== null) {
    // A quarter against a full year is not a smaller version of the same fact.
    differences.push({
      dimension: 'period_type',
      a: a.periodType,
      b: b.periodType,
      couldExplainGap: true,
    });
  }

  /**
   * A dimension differs only when both documents state it and state different things.
   *
   * Silence is not disagreement. Plan 5.2 requires null to mean unknown rather than a
   * guess, so a document that does not say whether a figure is consolidated has not
   * contradicted one that does — it has said nothing, and reading that as a difference
   * asserts something neither source did.
   *
   * This matters beyond tidiness because `corroborates` requires *zero* differences. With
   * silence counted as a difference, a genuine agreement between two documents was blocked
   * whenever either left a field unstated, which extraction routinely does — and the
   * collection produced no corroboration at all. `period_type` above already had this
   * right and the rest did not.
   */
  const bothStated = <T>(x: T | null, y: T | null): boolean => x !== null && y !== null;

  const scopeA = normalizeScope(a.scope);
  const scopeB = normalizeScope(b.scope);
  if (bothStated(scopeA, scopeB) && scopeA !== scopeB) {
    differences.push({ dimension: 'scope', a: scopeA, b: scopeB, couldExplainGap: true });
  }

  if (bothStated(a.assertionStatus, b.assertionStatus) && a.assertionStatus !== b.assertionStatus) {
    differences.push({
      dimension: 'assertion_status',
      a: a.assertionStatus,
      b: b.assertionStatus,
      couldExplainGap: true,
    });
  }

  const unitA = normalizeToken(a.unit);
  const unitB = normalizeToken(b.unit);
  if (bothStated(unitA, unitB) && unitA !== unitB) {
    differences.push({ dimension: 'unit', a: a.unit, b: b.unit, couldExplainGap: true });
  }

  const currencyA = normalizeToken(a.currency);
  const currencyB = normalizeToken(b.currency);
  if (bothStated(currencyA, currencyB) && currencyA !== currencyB) {
    // Not an explanation: plan 5.1 forbids converting currencies without a stated rate,
    // so this makes the pair incomparable rather than reconcilable.
    differences.push({
      dimension: 'currency',
      a: a.currency,
      b: b.currency,
      couldExplainGap: false,
    });
  }

  for (const difference of compareQualifiers(a.qualifiers, b.qualifiers)) {
    differences.push(difference);
  }

  return differences;
}

function normalizeToken(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim().toLowerCase();
  return text === '' ? null : text;
}

function samePeriod(a: ClaimContext, b: ClaimContext): boolean {
  const labelA = normalizeToken(a.periodLabel)?.replace(/\s|'/g, '') ?? null;
  const labelB = normalizeToken(b.periodLabel)?.replace(/\s|'/g, '') ?? null;

  if (labelA !== null && labelB !== null) {
    if (labelA === labelB) return true;

    // FY24 and FY2024 are one period written two ways. Comparing the parsed shape rather
    // than the string keeps that from reading as a context difference.
    const parsedA = parsePeriodLabel(labelA);
    const parsedB = parsePeriodLabel(labelB);
    if (parsedA !== null && parsedB !== null) {
      if (
        parsedA.kind === parsedB.kind &&
        parsedA.year === parsedB.year &&
        parsedA.quarter === parsedB.quarter &&
        parsedA.half === parsedB.half
      ) {
        return true;
      }
    }
  }

  if (a.periodStart !== null && b.periodStart !== null && a.periodEnd !== null && b.periodEnd !== null) {
    return (
      a.periodStart.getTime() === b.periodStart.getTime() &&
      a.periodEnd.getTime() === b.periodEnd.getTime()
    );
  }

  return labelA === labelB;
}

function compareQualifiers(
  a: readonly Qualifier[],
  b: readonly Qualifier[],
): ContextDifference[] {
  const byName = (list: readonly Qualifier[]) =>
    new Map(list.map((entry) => [entry.name.trim().toLowerCase(), entry.value.trim()]));

  const left = byName(a);
  const right = byName(b);
  const differences: ContextDifference[] = [];

  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const valueA = left.get(name) ?? null;
    const valueB = right.get(name) ?? null;
    if (valueA === valueB) continue;

    differences.push({
      dimension: 'qualifier',
      a: valueA === null ? null : `${name}: ${valueA}`,
      b: valueB === null ? null : `${name}: ${valueB}`,
      couldExplainGap: true,
    });
  }

  return differences;
}
