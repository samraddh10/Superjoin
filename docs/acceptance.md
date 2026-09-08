# Phase 0.5: acceptance criteria

Each criterion is stated so that it can be checked by someone who did not build the system. "Pass" means the stated check was performed and observed, not that the feature exists in the code.

## A. Unfamiliar PDFs can be processed

| ID | Criterion | Check |
|---|---|---|
| A1 | A PDF not present at build time can be uploaded through the web interface and through the API | Upload a PDF from outside `datasets/`; a run ID is returned and reaches a terminal stage |
| A2 | Nothing in extraction, normalization or classification is keyed to Delhivery, to logistics, or to the starter file names | Rename a starter PDF and process it in a new collection; the claims produced are equivalent |
| A3 | Malformed, encrypted and oversized PDFs are rejected with a specific reason | Submit each; the error names the cause, and no run is left in a falsely successful state |
| A4 | A duplicate upload within a collection is identified rather than silently reprocessed | Upload the same file twice; the second is reported as a duplicate |

## B. Claims expose their evidence

| ID | Criterion | Check |
|---|---|---|
| B1 | Every accepted claim links to at least one source block with a document, a physical page index and a quoted passage or table cell reference | Open ten accepted claims at random; each shows all three |
| B2 | The quoted passage is present in the stored source text, allowing only documented whitespace normalization | Automated check across all accepted claims; zero unlocatable quotes |
| B3 | Clicking evidence opens the original PDF at the correct physical page | Check every gold-set claim; the page shown matches `physical_page` in `evaluation/goldset.json` |
| B4 | Claims whose only support is a model transcription of a page image are distinguishable from claims verified against native text | Filter by review status; visual-only claims appear as `needs_review` |
| B5 | Unsupported or ambiguous claims are marked rejected or needs_review and are excluded from confident relationships | Inspect the issues view; rejected claims do not appear as evidence for a `corroborates` or `contradicts` relationship |

## C. Relationships are explained, not asserted

| ID | Criterion | Check |
|---|---|---|
| C1 | Every relationship shows both claims, both sets of evidence, the differing context dimensions, and a rationale | Open ten relationships; each shows all four |
| C2 | Conflicting source values are both preserved; neither is overwritten or merged into a single invented value | Inspect the claims behind P11 and P15; both original figures remain queryable |
| C3 | The system abstains with `insufficient_context` rather than forcing a label when the comparison cannot be resolved | P18 is not labelled `reconciled_by_context` or `contradicts` |
| C4 | No relationship presents a model-generated score as a calibrated probability | No confidence percentage appears in the interface or the API payload |

## D. The four required cases

Each must be reachable in the interface and defensible from the evidence shown. Sources are recorded in `docs/contradiction-verdict.md`.

| ID | Case | Concrete instance |
|---|---|---|
| D1 | Corroboration | FY24 revenue from services: ₹8,142 Cr (`doc-03` p5) and ₹81,415 million (`doc-02` p3), agreeing after a crore-to-million conversion (gold-set P01) |
| D2 | Genuine or likely contradiction | FY21 EBITDA: (1,229) million (`doc-02` p5) against (1,003.79) million (`doc-01` p43), with the FY20 agreement shown as evidence that the definitions match (gold-set P11 and P12) |
| D3 | Context-resolved difference | Workforce 98,135 (`doc-02` p1) against team size 63,713 (`doc-03` p7), reconciled by the partner-agent definition, 63,713 + 34,422 = 98,135 (gold-set P05) |
| D4 | Observed failure | A real failure from `docs/difficult-pages.md`, shown in the issues view with how the system handled it, not only described in the README |

D4 must be a failure the system actually produced on a starter document. A synthetic fixture does not satisfy it.

## E. Reproducibility

| ID | Criterion | Check |
|---|---|---|
| E1 | Setup works from a clean checkout with the documented commands and nothing else | On a machine that has never run the project: clone, follow the README, process a PDF |
| E2 | A reviewer can see real output without running the pipeline themselves | Read `sample-output/sample.json`, an exported collection with its claims, evidence and relationships. Processing itself requires a working key: there is no replay mode, and a run whose model calls fail is reported failed rather than completed from substituted answers |
| E3 | No credentials, keys or `.env` files are committed | Scan the repository history before submission |
| E4 | Migrations apply from empty, in order, without manual steps | Drop the database volume and start again |

## F. Demonstration

| ID | Criterion | Check |
|---|---|---|
| F1 | The demo runs to at most three minutes and covers D1 through D4 plus the generalization result and one trade-off | Time the recording |
| F2 | Any time cut is labelled on screen, and no edit implies a processing latency that did not occur | Review the recording against the Phase 11.3 budget |

## G. Honesty constraints

These are pass/fail on the written output, not on the code.

| ID | Criterion |
|---|---|
| G1 | Every reported metric states its sample size and whether it came from development or held-out data |
| G2 | No accuracy target is claimed as achieved that was not measured |
| G3 | Limitations name specific observed failures, not generic caveats |
| G4 | Where the system abstained often, the abstention rate is reported alongside precision, so precision is not inflated by suppressing output |

## Out of scope for acceptance

Cloud deployment (Phase 10), the Phase 9 extensions, bounding-box highlighting, and any collection beyond the two supplied. Correct page navigation is required; region highlighting is not.
