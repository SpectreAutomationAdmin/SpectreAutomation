"use client";

// Sprint 2 Checkpoint 14C (2026-07-23) — Mission Control email-derived
// Work Intake card with inline expansion.
//
// Design revision from C14B (per founder review):
//   1. Removed "Open detail" — the card must not navigate away.
//      Mission Control is the primary work surface.
//   2. Removed the raw email-body preview. The card renders a
//      structured operational synopsis composed by the deterministic
//      invoice-analysis pipeline. Every finding is grounded in real
//      data — no fabricated invoices, vendors, GST, or GL accounts.
//   3. Card actions carry crisp Spectre icons (mail / reply / edit).
//   4. Expanded panel shows the FULL conversation newest-first (not
//      just one email). No "Open in Outlook on the web" exit.
//   5. Reply composer sends a real reply in Phase 14C-B if the
//      Mail.Send scope has been consented. Fail-closed until then.
//
// The card is a natural extension of the existing Mission Control
// anatomy. It does not look like Outlook embedded inside Spectre.

import { useCallback, useEffect, useState } from "react";
import InlineConversationPanel, { type ConversationDetail } from "./InlineConversationPanel";
import ReplyComposer, { type ReplyComposerConsentState } from "./ReplyComposer";
import { IconMail, IconReply, IconEdit, IconClock, IconCheck, IconUserPlus, IconSend } from "@/components/spectre/icons";
import DocumentPreviewModal from "./DocumentPreviewModal";

export interface EmailFeedCardData {
  workIntakeItemId: string;
  emailMessageId: string;
  state: "judgment" | "info" | "comm";
  idTag: string;
  situationTitle: string;
  contextLine: string;
  timestampLabel: string;
  synopsisText: string;
  evidence: Array<{
    label: string;
    value: string;
    state: "found" | "ambiguous" | "not_found" | "not_extracted" | "extracted" | "duplicate" | "no_data";
  }>;
  recommendation?: string;
  isUnread: boolean;
  isHighImportance: boolean;
  conversationMessageCount: number;
  actions: Array<{
    key: string;
    label: string;
    kind: "primary" | "secondary" | "tertiary";
    iconKey?: "mail" | "reply" | "edit" | "clock" | "check" | "user-plus" | "send";
    disabledReason?: string;
    onClickAction?: "expand-view" | "expand-reply" | "expand-both";
  }>;
  // Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
  // Attached intelligence facets from AP/Statement child intakes that
  // originated from the same inbound email. When present, the card
  // renders tabs (Conversation | Attachments | Invoice Review |
  // Statement Review | Activity) instead of the collapsed synopsis-only
  // view — one card per inbound conversation.
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

interface Props {
  data: EmailFeedCardData;
}

// Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
// Tab-based expansion. When the email carries linkedIntelligence
// facets, the expansion switches to a tabbed layout. Legacy
// "view"/"reply" modes still work when there's no attached
// accounting content.
type ExpandMode = "collapsed" | "view" | "reply";
type Tab = "conversation" | "attachments" | "invoice" | "statement" | "activity";

const PILL_LABEL: Record<EmailFeedCardData["state"], string> = {
  judgment: "Needs judgment",
  info: "Informational",
  comm: "Communication required",
};

const EVIDENCE_STATE_CLASS: Record<EmailFeedCardData["evidence"][number]["state"], string> = {
  found: "found",
  ambiguous: "ambiguous",
  not_found: "not-found",
  not_extracted: "not-extracted",
  extracted: "extracted",
  duplicate: "duplicate",
  no_data: "no-data",
};

export default function EmailIntakeCard({ data }: Props) {
  const [mode, setMode] = useState<ExpandMode>("collapsed");
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sprint 3 Checkpoint 15H Unified Remediation state.
  const linked = data.linkedIntelligence;
  const hasInvoice = (linked?.invoiceAttachmentCount ?? 0) > 0;
  const hasStatement = (linked?.statementAttachmentCount ?? 0) > 0;
  const hasAnyAttachment = (linked?.attachmentCount ?? 0) > 0;
  const useTabbedLayout = !!linked && (hasInvoice || hasStatement || linked.attachmentCount > 0);
  const defaultTab: Tab = hasInvoice ? "invoice" : hasStatement ? "statement" : "conversation";
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [pdfModal, setPdfModal] = useState<null | { documentId: string; filename: string }>(null);
  const [apEvidence, setApEvidence] = useState<unknown | null>(null);
  const [statementEvidence, setStatementEvidence] = useState<unknown | null>(null);
  const [attachments, setAttachments] = useState<Array<{ id: string; filename: string; mimeType: string; byteLength: number; classification: string; receivedAt: string }> | null>(null);

  useEffect(() => {
    // Reset the default tab if the linked facets change (e.g. an
    // analysis completes after the first render).
    if (mode === "collapsed") setTab(defaultTab);
  }, [defaultTab, mode]);

  const loadDetailOnce = useCallback(async () => {
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

  const handleExpand = useCallback(
    (target: "view" | "reply") => {
      setMode(target);
      void loadDetailOnce();
    },
    [loadDetailOnce],
  );
  const handleCollapse = useCallback(() => { setMode("collapsed"); }, []);

  const accentClass = data.isUnread ? " spectre-mc-item--unread" : "";

  return (
    <article
      className={`spectre-mc-item ${data.state}${accentClass}`}
      data-testid="email-intake-card"
      data-work-intake-item-id={data.workIntakeItemId}
      data-email-id={data.emailMessageId}
    >
      <div className="spectre-mc-item-head">
        <span
          className={`spectre-mc-worktype spectre-mc-worktype--${worktypeSlug(linked)}`}
          data-testid="worktype-eyebrow"
        >
          {worktypeLabel(linked)}
        </span>
        <span className={`spectre-mc-pill ${data.state}`}>{PILL_LABEL[data.state]}</span>
        <span className="spectre-mc-id-tag">{data.idTag}</span>
        {data.isHighImportance ? (
          <span className="spectre-mc-flag" data-testid="email-importance-high" title="High importance in the source mailbox">
            High importance
          </span>
        ) : null}
        {data.isUnread ? (
          <span className="spectre-mc-pill-unread" data-testid="email-unread">Unread</span>
        ) : null}
        {data.conversationMessageCount > 1 ? (
          <span className="spectre-mc-convo-count" data-testid="email-convo-count">
            {data.conversationMessageCount} messages
          </span>
        ) : null}
        <span className="spectre-mc-ts">{data.timestampLabel}</span>
      </div>

      <h3>{data.situationTitle}</h3>

      <div className="spectre-mc-sender">
        <span className="from">{data.contextLine}</span>
      </div>

      {/* Sprint 2 Checkpoint 14C — structured operational synopsis in
          place of the raw email preview. */}
      <p className="spectre-mc-synopsis" data-testid="email-synopsis">{data.synopsisText}</p>

      {data.evidence && data.evidence.length > 0 ? (
        <div className="spectre-mc-evidence" data-testid="email-evidence">
          {data.evidence.map((cell) => (
            <div key={cell.label} className={`cell state-${EVIDENCE_STATE_CLASS[cell.state]}`} data-testid={`evidence-${cell.label.toLowerCase().replace(/\s+/g, "-")}`}>
              <div className="k">{cell.label}</div>
              <div className="v">{cell.value}</div>
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

      <div className="spectre-mc-actions">
        {mode === "collapsed" ? (
          <>
            {useTabbedLayout ? (
              <button
                type="button"
                className="spectre-btn spectre-btn--primary"
                onClick={() => handleExpand("view")}
                data-testid="unified-open-review"
              >
                Open review
              </button>
            ) : null}
            {useTabbedLayout && hasAnyAttachment ? (
              <button
                type="button"
                className="spectre-btn spectre-btn--secondary"
                onClick={async () => {
                  await ensureAttachmentsLoaded();
                  // Pick the first attached PDF invoice/statement doc.
                  const first = (attachments ?? []).find((a) =>
                    a.mimeType === "application/pdf" &&
                    (a.classification === "INVOICE" || a.classification === "STATEMENT" || a.classification === "UNKNOWN" || a.classification === "OTHER"),
                  );
                  if (first) setPdfModal({ documentId: first.id, filename: first.filename });
                }}
                data-testid="unified-view-pdf"
              >
                View PDF
              </button>
            ) : null}
            {data.actions.map((a) => (
              <ActionButton key={a.key} action={a} onExpand={handleExpand} />
            ))}
          </>
        ) : (
          <>
            <button
              type="button"
              className="spectre-btn spectre-btn--ghost"
              onClick={handleCollapse}
              data-testid="email-action-collapse"
            >
              Collapse
            </button>
            {mode === "view" && !useTabbedLayout ? (
              <button
                type="button"
                className="spectre-btn spectre-btn--secondary"
                onClick={() => handleExpand("reply")}
                data-testid="email-action-open-composer"
              >
                <IconReply size={12} />
                Review &amp; send reply
              </button>
            ) : null}
            {data.actions
              .filter((a) => a.kind === "tertiary")
              .map((a) => <ActionButton key={a.key} action={a} onExpand={handleExpand} />)}
          </>
        )}
      </div>

      {mode !== "collapsed" ? (
        <div className="spectre-mc-inline-expansion" data-testid="email-inline-expansion">
          {useTabbedLayout ? (
            <>
              <TabBar
                available={tabsFor(linked)}
                active={tab}
                onChange={(t) => {
                  setTab(t);
                  if (t === "conversation" || t === "activity") void loadDetailOnce();
                  if (t === "attachments") void ensureAttachmentsLoaded();
                  if (t === "invoice") void ensureApEvidenceLoaded();
                  if (t === "statement") void ensureStatementEvidenceLoaded();
                }}
              />
              <div className="spectre-mc-unified-body" data-testid="unified-tab-body">
                {tab === "conversation" && (
                  loading ? <div className="spectre-mc-inline-status" role="status">Loading conversation…</div>
                  : error ? <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">Could not load the conversation.</div>
                  : detail ? <InlineConversationPanel detail={detail} />
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
                  loading ? <div className="spectre-mc-inline-status" role="status">Loading activity…</div>
                  : detail ? <p className="spectre-review-muted">See conversation tab for message history. Full activity timeline coming in a follow-up.</p>
                  : null
                )}
              </div>
              {mode === "reply" ? (
                loading ? null : detail ? (
                  <ReplyComposer
                    workIntakeItemId={data.workIntakeItemId}
                    emailMessageId={data.emailMessageId}
                    seedRecommendation={data.recommendation}
                    consentState={detail.replyConsent}
                    onCancel={handleCollapse}
                  />
                ) : null
              ) : null}
            </>
          ) : (
            // Legacy layout for emails with no linked intelligence.
            loading ? (
              <div className="spectre-mc-inline-status" role="status">Loading conversation…</div>
            ) : error ? (
              <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">
                {error === "not_found"
                  ? "The conversation is no longer available."
                  : "Could not load the conversation. Please try again."}
              </div>
            ) : detail ? (
              <>
                <InlineConversationPanel detail={detail} />
                {mode === "reply" ? (
                  <ReplyComposer
                    workIntakeItemId={data.workIntakeItemId}
                    emailMessageId={data.emailMessageId}
                    seedRecommendation={data.recommendation}
                    consentState={detail.replyConsent}
                    onCancel={handleCollapse}
                  />
                ) : null}
              </>
            ) : null
          )}
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

  // ------------------------------------------------------------------
  // Attached-facet fetchers (each fires on first tab activation).
  // ------------------------------------------------------------------
  async function ensureAttachmentsLoaded() {
    if (attachments !== null) return;
    try {
      const res = await fetch(`/api/mission-control/work-intake/${encodeURIComponent(data.workIntakeItemId)}/documents`, { method: "GET" });
      if (!res.ok) { setAttachments([]); return; }
      const body = await res.json();
      setAttachments(body.documents ?? []);
    } catch { setAttachments([]); }
  }
  async function ensureApEvidenceLoaded() {
    if (apEvidence !== null || !linked || linked.apReviewIntakeIds.length === 0) return;
    try {
      const apIntakeId = linked.apReviewIntakeIds[0];
      const res = await fetch(`/api/mission-control/work-intake/${encodeURIComponent(apIntakeId)}/ap-evidence`, { method: "GET" });
      if (!res.ok) { setApEvidence({ error: "load_failed" }); return; }
      setApEvidence(await res.json());
    } catch { setApEvidence({ error: "network" }); }
  }
  async function ensureStatementEvidenceLoaded() {
    if (statementEvidence !== null || !linked || linked.statementReviewIntakeIds.length === 0) return;
    try {
      const stIntakeId = linked.statementReviewIntakeIds[0];
      const res = await fetch(`/api/mission-control/work-intake/${encodeURIComponent(stIntakeId)}/statement-evidence`, { method: "GET" });
      if (!res.ok) { setStatementEvidence({ error: "load_failed" }); return; }
      setStatementEvidence(await res.json());
    } catch { setStatementEvidence({ error: "network" }); }
  }
}

function ActionButton({
  action,
  onExpand,
}: {
  action: EmailFeedCardData["actions"][number];
  onExpand: (mode: "view" | "reply") => void;
}) {
  const disabled = !!action.disabledReason;
  const handleClick = () => {
    if (disabled) return;
    if (action.onClickAction === "expand-view") { onExpand("view"); return; }
    if (action.onClickAction === "expand-reply") { onExpand("reply"); return; }
  };
  const className =
    action.kind === "primary" ? "spectre-btn spectre-btn--primary" :
    action.kind === "secondary" ? "spectre-btn spectre-btn--secondary" :
    "spectre-btn spectre-btn--ghost";
  return (
    <button
      type="button"
      className={disabled ? `${className} spectre-btn--disabled` : className}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      title={action.disabledReason}
      onClick={handleClick}
      data-testid={`email-action-${action.key}`}
    >
      <ActionIcon iconKey={action.iconKey} />
      {action.label}
    </button>
  );
}

function ActionIcon({ iconKey }: { iconKey?: EmailFeedCardData["actions"][number]["iconKey"] }) {
  switch (iconKey) {
    case "mail":      return <IconMail size={12} />;
    case "reply":     return <IconReply size={12} />;
    case "edit":      return <IconEdit size={12} />;
    case "clock":     return <IconClock size={12} />;
    case "check":     return <IconCheck size={12} />;
    case "user-plus": return <IconUserPlus size={12} />;
    case "send":      return <IconSend size={12} />;
    default:          return null;
  }
}

// ---------------------------------------------------------------------------
// Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) — helpers
// ---------------------------------------------------------------------------
type LinkedIntel = EmailFeedCardData["linkedIntelligence"];

function worktypeSlug(linked: LinkedIntel | undefined): string {
  const f = linked?.dominantFacet ?? "email";
  return f === "invoice" ? "ap-invoice"
    : f === "statement" ? "vendor-statement"
    : f === "invoice+statement" ? "ap-invoice"
    : "email";
}
function worktypeLabel(linked: LinkedIntel | undefined): string {
  const f = linked?.dominantFacet ?? "email";
  return f === "invoice" ? "EMAIL · AP INVOICE"
    : f === "statement" ? "EMAIL · VENDOR STATEMENT"
    : f === "invoice+statement" ? "EMAIL · AP INVOICE + STATEMENT"
    : "EMAIL CORRESPONDENCE";
}
function tabsFor(linked: LinkedIntel | undefined): Tab[] {
  const tabs: Tab[] = ["conversation"];
  if ((linked?.attachmentCount ?? 0) > 0) tabs.push("attachments");
  if ((linked?.invoiceAttachmentCount ?? 0) > 0) tabs.push("invoice");
  if ((linked?.statementAttachmentCount ?? 0) > 0) tabs.push("statement");
  tabs.push("activity");
  return tabs;
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
          onClick={() => onChange(t)}
          data-testid={`unified-tab-${t}`}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}

// Minimal typed shapes for the two evidence payloads — kept narrow so
// changes to the API don't cascade.
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
