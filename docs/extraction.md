# Phase 4: fact extraction and grounding

How a chunk of parsed text becomes a stored claim with evidence a reviewer can open.

## The contract

`packages/pipeline/src/extraction/contract.ts` holds one Zod schema and one JSON Schema. The JSON Schema is sent as a Bedrock tool input schema under a required `toolChoice`; the Zod schema validates whatever comes back. Both live in the same file because they are one contract in two encodings, and separating them is how they stop matching.

A claim carries subject, an open snake_case predicate, the original statement, the raw value as printed, a decimal-string numeric value, currency, scale, unit, period label and type, scope, assertion status, qualifiers, cited block handles, and the quote.

Two rules are enforced by the schema rather than by convention:

- `numeric_value` must match `^-?\d+(\.\d+)?$`. A currency symbol or a comma is rejected, because those are how a financial figure ends up passing through a JavaScript `Number` before any of our code sees it. Values stay strings across the wire and become PostgreSQL `NUMERIC` in storage; arithmetic uses decimal.js.
- Unknown context is `null`. A period invented for a claim that had none is indistinguishable afterwards from one the document stated.

A schema violation is an outcome, not an exception. `parseExtraction` returns the failing path and message, and `extractChunk` sends that back once with the rejected reply attached. Two failures end the chunk: a model that failed twice is not converging, and a third call spends budget the remaining chunks need.

## Block handles, not UUIDs

Chunks label each block they contain as `[B1]`, `[B2]` and carry a `blockRefs` mapping back to the source-block ids. Claims cite the handles. A model asked to echo a 36-character UUID gets it wrong often enough to matter, and every one it copies is spent tokens. Citations are resolved through the chunk's own mapping, so a handle that was never offered resolves to nothing rather than to a plausible row.

## The filename is not in the prompt

Acceptance criterion A2 requires a renamed starter PDF to produce equivalent claims. A filename in the prompt is a filename the output depends on, so none is sent. The passage carries its own page and section context from chunking, which is context that is actually in the document.

## Which blocks are extracted from

On a page the visual route reached, the native `table` and `chart` blocks are left out of the chunks and the transcription is used instead: they describe the same table, and asking about both spends twice the tokens to produce two readings that then have to be reconciled. Narrative blocks on that page are kept, because a transcription covers only its tables.

The native blocks are not deleted. Verification needs them.

## Grounding

`verifyClaim` answers three separate questions, and the answers genuinely differ:

| Question | Recorded as |
|---|---|
| Does the cited block exist and belong to this document? | `block_not_found` |
| Is the quoted passage really in it? | `quote_not_found` |
| Does the passage state what the claim reports? | `entailment` |

A real quote can still fail to support the claim, so both verdicts are stored on every evidence row.

Quote matching allows exactly one class of difference, documented in the code and repeated here: runs of any whitespace collapse to one space; curly quotes and apostrophes fold to straight ones; en dash, em dash and the Unicode minus become a hyphen; soft hyphen, zero-width space and byte-order mark are dropped. Case is not normalized and nothing else is added or removed. Matches are reported as spans of the stored text, not of the normalized form, so a future highlight lands on characters the document contains.

Entailment for a numeric claim is a presence check: the figure's digits, ignoring grouping, must appear in the quote. `81,415` and `8,14,15` are one number under it. For a non-numeric claim it is word overlap against the original statement, and a shortfall gives `unclear` rather than `unsupported`, because the extractor may simply have rewritten the sentence.

## Independence

A claim the model extracted, cited to a block the same model transcribed from a page image, is one system agreeing with itself. That evidence is stored as `visual_only` and the claim stays `needs_review`.

The exception is a genuine second witness. If the figure also appears in the page's own text layer, that is independent of the transcription, and a separate evidence row is written against the native block with a note saying what was checked. Such a claim can be accepted. The check is weaker than a quote match on purpose: the text layer of a table page is the garbled column soup that sent the page to the visual route in the first place, so what is verified is that the digits are on the page, and the note says so.

## Status

| Evidence | Status |
|---|---|
| Quote located in native text and states the value | `accepted` |
| Any located passage does not state the reported value | `rejected` |
| Every citation missing or unlocatable | `rejected` |
| Located only in a model transcription | `needs_review` |
| Located but support unclear | `needs_review` |

Status is a pure function of the evidence rows stored against the claim, recomputed after every write. A second pass that finds a cross-check lifts a claim out of review; a replay cannot lower one.

Rejected claims are stored, not discarded. They are the grounding measurement in Phase 8.1 and the observed-failure record the acceptance criteria ask for.

## Deduplication

The fingerprint identifies the assertion, not the sentence: subject, predicate, value, currency, scale, unit, period, scope, assertion status and qualifiers, normalized. The quote and the original statement are excluded on purpose. The same fact stated in a table and repeated in the narrative above it is one claim with two pieces of evidence; folding the wording in would store two claims that then appear to corroborate each other, manufacturing the "repeated wording is not independent evidence" trap in our own writer.

A unique index on (document, fingerprint) makes a retried job collide rather than duplicate. Evidence accumulates against whichever row won.

## Several passages in one request

Chunking flushes at every heading and every page. Both boundaries are load-bearing — a table has to stay attached to the section that names it, and a claim's page has to be unambiguous — so neither moves. What they produce, though, is a long tail of very small chunks: a heading with two sentences under it, the last rows of a table on a page of its own. Each one paid the full fixed cost of a request — system prompt, rules, the collection's entire predicate vocabulary, schema — to ask about a few dozen words.

Small chunks now travel together, up to `EXTRACTION_BATCH_TOKENS` of input and `EXTRACTION_BATCH_CHUNKS` passages. Each passage keeps its own page and section header and is stated to be separate from the others. Batches are packed in reading order rather than bin-packed, so a batch usually reads as a continuation of one section; an oversized chunk travels alone rather than being refused.

Handles are the part that has to be exactly right. They are numbered per chunk, so two passages in one request would each offer a `B1` standing for a different block. Every handle in a multi-passage request is therefore rewritten to carry its passage — `P2B1` — and the lookup is built over the whole batch. Claims come back as one list and are attributed to a chunk by the block each cites, never by what the model says about which passage it read, so a model that confuses two passages still produces a claim grounded in the block it actually quoted. A claim whose citations resolve to nothing is a rejection either way, and it leaves the whole batch unrecorded rather than crediting a chunk that may not have produced it.

A request carrying one passage is asked exactly what a single chunk was always asked, word for word. `EXTRACTION_BATCH_CHUNKS=1` restores one request per chunk, which is what the measurement of the saving has to be taken against.

The reply allowance grows with the batch but not in proportion: 4,000 tokens for one passage and 2,000 for each after it, capped at 8,000. The chunks that pack are the small ones, and a ceiling generous enough for the worst case would let a single runaway reply spend the document's budget.

## Resuming a retried job

A retry re-enters this stage from the beginning, because the stage has no memory of which chunks the previous attempt reached. Deduplication made that safe but not cheap: every chunk was asked again, at full price, to arrive back at claims the unique index refuses to duplicate, so a document cost its length multiplied by its attempts.

A chunk that came back and was written now records that it did, in `chunk_extractions`. The next attempt looks the chunk up before it calls and skips the call on a hit, still counting the claims and the tokens that chunk produced so the run's totals stay the cost of reading the document rather than the cost of the attempt that finished it.

The row's identity is everything the answer depended on: the chunk's text, the block each handle resolves to, the vocabulary rendered into the prompt beside it, the prompt version and the model. Change any of them and the fingerprint changes and the chunk is read again. It is deliberately not the chunk index, which a re-parse may renumber.

A chunk whose claims were rejected is not recorded. A rejection is a bad reading — a quote that is not in the block, a citation to material the model was never shown — and freezing it would deny the next pass the chance to do better. A chunk held for review is recorded: review is resolved by evidence found elsewhere, not by asking the same chunk the same question again.

The per-document token budget is measured against what the current attempt spent, not against the document's total. Charging a resumed chunk's tokens again would let a long document exhaust its budget without making a single call.

## Failure handling

A batch that fails costs its passages. They shared one request and there is no way to tell which of them the model choked on, nor is it usually one of them. The document keeps every other chunk's claims, the failure is recorded against the run, and the run ends `completed_with_issues`. The stage stops early after four consecutive failures or when the per-document token budget is spent, and records why with a count of the chunks it did not attempt.

## Limitations

- Entailment is a presence check, not logical entailment. A passage can contain the figure and still be about something else. Relationship classification re-reads the evidence rather than trusting the claim.
- A claim whose value appears nowhere in its own quote is rejected even if the quote is the right passage and the extractor merely quoted the row header. This trades recall for the guarantee that an accepted claim's quote contains its figure.
- Resumption is per chunk, so a document whose parse changed loses the whole cache at once: every fingerprint moves together.
- A batch fails as a unit, so one unreadable reply costs every passage in it. Bounding the batch is what keeps that cost small, and it is why the ceilings are well under what a model would accept.
- Tokens are recorded per chunk by apportioning the request they shared, weighted by each passage's size. The totals are exact; the per-chunk figures are an apportionment and should not be read as a measurement of one chunk's cost.
- Chunk-level extraction cannot see a footnote on another page. Evidence spanning pages is not currently reachable.
- Table cells are validated through the transcription text that carries the row header and unit alongside the value, not against the `table_headers` column directly. A quote that spans the header and the figure therefore validates both, and one that quotes the figure alone does not check its header at all. Wiring the stored cell address into verification is the next step here.
