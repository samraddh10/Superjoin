/**
 * The issues view.
 *
 * Plan 7.3 requires the interface to show the observed failure and how it was handled,
 * and acceptance depends on a real one being demonstrable. That makes this view part of
 * the deliverable rather than an operator's convenience, which is why issues are grouped
 * by failure kind: the question a reviewer is really asking is what kinds of thing go
 * wrong, not which page number happened to go wrong first.
 *
 * Resolved and abandoned issues stay listed. An issue the system recovered from is the
 * evidence that recovery works, and an abandoned one is the evidence of the limit; a view
 * that showed only what is currently broken would erase both.
 */

import type { DocumentSummary, ProcessingIssueResponse } from '@superjoin/contracts';

import { listDocuments } from './api.ts';
import { Empty, ErrorNotice, Spinner, useAsync } from './ui.tsx';

interface Row {
  readonly issue: ProcessingIssueResponse;
  readonly filename: string;
}

const RESOLUTION_CLASS: Record<ProcessingIssueResponse['resolution'], string> = {
  open: 'badge-rejected',
  retrying: 'badge-needs_review',
  resolved: 'badge-accepted',
  abandoned: 'badge-neutral',
};

const RESOLUTION_MEANING: Record<ProcessingIssueResponse['resolution'], string> = {
  open: 'Recorded and not yet dealt with.',
  retrying: 'Being retried; the pipeline expects this one to be transient.',
  resolved: 'A later attempt succeeded.',
  abandoned: 'The system could not recover from this. It is kept as the record of a real limit.',
};

function collectRows(items: readonly DocumentSummary[]): Row[] {
  return items.flatMap((document) =>
    (document.latestRun?.issues ?? []).map((issue) => ({ issue, filename: document.filename })),
  );
}

export function IssuesView({ collectionId }: { collectionId: string }) {
  const documents = useAsync(() => listDocuments(collectionId), `issues:${collectionId}`);
  const rows = collectRows(documents.data?.items ?? []);

  const byKind = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byKind.get(row.issue.failureKind) ?? [];
    list.push(row);
    byKind.set(row.issue.failureKind, list);
  }

  return (
    <div className="column">
      <section className="card">
        <div className="card-head">
          <strong>Processing issues</strong>
          <span className="muted small">{rows.length}</span>
          {documents.loading ? <Spinner /> : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={documents.reload}>
            Refresh
          </button>
        </div>
        <div className="card-body small muted">
          Everything the pipeline recorded as having gone wrong, including issues it
          recovered from. A page that failed to parse, a chunk the model returned an
          unusable answer for, or a provider rate limit all land here with what happened
          next.
        </div>
      </section>

      {documents.error !== null ? <ErrorNotice error={documents.error} /> : null}

      {rows.length === 0 ? (
        <section className="card">
          <Empty>
            {documents.loading
              ? 'Loading…'
              : 'No issues recorded for this collection. That is not the same as none being possible: process a difficult document to see how failures are handled.'}
          </Empty>
        </section>
      ) : (
        [...byKind.entries()].map(([kind, group]) => (
          <section className="card" key={kind}>
            <div className="card-head">
              <strong className="mono">{kind}</strong>
              <span className="muted small">
                {group.length} occurrence{group.length === 1 ? '' : 's'}
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Stage</th>
                  <th>Page</th>
                  <th>What happened</th>
                  <th className="num">Attempts</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {group.map(({ issue, filename }) => (
                  <tr key={issue.id}>
                    <td className="small">{filename}</td>
                    <td className="small">{issue.stage}</td>
                    <td className="num small">
                      {issue.physicalPage === null ? '—' : issue.physicalPage + 1}
                    </td>
                    <td className="wrap-cell small">
                      {issue.message}
                      {issue.isTransient !== null ? (
                        <div className="muted">
                          {/* Plan 2.3: a transient provider failure and an invalid PDF are
                              different problems and no number of retries fixes the second. */}
                          {issue.isTransient
                            ? 'classified as transient — a retry could succeed'
                            : 'classified as permanent — retrying would not help'}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{issue.attemptCount}</td>
                    <td>
                      <span
                        className={`badge ${RESOLUTION_CLASS[issue.resolution]}`}
                        title={RESOLUTION_MEANING[issue.resolution]}
                      >
                        {issue.resolution}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}
