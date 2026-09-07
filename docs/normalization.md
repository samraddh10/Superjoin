# Phase 5: normalization and entity resolution

How a stored claim becomes comparable with a claim from another document, without losing what its own document said.

Nothing here overwrites the source. `raw_value` and `numeric_value` stay exactly as extracted; `normalized_value`, `normalized_unit` and the `normalization` record exist only so two claims can be put side by side.

## Numbers

`packages/pipeline/src/normalize/numbers.ts`. Deterministic TypeScript, decimal.js over decimal strings, no model call and no JavaScript `Number` anywhere on the path.

Handled: Indian grouping (`1,23,456`) and western (`123,456`); parentheses as the accounting negative; currency symbols and words; scale words from thousand to trillion including lakh and crore; percent, basis points and percentage points; ranges; approximation markers.

Three prohibitions are implemented as refusals rather than as best-effort conversions:

- **Currencies never convert.** Two figures in different currencies are `incomparable`, and the reason says an explicit exchange-rate basis would be needed. Nothing supplies one.
- **A percentage is not a percentage point.** They normalize to different units and compare as different quantities. Basis points convert to percent, which is a change of unit within one quantity; percentage points have nowhere to go.
- **An unrecognised scale word is not dropped.** The value keeps a compound unit such as `INR/myriad` and records `unrecognised_scale`. Silently ignoring it would report a figure orders of magnitude too small as though it were comparable.

### Rounding

Compatibility comes from the precision each source printed, not from one blanket tolerance. A figure carries a half-width equal to half its last recorded digit, multiplied through the same scale conversion the value went through. `8,142 Cr` therefore stands for an interval half a crore wide, and `81,415 million` for one half a million wide.

Two figures agree when their intervals overlap, closed at both ends. The FY24 revenue pair in the gold set is exactly the touching case: 8,142 Cr is 81,420,000,000 with a 5,000,000 half-width, 81,415 million is 81,415,000,000 with a 500,000 half-width, and the intervals meet at a point. They agree. The FY21 EBITDA pair, both printed to at least the million and 225 million apart, does not.

A clean power-of-ten ratio between two otherwise similar figures is reported separately. It nearly always means a scale word was read differently on one side, and saying so gives the classifier something better than "these numbers differ".

## Context

Periods are tracked separately from the document's publication date, and fiscal dates are resolved **only when the document states its convention**. `detectFiscalConvention` looks for a sentence that names the closing month — "for the year ended March 31, 2024", or the statutory "April 1, 2023 to March 31, 2024". A bare "FY24" states a year without saying which twelve months it covers, and a document that never says keeps its label and gets no dates. Comparison then falls back to matching labels, which is weaker and honest rather than stronger and invented.

The convention is read once per document from native-text blocks only. A convention inferred from a model transcription would be the model telling us what its own dates mean.

`FY24`, `FY2024`, `fiscal 2024` and `2023-24` parse to one fiscal year. `2024` alone is a calendar year and is not promoted.

Scope maps `consolidated` and `standalone` onto one form each because they are terms of art with one meaning. A segment or a geography keeps its own words and compares equal only to itself.

`compareContext` reports every dimension on which two claims differ — period, period type, scope, assertion status, unit, currency, qualifiers — rather than reducing them to a verdict. Those differences are what turn an apparent contradiction into a reconciliation, so they are data. A currency difference is flagged as one that *cannot* explain a gap, since converting without a rate is forbidden.

## Predicates

There is no registry of allowed predicate names and nothing rejects an unfamiliar one; plan 4.2 requires new fact types to arrive as data. What `predicates.ts` decides is when two names may be treated as the same fact, and it is deliberately reluctant.

Normalization is form only: case, separators, punctuation, trailing plurals, and grammatical filler such as `of` and `for`. Only an identical normalized name returns `same`.

Beyond that it classifies rather than merges:

| Relation | Meaning |
|---|---|
| `explicitly_distinct` | A recorded non-equivalence, such as revenue from operations against total income |
| `modifier_variant` | One narrows the other: EBITDA and adjusted EBITDA, revenue and total revenue |
| `related_form` | A shared quantity word, different measure: EBITDA and EBITDA margin |
| `unrelated` | Nothing in the names connects them |

None of the last four is comparable as the same measure. The recorded non-equivalences only ever prevent a merge, so adding one can make the system more cautious and never more confident.

## Entities

Resolution order, from `entities.ts`:

1. Exact match on the normalized label within the collection.
2. A source-backed alias.
3. Candidates from lexical token overlap, plus anything the caller retrieved by embedding. Suggestions only.
4. The model, asked about at most three candidates with the claim's own statement attached.
5. Otherwise a new entity.

Legal-form suffixes are stripped from the end of a name only: `Delhivery Limited`, `Delhivery Ltd.` and `DELHIVERY PRIVATE LIMITED` all normalize to `delhivery`. A distinguishing word in the middle is not a suffix, so `Delhivery Express Parcel Private Limited` normalizes to `delhivery express parcel` and becomes a candidate for adjudication rather than an automatic match. The adjudication prompt names the trap directly: a parent and its subsidiary are not the same entity even when one name contains the other.

A failed or unparsable adjudication is a "no". Refusing to merge on a broken call leaves two entities that can be merged later; merging on one is invisible afterwards.

"Left unmerged" is implemented as a new entity, not a null. The claims stay queryable and stay out of comparisons they do not belong in.

Aliases record how they were established, so one the model proposed is distinguishable from one the document states.

## Fact groups

Each claim is placed in a fact group keyed on collection, entity, canonical predicate and resolved context. The group id is derived from that key as a version-5 UUID rather than generated, so two documents processed concurrently converge on one group and the primary key does the deduplication without a new index.

A group holds no resolved value of its own. Conflicting members are what it is for.

## Limitations

- Grouping separators are assumed to be the comma with the point as the fraction. A locale that reverses them would need the convention supplied rather than inferred.
- The fiscal convention is a single value per document. A filing that quotes a counterparty on a different fiscal calendar would be resolved wrongly.
- Entity candidates come from lexical overlap unless the caller supplies embedding suggestions; the normalization stage currently does not, so entity retrieval is lexical in practice. Claim-level retrieval in Phase 6 is where embeddings carry their weight.
- A claim whose subject the model wrote differently on two pages of one document becomes two entities unless the model adjudicates them together.
