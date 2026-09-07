/**
 * The facts view: every claim in the collection, filtered, with its evidence one click
 * away.
 *
 * Plan 7.2 asks for filters on document, entity, predicate and review status, and for
 * clicking through to the evidence. The filters are exactly those; the click opens the
 * drawer that shows the cited passage and the original page.
 *
 * Claims of every status are listed, including rejected ones. Plan 4.3 treats
 * needs_review as a real outcome and Phase 8.1 has to report abstention honestly, so a
 * view that quietly showed only accepted claims would misrepresent both.
 */

import { useMemo, useState } from 'react';

import type { FactDetail, FactSummary } from '@superjoin/contracts';

import { getFact, listFacts } from './api.ts';
import { EvidenceDrawer } from './EvidenceDrawer.tsx';
import {
  Empty,
  ErrorNotice,
  Spinner,
  StatusBadge,
  formatValue,
  pageLabel,
  useAsync,
} from './ui.tsx';

const PAGE_SIZE = 50;

export interface FactsViewProps {
  readonly collectionId: string;
  /** Set when arriving from the relationships view, so one claim can be shown alone. */
  readonly focusFactId?: string | undefined;
  onShowRelationships(claimId: string): void;
}

function ContextLine({ fact }: { fact: FactSummary }) {
  const parts = [fact.periodLabel, fact.scope, fact.assertionStatus].filter(
    (part): part is string => part !== null && part !== '',
  );
  if (parts.length === 0) {
    return <span className="muted small">no context recorded</span>;
  }
  return <span className="small muted">{parts.join(' · ')}</span>;
}

export function FactsView({ collectionId, focusFactId, onShowRelationships }: FactsViewProps) {
  const [documentId, setDocumentId] = useState('');
  const [predicate, setPredicate] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(focusFactId ?? null);
  const [showEvidenceFor, setShowEvidenceFor] = useState<FactDetail | null>(null);

  const key = `facts:${collectionId}:${documentId}:${predicate}:${status}:${offset}`;
  const facts = useAsync(
    () =>
      listFacts(collectionId, {
        documentId: documentId === '' ? undefined : documentId,
        predicate: predicate === '' ? undefined : predicate,
        status: status === '' ? undefined : status,
        limit: PAGE_SIZE,
        offset,
      }),
    key,
  );

  const detail = useAsync(
    () => (selected === null ? Promise.resolve(null) : getFact(selected)),
    `fact:${selected ?? 'none'}`,
  );

  const items = facts.data?.items ?? [];
  const total = facts.data?.total ?? 0;

  // Built from the rows on screen: the API returns the filename with each claim, so the
  // document filter needs no extra request.
  const documentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) seen.set(item.documentId, item.filename);
    return [...seen.entries()];
  }, [items]);

  function changeFilter(apply: () => void) {
    apply();
    setOffset(0);
    setSelected(null);
  }

  return (
    <div className="column">
      <section className="card">
        <div className="card-body filters">
          <label className="field">
            <span>Document</span>
            <select
              value={documentId}
              onChange={(event) => changeFilter(() => setDocumentId(event.target.value))}
            >
              <option value="">all documents</option>
              {documentOptions.map(([id, filename]) => (
                <option key={id} value={id}>
                  {filename}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Predicate</span>
            <select
              value={predicate}
              onChange={(event) => changeFilter(() => setPredicate(event.target.value))}
            >
              <option value="">all predicates</option>
              {(facts.data?.predicates ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Review status</span>
            <select
              value={status}
              onChange={(event) => changeFilter(() => setStatus(event.target.value))}
            >
              <option value="">any status</option>
              <option value="accepted">accepted</option>
              <option value="needs_review">needs review</option>
              <option value="rejected">rejected</option>
            </select>
          </label>

          <span className="spacer" />
          <span className="muted small num">
            {total} claim{total === 1 ? '' : 's'}
            {facts.loading ? ' · ' : ''}
          </span>
          {facts.loading ? <Spinner /> : null}
        </div>
      </section>

      {facts.error !== null ? <ErrorNotice error={facts.error} /> : null}

      <section className="card">
        {items.length === 0 ? (
          <Empty>
            {facts.loading
              ? 'Loading…'
              : 'No claims match these filters. Upload a document, or widen the filters.'}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Predicate</th>
                <th>Value</th>
                <th>Context</th>
                <th>Status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {items.map((fact) => (
                <tr
                  key={fact.id}
                  className="selectable"
                  aria-selected={fact.id === selected}
                  onClick={() => setSelected(fact.id === selected ? null : fact.id)}
                >
                  <td>
                    <div>{fact.entityLabel ?? fact.subject}</div>
                    {fact.entityLabel !== null && fact.entityLabel !== fact.subject ? (
                      // The document's own wording is kept beside the resolved entity, so
                      // a merge the reviewer disagrees with is visible rather than hidden.
                      <div className="small muted">as written: {fact.subject}</div>
                    ) : null}
                  </td>
                  <td className="mono">{fact.predicate}</td>
                  <td className="value-cell">{formatValue(fact)}</td>
                  <td>
                    <ContextLine fact={fact} />
                  </td>
                  <td>
                    <StatusBadge status={fact.status} />
                  </td>
                  <td className="small muted">
                    {fact.filename}
                    {fact.pages.length > 0 ? (
                      <div>{fact.pages.map((page) => `p${page + 1}`).join(', ')}</div>
                    ) : (
                      <div>no evidence</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {total > PAGE_SIZE ? (
          <div className="card-head" style={{ borderTop: '1px solid var(--line-soft)', borderBottom: 0 }}>
            <button
              type="button"
              className="btn"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <span className="muted small num">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button
              type="button"
              className="btn"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        ) : null}
      </section>

      {selected !== null ? (
        <section className="card">
          <div className="card-head">
            <strong>Claim detail</strong>
            {detail.loading ? <Spinner /> : null}
            <span className="spacer" />
            <button type="button" className="btn-link small" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>

          {detail.error !== null ? (
            <div className="card-body">
              <ErrorNotice error={detail.error} />
            </div>
          ) : detail.data === null ? (
            <div className="card-body">
              <Spinner />
            </div>
          ) : (
            <div className="card-body stack">
              <div>
                <p className="section-title">What the document says</p>
                <blockquote className="quote">{detail.data.originalStatement}</blockquote>
              </div>

              <dl className="pairs">
                <dt>Subject</dt>
                <dd>{detail.data.subject}</dd>
                <dt>Predicate</dt>
                <dd className="mono">{detail.data.predicate}</dd>
                <dt>Value as written</dt>
                <dd className="num">{formatValue(detail.data)}</dd>
                {detail.data.normalizedValue !== null ? (
                  <>
                    <dt>Normalized</dt>
                    <dd className="num">
                      {detail.data.normalizedValue} {detail.data.normalizedUnit ?? ''}
                    </dd>
                  </>
                ) : null}
                {detail.data.periodLabel !== null ? (
                  <>
                    <dt>Period</dt>
                    <dd>
                      {detail.data.periodLabel}
                      {detail.data.periodType !== null ? ` (${detail.data.periodType})` : ''}
                    </dd>
                  </>
                ) : null}
                {detail.data.scope !== null ? (
                  <>
                    <dt>Scope</dt>
                    <dd>{detail.data.scope}</dd>
                  </>
                ) : null}
                {detail.data.assertionStatus !== null ? (
                  <>
                    <dt>Asserted as</dt>
                    <dd>{detail.data.assertionStatus}</dd>
                  </>
                ) : null}
                {detail.data.qualifiers.map((qualifier) => (
                  <div key={qualifier.name} style={{ display: 'contents' }}>
                    <dt>{qualifier.name}</dt>
                    <dd>{qualifier.value}</dd>
                  </div>
                ))}
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={detail.data.status} />
                  {detail.data.statusReason !== null ? (
                    <span className="small muted"> — {detail.data.statusReason}</span>
                  ) : null}
                </dd>
              </dl>

              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={detail.data.evidence.length === 0}
                  onClick={() => setShowEvidenceFor(detail.data)}
                >
                  {detail.data.evidence.length === 0
                    ? 'No evidence to inspect'
                    : `Inspect evidence (${detail.data.evidence.length})`}
                </button>
                {detail.data.relationshipCount > 0 ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onShowRelationships(detail.data!.id)}
                  >
                    {detail.data.relationshipCount} relationship
                    {detail.data.relationshipCount === 1 ? '' : 's'}
                  </button>
                ) : (
                  <span className="muted small">no relationships</span>
                )}
                <span className="muted small">
                  {detail.data.evidence
                    .map((item) => pageLabel(item.block.physicalPage, item.block.printedPageLabel))
                    .join(', ')}
                </span>
              </div>

              {detail.data.normalization !== null ? (
                <details>
                  <summary className="small muted">
                    How the normalized value was reached
                  </summary>
                  {/* The audit trail plan 6.4 requires: an agreement should be traceable
                      to a stated conversion rather than to a wide tolerance. */}
                  <pre className="mono quote" style={{ marginTop: 8, overflowX: 'auto' }}>
                    {JSON.stringify(detail.data.normalization, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {showEvidenceFor !== null ? (
        <EvidenceDrawer
          title={`${showEvidenceFor.subject} · ${showEvidenceFor.predicate}`}
          claimStatement={showEvidenceFor.originalStatement}
          evidence={showEvidenceFor.evidence}
          onClose={() => setShowEvidenceFor(null)}
        />
      ) : null}
    </div>
  );
}
