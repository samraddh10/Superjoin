/**
 * The evidence drawer: the cited passage, and the original page it came from.
 *
 * Plan 7.3 sets the bar. Navigating to the correct physical page is core; region
 * highlighting is optional. So the page is rendered from the original PDF with PDF.js and
 * the quoted passage is displayed separately, above it, rather than being searched for in
 * the rendering. When a bounding box was stored the region is outlined as well, but
 * nothing depends on that box existing.
 *
 * The passage shown is the stored quote, not a re-extraction. Verification already decided
 * whether that text is in the document, and re-deriving it here would quietly replace an
 * audited answer with an unaudited one.
 */

import { useEffect, useRef, useState } from 'react';

import type { EvidenceItem } from '@superjoin/contracts';

import { documentFileUrl } from './api.ts';
import { ENTAILMENT_LABEL, VERIFICATION_LABEL, pageLabel, Spinner } from './ui.tsx';

/**
 * PDF.js ships its worker as a separate module. Vite is told to build it as one and hand
 * back a URL, which keeps parsing off the main thread without a copy step or a CDN.
 */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  return pdfjs;
}

interface PageViewProps {
  readonly documentId: string;
  /** Zero-based physical page index, which is what every citation keys off. */
  readonly physicalPage: number;
  readonly bbox: EvidenceItem['block']['bbox'];
  readonly pageRotation: number;
}

/**
 * Renders one physical page of one document.
 *
 * The document is opened per drawer rather than cached globally. A reviewer looks at a
 * handful of pages and then closes it, and a cache that outlived the drawer would hold a
 * whole PDF in memory for a view nobody is looking at.
 */
function PageView({ documentId, physicalPage, bbox, pageRotation }: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let live = true;
    let cleanup: (() => void) | undefined;

    setRendering(true);
    setError(null);

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const task = pdfjs.getDocument({ url: documentFileUrl(documentId) });
        // The loading task owns the worker, so tearing that down is what releases the
        // document; the proxy itself has no destroy of its own.
        cleanup = () => void task.destroy();
        const pdf = await task.promise;
        if (!live) return;

        // PDF.js numbers pages from one; every stored citation is zero-based.
        const pageNumber = physicalPage + 1;
        if (pageNumber < 1 || pageNumber > pdf.numPages) {
          setError(
            `the citation names physical page ${pageNumber}, and the document has ${pdf.numPages}`,
          );
          setRendering(false);
          return;
        }

        const page = await pdf.getPage(pageNumber);
        if (!live) return;

        const canvas = canvasRef.current;
        if (canvas === null) return;

        // Rendered at the device pixel ratio and scaled back down in CSS, so small print
        // in a financial table stays readable rather than resampled to mush.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: 1.5 * ratio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;

        const context = canvas.getContext('2d');
        if (context === null) {
          setError('this browser did not provide a 2D canvas context');
          setRendering(false);
          return;
        }

        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!live) return;

        // Optional per plan 7.3. Drawn through the same viewport transform the page was
        // rendered with, so it accounts for scale and rotation instead of assuming
        // neither applies.
        if (bbox !== null) {
          const [x1, y1] = viewport.convertToViewportPoint(bbox.x, bbox.y);
          const [x2, y2] = viewport.convertToViewportPoint(
            bbox.x + bbox.width,
            bbox.y + bbox.height,
          );
          context.save();
          context.strokeStyle = 'rgba(31, 95, 208, 0.9)';
          context.fillStyle = 'rgba(31, 95, 208, 0.12)';
          context.lineWidth = 2 * ratio;
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.abs(x2 - x1);
          const height = Math.abs(y2 - y1);
          context.fillRect(left, top, width, height);
          context.strokeRect(left, top, width, height);
          context.restore();
        }

        setRendering(false);
      } catch (cause) {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setRendering(false);
      }
    })();

    return () => {
      live = false;
      cleanup?.();
    };
  }, [documentId, physicalPage, bbox]);

  return (
    <div className="stack">
      <div className="row small muted">
        {rendering ? <Spinner label="rendering the page" /> : null}
        {pageRotation !== 0 ? <span>page rotated {pageRotation}°</span> : null}
      </div>
      {error !== null ? (
        <p className="notice notice-error" role="alert">
          the original page could not be shown: {error}
        </p>
      ) : null}
      <div className="pdf-frame">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

export interface EvidenceDrawerProps {
  readonly title: string;
  readonly claimStatement: string;
  readonly evidence: readonly EvidenceItem[];
  onClose(): void;
}

/**
 * Shows every evidence link for one claim, one page at a time.
 *
 * Each item states its verification and its entailment as two separate lines. Plan 4.3
 * requires that separation to survive into the interface: a quote that is genuinely in
 * the document and still fails to support the claim is a finding a reviewer must be able
 * to read off the screen, and one combined "valid" mark would erase it.
 */
export function EvidenceDrawer({
  title,
  claimStatement,
  evidence,
  onClose,
}: EvidenceDrawerProps) {
  const [index, setIndex] = useState(0);
  const active = evidence[Math.min(index, evidence.length - 1)];

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="drawer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Evidence for ${title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <strong>Evidence</strong>
          <span className="muted small">{title}</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="drawer-body">
          <section className="card">
            <div className="card-body stack">
              <div>
                <p className="section-title">The claim</p>
                <p className="quote">{claimStatement}</p>
              </div>
            </div>
          </section>

          {active === undefined ? (
            <p className="notice">
              This claim has no evidence links. It cannot be accepted on that basis, and is
              shown so the gap is visible rather than silently filtered out.
            </p>
          ) : (
            <>
              {evidence.length > 1 ? (
                <div className="chips">
                  {evidence.map((item, position) => (
                    <button
                      key={item.id}
                      type="button"
                      className="chip"
                      aria-pressed={position === index}
                      onClick={() => setIndex(position)}
                    >
                      {pageLabel(item.block.physicalPage, item.block.printedPageLabel)} ·{' '}
                      {item.supportRole}
                    </button>
                  ))}
                </div>
              ) : null}

              <section className="card">
                <div className="card-head">
                  <strong>{active.block.filename}</strong>
                  <span className="badge badge-neutral">
                    {pageLabel(active.block.physicalPage, active.block.printedPageLabel)}
                  </span>
                  <span className="badge badge-neutral">{active.block.blockType}</span>
                  {active.block.extractionMethod === 'model_transcription' ? (
                    <span
                      className="badge badge-needs_review"
                      title="The model wrote this text from a page image. It cannot independently verify a claim the same model extracted."
                    >
                      model transcription
                    </span>
                  ) : null}
                </div>

                <div className="card-body stack">
                  <div>
                    <p className="section-title">The cited passage</p>
                    <blockquote className="quote">{active.quote}</blockquote>
                  </div>

                  <dl className="pairs">
                    <dt>Citation</dt>
                    <dd>{VERIFICATION_LABEL[active.verification]}</dd>
                    <dt>Support</dt>
                    <dd>{ENTAILMENT_LABEL[active.entailment]}</dd>
                    <dt>Role</dt>
                    <dd>{active.supportRole}</dd>
                    {active.verificationNote !== null ? (
                      <>
                        <dt>Note</dt>
                        <dd>{active.verificationNote}</dd>
                      </>
                    ) : null}
                    {active.quoteStart !== null ? (
                      <>
                        <dt>Offsets</dt>
                        <dd className="mono">
                          {active.quoteStart}–{active.quoteEnd ?? '?'} in the stored block
                        </dd>
                      </>
                    ) : null}
                  </dl>

                  <details>
                    <summary className="small muted">The stored source block in full</summary>
                    <p className="quote small" style={{ marginTop: 8 }}>
                      {active.block.content}
                    </p>
                  </details>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <strong>The original page</strong>
                  <span className="muted small">
                    from {active.block.filename}, as uploaded
                  </span>
                  <span className="spacer" />
                  <a
                    className="btn-link small"
                    href={`${documentFileUrl(active.block.documentId)}#page=${
                      active.block.physicalPage + 1
                    }`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open the PDF
                  </a>
                </div>
                <div className="card-body">
                  <PageView
                    documentId={active.block.documentId}
                    physicalPage={active.block.physicalPage}
                    bbox={active.block.bbox}
                    pageRotation={active.block.pageRotation}
                  />
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
