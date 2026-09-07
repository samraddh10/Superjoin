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
