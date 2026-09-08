/**
 * The visual route: reading a difficult page with the multimodal model.
 *
 * Plan section 3.1 sends table-heavy, scanned or garbled pages to the model as an image
 * together with their native text, and asks for structured rows and cells with headings,
 * units and footnotes. What comes back is stored as `model_transcription`, never as
 * source text, because plan 4.3 is explicit that a transcription cannot independently
 * verify a claim extracted by the same model. The page image is kept as evidence so a
 * reviewer can see what the model was shown.
 *
 * The design constraint that shaped this file is availability rather than capability.
 * Measured on the free tier, the shared upstream pool returns 429 for a large share of
 * requests, so throttling is an ordinary event here. A page that cannot be transcribed
 * must therefore leave the document usable: the native-text blocks for that page are
 * already stored, the failure is recorded against the run, and the run finishes
 * `completed_with_issues` rather than failing outright. The alternative — treating a
 * throttled page as a document-level failure — would make the whole pipeline as reliable
 * as the least reliable minute of a free API.
 */

import { z } from 'zod';

import type { Database } from '@superjoin/db';
import { sourceBlocks } from '@superjoin/db';
import { and, eq, inArray } from 'drizzle-orm';

import {
  ModelError,
  extractJson,
  imageContentPart,
  type CompletionProvider,
} from '../model/index.ts';
import { pageImageStorageKey, writeObject } from '../storage.ts';
import { renderPage } from './render.ts';

/** Bumped when the prompt or schema changes what the model returns. */
export const TRANSCRIPTION_PROMPT_VERSION = 'table-transcribe@1';

const cellSchema = z.object({
  text: z.string(),
  rowHeader: z.string().nullable(),
  columnHeader: z.string().nullable(),
  unit: z.string().nullable(),
  footnote: z.string().nullable(),
});

const transcriptionSchema = z.object({
  tables: z.array(
    z.object({
      title: z.string().nullable(),
      unitNote: z.string().nullable(),
      rows: z.array(z.array(cellSchema)),
    }),
  ),
});

export type Transcription = z.infer<typeof transcriptionSchema>;

/** The JSON Schema sent as `response_format`. Mirrors the Zod shape above. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    tables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          unitNote: { type: ['string', 'null'] },
          rows: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  rowHeader: { type: ['string', 'null'] },
                  columnHeader: { type: ['string', 'null'] },
                  unit: { type: ['string', 'null'] },
                  footnote: { type: ['string', 'null'] },
                },
                required: ['text', 'rowHeader', 'columnHeader', 'unit', 'footnote'],
                additionalProperties: false,
              },
            },
          },
        },
        required: ['title', 'unitNote', 'rows'],
        additionalProperties: false,
      },
    },
  },
  required: ['tables'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  'You transcribe tables and charts from a page of a financial document.',
  'Report only what is visible on the page. Never infer, complete or correct a value.',
  'Bind every value to the row and column heading it sits under, and carry the unit',
  'stated for that table or column. If a value has a footnote marker, record the marker.',
  'If a cell is unreadable, give its text as an empty string rather than guessing.',
].join(' ');

export interface TranscribeOptions {
  readonly client: CompletionProvider;
  readonly storageDir: string;
  readonly documentHash: string;
  /** Render scale. Small type in financial tables needs more than the native size. */
  readonly scale?: number;
  readonly maxTokens?: number;
}

export interface TranscriptionResult {
  readonly physicalPage: number;
  readonly transcription: Transcription;
  /** Where the rendered page was stored, kept as evidence per plan 3.1. */
  readonly pageImageKey: string;
  readonly servedByModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Transcribes one page.
 *
 * The native text is supplied alongside the image deliberately. The model reads a table's
 * structure from the picture, but the digits are more reliably had from the text layer,
 * and giving it both lets it agree with the document rather than re-read every figure
 * from pixels.
 */
export async function transcribePage(
  bytes: Uint8Array,
  physicalPage: number,
  nativeText: string,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  const rendered = await renderPage(bytes, physicalPage, { scale: options.scale ?? 2 });

  // Stored before the call, so the evidence exists even if the model never answers.
  const pageImageKey = pageImageStorageKey(options.documentHash, physicalPage);
  await writeObject(options.storageDir, pageImageKey, rendered.bytes);

  const result = await options.client.complete({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `This is physical page ${physicalPage} of a financial document.`,
              'Transcribe every table or chart on it.',
              '',
              'The text layer extracted from this page, for the exact digits:',
              nativeText.slice(0, 8000),
            ].join('\n'),
          },
          imageContentPart(rendered.bytes, rendered.mimeType),
        ],
      },
    ],
    schema: { name: 'page_transcription', schema: RESPONSE_SCHEMA },
    maxTokens: options.maxTokens ?? 8000,
  });

  // Parsed with Zod after the fact, never trusted because response_format was sent. A
  // free endpoint may ignore the schema under load, and plan 4.1 requires the reply to be
  // validated before it is accepted.
  const parsed = transcriptionSchema.safeParse(extractJson(result.text));
  if (!parsed.success) {
    throw new ModelError(
      `transcription did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      'schema_violation',
      // Worth one more attempt: the model often complies on a retry.
      true,
    );
  }

  return {
    physicalPage,
    transcription: parsed.data,
    pageImageKey,
    servedByModel: result.servedByModel,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

/** Flattens a transcription into the text stored on a block. */
export function renderTranscription(transcription: Transcription): string {
  return transcription.tables
    .map((table) => {
      const header = [table.title, table.unitNote].filter((part) => part !== null).join(' — ');
      const rows = table.rows
        .map((row) => row.map((cell) => cell.text).join(' | '))
        .join('\n');
      return header !== '' ? `${header}\n${rows}` : rows;
    })
    .join('\n\n');
}

/**
 * Writes a transcription as source blocks.
 *
 * `model_transcription` rather than `native_text`, which is what keeps a model's reading
 * distinguishable from the document's own text. A claim supported only by these blocks
 * cannot be accepted on that evidence alone.
 */
export async function persistTranscription(
  db: Database,
  documentId: string,
  result: TranscriptionResult,
  producedBy: string,
): Promise<number> {
  const existing = await db
    .select({ id: sourceBlocks.id })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, documentId),
        eq(sourceBlocks.physicalPage, result.physicalPage),
        eq(sourceBlocks.producedBy, producedBy),
      ),
    )
    .limit(1);

  if (existing.length > 0) return 0;

  const rows = result.transcription.tables.map((table, index) => ({
    documentId,
    physicalPage: result.physicalPage,
    printedPageLabel: null,
    blockType: 'table' as const,
    extractionMethod: 'model_transcription' as const,
    // Offset so a transcription block can never collide with a native-text block index
    // on the same page under a different parser version.
    blockIndex: 10_000 + index,
    content: renderTranscription({ tables: [table] }),
    tableHeaders: table.rows[0]?.map((cell) => cell.columnHeader) ?? null,
    pageImageKey: result.pageImageKey,
    coordinateOrigin: 'bottom-left',
    pageRotation: 0,
    producedBy,
  }));

  if (rows.length === 0) return 0;

  await db.insert(sourceBlocks).values(rows).onConflictDoNothing();
  return rows.length;
}

/** Pages that already carry a native-text table block, which are the ones worth re-reading. */
export async function pagesNeedingTranscription(
  db: Database,
  documentId: string,
  producedBy?: string,
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ physicalPage: sourceBlocks.physicalPage })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, documentId),
        inArray(sourceBlocks.blockType, ['table', 'chart']),
        eq(sourceBlocks.extractionMethod, 'native_text'),
      ),
    )
    .orderBy(sourceBlocks.physicalPage);

  const candidates = rows.map((row) => row.physicalPage);
  if (producedBy === undefined) return candidates;

  /**
   * Pages this model has already transcribed under this prompt.
   *
   * The native table blocks stay on the page after a transcription — `verifyClaim` needs
   * them as the independent witness — so their presence cannot mean the page is still
   * owed a reading. Without this a retry re-transcribed every page it had already done,
   * which on a rate-limited tier is not merely wasteful: the run spends its whole quota
   * redoing settled pages and fails again at the same place, one page further on at best.
   *
   * Keyed on `producedBy`, which carries the model and the prompt version, so a changed
   * model or prompt reads the page again rather than inheriting an older reading.
   */
  const done = await db
    .selectDistinct({ physicalPage: sourceBlocks.physicalPage })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, documentId),
        eq(sourceBlocks.extractionMethod, 'model_transcription'),
        eq(sourceBlocks.producedBy, producedBy),
      ),
    );

  const transcribed = new Set(done.map((row) => row.physicalPage));
  return candidates.filter((page) => !transcribed.has(page));
}
