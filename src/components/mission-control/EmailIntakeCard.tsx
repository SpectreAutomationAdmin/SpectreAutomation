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
import CreateVendorAndPostModal from "./CreateVendorAndPostModal";
import type { LinkedIntelligenceForEmail, ApInvoiceCardIntelligence } from "@/lib/mission-control";

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
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — typed AP-card
  // projection. The card's Variant D AP body consumes this shape
  // directly instead of the generic email-derived `evidence` array.
  linkedIntelligence?: LinkedIntelligenceForEmail;
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
  // Sprint 3 · Checkpoint 15L — vendor-first modal open state.
  const [cvapModalOpen, setCvapModalOpen] = useState(false);
  // 15P-2: when the AP primary is "Approve & post" (or "Review
  // coding") and the vendor is already matched, we open the same
  // modal directly at Step 2 with the matched vendor preselected.
  // For a new vendor the modal opens at Step 1 as before. Kept as a
  // discriminated shape so the props threaded to the modal are
  // never partially set.
  const [cvapModalMode, setCvapModalMode] = useState<
    | { kind: "STEP_1" }
    | { kind: "STEP_2"; vendorId: string; vendorName: string }
  >({ kind: "STEP_1" });
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
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — AP-mode gate.
  //   `ap` is defined only when the loader projected a real
  //   ApInvoiceCardIntelligence (i.e. the intake has an attached
  //   invoice PDF that the analyser could process). Everything the
  //   AP-mode body renders is projected — no re-parse here.
  const ap: ApInvoiceCardIntelligence | null = linked?.invoiceSummary ?? null;

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

  // Sprint 3 Checkpoint 15I-2 — Defer 24 hr. Uses the existing
  // `defer` action + WorkIntakeItem.deferredUntil. Loader excludes
  // items whose deferredUntil > now from the active feed; the item
  // remains fully preserved and reappears automatically after 24h.
  const [deferring, setDeferring] = useState(false);
  const handleDefer24h = useCallback(async (evt: React.MouseEvent) => {
    evt.stopPropagation();
    if (deferring) return;
    setDeferring(true);
    try {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch("/api/work-intake/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "defer", until }),
      });
      if (res.ok) router.refresh(); else setDeferring(false);
    } catch { setDeferring(false); }
  }, [deferring, data.workIntakeItemId, router]);

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
        {ap
          ? renderApCollapsedBody(data, ap, expanded, () => setCvapModalOpen(true))
          : renderEmailCollapsedBody(data)}
      </div>

      {/* Actions — queue-level (AP mode: primary is the AP workflow
          domain action; Resolve is a secondary overflow). Interior
          clicks stopPropagation so nested buttons never toggle the
          accordion. */}
      <div
        className="spectre-mc-actions"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        {isResolved ? (
          <span className="spectre-mc-aux" data-testid="card-resolved-marker">
            Resolved · in Completed history
          </span>
        ) : ap ? (
          <ApActionRow
            ap={ap}
            workIntakeItemId={data.workIntakeItemId}
            onDefer={handleDefer24h}
            onPrimary={() => {
              // Sprint 3 · Checkpoint 15P-2 — routing for the AP
              // primary action. The founder rule: every actionable
              // workflow state MUST open the shared modal (never
              // "does nothing"); no state posts from the collapsed
              // card without operator review.
              //
              //   VENDOR_MATCH_REQUIRED  → Step 1 (create vendor,
              //                            then Step 2)
              //   READY_FOR_APPROVAL     → Step 2 directly, vendor
              //                            pre-selected from the
              //                            match  (Approve & post)
              //   NEEDS_JUDGMENT         → Step 2 directly (Review
              //                            coding) — same shared
              //                            modal, different starting
              //                            label upstream
              //   POSSIBLE_DUPLICATE     → keep the pre-15L expand
              //                            path (duplicate needs
              //                            evidence review, not
              //                            direct posting)
              //   MISSING_INFORMATION    → expand path for now (email
              //                            reply flow lives on the
              //                            Invoice tab)
              //   CHART_OF_ACCOUNTS_REQUIRED → expand path (guidance
              //                            surface, not postable)
              const openStep2WithMatch = () => {
                const v = ap?.vendorMatch;
                if (!v || !v.matchedVendorId) return false;
                setCvapModalMode({
                  kind: "STEP_2",
                  vendorId: v.matchedVendorId,
                  vendorName: v.matchedName ?? "Selected vendor",
                });
                setCvapModalOpen(true);
                if (!expanded) void markReadOnce();
                return true;
              };
              if (ap?.workflowState === "VENDOR_MATCH_REQUIRED") {
                setCvapModalMode({ kind: "STEP_1" });
                setCvapModalOpen(true);
                if (!expanded) void markReadOnce();
                return;
              }
              if (ap?.workflowState === "READY_FOR_APPROVAL" || ap?.workflowState === "NEEDS_JUDGMENT") {
                if (openStep2WithMatch()) return;
              }
              if (!expanded) {
                setExpanded(true);
                void markReadOnce();
              }
              setTab("invoice");
              void loadApEvidenceOnce();
            }}
            onOpenPdf={ap.primaryAttachment
              ? () => setPdfModal({ documentId: ap.primaryAttachment!.documentId, filename: ap.primaryAttachment!.filename })
              : undefined
            }
          />
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

      {ap ? (
        <CreateVendorAndPostModal
          open={cvapModalOpen}
          onClose={() => {
            setCvapModalOpen(false);
            // Reset mode so the next open (unless explicitly set by
            // a primary-action click) starts at Step 1 again.
            setCvapModalMode({ kind: "STEP_1" });
          }}
          ap={ap}
          workIntakeItemId={data.workIntakeItemId}
          initialStep={cvapModalMode.kind === "STEP_2" ? "AP_CODING" : "PROFILE"}
          preselectedVendorId={cvapModalMode.kind === "STEP_2" ? cvapModalMode.vendorId : undefined}
          preselectedVendorName={cvapModalMode.kind === "STEP_2" ? cvapModalMode.vendorName : undefined}
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

// ---------------------------------------------------------------------------
// Sprint 3 Checkpoint 15I-2 (2026-07-27) — Variant D AP-invoice card body.
//
// This helper renders the collapsed AP-mode body for cards that have a
// linked AP child intake (invoice PDF attached to the email). It renders
// EVERY visible cell from the typed ApInvoiceCardIntelligence projection —
// no re-parse of the PDF, no fallback to email-only heuristics.
//
// Region mapping (Ace Foods reference · variant-d-instrument.html):
//   status pill · id tag · timestamp
//   h3: <Vendor> invoice #<Number> — <Currency Amount> · <Category>
//   sender line: <address> · <cadence> · <terms>
//   work paragraph: accounting-specific narrative
//   4-cell readout: AMOUNT · PO/INVOICE · CATEGORY · CONFIDENCE
//   recommendation strip: workflow-specific action language
//
// Sender identity is provenance only — it NEVER labels the vendor.
// ---------------------------------------------------------------------------

function renderApCollapsedBody(
  data: EmailFeedCardData,
  ap: ApInvoiceCardIntelligence,
  expanded: boolean,
  onOpenCreateVendor: () => void,
) {
  const pill = pillForApWorkflow(ap.workflowState);
  const senderLine = buildApSenderLine(ap);

  return (
    <>
      <div className="spectre-mc-item-head">
        <span className={`spectre-mc-pill ${pill.tone}`} data-testid="ap-workflow-pill">{pill.label}</span>
        <span className="spectre-mc-id-tag">{data.idTag}</span>
        {data.conversationMessageCount > 1 ? (
          <span className="spectre-mc-convo-count" data-testid="email-convo-count">
            {data.conversationMessageCount} messages
          </span>
        ) : null}
        <span className="spectre-mc-ts">{data.timestampLabel}</span>
      </div>

      <h3 id={`title-${data.workIntakeItemId}`} data-testid="ap-title">
        <ApTitle ap={ap} onVendorClick={onOpenCreateVendor} />
      </h3>

      <div className="spectre-mc-sender" data-testid="ap-sender-line">
        <span className="from">{senderLine}</span>
      </div>

      <p className="spectre-mc-work" data-testid="ap-work-summary">
        <ApWorkSummary ap={ap} />
      </p>

      <div className="spectre-mc-readout" data-testid="ap-readout">
        <ReadoutCell k="Amount" v={formatAmountReadout(ap.gross.amount, ap.gross.currency, ap.currencyShowCode !== false)} testid="ap-readout-amount" />
        <ReadoutCell
          k={ap.purchaseOrder.poNumber ? "PO" : "Invoice"}
          v={ap.purchaseOrder.poNumber
            ? `#${ap.purchaseOrder.poNumber}`
            : (ap.invoiceNumber ? `#${ap.invoiceNumber}` : "—")}
          tone={ap.purchaseOrder.poNumber || ap.invoiceNumber ? undefined : "observation"}
          testid="ap-readout-po-or-invoice"
        />
        <ReadoutCell
          k="Category"
          v={ap.category.label ?? "—"}
          tone={ap.category.label ? undefined : "observation"}
          testid="ap-readout-category"
        />
        <ReadoutCell
          k="Confidence"
          v={ap.confidence != null ? `${ap.confidence} %` : "—"}
          tone={
            ap.confidence == null ? "observation"
            : ap.confidence >= 85 ? "confidence"
            : ap.confidence >= 60 ? undefined
            : "observation"
          }
          testid="ap-readout-confidence"
        />
      </div>

      <div className="spectre-mc-rec" data-testid="ap-recommendation">
        <span className="k">Recommended</span>
        <span className="v">{ap.workflowReason}</span>
      </div>
    </>
  );
}

// Fallback renderer — for email-derived cards that do NOT have an AP
// child (member correspondence, informational email, etc.). Preserves
// the pre-15I-2 rendering path unchanged.
function renderEmailCollapsedBody(data: EmailFeedCardData) {
  return (
    <>
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
      <p className="spectre-mc-work" data-testid="email-synopsis">{data.synopsisText}</p>
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
    </>
  );
}

function ReadoutCell({ k, v, tone, testid }: { k: string; v: string; tone?: "observation" | "confidence"; testid?: string }) {
  return (
    <div className="cell" data-testid={testid}>
      <div className="k">{k}</div>
      <div className={`v${tone ? ` ${tone}` : ""}`}>{v}</div>
    </div>
  );
}

// ---- Pill / title / sender / work helpers ---------------------------------

function pillForApWorkflow(state: ApInvoiceCardIntelligence["workflowState"]): { label: string; tone: string } {
  switch (state) {
    case "READY_FOR_APPROVAL":         return { label: "Ready for approval",       tone: "approval" };
    case "VENDOR_MATCH_REQUIRED":      return { label: "Vendor match required",    tone: "judgment" };
    case "MISSING_INFORMATION":        return { label: "Missing information",      tone: "judgment" };
    case "POSSIBLE_DUPLICATE":         return { label: "Possible duplicate",       tone: "judgment" };
    case "CHART_OF_ACCOUNTS_REQUIRED": return { label: "Chart of accounts required", tone: "judgment" };
    case "NEEDS_JUDGMENT":
    default:                           return { label: "Needs judgment",           tone: "judgment" };
  }
}

/**
 * Sprint 3 · Checkpoint 15M — factual title as a React fragment so
 * the vendor name segment can be an anchor. When the vendor exists,
 * it links to the permanent vendor timeline; when the vendor is
 * only extracted (no record yet), it links to the provisional
 * timeline view keyed to the extracted identity + Work Intake id
 * so the pre-creation history survives vendor creation.
 *
 * Only the vendor-name span is interactive — the invoice number,
 * amount, and category are plain text (§Phase 2: "Only Microsoft
 * Corporation should act as the vendor link.").
 *
 * Sprint 3 · Checkpoint 15M currency (Phase 8): amount renders as
 * `$31.29 CAD` (locale-aware symbol + trailing code) via the
 * shared money formatter, not the pre-15M `CAD 31.29` shape.
 */
function ApTitle({
  ap,
  onVendorClick,
}: {
  ap: ApInvoiceCardIntelligence;
  onVendorClick: () => void;
}) {
  const vendorLabel = ap.vendorMatch.matchedName ?? ap.extractedVendor.name;
  const invoiceNumber = ap.invoiceNumber ? `invoice #${ap.invoiceNumber}` : (vendorLabel ? "invoice" : null);
  const amount = ap.gross.amount && ap.gross.currency
    ? formatOperationalMoney(ap.gross.amount, ap.gross.currency, ap.currencyShowCode !== false)
    : null;
  const category = ap.category.label ?? null;

  // Sprint 3 · Checkpoint 15O — vendor-name click behaviour.
  //
  //   MATCHED       → link to /app/admin/ap/vendors/[id]/timeline
  //                    (the real, permanent vendor timeline).
  //   NOT_FOUND / AMBIGUOUS / INSUFFICIENT_SIGNAL
  //                 → button that OPENS the Create Vendor modal.
  //                    No provisional route, no fake vendor entity.
  //                    (§Phase 1 — provisional timeline REMOVED.)
  //
  // The vendor label is always visually emphasised — the linked-vs-
  // action distinction is only in the underlying element.
  if (vendorLabel && ap.vendorMatch.state === "MATCHED" && ap.vendorMatch.matchedVendorId) {
    const href = `/app/admin/ap/vendors/${encodeURIComponent(ap.vendorMatch.matchedVendorId)}/timeline`;
    return (
      <>
        <a
          href={href}
          className="spectre-mc-vendor-link"
          data-testid="ap-title-vendor-link"
          onClick={(e) => e.stopPropagation()}
        >
          {vendorLabel}
        </a>
        {invoiceNumber ? <> {invoiceNumber}</> : null}
        {amount ? <> — {amount}</> : null}
        {category ? <> · {category}</> : null}
      </>
    );
  }
  if (vendorLabel) {
    return (
      <>
        <button
          type="button"
          className="spectre-mc-vendor-link"
          data-testid="ap-title-vendor-button"
          onClick={(e) => { e.stopPropagation(); onVendorClick(); }}
          title="Open Create Vendor — this vendor is not yet on file"
        >
          {vendorLabel}
        </button>
        {invoiceNumber ? <> {invoiceNumber}</> : null}
        {amount ? <> — {amount}</> : null}
        {category ? <> · {category}</> : null}
      </>
    );
  }
  return (
    <>
      AP invoice
      {invoiceNumber ? <> {invoiceNumber}</> : null}
      {amount ? <> — {amount}</> : null}
      {category ? <> · {category}</> : null}
    </>
  );
}

// Sprint 3 · Checkpoint 15M money formatter for operational surfaces
// (Mission Control cards, AP screens, vendor timelines, transaction
// previews). Locale-aware currency symbol + optional trailing ISO
// code. Never used inside the monthly reporting package (which has
// its own bg-club-cream / bg-club-green palette + its own money
// helpers).
function formatOperationalMoney(rawAmount: string, currency: string, showCurrencyCode: boolean): string {
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return `${currency} ${rawAmount}`;
  // For CAD/USD/AUD/NZD — all use `$`. For EUR — €. For GBP — £.
  const localized = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).format(n);
  return showCurrencyCode ? `${localized} ${currency}` : localized;
}

/**
 * Source and relationship line. When the sender is a forwarding
 * employee, clearly label them — never let sender-as-vendor confusion
 * back in.
 */
function buildApSenderLine(ap: ApInvoiceCardIntelligence): string {
  const bits: string[] = [];
  if (ap.sender.relationship === "EMPLOYEE_FORWARD" && ap.sender.email) {
    bits.push(`Forwarded by ${ap.sender.email}`);
    if (ap.extractedVendor.name) bits.push(`PDF vendor: ${ap.extractedVendor.name}`);
  } else if (ap.sender.email) {
    bits.push(ap.sender.email);
  } else if (ap.sender.name) {
    bits.push(ap.sender.name);
  }
  if (ap.invoiceCadenceThisQuarter != null && ap.invoiceCadenceThisQuarter >= 1) {
    bits.push(cadenceLabel(ap.invoiceCadenceThisQuarter));
  }
  if (ap.paymentTerms) bits.push(ap.paymentTerms);
  return bits.join(" · ") || "Accounts payable · pending analysis";
}

function cadenceLabel(n: number): string {
  const ord = ordinal(n);
  return `${ord} invoice this quarter`;
}
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Sprint 3 · Checkpoint 15L — accounting-specific work summary
 * rendered as a React fragment so we can emphasise the Ace Foods
 * reference tokens the founder approved:
 *   • bold "Spectre" attribution at the start
 *   • emphasised gross amount as a chip / ref
 *   • emphasised GL account number+name as a chip / ref
 *   • emphasised PO reference where matched
 *   • emphasised PO variance where present
 *
 * Only mentions work Spectre actually completed. Never invents
 * cadence, never a generic "vendor reports invoice unpaid" line.
 * GST language appears ONLY when the GST rate was verified via the
 * extracted subtotal + tax arithmetic (see ap.gstVerification).
 */
function ApWorkSummary({ ap }: { ap: ApInvoiceCardIntelligence }) {
  const vendor = ap.vendorMatch.matchedName ?? ap.extractedVendor.name ?? "the vendor";
  const grossToken = ap.gross.amount && ap.gross.currency
    ? formatOperationalMoney(ap.gross.amount, ap.gross.currency, ap.currencyShowCode !== false)
    : null;
  const glToken = ap.category.glAccountNumber && ap.category.glAccountName
    ? `GL ${ap.category.glAccountNumber} ${ap.category.glAccountName}`
    : null;

  return (
    <>
      <span className="a" data-testid="ap-work-attribution"><strong>Spectre</strong></span>{" "}
      classified the attached PDF as an invoice and extracted the vendor as {vendor}.
      {ap.invoiceNumber ? <>{" "}Invoice #{ap.invoiceNumber}.</> : null}
      {ap.gstVerification === "VERIFIED" && ap.gstRatePercent != null
        ? <>{" "}Verified GST at {formatRate(ap.gstRatePercent)} %.</>
        : ap.gstVerification === "EXTRACTED_UNVERIFIED"
        ? <>{" "}Tax was extracted from the PDF but the rate could not be reconciled — reviewer must confirm.</>
        : ap.gstVerification === "NOT_PRESENT"
        ? <>{" "}No GST detected on the PDF.</>
        : null}
      {(() => {
        switch (ap.vendorMatch.state) {
          case "MATCHED":
            return <>{" "}Matched to Spectre vendor <strong>{ap.vendorMatch.matchedName}</strong>.</>;
          case "AMBIGUOUS":
            return <>{" "}Multiple Spectre vendor candidates matched — reviewer must select the correct one.</>;
          case "NOT_FOUND":
            return <>{" "}No matching vendor record exists.</>;
          case "INSUFFICIENT_SIGNAL":
            return <>{" "}Vendor match indeterminate — extracted signals were insufficient.</>;
        }
      })()}
      {grossToken && glToken ? (
        <>
          {" "}Prepared a proposed entry to post{" "}
          <span className="ref" data-testid="ap-work-gross-ref"><strong>{grossToken}</strong></span>{" "}
          to <span className="ref" data-testid="ap-work-gl-ref"><strong>{glToken}</strong></span>.
        </>
      ) : glToken ? (
        <>{" "}Draft GL: <span className="ref" data-testid="ap-work-gl-ref"><strong>{glToken}</strong></span>.</>
      ) : ap.category.label ? (
        <>{" "}Recommended category: <strong>{ap.category.label}</strong>.</>
      ) : null}
      {ap.purchaseOrder.poNumber ? (
        <>{" "}Matched to <span className="ref"><strong>PO #{ap.purchaseOrder.poNumber}</strong></span>.
          {ap.purchaseOrder.variance != null
            ? <> Variance from PO: <strong data-testid="ap-work-po-variance">{formatVariance(ap.purchaseOrder.variance, ap.gross.currency ?? "CAD")}</strong>.</>
            : null}
        </>
      ) : (
        <>{" "}No purchase order was identified.</>
      )}
      {ap.paymentTerms
        ? <>{" "}Payment terms: <strong>{ap.paymentTerms}</strong>.</>
        : null}
      {ap.unresolvedFindingCount > 0
        ? <>{" "}<strong>{ap.unresolvedFindingCount}</strong> finding{ap.unresolvedFindingCount === 1 ? "" : "s"} for review.</>
        : null}
    </>
  );
}

function formatRate(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function formatVariance(v: string, currency: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${currency} ${v}`;
  const sign = n === 0 ? "" : n > 0 ? "+" : "";
  return `${sign}${currency} ${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAmountReadout(amount: string | null, currency: string | null, showCurrencyCode: boolean): string {
  if (!amount || !currency) return "—";
  return formatOperationalMoney(amount, currency, showCurrencyCode);
}

function formatDecimal(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- AP action row --------------------------------------------------------
// Primary action is the domain action for the current workflow state.
// Assignment + Defer + attachment aux link follow the Ace Foods layout.

function ApActionRow({
  ap,
  workIntakeItemId,
  onDefer,
  onPrimary,
  onOpenPdf,
}: {
  ap: ApInvoiceCardIntelligence;
  workIntakeItemId: string;
  onDefer: (e: React.MouseEvent) => void;
  onPrimary: () => void;
  onOpenPdf?: () => void;
}) {
  const primary = primaryActionForApWorkflow(ap.workflowState);
  return (
    <>
      <button
        type="button"
        className="spectre-btn spectre-btn--primary spectre-btn--sm"
        data-testid="ap-action-primary"
        data-workflow-state={ap.workflowState}
        // Sprint 3 Checkpoint 15I-2 (2026-07-27) — the primary AP
        // action expands the card and switches directly to the
        // Invoice Review tab where the canonical domain workflow
        // controls live (matched to the founder's brief §3.7:
        // "It is acceptable for the collapsed primary button to
        // expand the card and activate the correct Invoice Review
        // subsection if the final accounting transaction requires
        // a deeper confirmation.").
        //
        // The Invoice Review tab is the same real UI already
        // exercised by Checkpoint 15H — Approve & post, Match
        // vendor, Request information all live there and remain
        // wired to their real server actions.
        onClick={(e) => { e.stopPropagation(); onPrimary(); }}
        aria-label={primary.label}
      >
        {/* Sprint 3 · Checkpoint 15M — inline white icon matching
            the Ace Foods reference. Icon is decorative (label
            carries the action name); rendered with aria-hidden. */}
        <PrimaryActionIcon kind={primary.icon} />
        {primary.label}
      </button>
      {/* Sprint 3 Checkpoint 15I-2 — Assign is a real capability
          on the founder-approved gold standard, but full delegation
          (user picker + tenant-scoped user list + audited ownership
          transition) is scoped to a follow-up ticket. Rather than
          ship a button that does nothing, the control is rendered
          visibly DISABLED with an accessible explanation. Truthful
          omission is better than a false control. */}
      <button
        type="button"
        className="spectre-btn spectre-btn--secondary spectre-btn--sm"
        data-testid="ap-action-assign"
        disabled
        aria-disabled="true"
        title="Assignment to another Spectre user lands in a follow-up ticket. This control is intentionally disabled — click Match vendor or Approve & post above to advance the item."
        onClick={(e) => e.stopPropagation()}
      >
        Assign
      </button>
      <button
        type="button"
        className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
        data-testid="ap-action-defer"
        onClick={onDefer}
      >
        Defer 24 hr
      </button>
      <div className="grow" />
      {onOpenPdf ? (
        <button
          type="button"
          className="spectre-mc-aux-link"
          data-testid="ap-attachment-footer"
          onClick={(e) => { e.stopPropagation(); onOpenPdf(); }}
          title="Open the invoice PDF"
        >
          Invoice · PDF
        </button>
      ) : null}
    </>
  );
}

type PrimaryIconKind = "check" | "vendor-plus" | "envelope" | "document-check" | "duplicate" | "coa";

function primaryActionForApWorkflow(state: ApInvoiceCardIntelligence["workflowState"]):
  { label: string; icon: PrimaryIconKind; onClick?: (ctx: { workIntakeItemId: string }) => void } {
  switch (state) {
    case "READY_FOR_APPROVAL":         return { label: "Approve & post",            icon: "check" };
    // Sprint 3 · Checkpoint 15L — the workflow is vendor-first + AP-
    // second. When the vendor is missing, the primary action reads
    // "Create vendor & post" so the operator knows the modal will
    // (a) let them create the vendor or accept a proposed match,
    // (b) show the drafted GL coding, and (c) still require a final
    // confirmation before posting. The label does NOT bypass any
    // confirmation — it names the end-to-end workflow the button
    // opens, not the immediate side effect. See CreateVendorAndPostModal.
    case "VENDOR_MATCH_REQUIRED":      return { label: "Create vendor & post",      icon: "vendor-plus" };
    case "MISSING_INFORMATION":        return { label: "Request information",       icon: "envelope" };
    case "POSSIBLE_DUPLICATE":         return { label: "Review duplicate",          icon: "duplicate" };
    case "CHART_OF_ACCOUNTS_REQUIRED": return { label: "Import chart of accounts",  icon: "coa" };
    case "NEEDS_JUDGMENT":
    default:                           return { label: "Review coding",             icon: "document-check" };
  }
}

// Sprint 3 · Checkpoint 15M — the small white inline icon that sits
// at the start of every dark-green Work Intake primary action.
// Matches the icon family used by the Variant D reference: stroke
// 2.2, square line caps, currentColor. Sized to match the button
// text (14px). aria-hidden — the label carries the semantic action.
function PrimaryActionIcon({ kind }: { kind: PrimaryIconKind }) {
  const common = {
    className: "spectre-mc-action-icon",
    "aria-hidden": true,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "check":
      return <svg {...common}><path d="M5 12l5 5L20 7" /></svg>;
    case "vendor-plus":
      // Person + small plus — vendor create/onboard glyph.
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M3 20c0-3.5 3-6 6-6s6 2.5 6 6" />
          <path d="M18 6v6M15 9h6" />
        </svg>
      );
    case "envelope":
      return (
        <svg {...common}>
          <path d="M3 6h18v12H3z" />
          <path d="M3 6l9 7 9-7" />
        </svg>
      );
    case "document-check":
      return (
        <svg {...common}>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M9 14l2 2 4-4" />
        </svg>
      );
    case "duplicate":
      return (
        <svg {...common}>
          <path d="M9 4h9v13H9z" />
          <path d="M4 8h9v13H4z" />
        </svg>
      );
    case "coa":
      // Ledger — three horizontal rules inside a book/spine.
      return (
        <svg {...common}>
          <path d="M4 4h14v16H4z" />
          <path d="M8 4v16" />
          <path d="M11 9h5M11 12h5M11 15h5" />
        </svg>
      );
  }
}
