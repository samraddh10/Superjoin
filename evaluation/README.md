# Evaluation set

`goldset.json` holds the Phase 0.3 hand-reviewed set for the Delhivery collection: **50 claims and 25 candidate pairs**.

These are evaluation examples. Nothing here is a runtime input, a prompt fixture, or a hard-coded output. The pipeline must reach these conclusions from the PDFs alone.

## How it was built

1. Native text and positioned words were extracted per page and read by hand (Phase 0.2).
2. A claim was recorded only after its quote was located in the source page.
3. Chart-sourced values were bound to their period by **x-coordinate**, not reading order. Two claims (C42, C43) are recorded specifically because reading order gives the wrong year for them.
4. Pairs were labelled by working out the reconciliation by hand, not by inspecting numeric closeness.

## Labelling rules applied

- A difference explained by period, scope, units, definition or as-of date is `reconciled_by_context`, never `contradicts`, and the explanation must be supported by text on a cited page. P05 and P06 qualify because the defining footnotes are on the pages themselves and the arithmetic closes exactly.
- `likely_contradiction` is used where the conflict looks real but one material context question is unresolved by the documents. All three conflicts in this set are labelled this way. None is labelled `contradicts`, because in every case a definition or basis is left unstated by the sources.
- `insufficient_context` is a correct answer, not a failure. P18 is labelled this way deliberately: two dimensions differ at once and the documents do not let either be held constant.
- `unrelated` covers pairs that retrieval will surface on semantic similarity but that assert different things (P24, P25).

## Distribution

| Expected label | Pairs |
|---|---|
| corroborates | 14 |
| reconciled_by_context | 5 |
| likely_contradiction | 3 |
| unrelated | 2 |
| insufficient_context | 1 |

| Difficulty | Pairs |
|---|---|
| easy | 8 |
| medium | 9 |
| hard | 8 |

Claims by source document: 19 from the earnings deck, 22 from the annual report, 9 from the prospectus. By evidence kind: 22 table, 19 narrative, 7 chart, 2 list.

The label distribution is deliberately unbalanced toward `corroborates`, because that is the distribution the documents actually produce. Reporting precision on a rebalanced set would overstate performance on the real collection.

## Claims not used in any pair

Eight claims are recorded without being a member of a pair, each for a stated reason:

| Claim | Why it is in the set |
|---|---|
| C10, C12, C20 | Reconciling components. The explanations for P05, P06 and P10 depend on them; the system must retrieve them to justify those labels |
| C24 | The "increased by Rs. 578 Cr" sentence, whose internal arithmetic is off by one crore. A false-contradiction trap for deterministic checks |
| C46 | The CFO entry that linear extraction interleaves into the board list. An extraction-precision trap, not a comparison case |
| C05, C16, C34 | Extraction-recall targets: facts that must be found and grounded, whose relationships are already covered by other pairs |

## What this set does and does not measure

Measures: claim-grounding precision, evidence-reference validity, candidate recall on known pairs, relationship precision, and abstention behaviour.

Does not measure: extraction recall across the full collection. 50 claims out of three documents is a sample. Coverage is reported separately in Phase 8, and the sample size is stated wherever a number derived from this set is quoted.

Development versus held-out: this entire set is **development data**. It was read before the system was built and will inform tuning. The Phase 8.5 generalization result on the India macroeconomy collection is the held-out measurement, and prompts and normalization rules are frozen before that collection is processed for the first time.

## Running the scorer

```bash
npx tsx --conditions development evaluation/src/run.ts "<collection name or id>" \
  --out evaluation/results/<name>.md
```

`npm run evaluate -- "<collection>"` works too, but npm consumes `--out` as one of its own
flags before the script sees it, so pass a custom output path only via the direct form.

The scorer is read-only against the database and reads the same tables the interface does.
An evaluation that could change what it measures would not be one, and a separate export
would be a second description of what the pipeline produced that could disagree with the
first.

## How a produced claim is matched to a gold claim

Every figure in the report rests on this rule, so it is stated rather than left implicit
in a similarity score. A produced claim matches when all four hold:

1. same document, joined on the file's basename;
2. the gold physical page is among the pages the claim's evidence lands on;
3. the predicates are the same measure, by `predicateRelation`, which returns `same` only
   for identical names after folding;
4. the figures are equal in base units exactly, or neither side states a figure — and
   where neither does, the subjects must agree, since one page lists several directors
   under one predicate and nothing numeric separates them.

Three choices are deliberate and worth arguing with:

- **Period and scope are not match conditions.** They are what the pairs turn on. Folding
  them into identity would let a claim about FY2024 satisfy a gold claim about Q4 FY24 and
  be scored as correct. They are reported instead as context agreement on claims that
  already matched, so a right value under a wrong period is visible as exactly that.
- **Exact value equality, not a tolerance.** The pipeline's rounding-interval logic decides
  whether two *sources* agree; borrowing it here would let the system's own notion of
  closeness grade its extraction. Gold values are at source precision, so the produced
  value should reach the same figure.
- **`predicateHead` is not used.** Its own documentation says it exists to widen retrieval
  and decides nothing. It collapses `ebitda` into `adjusted_ebitda`, and the earnings deck
  reports both.

Evidence-reference validity is re-checked here rather than read back from the stored
verification flag. A scorer that trusted that field would be reporting the pipeline's
opinion of itself.

## What the report will not do

It prints `not measured` rather than `0%` wherever a denominator is empty. A zero is a
result and an absence is not, and a report that showed the second as the first would be
worse than no report.
