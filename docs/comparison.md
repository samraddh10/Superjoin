# Phase 6: candidate retrieval and relationship reasoning

How two claims become a stored relationship with an explanation a reviewer can check.

## Retrieval

Two channels, unioned, both bounded to one collection.

**Exact.** Same subject and the same normalized predicate, regardless of period, scope or rank. This channel runs every time and is not a fallback. A vector search ranks by how a claim reads, and two documents describing one measure in different words can both be outranked by fifteen claims that merely sound alike; the reconciliation cases are precisely the pairs whose contexts differ, so they have to be reachable without competing for a top-k slot.

Subject identity uses entity ids when both claims have one and the normalized subject otherwise, which keeps a collection usable when entity resolution has left subjects unmerged.

**Semantic.** Exact nearest-neighbour search in pgvector, cosine distance, top-15 by default from `CANDIDATE_TOP_K`. Exact rather than approximate: three documents do not justify an index, and an approximate one would trade recall for a latency problem this corpus does not have.

Each pair records which channels found it, because a pair only the exact channel ever finds is evidence about the embeddings rather than about the pair.

### Embeddings

Local, through `@huggingface/transformers`, `Xenova/all-mpnet-base-v2` at 768 dimensions, normalized. OpenRouter serves no embedding models at all, so this cannot come from the same provider.

The embedded text is the subject, predicate, scope, period, unit and qualifiers — never the value. An embedding of "revenue from services was 8,142 crore" is dominated by its digits, and retrieval then ranks by numeric coincidence, which is the opposite of what candidate generation is for.

Vectors are stored with their model, dimensions and task type, keyed unique on (claim, model). A change of model produces a second vector alongside the first rather than overwriting it, which is the only way the rule against comparing vectors from different models stays enforceable.

If the model cannot be loaded, the run records `semantic_retrieval_unavailable` as an issue and continues with the exact channel. A recall figure measured while semantic retrieval was silently off would be reported as though both channels had run.

### What retrieval deliberately does not do

Pairs are cross-document only. Comparing a new document against everything already stored is what makes ingestion incremental. An inconsistency inside a single filing is a real thing to look for, but it is not the comparison this system is asked to make, and including it would bury the cross-document pairs under same-document noise.

## Deterministic checks

`checks.ts` computes entity match, predicate relation, every differing context dimension, the value comparison with both rounding intervals, the power-of-ten ratio, whether both claims were accepted, whether they come from one document, and whether they rest on a shared source block.

They are stored on the relationship and shown to the classifier as *inputs, not conclusions*. That phrasing is in the prompt itself: a verdict in a prompt is a verdict the model copies, so it reads "the intervals overlap" rather than "these agree".

The shared-block check is about independence rather than value. Two claims resting on one passage corroborate nothing; that is one sentence read twice.

`worthComparing` is a weak gate. It excludes only pairs that name different entities or measures a recorded rule keeps apart. Differing periods and scopes pass, because those are the reconciliation cases.

## Classification

The model receives both claims with their values as written, every differing context dimension, the check results, and up to eight quoted evidence passages *with the block text around each quote* — which is what lets it see the footnote that defines a figure. Evidence is cited by `E1`-style handle and resolved back to stored `claim_evidence` rows; a handle that was never offered resolves to nothing.

The six labels are exactly those in the plan. The prompt states four rules that shape which one is reachable:

- `reconciled_by_context` requires the explanation to be visible in a supplied passage. A plausible reconciliation that cannot be pointed at is `insufficient_context`.
- `contradicts` requires that no stated difference of period, scope, basis or definition could account for the gap. If one might and the documents do not say, the answer is `likely_contradiction`.
- `insufficient_context` is a correct answer and is to be preferred to a label that cannot be justified.
- No confidence, probability or percentage of certainty is requested, so none can be stored and later presented as calibrated.

Two downgrades are applied in code rather than trusted to the prompt. A `corroborates` between claims sharing a source block becomes `insufficient_context` with the reason attached. A `corroborates` within one document keeps its label but gains an uncertainty reason saying it is internal consistency, not independent corroboration. A pair involving a claim held for review always gains a reason saying the conclusion rests on unverified evidence.

## When the classifier cannot be reached

Throttled, out of budget, or no key at all: the pair falls back to the deterministic answer, the row records `deterministic` as its method, and the reason is stored as uncertainty.

The deterministic label is deliberately impoverished. It can return `unrelated` when the names have nothing in common or a rule keeps the measures apart, and `corroborates` for two independent accepted claims whose contexts match exactly and whose figures agree after a recorded conversion. Everything else is `insufficient_context`.

It can never return `contradicts` or `likely_contradiction`. Arithmetic is not proof of conflict, and every apparent conflict in the working collection turns on a definition or a basis that arithmetic cannot read. Abstention that is visibly abstention is the point.

## Audit trail

Each relationship stores both claim ids, the label, the rationale, the differing context dimensions, the uncertainty reasons, the resolved supporting evidence ids, the full deterministic check output including which channels retrieved the pair, the method, the method version, the served model and the prompt version.

Both claims stay untouched. Nothing resolves a disagreement into a third value that neither document states, and no confidence score is stored anywhere.

A unique index on (claim A, claim B, method version) makes a re-run collide instead of duplicating. A row is upgraded from `deterministic` to `model` when a later run reaches the classifier; the reverse never happens, so a throttled retry cannot erase a considered label.

## Limitations

- Same-document pairs are never retrieved, so an internal inconsistency within one filing is invisible to this stage.
- Candidate loading reads every comparable claim in the collection into memory for the exact channel. That is right for three documents and is the first thing to change as a corpus grows (plan 9.5).
- A `reconciled_by_context` depends on the explaining passage being inside the evidence already attached to one of the two claims. A definition three pages away will not be seen.
- The deterministic fallback's `corroborates` requires an exact context match, so a run with no model access reports far fewer corroborations than one with it, and the difference is a property of availability rather than of the documents.
