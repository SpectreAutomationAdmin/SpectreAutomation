// Payroll-3D-3B Slice 4 (2026-09-06) — canonical secure server-action
// dispatcher for Work Intake inline actions.
//
// This module is the ONE bridge between a Mission Control card and
// the underlying canonical domain services. It exists to enforce that
// every click on a "Approve", "Reject", or "Approve Time" button:
//
//   1. is invoked with an authenticated principal (never trust the
//      browser for auth);
//   2. is scoped to the principal's active tenant;
//   3. names the target obligation with canonical IDs — no client-
//      supplied "workDomain" strings, no dynamic function names, no
//      eval;
//   4. verifies the WorkIntakeItem the card was rendered from is the
//      actual canonical active obligation for the target (a rogue
//      client cannot use an unrelated card to unlock an action on a
//      different obligation);
//   5. re-resolves current responsibility ownership server-side —
//      stale ownerUserId from the card is never authorization;
//   6. rejects config-gap cards from being used as decision authority;
//   7. delegates to the existing canonical service functions —
//      approveCorrectionRequest / rejectCorrectionRequest /
//      approveTimesheetScope — with no duplication of authorization,
//      CAS, audit, event, or side-effect logic;
//   8. maps canonical AppError codes onto a stable client contract of
//      structured result codes.
//
// The whitelist is exactly three actions:
//   correction.approve
//   correction.reject
//   timesheetScope.approve
// No dynamic import / eval / string-to-function map. Adding a new
// action requires a new discriminated-union arm AND a new branch in
// invokeWorkIntakeAction — deliberate, greppable, reviewable.
//
// Slice 6 will render these action buttons in Mission Control on top
// of this dispatcher; Slice 4 ships infrastructure only.

import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import {
  AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError,
} from "../errors";
import { hasPermission, type Principal } from "../rbac";
import {
  approveCorrectionRequest,
  rejectCorrectionRequest,
  resolveCorrectionScope,
} from "../timesheets/correction-service";
import { approveTimesheetScope, resolveDepartmentTimeApprover } from "../timesheets/manager-approval";
import { getScopeReview } from "../timesheets/approval-scope";
import { ensureTimesheetApprovalWorkItems } from "../timesheets/orchestration";
import {
  CORRECTION_REVIEW_KIND,
  CORRECTION_REVIEW_GAP_KIND,
  ensureCorrectionReviewWorkItems,
} from "./correction-review-orchestration";

const SCOPE_ORIGIN_KIND = "PAYROLL_TIMESHEET_APPROVAL";
const SCOPE_GAP_ORIGIN_KIND = "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP";

// -------------------------------------------------------------------
// Slice 4A (2026-09-06) — Work Intake actionable-status invariant.
//
// Audit of prisma/schema.prisma:9650 and src/lib/work-intake/actions.ts
// confirms the enum: OPEN | IN_PROGRESS | DEFERRED | RESOLVED |
// INFORMATIONAL | SUPPRESSED.
//
// Actionable = { OPEN, IN_PROGRESS }.
//   OPEN — canonical active obligation, unassigned or reassignable.
//   IN_PROGRESS — an assignee opened the card; still actionable.
//
// Non-actionable and DO NOT trigger reconciliation:
//   DEFERRED       — user explicitly postponed; reconciliation would
//                    fight the user's intent.
//   INFORMATIONAL  — user classified as no-action-required; same.
//   SUPPRESSED     — deliberately silenced; same.
//
// Non-actionable AND triggers reconciliation:
//   RESOLVED       — completion recorded, but the domain may still
//                    require action (e.g., a correction remained
//                    PENDING after a WI orchestration bug earlier in
//                    development). Call the canonical ensureX helper
//                    so a fresh active card is materialised / the
//                    resolved card is reopened. Then return STALE so
//                    the client can refresh Mission Control and act
//                    from the current active obligation. The
//                    reconciliation NEVER decides the domain.
//
// Config-gap cards remain a separate CONFIG_GAP failure independent
// of status (already implemented in Slice 4). The status check runs
// AFTER config-gap check so a RESOLVED config-gap surfaces the
// clearer CONFIG_GAP error rather than STALE.
// -------------------------------------------------------------------

const ACTIONABLE_WI_STATUSES = ["OPEN", "IN_PROGRESS"] as const;
type ActionableWiStatus = typeof ACTIONABLE_WI_STATUSES[number];

function isActionableStatus(status: string): status is ActionableWiStatus {
  return (ACTIONABLE_WI_STATUSES as readonly string[]).includes(status);
}

// -------------------------------------------------------------------
// Public contract
// -------------------------------------------------------------------

export type WorkIntakeActionRequest =
  | {
      action: "correction.approve";
      workIntakeItemId: string;
      correctionRequestId: string;
    }
  | {
      action: "correction.reject";
      workIntakeItemId: string;
      correctionRequestId: string;
      reviewerNote: string;
    }
  | {
      action: "timesheetScope.approve";
      workIntakeItemId: string;
      payPeriodId: string;
      departmentId: string;
      expectedRevision: string;
    };

export type WorkIntakeActionErrorCode =
  | "STALE"
  | "ALREADY_DECIDED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFIG_GAP"
  | "NOT_READY"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export type WorkIntakeActionResult =
  | { ok: true; action: string; message?: string }
  | { ok: false; code: WorkIntakeActionErrorCode; message: string; details?: unknown };

// -------------------------------------------------------------------
// Entrypoint — called from the `"use server"` wrapper. Never accepts
// clubId from the client; the authenticated context's activeClubId is
// the tenant authority.
// -------------------------------------------------------------------

export async function invokeWorkIntakeAction(
  principal: Principal,
  activeClubId: string,
  request: WorkIntakeActionRequest,
): Promise<WorkIntakeActionResult> {
  try {
    switch (request.action) {
      case "correction.approve":
        return await dispatchCorrectionApprove(principal, activeClubId, request);
      case "correction.reject":
        return await dispatchCorrectionReject(principal, activeClubId, request);
      case "timesheetScope.approve":
        return await dispatchTimesheetScopeApprove(principal, activeClubId, request);
      default: {
        // Exhaustiveness — if a new arm is added to the union but no
        // dispatcher branch, TypeScript will surface it here.
        const _exhaustive: never = request;
        void _exhaustive;
        return { ok: false, code: "VALIDATION_ERROR", message: "Unknown action." };
      }
    }
  } catch (err) {
    return mapErrorToResult(err, request, principal.id, activeClubId);
  }
}

// -------------------------------------------------------------------
// correction.approve
// -------------------------------------------------------------------

async function dispatchCorrectionApprove(
  principal: Principal,
  activeClubId: string,
  req: Extract<WorkIntakeActionRequest, { action: "correction.approve" }>,
): Promise<WorkIntakeActionResult> {
  const bindOutcome = await verifyCorrectionBinding({
    activeClubId,
    workIntakeItemId: req.workIntakeItemId,
    correctionRequestId: req.correctionRequestId,
  });
  if (!bindOutcome.ok) return bindOutcome.result;

  await approveCorrectionRequest(principal, activeClubId, {
    requestId: req.correctionRequestId,
    reviewerNote: null,
  });
  return { ok: true, action: "correction.approve" };
}

// -------------------------------------------------------------------
// correction.reject
// -------------------------------------------------------------------

async function dispatchCorrectionReject(
  principal: Principal,
  activeClubId: string,
  req: Extract<WorkIntakeActionRequest, { action: "correction.reject" }>,
): Promise<WorkIntakeActionResult> {
  const bindOutcome = await verifyCorrectionBinding({
    activeClubId,
    workIntakeItemId: req.workIntakeItemId,
    correctionRequestId: req.correctionRequestId,
  });
  if (!bindOutcome.ok) return bindOutcome.result;

  await rejectCorrectionRequest(principal, activeClubId, {
    requestId: req.correctionRequestId,
    reviewerNote: req.reviewerNote,
  });
  return { ok: true, action: "correction.reject" };
}

// -------------------------------------------------------------------
// timesheetScope.approve
// -------------------------------------------------------------------

async function dispatchTimesheetScopeApprove(
  principal: Principal,
  activeClubId: string,
  req: Extract<WorkIntakeActionRequest, { action: "timesheetScope.approve" }>,
): Promise<WorkIntakeActionResult> {
  const bindOutcome = await verifyTimesheetScopeBinding({
    activeClubId,
    workIntakeItemId: req.workIntakeItemId,
    payPeriodId: req.payPeriodId,
    departmentId: req.departmentId,
  });
  if (!bindOutcome.ok) return bindOutcome.result;

  // §11 — NOT_READY gate. Even with a valid WI, the scope must be
  // canonically ready before Approve Time is permitted. Defense in
  // depth: Slice 6 will also omit the button server-side, but the
  // dispatcher enforces it regardless of the button state.
  const review = await getScopeReview(activeClubId, req.payPeriodId, req.departmentId);
  if (!review.readiness.ready) {
    return {
      ok: false, code: "NOT_READY",
      message: "This scope is not ready to approve. Resolve blocking issues first.",
      details: { blocking: review.readiness.blockingReasons },
    };
  }

  await approveTimesheetScope(principal, {
    clubId: activeClubId,
    payPeriodId: req.payPeriodId,
    departmentId: req.departmentId,
    attestedRevision: req.expectedRevision,
  });
  return { ok: true, action: "timesheetScope.approve" };
}

// -------------------------------------------------------------------
// Binding verifier — correction obligation.
//
// Enforces §5 (WI item is the canonical active obligation for the
// target) + §17 (config-gap cards may not authorize decisions) +
// §7 (current responsibility ownership).
// -------------------------------------------------------------------

async function verifyCorrectionBinding(args: {
  activeClubId: string;
  workIntakeItemId: string;
  correctionRequestId: string;
}): Promise<{ ok: true } | { ok: false; result: WorkIntakeActionResult }> {
  const item = await prisma.workIntakeItem.findFirst({
    where: { id: args.workIntakeItemId, clubId: args.activeClubId },
    include: {
      origins: { where: { role: "PRIMARY" }, select: { kind: true, referenceId: true } },
    },
  });
  if (!item) return notFound("WorkIntakeItem", args.workIntakeItemId);

  const primaryOrigin = item.origins[0];
  if (!primaryOrigin) return notFound("WorkIntakeOrigin", args.workIntakeItemId);

  // §17 — config-gap items are configuration work, not decision authority.
  if (primaryOrigin.kind === CORRECTION_REVIEW_GAP_KIND) {
    return {
      ok: false,
      result: { ok: false, code: "CONFIG_GAP", message: "This card is a configuration gap and cannot be used to decide corrections." },
    };
  }

  // §5 — WI must be the canonical correction-review card for the exact target.
  if (
    primaryOrigin.kind !== CORRECTION_REVIEW_KIND
    || primaryOrigin.referenceId !== args.correctionRequestId
  ) {
    return notFound("WorkIntakeItem", args.workIntakeItemId);
  }

  // Slice 4A — Work Intake actionability invariant. A card in any
  // non-actionable status (RESOLVED, SUPPRESSED, INFORMATIONAL,
  // DEFERRED) is not a valid execution path even when the underlying
  // correction is still PENDING. RESOLVED additionally triggers
  // canonical reconciliation so the manager can refresh Mission
  // Control and act from a current active obligation.
  if (!isActionableStatus(item.status)) {
    if (item.status === "RESOLVED") {
      // Reconciliation is best-effort — a failure here does NOT change
      // the STALE outcome (the client refreshes regardless).
      try {
        await ensureCorrectionReviewWorkItems({
          clubId: args.activeClubId,
          correctionRequestId: args.correctionRequestId,
        });
      } catch (err) {
        logger.warn("work_intake.action.reconcile_failed", {
          action: "correction",
          workIntakeItemId: args.workIntakeItemId,
          clubId: args.activeClubId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      ok: false,
      result: staleResult(item.status, "correction"),
    };
  }

  // Correction row must exist within the tenant.
  const correction = await prisma.timeClockCorrectionRequest.findFirst({
    where: { id: args.correctionRequestId, clubId: args.activeClubId },
    select: { status: true },
  });
  if (!correction) return notFound("TimeClockCorrectionRequest", args.correctionRequestId);

  // §13 / §16 — already-decided.
  if (correction.status !== "PENDING") {
    return {
      ok: false,
      result: { ok: false, code: "ALREADY_DECIDED", message: `Correction is already ${correction.status.toLowerCase()}.` },
    };
  }

  return { ok: true };
}

// -------------------------------------------------------------------
// Binding verifier — timesheet-approval scope.
// -------------------------------------------------------------------

async function verifyTimesheetScopeBinding(args: {
  activeClubId: string;
  workIntakeItemId: string;
  payPeriodId: string;
  departmentId: string;
}): Promise<{ ok: true } | { ok: false; result: WorkIntakeActionResult }> {
  const item = await prisma.workIntakeItem.findFirst({
    where: { id: args.workIntakeItemId, clubId: args.activeClubId },
    include: {
      origins: { where: { role: "PRIMARY" }, select: { kind: true, referenceId: true } },
    },
  });
  if (!item) return notFound("WorkIntakeItem", args.workIntakeItemId);

  const primaryOrigin = item.origins[0];
  if (!primaryOrigin) return notFound("WorkIntakeOrigin", args.workIntakeItemId);

  // §17 — config-gap items are configuration work.
  if (primaryOrigin.kind === SCOPE_GAP_ORIGIN_KIND) {
    return {
      ok: false,
      result: { ok: false, code: "CONFIG_GAP", message: "This card is a configuration gap and cannot be used to approve time." },
    };
  }

  // §5 — WI must be the canonical timesheet-approval card for the exact scope.
  const expectedReferenceId = `${args.payPeriodId}:${args.departmentId}`;
  if (
    primaryOrigin.kind !== SCOPE_ORIGIN_KIND
    || primaryOrigin.referenceId !== expectedReferenceId
  ) {
    return notFound("WorkIntakeItem", args.workIntakeItemId);
  }

  // Slice 4A — actionability invariant. Same rule as correction:
  // RESOLVED / SUPPRESSED / INFORMATIONAL / DEFERRED cannot execute
  // a domain decision. RESOLVED triggers canonical reconciliation
  // (already-approved-with-matching-revision short-circuits inside
  // ensureTimesheetApprovalWorkItems, so this call safely no-ops
  // when the scope is genuinely complete).
  if (!isActionableStatus(item.status)) {
    if (item.status === "RESOLVED") {
      try {
        await ensureTimesheetApprovalWorkItems(args.activeClubId, args.payPeriodId);
      } catch (err) {
        logger.warn("work_intake.action.reconcile_failed", {
          action: "timesheetScope",
          workIntakeItemId: args.workIntakeItemId,
          clubId: args.activeClubId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      ok: false,
      result: staleResult(item.status, "timesheetScope"),
    };
  }

  return { ok: true };
}

// -------------------------------------------------------------------
// Slice 4A — human-friendly STALE messages per status. All four
// non-actionable statuses map to the STALE code because the client
// experience is identical: refresh Mission Control and re-render.
// The message copy varies so a manager sees "this card was resolved"
// vs "this card was deferred" and understands why the click did not
// take.
// -------------------------------------------------------------------

function staleResult(status: string, kind: "correction" | "timesheetScope"): WorkIntakeActionResult {
  const noun = kind === "correction" ? "correction review" : "timesheet approval";
  let message: string;
  switch (status) {
    case "RESOLVED":
      message = `This ${noun} card was already resolved. Refresh Mission Control to see the current obligation, if any.`;
      break;
    case "SUPPRESSED":
      message = `This ${noun} card is suppressed. Restore it before acting.`;
      break;
    case "INFORMATIONAL":
      message = `This ${noun} card is marked informational. Restore it before acting.`;
      break;
    case "DEFERRED":
      message = `This ${noun} card is deferred. Return it to the feed before acting.`;
      break;
    default:
      message = `This ${noun} card is no longer actionable. Refresh Mission Control.`;
  }
  return { ok: false, code: "STALE", message, details: { workIntakeItemStatus: status } };
}

// -------------------------------------------------------------------
// Error mapping — turns canonical AppError codes into the structured
// WorkIntakeActionResult contract. Never leaks Prisma internals or
// stack traces to the client. Full detail is logged server-side.
// -------------------------------------------------------------------

function mapErrorToResult(
  err: unknown, request: WorkIntakeActionRequest,
  principalId: string, clubId: string,
): WorkIntakeActionResult {
  // Structured server log — full detail for diagnosis. Never includes
  // sensitive payroll values (§22).
  logger.warn("work_intake.action.error", {
    action: request.action,
    workIntakeItemId: request.workIntakeItemId,
    clubId, principalUserId: principalId,
    errorName: err instanceof Error ? err.name : "unknown",
    errorMessage: err instanceof Error ? err.message : String(err),
  });

  if (err instanceof ValidationError) {
    return { ok: false, code: "VALIDATION_ERROR", message: err.safeMessage, details: err.issues };
  }
  if (err instanceof ForbiddenError) {
    return { ok: false, code: "UNAUTHORIZED", message: err.safeMessage };
  }
  if (err instanceof NotFoundError) {
    return { ok: false, code: "NOT_FOUND", message: err.safeMessage };
  }
  if (err instanceof ConflictError) {
    // §13 / §14 — canonical services throw ConflictError for CAS/
    // revision drift + already-decided; classify by message shape so
    // the client can pick the right friendly copy.
    const msg = err.safeMessage.toLowerCase();
    if (msg.includes("already ") || msg.includes("no longer") || msg.includes("resolved")) {
      return { ok: false, code: "ALREADY_DECIDED", message: err.safeMessage };
    }
    if (msg.includes("revision") || msg.includes("re-attest") || msg.includes("changed since")) {
      return { ok: false, code: "STALE", message: err.safeMessage };
    }
    return { ok: false, code: "CONFLICT", message: err.safeMessage };
  }
  if (err instanceof AppError) {
    // Any other typed AppError.
    return { ok: false, code: "CONFLICT", message: err.safeMessage };
  }
  // Unknown / unmapped — never leak stack, never leak Prisma internals.
  logger.error("work_intake.action.unmapped_error", {
    action: request.action,
    workIntakeItemId: request.workIntakeItemId,
    clubId, principalUserId: principalId,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  return { ok: false, code: "INTERNAL_ERROR", message: "Something went wrong. Please refresh and try again." };
}

function notFound(entity: string, id: string): { ok: false; result: WorkIntakeActionResult } {
  return {
    ok: false,
    result: { ok: false, code: "NOT_FOUND", message: `${entity} not found` , details: { entity, id } },
  };
}

// -------------------------------------------------------------------
// Escape-hatch: an EMPLOYEE portal principal must never reach this
// dispatcher. The `"use server"` wrapper is responsible for building
// a `Principal` (tenant/admin authority) from the request context.
// A caller that mistakenly hands us an EmployeePortalPrincipal would
// fail the RBAC checks inside the canonical services (they expect
// `Principal` with `memberships`), so the safety layer is transitive.
// We do NOT trust `principal` to have any specific role — every
// canonical service revalidates through its own permission gate.
// -------------------------------------------------------------------

export function _isPrincipalTenantAdminForClub(principal: Principal, clubId: string): boolean {
  return hasPermission(principal, clubId, "payroll:write")
      || hasPermission(principal, clubId, "payroll:employees:manage");
}
export function _resolveDepartmentTimeApproverForTest(clubId: string, departmentId: string) {
  return resolveDepartmentTimeApprover(clubId, departmentId);
}
// The correction scope helper is imported here purely so the module
// keeps a single reference to it — future dispatch branches (e.g.,
// bulk correction actions) can reuse it without a second import site.
export function _resolveCorrectionScopeForTest(clubId: string, corr: Parameters<typeof resolveCorrectionScope>[1]) {
  return resolveCorrectionScope(clubId, corr);
}
