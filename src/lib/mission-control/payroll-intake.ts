// Payroll MVP posting (2026-09-05) — Mission Control loader that
// surfaces Payroll-domain Work Intake cards in the founder's feed.
//
// Payroll-3D-3B Slice 6 (2026-09-06) — the loader now also produces
// the rich `payrollCard` projection for correction-review and
// timesheet-approval obligations so <PayrollActionCard> can render
// them with full canonical context. Non-payroll-action subtypes
// continue to project as deep-link-only <FeedItem> rows.

import { prisma } from "../prisma";
import type { WorkItem, PayrollWorkIntakeCard } from "./index";
import { resolvePayrollWorkIntakeDeepLink } from "../payroll/work-intake-deep-link";
import { getScopeReview } from "../timesheets/approval-scope";
import type { Principal } from "../rbac";

export interface LoadPayrollAdminIntakeArgs {
  principal: Principal;
  clubId: string;
  now: Date;
}

const HIDDEN_STATUSES = ["RESOLVED", "SUPPRESSED"];

function relTime(now: Date, then: Date): string {
  const diffMs = now.getTime() - then.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString();
}

/**
 * Load Payroll-domain Work Intake cards the signed-in user owns.
 * Emits one WorkItem per card. When the card is a supported payroll
 * action obligation (correction review, timesheet approval, or their
 * config-gap siblings), the rich `payrollCard` projection is attached
 * so Mission Control dispatches to <PayrollActionCard>.
 */
export async function loadPayrollAdminIntakeItems(
  args: LoadPayrollAdminIntakeArgs,
): Promise<WorkItem[]> {
  const { principal, clubId, now } = args;

  const items = await prisma.workIntakeItem.findMany({
    where: {
      clubId,
      workDomain: "PAYROLL",
      ownerUserId: principal.id,
      status: { notIn: HIDDEN_STATUSES },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (items.length === 0) return [];

  const origins = await prisma.workIntakeOrigin.findMany({
    where: {
      clubId,
      role: "PRIMARY",
      workIntakeItemId: { in: items.map((i) => i.id) },
    },
    select: { workIntakeItemId: true, kind: true, referenceId: true },
  });
  const originByItem = new Map(origins.map((o) => [o.workIntakeItemId, { kind: o.kind, referenceId: o.referenceId }]));

  const results: WorkItem[] = [];
  for (const wi of items) {
    const origin = originByItem.get(wi.id) ?? null;
    const deep = origin
      ? resolvePayrollWorkIntakeDeepLink(wi.workSubtype ?? origin.kind, origin.referenceId)
      : null;
    const state: WorkItem["state"] = wi.workIntent === "APPROVE" ? "approval" : "judgment";

    // Slice 6 rich card projection.
    const payrollCard = origin
      ? await buildPayrollCardProjection({ clubId, workIntakeItemId: wi.id, origin, deep })
      : null;

    // For payrollCard-backed items the card component renders its
    // own primary action; the WorkItem.actions array only carries the
    // secondary deep-link so the fallback renderer works if the client
    // dispatch tree somehow misses the payroll variant.
    const actions: WorkItem["actions"] = payrollCard && deep
      ? [{ key: "deep_link", label: deep.label, kind: "secondary" as const, href: deep.href }]
      : [
        deep
          ? { key: "review_payroll", label: deep.label, kind: "primary" as const, href: deep.href }
          : { key: "review_payroll", label: "Open payroll", kind: "primary" as const },
      ];

    results.push({
      id: `wi-${wi.id}`,
      state,
      idTag: `PAY-${wi.id.slice(0, 6).toUpperCase()}`,
      title: wi.displaySubject,
      sender: {
        from: wi.displaySender,
        ctx: `Received ${relTime(now, wi.displayReceivedAt)}`,
      },
      timestamp: wi.createdAt.toISOString(),
      timestampLabel: relTime(now, wi.createdAt),
      recommendation: undefined,
      readout: [],
      actions,
      workIntakeItemId: wi.id,
      workDomain: "PAYROLL",
      workIntent: wi.workIntent ?? undefined,
      workSubtype: wi.workSubtype ?? undefined,
      workIntakeStatus: wi.status,
      workIntakeCreatedAt: wi.createdAt.toISOString(),
      sortTimestamp: wi.createdAt.toISOString(),
      payrollCard: payrollCard ?? undefined,
    });
  }
  return results;
}

// -------------------------------------------------------------------
// Card projection — one function, dispatches on origin.kind. Every
// value assembled here comes from canonical services / joins. UI code
// downstream does zero payroll math.
// -------------------------------------------------------------------

async function buildPayrollCardProjection(args: {
  clubId: string;
  workIntakeItemId: string;
  origin: { kind: string; referenceId: string };
  deep: { href: string; label: string } | null;
}): Promise<PayrollWorkIntakeCard | null> {
  const { clubId, workIntakeItemId, origin, deep } = args;

  switch (origin.kind) {
    case "TIMECLOCK_CORRECTION_REVIEW":
      return buildCorrectionCard({ clubId, workIntakeItemId, correctionRequestId: origin.referenceId, deep });
    case "PAYROLL_TIMESHEET_APPROVAL":
      return buildScopeCard({ clubId, workIntakeItemId, referenceId: origin.referenceId, deep });
    case "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP":
      return buildCorrectionGapCard({ clubId, workIntakeItemId, referenceId: origin.referenceId, deep });
    case "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP":
      return buildScopeGapCard({ clubId, workIntakeItemId, referenceId: origin.referenceId, deep });
    default:
      return null;
  }
}

// -------------------------------------------------------------------
// Correction review card
// -------------------------------------------------------------------

const CORRECTION_TYPE_LABELS: Record<string, string> = {
  ADD_MISSING_CLOCK_IN:  "Missing Clock In",
  ADD_MISSING_CLOCK_OUT: "Missing Clock Out",
  CORRECT_CLOCK_IN:      "Correct Clock In",
  CORRECT_CLOCK_OUT:     "Correct Clock Out",
  CORRECT_BREAK_START:   "Correct Break Start",
  CORRECT_BREAK_END:     "Correct Break End",
};

async function buildCorrectionCard(args: {
  clubId: string;
  workIntakeItemId: string;
  correctionRequestId: string;
  deep: { href: string; label: string } | null;
}): Promise<PayrollWorkIntakeCard | null> {
  const c = await prisma.timeClockCorrectionRequest.findFirst({
    where: { id: args.correctionRequestId, clubId: args.clubId },
    select: {
      id: true, employeeId: true, employmentAssignmentId: true,
      originalClockEventId: true, requestType: true,
      requestedOccurredAt: true, reason: true, createdAt: true,
    },
  });
  if (!c) return null;

  const [employee, assignment, originalEvent] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: c.employeeId, clubId: args.clubId },
      select: { firstName: true, lastName: true, employeeNumber: true },
    }),
    c.employmentAssignmentId
      ? prisma.employeeEmploymentAssignment.findFirst({
          where: { id: c.employmentAssignmentId, clubId: args.clubId },
          select: { departmentId: true, department: { select: { name: true } } },
        })
      : Promise.resolve(null),
    c.originalClockEventId
      ? prisma.timeClockEvent.findFirst({
          where: { id: c.originalClockEventId, clubId: args.clubId },
          select: { kind: true, occurredAt: true, employmentAssignmentId: true },
        })
      : Promise.resolve(null),
  ]);

  // Fallback to the original-clock-event's assignment department if
  // correction.employmentAssignmentId is null.
  let departmentId: string | null = assignment?.departmentId ?? null;
  let departmentName: string | null = assignment?.department?.name ?? null;
  if (!departmentName && originalEvent?.employmentAssignmentId) {
    const evAssn = await prisma.employeeEmploymentAssignment.findFirst({
      where: { id: originalEvent.employmentAssignmentId, clubId: args.clubId },
      select: { departmentId: true, department: { select: { name: true } } },
    });
    departmentId = evAssn?.departmentId ?? null;
    departmentName = evAssn?.department?.name ?? null;
  }

  const employeeName = employee ? `${employee.firstName} ${employee.lastName}`.trim() : "Employee";
  const workDate = c.requestedOccurredAt ?? originalEvent?.occurredAt ?? c.createdAt;
  const originalTimeLabel = originalEvent
    ? `${prettyClockKind(originalEvent.kind)} at ${formatTimeShort(originalEvent.occurredAt)}`
    : null;
  const requestedTimeLabel = c.requestedOccurredAt ? formatTimeShort(c.requestedOccurredAt) : null;

  // Slice 6A — build the deep-link from the correction's canonical
  // context so the target page's existing ?payPeriodId=&departmentId=
  // handlers pick it up. The bare deep-link resolver returns null for
  // TIMECLOCK_CORRECTION_REVIEW (audited: the workspace page does
  // NOT read a correctionRequestId query param). We resolve the pay
  // period that contains the correction's operative moment — same
  // logic the correction service itself uses at approval time.
  let correctionDeep: { href: string; label: string } | null = args.deep;
  if (!correctionDeep && departmentId) {
    const period = await prisma.payrollPayPeriod.findFirst({
      where: {
        clubId: args.clubId,
        periodStart: { lte: workDate },
        periodEnd:   { gt:  workDate },
      },
      orderBy: { periodStart: "desc" },
      select: { id: true },
    });
    if (period) {
      const qs = new URLSearchParams({
        payPeriodId: period.id,
        departmentId,
        scope: "timesheet",
      }).toString();
      correctionDeep = {
        href:  `/app/admin/payroll/time?${qs}`,
        label: "View timesheet",
      };
    }
  }

  return {
    kind: "correction",
    workIntakeItemId: args.workIntakeItemId,
    correctionRequestId: c.id,
    employeeName,
    employeeNumber: employee?.employeeNumber ?? null,
    departmentName,
    workDateIso: workDate.toISOString(),
    correctionTypeLabel: CORRECTION_TYPE_LABELS[c.requestType] ?? c.requestType,
    originalTimeLabel,
    requestedTimeLabel,
    reason: c.reason,
    deepLink: correctionDeep,
  };
}

function prettyClockKind(kind: string): string {
  switch (kind) {
    case "CLOCK_IN":    return "Clocked in";
    case "CLOCK_OUT":   return "Clocked out";
    case "BREAK_START": return "Break start";
    case "BREAK_END":   return "Break end";
    default:            return kind;
  }
}
function formatTimeShort(d: Date): string {
  // Render as HH:MM (24h) in UTC. The workspace deep-link presents
  // the localised precise view; the card only needs a scannable label.
  return d.toISOString().slice(11, 16);
}

// -------------------------------------------------------------------
// Timesheet-approval scope card
// -------------------------------------------------------------------

async function buildScopeCard(args: {
  clubId: string;
  workIntakeItemId: string;
  referenceId: string;
  deep: { href: string; label: string } | null;
}): Promise<PayrollWorkIntakeCard | null> {
  const [payPeriodId, departmentId] = args.referenceId.split(":");
  if (!payPeriodId || !departmentId) return null;

  const review = await getScopeReview(args.clubId, payPeriodId, departmentId).catch(() => null);
  if (!review) return null;

  const blockers = humanizeBlockers(review.readiness.blockingReasons);
  const reviewRequired =
    !!review.approval && review.approval.state === "REVIEW_REQUIRED";

  return {
    kind: "scope",
    workIntakeItemId: args.workIntakeItemId,
    payPeriodId,
    departmentId,
    departmentName: review.departmentName,
    employeeCount: review.employees.length,
    recordedHours: Math.round((review.totalRecordedSeconds / 3600) * 100) / 100,
    exceptionCount:
      review.exceptionSummary.missingClockOutCount
      + review.exceptionSummary.openBreakCount
      + review.exceptionSummary.missingAssignmentCount,
    pendingCorrectionCount: review.pendingCorrections.length,
    readinessReady: review.readiness.ready,
    blockers,
    currentRevision: review.currentRevision,
    currentScopeVersion: review.currentScopeVersion,
    reviewRequired,
    deepLink: args.deep,
  };
}

function humanizeBlockers(reasons: ReadonlyArray<{ kind: string; count: number; detail: string }>): string[] {
  return reasons.map((r) => {
    switch (r.kind) {
      case "MISSING_CLOCK_OUT":
        return r.count === 1 ? "1 missing clock-out" : `${r.count} missing clock-outs`;
      case "OPEN_BREAK":
        return r.count === 1 ? "1 unresolved open break" : `${r.count} unresolved open breaks`;
      case "MISSING_ASSIGNMENT":
        return r.count === 1 ? "1 session missing an assignment" : `${r.count} sessions missing an assignment`;
      case "PENDING_CORRECTION":
        return r.count === 1 ? "1 pending correction" : `${r.count} pending corrections`;
      default:
        return r.detail;
    }
  });
}

// -------------------------------------------------------------------
// Config-gap cards (correction + scope)
// -------------------------------------------------------------------

async function buildCorrectionGapCard(args: {
  clubId: string;
  workIntakeItemId: string;
  referenceId: string;
  deep: { href: string; label: string } | null;
}): Promise<PayrollWorkIntakeCard | null> {
  let gapReason: "MISSING_APPROVER" | "MISSING_ASSIGNMENT";
  let departmentId: string | null = null;
  let correctionRequestId: string | null = null;
  if (args.referenceId.startsWith("MISSING_APPROVER:")) {
    gapReason = "MISSING_APPROVER";
    const parts = args.referenceId.split(":");
    departmentId = parts[1] ?? null;
    correctionRequestId = parts[2] ?? null;
  } else if (args.referenceId.startsWith("MISSING_ASSIGNMENT:")) {
    gapReason = "MISSING_ASSIGNMENT";
    correctionRequestId = args.referenceId.split(":")[1] ?? null;
  } else {
    return null;
  }

  const department = departmentId
    ? await prisma.department.findFirst({
        where: { id: departmentId, clubId: args.clubId },
        select: { name: true },
      })
    : null;
  const correction = correctionRequestId
    ? await prisma.timeClockCorrectionRequest.findFirst({
        where: { id: correctionRequestId, clubId: args.clubId },
        select: {
          employee: { select: { firstName: true, lastName: true } },
        },
      })
    : null;
  const employeeName = correction?.employee
    ? `${correction.employee.firstName} ${correction.employee.lastName}`.trim()
    : null;

  return {
    kind: "correction-gap",
    workIntakeItemId: args.workIntakeItemId,
    gapReason,
    departmentName: department?.name ?? null,
    employeeName,
    deepLink: args.deep,
  };
}

async function buildScopeGapCard(args: {
  clubId: string;
  workIntakeItemId: string;
  referenceId: string;
  deep: { href: string; label: string } | null;
}): Promise<PayrollWorkIntakeCard | null> {
  const [_payPeriodId, departmentId] = args.referenceId.split(":");
  const department = departmentId
    ? await prisma.department.findFirst({
        where: { id: departmentId, clubId: args.clubId },
        select: { name: true },
      })
    : null;
  return {
    kind: "scope-gap",
    workIntakeItemId: args.workIntakeItemId,
    departmentName: department?.name ?? null,
    deepLink: args.deep,
  };
}
