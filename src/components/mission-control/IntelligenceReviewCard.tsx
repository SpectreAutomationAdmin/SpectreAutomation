"use client";
// Sprint 3 Checkpoint 15H (2026-07-25) — Mission Control review card
// for the two document-driven review situations:
//   * AP_INVOICE_REVIEW      — AP invoice reviewer pane
//   * VENDOR_STATEMENT_REVIEW — vendor statement reconciliation pane
//
// Follows the C14B/C14C inline-expansion pattern from EmailIntakeCard:
//   collapsed → click "Open review" → expanded with fetched evidence
// All actions POST to the C15E/C15G closed-enum endpoints.
// Storage keys and bank details are never rendered — the API omits them.

import Link from "next/link";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkItem } from "@/lib/mission-control";

type ClassificationKind = "AP_INVOICE_REVIEW" | "VENDOR_STATEMENT_REVIEW";

interface Props {
  data: WorkItem;
  kind: ClassificationKind;
}

const PILL_LABEL: Record<string, string> = {
  approval: "Needs review",
  info: "Informational",
  urgent: "Urgent",
  scheduled: "Scheduled",
};

// ---------------------------------------------------------------------------
// Fetched shapes — narrow types matching the C15E / C15G API payloads.
// ---------------------------------------------------------------------------
interface ApEvidencePayload {
  intake: { id: string; title: string | null; status: string; lastAnalysedAt: string | null; ruleSource: string };
  document: {
    id: string; filename: string; mimeType: string; byteLength: number; sha256Hash: string;
    receivedAt: string; ingestedAt: string; classification: string;
    previewUrl: string; downloadUrl: string; metadataUrl: string;
  };
  extraction: {
    state: string;
    invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null;
    purchaseOrder: string | null; description: string | null; currency: string | null;
    subtotal: string | null; taxTotal: string | null; total: string | null;
    lineItemCount: number; warnings: string[];
    vendor: { guessedName: string | null; guessedEmail: string | null };
  };
  vendorResolution: {
    state: string;
    candidates: Array<{ id: string; legalName: string; operatingName: string | null; matchSignals: string[] }>;
  };
  reconciliation: {
    state: string;
    matchedApInvoiceId: string | null;
    matchedApInvoice: null | { id: string; invoiceNumber: string; vendorReference: string | null; total: string; status: string; vendor: { legalName: string } };
    findings: Array<{ key: string; severity: string; statement: string; ruleKey: string; apInvoiceId?: string }>;
  };
  capitalRecommendation: {
    state: string; capitalClass: string | null; reasoning: string; supportingEvidence: string[];
  };
  glRecommendation: {
    accountNumber: string | null; accountName: string | null; reason: string; source: string;
  };
  persistedFindings: Array<{ id: string; key: string; statement: string; severity: string; state: string }>;
  availableActions: Record<string, boolean>;
  postingActionAvailable: boolean;
  postingActionReason: string;
}

interface StatementEvidencePayload {
  intake: { id: string; title: string | null; status: string; lastAnalysedAt: string | null; ruleSource: string };
  document: ApEvidencePayload["document"];
  vendor: null | { id: string; legalName: string; operatingName: string | null };
  statementSummary: {
    statementDate: string | null; periodStart: string | null; periodEnd: string | null;
    openingBalance: string; closingBalance: string; amountDue: string;
    spectreBalanceAsOfStatementDate: string | null;
    netDifference: string | null;
    currency: string; extractionState: string; reconciliationState: string;
  };
  lines: Array<{
    id: string; sequence: number;
    transactionDate: string | null; referenceNumber: string | null; description: string | null;
    transactionKind: string;
    debitAmount: string; creditAmount: string; runningBalance: string | null;
    matches: Array<{
      id: string; targetKind: string; targetReferenceId: string | null;
      matchState: string; amountDifference: string | null; dateDifferenceDays: number | null;
      reviewerDecision: null | { decision?: string; note?: string };
    }>;
  }>;
  findings: Array<{ id: string; key: string; statement: string; severity: string; state: string }>;
  availableActions: string[];
  autoActionAvailable: boolean;
  autoActionReason: string;
}

// ---------------------------------------------------------------------------
export default function IntelligenceReviewCard({ data, kind }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apPayload, setApPayload] = useState<ApEvidencePayload | null>(null);
  const [stmtPayload, setStmtPayload] = useState<StatementEvidencePayload | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<null | { tone: "success" | "error"; text: string }>(null);
  const workIntakeItemId = data.workIntakeItemId ?? data.id;

  const loadOnce = useCallback(async () => {
    if ((kind === "AP_INVOICE_REVIEW" && apPayload) || (kind === "VENDOR_STATEMENT_REVIEW" && stmtPayload) || loading) return;
    setLoading(true);
    setError(null);
    try {
      const url = kind === "AP_INVOICE_REVIEW"
        ? `/api/mission-control/work-intake/${encodeURIComponent(workIntakeItemId)}/ap-evidence`
        : `/api/mission-control/work-intake/${encodeURIComponent(workIntakeItemId)}/statement-evidence`;
      const res = await fetch(url, { method: "GET" });
      if (res.status === 401) { setError("unauthenticated"); return; }
      if (res.status === 404) { setError("not_found"); return; }
      if (!res.ok) { setError("load_failed"); return; }
      const body = await res.json();
      if (kind === "AP_INVOICE_REVIEW") setApPayload(body as ApEvidencePayload);
      else setStmtPayload(body as StatementEvidencePayload);
    } catch {
      setError("load_failed");
    } finally {
      setLoading(false);
    }
  }, [workIntakeItemId, kind, apPayload, stmtPayload, loading]);

  const handleOpen = useCallback(() => {
    setExpanded(true);
    void loadOnce();
  }, [loadOnce]);
  const handleCollapse = useCallback(() => setExpanded(false), []);

  const runAction = useCallback(
    async (actionKind: string, notes?: string, payload?: Record<string, unknown>) => {
      setActionInFlight(actionKind);
      setActionBanner(null);
      try {
        const url = kind === "AP_INVOICE_REVIEW"
          ? `/api/mission-control/work-intake/${encodeURIComponent(workIntakeItemId)}/ap-actions`
          : `/api/mission-control/work-intake/${encodeURIComponent(workIntakeItemId)}/statement-actions`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: actionKind, notes, payload }),
        });
        if (res.status === 401) { setActionBanner({ tone: "error", text: "Session expired — please sign in again." }); return; }
        if (res.status === 404) { setActionBanner({ tone: "error", text: "The intake was not found in your active club." }); return; }
        if (!res.ok) { setActionBanner({ tone: "error", text: `Action failed (HTTP ${res.status}).` }); return; }
        setActionBanner({ tone: "success", text: `Recorded: ${actionKind}` });
        // Force a re-fetch so the pane reflects reviewer decisions.
        if (kind === "AP_INVOICE_REVIEW") setApPayload(null); else setStmtPayload(null);
        await loadOnce();
        router.refresh();
      } catch {
        setActionBanner({ tone: "error", text: "Network error — action not recorded." });
      } finally {
        setActionInFlight(null);
      }
    },
    [workIntakeItemId, kind, loadOnce, router],
  );

  return (
    <article
      className={`spectre-mc-item ${data.state}`}
      data-testid={kind === "AP_INVOICE_REVIEW" ? "ap-review-card" : "statement-review-card"}
      data-work-intake-item-id={workIntakeItemId}
    >
      <div className="spectre-mc-item-head">
        <span className={`spectre-mc-worktype spectre-mc-worktype--${kind === "AP_INVOICE_REVIEW" ? "ap-invoice" : "vendor-statement"}`} data-testid="worktype-eyebrow">
          {kind === "AP_INVOICE_REVIEW" ? "AP INVOICE" : "VENDOR STATEMENT"}
        </span>
        <span className={`spectre-mc-pill ${data.state}`}>{PILL_LABEL[data.state] ?? data.state}</span>
        <span className="spectre-mc-id-tag">{data.idTag}</span>
        <span className="spectre-mc-ts">{data.timestampLabel}</span>
      </div>
      <h3>{data.title}</h3>
      <div className="spectre-mc-sender">
        <span className="from">{data.sender.from}</span>
        {data.sender.ctx ? <><span className="sep">·</span><span>{data.sender.ctx}</span></> : null}
      </div>
      {data.synopsisText ? <p className="spectre-mc-synopsis">{data.synopsisText}</p> : null}
      {data.evidence && data.evidence.length > 0 ? (
        <div className="spectre-mc-evidence">
          {data.evidence.map((c) => (
            <div key={c.label} className={`cell state-${c.state ?? "info"}`}>
              <div className="k">{c.label}</div>
              <div className="v">{c.value}</div>
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
        {!expanded ? (
          <>
            <button
              type="button"
              className="spectre-btn spectre-btn--primary"
              onClick={handleOpen}
              data-testid={`${kind.toLowerCase()}-open-review`}
            >
              Open review
            </button>
            <button
              type="button"
              className="spectre-btn spectre-btn--ghost"
              onClick={() => runAction("DEFER_REVIEW")}
              disabled={actionInFlight !== null}
            >
              Defer
            </button>
          </>
        ) : (
          <button
            type="button"
            className="spectre-btn spectre-btn--ghost"
            onClick={handleCollapse}
            data-testid={`${kind.toLowerCase()}-collapse`}
          >
            Collapse
          </button>
        )}
      </div>

      {expanded ? (
        <div className="spectre-mc-inline-expansion" data-testid="review-inline-expansion">
          {actionBanner ? (
            <div
              className={`spectre-mc-inline-status${actionBanner.tone === "error" ? " spectre-mc-inline-status--error" : ""}`}
              role={actionBanner.tone === "error" ? "alert" : "status"}
            >
              {actionBanner.text}
            </div>
          ) : null}
          {loading ? (
            <div className="spectre-mc-inline-status" role="status">Loading review evidence…</div>
          ) : error ? (
            <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">
              {error === "not_found" ? "This review is no longer available."
               : error === "unauthenticated" ? "Session expired — please sign in again."
               : "Could not load review evidence. Please try again."}
            </div>
          ) : kind === "AP_INVOICE_REVIEW" && apPayload ? (
            <ApReviewPane payload={apPayload} onAction={runAction} actionInFlight={actionInFlight} />
          ) : kind === "VENDOR_STATEMENT_REVIEW" && stmtPayload ? (
            <StatementReviewPane payload={stmtPayload} onAction={runAction} actionInFlight={actionInFlight} />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// AP Invoice Review pane
// ---------------------------------------------------------------------------
function ApReviewPane({
  payload,
  onAction,
  actionInFlight,
}: {
  payload: ApEvidencePayload;
  onAction: (kind: string, notes?: string, payload?: Record<string, unknown>) => Promise<void>;
  actionInFlight: string | null;
}) {
  const isCapital = payload.capitalRecommendation.state === "CAPITAL";
  const isOperating = payload.capitalRecommendation.state === "OPERATING";
  const glIsBalanceSheet = !!payload.glRecommendation.accountNumber && /^1[0-9]{3}$/.test(payload.glRecommendation.accountNumber);

  return (
    <div className="spectre-review-pane" data-testid="ap-review-pane">
      <DocumentPanel doc={payload.document} />
      <section className="spectre-review-section">
        <h4>Extracted invoice facts</h4>
        <dl className="spectre-review-facts">
          <FactRow k="Vendor guess" v={payload.extraction.vendor.guessedName ?? "—"} />
          <FactRow k="Invoice #" v={payload.extraction.invoiceNumber ?? "—"} />
          <FactRow k="Invoice date" v={payload.extraction.invoiceDate ?? "—"} />
          <FactRow k="Due date" v={payload.extraction.dueDate ?? "—"} />
          <FactRow k="Purchase order" v={payload.extraction.purchaseOrder ?? "—"} />
          <FactRow k="Subtotal" v={payload.extraction.subtotal ? `${payload.extraction.currency ?? "CAD"} ${payload.extraction.subtotal}` : "—"} />
          <FactRow k="Tax" v={payload.extraction.taxTotal ? `${payload.extraction.currency ?? "CAD"} ${payload.extraction.taxTotal}` : "—"} />
          <FactRow k="Total" v={payload.extraction.total ? `${payload.extraction.currency ?? "CAD"} ${payload.extraction.total}` : "—"} tone="strong" />
          <FactRow k="Line items" v={String(payload.extraction.lineItemCount)} />
          <FactRow k="Extraction state" v={payload.extraction.state} tone={payload.extraction.state === "STRUCTURED" ? "ok" : "warn"} />
        </dl>
        {payload.extraction.warnings.length > 0 ? (
          <div className="spectre-review-warnings" role="note">
            <strong>Extraction warnings</strong>
            <ul>{payload.extraction.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        ) : null}
      </section>

      <section className="spectre-review-section">
        <h4>Vendor resolution</h4>
        <p><strong>{payload.vendorResolution.state}</strong></p>
        {payload.vendorResolution.candidates.length > 0 ? (
          <ul className="spectre-review-list">
            {payload.vendorResolution.candidates.map((c) => (
              <li key={c.id}>
                {c.operatingName ?? c.legalName}
                <span className="spectre-review-muted"> · signals: {c.matchSignals.join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : <p className="spectre-review-muted">No candidate vendor could be resolved from the extracted invoice.</p>}
      </section>

      <section className="spectre-review-section">
        <h4>AP reconciliation</h4>
        <p><strong>{payload.reconciliation.state}</strong></p>
        {payload.reconciliation.matchedApInvoice ? (
          <p>Matched: <Link href={`/app/admin/ap/invoices/${payload.reconciliation.matchedApInvoice.id}`}>{payload.reconciliation.matchedApInvoice.invoiceNumber}</Link> — {payload.reconciliation.matchedApInvoice.vendor.legalName} — CAD {payload.reconciliation.matchedApInvoice.total}</p>
        ) : null}
        {payload.reconciliation.findings.length > 0 ? (
          <ul className="spectre-review-list">
            {payload.reconciliation.findings.map((f, i) => (
              <li key={i}><span className={`spectre-review-sev spectre-review-sev--${f.severity.toLowerCase()}`}>{f.severity}</span> {f.statement}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="spectre-review-section">
        <h4>Capital vs Operating</h4>
        <p className={`spectre-review-verdict spectre-review-verdict--${payload.capitalRecommendation.state.toLowerCase()}`}>
          <strong>{payload.capitalRecommendation.state}</strong>
          {payload.capitalRecommendation.capitalClass ? <span> · {payload.capitalRecommendation.capitalClass.replace(/_/g, " ")}</span> : null}
        </p>
        <p className="spectre-review-reason">{payload.capitalRecommendation.reasoning}</p>
        {payload.capitalRecommendation.supportingEvidence.length > 0 ? (
          <ul className="spectre-review-list">
            {payload.capitalRecommendation.supportingEvidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        ) : null}
      </section>

      <section className="spectre-review-section">
        <h4>GL recommendation</h4>
        {payload.glRecommendation.accountNumber ? (
          <>
            <p><strong>{payload.glRecommendation.accountNumber}</strong> — {payload.glRecommendation.accountName ?? "—"}</p>
            {glIsBalanceSheet ? (
              <p className="spectre-review-hint" role="note">
                <strong>Balance Sheet asset account.</strong> Capitalisation is determined by the accounting policy + line
                classification (isCapital), not by <code>fundApplicability</code>.
              </p>
            ) : null}
            <p className="spectre-review-muted">Source: {payload.glRecommendation.source}. {payload.glRecommendation.reason}</p>
          </>
        ) : <p className="spectre-review-muted">No GL account could be recommended. {payload.glRecommendation.reason}</p>}
      </section>

      <ActionRow
        actions={[
          { key: "APPROVE_EXTRACTION", label: "Approve extraction", kind: "primary" },
          { key: "REJECT_EXTRACTION", label: "Reject extraction", kind: "secondary" },
          { key: "CORRECT_VENDOR", label: "Correct vendor", kind: "secondary", disabled: !payload.availableActions.correctVendor },
          { key: "CORRECT_GL_ACCOUNT", label: "Correct GL", kind: "secondary", disabled: !payload.availableActions.correctGl },
          { key: isCapital ? "MARK_OPERATING" : "MARK_CAPITAL", label: isCapital ? "Mark operating" : "Mark capital", kind: "secondary", disabled: isCapital ? !payload.availableActions.markOperating : !payload.availableActions.markCapital },
          { key: "ATTACH_TO_EXISTING_INVOICE", label: "Attach to existing invoice", kind: "ghost", disabled: !payload.availableActions.attachToExistingApInvoice },
          { key: "CREATE_DRAFT_INVOICE", label: "Create AP invoice draft", kind: "ghost", disabled: !payload.availableActions.createDraftApInvoice },
        ]}
        onAction={onAction}
        actionInFlight={actionInFlight}
      />
      <p className="spectre-review-muted" role="note">{payload.postingActionReason}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor Statement Review pane
// ---------------------------------------------------------------------------
function StatementReviewPane({
  payload,
  onAction,
  actionInFlight,
}: {
  payload: StatementEvidencePayload;
  onAction: (kind: string, notes?: string, payload?: Record<string, unknown>) => Promise<void>;
  actionInFlight: string | null;
}) {
  const [filter, setFilter] = useState<"all" | "exceptions" | "missing" | "payments" | "credits" | "duplicates" | "timing" | "unknown">("all");
  const sum = payload.statementSummary;
  const dominantDiffCents = sum.netDifference ? Math.round(Number(sum.netDifference) * 100) : null;

  const filteredLines = payload.lines.filter((line) => {
    if (filter === "all") return true;
    const state = line.matches[0]?.matchState ?? "";
    if (filter === "exceptions") return state !== "EXACT_MATCH" && state !== "PROBABLE_MATCH";
    if (filter === "missing") return state === "NOT_FOUND" || state === "PAYMENT_NOT_FOUND" || state === "CREDIT_NOT_FOUND";
    if (filter === "payments") return line.transactionKind === "PAYMENT";
    if (filter === "credits") return line.transactionKind === "CREDIT_NOTE" || state.startsWith("CREDIT");
    if (filter === "duplicates") return state === "DUPLICATE_LEDGER_ENTRY" || state === "DUPLICATE_STATEMENT_LINE";
    if (filter === "timing") return state === "DATE_MISMATCH" || state === "PAYMENT_DATE_MISMATCH";
    if (filter === "unknown") return line.transactionKind === "UNKNOWN" || line.transactionKind === "OTHER";
    return true;
  });

  return (
    <div className="spectre-review-pane" data-testid="statement-review-pane">
      <DocumentPanel doc={payload.document} />
      <section className="spectre-review-section">
        <h4>Reconciliation summary</h4>
        <dl className="spectre-review-facts">
          <FactRow k="Vendor" v={payload.vendor ? (payload.vendor.operatingName ?? payload.vendor.legalName) : "Unresolved"} tone={payload.vendor ? undefined : "warn"} />
          <FactRow k="Statement date" v={sum.statementDate?.slice(0, 10) ?? "—"} />
          <FactRow k="Period" v={sum.periodStart && sum.periodEnd ? `${sum.periodStart.slice(0, 10)} → ${sum.periodEnd.slice(0, 10)}` : "—"} />
          <FactRow k="Opening balance" v={`${sum.currency} ${sum.openingBalance}`} />
          <FactRow k="Closing balance" v={`${sum.currency} ${sum.closingBalance}`} tone="strong" />
          <FactRow k="Amount due" v={`${sum.currency} ${sum.amountDue}`} />
          <FactRow k="Spectre balance (statement date)" v={sum.spectreBalanceAsOfStatementDate ? `${sum.currency} ${sum.spectreBalanceAsOfStatementDate}` : "n/a"} />
          <FactRow k="Net difference" v={sum.netDifference ?? "n/a"} tone={dominantDiffCents !== null && Math.abs(dominantDiffCents) > 2 ? "warn" : "ok"} />
          <FactRow k="Extraction" v={sum.extractionState} tone={sum.extractionState === "STRUCTURED" ? "ok" : "warn"} />
          <FactRow k="Reconciliation" v={sum.reconciliationState} tone={sum.reconciliationState === "RECONCILED" ? "ok" : "warn"} />
        </dl>
      </section>

      <section className="spectre-review-section" data-testid="statement-line-filters">
        <h4>Reconciliation table</h4>
        <div className="spectre-review-filters" role="tablist">
          {(["all", "exceptions", "missing", "payments", "credits", "duplicates", "timing", "unknown"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={`spectre-btn spectre-btn--sm ${filter === k ? "spectre-btn--primary" : "spectre-btn--ghost"}`}
              data-testid={`statement-filter-${k}`}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="spectre-review-table-wrap">
          <table className="spectre-review-table" data-testid="statement-lines-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Date</th>
                <th scope="col">Reference</th>
                <th scope="col">Description</th>
                <th scope="col" style={{ textAlign: "right" }}>Debit</th>
                <th scope="col" style={{ textAlign: "right" }}>Credit</th>
                <th scope="col">Kind</th>
                <th scope="col">Match</th>
                <th scope="col" style={{ textAlign: "right" }}>Diff</th>
              </tr>
            </thead>
            <tbody>
              {filteredLines.map((line) => {
                const match = line.matches[0];
                const decisionText = match?.reviewerDecision?.decision ? ` (${match.reviewerDecision.decision})` : "";
                return (
                  <tr key={line.id} data-line-sequence={line.sequence} data-testid={`statement-line-${line.sequence}`}>
                    <td>{line.sequence}</td>
                    <td>{line.transactionDate?.slice(0, 10) ?? "—"}</td>
                    <td>{line.referenceNumber ?? "—"}</td>
                    <td>{line.description ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{line.debitAmount !== "0" ? line.debitAmount : ""}</td>
                    <td style={{ textAlign: "right" }}>{line.creditAmount !== "0" ? line.creditAmount : ""}</td>
                    <td>{line.transactionKind}</td>
                    <td>{match ? `${match.matchState}${decisionText}` : "—"}</td>
                    <td style={{ textAlign: "right" }}>{match?.amountDifference ?? ""}</td>
                  </tr>
                );
              })}
              {filteredLines.length === 0 ? (
                <tr><td colSpan={9} className="spectre-review-muted">No lines match this filter.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="spectre-review-section">
        <h4>Exceptions ({payload.findings.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL").length})</h4>
        <ul className="spectre-review-list">
          {payload.findings.map((f) => (
            <li key={f.id} data-testid={`finding-${f.key}`}>
              <span className={`spectre-review-sev spectre-review-sev--${f.severity.toLowerCase()}`}>{f.severity}</span>{" "}
              {f.statement}
              {f.state === "USER_REJECTED" ? <em className="spectre-review-muted"> · rejected by reviewer</em> : null}
            </li>
          ))}
        </ul>
      </section>

      <ActionRow
        actions={payload.availableActions.map((k) => ({
          key: k,
          label: k.replace(/_/g, " ").toLowerCase(),
          kind: k === "RESOLVE_RECONCILIATION" ? "primary" : k.startsWith("MARK_") || k === "DEFER_REVIEW" ? "ghost" : "secondary",
        }))}
        onAction={onAction}
        actionInFlight={actionInFlight}
      />
      <p className="spectre-review-muted" role="note">{payload.autoActionReason}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function DocumentPanel({ doc }: { doc: { id: string; filename: string; mimeType: string; byteLength: number; sha256Hash: string; receivedAt: string; ingestedAt: string; previewUrl: string; downloadUrl: string } }) {
  return (
    <section className="spectre-review-section spectre-review-doc" data-testid="review-doc-panel">
      <h4>Document</h4>
      <dl className="spectre-review-facts spectre-review-facts--tight">
        <FactRow k="Filename" v={doc.filename} />
        <FactRow k="Type" v={doc.mimeType} />
        <FactRow k="Size" v={`${Math.round(doc.byteLength / 1024)} KB`} />
        <FactRow k="Received" v={doc.receivedAt.slice(0, 10)} />
        <FactRow k="SHA-256 (last 8)" v={doc.sha256Hash.slice(-8)} />
      </dl>
      <div className="spectre-review-doc-actions">
        <a href={doc.downloadUrl} className="spectre-btn spectre-btn--secondary" download={doc.filename} data-testid="review-doc-download">Download</a>
      </div>
      <div className="spectre-review-doc-preview">
        <iframe
          src={doc.previewUrl}
          title={`Preview: ${doc.filename}`}
          data-testid="review-doc-preview-iframe"
          sandbox=""
          referrerPolicy="no-referrer"
          style={{ width: "100%", minHeight: 480, border: "1px solid var(--spectre-border-hairline)", borderRadius: "var(--spectre-radius-panel)" }}
          onError={() => { /* browser will show its native error inside iframe */ }}
        />
        <p className="spectre-review-muted" role="note">
          If preview fails to load, use <strong>Download</strong> — findings and reviewer controls remain fully usable.
        </p>
      </div>
    </section>
  );
}

function FactRow({ k, v, tone }: { k: string; v: string; tone?: "ok" | "warn" | "strong" }) {
  return (
    <div className={`spectre-review-fact${tone ? ` spectre-review-fact--${tone}` : ""}`}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

interface ActionSpec { key: string; label: string; kind: "primary" | "secondary" | "ghost"; disabled?: boolean; }

function ActionRow({
  actions,
  onAction,
  actionInFlight,
}: {
  actions: ActionSpec[];
  onAction: (kind: string, notes?: string, payload?: Record<string, unknown>) => Promise<void>;
  actionInFlight: string | null;
}) {
  return (
    <div className="spectre-review-actions spectre-mc-actions" data-testid="review-actions">
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`spectre-btn spectre-btn--${a.kind}`}
          onClick={() => onAction(a.key)}
          disabled={a.disabled || actionInFlight !== null}
          aria-busy={actionInFlight === a.key}
          data-testid={`review-action-${a.key}`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
