# Phase 0.2: content inspection and difficult pages

Method: text and positioned words extracted per page with PyMuPDF as a throwaway reconnaissance tool (not a project dependency), then read by hand. Page numbers below are **physical PDF page indexes, zero-based**, which is the identifier the pipeline will use.

## Structural findings that constrain the design

### 1. No PDF page labels in any document

All three PDFs return an empty page label for every page. Printed page numbers exist only as text on the page, in a different position per document:

| Document | Printed label location | Example |
|---|---|---|
| `doc-01-prospectus` | First non-blank line of the page | physical 43 -> printed "214"; physical 83 -> printed "258" |
| `doc-02-annual-report` | Bottom of page, **two labels per physical page** | physical 1 -> "2 3"; physical 5 -> "10 ... 11" |
| `doc-03-earnings-deck` | Bottom of page, single number | physical 13 -> "13" |

Consequence: printed labels must be a separately stored, optional, per-document heuristic, and left null when unreliable. Evidence and citations key off the physical page index. This is exactly the case plan item 3.5 anticipates.

### 2. The annual report is a two-page-per-sheet spread

Each physical page of `doc-02` contains two printed pages of the original report side by side. Two consequences:

- A single physical page can hold two unrelated sections, so a "page" is not a semantic unit for chunking. Section boundaries must come from layout, not page breaks.
- Reading order across the sheet is column-wise, and naive top-to-bottom extraction interleaves the two halves. See failure F2.

### 3. Excerpt page ranges are non-contiguous

`doc-01` retains original pages 1, 4, 26-37, 94-120, 216-245, 250-278; `doc-02` retains original pages 2-64 and 105-141. Printed labels therefore jump. Nothing may assume label continuity or infer a page from a label.

## Observed extraction failures

These are real failures found during inspection, not hypotheticals. F1 and F2 are the leading candidates for the demonstrated-failure requirement.

### F1: chart values extracted without their axis labels

`doc-03` pages 8, 9, 10, 11, 12, 15, 21 and `doc-02` page 5 are bar-chart pages. Linear text extraction returns bare numbers with the category labels in a separate run, so value-to-period association is lost or wrong.

`doc-02` page 5, adjusted-EBITDA chart, as linear text:

```
(6.9) (9.1) 1.0 (5.6) 0.9
(2,533) (2,532) 715 (4,039) 758
FY20 FY21 FY22 FY23 FY24
```

Read in order this gives FY20 = (2,533), FY21 = (2,532). Positioned extraction gives the opposite: the x-coordinates are FY20@966, FY21@989 against values (2,532)@963, (2,533)@987. The correct mapping is FY20 = (2,532), FY21 = (2,533), confirmed independently by `doc-01` page 43, which reports (2,531.93) for Fiscal 2020 and (2,532.83) for Fiscal 2021.

Two nearly equal adjacent values make this silent: the wrong answer is plausible and off by only one unit. Any claim sourced from a chart page must carry positional evidence or be held at `needs_review`.

#### Confirmed against the project dependency (Phase 1.2)

The finding above came from PyMuPDF, used as a throwaway reconnaissance tool. It has since been reproduced through `unpdf`, the PDF.js wrapper the pipeline actually runs, with identical coordinates. Measuring horizontal midpoints rather than left edges, because charts centre a value over its column and a value string is wider than its label:

| Run | x-centre | Binds to | Distance |
|---|---|---|---|
| `(2,532)` | 973.6 | `FY20` @ 975.3 | 1.7pt |
| `(2,533)` | 998.2 | `FY21` @ 998.3 | 0.2pt |
| `(4,039)` | 1045.1 | `FY23` @ 1044.8 | 0.3pt |

Column pitch on this axis is 23.2pt, so every binding is an order of magnitude inside its column. The mapping is FY20 = (2,532), FY21 = (2,533), as the prospectus independently reports. This is pinned as a regression test in `packages/pipeline/src/pdf-text.test.ts`, which asserts both that reading order is wrong here and that positional binding is right, so the mitigation cannot silently stop being exercised.

#### The inversion is local, which makes it worse

Reading order is **not** uniformly wrong on chart pages. It is usually right.

The top-five-customers chart sits on the same physical page, at the same five column positions, and PDF.js emits it in correct left-to-right order: 41.8, 42.7, 40.5, 39.1, 38.4. Only the adjusted-EBITDA chart, a few hundred points higher on the same sheet, comes out inverted.

Three consequences, and they are the reason this section exists:

- There is no page-level or document-level signal that marks reading order as untrustworthy. A page that inverts one chart emits the next one correctly.
- No cheap heuristic catches it. The inverted pair is indistinguishable, by any property other than coordinates, from the many pairs that are fine.
- Positional binding must therefore be applied to **every** chart value unconditionally. Applying it only where reading order "looks wrong" would miss exactly this case, because it does not look wrong.

A corollary for the classifier: a chart value bound to its label by coordinates is ordinary evidence, not a special case needing review. What earns `needs_review` is a value the binder could not place — one sitting more than half a column pitch from any label, or too close to call between two. That distinction is implemented in `packages/pipeline/src/axis-binding.ts`, which returns no label and a stated reason rather than a nearest guess.

### F2: multi-column reading order merges distinct lists

`doc-02` page 20 places "Board of Directors" and "Key Managerial Personnel" side by side. Linear extraction interleaves them:

```
Sahil Barua  Managing Director and Chief Executive Officer
Aruna Sundararajan  Non-Executive Independent Director
Amit Agarwal  Chief Financial Officer
Saugata Gupta  Non-Executive Independent Director
Suraj Saharan  Chief People Officer
```

Amit Agarwal (CFO) and Suraj Saharan (Chief People Officer) are key managerial personnel, not directors, but appear inside the director sequence. An extractor working from this text will assert that the CFO is a board member. The page also repeats Sahil Barua and Kapil Bharati, once per column, which invites duplicate claims.

### F3: source-internal arithmetic that does not close

`doc-03` page 4 states FY24 EBITDA "increased by Rs. 578 Cr to Rs. 127 Cr from Rs. (452 Cr) in FY23". 127 - (-452) = 579, not 578. The document is internally rounding-inconsistent. A naive consistency check flags a contradiction where the correct answer is a rounding artefact, which is precisely the false-contradiction risk Phase 8.2 measures.

## Table-heavy pages worth routing to the visual path

| Document | Physical pages | Content |
|---|---|---|
| `doc-03` | 7, 13, 14, 16, 18, 19, 20, 22, 23, 24 | Operating metrics, quarterly P&L, balance sheet, cash flow, cost drivers, ESOP schedule |
| `doc-02` | 21, 35 | Directors' report financial summary, MD&A consolidated performance |
| `doc-01` | 20, 43 | Summary financial information, key financial and operational indicators |

Native text on these pages is usable but column-to-header association is positional, not structural. They are the primary test of plan items 3.2 and 3.3.

## Sparse and image-only pages

Pages where text extraction returns almost nothing, and the page is either a divider or an image:

| Document | Physical page | Characters | Nature |
|---|---|---|---|
| `doc-03` | 17 | 12 | Section divider ("Appendix") |
| `doc-03` | 3 | 27 | Divider with a headline claim ("FY24: EBITDA profitable") |
| `doc-03` | 1 | 32 | Title slide |
| `doc-03` | 26 | 59 | Contact slide |
| `doc-01` | 62 | 69 | App screenshots, image-only |
| `doc-02` | 8 | 228 | Infographic ("three pillars") |
| `doc-02` | 4 | 642 | Photo page with two short narrative blocks |

These must not be treated as extraction failures requiring retry. A page can legitimately contain no facts. Distinguishing "empty" from "failed" is a Phase 3 requirement.

## Fact density

Per-document character counts from native extraction: `doc-01` 336,394; `doc-02` 618,469; `doc-03` 23,511. The 27-page earnings deck carries the highest fact density per page and is the best source for the demo; the annual report carries the most cross-referencable detail; the prospectus supplies the 2019-2021 history that the other two restate.

## Environment gap found during inspection

At the time of inspection `node` was not on `PATH` on this machine (`bun`, `uv`, `jj`, `python3` were), and the conclusion recorded here was that Node 24 must be installed before Phase 1.1, since `pdfjs-dist`, `@napi-rs/canvas` and `pg-boss` run on Node rather than under bun.

**Resolved at Phase 1.1.** The runtime is Node.js 24 LTS, as `superjoin-implementation-plan.md` specifies, and `package.json` pins `engines.node` to `>=24.0.0`.

An earlier revision of this section argued that Node 24 was unnecessary, on the grounds that the package constraints are lower:

| Package | Requires |
|---|---|
| `pdfjs-dist` 6.3.289 | `node >=22.13.0 \|\| >=24` |
| `pg-boss` 12.30.0 | `node >=22.12.0` |
| `unpdf` 1.8.1 | `node >=22` |

Those figures are accurate and they do not settle the question. The plan sets the runtime version; a package floor is a lower bound, not a recommendation. The claim is left here rather than deleted because the reasoning error is worth keeping visible: verifying a constraint is not the same as being entitled to relax it.

The bun/Node split this note anticipated is dropped in favour of Node only, which the plan also implies by naming a single TypeScript toolchain across the API, worker and shared packages.
