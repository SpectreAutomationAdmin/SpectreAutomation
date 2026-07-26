"use client";

// Sprint 3 Checkpoint 15I (2026-07-26) — Variant D card body.
//
// Founder-approved design reference:
//   public/design-concepts/mission-control/variant-d-instrument.html
//
// This component renders an email-derived Work Intake item using the
// Variant D card shell: `.spectre-mc-item` outer, `.spectre-mc-pill`
// eyebrow, `h3` operational headline, `.spectre-mc-sender` metadata
// line, `.spectre-mc-work` prose, `.spectre-mc-readout` instrument-
// panel metric strip, `.spectre-mc-rec` recommendation strip, and a
// compact `.spectre-mc-actions` row with queue-level actions only.
//
// Interaction contract (Checkpoint 15I):
//   • Clicking the primary card surface marks-read AND expands the
//     card in place (accordion). Nested buttons/tabs `stopPropagation`.
//   • Read state is per-user (WorkIntakeItemRead table). The card
//     calls POST /api/work-intake/action { action: "mark_read" } on
//     first expand.
//   • Merely rendering the feed does NOT flip read state.
//   • Contextual tabs — Conversation | Attachments | Invoice Review |
//     Statement Review | Activity. Only the tabs relevant to the
//     linked intelligence render.
//   • Resolve fires POST { action: "resolve" } and triggers a
//     router.refresh() so the item drops from the active feed.
//
// Preserves all Sprint 3 Checkpoint 15H behaviour:
//   • One canonical parent card per email conversation (loader-level
//     suppression of child AP / Statement intakes)
//   • Blob-URL PDF preview via DocumentPreviewModal (CSP object-src +
//     frame-src permit `blob:` per src/middleware.ts)
//   • Sender identity remains SEPARATE from extracted vendor identity:
//     the sender-line in the collapsed body shows the email `from`
//     name; the Invoice Review tab shows the PDF-extracted vendor
//     name. They are never conflated.
//   • Tenant isolation preserved end-to-end.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import InlineConversationPanel, { type ConversationDetail } from "./InlineConversationPanel";
import ReplyComposer from "./ReplyComposer";
import DocumentPreviewModal from "./DocumentPreviewModal";

// -------------------------------------------------------------------------
// Public props
// -------------------------------------------------------------------------

export interface EmailFeedCardData {
  workIntakeItemId: string;
  emailMessageId: string;
  // Semantic state → left rail colour + pill variant (Variant D §3.6).
  state: "judgment" | "info" | "comm";
  idTag: string;
  situationTitle: string;
  contextLine: string;           // Sender line — the raw email `from` metadata.
  timestampLabel: string;
  synopsisText: string;
  evidence: Array<{
    // Existing label vocabulary — projected by the loader from the
    // analyser. Rendered as the 4-cell instrument-panel readout in
    // Variant D style. See src/lib/mission-control/index.ts →
    // WorkItemEvidenceCell.
    label: string;
    value: string;
    state: "found" | "ambiguous" | "not_found" | "not_extracted" | "extracted" | "duplicate" | "no_data";
  }>;
  recommendation?: string;
  isUnread: boolean;             // Projected per-user by the loader (Checkpoint 15I).
  isHighImportance: boolean;
  conversationMessageCount: number;
  workIntakeStatus?: string;     // OPEN | IN_PROGRESS | DEFERRED | RESOLVED | INFORMATIONAL | SUPPRESSED
  linkedIntelligence?: {
    apReviewIntakeIds: string[];
    statementReviewIntakeIds: string[];
    attachmentCount: number;
    invoiceAttachmentCount: number;
    statementAttachmentCount: number;
    dominantFacet: "email" | "invoice" | "statement" | "invoice+statement";
    invoiceSummary?: {
      vendorGuess: string | null;
      invoiceNumber: string | null;
      total: string | null;
      currency: string | null;
      capitalState: string | null;
      unresolvedFindingCount: number;
    };
    statementSummary?: {
      vendorGuess: string | null;
      closingBalance: string | null;
      currency: string | null;
      reconciliationState: string | null;
      unresolvedFindingCount: number;
    };
  };
}

interface Props { data: EmailFeedCardData }

type Tab = "conversation" | "attachments" | "invoice" | "statement" | "activity";

const PILL_LABEL: Record<EmailFeedCardData["state"], string> = {
  judgment: "Needs judgment",
  info: "Informational",
  comm: "Communication required",
};

// -------------------------------------------------------------------------
// Card
// -------------------------------------------------------------------------

export default function EmailIntakeCard({ data }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [readLocal, setReadLocal] = useState(!data.isUnread);
  const [tab, setTab] = useState<Tab>(defaultTabFor(data));
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [pdfModal, setPdfModal] = useState<null | { documentId: string; filename: string }>(null);
  const [apEvidence, setApEvidence] = useState<unknown | null>(null);
  const [statementEvidence, setStatementEvidence] = useState<unknown | null>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; filename: string; mimeType: string; byteLength: number; classification: string; receivedAt: string }> | null
  >(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);

  const isUnread = !readLocal;
  const isResolved = data.workIntakeStatus === "RESOLVED";
  const linked = data.linkedIntelligence;

  const availableTabs = tabsFor(data);

  useEffect(() => {
    // If the linked intelligence changes and the current tab is no
    // longer in the available set, snap back to the default.
    if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "activity");
  }, [availableTabs, tab]);

  const loadConversationOnce = useCallback(async () => {
    if (detail || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(data.workIntakeItemId)}/thread`,
        { method: "GET" },
      );
      if (res.status === 404) { setError("not_found"); return; }
      if (!res.ok) { setError("load_failed"); return; }
      const body = (await res.json()) as ConversationDetail;
      setDetail(body);
    } catch { setError("load_failed"); }
    finally { setLoading(false); }
  }, [data.workIntakeItemId, detail, loading]);

  const loadAttachmentsOnce = useCallback(async () => {
    if (attachments !== null) return;
    try {
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(data.workIntakeItemId)}/documents`,
        { method: "GET" },
      );
      if (!res.ok) { setAttachments([]); return; }
      const body = await res.json();
      setAttachments(body.documents ?? []);
    } catch { setAttachments([]); }
  }, [data.workIntakeItemId, attachments]);

  const loadApEvidenceOnce = useCallback(async () => {
    if (apEvidence !== null || !linked || linked.apReviewIntakeIds.length === 0) return;
    try {
      const apIntakeId = linked.apReviewIntakeIds[0];
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(apIntakeId)}/ap-evidence`,
        { method: "GET" },
      );
      if (!res.ok) { setApEvidence({ error: "load_failed" }); return; }
      setApEvidence(await res.json());
    } catch { setApEvidence({ error: "network" }); }
  }, [apEvidence, linked]);

  const loadStatementEvidenceOnce = useCallback(async () => {
    if (statementEvidence !== null || !linked || linked.statementReviewIntakeIds.length === 0) return;
    try {
      const stIntakeId = linked.statementReviewIntakeIds[0];
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(stIntakeId)}/statement-evidence`,
        { method: "GET" },
      );
      if (!res.ok) { setStatementEvidence({ error: "load_failed" }); return; }
      setStatementEvidence(await res.json());
    } catch { setStatementEvidence({ error: "network" }); }
  }, [statementEvidence, linked]);

  // Fire the mark-read side effect the first time the user opens the
  // card. Idempotent server-side — repeated calls are no-ops.
  const markReadOnce = useCallback(async () => {
    if (readLocal || !data.workIntakeItemId) return;
    setReadLocal(true);
    try {
      await fetch("/api/work-intake/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "mark_read" }),
      });
    } catch {
      // Non-blocking. If the mark-read call fails, the UI state still
      // flips locally — a subsequent snapshot load will re-derive.
    }
  }, [readLocal, data.workIntakeItemId]);

  const handlePrimarySurfaceClick = useCallback(() => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    void markReadOnce();
    // Lazy-load the initial tab's data on first expand.
    const initial = defaultTabFor(data);
    setTab(initial);
    if (initial === "conversation") void loadConversationOnce();
    if (initial === "attachments") void loadAttachmentsOnce();
    if (initial === "invoice") void loadApEvidenceOnce();
    if (initial === "statement") void loadStatementEvidenceOnce();
  }, [expanded, markReadOnce, data, loadConversationOnce, loadAttachmentsOnce, loadApEvidenceOnce, loadStatementEvidenceOnce]);

  const handleResolve = useCallback(async (evt: React.MouseEvent) => {
    evt.stopPropagation();
    if (resolving) return;
    setResolving(true);
    setResolveError(null);
    try {
      const res = await fetch("/api/work-intake/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "resolve" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResolveError(body.error ?? "resolve_failed");
        setResolving(false);
        return;
      }
      // Re-fetch the RSC snapshot. The active-feed filter will drop
      // this card automatically (loader now excludes RESOLVED). The
      // underlying WorkIntakeItem row + email + documents + findings
      // are preserved — resolve is a status transition, not a delete.
      router.refresh();
    } catch {
      setResolveError("network");
      setResolving(false);
    }
  }, [resolving, data.workIntakeItemId, router]);

  // --- render ------------------------------------------------------------
  const semanticClass = isResolved ? "done" : data.state;

  return (
    <article
      className={`spectre-mc-item ${semanticClass}${isUnread ? " spectre-mc-item--unread" : ""}`}
      data-testid="email-intake-card"
      data-work-intake-item-id={data.workIntakeItemId}
      data-email-id={data.emailMessageId}
      data-unread={isUnread ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      data-resolved={isResolved ? "true" : "false"}
      aria-labelledby={`title-${data.workIntakeItemId}`}
    >
      {/* Primary click surface — everything visible in Variant D up to
          the recommendation strip. Not a <button> to preserve inner
          semantic content (h3, dl, etc.); role/keyboard support wired
          explicitly. */}
      <div
        className="spectre-mc-item-surface"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handlePrimarySurfaceClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handlePrimarySurfaceClick();
          }
        }}
        ref={openButtonRef as unknown as React.Ref<HTMLDivElement>}
        data-testid="card-surface"
      >
        <div className="spectre-mc-item-head">
          <span className={`spectre-mc-pill ${data.state}`}>{PILL_LABEL[data.state]}</span>
          <span className="spectre-mc-id-tag">{data.idTag}</span>
          {data.isHighImportance ? (
            <span className="spectre-mc-flag" data-testid="email-importance-high" title="High importance in the source mailbox">
              High importance
            </span>
          ) : null}
          {data.conversationMessageCount > 1 ? (
            <span className="spectre-mc-convo-count" data-testid="email-convo-count">
              {data.conversationMessageCount} messages
            </span>
          ) : null}
          <span className="spectre-mc-ts">{data.timestampLabel}</span>
        </div>

        <h3 id={`title-${data.workIntakeItemId}`}>{data.situationTitle}</h3>

        <div className="spectre-mc-sender">
          <span className="from">{data.contextLine}</span>
        </div>

        <p className="spectre-mc-work" data-testid="email-synopsis">
          {data.synopsisText}
        </p>

        {data.evidence.length > 0 ? (
          <div className="spectre-mc-readout" data-testid="email-readout">
            {data.evidence.slice(0, 4).map((cell) => (
              <div key={cell.label} className="cell" data-testid={`readout-${cell.label.toLowerCase().replace(/\s+/g, "-")}`}>
                <div className="k">{cell.label}</div>
                <div className={`v${cell.state === "not_found" || cell.state === "not_extracted" ? " observation" : ""}${cell.state === "found" ? " confidence" : ""}`}>
                  {cell.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {data.recommendation ? (
          <div className="spectre-mc-rec">
            <span className="k">Recommended</span>
            <span className="v">{data.recommendation}</span>
          </div>
        ) : null}
      </div>

      {/* Actions — queue-level only. Domain actions live inside the
          expanded tabs (§3.4 of Checkpoint 15I). */}
      <div
        className="spectre-mc-actions"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        {isResolved ? (
          <span className="spectre-mc-aux" data-testid="card-resolved-marker">
            Resolved · in Completed history
          </span>
        ) : (
          <>
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary spectre-btn--sm"
              onClick={handleResolve}
              disabled={resolving}
              data-testid="card-resolve"
            >
              {resolving ? "Resolving…" : "Resolve"}
            </button>
            {resolveError ? (
              <span className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">
                Could not resolve — please retry.
              </span>
            ) : null}
          </>
        )}
        <div className="grow" />
        <button
          type="button"
          className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
          onClick={handlePrimarySurfaceClick}
          data-testid="card-toggle"
          aria-expanded={expanded}
        >
          {expanded ? "Collapse" : "Open"}
        </button>
      </div>

      {/* Expanded region — tabs + tab body. All clicks here stop
          propagating so they don't re-collapse the card. */}
      {expanded ? (
        <div
          className="spectre-mc-item-expanded"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
          data-testid="email-inline-expansion"
        >
          <TabBar
            available={availableTabs}
            active={tab}
            onChange={(next) => {
              setTab(next);
              if (next === "conversation" || next === "activity") void loadConversationOnce();
              if (next === "attachments") void loadAttachmentsOnce();
              if (next === "invoice") void loadApEvidenceOnce();
              if (next === "statement") void loadStatementEvidenceOnce();
            }}
          />
          <div className="spectre-mc-tab-body" data-testid="unified-tab-body">
            {tab === "conversation" && (
              loading ? <div className="spectre-mc-inline-status" role="status">Loading conversation…</div>
              : error ? <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">Could not load the conversation.</div>
              : detail ? (
                <>
                  <InlineConversationPanel detail={detail} />
                  {replyOpen ? (
                    <ReplyComposer
                      workIntakeItemId={data.workIntakeItemId}
                      emailMessageId={data.emailMessageId}
                      seedRecommendation={data.recommendation}
                      consentState={detail.replyConsent}
                      onCancel={() => setReplyOpen(false)}
                    />
                  ) : (
                    <div className="spectre-mc-tab-actions">
                      <button
                        type="button"
                        className="spectre-btn spectre-btn--secondary spectre-btn--sm"
                        onClick={() => setReplyOpen(true)}
                        data-testid="tab-conversation-reply"
                      >
                        Reply
                      </button>
                    </div>
                  )}
                </>
              )
              : null
            )}
            {tab === "attachments" && (
              attachments === null ? <div className="spectre-mc-inline-status" role="status">Loading attachments…</div>
              : (
                <ul className="spectre-mc-attachment-list" data-testid="unified-attachment-list">
                  {attachments.length === 0 ? <li>No attachments.</li> : null}
                  {attachments.map((a) => (
                    <li key={a.id} data-testid={`unified-attachment-${a.id}`}>
                      <div><strong>{a.filename}</strong></div>
                      <div className="spectre-review-muted">{a.classification} · {a.mimeType} · {Math.round(a.byteLength / 1024)} KB</div>
                      <div>
                        <button
                          type="button"
                          className="spectre-btn spectre-btn--sm spectre-btn--secondary"
                          onClick={() => setPdfModal({ documentId: a.id, filename: a.filename })}
                          data-testid={`unified-attachment-preview-${a.id}`}
                        >
                          View PDF
                        </button>
                        <a
                          href={`/api/documents/${encodeURIComponent(a.id)}/download`}
                          className="spectre-btn spectre-btn--sm spectre-btn--ghost"
                          download={a.filename}
                        >
                          Download
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}
            {tab === "invoice" && (
              apEvidence === null ? <div className="spectre-mc-inline-status" role="status">Loading invoice review…</div>
              : <InvoiceFacetPane payload={apEvidence as ApEvidence} onOpenPdf={(docId, filename) => setPdfModal({ documentId: docId, filename })} />
            )}
            {tab === "statement" && (
              statementEvidence === null ? <div className="spectre-mc-inline-status" role="status">Loading statement reconciliation…</div>
              : <StatementFacetPane payload={statementEvidence as StatementEvidence} onOpenPdf={(docId, filename) => setPdfModal({ documentId: docId, filename })} />
            )}
            {tab === "activity" && (
              detail ? (
                <p className="spectre-review-muted">See conversation tab for message history. Item-level activity timeline arrives in the follow-up entity-timeline checkpoint.</p>
              ) : loading ? <div className="spectre-mc-inline-status" role="status">Loading activity…</div>
              : <p className="spectre-review-muted">No activity to show yet.</p>
            )}
          </div>
        </div>
      ) : null}

      {pdfModal ? (
        <DocumentPreviewModal
          documentId={pdfModal.documentId}
          filename={pdfModal.filename}
          open={true}
          onClose={() => setPdfModal(null)}
          contextLabel={`From: ${data.contextLine} · ${data.timestampLabel}`}
        />
      ) : null}
    </article>
  );
}

// -------------------------------------------------------------------------
// Tab plumbing (contextual — Variant D §3.3)
// -------------------------------------------------------------------------

function tabsFor(data: EmailFeedCardData): Tab[] {
  const linked = data.linkedIntelligence;
  const tabs: Tab[] = ["conversation"];
  if ((linked?.attachmentCount ?? 0) > 0) tabs.push("attachments");
  if ((linked?.invoiceAttachmentCount ?? 0) > 0) tabs.push("invoice");
  if ((linked?.statementAttachmentCount ?? 0) > 0) tabs.push("statement");
  tabs.push("activity");
  return tabs;
}

function defaultTabFor(data: EmailFeedCardData): Tab {
  const linked = data.linkedIntelligence;
  if ((linked?.invoiceAttachmentCount ?? 0) > 0) return "invoice";
  if ((linked?.statementAttachmentCount ?? 0) > 0) return "statement";
  return "conversation";
}

function TabBar({ available, active, onChange }: { available: Tab[]; active: Tab; onChange: (t: Tab) => void }) {
  const LABEL: Record<Tab, string> = {
    conversation: "Conversation",
    attachments: "Attachments",
    invoice: "Invoice Review",
    statement: "Statement Review",
    activity: "Activity",
  };
  return (
    <div className="spectre-mc-tabs" role="tablist" data-testid="unified-tabs">
      {available.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={active === t}
          className={`spectre-mc-tab${active === t ? " spectre-mc-tab--active" : ""}`}
          onClick={(e) => { e.stopPropagation(); onChange(t); }}
          data-testid={`unified-tab-${t}`}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------
// Invoice + Statement facet panes (preserved from Checkpoint 15H)
// -------------------------------------------------------------------------

interface ApEvidence {
  document: { id: string; filename: string; mimeType: string; byteLength: number };
  extraction: {
    state: string;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    total: string | null;
    subtotal: string | null;
    taxTotal: string | null;
    currency: string | null;
    vendor: { guessedName: string | null; guessedTaxNumber: string | null };
    warnings: string[];
  };
  vendorResolution: { state: string };
  capitalRecommendation: { state: string; reasoning: string };
  glRecommendation: { accountNumber: string | null; accountName: string | null; reason: string };
  sourceCorrespondence?: { senderName: string | null; senderAddress: string | null; subject: string | null; receivedAt: string };
  error?: string;
}
interface StatementEvidence {
  document: { id: string; filename: string; mimeType: string; byteLength: number };
  vendor: { legalName: string; operatingName: string | null } | null;
  statementSummary: { statementDate: string | null; openingBalance: string; closingBalance: string; currency: string; reconciliationState: string };
  lines: Array<{ id: string; sequence: number; referenceNumber: string | null; description: string | null; debitAmount: string; creditAmount: string; matches: Array<{ matchState: string }> }>;
  findings: Array<{ id: string; key: string; severity: string; statement: string }>;
  error?: string;
}

function InvoiceFacetPane({ payload, onOpenPdf }: { payload: ApEvidence; onOpenPdf: (docId: string, filename: string) => void }) {
  if (payload.error) return <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">Invoice review could not load.</div>;
  return (
    <div className="spectre-review-pane" data-testid="unified-invoice-pane">
      <section className="spectre-review-section">
        <h4>Extracted invoice facts</h4>
        <p className="spectre-review-muted">
          <strong>Vendor (from PDF):</strong> {payload.extraction.vendor.guessedName ?? "not extracted"}
          {payload.extraction.vendor.guessedTaxNumber ? <> · Tax #: {payload.extraction.vendor.guessedTaxNumber}</> : null}
        </p>
        {payload.sourceCorrespondence ? (
          <p className="spectre-review-muted">
            <strong>Received from (email sender — provenance only):</strong>{" "}
            {payload.sourceCorrespondence.senderName ?? payload.sourceCorrespondence.senderAddress ?? "unknown"}
          </p>
        ) : null}
        <dl className="spectre-review-facts">
          <div className="spectre-review-fact"><dt>Invoice #</dt><dd>{payload.extraction.invoiceNumber ?? "Not extracted — review required"}</dd></div>
          <div className="spectre-review-fact"><dt>Invoice date</dt><dd>{payload.extraction.invoiceDate ?? "Not extracted — review required"}</dd></div>
          <div className="spectre-review-fact"><dt>Subtotal</dt><dd>{payload.extraction.subtotal ? `${payload.extraction.currency ?? "CAD"} ${payload.extraction.subtotal}` : "Not extracted"}</dd></div>
          <div className="spectre-review-fact"><dt>Tax</dt><dd>{payload.extraction.taxTotal ? `${payload.extraction.currency ?? "CAD"} ${payload.extraction.taxTotal}` : "Not extracted"}</dd></div>
          <div className="spectre-review-fact spectre-review-fact--strong"><dt>Total</dt><dd>{payload.extraction.total ? `${payload.extraction.currency ?? "CAD"} ${payload.extraction.total}` : "Not extracted — review required"}</dd></div>
          <div className="spectre-review-fact"><dt>Extraction state</dt><dd>{payload.extraction.state}</dd></div>
          <div className="spectre-review-fact"><dt>Vendor resolution</dt><dd>{payload.vendorResolution.state}</dd></div>
          <div className="spectre-review-fact"><dt>Capital vs Operating</dt><dd>{payload.capitalRecommendation.state}</dd></div>
          <div className="spectre-review-fact"><dt>GL recommendation</dt><dd>{payload.glRecommendation.accountNumber ? `${payload.glRecommendation.accountNumber} — ${payload.glRecommendation.accountName ?? ""}` : "None"}</dd></div>
        </dl>
        {payload.extraction.warnings.length > 0 ? (
          <div className="spectre-review-warnings" role="note">
            <strong>Extraction warnings</strong>
            <ul>{payload.extraction.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        ) : null}
        <div className="spectre-review-doc-actions">
          <button
            type="button"
            className="spectre-btn spectre-btn--sm spectre-btn--primary"
            onClick={() => onOpenPdf(payload.document.id, payload.document.filename)}
            data-testid="unified-invoice-view-pdf"
          >
            View invoice PDF
          </button>
        </div>
      </section>
    </div>
  );
}

function StatementFacetPane({ payload, onOpenPdf }: { payload: StatementEvidence; onOpenPdf: (docId: string, filename: string) => void }) {
  if (payload.error) return <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">Statement review could not load.</div>;
  const sum = payload.statementSummary;
  return (
    <div className="spectre-review-pane" data-testid="unified-statement-pane">
      <section className="spectre-review-section">
        <h4>Reconciliation summary</h4>
        <p className="spectre-review-muted">
          <strong>Vendor:</strong> {payload.vendor ? (payload.vendor.operatingName ?? payload.vendor.legalName) : "Unresolved"}
        </p>
        <dl className="spectre-review-facts">
          <div className="spectre-review-fact"><dt>Statement date</dt><dd>{sum.statementDate?.slice(0, 10) ?? "—"}</dd></div>
          <div className="spectre-review-fact"><dt>Opening</dt><dd>{sum.currency} {sum.openingBalance}</dd></div>
          <div className="spectre-review-fact spectre-review-fact--strong"><dt>Closing</dt><dd>{sum.currency} {sum.closingBalance}</dd></div>
          <div className="spectre-review-fact"><dt>State</dt><dd>{sum.reconciliationState}</dd></div>
        </dl>
        <div className="spectre-review-doc-actions">
          <button
            type="button"
            className="spectre-btn spectre-btn--sm spectre-btn--primary"
            onClick={() => onOpenPdf(payload.document.id, payload.document.filename)}
            data-testid="unified-statement-view-pdf"
          >
            View statement PDF
          </button>
        </div>
      </section>
    </div>
  );
}
