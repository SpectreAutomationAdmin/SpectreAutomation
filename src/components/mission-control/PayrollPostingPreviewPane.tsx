"use client";

// FPP-8 (2026-09-21) — Payroll Posting preview pane (Payroll Admin side).
//
// Renders inside the Mission Control workspace when a
// PAYROLL_READY_TO_POST Work Intake card is selected. Every value is
// bound to `loadPayrollPostingPreview(workIntakeItemId)` — the frozen
// approved evidence. The pane never reads live catalogue data.
//
// Composition mirrors the accepted FPP-6D approval preview:
//   header (icon + title + actions) →
//   status pills →
//   metadata cards (Approved by + Payroll Admin) →
//   summary (Employees + Pay Date + Gross + Net) →
//   executive insight (factual observations) →
//   accounting preview (canonical journal from previewPayrollJournal) →
//   full-review link →
//   actions row (Post Approved Payroll).
//
// Governance actions bind to the existing services:
//   • Post Approved Payroll → confirmation modal → postPayrollBatch
//     (RBAC + CAS on status + tenant scope remain server-side
//     authoritative). Never posts without the two-step confirmation.

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PayrollPostingPreview } from "@/lib/mission-control/payroll-posting-preview";
import { useWorkspacePreview } from "./WorkspacePreviewContext";

interface Props {
  preview: PayrollPostingPreview;
  currentUserId: string;
}

function PayrollPostingIcon() {
  return (
    <span
      className="spectre-mc-preview-icon"
      aria-hidden="true"
      style={{ background: "#dcfce7", color: "#166534" }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="15" rx="2" />
        <path d="M7 8h10M7 12h6" />
        <circle cx="16" cy="14" r="3" />
        <path d="M15 14l0.8 0.9 1.5-1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 4h6v6M20 4l-9 9M6 6h5M18 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

export default function PayrollPostingPreviewPane({ preview, currentUserId }: Props) {
  const router = useRouter();
  const { clearSelection, isClosing } = useWorkspacePreview();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<null | { text: string; tone: "info" | "error" | "success" }>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const status = preview.batchStatus;
  const isApproved = status === "APPROVED";
  // Server enforces payroll:post; the client hint disables Post when
  // the current user is NOT the assigned Payroll Admin. The server
  // remains authoritative — this is a UX guard only.
  const isAssignedPayrollAdmin =
    !!preview.payrollAdmin.userId && preview.payrollAdmin.userId === currentUserId;
  const journalReady = preview.journal.balanced && preview.journal.readinessBlockers.length === 0;
  const isActionable =
    isApproved && preview.workIntakeStatus === "OPEN" && isAssignedPayrollAdmin && journalReady;

  async function onPost() {
    if (!isActionable || busy || pending) return;
    setBusy(true);
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/mission-control/payroll-posting/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workIntakeItemId: preview.workIntakeItemId,
            batchId: preview.batchId,
            expectedCalculationVersion: preview.calculationVersion,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          setMessage({ text: "Payroll posted.", tone: "success" });
          clearSelection();
          router.refresh();
        } else {
          setMessage({
            text: body.message ?? `Posting refused (${res.status}).`,
            tone: "error",
          });
        }
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <section
      className={`spectre-mc-preview${isClosing ? " spectre-mc-preview--closing" : ""}`}
      data-testid="payroll-posting-preview"
      data-closing={isClosing ? "true" : "false"}
      aria-label="Payroll posting preview"
    >
      {/* Header ------------------------------------------------------ */}
      <header className="spectre-mc-preview-head">
        <PayrollPostingIcon />
        <div className="spectre-mc-preview-head-titles">
          <h2 className="spectre-mc-preview-title">Payroll Ready to Post</h2>
          <div className="spectre-mc-preview-sub">
            <span className="v">{preview.period.rangeLabel}</span>
          </div>
          <div className="spectre-mc-preview-club">{preview.clubDisplayName}</div>
        </div>
        <div className="spectre-mc-preview-head-actions">
          <Link
            href={preview.fullReviewHref}
            className="spectre-mc-preview-open-full"
            data-testid="posting-preview-open-full"
            aria-label="Open full payroll review"
          >
            <ExternalLinkIcon />
          </Link>
          <button
            type="button"
            className="spectre-mc-preview-close"
            onClick={clearSelection}
            data-testid="posting-preview-close"
            aria-label="Close preview"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      {/* Status pills ------------------------------------------------ */}
      <div className="spectre-mc-preview-pills">
        <span className="spectre-mc-preview-pill spectre-mc-preview-pill--approved">Approved</span>
        <span className="spectre-mc-preview-pill spectre-mc-preview-pill--priority">Ready to post</span>
      </div>

      {/* Metadata cards ---------------------------------------------- */}
      <div className="spectre-mc-preview-meta">
        <div className="cell">
          <div className="k">Approved by</div>
          <div className="v">{preview.approver.displayName ?? "Unknown"}</div>
          <div className="sub">{preview.approver.roleLabel} · {preview.approver.approvedDateLabel} · {preview.approver.approvedTimeLabel}</div>
        </div>
        <div className="cell">
          <div className="k">Payroll admin</div>
          <div className="v">{preview.payrollAdmin.displayName ?? "Unassigned"}</div>
          <div className="sub">{preview.payrollAdmin.roleLabel}</div>
        </div>
      </div>

      {/* Payroll summary --------------------------------------------- */}
      <div className="spectre-mc-preview-section">
        <div className="spectre-mc-preview-section-title">Summary</div>
        <div className="spectre-mc-preview-summary" data-testid="posting-preview-summary">
          <div className="cell">
            <div className="k">Employees</div>
            <div className="v">{preview.totals.employeeCount}</div>
          </div>
          <div className="cell">
            <div className="k">Pay Date</div>
            <div className="v">{preview.period.payDateLabel}</div>
          </div>
          <div className="cell">
            <div className="k">Gross Payroll</div>
            <div className="v tabular-nums">{preview.totals.grossPayDisplay}</div>
          </div>
          <div className="cell">
            <div className="k">Net Payroll</div>
            <div className="v tabular-nums">{preview.totals.netPayDisplay}</div>
          </div>
        </div>
      </div>

      {/* Executive insight ------------------------------------------- */}
      <div className="spectre-mc-preview-section">
        <div className="spectre-mc-preview-section-title">Executive insight</div>
        <ul className="spectre-mc-preview-insights" data-testid="posting-preview-insights">
          {preview.executiveInsights.map((i, idx) => (
            <li key={idx} data-tone={i.tone}>
              <span className="dot" data-tone={i.tone} aria-hidden="true" />
              <span>{i.label}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Accounting preview ------------------------------------------ */}
      <div className="spectre-mc-preview-section">
        <div className="spectre-mc-preview-section-title">Accounting preview</div>
        {preview.journal.lines.length === 0 ? (
          <p className="spectre-mc-preview-body-muted" data-testid="posting-preview-journal-missing">
            {preview.journal.readinessBlockers.length > 0
              ? preview.journal.readinessBlockers.map((b) => b.message).join(" · ")
              : "GL journal preview not available."}
          </p>
        ) : (
          <>
            <div className="spectre-mc-preview-journal" data-testid="posting-preview-journal">
              <div className="head">
                <span>Account</span>
                <span>Department</span>
                <span className="num">Debit</span>
                <span className="num">Credit</span>
              </div>
              {preview.journal.lines.map((l, idx) => (
                <div className="row" key={idx}>
                  <span>
                    <span className="acct-num tabular-nums">{l.accountNumber}</span>{" "}
                    <span className="acct-name">{l.accountName}</span>
                  </span>
                  <span className="dept">{l.departmentCode ?? "—"}</span>
                  <span className="num tabular-nums">{l.debitDisplay ?? ""}</span>
                  <span className="num tabular-nums">{l.creditDisplay ?? ""}</span>
                </div>
              ))}
              <div className="totals">
                <span></span>
                <span>Totals</span>
                <span className="num tabular-nums">{preview.journal.totalDebitsDisplay}</span>
                <span className="num tabular-nums">{preview.journal.totalCreditsDisplay}</span>
              </div>
            </div>
            <div
              className={`spectre-mc-preview-journal-status ${preview.journal.balanced ? "is-balanced" : "is-unbalanced"}`}
              data-testid="posting-preview-journal-status"
              data-balanced={preview.journal.balanced ? "true" : "false"}
            >
              {preview.journal.balanced
                ? "Balanced"
                : `Not balanced — difference ${preview.journal.differenceCentsDisplay}`}
            </div>
          </>
        )}
      </div>

      {/* Full-Review link ------------------------------------------ */}
      <div className="spectre-mc-preview-fullreview">
        <Link href={preview.fullReviewHref} data-testid="posting-preview-full-review-link">
          View Full Payroll Review
          <span aria-hidden="true"> →</span>
        </Link>
      </div>

      {/* Message ---------------------------------------------------- */}
      {message ? (
        <div
          className={`spectre-mc-preview-message spectre-mc-preview-message--${message.tone}`}
          role="status"
          data-testid="posting-preview-message"
        >
          {message.text}
        </div>
      ) : null}

      {/* Actions ---------------------------------------------------- */}
      <div className="spectre-mc-preview-actions" data-testid="posting-preview-actions">
        <button
          type="button"
          className="spectre-btn spectre-btn--primary"
          onClick={() => { setShowConfirm(true); setMessage(null); }}
          disabled={!isActionable || busy}
          data-testid="posting-preview-post"
        >
          {busy ? "Posting…" : "Post Approved Payroll"}
        </button>
      </div>

      {!isActionable ? (
        <p className="spectre-mc-preview-body-muted" data-testid="posting-preview-not-actionable">
          {status !== "APPROVED"
            ? `This batch is ${status.replace(/_/g, " ").toLowerCase()} — posting is only available for APPROVED payrolls.`
            : !isAssignedPayrollAdmin
              ? "This Ready-to-Post task is assigned to a different Payroll Administrator."
              : !journalReady
                ? "The GL journal preview is not ready. Resolve the readiness blockers before posting."
                : "This posting task is closed."}
        </p>
      ) : null}

      {/* FPP-8 (2026-09-21) — Final posting confirmation. This modal
          is the deliberate irreversible-action gate. Cancel dismisses
          without mutation. Only Confirm & Post Payroll POSTs to the
          canonical posting service. */}
      {showConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="posting-preview-confirm-title"
          data-testid="posting-preview-confirm-dialog"
          style={{
            position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.42)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowConfirm(false); }}
        >
          <div style={{
            background: "#ffffff", borderRadius: 10, width: "100%", maxWidth: 520,
            margin: "0 16px", padding: 22, boxShadow: "0 24px 44px rgba(15,23,42,0.18)",
            maxHeight: "88vh", overflowY: "auto",
          }}>
            <h2
              id="posting-preview-confirm-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#1c1917", letterSpacing: -0.005 }}
            >
              Post approved payroll
            </h2>
            <p style={{ margin: "10px 0 12px 0", fontSize: 13.5, lineHeight: 1.55, color: "#44403c" }}>
              You are about to post the approved payroll for the period{" "}
              <strong>{preview.period.rangeLabel}</strong>, pay date{" "}
              <strong>{preview.period.payDateLabel}</strong>.
            </p>
            <div
              style={{
                margin: "0 0 10px 0", padding: "10px 12px", border: "1px solid #e7e5e4",
                background: "#fbfaf7", borderRadius: 6,
              }}
              data-testid="posting-preview-confirm-summary"
            >
              <dl
                style={{
                  margin: 0, fontSize: 12.5, color: "#44403c",
                  display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 12,
                }}
              >
                <dt style={{ color: "#78716c" }}>Employees</dt>
                <dd style={{ margin: 0 }}>{preview.totals.employeeCount}</dd>
                <dt style={{ color: "#78716c" }}>Gross payroll</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.totals.grossPayDisplay}</dd>
                <dt style={{ color: "#78716c" }}>Net payroll</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.totals.netPayDisplay}</dd>
                <dt style={{ color: "#78716c" }}>Approved by</dt>
                <dd style={{ margin: 0 }}>{preview.approver.displayName ?? "Unknown"}</dd>
              </dl>
            </div>
            <div
              style={{
                margin: "0 0 10px 0", padding: "10px 12px", border: "1px solid #e7e5e4",
                background: "#f0fdf4", borderRadius: 6,
              }}
              data-testid="posting-preview-confirm-gl"
            >
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.06, textTransform: "uppercase", color: "#166534", marginBottom: 4 }}>
                General Ledger
              </div>
              <dl style={{ margin: 0, fontSize: 12.5, color: "#166534", display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 3, columnGap: 12 }}>
                <dt style={{ color: "#365d3a" }}>Total debits</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.journal.totalDebitsDisplay}</dd>
                <dt style={{ color: "#365d3a" }}>Total credits</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.journal.totalCreditsDisplay}</dd>
                <dt style={{ color: "#365d3a" }}>Status</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{preview.journal.balanced ? "Balanced" : "Not balanced"}</dd>
              </dl>
            </div>
            <p style={{ margin: "0 0 14px 0", fontSize: 12.5, lineHeight: 1.55, color: "#57534e" }}>
              Posting records this payroll in the general ledger. Employee payment transmission is separate and is not currently configured in Spectre.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="spectre-btn spectre-btn--secondary"
                onClick={() => setShowConfirm(false)}
                disabled={busy}
                data-testid="posting-preview-confirm-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="spectre-btn spectre-btn--primary"
                onClick={() => { setShowConfirm(false); onPost(); }}
                disabled={busy || !preview.journal.balanced}
                data-testid="posting-preview-confirm-submit"
              >
                {busy ? "Posting…" : "Confirm & Post Payroll"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
