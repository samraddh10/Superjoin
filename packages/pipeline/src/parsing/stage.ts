/**
 * The parsing stage.
 *
 * Reads the stored PDF page by page, reconstructs layout, classifies each page and writes
 * source blocks. This is the first real stage the worker runs; before it, a job verified
 * its inputs and completed having done nothing.
 *
 * Two behaviours here are deliberate and easy to get wrong the other way.
 *
 * A page that yields nothing is not automatically a failure. `docs/difficult-pages.md`
 * lists dividers, a title slide and a contact slide that legitimately contain no facts.
 * Those are counted and reported, never raised as issues and never retried.
 *
 * A page that fails to parse does not fail the document. One unreadable page out of a
 * hundred should cost that page, not the other ninety-nine, so the failure is recorded
 * against the run and parsing continues. The run ends `completed_with_issues`, which is
 * what makes partial success visible rather than dressing it as either outcome.
 */

import type { StageHandler, ProcessingContext } from '../processor.ts';
import { extractPageText } from '../pdf-text.ts';
import { readObject } from '../storage.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { buildLayout } from './layout.ts';
import { classifyPage, type PageClassification } from './classify.ts';
import { persistPageBlocks, PARSER_VERSION } from './persist.ts';

export interface ParseSummary {
  readonly pagesTotal: number;
  readonly pagesParsed: number;
  /** Pages that legitimately held no facts. Not failures. */
  readonly pagesEmpty: number;
  readonly pagesFailed: number;
  readonly blocksWritten: number;
  /** Pages the classifier wants the multimodal model to read as well. */
  readonly pagesNeedingVisualRoute: readonly number[];
}

/** How often to write progress back, in pages. */
const PROGRESS_INTERVAL = 5;

export async function parseDocument(context: ProcessingContext): Promise<ParseSummary> {
  const { db } = context.database;
  const bytes = await readObject(context.storageDir, context.storageKey);

  let pagesParsed = 0;
  let pagesEmpty = 0;
  let pagesFailed = 0;
  let blocksWritten = 0;
  const needsVisual: number[] = [];

  for (let physicalPage = 0; physicalPage < context.pageCount; physicalPage += 1) {
    try {
      const pageText = await extractPageText(bytes, physicalPage);
      const classification: PageClassification = classifyPage(buildLayout(pageText));

      if (classification.kind === 'empty' || classification.kind === 'sparse') {
        // Counted, not flagged. Raising an issue here would fill the issues view with
        // pages that are working exactly as intended.
        pagesEmpty += 1;
        pagesParsed += 1;
        continue;
      }

      const persisted = await persistPageBlocks(db, pageText, classification, {
        documentId: context.job.documentId,
        producedBy: PARSER_VERSION,
      });

      blocksWritten += persisted.blocksWritten;
      if (classification.needsVisualRoute) needsVisual.push(physicalPage);
      pagesParsed += 1;
    } catch (error) {
      // One bad page costs that page, not the document.
      pagesFailed += 1;
      await recordIssue(db, context.job.runId, {
        stage: 'parsing',
        failureKind: 'page_parse_failed',
        failureClass: 'permanent',
        message: `physical page ${physicalPage}: ${(error as Error).message}`,
        physicalPage,
      });
    }

    if (physicalPage % PROGRESS_INTERVAL === 0) {
      await recordProgress(db, context.job.runId, { pagesProcessed: pagesParsed });
    }
  }

  await recordProgress(db, context.job.runId, { pagesProcessed: pagesParsed });

  return {
    pagesTotal: context.pageCount,
    pagesParsed,
    pagesEmpty,
    pagesFailed,
    blocksWritten,
    pagesNeedingVisualRoute: needsVisual,
  };
}

/** The stage as the processor consumes it. */
export const parsingStage: StageHandler = {
  stage: 'parsing',
  async run(context) {
    await parseDocument(context);
  },
};
