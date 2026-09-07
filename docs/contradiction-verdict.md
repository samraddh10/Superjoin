# Phase 0.4: does the Delhivery collection contain a genuine contradiction?

**Verdict: yes.** Two independent conflicts were found by hand, both between figures the documents present for the same entity, metric and fiscal year. No synthetic supplemental PDF is needed, and none will be used.

The plan's rule applies: a difference explained by period, scope, units or definition is *not* a contradiction. Both cases below survive that test, and both are reported with the residual context question that keeps them at `likely_contradiction` rather than `contradicts`.

## Candidate A: FY21 EBITDA restated between the prospectus and the annual report

| Source | Physical page | Statement |
|---|---|---|
| `doc-01-prospectus` | 43 (printed 214) | EBITDA, Fiscal 2021: **(1,003.79)** million |
| `doc-02-annual-report` | 5 (printed 10-11) | EBITDA chart, FY21: **(1,229)** million, margin (3.4)% |

Difference: 225.21 million, roughly 22% of the smaller figure. Too large for rounding at any plausible precision.

Why this is not explained away:

- **Same period.** Both label the year ending 31 March 2021.
- **Same entity and scope.** Both are consolidated group figures. Spoton was acquired in August 2021, after FY21 closed, so consolidation cannot account for it.
- **Same definition, by evidence.** The adjacent year agrees exactly: the prospectus reports FY20 EBITDA of (1,720.47) million and the annual report's chart reports (1,720). If the two documents used different EBITDA definitions, FY20 would diverge too. It does not.
- **Internally consistent on each side.** The annual report's own margin, (3.4)%, matches (1,229) against its FY21 revenue of 36,355 million. The figure is not a transcription slip in the chart.

Residual context question: neither page states its EBITDA definition, and the annual report may be applying a later restatement it does not flag on that page. That unresolved question is what makes the correct label `likely_contradiction` rather than `contradicts`. A system that returns `contradicts` here is overconfident; one that returns `reconciled_by_context` has invented an explanation the documents do not supply.

## Candidate B: FY21 adjusted EBITDA, annual report letter versus its own chart

| Source | Physical page | Statement |
|---|---|---|
| `doc-02-annual-report` | 6 (printed 12-13) | "our adjusted EBITDA swung from negative ₹2,258 million in FY21 to positive ₹715 million on a pro forma basis" |
| `doc-02-annual-report` | 5 (printed 10-11) | Adjusted EBITDA chart, FY21: **(2,533)** million |
| `doc-01-prospectus` | 43 (printed 214) | Adjusted EBITDA, Fiscal 2021: **(2,532.83)** million |

The chart and the prospectus agree to within rounding. The shareholder letter, three pages later in the same report, does not.

Residual context question: the sentence attaches "on a pro forma basis" to the FY22 figure, and pro forma is defined in `doc-03` page 25 only as restating FY22 as if the Spoton acquisition had occurred on 1 April 2021. Whether the FY21 figure in that sentence is also pro forma is unstated. A pro forma FY21 including a loss-making Spoton would plausibly be *worse* than (2,533), not better, which argues against the reconciliation, but the documents do not settle it.

This case is valuable because the conflict is **within a single document**, so a system that only compares across documents will miss it.

## Confirmed false-contradiction traps

These pairs look like conflicts and are not. They exist to test that the classifier reconciles instead of over-reporting, and they feed the Phase 8.2 false-contradiction count.

| Apparent conflict | Actual explanation |
|---|---|
| FY23 revenue 72,236 million (`doc-02` p5) vs 72,253.01 million (`doc-02` p35) | "Revenue from services" vs "revenue from contracts with customers"; the 17 million gap is revenue from traded goods, reported as ₹2 Cr in `doc-03` p16 |
| Workforce 98,135 (`doc-02` p1) vs team size 63,713 (`doc-03` p7) | Definitional: `doc-02` includes last-mile partner agents, `doc-03` excludes them and reports 34,422 separately. 63,713 + 34,422 = 98,135 exactly |
| 4,445 last-mile delivery centres (`doc-02` p1) vs 3,506 express delivery centres (`doc-03` p7) | Same decomposition: 3,506 + 939 partner centres = 4,445 exactly |
| PIN code reach 17,488 (`doc-01` p43) vs 18,793 (`doc-03` p7) | As-of dates 31 December 2021 and 31 March 2024 |
| 11 directors (`doc-01` p83) vs 7 on the board (`doc-02` p20) | As-of dates, and `doc-02` reports composition as of 5 July 2024 |
| FY24 EBITDA "increased by Rs. 578 Cr" to 127 from (452) (`doc-03` p4) | 127 - (-452) = 579. Rounding artefact inside one sentence, not a conflict of fact |

## What this means for the demo

The four required cases all come from real starter-document evidence:

- **Corroboration**: FY24 revenue from services, ₹8,142 Cr (`doc-03` p5) and ₹81,415 million (`doc-02` p3), agreeing after a crore-to-million conversion.
- **Likely contradiction**: Candidate A above.
- **Context reconciliation**: the workforce decomposition, which reconciles to the unit.
- **Failure**: F1 or F2 from `docs/difficult-pages.md`.
