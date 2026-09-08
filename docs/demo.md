# Demo script

Three minutes, to the time budget in plan 11.2. Written to be read off while recording.

## Before you press record

1. **Process a collection ahead of time.** Extraction takes minutes and a demo cannot wait
   for it. Have a finished collection ready, and a second browser tab on a fresh empty
   collection for the upload shot.
2. **Check what you actually have.** Open the Relationships tab and note which labels are
   present. If there is no `contradicts`, say `likely_contradiction` instead — do not
   describe a case the recording does not show.
3. **Set the browser to about 1400px wide** so the side-by-side pair view does not collapse
   into one column.
4. Have `docs/evaluation.md` open in a tab for the closing trade-off.

If processing has to be cut, say so on camera: *"this section is cut, processing took N
minutes."* Plan 11.2 asks for that explicitly, and an edited wait presented as real latency
is the one thing that would undermine everything else.

---

## 0:00–0:25 — Upload and progress

**Show:** the Documents tab. Drag in the three PDFs. Let the first status appear.

> "TruthMesh takes unfamiliar PDFs and turns them into claims you can check, and
> relationships between what different documents say. Here are three Delhivery filings —
> a 2022 prospectus, the FY24 annual report, and the Q4 earnings deck. Nothing about them
> is configured anywhere; the pipeline has no knowledge of these files."

Point at the row as it moves to `parsing`.

> "Processing is a durable job, so this survives a restart. Pages processed, facts
> accepted, and issues are all live."

**Then switch to the pre-processed collection.**

---

## 0:25–1:00 — Corroboration

**Show:** Relationships tab, click the `corroborates` chip.

> "Two documents, the same measure, and the system says they agree."

Open one. Point at the two panels.

> "Both claims are shown whole and neither is presented as the correct one. That is
> deliberate — the system never replaces two conflicting figures with an invented single
> truth."

Point at **Why**.

> "The rationale is stored, not generated for this screen."

Click **inspect evidence** on one side. Let the PDF page render.

> "This is the original page, and the highlight is the row the claim was taken from. The
> quoted passage is shown separately above it — the system doesn't ask you to trust that
> the quote is in there, it shows you the page."

Point at **Citation** and **Support**.

> "Two separate lines. Whether the quote is really in the document, and whether it supports
> the claim, are different questions — a real quote can still fail to support the claim
> citing it."

---

## 1:00–1:35 — Conflict

**Show:** the `contradicts` or `likely_contradiction` chip. Use whichever you have.

> "Here the two documents disagree."

Open it. Point at **Why** and **What differs**.

> "The label is `likely_contradiction` rather than `contradicts` because a material
> question is unresolved — that's what the What is still open section says. The system is
> allowed to say the conflict looks real but it can't fully close it."

Expand **How this was decided**.

> "Method, model, prompt version. And no confidence score — none is stored anywhere. A
> number here would get read as a calibrated probability, and it wouldn't be one."

---

## 1:35–2:10 — Reconciled by context

**Show:** the `reconciled_by_context` chip.

> "These two figures differ, and that is not a contradiction."

Point at **What differs** and the `could explain a gap` badges.

> "One covers a quarter, the other the full year. The difference is fully accounted for by
> the period, so the label is `reconciled by context` — not agreement, and not conflict."

> "This is the case a naive numeric comparison gets wrong. It sees two different numbers
> for the same measure and calls it a contradiction."

---

## 2:10–2:40 — A real failure

**Show:** the Issues tab.

> "This is what went wrong, grouped by kind, kept rather than cleaned up."

Point at a throttling entry.

> "Provider rate limiting. Classified transient, backed off, and abandoned after four
> consecutive failures rather than burning the quota — and the document is marked completed
> *with issues*, not completed. It never looks like a clean success when it wasn't."

Then, honestly:

> "That's also a real limitation. On a free tier, a full collection is hundreds of model
> calls and the quota runs out. The measured accuracy numbers in the repo say 'not
> measured' for that reason, rather than reporting a zero."

Optionally show a `needs review` claim in Facts.

> "And a claim supported only by a model's own transcription of a page image stays in
> review — the model wrote both, so that's one witness, not two."

---

## 2:40–3:00 — Generalization and the trade-off

> "The same pipeline, unchanged and with prompts frozen, was run on three documents it had
> never seen — the Economic Survey, an RBI annual report, and an IMF consultation. All 284
> pages parsed, coordinates recovered for every block, and no new failure kind appeared."

> "The one thing that degraded was reading printed page numbers, 97% down to 66%. That's
> recorded before any tuning, and it costs display detail only, because nothing in the
> system locates a page by its printed label."

Close on the trade-off:

> "The core trade-off is that this system prefers abstaining to guessing. Uncertain
> entities stay unmerged, unsupported claims are rejected, and `insufficient_context` is a
> first-class answer sitting in the same list as `contradicts`. That costs recall. It's the
> right trade for a tool whose whole purpose is telling you when two documents disagree —
> a false contradiction is far more expensive than a missed one."

---

## If a case is missing

Do not invent it. Say what you have:

> "This run didn't produce a clear contradiction. The gold set records three candidate
> conflicts in these documents and all three are labelled `likely_contradiction`, because
> in every case a definition or basis is left unstated by the sources — so that's the
> honest label here too."

That reads better than describing something the screen does not show.
