"use client";

// Payroll-3D-3B Slice 6 (2026-09-06) — Mission Control card for
// payroll manager action obligations. Renders correction reviews,
// timesheet-approval scopes, and their configuration-gap siblings.
//
// The component does ZERO payroll business logic:
//   - Every displayed value comes from the loader
//     (src/lib/mission-control/payroll-intake.ts) which reads
//     canonical services (getScopeReview, correction service).
//   - Every action call goes through the Slice 4 dispatcher
//     (invokeMissionControlWorkIntakeAction) which re-resolves auth,
//     tenant, WI binding, readiness, and revision server-side.
//   - The card obeys the Slice 4A actionable-status gate — if the
//     server returns STALE the card refreshes and disappears.
//
// Native to the accepted Spectre Mission Control design system:
//   - Uses the same eyebrow / title / metadata / actions layout as
//     <FeedItem> in src/app/app/admin/page.tsx.
//   - Reuses spectre-mc-item / spectre-btn CSS classes.
//   - No new colour palette; category eyebrow uses PAYROLL slug.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { WorkItem, PayrollWorkIntakeCard } from "@/lib/mission-control";
import type { WorkIntakeActionResult } from "@/lib/work-intake/action-dispatcher";
import { invokeMissionControlWorkIntakeAction } from "@/app/app/admin/_work-intake-actions";

interface Props {
  item: WorkItem;
}

const IDLE_ERROR_MAP: Record<string, string> = {
  STALE:            "This item changed while you were reviewing it. Spectre refreshed the current work.",
  ALREADY_DECIDED:  "This correction has already been reviewed.",
  UNAUTHORIZED:     "You are no longer the assigned reviewer for this item.",
  NOT_FOUND:        "This item is no longer available.",
  CONFLICT:         "This action could not complete because of a conflict.",
  CONFIG_GAP:       "This item needs configuration attention before it can be reviewed.",
  NOT_READY:        "This timesheet is not ready to approve yet.",
  VALIDATION_ERROR: "Please check the note and try again.",
  INTERNAL_ERROR:   "Spectre couldn't complete this action. Please try again.",
};

export default function PayrollActionCard({ item }: Props) {
  const card = item.payrollCard;
  // Slice 4A — inline actions only for actionable statuses. Terminal
  // statuses fall through to the read-only rendering so the user sees
  // the historical context but no Approve/Reject buttons.
  const isActionable = item.workIntakeStatus === "OPEN" || item.workIntakeStatus === "IN_PROGRESS";
  if (!card) return null;
  switch (card.kind) {
    case "correction":
      return <CorrectionReviewCard item={item} card={card} isActionable={isActionable} />;
    case "scope":
      return <ScopeApprovalCard item={item} card={card} isActionable={isActionable} />;
    case "correction-gap":
      return <CorrectionGapCard item={item} card={card} />;
    case "scope-gap":
      return <ScopeGapCard item={item} card={card} />;
  }
}

// -------------------------------------------------------------------
// Card chrome — shared header/metadata block matching <FeedItem>.
// -------------------------------------------------------------------

function CardHeader(props: {
  state: WorkItem["state"];
  eyebrow: string;
  pillLabel: string;
  idTag: string;
  timestampLabel: string;
}) {
  return (
    <div className="spectre-mc-item-head">
      <span className={`spectre-mc-worktype spectre-mc-worktype--payroll`}>
        {props.eyebrow}
      </span>
      <span className={`spectre-mc-pill ${props.state}`}>{props.pillLabel}</span>
      <span className="spectre-mc-id-tag">{props.idTag}</span>
      <span className="spectre-mc-ts">{props.timestampLabel}</span>
    </div>
  );
}

function ActionMessage(props: { message: string | null; tone: "error" | "info" | "success" }) {
  if (!props.message) return null;
  return (
    <p role="status" className={`spectre-mc-action-message spectre-mc-action-message--${props.tone}`}>
      {props.message}
    </p>
  );
}

// -------------------------------------------------------------------
// Correction review — inline Approve / Reject / View Timesheet.
// -------------------------------------------------------------------

function CorrectionReviewCard(props: {
  item: WorkItem;
  card: Extract<PayrollWorkIntakeCard, { kind: "correction" }>;
  isActionable: boolean;
}) {
  const { item, card, isActionable } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyAction, setBusyAction] = useState<"approve" | "reject" | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "info" | "success" } | null>(null);
  const [showRejectNote, setShowRejectNote] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  const workDate = new Date(card.workDateIso);
  const workDateLabel = workDate.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  function handleResult(r: WorkIntakeActionResult) {
    if (r.ok) {
      setMessage({ text: "Decision recorded.", tone: "success" });
      setShowRejectNote(false);
      startTransition(() => router.refresh());
    } else {
      const friendly = IDLE_ERROR_MAP[r.code] ?? r.message;
      setMessage({ text: friendly, tone: "error" });
      if (r.code === "STALE" || r.code === "ALREADY_DECIDED" || r.code === "UNAUTHORIZED" || r.code === "NOT_FOUND") {
        startTransition(() => router.refresh());
      }
    }
  }

  function onApprove() {
    if (pending || busyAction) return;
    setBusyAction("approve");
    setMessage(null);
    startTransition(async () => {
      try {
        const r = await invokeMissionControlWorkIntakeAction({
          action: "correction.approve",
          workIntakeItemId: card.workIntakeItemId,
          correctionRequestId: card.correctionRequestId,
        });
        handleResult(r);
      } finally {
        setBusyAction(null);
      }
    });
  }
  function onRejectClick() {
    if (pending || busyAction) return;
    setShowRejectNote(true);
    setMessage(null);
  }
  function onRejectSubmit() {
    if (pending || busyAction) return;
    setBusyAction("reject");
    startTransition(async () => {
      try {
        const r = await invokeMissionControlWorkIntakeAction({
          action: "correction.reject",
          workIntakeItemId: card.workIntakeItemId,
          correctionRequestId: card.correctionRequestId,
          reviewerNote: rejectNote,
        });
        handleResult(r);
      } finally {
        setBusyAction(null);
      }
    });
  }
  function onRejectCancel() {
    if (busyAction === "reject") return;
    setShowRejectNote(false);
    setRejectNote("");
  }

  return (
    <article className={`spectre-mc-item ${item.state}`} data-testid={`payroll-action-card-${card.workIntakeItemId}`}>
      <CardHeader
        state={item.state}
        eyebrow="Payroll · Correction review"
        pillLabel="Needs review"
        idTag={item.idTag}
        timestampLabel={item.timestampLabel}
      />
      <h3>{card.employeeName} · {card.correctionTypeLabel}</h3>
      <div className="spectre-mc-sender">
        <span className="from">{card.departmentName ?? "No work area"}</span>
        <span className="sep">·</span>
        <span>Work date {workDateLabel}</span>
      </div>
      <div className="spectre-mc-readout">
        {card.originalTimeLabel ? (
          <div className="cell">
            <div className="k">Original</div>
            <div className="v">{card.originalTimeLabel}</div>
          </div>
        ) : null}
        {card.requestedTimeLabel ? (
          <div className="cell">
            <div className="k">Requested</div>
            <div className="v">{card.requestedTimeLabel}</div>
          </div>
        ) : null}
      </div>
      {card.reason ? (
        <p className="spectre-mc-work"><em>Reason:</em> {card.reason}</p>
      ) : null}

      <ActionMessage message={message?.text ?? null} tone={message?.tone ?? "info"} />

      {isActionable && !showRejectNote ? (
        <div className="spectre-mc-actions">
          <button
            type="button"
            className="spectre-btn spectre-btn--primary"
            onClick={onApprove}
            disabled={pending || busyAction !== null}
            data-testid="payroll-correction-approve"
            aria-label={`Approve correction for ${card.employeeName}`}
          >
            {busyAction === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--secondary"
            onClick={onRejectClick}
            disabled={pending || busyAction !== null}
            data-testid="payroll-correction-reject"
            aria-label={`Reject correction for ${card.employeeName}`}
          >
            Reject
          </button>
          {card.deepLink ? (
            <Link
              href={card.deepLink.href}
              className="spectre-btn spectre-btn--ghost"
              data-testid="payroll-correction-deeplink"
            >
              {card.deepLink.label}
            </Link>
          ) : null}
        </div>
      ) : null}

      {isActionable && showRejectNote ? (
        <div className="spectre-mc-reject-panel" role="group" aria-label="Reject correction">
          <label htmlFor={`reject-note-${card.workIntakeItemId}`} className="spectre-mc-reject-label">
            Optional note (visible to the employee):
          </label>
          <textarea
            id={`reject-note-${card.workIntakeItemId}`}
            className="spectre-mc-reject-textarea"
            rows={2}
            maxLength={500}
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            disabled={busyAction === "reject"}
            data-testid="payroll-correction-reject-note"
          />
          <div className="spectre-mc-actions">
            <button
              type="button"
              className="spectre-btn spectre-btn--primary"
              onClick={onRejectSubmit}
              disabled={busyAction === "reject"}
              data-testid="payroll-correction-reject-confirm"
            >
              {busyAction === "reject" ? "Rejecting…" : "Confirm reject"}
            </button>
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary"
              onClick={onRejectCancel}
              disabled={busyAction === "reject"}
              data-testid="payroll-correction-reject-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

// -------------------------------------------------------------------
// Timesheet-approval scope — ready OR blocked OR REVIEW_REQUIRED.
// -------------------------------------------------------------------

function ScopeApprovalCard(props: {
  item: WorkItem;
  card: Extract<PayrollWorkIntakeCard, { kind: "scope" }>;
  isActionable: boolean;
}) {
  const { item, card, isActionable } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "info" | "success" } | null>(null);

  function handleResult(r: WorkIntakeActionResult) {
    if (r.ok) {
      setMessage({ text: "Time approved.", tone: "success" });
      startTransition(() => router.refresh());
    } else {
      const friendly = IDLE_ERROR_MAP[r.code] ?? r.message;
      setMessage({ text: friendly, tone: "error" });
      if (r.code === "STALE" || r.code === "NOT_READY" || r.code === "UNAUTHORIZED") {
        startTransition(() => router.refresh());
      }
    }
  }

  function onApprove() {
    if (pending || busy) return;
    setBusy(true);
    setMessage(null);
    startTransition(async () => {
      try {
        const r = await invokeMissionControlWorkIntakeAction({
          action: "timesheetScope.approve",
          workIntakeItemId: card.workIntakeItemId,
          payPeriodId: card.payPeriodId,
          departmentId: card.departmentId,
          expectedRevision: card.currentRevision,
        });
        handleResult(r);
      } finally {
        setBusy(false);
      }
    });
  }

  const eyebrow = card.reviewRequired
    ? "Payroll · Time changed since approval"
    : "Payroll · Timesheet approval";
  const pillLabel = card.readinessReady ? "Ready for approval" : "Needs attention";

  return (
    <article className={`spectre-mc-item ${item.state}`} data-testid={`payroll-action-card-${card.workIntakeItemId}`}>
      <CardHeader
        state={item.state}
        eyebrow={eyebrow}
        pillLabel={pillLabel}
        idTag={item.idTag}
        timestampLabel={item.timestampLabel}
      />
      <h3>{card.departmentName} · Time approval</h3>
      <div className="spectre-mc-readout">
        <div className="cell"><div className="k">Employees</div><div className="v">{card.employeeCount}</div></div>
        <div className="cell"><div className="k">Recorded hours</div><div className="v">{card.recordedHours.toFixed(2)}h</div></div>
        {card.exceptionCount > 0 ? (
          <div className="cell"><div className="k">Exceptions</div><div className="v">{card.exceptionCount}</div></div>
        ) : null}
        {card.pendingCorrectionCount > 0 ? (
          <div className="cell"><div className="k">Corrections</div><div className="v">{card.pendingCorrectionCount} pending</div></div>
        ) : null}
      </div>

      {!card.readinessReady && card.blockers.length > 0 ? (
        <p className="spectre-mc-work"><em>Blocked by:</em> {card.blockers.join(" · ")}</p>
      ) : null}

      <ActionMessage message={message?.text ?? null} tone={message?.tone ?? "info"} />

      <div className="spectre-mc-actions">
        {isActionable && card.readinessReady ? (
          <button
            type="button"
            className="spectre-btn spectre-btn--primary"
            onClick={onApprove}
            disabled={pending || busy}
            data-testid="payroll-scope-approve"
            aria-label={`Approve time for ${card.departmentName}`}
          >
            {busy ? "Approving…" : "Approve Time"}
          </button>
        ) : null}
        {card.deepLink ? (
          <Link
            href={card.deepLink.href}
            className={isActionable && card.readinessReady ? "spectre-btn spectre-btn--secondary" : "spectre-btn spectre-btn--primary"}
            data-testid="payroll-scope-deeplink"
          >
            Review timesheets
          </Link>
        ) : null}
      </div>
    </article>
  );
}

// -------------------------------------------------------------------
// Config-gap cards — Tenant Admin remediation, never manager decision.
// -------------------------------------------------------------------

function CorrectionGapCard(props: {
  item: WorkItem;
  card: Extract<PayrollWorkIntakeCard, { kind: "correction-gap" }>;
}) {
  const { item, card } = props;
  const gapMessage = card.gapReason === "MISSING_APPROVER"
    ? `No Timesheet Approver is configured for ${card.departmentName ?? "this department"}. Assign one so ${card.employeeName ?? "the employee"}'s correction can be reviewed.`
    : `Spectre could not resolve a work assignment / department for ${card.employeeName ?? "an employee"}'s correction. Repair the assignment so a manager can review it.`;
  return (
    <article className={`spectre-mc-item ${item.state}`} data-testid={`payroll-action-card-${card.workIntakeItemId}`}>
      <CardHeader
        state={item.state}
        eyebrow="Payroll · Configuration"
        pillLabel="Needs configuration"
        idTag={item.idTag}
        timestampLabel={item.timestampLabel}
      />
      <h3>Timesheet correction routing needs attention</h3>
      <p className="spectre-mc-work">{gapMessage}</p>
      <div className="spectre-mc-actions">
        {card.deepLink ? (
          <Link
            href={card.deepLink.href}
            className="spectre-btn spectre-btn--primary"
            data-testid="payroll-correction-gap-remediation"
          >
            {card.deepLink.label}
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function ScopeGapCard(props: {
  item: WorkItem;
  card: Extract<PayrollWorkIntakeCard, { kind: "scope-gap" }>;
}) {
  const { item, card } = props;
  return (
    <article className={`spectre-mc-item ${item.state}`} data-testid={`payroll-action-card-${card.workIntakeItemId}`}>
      <CardHeader
        state={item.state}
        eyebrow="Payroll · Configuration"
        pillLabel="Needs configuration"
        idTag={item.idTag}
        timestampLabel={item.timestampLabel}
      />
      <h3>Timesheet Approver missing — {card.departmentName ?? "department"}</h3>
      <p className="spectre-mc-work">
        Assign a Timesheet Approver for {card.departmentName ?? "this department"} before recorded time can be reviewed.
      </p>
      <div className="spectre-mc-actions">
        {card.deepLink ? (
          <Link
            href={card.deepLink.href}
            className="spectre-btn spectre-btn--primary"
            data-testid="payroll-scope-gap-remediation"
          >
            {card.deepLink.label}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
