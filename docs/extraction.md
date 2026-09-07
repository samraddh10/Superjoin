# Phase 4: fact extraction and grounding

How a chunk of parsed text becomes a stored claim with evidence a reviewer can open.

## The contract

`packages/pipeline/src/extraction/contract.ts` holds one Zod schema and one JSON Schema. The JSON Schema is sent as OpenRouter's `response_format`; the Zod schema validates whatever comes back. Both live in the same file because they are one contract in two encodings, and separating them is how they stop matching.

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

## Failure handling

A chunk that fails costs that chunk. The document keeps every other chunk's claims, the failure is recorded against the run, and the run ends `completed_with_issues`. The stage stops early after four consecutive failures or when the per-document token budget is spent, and records why with a count of the chunks it did not attempt.

## Limitations

- Entailment is a presence check, not logical entailment. A passage can contain the figure and still be about something else. Relationship classification re-reads the evidence rather than trusting the claim.
- A claim whose value appears nowhere in its own quote is rejected even if the quote is the right passage and the extractor merely quoted the row header. This trades recall for the guarantee that an accepted claim's quote contains its figure.
- Chunk-level extraction cannot see a footnote on another page. Evidence spanning pages is not currently reachable.
- Table cells are validated through the transcription text that carries the row header and unit alongside the value, not against the `table_headers` column directly. A quote that spans the header and the figure therefore validates both, and one that quotes the figure alone does not check its header at all. Wiring the stored cell address into verification is the next step here.
