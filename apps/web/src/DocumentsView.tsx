/**
 * The documents view: upload, status, pages processed, accepted facts and errors.
 *
 * Plan 7.2 names those five together, and they are shown in one table because a reviewer
 * judging whether a run went well needs them side by side. A document with three pages
 * processed and zero accepted facts is a different situation from one with three pages
 * processed and forty, and neither figure says so alone.
 *
 * Polling is on only while something is actually running (plan 2.2's two-second figure).
 * A finished collection stops making requests.
 */

import { useCallback, useRef, useState } from 'react';

import type { DocumentSummary, UploadResult } from '@superjoin/contracts';

import { listDocuments, retryRun, uploadDocuments } from './api.ts';
import { Empty, ErrorNotice, Spinner, formatBytes, useAsync, usePolling } from './ui.tsx';

function StageBadge({ run }: { run: NonNullable<DocumentSummary['latestRun']> }) {
  // Stalled is reported ahead of the stage, because "extracting" on a run nothing has
  // touched for five minutes is misleading on its own. Plan 2.3 requires interrupted work
  // to be visible rather than silently stuck.
  if (run.stalled) {
    return (
      <span className="badge badge-needs_review" title="Not terminal, but nothing has touched it recently.">
        stalled in {run.stage}
      </span>
    );
  }
  const className =
    run.stage === 'failed'
      ? 'badge-rejected'
      : run.stage === 'completed'
        ? 'badge-accepted'
        : run.stage === 'completed_with_issues'
          ? 'badge-needs_review'
          : 'badge-neutral';
  return <span className={`badge ${className}`}>{run.stage.replace(/_/g, ' ')}</span>;
}

function Progress({ run }: { run: NonNullable<DocumentSummary['latestRun']> }) {
  const total = run.pagesTotal;
  if (total === null || total === 0) return <span className="muted small">—</span>;
  const done = Math.min(run.pagesProcessed, total);
  return (
    <div className="stack" style={{ gap: 4, minWidth: 120 }}>
      <div className="progress" role="presentation">
        <div style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <span className="small muted num">
        {done} / {total} pages
      </span>
    </div>
  );
}

function UploadResultLine({ result }: { result: UploadResult }) {
  if (result.status === 'accepted') {
    return (
      <li>
        <strong>{result.filename}</strong> accepted, {result.pageCount} pages — queued
      </li>
    );
  }
  if (result.status === 'duplicate') {
    return (
      <li>
        <strong>{result.filename}</strong> is the same file as{' '}
        <em>{result.existingFilename}</em>, already in this collection. Not reprocessed.
      </li>
    );
  }
  return (
    <li>
      <strong>{result.filename}</strong> rejected ({result.reason}): {result.message}
    </li>
  );
}

export interface DocumentsViewProps {
  readonly collectionId: string;
  /** Told to the shell so the facts and relationships tabs can refresh when a run lands. */
  onProcessingSettled(): void;
}

export function DocumentsView({ collectionId, onProcessingSettled }: DocumentsViewProps) {
  const documents = useAsync(() => listDocuments(collectionId), `documents:${collectionId}`);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const items = documents.data?.items ?? [];
  const running = items.some((item) => item.latestRun !== null && !item.latestRun.terminal);

  // Latched so the transition from running to finished fires the callback exactly once,
  // rather than on every poll after it.
  const wasRunning = useRef(false);
  const onSettled = useRef(onProcessingSettled);
  onSettled.current = onProcessingSettled;
  if (wasRunning.current && !running) {
    wasRunning.current = false;
    queueMicrotask(() => onSettled.current());
  } else if (running) {
    wasRunning.current = true;
  }

  usePolling(running, documents.reload);

  const upload = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      setUploadError(null);
      setResults(null);
      try {
        const response = await uploadDocuments(collectionId, files);
        setResults(response.results);
        documents.reload();
      } catch (error) {
        setUploadError(error);
      } finally {
        setUploading(false);
      }
    },
    [collectionId, documents],
  );

  return (
    <div className="column">
      <section className="card">
        <div className="card-head">
          <strong>Add documents</strong>
          <span className="muted small">PDFs are processed in the background</span>
        </div>
        <div className="card-body stack">
          <div
            className={dragOver ? 'dropzone over' : 'dropzone'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              void upload([...event.dataTransfer.files]);
            }}
          >
            <p style={{ margin: '0 0 8px' }}>Drop PDFs here, or</p>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              onChange={(event) => {
                void upload([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Choose files'}
            </button>
          </div>

          {uploadError !== null ? <ErrorNotice error={uploadError} /> : null}

          {results !== null ? (
            // Reported per file, because one request can legitimately produce an
            // acceptance, a duplicate and a rejection at once.
            <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {results.map((result, position) => (
                <UploadResultLine key={`${result.filename}-${position}`} result={result} />
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <strong>Documents</strong>
          <span className="muted small">{items.length}</span>
          {running ? <Spinner label="processing" /> : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={documents.reload}>
            Refresh
          </button>
        </div>

        {documents.error !== null ? (
          <div className="card-body">
            <ErrorNotice error={documents.error} />
          </div>
        ) : items.length === 0 ? (
          <Empty>
            {documents.loading ? 'Loading…' : 'No documents yet. Upload a PDF to begin.'}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Stage</th>
                <th>Pages</th>
                <th className="num">Facts</th>
                <th className="num">Relations</th>
                <th>Issues</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((document) => {
                const run = document.latestRun;
                return (
                  <tr key={document.id}>
                    <td>
                      <div>{document.filename}</div>
                      <div className="small muted num">
                        {formatBytes(document.byteSize)}
                        {document.pageCount !== null ? ` · ${document.pageCount} pages` : ''}
                      </div>
                    </td>
                    <td>
                      {run === null ? (
                        <span className="muted small">never queued</span>
                      ) : (
                        <StageBadge run={run} />
                      )}
                    </td>
                    <td>{run === null ? <span className="muted">—</span> : <Progress run={run} />}</td>
                    <td className="num">
                      {run === null ? (
                        '—'
                      ) : (
                        <>
                          <strong>{run.claimsAccepted}</strong>
                          <span className="muted"> / {run.claimsExtracted}</span>
                        </>
                      )}
                    </td>
                    <td className="num">{run === null ? '—' : run.relationshipsCreated}</td>
                    <td>
                      {run === null || run.issues.length === 0 ? (
                        <span className="muted small">none</span>
                      ) : (
                        <span
                          className="badge badge-needs_review"
                          title={run.issues.map((issue) => issue.message).join('\n')}
                        >
                          {run.issues.length}
                        </span>
                      )}
                      {run?.errorSummary != null ? (
                        <div className="small muted">{run.errorSummary}</div>
                      ) : null}
                    </td>
                    <td>
                      {/* Offered only when it applies: the API refuses a retry on a run
                          that is still progressing, and a button that 409s is noise. */}
                      {run !== null && (run.terminal || run.stalled) ? (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            void retryRun(run.id).then(documents.reload);
                          }}
                        >
                          Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
