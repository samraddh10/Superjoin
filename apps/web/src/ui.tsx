/**
 * Small shared pieces: badges, notices, and the two hooks every view loads data with.
 *
 * The vocabulary here is deliberately thin. What the interface has to get right is what
 * it says about a claim's status and a relationship's label, and both are decided by the
 * pipeline; the components' only job is not to editorialise on the way to the screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ClaimStatusContract,
  EvidenceItem,
  RelationshipLabelContract,
} from '@superjoin/contracts';

import { ApiError } from './api.ts';

/**
 * Human wording for the enums.
 *
 * `needs_review` reads as "needs review" rather than "unverified" or "failed", because
 * plan 4.3 makes it a claim awaiting independent evidence, not a rejected one.
 */
export const STATUS_LABEL: Record<ClaimStatusContract, string> = {
  accepted: 'accepted',
  needs_review: 'needs review',
  rejected: 'rejected',
};

export const RELATIONSHIP_LABEL: Record<RelationshipLabelContract, string> = {
  corroborates: 'corroborates',
  contradicts: 'contradicts',
  likely_contradiction: 'likely contradiction',
  reconciled_by_context: 'reconciled by context',
  insufficient_context: 'insufficient context',
  unrelated: 'unrelated',
};

/** One line on what each label asserts, shown as a tooltip so the list needs no legend. */
export const RELATIONSHIP_MEANING: Record<RelationshipLabelContract, string> = {
  corroborates: 'Comparable claims support the same assertion.',
  contradicts: 'Comparable assertions conflict, on strong evidence.',
  likely_contradiction: 'The conflict appears real, but a material context question remains.',
  reconciled_by_context:
    'Supported time, scope, units or other context explains the apparent conflict.',
  insufficient_context: 'The available evidence cannot resolve the comparison.',
  unrelated: 'Similar text, but the claims concern different assertions.',
};

export const VERIFICATION_LABEL: Record<EvidenceItem['verification'], string> = {
  verified_native_text: 'found in the PDF text',
  visual_only: 'from a page image only',
  quote_not_found: 'quote not found in the block',
  block_not_found: 'cited block does not exist',
  unchecked: 'not checked',
};

export const ENTAILMENT_LABEL: Record<EvidenceItem['entailment'], string> = {
  supported: 'supports the claim',
  unsupported: 'does not support the claim',
  unclear: 'support unclear',
  unchecked: 'not checked',
};

export function StatusBadge({ status }: { status: ClaimStatusContract }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function LabelBadge({ label }: { label: RelationshipLabelContract }) {
  return (
    <span className={`badge badge-${label}`} title={RELATIONSHIP_MEANING[label]}>
      {RELATIONSHIP_LABEL[label]}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="muted small">
      <span className="spinner" aria-hidden="true" /> {label ?? 'loading'}
    </span>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError
      ? `${error.message} (${error.code})`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <p className="notice notice-error" role="alert">
      {message}
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

export interface Async<T> {
  readonly data: T | null;
  readonly error: unknown;
  readonly loading: boolean;
  reload(): void;
}

/**
 * Runs a fetch when its key changes and whenever `reload` is called.
 *
 * Results from a superseded request are discarded rather than rendered: a reviewer
 * changing the predicate filter twice in quick succession must not be shown the first
 * answer because it happened to arrive second.
 */
export function useAsync<T>(load: () => Promise<T>, key: string): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  // The load function is rebuilt on every render by every caller, so the effect keys off
  // the caller's explicit key and reads the latest function from a ref instead.
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let live = true;
    setLoading(true);
    latest
      .current()
      .then((value) => {
        if (!live) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

/**
 * Calls `tick` on an interval while `active` is true.
 *
 * Two seconds, which is plan 2.2's suggested starting figure. Polling stops as soon as
 * nothing is in flight, so a finished collection does not keep a request going all day.
 */
export function usePolling(active: boolean, tick: () => void, intervalMs = 2000): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => latest.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}

/** Bytes as a short human figure, for the documents table. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * The value a claim states, as text.
 *
 * Assembled from the stored strings and never parsed into a number: plan 4.1 forbids a
 * financial figure passing through a JavaScript number, and formatting is exactly where
 * that would happen unnoticed.
 */
export function formatValue(claim: {
  rawValue: string | null;
  numericValue: string | null;
  currency: string | null;
  scale: string | null;
  unit: string | null;
}): string {
  if (claim.rawValue !== null && claim.rawValue !== '') return claim.rawValue;
  if (claim.numericValue === null) return '—';
  return [claim.currency, claim.numericValue, claim.scale, claim.unit]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}

/** Physical pages are zero-based internally and shown one-based, labelled as physical. */
export function pageLabel(physicalPage: number, printedPageLabel: string | null): string {
  const physical = `page ${physicalPage + 1}`;
  // The printed label is shown beside the physical page, never instead of it: one starter
  // document prints two labels per sheet, so a label identifies nothing on its own.
  return printedPageLabel === null ? physical : `${physical} (printed ${printedPageLabel})`;
}
