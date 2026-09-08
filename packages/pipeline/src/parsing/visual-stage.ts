/**
 * The visual-transcription stage.
 *
 * Runs after parsing, over the pages parsing marked as structured. A page reaches this
 * stage only because its text layer was judged unusable, which is what decides how a
 * failure here is treated.
 *
 *   - A provider that did not answer fails the run. Carrying on would leave the page
 *     read from a text layer already known to be wrong, and nothing downstream could
 *     tell that page from one the model had actually transcribed. Throttling and
 *     timeouts are raised as transient, so the queue retries them with backoff; a
 *     refused key is permanent and stops at once.
 *   - A page that failed to render still costs only itself. The provider answered — or
 *     was never asked — so the run continues and reports the page as failed.
 *   - A budget caps how many pages are attempted per run. Without one, a hundred-page
 *     document spends hours in backoff and the run looks stalled while working correctly.
 */

import type { Database } from '@superjoin/db';

import { ModelError, type CompletionProvider } from '../model/index.ts';
import { extractPageText } from '../pdf-text.ts';
import { ProcessingError, type ProcessingContext, type StageHandler } from '../processor.ts';
import { heartbeat, recordIssue } from '../run-state.ts';
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
  readonly scale?: number;
}

const DEFAULTS = {
  maxPages: 40,
} as const;

export interface VisualSummary {
  readonly pagesConsidered: number;
  readonly pagesTranscribed: number;
  readonly pagesFailed: number;
  readonly blocksWritten: number;
}

export async function transcribeDocument(
  context: ProcessingContext,
  options: VisualStageOptions,
): Promise<VisualSummary> {
  const { db } = context.database;
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;

  // Resolved before the candidates, because it is part of asking which pages still need
  // reading: a page already transcribed by this model under this prompt does not.
  const producedBy = `${options.client.model}/${TRANSCRIPTION_PROMPT_VERSION}`;

  const candidates = await pagesNeedingTranscription(
    db as Database,
    context.job.documentId,
    producedBy,
  );
  const selected = candidates.slice(0, maxPages);

  if (selected.length === 0) {
    return {
      pagesConsidered: 0,
      pagesTranscribed: 0,
      pagesFailed: 0,
      blocksWritten: 0,
    };
  }

  const bytes = await readObject(context.storageDir, context.storageKey);
  const documentHash = await options.documentHash(context);

  let transcribed = 0;
  let failed = 0;
  let blocksWritten = 0;

  for (const physicalPage of selected) {
    // One model call per page and no counter to report, so the run's heartbeat would
    // otherwise go untouched for the whole visual route and a working document would be
    // reported as stalled. See the same note in the normalization stage.
    await heartbeat(db, context.job.runId);

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
    } catch (error) {
      const modelError = error instanceof ModelError ? error : null;
      const isThrottle = modelError?.kind === 'provider_rate_limited';

      if (modelError === null) failed += 1;

      await recordIssue(db, context.job.runId, {
        stage: 'parsing',
        failureKind: isThrottle ? 'visual_route_throttled' : 'visual_route_failed',
        failureClass: modelError !== null && modelError.retryable ? 'transient' : 'permanent',
        message: `physical page ${physicalPage}: ${(error as Error).message.slice(0, 300)}`,
        physicalPage,
      });

      // A provider that did not answer fails the run. The page's native-text blocks are
      // stored either way, but this stage was reached precisely because that text layer
      // was judged unusable, so continuing would leave the page silently unread. A page
      // that failed to render is a different matter and still costs only itself.
      if (modelError !== null) {
        throw new ProcessingError(
          `transcription call failed on physical page ${physicalPage}: ${modelError.message}`,
          modelError.kind,
          modelError.retryable ? 'transient' : 'permanent',
          'parsing',
          physicalPage,
        );
      }
    }
  }

  return {
    pagesConsidered: selected.length,
    pagesTranscribed: transcribed,
    pagesFailed: failed,
    blocksWritten,
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
