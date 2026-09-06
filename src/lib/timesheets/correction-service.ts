// Payroll-3D-2 (2026-09-05) — Time clock correction request service.
//
// Employees submit correction requests through this service. Nothing
// here mutates immutable TimeClockEvent history. Approval (3D-3) will
// create a NEW event with source=ADMIN_CORRECTION and link it via
// resolutionClockEventId. Until then, requests sit in PENDING.
//
// Concurrency (§36, §79 of the 3D-2 brief): two identical concurrent
// PENDING submissions cannot both persist. The DB unique constraint
// (employeeId, requestType, originalClockEventId, status) collides
// the second insert; this service catches P2002 and returns the
// canonical row so the client sees an idempotent success.

import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { EmployeePortalPrincipal } from "../employee-portal-session";
import { materializeEmployeeTimesheet } from "./service";
import { resolveDepartmentTimeApprover, invalidateApprovalIfDrifted } from "./manager-approval";
import { ensureCorrectionReviewWorkItems } from "../work-intake/correction-review-orchestration";
import { enqueue } from "../queue";
import { logger } from "../observability/logger";

export const CORRECTION_REQUEST_TYPES = [
  "ADD_MISSING_CLOCK_IN",
  "ADD_MISSING_CLOCK_OUT",
  "CORRECT_CLOCK_IN",
  "CORRECT_CLOCK_OUT",
  "CORRECT_BREAK_START",
  "CORRECT_BREAK_END",
] as const;
export type CorrectionRequestType = (typeof CORRECTION_REQUEST_TYPES)[number];

export const CORRECTION_STATUSES = [
  "PENDING", "APPROVED", "REJECTED", "CANCELLED",
] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

const REASON_MAX = 500;

// -------------------------------------------------------------------
// Timezone-safe local → UTC.
//
// Client submits `requestedLocalIso` = "YYYY-MM-DDTHH:mm" as
// interpreted in the Club's IANA timezone. Server converts to UTC
// using Intl offsets so we never rely on the server/browser default
// timezone. §32 / §33.
// -------------------------------------------------------------------
export function requestedLocalToUtc(localIso: string, tz: string | null): Date {
  const iana = tz ?? "UTC";
  // Parse the local wall-clock components.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localIso);
  if (!m) {
    throw new ValidationError([{ path: "requestedLocalIso", message: "Invalid local time — expected YYYY-MM-DDTHH:mm." }]);
  }
  const [, y, mo, d, hh, mm, ss] = m;
  // Compute the UTC instant that would render as those wall-clock
  // components in `tz`. Iterative: guess UTC (as if it were UTC),
  // then adjust by the tz offset at that instant.
  const guess = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss ?? "0")));
  const offsetAtGuess = tzOffsetMs(guess, iana);
  const adjusted = new Date(guess.getTime() - offsetAtGuess);
  // Cross-check: at the adjusted instant, what wall clock does the
  // tz show? If it doesn't match, the requested instant is ambiguous
  // (fall-back DST) or nonexistent (spring-forward gap) — reject
  // rather than silently shift (§33).
  const check = formatInTz(adjusted, iana);
  const want = `${y}-${mo}-${d} ${hh}:${mm}`;
  if (check !== want) {
    throw new ValidationError([{
      path: "requestedLocalIso",
      message: "That local time is ambiguous or nonexistent in your Club's timezone (daylight-saving change). Please choose a different minute.",
    }]);
  }
  return adjusted;
}
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const mo = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  const ss = Number(parts.find((p) => p.type === "second")!.value);
  const asUtc = Date.UTC(y, mo - 1, d, hh, mm, ss);
  return asUtc - at.getTime();
}
function formatInTz(at: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const y = parts.find((p) => p.type === "year")!.value;
  const mo = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const hh = parts.find((p) => p.type === "hour")!.value;
  const mm = parts.find((p) => p.type === "minute")!.value;
  return `${y}-${mo}-${d} ${hh}:${mm}`;
}

// -------------------------------------------------------------------
// Submit
// -------------------------------------------------------------------
export interface SubmitCorrectionInput {
  requestType:         CorrectionRequestType;
  originalClockEventId?: string | null;
  /** Local time interpreted in the Club's timezone. */
  requestedLocalIso?:  string | null;
  reason:              string;
  employmentAssignmentId?: string | null;
}

export interface CorrectionRequestRow {
  id:                    string;
  clubId:                string;
  employeeId:            string;
  originalClockEventId:  string | null;
  requestType:           CorrectionRequestType;
  requestedOccurredAt:   Date | null;
  employmentAssignmentId: string | null;
  reason:                string;
  status:                CorrectionStatus;
  createdAt:             Date;
  updatedAt:             Date;
}

export async function submitCorrectionRequest(
  principal: EmployeePortalPrincipal,
  input: SubmitCorrectionInput,
): Promise<{ request: CorrectionRequestRow; idempotent: boolean }> {
  // Basic validation.
  if (!CORRECTION_REQUEST_TYPES.includes(input.requestType)) {
    throw new ValidationError([{
      path: "requestType",
      message: `must be one of ${CORRECTION_REQUEST_TYPES.join(", ")}`,
    }]);
  }
  const reason = (input.reason ?? "").trim().replace(/[<>]/g, "");
  if (!reason) {
    throw new ValidationError([{ path: "reason", message: "Reason is required." }]);
  }
  if (reason.length > REASON_MAX) {
    throw new ValidationError([{ path: "reason", message: `Reason must be ≤ ${REASON_MAX} characters.` }]);
  }

  // Original event → must belong to this employee if given (never
  // trust cross-employee references).
  let originalClockEventId: string | null = null;
  if (input.originalClockEventId) {
    const orig = await prisma.timeClockEvent.findFirst({
      where: {
        id: input.originalClockEventId,
        clubId: principal.clubId,
        employeeId: principal.employeeId,
      },
      select: { id: true },
    });
    if (!orig) {
      throw new ForbiddenError("Original clock event is not yours.");
    }
    originalClockEventId = orig.id;
  }

  // Convert requestedLocalIso → UTC via Club timezone. §32.
  let requestedOccurredAt: Date | null = null;
  if (input.requestedLocalIso) {
    const club = await prisma.club.findUnique({
      where: { id: principal.clubId }, select: { timezone: true },
    });
    requestedOccurredAt = requestedLocalToUtc(input.requestedLocalIso, club?.timezone ?? null);
  }

  // Add-missing types require a requested time.
  if (
    (input.requestType === "ADD_MISSING_CLOCK_IN" ||
     input.requestType === "ADD_MISSING_CLOCK_OUT") &&
    !requestedOccurredAt
  ) {
    throw new ValidationError([{
      path: "requestedLocalIso",
      message: "A proposed time is required for this correction type.",
    }]);
  }
  // Correct-existing types require an original event id.
  if (
    (input.requestType === "CORRECT_CLOCK_IN" ||
     input.requestType === "CORRECT_CLOCK_OUT" ||
     input.requestType === "CORRECT_BREAK_START" ||
     input.requestType === "CORRECT_BREAK_END") &&
    !originalClockEventId
  ) {
    throw new ValidationError([{
      path: "originalClockEventId",
      message: "An original clock event is required for a correction of an existing punch.",
    }]);
  }

  // Assignment must belong to the employee if given.
  let employmentAssignmentId: string | null = null;
  if (input.employmentAssignmentId) {
    const assn = await prisma.employeeEmploymentAssignment.findFirst({
      where: {
        id: input.employmentAssignmentId,
        clubId: principal.clubId, employeeId: principal.employeeId,
      },
      select: { id: true },
    });
    if (!assn) {
      throw new ValidationError([{
        path: "employmentAssignmentId",
        message: "Not your assignment.",
      }]);
    }
    employmentAssignmentId = assn.id;
  }

  // Insert with unique-collision idempotency. If a PENDING request
  // for the same (type, original event) already exists, the DB
  // unique fires and we swallow it → treat as idempotent success.
  try {
    const created = await prisma.timeClockCorrectionRequest.create({
      data: {
        clubId: principal.clubId,
        employeeId: principal.employeeId,
        originalClockEventId,
        requestType: input.requestType,
        requestedOccurredAt,
        employmentAssignmentId,
        reason,
        status: "PENDING",
      },
    });
    await audit(null, {
      clubId: principal.clubId,
      action: "timeclock.correction.submit",
      entityType: "TimeClockCorrectionRequest",
      entityId: created.id,
      after: {
        requestType: input.requestType,
        originalClockEventId,
        requestedOccurredAt: requestedOccurredAt?.toISOString() ?? null,
      },
    });
    // Payroll-3D-3B Slice 2 — post-commit orchestration for the
    // manager correction-review Work Intake obligation. Awaited so
    // any inline failure lands as a durable BackgroundJob (rather
    // than silently fire-and-forget). The correction itself is
    // already committed and correct; a WI failure never rolls it
    // back. Do NOT surface WI infrastructure detail to the employee
    // UI — the returned shape is unchanged.
    await orchestrateCorrectionReviewWorkItem(principal.clubId, created.id);
    return { request: toRow(created), idempotent: false };
  } catch (err) {
    // P2002 = unique constraint violation.
    if (isP2002(err)) {
      const existing = await prisma.timeClockCorrectionRequest.findFirst({
        where: {
          employeeId: principal.employeeId,
          requestType: input.requestType,
          originalClockEventId,
          status: "PENDING",
        },
      });
      if (existing) {
        // The idempotent-submit branch still needs to guarantee the
        // manager card exists — a prior submission may have committed
        // the correction but crashed before orchestration.
        await orchestrateCorrectionReviewWorkItem(principal.clubId, existing.id);
        return { request: toRow(existing), idempotent: true };
      }
    }
    throw err;
  }
}

// -------------------------------------------------------------------
// Payroll-3D-3B Slice 2 — post-commit Work Intake orchestration
// with durable recovery.
//
// Contract:
//   1. Await the inline ensure. Best case: the manager review card
//      (or config-gap card) is created before this function returns.
//   2. On any inline failure: log structured error + enqueue a
//      durable BackgroundJob (kind ENSURE_TIMECLOCK_CORRECTION_REVIEW_WI)
//      so the worker sweeps it up. Idempotency key is deterministic
//      per correction — repeated failures collapse to one job.
//   3. Never rethrow. The correction is already durably committed;
//      failing here would mislead the employee into thinking their
//      correction wasn't accepted.
// -------------------------------------------------------------------
async function orchestrateCorrectionReviewWorkItem(
  clubId: string, correctionRequestId: string,
): Promise<void> {
  try {
    await ensureCorrectionReviewWorkItems({ clubId, correctionRequestId });
  } catch (err) {
    logger.error("payroll.correction_review.orchestrate_failed", {
      clubId, correctionRequestId,
      obligationKind: "TIMECLOCK_CORRECTION_REVIEW",
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await enqueue({
        kind: "ENSURE_TIMECLOCK_CORRECTION_REVIEW_WI",
        clubId,
        payload: { clubId, correctionRequestId },
        idempotencyKey: `ensure-tccr-wi:${clubId}:${correctionRequestId}`,
        maxAttempts: 5,
      });
    } catch (enqueueErr) {
      // Even the enqueue failed — worst case. Log loudly so a
      // sweeper (Slice 3+ or ops) can pick this up.
      logger.error("payroll.correction_review.enqueue_failed", {
        clubId, correctionRequestId,
        obligationKind: "TIMECLOCK_CORRECTION_REVIEW",
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
    }
  }
}

// -------------------------------------------------------------------
// Cancel
// -------------------------------------------------------------------
export async function cancelCorrectionRequest(
  principal: EmployeePortalPrincipal,
  requestId: string,
): Promise<CorrectionRequestRow> {
  const row = await prisma.timeClockCorrectionRequest.findUnique({ where: { id: requestId } });
  if (!row) throw new NotFoundError("TimeClockCorrectionRequest", requestId);
  if (row.clubId !== principal.clubId || row.employeeId !== principal.employeeId) {
    throw new ForbiddenError("Not your correction request.");
  }
  if (row.status !== "PENDING") {
    throw new ConflictError(`Correction request is ${row.status}, not PENDING.`);
  }
  const updated = await prisma.timeClockCorrectionRequest.update({
    where: { id: row.id }, data: { status: "CANCELLED", updatedAt: new Date() },
  });
  await audit(null, {
    clubId: principal.clubId,
    action: "timeclock.correction.cancel",
    entityType: "TimeClockCorrectionRequest",
    entityId: row.id,
    before: { status: "PENDING" }, after: { status: "CANCELLED" },
  });
  return toRow(updated);
}

// -------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------
export async function listMyCorrectionRequests(
  principal: EmployeePortalPrincipal,
  opts?: { status?: CorrectionStatus | "ALL"; limit?: number },
): Promise<CorrectionRequestRow[]> {
  const status = opts?.status ?? "PENDING";
  const rows = await prisma.timeClockCorrectionRequest.findMany({
    where: {
      clubId: principal.clubId, employeeId: principal.employeeId,
      ...(status === "ALL" ? {} : { status }),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts?.limit ?? 20, 1), 100),
  });
  return rows.map(toRow);
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
function isP2002(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: string; name?: string };
  return anyErr.code === "P2002" || anyErr.name === "PrismaClientKnownRequestError";
}
function toRow(r: {
  id: string; clubId: string; employeeId: string;
  originalClockEventId: string | null;
  requestType: string; requestedOccurredAt: Date | null;
  employmentAssignmentId: string | null; reason: string; status: string;
  createdAt: Date; updatedAt: Date;
}): CorrectionRequestRow {
  return {
    id: r.id, clubId: r.clubId, employeeId: r.employeeId,
    originalClockEventId: r.originalClockEventId,
    requestType: r.requestType as CorrectionRequestType,
    requestedOccurredAt: r.requestedOccurredAt,
    employmentAssignmentId: r.employmentAssignmentId,
    reason: r.reason,
    status: r.status as CorrectionStatus,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/* Unused import guard — keep TransactionClient available for
 * future 3D-3 approval flow additions. */
export type _TxClient = PrismaTypes.TransactionClient;

// ===================================================================
// Payroll-3D-3 (2026-09-05) — Manager approve/reject.
//
// A correction request is decided by the manager responsible for the
// work scope (department) the correction affects. On APPROVE:
//   • original TimeClockEvent is preserved (immutable history);
//   • CORRECT_CLOCK_* → a NEW event is created with
//     source=ADMIN_CORRECTION and the original event's
//     supersededByEventId is pointed at the new one;
//   • ADD_MISSING_CLOCK_* → a NEW event is created (nothing to supersede);
//   • the correction row transitions PENDING → APPROVED with the
//     reviewer's userId + timestamp;
//   • the affected pay-period timesheet is re-materialised.
// On REJECT: no event changes; row transitions to REJECTED.
//
// Concurrency: the PENDING → APPROVED / REJECTED transition uses a
// compare-and-swap via `updateMany({ where: { status: "PENDING" }})`;
// the loser sees zero rows updated and rereads the canonical state.
// A duplicate ADMIN_CORRECTION event cannot occur.
//
// Authorization: caller MUST hold `payroll:timesheets:approve` AND
// must be the resolved DEPARTMENT_TIME_APPROVAL owner for the scope
// the correction affects — unless they are a tenant-scoped payroll
// admin (see manager-approval.ts § scope-authorization).
// ===================================================================

export type CorrectionDecision = "APPROVED" | "REJECTED";

export interface ManagerCorrectionDecisionInput {
  requestId:     string;
  reviewerNote?: string | null;
}

export interface ManagerCorrectionDecisionResult {
  request:              CorrectionRequestRow;
  createdResolutionEventId: string | null;
  supersededOriginalEventId: string | null;
  rematerialised:       boolean;
  rematerialiseSummary: {
    payPeriodId: string;
    timesheetId: string | null;
    entryCount:  number;
  } | null;
}

async function assertCorrectionScopeAuthorization(
  principal: Principal,
  clubId: string,
  correctionScopeDepartmentId: string | null,
): Promise<void> {
  if (!hasPermission(principal, clubId, "payroll:timesheets:approve")) {
    throw new ForbiddenError("You do not have permission to review timesheet correction requests.");
  }
  // Tenant-scoped payroll admins pass the scope check.
  const isTenantScoped =
    hasPermission(principal, clubId, "payroll:write") ||
    hasPermission(principal, clubId, "payroll:employees:manage");
  if (isTenantScoped) return;

  if (!correctionScopeDepartmentId) {
    // A correction with no scope-derivable department can only be
    // decided by a tenant-scoped admin (fail closed).
    throw new ForbiddenError("This correction has no derivable department scope — only a Payroll Administrator can decide it.");
  }
  const ownerUserId = await resolveDepartmentTimeApprover(clubId, correctionScopeDepartmentId);
  if (ownerUserId !== principal.id) {
    throw new ForbiddenError("You are not the assigned Timesheet Approver for this department scope.");
  }
}

export async function resolveCorrectionScope(
  clubId: string,
  correction: {
    id: string;
    employmentAssignmentId: string | null;
    originalClockEventId:   string | null;
  },
): Promise<{ departmentId: string | null; employeeId: string; assignmentId: string | null }> {
  // TimeClockCorrectionRequest.employmentAssignmentId is a scalar
  // (no relation on the model). Do a two-step resolution.
  const row = await prisma.timeClockCorrectionRequest.findFirst({
    where: { id: correction.id, clubId },
    select: {
      employeeId: true,
      employmentAssignmentId: true,
      originalClockEvent: { select: { employmentAssignmentId: true } },
    },
  });
  if (!row) throw new NotFoundError("TimeClockCorrectionRequest", correction.id);
  const assignmentId =
    row.employmentAssignmentId
    ?? row.originalClockEvent?.employmentAssignmentId
    ?? null;
  let departmentId: string | null = null;
  if (assignmentId) {
    const assn = await prisma.employeeEmploymentAssignment.findFirst({
      where: { id: assignmentId, clubId },
      select: { departmentId: true },
    });
    departmentId = assn?.departmentId ?? null;
  }
  return { departmentId, employeeId: row.employeeId, assignmentId };
}

export async function approveCorrectionRequest(
  principal: Principal,
  clubId: string,
  input: ManagerCorrectionDecisionInput,
): Promise<ManagerCorrectionDecisionResult> {
  const existing = await prisma.timeClockCorrectionRequest.findFirst({
    where: { id: input.requestId, clubId },
  });
  if (!existing) throw new NotFoundError("TimeClockCorrectionRequest", input.requestId);
  if (existing.status !== "PENDING") {
    throw new ConflictError(`Correction request is ${existing.status}, not PENDING.`);
  }
  const scope = await resolveCorrectionScope(clubId, existing);
  await assertCorrectionScopeAuthorization(principal, clubId, scope.departmentId);

  const reviewerNote = (input.reviewerNote ?? "").trim().replace(/[<>]/g, "").slice(0, 500) || null;
  const now = new Date();
  const requestedAt = existing.requestedOccurredAt ?? null;

  // CAS: the atomic transition ensures parallel approvals collapse to
  // exactly one final decision.
  const result = await prisma.$transaction(async (tx) => {
    const cas = await tx.timeClockCorrectionRequest.updateMany({
      where: { id: existing.id, status: "PENDING" },
      data:  { status: "APPROVED", reviewedAt: now, reviewedByUserId: principal.id, reviewerNote },
    });
    if (cas.count === 0) {
      const cur = await tx.timeClockCorrectionRequest.findUnique({ where: { id: existing.id } });
      throw new ConflictError(`Correction request already ${cur?.status ?? "resolved"}.`);
    }

    let createdResolutionEventId: string | null = null;
    let supersededOriginalEventId: string | null = null;

    if (existing.requestType === "CORRECT_CLOCK_IN"
     || existing.requestType === "CORRECT_CLOCK_OUT"
     || existing.requestType === "CORRECT_BREAK_START"
     || existing.requestType === "CORRECT_BREAK_END") {
      if (!existing.originalClockEventId || !requestedAt) {
        throw new ConflictError("CORRECT_* correction requires original event + requestedOccurredAt.");
      }
      const original = await tx.timeClockEvent.findFirst({
        where: { id: existing.originalClockEventId, clubId },
      });
      if (!original) throw new NotFoundError("TimeClockEvent", existing.originalClockEventId);
      const newEvent = await tx.timeClockEvent.create({
        data: {
          clubId, employeeId: existing.employeeId,
          kind: original.kind,
          occurredAt: requestedAt,
          source: "ADMIN_CORRECTION",
          employmentAssignmentId: scope.assignmentId ?? original.employmentAssignmentId,
          notes: reviewerNote,
        },
      });
      // Point original at the resolution — additive supersession.
      await tx.timeClockEvent.update({
        where: { id: original.id },
        data:  { supersededByEventId: newEvent.id },
      });
      await tx.timeClockCorrectionRequest.update({
        where: { id: existing.id }, data: { resolutionClockEventId: newEvent.id },
      });
      createdResolutionEventId  = newEvent.id;
      supersededOriginalEventId = original.id;
    } else if (existing.requestType === "ADD_MISSING_CLOCK_IN"
            || existing.requestType === "ADD_MISSING_CLOCK_OUT") {
      if (!requestedAt) throw new ConflictError("ADD_MISSING_* correction requires requestedOccurredAt.");
      const kind = existing.requestType === "ADD_MISSING_CLOCK_IN" ? "CLOCK_IN" : "CLOCK_OUT";
      const newEvent = await tx.timeClockEvent.create({
        data: {
          clubId, employeeId: existing.employeeId,
          kind,
          occurredAt: requestedAt,
          source: "ADMIN_CORRECTION",
          employmentAssignmentId: scope.assignmentId,
          notes: reviewerNote,
        },
      });
      await tx.timeClockCorrectionRequest.update({
        where: { id: existing.id }, data: { resolutionClockEventId: newEvent.id },
      });
      createdResolutionEventId = newEvent.id;
    }

    return { createdResolutionEventId, supersededOriginalEventId };
  }, { timeout: 20_000, maxWait: 5_000 });

  const finalRow = await prisma.timeClockCorrectionRequest.findUniqueOrThrow({
    where: { id: existing.id },
  });

  // Rematerialise the affected pay period's timesheet(s). We locate
  // the period containing the correction's operative moment.
  let rematerialiseSummary: ManagerCorrectionDecisionResult["rematerialiseSummary"] = null;
  const rematerialiseInstant = requestedAt ?? existing.createdAt;
  const period = await prisma.payrollPayPeriod.findFirst({
    where: {
      clubId,
      periodStart: { lte: rematerialiseInstant },
      periodEnd:   { gt:  rematerialiseInstant },
    },
    orderBy: { periodStart: "desc" },
  });
  if (period) {
    // Capture the pre-rematerialise frozen state for retro detection.
    const preFrozen = await prisma.payrollApprovedTimeEntry.findMany({
      where: {
        clubId, employeeId: existing.employeeId,
        payrollTimesheetEntry: { timesheet: { payPeriodId: period.id } },
      },
      select: {
        id: true, hours: true, workDate: true, employmentAssignmentId: true,
        consumedByBatchId: true, payrollTimesheetEntryId: true,
        supersededByApprovedTimeEntryId: true,
      },
    });

    const r = await materializeEmployeeTimesheet(clubId, existing.employeeId, period.id);
    rematerialiseSummary = {
      payPeriodId: period.id,
      timesheetId: r.timesheetId,
      entryCount:  r.entriesUpserted,
    };

    // Payroll-3D-4 (§32, §33, §68, §69, §70) — retro / stale handling.
    // For every previously-frozen row (with a mapped source timesheet
    // entry), compare its hours to the freshly-materialised timesheet
    // entry hours. If different:
    //   • consumed row  → cannot mutate. Create signed
    //                     PayrollTimeAdjustment(reason=RETRO_CORRECTION).
    //   • unconsumed row → mark SUPERSEDED_STALE so batch prep skips
    //                     it. Manager must re-attest + refreeze.
    for (const pf of preFrozen) {
      if (!pf.payrollTimesheetEntryId) continue;
      if (pf.supersededByApprovedTimeEntryId) continue;
      const currentEntry = await prisma.payrollTimesheetEntry.findUnique({
        where: { id: pf.payrollTimesheetEntryId },
        select: { id: true, recordedSeconds: true, workDate: true, employmentAssignmentId: true },
      });
      if (!currentEntry) continue;
      const currentHours = currentEntry.recordedSeconds / 3600;
      const priorHours   = Number(pf.hours.toString());
      const diff = currentHours - priorHours;
      const changed = Math.abs(diff) > 1 / 3600; // > 1s difference is real
      if (!changed) continue;

      if (pf.consumedByBatchId) {
        // §33 — historical row is immutable. Create signed adjustment.
        const currentPeriod = await prisma.payrollPayPeriod.findUniqueOrThrow({
          where: { id: period.id },
          select: { payGroupId: true, periodStart: true },
        });
        const nextPeriod = await prisma.payrollPayPeriod.findFirst({
          where: {
            clubId, payGroupId: currentPeriod.payGroupId,
            periodStart: { gt: currentPeriod.periodStart },
            status: { in: ["FUTURE", "OPEN"] },
          },
          orderBy: { periodStart: "asc" },
          select: { id: true },
        });
        await prisma.payrollTimeAdjustment.create({
          data: {
            clubId,
            employeeId: existing.employeeId,
            employmentAssignmentId: currentEntry.employmentAssignmentId ?? null,
            payPeriodId: period.id,
            targetPayPeriodId: nextPeriod?.id ?? null,
            sourceTimesheetEntryId: currentEntry.id,
            originalApprovedTimeEntryId: pf.id,
            reason: "RETRO_CORRECTION",
            differenceHours: diff,
            status: "OPEN",
            createdByUserId: principal.id,
            notes: `correction:${existing.id} approval:${(await prisma.payrollDepartmentTimeApproval.findFirst({ where: { clubId, payPeriodId: period.id, departmentId: scope.departmentId ?? undefined } }))?.id ?? "n/a"}`,
          },
        });
      } else {
        // §32, §70 — unconsumed stale. Mark superseded so batch prep skips.
        await prisma.payrollApprovedTimeEntry.update({
          where: { id: pf.id },
          data:  { approvalState: "SUPERSEDED_STALE" },
        });
      }
    }

    // §35 / §91 — an approved correction may have shifted the
    // scope's revision. If an APPROVED PayrollDepartmentTimeApproval
    // already exists for the scope, move it to REVIEW_REQUIRED and
    // reopen the WI card so the manager can re-attest.
    if (scope.departmentId) {
      await invalidateApprovalIfDrifted(clubId, period.id, scope.departmentId);
    }
  }

  await audit(principal, {
    clubId,
    action: "timeclock.correction.approve",
    entityType: "TimeClockCorrectionRequest",
    entityId: existing.id,
    before: { status: "PENDING" },
    after: {
      status: "APPROVED",
      resolutionEventId: result.createdResolutionEventId,
      supersededOriginalEventId: result.supersededOriginalEventId,
      reviewerNote,
    },
  });

  return {
    request: toRow(finalRow),
    createdResolutionEventId:  result.createdResolutionEventId,
    supersededOriginalEventId: result.supersededOriginalEventId,
    rematerialised: !!rematerialiseSummary,
    rematerialiseSummary,
  };
}

export async function rejectCorrectionRequest(
  principal: Principal,
  clubId: string,
  input: ManagerCorrectionDecisionInput,
): Promise<ManagerCorrectionDecisionResult> {
  const existing = await prisma.timeClockCorrectionRequest.findFirst({
    where: { id: input.requestId, clubId },
  });
  if (!existing) throw new NotFoundError("TimeClockCorrectionRequest", input.requestId);
  if (existing.status !== "PENDING") {
    throw new ConflictError(`Correction request is ${existing.status}, not PENDING.`);
  }
  const scope = await resolveCorrectionScope(clubId, existing);
  await assertCorrectionScopeAuthorization(principal, clubId, scope.departmentId);

  const reviewerNote = (input.reviewerNote ?? "").trim().replace(/[<>]/g, "").slice(0, 500) || null;
  const now = new Date();

  const cas = await prisma.timeClockCorrectionRequest.updateMany({
    where: { id: existing.id, status: "PENDING" },
    data:  { status: "REJECTED", reviewedAt: now, reviewedByUserId: principal.id, reviewerNote },
  });
  if (cas.count === 0) {
    const cur = await prisma.timeClockCorrectionRequest.findUnique({ where: { id: existing.id } });
    throw new ConflictError(`Correction request already ${cur?.status ?? "resolved"}.`);
  }
  const finalRow = await prisma.timeClockCorrectionRequest.findUniqueOrThrow({
    where: { id: existing.id },
  });
  await audit(principal, {
    clubId,
    action: "timeclock.correction.reject",
    entityType: "TimeClockCorrectionRequest",
    entityId: existing.id,
    before: { status: "PENDING" },
    after:  { status: "REJECTED", reviewerNote },
  });
  // Payroll-3D-3B Slice 3 (2026-09-06) — rejecting a correction may
  // unblock a department scope that was gated on pendingCorrectionCount
  // > 0. Proactively orchestrate the approval WI so the manager sees
  // the transition without needing to visit Payroll Time. Awaited +
  // durable-recovery via the same seam used post-materialise.
  const affectedInstant =
    existing.requestedOccurredAt ?? existing.createdAt;
  const affectedPeriod = await prisma.payrollPayPeriod.findFirst({
    where: {
      clubId,
      periodStart: { lte: affectedInstant },
      periodEnd:   { gt:  affectedInstant },
    },
    orderBy: { periodStart: "desc" },
    select: { id: true },
  });
  if (affectedPeriod) {
    const { orchestrateTimesheetApprovalWorkItem } = await import(
      "../work-intake/timesheet-approval-orchestration"
    );
    await orchestrateTimesheetApprovalWorkItem(clubId, affectedPeriod.id, scope.departmentId);
  }
  return {
    request: toRow(finalRow),
    createdResolutionEventId: null,
    supersededOriginalEventId: null,
    rematerialised: false,
    rematerialiseSummary: null,
  };
}
