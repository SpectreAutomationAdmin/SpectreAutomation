"use client";

// FPP-6 (2026-09-21) — Payroll Approval preview pane.
//
// Renders inside the Mission Control workspace when a
// PAYROLL_FINAL_APPROVAL Work Intake card is selected. Every value is
// bound to `loadPayrollApprovalPreview(workIntakeItemId)` — the frozen
// submitted evidence. The pane never reads live catalogue data.
//
// Visual layout follows the founder-approved 1440×900 reference:
//   header (icon + title + actions) →
//   sub-header (pay period + club + status pills) →
//   metadata cards (Submitted by + Submitted at) →
//   payroll summary (6 KPIs, 2×3 grid) →
//   details paragraph + Full-Review link →
//   review checks (four supported items) →
//   executive insights (factual observations only, per §1 MVP) →
//   actions row (Return for Correction + Approve Payroll).
//
// Governance actions bind to the existing services:
//   • Return for Correction → returnBatchToPreparation (VOIDS the batch)
//   • Approve Payroll → approvePayrollBatch (submitter != approver
//     rejection remains authoritative — the UI never fakes success).

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PayrollApprovalPreview } from "@/lib/mission-control/payroll-approval-preview";
import { useWorkspacePreview } from "./WorkspacePreviewContext";

interface Props {
  preview: PayrollApprovalPreview;
  currentUserId: string;
}

function PayrollIcon() {
  return (
    <span
      className="spectre-mc-preview-icon"
      aria-hidden="true"
      style={{ background: "#f4ecff", color: "#6d28d9" }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M8 9h8M8 13h5M8 17h3" />
      </svg>
    </span>
  );
}

function ChecklistCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#dcfce7" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" stroke="#166534" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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

export default function PayrollApprovalPreviewPane({ preview, currentUserId }: Props) {
  const router = useRouter();
  const { clearSelection, isClosing } = useWorkspacePreview();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "approve" | "return">(null);
  const [message, setMessage] = useState<null | { text: string; tone: "info" | "error" | "success" }>(null);
  const [returnNote, setReturnNote] = useState("");
  const [showReturnForm, setShowReturnForm] = useState(false);
  // FPP-7 (2026-09-21) — Controller approval confirmation dialog.
  // Clicking Approve Payroll opens this deliberate two-step
  // confirmation before the approval service is invoked. Cancel
  // dismisses without any mutation; only the inner Confirm button
  // POSTs to the approval endpoint.
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);

  const status = preview.batchStatus;
  const isSubmitted = status === "SUBMITTED_FOR_APPROVAL";
  // FPP-7 (2026-09-21) — segregation-of-duties UX. The preview DTO
  // now carries the submitter's user id, so we can accurately hint
  // the Approve refusal when the current user IS the submitter. The
  // server-side check in approvePayrollBatch remains the authoritative
  // enforcement — this only prevents a misleading actionable-CTA
  // presentation to the submitter (§9 of the FPP-7 brief).
  const isSelfSubmitted =
    !!preview.submitter.userId && preview.submitter.userId === currentUserId;
  const isActionable =
    isSubmitted && preview.workIntakeStatus === "OPEN" && !isSelfSubmitted;

  async function onApprove() {
    if (!isActionable || busy || pending) return;
    setBusy("approve");
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/mission-control/payroll-approval/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workIntakeItemId: preview.workIntakeItemId, batchId: preview.batchId }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          setMessage({ text: "Payroll approved.", tone: "success" });
          clearSelection();
          router.refresh();
        } else {
          setMessage({
            text: body.message ?? `Approval refused (${res.status}).`,
            tone: "error",
          });
        }
      } finally {
        setBusy(null);
      }
    });
  }

  async function onReturn() {
    if (!isActionable || busy || pending) return;
    const reason = returnNote.trim();
    if (!reason) {
      setMessage({ text: "Please describe why the payroll is being returned.", tone: "error" });
      return;
    }
    setBusy("return");
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/mission-control/payroll-approval/return", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workIntakeItemId: preview.workIntakeItemId,
            batchId: preview.batchId,
            reason,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          setMessage({ text: "Returned to Payroll Administrator.", tone: "success" });
          setReturnNote("");
          setShowReturnForm(false);
          clearSelection();
          router.refresh();
        } else {
          setMessage({
            text: body.message ?? `Return refused (${res.status}).`,
            tone: "error",
          });
        }
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <section
      className={`spectre-mc-preview${isClosing ? " spectre-mc-preview--closing" : ""}`}
      data-testid="payroll-approval-preview"
      data-closing={isClosing ? "true" : "false"}
      aria-label="Payroll approval preview"
    >
      {/* Header ------------------------------------------------------ */}
      <header className="spectre-mc-preview-head">
        <PayrollIcon />
        <div className="spectre-mc-preview-head-titles">
          <h2 className="spectre-mc-preview-title">Payroll Approval</h2>
          <div className="spectre-mc-preview-sub">
            <span className="v">{preview.period.rangeLabel}</span>
          </div>
          <div className="spectre-mc-preview-club">{preview.clubDisplayName}</div>
        </div>
        <div className="spectre-mc-preview-head-actions">
          <Link
            href={preview.fullReviewHref}
            className="spectre-mc-preview-open-full"
            data-testid="preview-open-full"
            aria-label="Open full payroll review"
          >
            <ExternalLinkIcon />
          </Link>
          <button
            type="button"
            className="spectre-mc-preview-close"
            onClick={clearSelection}
            data-testid="preview-close"
            aria-label="Close preview"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      {/* Status pills ------------------------------------------------ */}
      <div className="spectre-mc-preview-pills">
        <span className="spectre-mc-preview-pill spectre-mc-preview-pill--approval">Approval</span>
        <span className="spectre-mc-preview-pill spectre-mc-preview-pill--priority">
          Ready for approval
        </span>
      </div>

      {/* Metadata cards ---------------------------------------------- */}
      <div className="spectre-mc-preview-meta">
        <div className="cell">
          <div className="k">Submitted by</div>
          <div className="v">{preview.submitter.displayName ?? "Unknown"}</div>
          <div className="sub">{preview.submitter.roleLabel}</div>
        </div>
        <div className="cell">
          <div className="k">Submitted</div>
          <div className="v">{preview.submitter.submittedDateLabel}</div>
          <div className="sub">{preview.submitter.submittedTimeLabel}</div>
        </div>
      </div>

      {/* Payroll summary — FPP-6A: 2×2 with Employees, Pay Date,
          Gross, Net. Employee Deductions + Employer Contributions
          are secondary review information and live only in the full
          Payroll Review workspace (per §7 of the FPP-6A brief). */}
      <div className="spectre-mc-preview-section">
        <div className="spectre-mc-preview-section-title">Summary</div>
        <div className="spectre-mc-preview-summary" data-testid="preview-summary">
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

      {/* Executive Insight — FPP-6A: replaces the previous "Details"
          heading. Populated ONLY from factual frozen-evidence
          observations (§8 — no fabricated budget deltas, prior-period
          comparisons, or departmental causality). */}
      <div className="spectre-mc-preview-section">
        <div className="spectre-mc-preview-section-title">Executive insight</div>
        {preview.executiveInsights.length > 0 ? (
          <ul className="spectre-mc-preview-insights" data-testid="preview-executive-insights">
            {preview.executiveInsights.map((i, idx) => (
              <li key={idx} data-tone={i.tone}>
                <span className="dot" data-tone={i.tone} aria-hidden="true" />
                <span>{i.label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="spectre-mc-preview-body-muted">
            No analytical observations available for this payroll yet.
          </p>
        )}
      </div>

      {/* FPP-6C (2026-09-21) — the standing Review checklist and the
          Calculation / package / algorithmVersion provenance footer
          are removed from this compact executive-facing preview. The
          checklist is duplicated in the full Payroll Review workspace;
          the provenance identifiers remain on the loader's DTO and in
          the frozen batch record (calculationVersion / packageChecksum /
          algorithmVersion / WorkIntakeOrigin binding) for audit — they
          simply no longer render here. */}

      {/* Full-Review link ------------------------------------------ */}
      <div className="spectre-mc-preview-fullreview">
        <Link href={preview.fullReviewHref} data-testid="preview-full-review-link">
          View Full Payroll Review
          <span aria-hidden="true"> →</span>
        </Link>
      </div>

      {/* Message ---------------------------------------------------- */}
      {message ? (
        <div
          className={`spectre-mc-preview-message spectre-mc-preview-message--${message.tone}`}
          role="status"
          data-testid="preview-message"
        >
          {message.text}
        </div>
      ) : null}

      {/* Actions ---------------------------------------------------- */}
      {showReturnForm ? (
        <div className="spectre-mc-preview-return-form" data-testid="preview-return-form">
          <label htmlFor="preview-return-reason" className="k">
            Reason for return
          </label>
          <textarea
            id="preview-return-reason"
            data-testid="preview-return-reason"
            value={returnNote}
            onChange={(e) => setReturnNote(e.target.value)}
            rows={2}
            placeholder="Explain what needs correction…"
          />
          <div className="actions">
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary"
              onClick={() => { setShowReturnForm(false); setReturnNote(""); }}
              disabled={busy === "return"}
              data-testid="preview-return-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary"
              onClick={onReturn}
              disabled={busy === "return" || !returnNote.trim()}
              data-testid="preview-return-submit"
            >
              {busy === "return" ? "Returning…" : "Return for Correction"}
            </button>
          </div>
        </div>
      ) : (
        <div className="spectre-mc-preview-actions" data-testid="preview-actions">
          <button
            type="button"
            className="spectre-btn spectre-btn--secondary"
            onClick={() => { setShowReturnForm(true); setMessage(null); }}
            disabled={!isActionable || busy !== null}
            data-testid="preview-return"
          >
            Return for Correction
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--primary"
            onClick={() => { setShowApproveConfirm(true); setMessage(null); }}
            disabled={!isActionable || busy !== null}
            data-testid="preview-approve"
          >
            {busy === "approve" ? "Approving…" : "Approve Payroll"}
          </button>
        </div>
      )}

      {/* FPP-7 (2026-09-21) — Controller approval confirmation. This
          modal is the deliberate two-step. Cancel dismisses without
          mutation. Only the inner Confirm button invokes the
          approval service. */}
      {showApproveConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-approve-confirm-title"
          data-testid="preview-approve-confirm-dialog"
          style={{
            position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.42)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowApproveConfirm(false); }}
        >
          <div style={{
            background: "#ffffff", borderRadius: 10, width: "100%", maxWidth: 480,
            margin: "0 16px", padding: 22, boxShadow: "0 24px 44px rgba(15,23,42,0.18)",
            maxHeight: "88vh", overflowY: "auto",
          }}>
            <h2
              id="preview-approve-confirm-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#1c1917", letterSpacing: -0.005 }}
            >
              Approve Payroll
            </h2>
            <p style={{ margin: "10px 0 12px 0", fontSize: 13.5, lineHeight: 1.55, color: "#44403c" }}>
              You are approving the payroll for the period{" "}
              <strong>{preview.period.rangeLabel}</strong>, pay date{" "}
              <strong>{preview.period.payDateLabel}</strong>.
            </p>
            <div
              style={{
                margin: "0 0 12px 0", padding: "10px 12px", border: "1px solid #e7e5e4",
                background: "#fbfaf7", borderRadius: 6,
              }}
              data-testid="preview-approve-confirm-summary"
            >
              <dl
                style={{
                  margin: 0, fontSize: 12.5, color: "#44403c",
                  display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 12,
                }}
              >
                <dt style={{ color: "#78716c" }}>Employees</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.totals.employeeCount}</dd>
                <dt style={{ color: "#78716c" }}>Gross payroll</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.totals.grossPayDisplay}</dd>
                <dt style={{ color: "#78716c" }}>Net payroll</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{preview.totals.netPayDisplay}</dd>
                <dt style={{ color: "#78716c" }}>Calculation</dt>
                <dd style={{ margin: 0 }}>v{preview.calculationVersion}</dd>
              </dl>
            </div>
            <p style={{ margin: "0 0 6px 0", fontSize: 12.5, lineHeight: 1.55, color: "#57534e" }}>
              Once approved, this payroll will be handed back to Payroll Administration for posting.
            </p>
            <p style={{ margin: "0 0 14px 0", fontSize: 12.5, lineHeight: 1.55, color: "#57534e" }}>
              Approval does not transmit employee payments. Payment transmission is currently handled outside Spectre.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="spectre-btn spectre-btn--secondary"
                onClick={() => setShowApproveConfirm(false)}
                disabled={busy === "approve"}
                data-testid="preview-approve-confirm-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="spectre-btn spectre-btn--primary"
                onClick={() => { setShowApproveConfirm(false); onApprove(); }}
                disabled={busy === "approve"}
                data-testid="preview-approve-confirm-submit"
              >
                {busy === "approve" ? "Approving…" : "Approve Payroll"}
              </button>
            </div>
          </div>
        </div>
      )}

      {!isActionable ? (
        <p className="spectre-mc-preview-body-muted" data-testid="preview-not-actionable">
          {status !== "SUBMITTED_FOR_APPROVAL"
            ? `This batch is ${status.replace(/_/g, " ").toLowerCase()} — no controller action is required.`
            : isSelfSubmitted
              ? "You submitted this payroll. Segregation-of-duties requires an independent Controller to approve it."
              : "This approval item is closed."}
        </p>
      ) : null}
    </section>
  );
}
