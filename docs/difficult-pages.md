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

`node` is not on `PATH` on this machine (`bun`, `uv`, `jj`, `python3` are). Node 24 must be installed before Phase 1.1, since `pdfjs-dist`, `@napi-rs/canvas` and `pg-boss` run on Node rather than under bun.
