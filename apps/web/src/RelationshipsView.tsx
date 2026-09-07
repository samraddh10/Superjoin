/**
 * The relationships view: two claims side by side, what differs between them, and why the
 * system labelled the pair as it did.
 *
 * This is the view the assignment is really about, so it is built to plan 6.4's
 * constraints rather than to what would look most decisive. Both claims are shown whole
 * and neither is presented as the correct one. No confidence number appears, because none
 * is stored and any number here would be read as a calibrated probability. The
 * deterministic checks are shown as what the classifier was given, not as proof of the
 * answer it gave.
 *
 * Abstention is displayed as an ordinary outcome. `insufficient_context` sits in the same
 * list, in the same shape, as `contradicts`; a system that can only be seen when it is
 * confident cannot be judged on plan 8.1's abstention rate.
 */

import { useState } from 'react';

import type {
  FactDetail,
  RelationshipLabelContract,
  RelationshipSummary,
} from '@superjoin/contracts';

import { listRelationships } from './api.ts';
import { EvidenceDrawer } from './EvidenceDrawer.tsx';
import {
  Empty,
  ErrorNotice,
  LabelBadge,
  RELATIONSHIP_LABEL,
  RELATIONSHIP_MEANING,
  Spinner,
  StatusBadge,
  formatValue,
  pageLabel,
  useAsync,
} from './ui.tsx';

const PAGE_SIZE = 25;

const LABEL_ORDER: RelationshipLabelContract[] = [
  'contradicts',
  'likely_contradiction',
  'reconciled_by_context',
  'corroborates',
  'insufficient_context',
  'unrelated',
];

export interface RelationshipsViewProps {
  readonly collectionId: string;
  /** Set when arriving from a claim, to show only that claim's comparisons. */
  readonly focusClaimId?: string | undefined;
  onClearFocus(): void;
}

/** One side of the pair. Identical for both, so neither reads as the authoritative one. */
function ClaimSide({
  claim,
  onInspect,
}: {
  claim: FactDetail;
  onInspect(claim: FactDetail): void;
}) {
  return (
    <article>
      <div className="row small muted">
        <span>{claim.filename}</span>
        <span>·</span>
        <span>
          {claim.evidence.length === 0
            ? 'no evidence'
            : pageLabel(
                claim.evidence[0]!.block.physicalPage,
                claim.evidence[0]!.block.printedPageLabel,
              )}
        </span>
      </div>

      <div className="value">{formatValue(claim)}</div>

      <div className="small">
        <span className="mono">{claim.predicate}</span>
        <span className="muted">
          {' '}
          · {claim.entityLabel ?? claim.subject}
        </span>
      </div>

      <div className="small muted">
        {[claim.periodLabel, claim.scope, claim.assertionStatus]
          .filter((part): part is string => part !== null && part !== '')
          .join(' · ') || 'no context recorded'}
      </div>

      <blockquote className="quote small">{claim.originalStatement}</blockquote>

      <div className="row">
        <StatusBadge status={claim.status} />
        <button
          type="button"
          className="btn-link small"
          disabled={claim.evidence.length === 0}
          onClick={() => onInspect(claim)}
        >
          inspect evidence
        </button>
      </div>
    </article>
  );
}

function RelationshipCard({
  relationship,
  onInspect,
}: {
  relationship: RelationshipSummary;
  onInspect(claim: FactDetail): void;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <LabelBadge label={relationship.label} />
        <span className="muted small">{RELATIONSHIP_MEANING[relationship.label]}</span>
        <span className="spacer" />
        <span className="muted small mono">
          {relationship.method} · {relationship.methodVersion}
        </span>
      </div>

      <div className="pair">
        <ClaimSide claim={relationship.claimA} onInspect={onInspect} />
        <ClaimSide claim={relationship.claimB} onInspect={onInspect} />
      </div>

      <div className="card-body stack">
        <div>
          <p className="section-title">Why</p>
          <p style={{ margin: 0 }}>{relationship.rationale}</p>
        </div>

        {relationship.contextDifferences.length > 0 ? (
          <div>
            <p className="section-title">What differs</p>
            <div className="diffs">
              {relationship.contextDifferences.map((difference, position) => (
                <div className="diff" key={`${difference.dimension}-${position}`}>
                  <span className="diff-dim">{difference.dimension.replace(/_/g, ' ')}</span>
                  <span className="mono">{difference.a ?? '—'}</span>
                  <span className="muted">vs</span>
                  <span className="mono">{difference.b ?? '—'}</span>
                  {difference.couldExplainGap ? (
                    <span
                      className="badge badge-neutral"
                      title="This difference could account for a numerical gap. It is an input to the label, not the label itself."
                    >
                      could explain a gap
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {relationship.uncertaintyReasons.length > 0 ? (
          <div>
            {/* Plan 6.3 makes abstention a correct answer, so the reason for abstaining is
                data the reviewer gets to see rather than an absence. */}
            <p className="section-title">What is still open</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {relationship.uncertaintyReasons.map((reason, position) => (
                <li key={position}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <details>
          <summary className="small muted">How this was decided</summary>
          <dl className="pairs" style={{ marginTop: 8 }}>
            <dt>Method</dt>
            <dd className="mono">{relationship.method}</dd>
            <dt>Method version</dt>
            <dd className="mono">{relationship.methodVersion}</dd>
            {relationship.modelName !== null ? (
              <>
                <dt>Model</dt>
                <dd className="mono">{relationship.modelName}</dd>
              </>
            ) : null}
            {relationship.promptVersion !== null ? (
              <>
                <dt>Prompt version</dt>
                <dd className="mono">{relationship.promptVersion}</dd>
              </>
            ) : null}
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            No confidence score is recorded. The label is a judgement with a stated
            rationale, and a number here would be read as a calibrated probability.
          </p>
        </details>
      </div>
    </section>
  );
}

export function RelationshipsView({
  collectionId,
  focusClaimId,
  onClearFocus,
}: RelationshipsViewProps) {
  const [label, setLabel] = useState<RelationshipLabelContract | ''>('');
  const [offset, setOffset] = useState(0);
  const [inspecting, setInspecting] = useState<FactDetail | null>(null);

  const relationships = useAsync(
    () =>
      listRelationships(collectionId, {
        label: label === '' ? undefined : label,
        claimId: focusClaimId,
        limit: PAGE_SIZE,
        offset,
      }),
    `relationships:${collectionId}:${label}:${focusClaimId ?? ''}:${offset}`,
  );

  const items = relationships.data?.items ?? [];
  const counts: Partial<Record<RelationshipLabelContract, number>> =
    relationships.data?.counts ?? {};
  const total = relationships.data?.total ?? 0;

  return (
    <div className="column">
      {focusClaimId !== undefined ? (
        <div className="notice row">
          <span>Showing only the comparisons involving one claim.</span>
          <button type="button" className="btn-link" onClick={onClearFocus}>
            show all relationships
          </button>
        </div>
      ) : null}

      <section className="card">
        <div className="card-body row">
          <div className="chips">
            <button
              type="button"
              className="chip"
              aria-pressed={label === ''}
              onClick={() => {
                setLabel('');
                setOffset(0);
              }}
            >
              all
            </button>
            {LABEL_ORDER.map((name) => (
              <button
                key={name}
                type="button"
                className="chip"
                aria-pressed={label === name}
                title={RELATIONSHIP_MEANING[name]}
                onClick={() => {
                  setLabel(name);
                  setOffset(0);
                }}
              >
                {RELATIONSHIP_LABEL[name]}
                {/* Counted across the collection rather than the filtered set, so the
                    chips still say what else is there once one is chosen. */}
                <span className="tab-count num">{counts[name] ?? 0}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          {relationships.loading ? <Spinner /> : null}
        </div>
      </section>

      {relationships.error !== null ? <ErrorNotice error={relationships.error} /> : null}

      {items.length === 0 ? (
        <section className="card">
          <Empty>
            {relationships.loading
              ? 'Loading…'
              : label === ''
                ? 'No relationships yet. They are created once two documents have been processed.'
                : `No ${RELATIONSHIP_LABEL[label]} relationships in this collection.`}
          </Empty>
        </section>
      ) : (
        items.map((relationship) => (
          <RelationshipCard
            key={relationship.id}
            relationship={relationship}
            onInspect={setInspecting}
          />
        ))
      )}

      {total > PAGE_SIZE ? (
        <div className="row">
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

      {inspecting !== null ? (
        <EvidenceDrawer
          title={`${inspecting.subject} · ${inspecting.predicate}`}
          claimStatement={inspecting.originalStatement}
          evidence={inspecting.evidence}
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </div>
  );
}
