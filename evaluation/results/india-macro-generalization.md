# Evaluation results

Generated 2026-09-07T20:32:53.907Z against collection **India macroeconomy (held-out)** (`0750b8b3-19e4-4cd2-8bf3-64769ca34758`).

This collection has **no hand-reviewed sample**, so the accuracy sections are omitted rather than printed empty. That is the held-out collection of plan 8.3 by design: a gold set built for it would have had to be read first, and reading it is what makes a set no longer held out.

What can still be measured without ground truth is measured: what parsing produced, how far each run got, and what failed. Those are reported below.

## 6. Processing and failures

| Measure | Value |
|---|---|
| Documents | 3 |
| Pages processed | 284 / 284 |
| Chunks processed | 0 / 676 |
| Claims extracted | 0 |
| Claims accepted | 0 |
| Relationships created | 0 |
| Input tokens | 0 |
| Output tokens | 0 |
| Wall clock | 531.6s |

Run stages reached:

- completed_with_issues: 3

| Failure kind | Occurrences |
|---|---|
| `extraction_throttled` | 11 |
| `visual_route_throttled` | 9 |
| `extraction_abandoned` | 3 |
| `visual_route_abandoned` | 3 |

## 7. Parsing and structure

Measured without ground truth, so it is available on a held-out collection too. This is the part of the pipeline that runs before the model, and on an unfamiliar collection it is the part a generalization claim can actually rest on.

| Measure | Value |
|---|---|
| Source blocks | 5516 |
| Pages that produced blocks | 277 / 284 |
| Blocks with a bounding box | 100.0% (5516/5516) |
| Blocks with a printed page label | 65.6% (3618/5516) |
| Blocks from a model transcription | 0 |

| Block type | Count |
|---|---|
| paragraph | 3726 |
| heading | 895 |
| table | 882 |
| list | 13 |

A page producing no blocks is not necessarily a failure: a cover or a divider legitimately has no extractable text. The count is reported rather than judged, because deciding which is which needs the page in front of you.

## Cost

No tokens were billed: the model returned no successful completion in this run. The configured model is a `:free` route, so the monetary cost of this run is zero either way, and a per-token cost estimate would be an estimate of nothing.

