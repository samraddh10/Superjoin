# Phase 0.1: scope

## Working collection

The **Delhivery** collection is the working dataset for development and for the demo:

| Document ID | File | Physical pages | Published |
|---|---|---|---|
| `doc-01-prospectus` | `datasets/delhivery/01-delhivery-prospectus-2022-excerpt.pdf` | 100 | May 2022 |
| `doc-02-annual-report` | `datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf` | 100 | August 2024 |
| `doc-03-earnings-deck` | `datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf` | 27 | 17 May 2024 |

The three documents are excerpts of public filings by the same issuer, in three disclosure formats (prospectus, annual report, investor presentation) with publication dates spanning two years. They share entity, overlap heavily on financial and operational facts, and restate the same historical fiscal years under different definitions. That overlap is what makes cross-document reconciliation testable.

## Held-back collection

The **India macroeconomy** collection (`datasets/india-macroeconomy/`, three documents, 89/100/95 pages) is reserved for the Phase 8.5 generalization run. It is not read during development beyond confirming it parses. Prompts and normalization rules are frozen before it is processed for the first time.

Rationale for holding it back: the assignment asks whether the system generalizes to unfamiliar PDFs. If both collections are used for development, nothing is left to answer that question with.

## Boundary rules

- Comparisons run **within a collection**. The two collections are independent and are never compared with each other.
- Runtime behaviour must not depend on collection names, file names, or the ordinal prefixes in the file names. The numbering here is provenance metadata, not a processing signal.
- Nothing about Delhivery, logistics, or Indian accounting conventions is hard-coded into extraction, normalization or classification. Where a convention is needed (Indian numbering, fiscal-year labels), it is a general rule, not a document-specific one.

## Assignment ambiguity, and how it is resolved

The starter ZIP contains two independent three-document datasets. The assignment does not state whether both must be demonstrated. The choice recorded here: **build and demo on Delhivery, report measured results on India macroeconomy as a generalization test.** Both are processed by the submitted system; only one informed its development.
