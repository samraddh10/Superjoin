/**
 * Predicates.
 *
 * Plan section 4.2 requires new predicates rather than a fixed revenue/address/director
 * schema, so there is no registry of allowed names here and nothing rejects an unfamiliar
 * one. What this file does instead is decide when two predicate names may be treated as
 * the same fact, and it is deliberately reluctant.
 *
 * The reluctance is the requirement. Plan 5.3 says not to equate revenue from operations
 * with total income, and not to equate a parent with its subsidiary. Both are cases where
 * the names are similar, the numbers are close, and treating them as one fact produces a
 * confident wrong answer. Everything below either normalizes *form* — case, separators,
 * plurals — or refuses; nothing here decides that two differently named quantities mean
 * the same thing. That judgement is left to the model, with evidence attached, which is
 * what plan 5.3 reserves it for.
 */

/**
 * Words that narrow a measure rather than name one.
 *
 * `ebitda` and `adjusted_ebitda` are different quantities, and so are `revenue` and
 * `total_revenue`. The list is used to *prevent* a merge, never to perform one, so a word
 * wrongly included here costs a missed comparison rather than a false equivalence.
 */
const MODIFIERS = new Set([
  'adjusted',
  'normalised',
  'normalized',
  'underlying',
  'pro',
  'forma',
  'proforma',
  'restated',
  'reported',
  'organic',
  'like',
  'total',
  'net',
  'gross',
  'excluding',
  'including',
  'ex',
  'before',
  'after',
  'per',
  'average',
  'median',
  'estimated',
  'projected',
  'annualised',
  'annualized',
]);

/**
 * Pairs the plan names as traps, recorded so the behaviour is guaranteed rather than
 * emergent.
 *
 * These are non-equivalences, not a domain schema: each entry only ever stops a merge,
 * and adding one can make the system more cautious but never more confident. Stored
 * normalized, and compared in both directions.
 */
const KNOWN_DISTINCT: readonly (readonly [string, string])[] = [
  ['revenue_from_operations', 'total_income'],
  ['revenue_from_services', 'total_income'],
  ['revenue', 'total_income'],
  ['revenue_from_operations', 'other_income'],
  ['profit_after_tax', 'profit_before_tax'],
];

/**
 * Reduces a predicate to a comparable form.
 *
 * Form only: case, separators, punctuation, a trailing plural. "Revenue From Services",
 * "revenue-from-services" and "revenue from services" are one name written three ways,
 * and treating them as three predicates would split one fact across three groups for no
 * reason a reader would recognise.
 */
export function normalizePredicate(raw: string): string {
  const tokens = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token !== '')
    // Grammatical filler carries no distinction: revenue_from_services and
    // revenue_of_services are the same measure. Words that narrow the measure are not
    // filler and are kept.
    .filter((token) => !['the', 'a', 'an', 'of', 'for', 'in', 'on', 'to'].includes(token))
    .map(singularize);

  return tokens.join('_');
}

/** Strips a trailing plural, leaving irregular forms alone rather than guessing at them. */
function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') || token.endsWith('xes')) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * The same pairs in normalized form.
 *
 * Computed rather than written out, so the list above stays readable as the names a
 * document would actually print while the comparison sees what `normalizePredicate`
 * produces. Writing both by hand is how the two quietly stop matching.
 */
const NORMALIZED_DISTINCT: readonly (readonly [string, string])[] = KNOWN_DISTINCT.map(
  ([one, other]) => [normalizePredicate(one), normalizePredicate(other)] as const,
);

export type PredicateRelation =
  /** The same measure under the same name. Safe to compare directly. */
  | 'same'
  /** Named as different measures by a rule that exists to prevent exactly this merge. */
  | 'explicitly_distinct'
  /** One narrows the other. Related, comparable only with the difference stated. */
  | 'modifier_variant'
  /** Same underlying quantity word, different framing. A candidate, not a match. */
  | 'related_form'
  /** Nothing in the names connects them. */
  | 'unrelated';

export interface PredicateComparison {
  readonly relation: PredicateRelation;
  readonly reason: string;
  /** Whether these two may be compared as though they measure the same thing. */
  readonly comparable: boolean;
}

/**
 * Decides how two predicate names relate.
 *
 * Never returns `same` for two different names. That is the whole point: a similar name
 * is a reason to look, and the looking is done by the classifier with the evidence in
 * front of it, not by a string comparison here.
 */
export function predicateRelation(a: string, b: string): PredicateComparison {
  const left = normalizePredicate(a);
  const right = normalizePredicate(b);

  if (left === right) {
    return { relation: 'same', reason: 'the same predicate', comparable: true };
  }

  for (const [one, other] of NORMALIZED_DISTINCT) {
    if ((left === one && right === other) || (left === other && right === one)) {
      return {
        relation: 'explicitly_distinct',
        reason: `${left} and ${right} are different measures and must not be equated`,
        comparable: false,
      };
    }
  }

  const leftTokens = left.split('_');
  const rightTokens = right.split('_');
  const leftCore = leftTokens.filter((token) => !MODIFIERS.has(token));
  const rightCore = rightTokens.filter((token) => !MODIFIERS.has(token));

  if (leftCore.join('_') === rightCore.join('_') && leftCore.length > 0) {
    // Same quantity, one of them qualified: EBITDA against adjusted EBITDA. Worth
    // comparing, and worth saying out loud that they are not the same figure.
    const extra = [...leftTokens, ...rightTokens].filter((token) => MODIFIERS.has(token));
    return {
      relation: 'modifier_variant',
      reason: `one is the other qualified by ${[...new Set(extra)].join(', ')}`,
      comparable: false,
    };
  }

  const shared = leftCore.filter((token) => rightCore.includes(token));
  if (shared.length > 0) {
    return {
      relation: 'related_form',
      reason: `both concern ${shared.join(', ')} but are not the same measure`,
      comparable: false,
    };
  }

  return { relation: 'unrelated', reason: 'the predicates have nothing in common', comparable: false };
}

/**
 * The quantity a predicate is about, for grouping and for embedding text.
 *
 * The last non-modifier token, which for these names is the head noun: `revenue` for
 * `total_revenue`, `ebitda` for `adjusted_ebitda`. Used to widen candidate retrieval, not
 * to decide anything.
 */
export function predicateHead(predicate: string): string {
  const tokens = normalizePredicate(predicate).split('_').filter((token) => !MODIFIERS.has(token));
  return tokens[tokens.length - 1] ?? normalizePredicate(predicate);
}
