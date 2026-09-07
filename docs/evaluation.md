# Phase 8: what was measured, and what could not be

This records the state of evaluation honestly, including the parts that did not produce a
number. Plan section 8.1 asks for measured results and explicitly warns against claiming
accuracy targets were achieved; the largest finding here is that the baseline measurement
could not be taken at all, and why.

The scorer, its matching rule and how to run it are in [`evaluation/README.md`](../evaluation/README.md).
The generated report is [`evaluation/results/delhivery-baseline.md`](../evaluation/results/delhivery-baseline.md).

## The blocker: the free model pool

Extraction over the Delhivery collection produced **zero claims from 457 chunks**. Every
call to `google/gemma-4-26b-a4b-it:free` returned HTTP 429.

Availability was measured rather than assumed — six probes per model, two seconds apart:

| Model | Successful | Codes |
|---|---|---|
| `google/gemma-4-26b-a4b-it:free` | 0 of 6 | 429 × 6 |
| `google/gemma-4-31b-it:free` | 1 of 6 | 200, then 429 × 5 |

The plan anticipated this. Section 3.1 requires a 429 to be treated as an ordinary event
rather than an error, and the pipeline does: it classified every failure as transient,
backed off, honoured `Retry-After`, abandoned after four consecutive failures rather than
burning the quota, recorded twenty-five issues naming the affected chunk or page, and left
two of the three documents at `completed_with_issues` so nothing looked successful.

Parsing is unaffected and complete: **227 of 227 pages** across the three documents, with
source blocks, positions and bounding boxes stored. Everything downstream of the model is
built and tested; it has had no input.

The plan also names the remedy, and it changes no code: attach a personal Google AI Studio
key at OpenRouter's integrations page, which moves requests onto that key's own quota.
Until then the accuracy figures in section 8.1 cannot be produced, and the report prints
`not measured` for each of them rather than a zero.

## What the scorer measures once there is output

All six measurements plan 8.1 asks for are implemented and tested, each with its own
denominator so that none can be inflated by the others:

| Measurement | Denominator |
|---|---|
| Extraction coverage | the 50 gold claims |
| Grounding precision | accepted claims landing on a page the gold set covers |
| Evidence-reference validity | evidence rows, re-checked independently |
| Semantic support | evidence rows, reported separately from the above |
| Candidate recall | gold pairs whose two claims were both extracted |
| Relationship confusion matrix | gold pairs with a stored relationship |

Coverage and abstention are reported alongside precision deliberately. Plan 8.1 warns that
precision can be inflated by suppressing almost everything, and the only defence is showing
how much was suppressed.

False contradictions are counted as their own line rather than folded into an aggregate
accuracy. Telling a reviewer that two documents disagree when they do not is the expensive
error in this system, and an aggregate would price it the same as an abstention.

## Two genuine observed failures

Plan 8.2 asks for at least one real failure to be recorded. There are two.

### F2: provider throttling stops extraction entirely

Described above. Handled as designed rather than as a crash: transient classification,
bounded backoff, early abandonment, per-chunk issues, and a run status that says the
document did not fully succeed. It is visible in the interface's Issues view grouped by
failure kind, which is what plan 7.3 asks the interface to show.

This is a limitation of the free tier rather than a defect in the pipeline, but it is a
real limitation and it blocks the baseline measurement, so it is recorded as a failure and
not as an inconvenience.

### F3: a run that extracted nothing reported `completed`

Found by running the evaluation, which is the point of having one.

Retrying the earnings-deck document produced a run that finished at stage `completed` with
`chunks_processed = 0` of 26, `claims_extracted = 0`, zero tokens billed, and **no
processing issue recorded at all**. Reproduced three times.

That is the falsely successful document plan 2.1 warns against, and it is worse than a
failure because it looks like a result: the documents view showed a green "completed" for a
document with no facts, and `finishRun` had no unresolved issue to reach
`completed_with_issues` with.

**Root cause: the cutoff in `resolveOpenIssues` used the wrong timestamp. Fixed.**

`recordIssue` deduplicates on `(run, failure kind, physical page)`. When a failure recurs
it *updates* the row it already has — incrementing `attemptCount`, refreshing `message` and
`lastAttemptAt` — and deliberately leaves `createdAt` at the first sighting, so one
recurring problem stays one row with a count rather than becoming forty.

`resolveOpenIssues` decided which issues belonged to *earlier* attempts with
`createdAt < attemptStartedAt`. For a recurring issue that timestamp is the first sighting,
which by definition predates the current attempt. So the issues this attempt had just
re-recorded were marked `resolved`, with the note "a later attempt completed this stage",
when nothing had completed. `finishRun` counts unresolved issues to choose between
`completed` and `completed_with_issues`, found none, and reported success.

The stored rows show it plainly — `created_at` from the first run, `last_attempt_at` from
the retry three hours later, `attempt_count` of four, and `resolution = resolved`:

| failure kind | attempts | resolution | created | last attempt |
|---|---|---|---|---|
| `visual_route_throttled` | 4 | resolved | 19:05:34 | 20:01:16 |
| `extraction_throttled` | 4 | resolved | 19:06:55 | 20:02:41 |

The fix is to cut on when the issue was last *seen* rather than when it was first recorded:
`coalesce(last_attempt_at, created_at) < attemptStartedAt`. An issue the current attempt
touched now stays open; one that stopped recurring is still resolved, which is what the
cutoff existed for.

Two things this rules out, both of which looked plausible at the time. It is not a dropped
retry: all four pg-boss jobs for the document reached `completed`, with no send returning
null despite the singleton key on the document id. And it is not the extraction stage:
called directly against the same 26 chunks with a client that always throws the provider's
rate-limit error, it attempts four chunks, records four issues and sets `stoppedEarly`,
exactly as intended. The extraction stage was correct throughout; only the resolution
sweep that ran after it was wrong.

Regression test: `packages/pipeline/src/processor.test.ts`, "an issue that recurs on a
later attempt". It fails against the old cutoff and passes against the new one, and its
companion checks that an issue which stops recurring is still resolved — otherwise the fix
would be to resolve nothing, which would hide successful recovery instead.

## Robustness checks (plan 8.2)

Covered by the test suite rather than by a separate manual pass, so they run on every
change. Every item plan 8.2 names has a test:

| Check | Where |
|---|---|
| Duplicate uploads | reported as duplicates, not reprocessed, scoped to the collection |
| Encrypted PDFs | rejected by name, with no document or run created |
| Malformed PDFs | named when the body is truncated |
| Interrupted processing | stalled runs distinguished from working ones; retry refused while queued |
| Missing stored file | permanent failure without retrying; the file endpoint answers 410 |
| Rate-limit errors | 429 marked retryable and `Retry-After` honoured; 400 marked permanent |
| Missing units | a null period kept rather than treated as missing; currencies never converted without a stated rate |
| Wrong table-column selection | values bound by coordinate; a value midway between columns refuses to guess |
| Unsupported evidence | corroboration refused on a single shared passage, and refused when a claim is held for review |

## Held-out data (plan 8.3)

**Not yet run.** The India macroeconomy collection is the held-out set, and plan 8.3
requires prompts and normalization rules to be frozen before it is processed for the first
time. Running it now would produce the same throttled result as the development set while
spending the one chance to measure generalization on a first, uninformative attempt.

The freeze is what matters and it is recorded: `EXTRACTION_PROMPT_VERSION`,
`RELATIONSHIP_PROMPT_VERSION`, `NORMALIZATION_VERSION`, `CHECKS_VERSION` and
`COMPARISON_METHOD_VERSION` are stored on every run and every relationship, so a later
generalization run is comparable to this baseline or is visibly not.

## What no number here should be read as

The gold set is 50 claims and 25 pairs, hand-reviewed, and it is **development data**: it
was read before the system was built. It measures grounding, evidence validity, candidate
recall, relationship precision and abstention on a sample. It does not measure extraction
recall across the collection, and no figure derived from it should be quoted without the
sample size that travels with it in the report.
