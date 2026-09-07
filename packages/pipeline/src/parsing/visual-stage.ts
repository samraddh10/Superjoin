/**
 * The visual-transcription stage.
 *
 * Runs after parsing, over the pages parsing marked as structured. Everything about its
 * error handling follows from one measured fact: on the free tier the upstream pool
 * returns 429 for a large share of requests, so being throttled is normal operation here
 * rather than an exception.
 *
 * The consequences, all deliberate:
 *
 *   - A throttled page costs that page. Its native-text blocks are already stored, so the
 *     document remains usable and the run ends `completed_with_issues`.
 *   - A budget caps how many pages are attempted per run. Without one, a hundred-page
 *     document spends hours in backoff and the run looks stalled while working correctly.
 *   - Consecutive throttling stops the stage early. Once the pool is refusing, continuing
 *     to ask buys nothing and delays the rest of the pipeline.
 *
 * None of this is a substitute for having the capacity. It is what keeps the pipeline
 * honest about not having it.
 */

import type { Database } from '@superjoin/db';

import { ModelError, type CompletionProvider } from '../model/index.ts';
import { extractPageText } from '../pdf-text.ts';
import type { ProcessingContext, StageHandler } from '../processor.ts';
import { recordIssue } from '../run-state.ts';
import { readObject } from '../storage.ts';
import { toLayoutText, buildLayout } from './layout.ts';
import {
  TRANSCRIPTION_PROMPT_VERSION,
  pagesNeedingTranscription,
  persistTranscription,
  transcribePage,
} from './transcribe.ts';

export interface VisualStageOptions {
  readonly client: CompletionProvider;
  /** SHA-256 of the document, used to key the stored page images. */
  readonly documentHash: (context: ProcessingContext) => Promise<string> | string;
  /** Most pages to attempt in one run. */
  readonly maxPages?: number;
  /** Give up after this many throttled pages in a row. */
  readonly maxConsecutiveFailures?: number;
  readonly scale?: number;
}

const DEFAULTS = {
  maxPages: 40,
  maxConsecutiveFailures: 3,
} as const;

export interface VisualSummary {
  readonly pagesConsidered: number;
  readonly pagesTranscribed: number;
  readonly pagesThrottled: number;
  readonly pagesFailed: number;
  readonly blocksWritten: number;
  readonly stoppedEarly: boolean;
}

export async function transcribeDocument(
  context: ProcessingContext,
  options: VisualStageOptions,
): Promise<VisualSummary> {
  const { db } = context.database;
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;
  const maxConsecutive = options.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures;

  const candidates = await pagesNeedingTranscription(db as Database, context.job.documentId);
  const selected = candidates.slice(0, maxPages);

  if (selected.length === 0) {
    return {
      pagesConsidered: 0,
      pagesTranscribed: 0,
      pagesThrottled: 0,
      pagesFailed: 0,
      blocksWritten: 0,
      stoppedEarly: false,
    };
  }

  const bytes = await readObject(context.storageDir, context.storageKey);
  const documentHash = await options.documentHash(context);
  const producedBy = `${options.client.model}/${TRANSCRIPTION_PROMPT_VERSION}`;

  let transcribed = 0;
  let throttled = 0;
  let failed = 0;
  let blocksWritten = 0;
  let consecutive = 0;
  let stoppedEarly = false;

  for (const physicalPage of selected) {
    if (consecutive >= maxConsecutive) {
      stoppedEarly = true;
      await recordIssue(db, context.job.runId, {
        stage: 'parsing',
        failureKind: 'visual_route_abandoned',
        failureClass: 'transient',
        message: `stopped after ${consecutive} consecutive throttled pages; ${selected.length - transcribed - throttled - failed} pages were not attempted`,
      });
      break;
    }

    try {
      const pageText = await extractPageText(bytes, physicalPage);
      const nativeText = toLayoutText(buildLayout(pageText));

      const result = await transcribePage(bytes, physicalPage, nativeText, {
        client: options.client,
        storageDir: context.storageDir,
        documentHash,
        ...(options.scale !== undefined ? { scale: options.scale } : {}),
      });

      blocksWritten += await persistTranscription(
        db,
        context.job.documentId,
        result,
        producedBy,
      );
      transcribed += 1;
      consecutive = 0;
    } catch (error) {
      const modelError = error instanceof ModelError ? error : null;
      const isThrottle = modelError?.kind === 'provider_rate_limited';

      if (isThrottle) {
        throttled += 1;
        consecutive += 1;
      } else {
        failed += 1;
        consecutive = 0;
      }

      // Recorded, not thrown. The page's native-text blocks are already stored, so the
      // document stays usable and the run reports honestly that this page was read only
      // from its text layer.
      await recordIssue(db, context.job.runId, {
        stage: 'parsing',
        failureKind: isThrottle ? 'visual_route_throttled' : 'visual_route_failed',
        failureClass: isThrottle ? 'transient' : 'permanent',
        message: `physical page ${physicalPage}: ${(error as Error).message.slice(0, 300)}`,
        physicalPage,
      });
    }
  }

  return {
    pagesConsidered: selected.length,
    pagesTranscribed: transcribed,
    pagesThrottled: throttled,
    pagesFailed: failed,
    blocksWritten,
    stoppedEarly,
  };
}

/**
 * Builds the stage.
 *
 * A factory rather than a constant, because the stage needs the model client and the
 * worker is the only process that may hold one.
 */
export function createVisualStage(options: VisualStageOptions): StageHandler {
  return {
    stage: 'parsing',
    async run(context) {
      await transcribeDocument(context, options);
    },
  };
}
