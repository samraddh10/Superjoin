# Evaluation results

Generated 2026-09-07T20:32:55.672Z against collection **Delhivery (Phase 7 demo)** (`1b752739-d556-4618-a22b-eb4242ec208b`).

Scored on `evaluation/goldset.json` version 0.1, which holds **50 claims and 25 pairs** across 3 documents. It is development data: it was read before the system was built.

> **No claims were extracted in this run, so every accuracy figure below is
> unmeasured rather than zero.** The counts and the failure breakdown are real
> and are reported; the rates are not, and are marked as such. What stopped the
> run is in "Processing and failures" at the end.

## 1. Extraction coverage on the reviewed sample

Recall over the hand-reviewed sample, not over the collection. Fifty claims from three documents is a sample, and this figure does not describe what fraction of everything in the PDFs was found.

- Gold claims located: **0.0% (0/50)**
- Of those, carrying the gold period and scope: _no claims matched, so context agreement is not measured_

| Evidence kind | Located |
|---|---|
| narrative | 0.0% (0/19) |
| table | 0.0% (0/22) |
| chart | 0.0% (0/7) |
| list | 0.0% (0/2) |

Not located: C01, C02, C03, C04, C05, C07, C08, C09, C10, C11, C12, C13, C15, C16, C17, C18, C19, C20, C24, C26, C27, C28, C29, C30, C31, C32, C33, C34, C35, C36, C37, C38, C39, C40, C41, C42, C43, C44, C45, C46, C47, C48, C49, C50, C51, C52, C53, C55, C56, C57

## 2. Grounding precision on accepted claims

Scope: accepted claims whose evidence lands on a page the gold set covers.

- Accepted claims matching a gold claim: _no accepted claims fall on a page the gold set covers, so precision is not measured_
- Matched but with a different period or scope: 0

A claim on a gold page that matches no gold claim is counted against precision. That is deliberately harsh: the page was reviewed by hand, so a figure the reviewer did not record is more likely wrong than merely unrecorded — but it is not certain, and the count should be read with that in mind.

## 3. Evidence references and semantic support

Reported separately, per plan 4.3 and 8.1, because they fail independently: a quote can be genuinely present in the document and still fail to support the claim citing it.

- Quote independently located in the cited block: _no evidence rows exist, so reference validity is not measured_
- Recorded by the pipeline as verified in native text: _not measured_
- Recorded as supporting the claim (entailment): _not measured_
- Supported only by a page image, so not independently verified: _not measured_
- Rows where this scorer and the pipeline disagree about whether the quote is present: 0

The first line is re-checked here rather than read back from the database. A scorer that trusted the stored verification flag would be reporting the pipeline's opinion of itself.

## 4. Candidate recall on known pairs

- Gold pairs whose two claims were both extracted: **0 of 25**
- Of those, surfaced as a candidate: _no pair had both claims extracted, so retrieval could not be measured_

Conditioned on both claims existing: a pair cannot be retrieved when one side was never extracted, and charging retrieval for an extraction miss would confuse the two stages plan 8.1 asks to be evaluated apart. Note also that this is measured from stored relationships, so it cannot separate a pair retrieval never surfaced from one the classifier declined to store; it is a lower bound on retrieval.

## 5. Relationship labels

_No gold pair could be scored: the pairs need both claims extracted and a stored relationship between them. The confusion matrix is not reported rather than reported as empty._

Not scored, because a claim or the relationship itself was not produced: P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24, P25

## 6. Processing and failures

| Measure | Value |
|---|---|
| Documents | 3 |
| Pages processed | 227 / 227 |
| Chunks processed | 0 / 457 |
| Claims extracted | 0 |
| Claims accepted | 0 |
| Relationships created | 0 |
| Input tokens | 0 |
| Output tokens | 0 |
| Wall clock | 4693.0s |

Run stages reached:

- completed_with_issues: 3

| Failure kind | Occurrences |
|---|---|
| `extraction_throttled` | 10 |
| `visual_route_throttled` | 9 |
| `visual_route_abandoned` | 3 |
| `extraction_abandoned` | 3 |

## 7. Parsing and structure

Measured without ground truth, so it is available on a held-out collection too. This is the part of the pipeline that runs before the model, and on an unfamiliar collection it is the part a generalization claim can actually rest on.

| Measure | Value |
|---|---|
| Source blocks | 3885 |
| Pages that produced blocks | 216 / 227 |
| Blocks with a bounding box | 100.0% (3885/3885) |
| Blocks with a printed page label | 96.8% (3759/3885) |
| Blocks from a model transcription | 0 |

| Block type | Count |
|---|---|
| paragraph | 2898 |
| table | 548 |
| heading | 369 |
| list | 70 |

A page producing no blocks is not necessarily a failure: a cover or a divider legitimately has no extractable text. The count is reported rather than judged, because deciding which is which needs the page in front of you.

## Cost

No tokens were billed: the model returned no successful completion in this run. The configured model is a `:free` route, so the monetary cost of this run is zero either way, and a per-token cost estimate would be an estimate of nothing.

