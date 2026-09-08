/**
 * The deterministic checks.
 *
 * Plan section 6.2 lists them — unit conversion, interval compatibility, reporting-period
 * differences, scope mismatches, rounding intervals — and then states the constraint that
 * governs how they may be used: they are *inputs to classification, not automatic proof
 * of either contradiction or reconciliation*.
 *
 * So nothing in this file returns a relationship label. It returns arithmetic and a list
 * of differences, and the two callers use it differently: the classifier is given it as
 * context, and the stage uses it to decide which pairs are worth a model call at all.
 * Two figures that disagree after every conversion may still be one restated figure and
 * one original; two that agree may be the same sentence copied between documents. Neither
 * is something arithmetic can see.
 *
 * The last check is about independence rather than value. Plan 6.4 warns that repeated
 * wording is not independent evidence, so a pair whose claims rest on the same source
 * block is flagged: two readings of one sentence corroborate nothing.
 */

import type { AssertionStatus, PeriodType, Qualifier } from '../extraction/contract.ts';
import { isGenericSubject } from '../normalize/entities.ts';
import {
  compareContext,
  normalizeScope,
  type ClaimContext,
  type ContextDifference,
} from '../normalize/context.ts';
import {
  compareValues,
  normalizeValue,
  scaleRatio,
  type NormalizedValue,
  type ValueComparison,
} from '../normalize/numbers.ts';
import { predicateRelation, type PredicateComparison } from '../normalize/predicates.ts';

/** Bumped when a change here alters what the checks report. Stored on every relationship. */
export const CHECKS_VERSION = 'checks@2';

/** A claim as comparison reads it, with both its raw and its resolved context. */
export interface ComparableClaim {
  readonly id: string;
  readonly documentId: string;
  readonly entityId: string | null;
  readonly subject: string;
  readonly predicate: string;
  readonly originalStatement: string;
  readonly rawValue: string | null;
  readonly numericValue: string | null;
  readonly currency: string | null;
  readonly scale: string | null;
  readonly unit: string | null;
  readonly periodLabel: string | null;
  readonly periodType: PeriodType | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly scope: string | null;
  readonly assertionStatus: AssertionStatus | null;
  readonly qualifiers: readonly Qualifier[];
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  /** Source blocks this claim's evidence points at, for the independence check. */
  readonly sourceBlockIds: readonly string[];
}

export type EntityMatch = 'same' | 'different' | 'unresolved';

export interface DeterministicChecks {
  readonly version: string;
  /** Two claims from one document are not two sources. */
  readonly sameDocument: boolean;
  /** Blocks both claims rest on. Non-empty means the evidence is not independent. */
  readonly sharedSourceBlocks: readonly string[];
  readonly entityMatch: EntityMatch;
  readonly predicate: PredicateComparison;
  readonly contextDifferences: readonly ContextDifference[];
  /** Null when at least one side has no figure to compare. */
  readonly value: ValueComparison | null;
  /** A clean power-of-ten gap, which usually means a scale word was misread. */
  readonly scaleRatio: string | null;
  /** True only when both claims were accepted on independent evidence. */
  readonly bothAccepted: boolean;
  /**
   * Whether the pair is worth putting in front of the classifier at all.
   *
   * A weak gate, not a verdict. It excludes pairs that name different entities or
   * measures the registry says must never be equated, and lets everything else through
   * — including pairs whose periods or scopes differ, since plan 6.1 requires those to
   * survive retrieval precisely because they are the reconciliation cases.
   */
  readonly worthComparing: boolean;
  readonly notes: readonly string[];
}

function contextOf(claim: ComparableClaim): ClaimContext {
  return {
    periodLabel: claim.periodLabel,
    periodType: claim.periodType,
    periodStart: claim.periodStart,
    periodEnd: claim.periodEnd,
    scope: claim.scope,
    assertionStatus: claim.assertionStatus,
    qualifiers: claim.qualifiers,
    unit: claim.unit,
    currency: claim.currency,
  };
}

function normalizedOf(claim: ComparableClaim): NormalizedValue | null {
  if (claim.numericValue === null) return null;
  return normalizeValue({
    numericValue: claim.numericValue,
    scale: claim.scale,
    unit: claim.unit,
    currency: claim.currency,
  });
}

/**
 * Runs every check over one pair.
 *
 * Recomputed from the stored claim columns rather than read from the `normalization`
 * JSONB. The columns are what the document said; the JSONB is a record of what was done
 * to them, and deriving a comparison from a record of a derivation is one indirection too
 * many when the inputs are right there.
 */
export function runDeterministicChecks(
  a: ComparableClaim,
  b: ComparableClaim,
): DeterministicChecks {
  const notes: string[] = [];

  const entityMatch: EntityMatch =
    a.entityId !== null && b.entityId !== null
      ? a.entityId === b.entityId
        ? 'same'
        : 'different'
      : 'unresolved';

  if (entityMatch === 'unresolved') {
    notes.push('at least one subject was not resolved to an entity, so identity is by name only');
  }

  const predicate = predicateRelation(a.predicate, b.predicate);
  const contextDifferences = compareContext(contextOf(a), contextOf(b));

  const normalizedA = normalizedOf(a);
  const normalizedB = normalizedOf(b);
  const value =
    normalizedA !== null && normalizedB !== null ? compareValues(normalizedA, normalizedB) : null;

  if (value === null) {
    notes.push('at least one claim states no figure, so no numerical comparison was made');
  }

  const ratio =
    normalizedA !== null && normalizedB !== null ? scaleRatio(normalizedA, normalizedB) : null;

  if (ratio !== null && value?.agreement === 'disagree') {
    notes.push(
      `the figures differ by a factor of exactly ${ratio}, which usually means a scale word was read differently on one side`,
    );
  }

  const sharedSourceBlocks = a.sourceBlockIds.filter((id) => b.sourceBlockIds.includes(id));
  if (sharedSourceBlocks.length > 0) {
    notes.push(
      'both claims rest on the same source block, so agreement between them is one passage read twice rather than two sources',
    );
  }

  const sameDocument = a.documentId === b.documentId;
  if (sameDocument) {
    notes.push('both claims come from the same document');
  }

  const scopeA = normalizeScope(a.scope);
  const scopeB = normalizeScope(b.scope);
  if (scopeA !== scopeB && scopeA !== null && scopeB !== null) {
    notes.push(`the reporting scope differs: ${scopeA} against ${scopeB}`);
  }

  /**
   * A placeholder subject cannot identify anything across documents.
   *
   * Extraction sometimes returns the document's own self-reference — "document", "this
   * presentation" — as the subject. Two such claims from two files share a subject *word*
   * and nothing else, and the classifier, shown two identical subjects with the same
   * predicate and different values, quite reasonably calls it a contradiction. It produced
   * exactly that: the prospectus's filing date against the earnings deck's, read as one
   * document holding two dates.
   *
   * Scoping the entity was not enough, because the classifier reads the subject text too.
   * The pair is refused here instead, which is the gate that decides what it ever sees.
   */
  const genericAcrossDocuments =
    !sameDocument && isGenericSubject(a.subject) && isGenericSubject(b.subject);
  if (genericAcrossDocuments) {
    notes.push(
      'both subjects name the document itself rather than an entity, so the two are not comparable across files',
    );
  }

  const bothAccepted = a.status === 'accepted' && b.status === 'accepted';
  if (!bothAccepted) {
    notes.push(
      'at least one claim is held for review, so any conclusion drawn from this pair is provisional',
    );
  }

  return {
    version: CHECKS_VERSION,
    sameDocument,
    sharedSourceBlocks,
    entityMatch,
    predicate,
    contextDifferences,
    value,
    scaleRatio: ratio,
    bothAccepted,
    worthComparing:
      entityMatch !== 'different' &&
      predicate.relation !== 'unrelated' &&
      predicate.relation !== 'explicitly_distinct' &&
      !genericAcrossDocuments,
    notes,
  };
}

/**
 * The label the checks alone can justify, when no model is available.
 *
 * Deliberately impoverished. It will say `unrelated` when the names have nothing in
 * common and `corroborates` when two independent, accepted claims in the same context
 * agree after conversion — and otherwise it abstains with `insufficient_context`.
 *
 * It never returns `contradicts` or `likely_contradiction`. Plan 6.2 forbids treating a
 * numerical disagreement as proof of conflict, and every apparent conflict in the
 * collection turns on a definition or a basis that arithmetic cannot read. Abstaining is
 * the honest answer when the classifier could not be reached, and it is visibly different
 * from a conclusion.
 */
export function deterministicLabel(checks: DeterministicChecks): {
  readonly label:
    | 'corroborates'
    | 'reconciled_by_context'
    | 'insufficient_context'
    | 'unrelated';
  readonly rationale: string;
  readonly uncertaintyReasons: readonly string[];
} {
  if (checks.entityMatch === 'different') {
    return {
      label: 'unrelated',
      rationale: 'the two claims are about different entities',
      uncertaintyReasons: [],
    };
  }

  if (checks.predicate.relation === 'unrelated') {
    return {
      label: 'unrelated',
      rationale: checks.predicate.reason,
      uncertaintyReasons: [],
    };
  }

  if (checks.predicate.relation === 'explicitly_distinct') {
    return {
      label: 'unrelated',
      rationale: `${checks.predicate.reason}, so their values are not expected to agree`,
      uncertaintyReasons: [],
    };
  }

  const contextMatches = checks.contextDifferences.length === 0;

  if (
    checks.predicate.relation === 'same' &&
    contextMatches &&
    checks.value?.agreement === 'agree' &&
    checks.bothAccepted &&
    !checks.sameDocument &&
    checks.sharedSourceBlocks.length === 0
  ) {
    return {
      label: 'corroborates',
      rationale: `two documents state the same measure for the same period and ${checks.value.reason}`,
      uncertaintyReasons: [],
    };
  }

  return {
    label: 'insufficient_context',
    rationale:
      'the deterministic checks could not settle this pair and no classifier was available to read the evidence',
    uncertaintyReasons: [
      'classification was not run for this pair',
      ...checks.notes,
      ...checks.contextDifferences.map(
        (difference) => `${difference.dimension} differs: ${difference.a} against ${difference.b}`,
      ),
    ],
  };
}
