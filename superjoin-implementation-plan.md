# Superjoin assignment: Node.js phase and subphase implementation plan

This is a proposed implementation plan, not an additional set of assignment requirements. The required outcome is a prototype that accepts unfamiliar PDFs, extracts meaningful facts with source evidence, and explains corroboration, likely contradictions, and context-resolved differences. It must also demonstrate a real failure and document limitations. Cloud hosting and the extensions below are optional.

## Recommended stack and service boundaries

Use Node.js 24 LTS with TypeScript in the API, worker and shared packages. The frontend also uses TypeScript. Compile backend TypeScript with tsc for production; use tsx for development. Use npm workspaces and commit the lockfile. [Node.js release status](https://nodejs.org/en/about/previous-releases).

| Component | Use | Responsibility |
|---|---|---|
| Web interface | React + TypeScript + Vite; Tailwind and shadcn/ui optional | Upload documents, browse claims and relationships, inspect evidence |
| HTTP API | [Fastify](https://fastify.dev/docs/latest/) | Upload, status and result endpoints; use @fastify/multipart for uploads |
| Validation and contracts | Zod | Runtime validation and shared TypeScript types; export compatible JSON Schema for Fastify/OpenAPI and the model's structured output |
| Processing worker | Separate Node.js process using shared pipeline code | Parsing, extraction, normalization and comparisons |
| Durable jobs | [pg-boss](https://github.com/timgit/pg-boss) | PostgreSQL-backed jobs, retries and concurrency control |
| Database | PostgreSQL with JSONB and [pgvector](https://github.com/pgvector/pgvector) | Claims, evidence, relationships, embeddings and job state |
| Database access | [Drizzle ORM + pg](https://orm.drizzle.team/docs/get-started/postgresql-new) | TypeScript schema, queries and transactions |
| Migrations | Drizzle Kit | Generate and apply reviewed SQL migrations; manage pg-boss schema upgrades separately |
| PDF text extraction | [unpdf + PDF.js](https://github.com/unjs/unpdf) | Page text and positioned text items; maintain page-level provenance |
| Difficult-page processing | Gemma 4 multimodal input via OpenRouter | Interpret table-heavy, scanned or poorly extracted pages; retain original page evidence |
| PDF page rendering | unpdf + pdfjs-dist + @napi-rs/canvas | Render selected source pages for multimodal processing and inspection |
| LLM | [OpenRouter](https://openrouter.ai/docs) chat completions API | Structured fact extraction and evidence-based relationship classification |
| Initial LLM model | `google/gemma-4-26b-a4b-it:free`, configurable | Baseline to evaluate; record exact model and prompt version |
| Embeddings | `@huggingface/transformers` run locally | Embed short claim descriptions; use 768 dimensions and normalize vectors. OpenRouter serves no embedding models, so this cannot go through the same provider |
| Decimal arithmetic | [decimal.js](https://mikemcl.github.io/decimal.js/) | Precise unit conversion and numerical comparison; store PostgreSQL NUMERIC |
| Evidence viewer | [PDF.js](https://mozilla.github.io/pdf.js/) | Display original PDFs and navigate to evidence pages |
| Local PDF storage | Shared Docker volume | Original PDFs and derived parsing artifacts |
| Local execution | Docker Compose | Run web, API, worker and PostgreSQL |
| Verification | Vitest; Playwright for one browser smoke test if needed | Grounding, comparisons, recovery and upload workflow |

OpenRouter is a single OpenAI-compatible endpoint in front of many providers, which keeps the model choice a configuration value rather than a code dependency. Two free Gemma models are available and both accept image input, which the difficult-page route in section 3.1 requires:

| Model | Context | Max completion | Input | Notes |
|---|---|---|---|---|
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 32,768 | text, image, video | Mixture of experts, 4B active. **The default**, on measured availability |
| `google/gemma-4-31b-it:free` | 262,144 | 32,768 | text, image, video | Dense 31B. Likely stronger, but unusable on the shared pool |

The default is chosen on availability rather than size, and the measurement is worth
recording: probed six times each on the shared free pool, the dense 31B returned 429 on
six of six while the mixture-of-experts model answered five of six at about 1.2 seconds.
Both draw on one upstream Google AI Studio pool, so throttling remains common either way
and the pipeline must treat a 429 as an ordinary event rather than an error. Attaching a
personal Google AI Studio key at OpenRouter's integrations page moves requests onto that
key's own quota and is the practical remedy; it changes no code.

Both advertise `response_format`, `tools` and `seed`. Keep the model configurable and compare others only when evaluation identifies a need. Structured output constrains JSON shape, not truth, and a free endpoint may ignore the schema under load, so Zod post-response validation is mandatory rather than defensive. Record the exact model string including the `:free` suffix, since the paid and free routes are different deployments and may not behave identically. [OpenRouter models](https://openrouter.ai/docs/models), [structured outputs](https://openrouter.ai/docs/features/structured-outputs).

Embeddings do not come from OpenRouter. Its catalogue is chat completions only, with no embedding models at all, so the retrieval side of section 6.1 has to be served another way. Run them locally with `@huggingface/transformers`, which section 9 already listed as an acceptable alternative. Use a symmetric sentence-similarity model at 768 dimensions so the existing `vector(768)` column is unchanged; `Xenova/all-mpnet-base-v2` is the default. Normalize the result. Keep each embedded description below the model input limit. Record model, dimensions and the task it was embedded for; never compare vectors from different embedding models. Similarity only generates candidates, not agreement labels. Benchmark memory, latency and candidate recall before accepting it, and re-embed the collection if the model changes. [Transformers.js](https://huggingface.co/docs/transformers.js/en/index).

Start with four services: web, api, worker and postgres. Only the worker calls OpenRouter, and only the worker loads the local embedding model. API and worker share code, database and PDF volume. pg-boss uses PostgreSQL, so Redis is unnecessary for this design. Make job handlers idempotent even with queue delivery guarantees: a retried external LLM call or partial application write can still repeat work.

## Phase 0: scope and evidence reconnaissance

### 0.1 Select the initial dataset

- Begin with all three Delhivery documents as one collection.
- Reserve the India macroeconomy collection for a later generalization evaluation.
- The ZIP contains two independent three-document datasets; the assignment does not explicitly resolve whether both must be demonstrated. Document the chosen scope.
- Keep runtime processing independent of collection names and filenames.

### 0.2 Inspect representative content

- Examine narrative pages, financial tables, director information, dates, units and footnotes.
- Note that excerpt page positions and original printed page numbers can differ.
- Look for possible examples of the three relationship classes. Verify them manually; do not assume the PDFs contain a genuine contradiction just because figures differ.
- Create a small human-reviewed set of roughly 30–50 claims and 15–25 candidate pairs. These are evaluation examples, not hard-coded runtime outputs.

### 0.3 Define completion criteria

- New PDFs can be uploaded and processed through the interface or API.
- Accepted claims expose supporting evidence.
- Relationships expose both claims, evidence and an explanation.
- Demonstrate corroboration, likely contradiction, context reconciliation, and one observed failure.
- Setup works from a clean checkout and demo is at most three minutes.

**Exit condition:** a written scope, an evaluation set and a preliminary list of difficult examples. If no genuine contradiction is found, keep investigating; do not force a context difference into that category. A clearly labelled supplemental PDF pair can test contradiction behavior, but do not present synthetic material as starter-document evidence.

## Phase 1: foundation and storage

### 1.1 Establish the repository

Suggested paths: `apps/web`, `apps/api`, `apps/worker`, `packages/pipeline`, `packages/db`, `packages/contracts`, `packages/db/migrations`, `tests`, `evaluation`, `sample-output`, and `docs`.

Share the pipeline, database and Zod contracts through npm workspace packages. Keep database clients and secrets in server-only packages. Add a dependency lockfile, `.env.example`, `.gitignore`, Dockerfiles and Compose configuration. Use meaningful commits at working milestones.

### 1.2 Create the data model

| Table | Essential contents |
|---|---|
| collections | ID and name; boundary within which comparisons run |
| documents | Collection, filename, content hash, storage key, publication date if known, page count |
| processing_runs | Document, pipeline/model/prompt versions, stage, timestamps, counts and error summary |
| source_blocks | Document, physical PDF page, printed page label if known, text or table content, block ID, bounding box and coordinate metadata |
| entities | Canonical label, type, aliases and supporting references |
| claims | Entity, original statement, open predicate name, typed value, original and normalized units, time, scope, assertion status, qualifiers JSONB and extraction status |
| claim_evidence | Claim-to-source-block links, exact excerpt or table cell references, verification result |
| relationships | Two claim IDs, label, context differences, concise rationale, supporting evidence IDs, method and version |
| processing_issues | Stage, affected source or claim, failure kind, retry history and resolution |

Use claim records to preserve what each document says. Do not overwrite one source's claim when another disagrees. Multiple source claims may belong to a shared canonical fact group.

Keep the envelope stable but predicates and qualifiers extensible. A new fact type should be represented by data rather than a new SQL table or an LLM-generated migration.

### 1.3 Establish configuration

Proposed initial values, to tune after measurement:

- `DATABASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`, `LLM_MODEL=google/gemma-4-26b-a4b-it:free`, `STORAGE_DIR`.
- `EMBEDDING_MODEL=Xenova/all-mpnet-base-v2`, `EMBEDDING_DIMENSIONS=768`.
- `MAX_UPLOAD_MB=50`, `MAX_PDF_PAGES=300`.
- `LLM_CONCURRENCY=2`, `CANDIDATE_TOP_K=15`.
- A per-document token budget, application timeout and provider retry limit.

These are project defaults, not claims about provider limits. Keep credentials on the backend.

**Exit condition:** containers start, migrations apply, and API and worker can access the same database and files.

## Phase 2: upload and durable processing

### 2.1 Implement ingestion

- Accept one or more PDFs in a collection.
- Check file signature, readable PDF structure, size and page limit; report encrypted or malformed files clearly.
- Compute a SHA-256 hash and identify duplicate uploads within the collection.
- Save the original bytes using an ID or content hash as the storage key.
- Create a processing run and enqueue work in one PostgreSQL transaction using the pg-boss transaction integration supported by the pinned version. Return HTTP 202 with run IDs. If using a separate dispatcher, implement an outbox and recovery explicitly.
- Handle a failure between writing the file and enqueueing by retaining a retryable run state or removing the unused upload. Avoid leaving a falsely successful document.

### 2.2 Track progress

Use stages such as queued, parsing, extracting, normalizing, comparing, completed, completed_with_issues and failed. Store page/chunk counts in PostgreSQL so progress survives API restarts. The frontend can poll every two seconds initially.

### 2.3 Add recovery

- Set explicit retry policies; distinguish transient API failures from invalid PDFs or unsupported input.
- Use bounded exponential backoff and respect rate-limit responses.
- Record completed chunks and make inserts idempotent.
- Use task locks and database uniqueness constraints to prevent duplicate claims and relationships.
- Verify and document how interrupted or stalled worker jobs are recovered; do not assume all crashed jobs automatically retry.

**Exit condition:** upload a PDF, restart a process, and verify the document remains visible with an accurate status and a recovery path.

## Phase 3: PDF parsing and evidence indexing

### 3.1 Parse with unpdf and PDF.js; route difficult pages to the multimodal model

- Validate the page count before extraction. Extract text page by page and retain positioned text items where available.
- Reconstruct simple lines/blocks using positions; identify repeated headers and likely section boundaries. Preserve raw items as well as reconstructed text.
- Plain PDF text extraction does not reliably reconstruct financial tables. Detect table-like layouts using positions, repeated numeric columns and headers; allow manual retry of any page through the visual route.
- For table-heavy, scanned or garbled pages, render selected pages with unpdf using the official pdfjs-dist build and @napi-rs/canvas. Pass page images, their known physical page IDs, and available native text to the model as an image content part.
- Ask for structured table rows/cells with headings, units and footnotes. Store this as model-derived transcription, not independently verified source text.
- Keep the original page image and raw text as evidence. A model transcription cannot independently verify a claim extracted by the same model; use text cross-checks when available and mark visual-only support for review.
- Cache parsing and visual transcriptions by document hash, page, parser/model version and options.
- Run CPU-heavy parsing/rendering in bounded worker_threads or child processes when needed. A Promise timeout alone does not stop synchronous CPU work; terminate the isolated task when its execution limit is reached.

unpdf documents text extraction and Node.js rendering. Gemma 4 accepts image input for visual document understanding. This combined route requires evaluating table quality and explicitly preserving uncertain evidence, and a free model is more likely to need that scrutiny, not less. [unpdf documentation](https://github.com/unjs/unpdf), [OpenRouter image inputs](https://openrouter.ai/docs/features/images-and-pdfs).

### 3.2 Create stable source references

Assign each source block an ID. Store physical page index, original text or page-image reference, block type, extraction method, verification status and optional bounding box. Preserve coordinate origin, dimensions and rotation so future PDF highlights align correctly. Keep printed page labels separately and leave them unknown when unreliable.

### 3.3 Chunk without losing context

- Use headings and paragraph boundaries; start around 1,000–2,000 tokens per chunk.
- Carry section headings into each chunk.
- Split large tables by rows while repeating headers, units and relevant notes.
- Preserve mappings from every chunk back to original source blocks.
- Support evidence spanning a value cell and its headers or a claim and its footnote.

**Exit condition:** representative narrative and table content is readable, and every chunk resolves to the correct source page.

## Phase 4: fact extraction and grounding

### 4.1 Define the extraction contract

Use Zod contracts and a compatible JSON Schema with OpenRouter's `response_format` structured output; parse the response with Zod before accepting it, and treat a schema violation as a normal outcome to repair rather than an exception. A claim should contain a subject, open predicate, original statement, typed value, units, period or as-of date, scope, qualifiers, and source-block IDs. Use null for unknown context instead of guessing. Preserve negative claims, ranges and approximate values.

Example fields, not a required domain schema:

```json
{
  "subject": "Example Ltd",
  "predicate": "revenue",
  "raw_value": "100 crore",
  "numeric_value": "100",
  "currency": "INR",
  "scale": "crore",
  "period_label": "FY2024",
  "scope": "consolidated",
  "assertion_status": "reported",
  "qualifiers": [],
  "evidence_block_ids": ["block-42"]
}
```

This example is synthetic. Preserve decimal values as strings in interchange and decimal.js/PostgreSQL NUMERIC internally; avoid converting financial values through JavaScript Number.

### 4.2 Extract bounded chunks

- Ask for meaningful numerical and semantic claims supported by the supplied material.
- Permit new predicates instead of forcing a fixed revenue/address/director schema.
- Treat PDF text as source data, including any embedded instructions; the extraction step requires no tool execution.
- Record model, prompt and schema versions, token usage and latency.

### 4.3 Verify evidence

- Check referenced blocks exist and belong to the processed document.
- Locate quoted passages in the stored source, allowing only documented whitespace normalization.
- For tables, validate the value cell together with its unit, row/column header and footnote links. Cross-check with native PDF text where possible. If evidence exists only in the page image, retain visual-only or needs_review status until verified; a matching model-generated transcription is not independent validation.
- Separate citation existence from entailment: a real quote can still fail to support the claim.
- Mark unsupported or ambiguous claims as rejected or needs_review; exclude them from confident relationship conclusions.
- Allow a bounded repair attempt with validation feedback.

### 4.4 Deduplicate extraction overlap

Deduplicate repeated extraction of the same source assertion while keeping all evidence links. Preserve separate assertions from independent documents.

**Exit condition:** a reviewer can open an accepted claim, inspect its supporting passage or table and understand what context was extracted.

## Phase 5: normalization and entity resolution

### 5.1 Normalize numbers and units

Use deterministic TypeScript code for separators, Indian numbering, lakh/crore/million/billion, percentages, percentage points, ranges and negative values in parentheses. Use decimal.js arithmetic with decimal strings as inputs. Store both raw and normalized representations and the transformation applied.

Do not convert currencies without an explicit exchange-rate basis. Do not equate nominal and real values or percentages and percentage points. Use source precision to judge rounding compatibility rather than one blanket tolerance.

### 5.2 Normalize context

Track reporting period separately from publication date. Preserve quarter versus year, standalone versus consolidated, geography, segment, actual versus estimate/forecast, revision status and relevant methodology. Resolve fiscal dates only when the convention is supported by the document.

### 5.3 Resolve entities and predicates

- Use exact normalization and source-backed aliases first.
- Use embeddings to suggest candidate aliases and semantically similar predicates.
- Use the LLM only for ambiguous matches, with evidence attached.
- Leave uncertain entities unmerged; similar names or vector scores alone are insufficient.
- Do not automatically equate revenue from operations with total income, or a parent company with its subsidiary.

**Exit condition:** different wording and units can map to comparable claims without losing source wording or context.

## Phase 6: candidate retrieval and relationship reasoning

### 6.1 Generate candidates

Combine entity/alias and predicate matching with embedding retrieval in pgvector. Embed subject, predicate and qualifier descriptions so candidate retrieval is not dominated by numerical values. Start with exact vector search and a top-15 semantic candidate budget; tune recall on the reviewed set.

Keep same-entity/same-predicate exact matches even when outside the semantic top-k. Do not require matching periods or scopes during retrieval: those differences are necessary for the reconciliation case. Compare within collections by default.

pgvector supports exact search and optional approximate indexes; add an index only when corpus size and measured query latency justify it. [pgvector documentation](https://github.com/pgvector/pgvector).

### 6.2 Apply deterministic checks

Calculate unit conversions, interval compatibility, reporting-period differences, scope mismatches and rounding intervals. These are inputs to classification, not automatic proof of either contradiction or reconciliation.

### 6.3 Classify difficult pairs with the LLM

Provide both claims, original evidence, neighboring context and deterministic check results. Return structured fields: label, concise rationale, evidence IDs, differing context dimensions, uncertainty reasons, method and version.

| Label | Meaning |
|---|---|
| corroborates | Comparable claims support the same assertion |
| contradicts | Comparable assertions conflict with strong evidence |
| likely_contradiction | Conflict appears real but a material context question remains |
| reconciled_by_context | Supported time, scope, units or other context explains the apparent conflict |
| insufficient_context | Available evidence cannot resolve the comparison |
| unrelated | Similar text concerns different assertions |

Use the same baseline Gemma model initially. A larger-model retry is optional and should be justified by evaluation results; OpenRouter makes that a configuration change rather than a new integration.

### 6.4 Preserve an audit trail

Keep the original claims, relationship rationale and normalization steps. Do not replace conflicting values with an invented single truth. Do not present LLM-generated confidence as calibrated probability. Do not assume corroboration is transitive or that repeated wording represents independent evidence.

**Exit condition:** the required first three cases show correct evidence and a defensible explanation; the system can abstain on incomplete comparisons.

## Phase 7: API and review interface

### 7.1 Expose a small API

| Endpoint | Purpose |
|---|---|
| POST /collections | Create an independent document collection |
| POST /collections/{id}/documents | Upload PDFs and enqueue processing |
| GET /runs/{id} | Retrieve progress and errors |
| POST /runs/{id}/retry | Retry a failed or recoverable run |
| GET /collections/{id}/facts | Paginated claims with filters |
| GET /facts/{id} | Claim, normalization and evidence details |
| GET /collections/{id}/relationships | Filter by relationship label |
| GET /relationships/{id} | Two claims, evidence and explanation |
| GET /documents/{id}/file | Serve the original PDF locally or authorize hosted access |

### 7.2 Build three views

- Documents: upload, status, pages processed, accepted facts and errors.
- Facts: filter by document, entity, predicate and review status; click to inspect evidence.
- Relationships: side-by-side claims, context differences, source references and explanation.

### 7.3 Make evidence inspection direct

Use PDF.js to navigate to the correct physical page. Display the quoted passage separately. Bounding-box highlights are optional; correct page navigation is core. Include an issues view or panel showing the observed failure and its handling.

**Exit condition:** an unfamiliar reviewer can upload a PDF and inspect the three relationship categories and a failure without developer assistance.

## Phase 8: evaluation and generalization

### 8.1 Evaluate distinct stages

- Accepted-claim grounding precision on a human-reviewed sample.
- Evidence-reference validity, reported separately from semantic support.
- Candidate recall on known relevant pairs.
- Relationship confusion matrix, especially false contradictions.
- Coverage and abstention rate, so precision is not inflated by suppressing almost everything.
- Processing latency, token use, estimated API cost and failed-page/chunk counts.

State sample sizes and distinguish development examples from held-out examples. Set improvement goals after measuring the baseline; do not claim arbitrary accuracy targets were achieved.

### 8.2 Run focused robustness checks

Test duplicate uploads, interrupted processing, invalid or encrypted PDFs, missing units, wrong table-column selection, rate-limit errors and unsupported evidence. Record at least one genuine extraction or reasoning failure. Synthetic fixtures are useful for regression tests but do not establish performance on the starter documents.

### 8.3 Freeze and test generalization

Freeze prompts and normalization rules before running the India macroeconomy set as a separate collection. Record failures before tuning. If you tune on that set, label it development data and use another unseen PDF for the final generalization check.

**Exit condition:** sample outputs, measured results, the four required cases and honest limitations are saved for the README and demo.

## Phase 9: optional improvements, in priority order

| Priority | Subphase | Implementation | Completion evidence |
|---|---|---|---|
| 1 | Incremental ingestion | Process new document hashes only; compare new claims with stored candidates; version outputs | Add a fourth document without reparsing the first three |
| 2 | Large-PDF efficiency | Cached parsing, chunk checkpoints, bounded concurrency, selective visual processing and progress counts | Report runtime and memory on a larger PDF |
| 3 | Source highlighting | Map stored PDF.js text-item coordinates to viewer coordinates, including rotation; use page-level evidence where exact regions are unavailable | Clicking evidence highlights the correct region |
| 4 | Flexible schema handling | Predicate registry with descriptions, aliases and units; typed qualifier lists in JSONB | A new fact type appears without a SQL migration |
| 5 | Many-document search | Batched embeddings, SQL indexes and pgvector HNSW if needed | Measure latency and candidate recall as corpus grows |
| 6 | Human correction | Accept/reject a claim or relation; retain original output and recompute affected results | Review action changes displayed status with an audit trail |
| 7 | Stronger parsing or reasoning | Tesseract.js OCR of rendered page images, or a stronger OpenRouter model only for flagged chunks/pairs | Show the baseline failure and measured improvement |
| 8 | Grounded question answering | Retrieve accepted claims and relationships; answer with evidence and conflicts | An answer cites the stored evidence and acknowledges disagreement |
| 9 | Graph view | Client-side claim/entity relationship visualization using existing records | Clicking a graph edge opens the same evidence comparison |

Optional Node.js alternatives:

- Local OCR: tesseract.js on rendered page images. It does not directly accept PDF files, and OCR alone does not reconstruct table semantics. [Tesseract.js](https://github.com/naptha/tesseract.js).
- Hosted embeddings: a dedicated embeddings provider, if local embedding latency or recall proves inadequate. This is now the alternative rather than the default, since OpenRouter serves no embedding models and the local route is the baseline.
- Queue dashboard: @pg-boss/dashboard for inspecting jobs if operational visibility is useful. Keep it separate from the reviewer-facing fact interface. [pg-boss](https://github.com/timgit/pg-boss).

Each extension should address an observed limitation. A graph view and chat are optional presentation features; neither replaces the core comparison workflow.

## Phase 11: package and submit

### 11.1 Prepare the repository

README sections: Setup and Run Instructions; Video Demo; Approach; Limitations and Next Steps; Additional Notes. Explain the architecture, key decisions, AI tools used and optional features actually completed.

Include `.env.example`, migrations, exact run commands, locked dependencies, human-readable evaluation results and enough sample output for evaluation without paid API access. A read-only saved-output mode is useful; clearly distinguish it from live processing.

### 11.2 Record the demo

| Time budget | Content |
|---|---|
| 0:00–0:25 | Upload and start processing; show progress |
| 0:25–1:00 | Corroboration with both sources |
| 1:00–1:35 | Genuine or likely contradiction with evidence |
| 1:35–2:10 | Context-resolved difference |
| 2:10–2:40 | Real failure and handling or next improvement |
| 2:40–3:00 | Generalization result and one key trade-off |

If processing takes longer, use a labelled time cut and say which results are preprocessed. Do not imply an edited wait is actual processing latency.

### 11.3 Final check and submission

Follow the README from a clean checkout, process a new PDF, open cited source pages, confirm all four cases, check that credentials are excluded, and submit the GitHub and demo links through the assignment form.

## Suggested effort allocation

Illustrative allocation for seven focused workdays, not a deadline or delivery guarantee:

| Day | Focus |
|---|---|
| 1 | Phases 0–1: inspect evidence, define evaluation, scaffold schema |
| 2 | Phases 2–3: uploads, jobs, PDF parsing and source references |
| 3 | Phase 4: structured extraction and grounding verification |
| 4 | Phases 5–6: normalization, matching and relationship reasoning |
| 5 | Phase 7 and early Phase 8: interface and end-to-end evaluation |
| 6 | Phase 8: correct failures, test the second dataset, then one optional extension |
| 7 | Phase 11: clean setup check, README, sample results and video |

Cloud deployment is outside this core allocation. If time is tight, use an OpenAPI UI via @fastify/swagger and @fastify/swagger-ui for the required interface and reduce UI scope. Preserve evidence quality, the four cases and reproducible submission instructions.
