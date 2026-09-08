# TruthMesh

A fact knowledge layer over PDFs. Upload unfamiliar documents; get back claims with the
passage that supports each one, and explained relationships between claims that different
documents make about the same thing — corroboration, likely contradiction, and differences
that context reconciles.

Built against three Delhivery filings (a 2022 prospectus, an FY24 annual report and a Q4
FY24 earnings deck) and tested for generalization on three unrelated macroeconomic
documents from the Economic Survey, the RBI and the IMF.

---

## Setup and run instructions

**Requirements:** Docker Desktop. Nothing else — the containers build their own toolchain.

```bash
git clone <this repo>
cd Superjoin
cp .env.example .env        # then add a model key, see below
docker compose up -d --build
```

Open **http://localhost:5173**. Create a collection, then drag in **at least two PDFs**.

One document is not enough to see the system's point: corroboration between two claims
requires them to come from *different* documents, so a single upload produces facts and no
relationships. Use all three from a dataset.

Migrations run automatically — the `migrate` service must exit successfully before the API
and worker start, so there is no separate setup step.

### The model key

Only the worker talks to a model. Put a key in `.env`:

```
OPENROUTER_API_KEY=<your key>
OPENROUTER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-3.5-flash-lite
```

The client is plain OpenAI-compatible, so `OPENROUTER_BASE_URL` can point at OpenRouter or
straight at any provider speaking that protocol. Two things are worth knowing before you
pick one, both learned the hard way and documented in `docs/evaluation.md`:

- **The model must honour `response_format` with a JSON schema.** Gemma ignores it — asked
  for a strict schema it replies with prose bullet points — so extraction produces nothing.
  Gemini models honour it. Zod rejects the malformed output either way, so nothing corrupt
  reaches the database, but the run yields no claims.
- **Free tiers are the binding constraint, not model speed.** Successful calls run at a
  2.2s median. What makes a run slow is rate limiting and daily quotas.

To use a Google key directly, get one at https://aistudio.google.com/apikey. To route
through OpenRouter instead, set the base URL to `https://openrouter.ai/api/v1` and prefix
the model (`google/gemini-3.5-flash-lite`).

### Checking it works

```bash
docker compose ps                    # postgres healthy, plus api, web, worker
curl http://localhost:3000/ready     # {"ok":true,...}
docker compose logs -f worker        # watch documents process
```

The API reporting `"modelMode":"saved-output"` is correct: it deliberately has no model
access. Only the worker does.

### Tests and evaluation

```bash
npm install && npm test              # 422 tests; needs postgres up
npx tsx --conditions development evaluation/src/run.ts "<collection name>"
```

---

## Video demo

*(link to be added)*

---

## Approach

Five stages, each of which can fail without destroying the others' work.

| Stage | What it does |
|---|---|
| **Parse** | unpdf/PDF.js text with positions; lines, columns and blocks reconstructed from coordinates; table-like and scanned pages routed to a multimodal transcription |
| **Extract** | bounded chunks sent to the model under a Zod-defined JSON schema; claims cite `[B1]`-style block handles rather than inventing page references |
| **Verify** | three separate questions: does the cited block exist, is the quoted passage really in it, and does that passage state what the claim reports |
| **Normalize** | decimal.js throughout; scale words, Indian numbering, percentages; periods, scopes and entities resolved with the model only for genuinely ambiguous names |
| **Compare** | exact entity/predicate matching unioned with pgvector top-k; deterministic checks; the model labels the pair from both claims and their evidence |

### Decisions worth defending

**A claim is never overwritten because another document disagrees.** Disagreement is two
claims and a relationship between them. There is no "resolved" value anywhere in the
schema, because inventing one is the failure mode the assignment is really about.

**No confidence score is stored, requested, or displayed.** A number on the screen is read
as a calibrated probability whatever the label says. What the interface shows instead is
the rationale, the differing context dimensions, the unresolved questions, and the
deterministic checks the classifier was given — marked as inputs, not as proof.

**Citation existence and entailment are separate fields.** A quote can be genuinely present
in the document and still fail to support the claim citing it. One combined "valid" flag
would erase that finding, which is a real one: it is why claims extracted from a
disclaimer page are rejected rather than accepted.

**A claim supported only by a model transcription stays in review.** The model wrote both
the claim and the transcription; that is one witness, not two.

**Abstention is a first-class answer.** `insufficient_context` appears in the same list, in
the same shape, as `contradicts`. A system only visible when confident cannot be judged on
how often it should have abstained.

**Financial values never pass through a JavaScript number.** Decimal strings from Postgres
`NUMERIC` to the browser, decimal.js for arithmetic.

**Rounding compatibility comes from each source's own precision**, not one blanket
tolerance. That is why 8,142 Cr and 81,415 million agree while (1,229) and (1,003.79)
million do not.

### Stack

Node 24 + TypeScript throughout. Fastify, Zod, pg-boss, PostgreSQL with pgvector, Drizzle,
unpdf, React + Vite, PDF.js, decimal.js, local `@huggingface/transformers` embeddings at
768 dimensions. Four services under Compose: web, api, worker, postgres.

---

## Limitations and next steps

Stated plainly, because several of these are load-bearing.

**Measured accuracy is not available.** The evaluation harness implements all six of the
plan's measurements against a 50-claim, 25-pair hand-reviewed gold set, and it runs — but
every run so far has been throttled or quota-limited before producing enough output to
score. The report prints `not measured` rather than a zero, because a zero is a result and
an absence is not. See `evaluation/results/`.

**Grounding may be too strict.** Correct facts have been rejected on entailment —
"BSE and NSE" as `proposed_listing_exchanges` is a true statement that did not survive
verification. Whether the threshold is right is exactly what the gold set would answer,
and has not been answered.

**Table transcription is unreliable on the free tier.** The visual route asks for
structured rows and often gets a Markdown table back. It is rejected rather than stored, so
those pages fall back to native text.

**The pipeline is call-hungry.** Roughly one model call per chunk, one per difficult page,
and one per ambiguous entity — several hundred for a 227-page collection. That is inherent
to grounded extraction, but it makes free tiers impractical for a full collection.

**Printed page labels degrade on unfamiliar documents** — 96.8% coverage on the development
set, 65.6% on the held-out one. Recorded before any tuning. It costs display detail only:
nothing locates a page by label, because the starter documents already proved labels
unreliable.

**Entity resolution is deliberately conservative.** Uncertain names stay unmerged, which
costs recall to protect against merging a parent with its subsidiary.

### Next

Measure the gold set on a quota that allows a full run; re-tune the entailment threshold
against it; incremental ingestion so a fourth document does not reparse the first three;
bounding-box highlights are implemented but only where the parser stored a box.

---

## Additional notes

### Observed failures

The assignment asks for real ones. These are documented in `docs/evaluation.md` with the
evidence that found them:

- **Provider throttling** stopping extraction entirely, handled as an ordinary event —
  classified transient, backed off, abandoned after consecutive failures, and surfaced in
  the interface's Issues view rather than crashing.
- **A run reporting `completed` having extracted nothing**, because the issue-resolution
  sweep cut on when a problem was *first* recorded rather than when it was last seen — so
  failures the current attempt had just re-recorded were marked resolved. Fixed, with a
  regression test that fails against the old cutoff.
- **Entity adjudication costing hours per document**, because it asked the model about
  three candidates for every distinct subject with nothing capping how often. Bounded.

### AI tools used

Built with Claude Code as a pair programmer across all phases: schema design, pipeline
implementation, the React interface, and the evaluation harness. Every commit message
records the reasoning behind the decision it carries, and `docs/` holds the longer-form
findings. The implementation plan in `superjoin-implementation-plan.md` was written first
and followed phase by phase.

### Repository layout

```
apps/web        React review interface
apps/api        Fastify HTTP API
apps/worker     pg-boss consumer running the pipeline stages
packages/pipeline   parsing, extraction, normalization, comparison
packages/db     Drizzle schema and migrations
packages/contracts  Zod contracts shared by API and web
evaluation      gold set, scorer, freeze manifest, results
docs            findings: scope, difficult pages, extraction, comparison, evaluation
```
