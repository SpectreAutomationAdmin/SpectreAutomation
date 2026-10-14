// WI-2B.1 (2026-09-27) — real-data Work Intake review page.
//
// Renders the accepted WI-2A visual design (`.wi-review-*` CSS
// namespace) with canonical `RealReviewData`. NEVER imports the
// Fairway fixture; every value is either a real canonical field
// or an explicit empty/pending state (§12).
//
// Contract:
//   - preserves the accepted composition and typography per §13
//   - shows "Not yet extracted" placeholders where data is unavailable
//   - shows no fake vendor / invoice # / dollar amount / GL code

import Link from "next/link";
import type { RealReviewData } from "@/lib/work-intake/review-detail-view-model";
import DocumentPdfPreview from "./DocumentPdfPreview";

function BackArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M8 3l-4 4 4 4M4 7h7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true">
      <path d="M8 5h10l5 5v15H8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M18 5v5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 15h8M11 18.5h8M11 22h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function OverflowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}
function ArrowRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 6h6M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function MetaLeadDot() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="wi-review-meta-dot">
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}
function CheckDot() {
  return (
    <span className="wi-review-check-dot" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="7" fill="#dff0dd" />
        <path d="M4.5 8.3l2.2 2.2L11.5 5.7" stroke="#1f6f3f" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
function Sparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5l1.3 3.7 3.7 1.3-3.7 1.3L10 12.5l-1.3-3.7L5 7.5l3.7-1.3z" fill="var(--wi-review-spectre-gold, #c9a24a)" />
    </svg>
  );
}
function CloseX() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function InsightCheck() {
  return (
    <span className="wi-review-insight-check" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r="8" fill="#dff0dd" />
        <path d="M5 9.3l2.5 2.5L13 6.5" stroke="#1f6f3f" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
function SendArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7h8M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Renders "Not yet extracted" in the muted-italic style used
 *  throughout the accepted design for pending/empty rows. */
function Pending({ label = "Not yet extracted" }: { label?: string }) {
  return <span style={{ color: "var(--wi-ink-3)", fontStyle: "italic" }}>{label}</span>;
}

function Header({ data }: { data: RealReviewData }) {
  const h = data.header;
  return (
    <header className="wi-review-header">
      <Link href="/app/admin/work-intake" className="wi-review-back">
        <BackArrow />
        <span>Back to Work Intake</span>
      </Link>
      <div className="wi-review-header-row">
        <div className="wi-review-header-icon" aria-hidden="true">
          <DocIcon />
        </div>
        <div className="wi-review-header-body">
          <div className="wi-review-eyebrow">{h.eyebrow}</div>
          <h1 className="wi-review-title">{h.title}</h1>
          <div className="wi-review-meta">
            {h.detectedAtLabel && <span className="wi-review-meta-item">{h.detectedAtLabel}</span>}
            {h.metaChips.map((chip, i) => (
              <span key={i} className={`wi-review-meta-chip wi-review-meta-chip--${chip.tone}`}>
                {i === 0 && chip.tone === "amber-outline" && <MetaLeadDot />}
                <span>{chip.label}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="wi-review-header-actions">
          <button type="button" className="wi-review-icon-btn" aria-label="More" disabled>
            <OverflowIcon />
          </button>
          <button type="button" className="wi-review-btn wi-review-btn--ghost" disabled>Send back</button>
          <button type="button" className="wi-review-btn wi-review-btn--primary" disabled>
            Approve &amp; Start <ArrowRight />
          </button>
        </div>
      </div>
    </header>
  );
}

function Tabs() {
  return (
    <nav className="wi-review-tabs" role="tablist" aria-label="Review sections">
      <button type="button" role="tab" aria-selected={true} className="wi-review-tab wi-review-tab--active">
        <span>Overview</span>
      </button>
      <button type="button" role="tab" className="wi-review-tab">
        <span>Documents</span>
      </button>
      <button type="button" role="tab" className="wi-review-tab">
        <span>Extracted Data</span>
      </button>
      <button type="button" role="tab" className="wi-review-tab">
        <span>Related Work</span>
      </button>
      <button type="button" role="tab" className="wi-review-tab">
        <span>Audit Trail</span>
      </button>
    </nav>
  );
}

function DocumentPreview({ data }: { data: RealReviewData }) {
  const d = data.document;
  const pdf = d.primaryPdf;
  return (
    <div className={`wi-review-doc-wrap${pdf ? " wi-review-doc-wrap--pdf" : ""}`}>
      {pdf ? (
        // WI-2B.2 — real PDF served by /api/documents/{id}/preview,
        // rendered inside the accepted .wi-review-doc viewport via the
        // blob-fetch pattern (X-Frame-Options: DENY blocks a direct
        // iframe src=/api/documents/... in Chrome; the middleware CSP
        // already permits blob: framing).
        <DocumentPdfPreview
          ingestedDocumentId={pdf.ingestedDocumentId}
          filename={pdf.filename}
        />
      ) : (
        <article
          className="wi-review-doc"
          aria-label="Work Intake document"
          style={{ minHeight: 220, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}
        >
          {d.hasAttachments ? (
            <>
              <div style={{ fontSize: 32, marginBottom: 8, color: "var(--wi-ink-3)" }}>
                <DocIcon />
              </div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--wi-ink)", marginBottom: 4 }}>
                {d.firstAttachmentFilename ?? "Attached document"}
              </div>
              {d.attachmentCount > 1 && (
                <div style={{ fontSize: 10, color: "var(--wi-ink-3)" }}>
                  +{d.attachmentCount - 1} more attachment{d.attachmentCount - 1 === 1 ? "" : "s"}
                </div>
              )}
              <div style={{ fontSize: 9, color: "var(--wi-ink-3)", marginTop: 12, maxWidth: 240 }}>
                Attachment is not yet available for inline preview.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 32, marginBottom: 8, color: "var(--wi-ink-3)" }}>
                <DocIcon />
              </div>
              <div style={{ fontSize: 11, color: "var(--wi-ink-3)" }}>
                No document attached to this Work Intake item.
              </div>
            </>
          )}
        </article>
      )}
      <div className="wi-review-doc-toolbar">
        {pdf ? (
          // WI-2B.4 — "Open full document" is a VIEW action. Point
          // it at /preview (Content-Disposition: inline) so the
          // browser opens its native PDF viewer in a new tab with
          // built-in navigation, save + print controls. The
          // authorization guard is the same as the inline preview
          // (loadReadable() enforces clubId + WORK_INTAKE_ITEM
          // evidence link). Download remains available inside the
          // browser's viewer chrome.
          <a
            href={`/api/documents/${encodeURIComponent(pdf.ingestedDocumentId)}/preview#view=Fit&toolbar=1&navpanes=0`}
            className="wi-review-doc-link"
            target="_blank"
            rel="noreferrer"
            data-testid="wi-review-doc-open-full"
          >
            Open full document
          </a>
        ) : d.webLink ? (
          <a href={d.webLink} className="wi-review-doc-link" target="_blank" rel="noreferrer">
            Open in Outlook
          </a>
        ) : (
          <span className="wi-review-doc-link" style={{ opacity: 0.5 }}>View full document</span>
        )}
        <div className="wi-review-doc-pager">
          <span className="wi-review-doc-page">
            {pdf ? `1 / ${d.attachmentCount}` : d.attachmentCount > 0 ? `1 / ${d.attachmentCount}` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="wi-review-doc-meta-row">
      <div className="wi-review-doc-meta-label">{label}</div>
      <div className="wi-review-doc-meta-value">{value}</div>
    </div>
  );
}

function Classification({ data }: { data: RealReviewData }) {
  const i = data.invoice;
  return (
    <div className="wi-review-classify" aria-label="Extracted information">
      <MetaRow label="Vendor" value={i.vendor ?? <Pending />} />
      <MetaRow label="Invoice #" value={i.invoiceNumber ?? <Pending />} />
      <MetaRow label="Invoice Date" value={i.invoiceDateLabel ?? <Pending />} />
      <MetaRow label="Due Date" value={i.dueDateLabel ?? <Pending />} />
      <MetaRow label="Total Amount" value={i.totalLabel ?? <Pending />} />
      <div className="wi-review-classify-divider" role="presentation" />
      <MetaRow label="Category" value={i.categoryLabel ?? <Pending />} />
      <MetaRow label="GL Suggestion" value={i.glAccountLabel ?? <Pending />} />
      <MetaRow
        label="Vendor Match"
        value={
          i.vendorMatchState
            ? i.vendorMatchState.replace(/_/g, " ").toLowerCase()
            : <Pending label="Not resolved" />
        }
      />
      <MetaRow label="Workflow State" value={i.workflowStateLabel ?? <Pending />} />
    </div>
  );
}

// WI-2B.7 — Context rendered as an inline SECTION (no card chrome)
// inside the consolidated Invoice Details card. Uses the same
// per-row visual language as the WI-2B.6 standalone Context card
// (category label + green check + title/meta), but drops the outer
// .wi-review-card wrapper so the section reads as another column of
// the same composed card, not a nested card-in-a-card (§8).
function ContextSection({ data }: { data: RealReviewData }) {
  return (
    <div className="wi-review-details-context" aria-label="Context">
      <h3 className="wi-review-details-subhead">Context</h3>
      <div className="wi-review-context-list">
        {data.context.map((row, i) => (
          <div key={i} className="wi-review-context-row">
            <div className="wi-review-context-cat">{row.category}</div>
            <div className="wi-review-context-body">
              <CheckDot />
              <div className="wi-review-context-lines">
                <div className="wi-review-context-title">{row.title}</div>
                <div className="wi-review-context-meta">{row.meta}</div>
              </div>
            </div>
            <div className="wi-review-context-action" />
          </div>
        ))}
      </div>
    </div>
  );
}

// WI-2B.7 — Line Items rendered as an inline SECTION spanning the
// combined metadata + context width. Same table + summary head as
// the WI-2B.6 standalone Line Items card, minus the .wi-review-card
// wrapper. Freezes the WI-2B.6-accepted data: role-aware purchase
// rows + canonical tax rows, subtotal/total NEVER become rows.
function LineItemsSection({ data }: { data: RealReviewData }) {
  const lines = data.invoice.lineItems ?? [];
  const tax = data.invoice.tax ?? [];
  const totalRows = lines.length + tax.length;
  const nextIndexAfterLines = lines.length + 1;
  return (
    <div className="wi-review-details-lines" aria-label="Line Items">
      <div className="wi-review-details-subhead-row">
        <h3 className="wi-review-details-subhead">Line Items</h3>
        {totalRows > 0 && (
          <div className="wi-review-card-summary">
            <span>{totalRows} item{totalRows === 1 ? "" : "s"}</span>
            {data.invoice.totalLabel && (
              <span className="wi-review-card-summary-total">{data.invoice.totalLabel}</span>
            )}
          </div>
        )}
      </div>
      {totalRows > 0 ? (
        <table className="wi-review-lines" data-testid="wi-review-lines-table">
          <thead>
            <tr>
              <th className="wi-review-lines-idx">#</th>
              <th>Description</th>
              <th className="wi-review-lines-num">Qty</th>
              <th className="wi-review-lines-num">Unit Price</th>
              <th className="wi-review-lines-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={"line-" + l.n} data-row-role="purchase">
                <td className="wi-review-lines-idx">{l.n}</td>
                <td>{l.description || <span style={{ color: "var(--wi-ink-3)", fontStyle: "italic" }}>Unlabeled line</span>}</td>
                <td className="wi-review-lines-num">{l.quantity ?? ""}</td>
                <td className="wi-review-lines-num">{l.unitCost ?? ""}</td>
                <td className="wi-review-lines-num">{l.amount ?? ""}</td>
              </tr>
            ))}
            {tax.map((t, i) => (
              <tr key={"tax-" + i} data-row-role="tax">
                <td className="wi-review-lines-idx">{nextIndexAfterLines + i}</td>
                <td>
                  <span style={{ fontWeight: 500 }}>{t.label}</span>
                  {t.rate != null && (
                    <span style={{ color: "var(--wi-ink-3)", marginLeft: 6 }}>{t.rate}%</span>
                  )}
                </td>
                <td className="wi-review-lines-num">{"—"}</td>
                <td className="wi-review-lines-num">{"—"}</td>
                <td className="wi-review-lines-num">{t.amount ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ padding: "18px 8px", fontSize: 12, color: "var(--wi-ink-3)", fontStyle: "italic" }}>
          {data.invoice.hasExtraction
            ? "Line-item extraction not yet available for this record."
            : "This item does not carry line-item data."}
        </div>
      )}
    </div>
  );
}

// WI-2B.7 — Consolidated Invoice Details card.
// Layout:
//   Left:  PDF (unchanged)
//   Right: two-column upper (metadata + context) then Line Items
//          spanning the full right width.
// The standalone Line Items and Context cards are removed from the
// main body.
function InvoiceDetails({ data }: { data: RealReviewData }) {
  return (
    <section className="wi-review-card wi-review-card--details" aria-label="Invoice Details">
      <div className="wi-review-card-head">
        <h2 className="wi-review-card-title">
          {data.invoice.hasExtraction ? "Invoice Details" : "Work Intake Details"}
        </h2>
      </div>
      <div className="wi-review-details-grid">
        <div className="wi-review-details-doc">
          <DocumentPreview data={data} />
        </div>
        <div className="wi-review-details-info">
          <div className="wi-review-details-upper">
            <div className="wi-review-details-metadata">
              <Classification data={data} />
            </div>
            <ContextSection data={data} />
          </div>
          <LineItemsSection data={data} />
        </div>
      </div>
    </section>
  );
}

function Workflow({ data }: { data: RealReviewData }) {
  return (
    <section className="wi-review-card wi-review-card--workflow" aria-label="Workflow">
      <div className="wi-review-card-head">
        <h2 className="wi-review-card-title">Workflow</h2>
      </div>
      <ol className="wi-review-flow" data-testid="wi-review-flow">
        {data.workflow.map((s, i) => (
          <li key={i} className={`wi-review-flow-stage wi-review-flow-stage--${s.state}`}>
            {i > 0 && <span className="wi-review-flow-conn" aria-hidden="true" />}
            <div className="wi-review-flow-head">
              <span className="wi-review-flow-circle" aria-hidden="true">{s.index}</span>
              <span className="wi-review-flow-label">{s.label}</span>
            </div>
            <div className="wi-review-flow-supporting">
              {s.supporting.split("\n").map((line, li) => (
                <div key={li}>{line}</div>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SpectreRail({ data }: { data: RealReviewData }) {
  const s = data.spectre;
  return (
    <aside className="wi-review-rail" aria-label="Spectre intelligence">
      <header className="wi-review-rail-head">
        <div className="wi-review-rail-brand">
          <Sparkle />
          <div className="wi-review-rail-brand-text">
            <div className="wi-review-rail-brand-name">Spectre</div>
            <div className="wi-review-rail-brand-sub">Your autonomous finance teammate</div>
          </div>
        </div>
        <button type="button" className="wi-review-rail-close" aria-label="Close Spectre" disabled>
          <CloseX />
        </button>
      </header>
      <div className="wi-review-rail-lead">
        <p>{s.lead}</p>
      </div>
      <section className="wi-review-rail-section">
        <h3 className="wi-review-rail-section-title">Key Insights</h3>
        {s.hasIntelligence ? (
          <ul className="wi-review-insights">
            {s.keyInsights.map((k, i) => (
              <li key={i} className="wi-review-insight">
                <InsightCheck />
                <span>{k}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: 12, color: "var(--wi-ink-3)", fontStyle: "italic" }}>
            No insights available yet — classification confidence: {s.classificationConfidence}.
          </div>
        )}
      </section>
      <section className="wi-review-rail-section">
        <h3 className="wi-review-rail-section-title">Recommendations</h3>
        <div style={{ fontSize: 12, color: "var(--wi-ink-3)", fontStyle: "italic" }}>
          Recommendation actions are not yet wired for this record.
        </div>
      </section>
      <div className="wi-review-ask">
        <textarea
          className="wi-review-ask-field"
          placeholder="Ask anything about this record…"
          aria-label="Ask Spectre"
          rows={3}
          disabled
        />
        <button type="button" className="wi-review-ask-send" aria-label="Send" disabled>
          <SendArrow />
        </button>
      </div>
    </aside>
  );
}

export default function WorkIntakeReviewReal({ data }: { data: RealReviewData }) {
  return (
    <div
      className="wi-review-root"
      data-testid="wi-review-root"
      data-work-intake-id={data.workIntakeItemId}
      data-real="1"
    >
      <div className="wi-review-grid">
        <div className="wi-review-main">
          <Header data={data} />
          <Tabs />
          <div className="wi-review-body">
            {/* WI-2B.7 — Invoice Details now includes Metadata,
               Context, and Line Items as sections. Standalone
               Line Items and Context cards were removed. */}
            <InvoiceDetails data={data} />
            <Workflow data={data} />
          </div>
        </div>
        <SpectreRail data={data} />
      </div>
    </div>
  );
}
