// Payroll-3B-3 (2026-08-28) — Payroll → Work Intake orchestration.
//
// This service is the "system-generated Work Intake" surface for
// Payroll operational workflow. Reuses the canonical WorkIntakeItem
// + WorkIntakeOrigin + WorkIntakeActivity infrastructure — no
// parallel PayrollTasks table. Two workflow types today:
//
//   • DEPARTMENT_TIME_APPROVAL — one card per Department that has
//     payable time for a Pay Period. Owner = the Department
//     manager User (resolved from EmployeeEmploymentAssignment).
//     Idempotent: re-running orchestration for the same
//     (Club, PayPeriod, Department) does NOT create a duplicate
//     card. Completes when the department approves; reactivates
//     when the approval is reopened.
//
//   • PAYROLL_ADMIN_PROCESSING — one card per Pay Period, owned
//     by `PayrollClubConfig.payrollAdminUserId`. Created ONLY
//     after every Department with payable time has approved.
//     Does not exist yet as a working "Process Payroll" action —
//     3B-4 will wire actual batch preparation to this card.
//
// WorkIntakeOrigin.kind values (namespaced for idempotency):
//   • "PAYROLL_DEPARTMENT_APPROVAL" — refId = PayrollDepartmentTimeApproval.id
//     OR a synthetic composite `{payPeriodId}:{departmentId}` when the
//     approval row does not exist yet.
//   • "PAYROLL_ADMIN_PROCESSING" — refId = payPeriodId.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import {
  tallyDepartmentsForPeriod,
  resolveDepartmentManagerUserIds,
} from "./department-approval";

const DEPT_ORIGIN_KIND = "PAYROLL_DEPARTMENT_APPROVAL";
const ADMIN_ORIGIN_KIND = "PAYROLL_ADMIN_PROCESSING";
const REVIEW_ORIGIN_KIND = "PAYROLL_REVIEW";

export interface DepartmentOrchestrationTask {
  workIntakeItemId: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  ownerUserId: string | null;
  ownerDisplay: string;   // resolved user name/email OR "Unassigned"
  employeeCount: number;
  entryCount: number;
  totalHours: string;
  created: boolean;
  ownershipNote: string | null;   // populated when 0 or >1 managers were resolved
}

export interface OrchestrateDepartmentTasksResult {
  clubId: string;
  payPeriodId: string;
  tasks: DepartmentOrchestrationTask[];
  unresolvableDepartments: Array<{ departmentId: string; departmentCode: string; departmentName: string }>;
}

// Common display projection for Payroll-domain WI cards.
function buildDisplayProjection(args: {
  subject: string;
  preview: string;
  receivedAt: Date;
}) {
  return {
    displaySourceLabel: "Spectre Payroll",
    displaySender: "Payroll orchestration",
    displaySubject: args.subject,
    displayPreview: args.preview,
    displayReceivedAt: args.receivedAt,
    displayHasAttachments: false,
  };
}

async function ensureOriginBackedItem(args: {
  clubId: string;
  originKind: string;
  originReferenceId: string;
  workIntent: "APPROVE" | "REVIEW";
  workSubtype: string;
  ownerUserId: string | null;
  subject: string;
  preview: string;
  linkReason: string;
}): Promise<{ workIntakeItemId: string; created: boolean }> {
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId,
      kind: args.originKind,
      referenceId: args.originReferenceId,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  if (existing) {
    // Refresh owner + display projection on re-run so tally changes
    // are visible without destroying the item identity.
    await prisma.workIntakeItem.update({
      where: { id: existing.workIntakeItemId },
      data: {
        ownerUserId: args.ownerUserId,
        displaySubject: args.subject,
        displayPreview: args.preview,
        displayReceivedAt: new Date(),
      },
    });
    return { workIntakeItemId: existing.workIntakeItemId, created: false };
  }
  const now = new Date();
  const created = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId,
      status: "OPEN",
      judgmentRequired: true,
      ownerUserId: args.ownerUserId,
      classification: args.originKind,
      classificationReason: `Spectre Payroll orchestrated a ${args.workSubtype} task.`,
      classificationMethod: "RULE",
      classificationRuleKey: "payroll-orchestration.v1",
      classificationRuleVersion: 1,
      ...buildDisplayProjection({ subject: args.subject, preview: args.preview, receivedAt: now }),
      workDomain: "PAYROLL",
      workIntent: args.workIntent,
      workSubtype: args.workSubtype,
      workDomainConfidence: 1,
      workDomainClassifiedAt: now,
      workDomainClassifierVersion: "payroll-orchestration.v1",
    },
    select: { id: true },
  });
  await prisma.workIntakeOrigin.create({
    data: {
      clubId: args.clubId,
      workIntakeItemId: created.id,
      kind: args.originKind,
      referenceId: args.originReferenceId,
      role: "PRIMARY",
      linkReason: args.linkReason,
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: created.id,
      action: "MATERIALISED",
      note: args.linkReason,
    },
  });
  return { workIntakeItemId: created.id, created: true };
}

function formatHours(cents: bigint): string {
  return (Number(cents) / 10_000).toFixed(2);
}

/**
 * Founder-preview helper: materialise the Payroll Admin's
 * PAYROLL_ADMIN_PROCESSING card directly for a Pay Period that has
 * no department time approvals (e.g. an all-salaried pay group).
 *
 * The orchestrator's normal path derives readiness from department
 * tallies; a salary-only period produces no tallies and the card is
 * not created. This helper wraps the same canonical origin-backed
 * primitive so the Payroll Admin can begin the workflow from
 * Mission Control → Work Intake instead of a hidden URL.
 *
 * Idempotent — re-running against the same (clubId, payPeriodId)
 * reuses the existing card and refreshes owner + display projection.
 */
export async function ensurePayrollAdminProcessingCardForSalaryPeriod(args: {
  clubId: string;
  payPeriodId: string;
  ownerUserId: string;
  subject: string;
  preview: string;
}): Promise<{ workIntakeItemId: string; created: boolean }> {
  return ensureOriginBackedItem({
    clubId:            args.clubId,
    originKind:        ADMIN_ORIGIN_KIND,
    originReferenceId: args.payPeriodId,
    workIntent:        "REVIEW",
    workSubtype:       "PAYROLL_ADMIN_PROCESSING",
    ownerUserId:       args.ownerUserId,
    subject:           args.subject,
    preview:           args.preview,
    linkReason:        "Payroll orchestrator — salary-only pay period, direct materialisation of admin-processing card.",
  });
}

/**
 * Ensure a Work Intake card exists for every Department with payable
 * time in the given Pay Period. Idempotent: re-running with the same
 * inputs updates display + owner but does NOT create duplicates.
 *
 * Ownership resolution: if EXACTLY ONE manager can be resolved for
 * the Department, that manager owns the task. If MULTIPLE managers
 * are resolved, ownership is assigned to the lexicographically-first
 * userId and a note is emitted (§32 shared-responsibility hint —
 * a future slice can add multi-owner semantics). If ZERO managers
 * can be resolved, the Department is returned in
 * `unresolvableDepartments` — the task is created with `ownerUserId
 * = null` so the Payroll Admin sees the gap, but no false ownership
 * is fabricated.
 */
export async function orchestrateDepartmentApprovalTasks(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<OrchestrateDepartmentTasksResult> {
  // Read gate — anyone who can see payroll time may trigger a
  // re-orchestration; the tasks themselves are always tenant-scoped.
  if (!hasPermission(principal, clubId, "payroll:timesheets:read")) {
    throw new Error("Not authorized");
  }
  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { id: true, periodStart: true, periodEnd: true },
  });
  if (!period) {
    throw new Error("Pay period not found");
  }
  const tallies = await tallyDepartmentsForPeriod(clubId, payPeriodId);
  // Sort so orchestration is deterministic.
  const sorted = Array.from(tallies.values()).sort((a, b) => a.code.localeCompare(b.code));
  const tasks: DepartmentOrchestrationTask[] = [];
  const unresolvable: Array<{ departmentId: string; departmentCode: string; departmentName: string }> = [];
  for (const t of sorted) {
    const managers = await resolveDepartmentManagerUserIds(clubId, t.departmentId);
    let ownerUserId: string | null = null;
    let ownershipNote: string | null = null;
    if (managers.length === 1) {
      ownerUserId = managers[0]!;
    } else if (managers.length > 1) {
      const sortedIds = [...managers].sort();
      ownerUserId = sortedIds[0]!;
      ownershipNote = `${managers.length} eligible managers; assigned to first by userId (future: shared ownership).`;
    } else {
      unresolvable.push({ departmentId: t.departmentId, departmentCode: t.code, departmentName: t.name });
    }

    // Payroll-3B-4 linkage fix: ALWAYS use the deterministic
    // composite `${payPeriodId}:${departmentId}` as the origin
    // reference. The approval row's own id is NOT used because
    // the row does not exist until the first approve, which
    // previously required a second orchestration pass to back-
    // link. Using the composite from the start means the WI item
    // can be resolved via WorkIntakeOrigin on the FIRST approve.
    const referenceId = `${payPeriodId}:${t.departmentId}`;
    const approvalRow = await prisma.payrollDepartmentTimeApproval.findUnique({
      where: { clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId: t.departmentId } },
      select: { id: true },
    });

    const hours = formatHours(t.totalHoursCents);
    const subject = `Timesheets ready for approval — ${t.name}`;
    const preview = `${t.employeeIds.size} employee${t.employeeIds.size === 1 ? "" : "s"} · ${hours} hours`;

    const { workIntakeItemId, created } = await ensureOriginBackedItem({
      clubId,
      originKind: DEPT_ORIGIN_KIND,
      originReferenceId: referenceId,
      workIntent: "APPROVE",
      workSubtype: "DEPARTMENT_TIME_APPROVAL",
      ownerUserId,
      subject,
      preview,
      linkReason: `Payroll orchestrator — department ${t.code} for period ${payPeriodId}.`,
    });

    // If a real approval row exists, back-link the WI item id so
    // approve/reopen can find and mutate it.
    if (approvalRow && !workIntakeItemId.startsWith("dry:")) {
      await prisma.payrollDepartmentTimeApproval.update({
        where: { id: approvalRow.id },
        data: { workIntakeItemId },
      });
    }

    // Look up owner display name for the response only.
    let ownerDisplay = "Unassigned";
    if (ownerUserId) {
      const u = await prisma.user.findUnique({
        where: { id: ownerUserId },
        select: { name: true, email: true },
      });
      ownerDisplay = u?.name || u?.email || ownerUserId;
    }

    tasks.push({
      workIntakeItemId,
      departmentId: t.departmentId,
      departmentCode: t.code,
      departmentName: t.name,
      ownerUserId,
      ownerDisplay,
      employeeCount: t.employeeIds.size,
      entryCount: t.entryIds.length,
      totalHours: hours,
      created,
      ownershipNote,
    });
  }
  await audit(principal, {
    action: "payroll.orchestration.department-tasks",
    entityType: "WorkIntakeItem",
    entityId: payPeriodId,
    clubId,
    after: {
      payPeriodId,
      taskCount: tasks.length,
      created: tasks.filter((t) => t.created).length,
      unresolvableCount: unresolvable.length,
    },
  });
  return { clubId, payPeriodId, tasks, unresolvableDepartments: unresolvable };
}

// ---------------------------------------------------------------------------
// Payroll Admin handoff — created only when every required department has approved.
// ---------------------------------------------------------------------------

export interface PayrollAdminHandoffResult {
  status: "created" | "existing" | "not-ready" | "no-admin-configured";
  workIntakeItemId: string | null;
  ownerUserId: string | null;
  ownerDisplay: string;
  pendingDepartments: string[];  // department codes still awaiting approval
}

export async function orchestratePayrollAdminHandoff(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<PayrollAdminHandoffResult> {
  if (!hasPermission(principal, clubId, "payroll:timesheets:read")) {
    throw new Error("Not authorized");
  }
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (!config?.payrollAdminUserId) {
    return {
      status: "no-admin-configured",
      workIntakeItemId: null,
      ownerUserId: null,
      ownerDisplay: "Unassigned",
      pendingDepartments: [],
    };
  }
  const tallies = await tallyDepartmentsForPeriod(clubId, payPeriodId);
  if (tallies.size === 0) {
    return {
      status: "not-ready",
      workIntakeItemId: null,
      ownerUserId: null,
      ownerDisplay: "Unassigned",
      pendingDepartments: [],
    };
  }
  const approvals = await prisma.payrollDepartmentTimeApproval.findMany({
    where: {
      clubId,
      payPeriodId,
      departmentId: { in: Array.from(tallies.keys()) },
      state: "APPROVED",
    },
    select: { departmentId: true },
  });
  const approvedIds = new Set(approvals.map((a) => a.departmentId));
  const pending: string[] = [];
  for (const t of Array.from(tallies.values()).sort((a, b) => a.code.localeCompare(b.code))) {
    if (!approvedIds.has(t.departmentId)) pending.push(t.code);
  }
  if (pending.length > 0) {
    return {
      status: "not-ready",
      workIntakeItemId: null,
      ownerUserId: config.payrollAdminUserId,
      ownerDisplay: "",
      pendingDepartments: pending,
    };
  }

  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { periodStart: true, periodEnd: true },
  });
  const dateLabel = period
    ? `${period.periodStart.toISOString().slice(0, 10)} → ${new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`
    : payPeriodId;
  let totalEmployees = 0;
  let totalHoursCents = 0n;
  for (const t of tallies.values()) {
    totalEmployees += t.employeeIds.size;
    totalHoursCents += t.totalHoursCents;
  }
  const subject = `Payroll ready to process — ${dateLabel}`;
  const preview = `${totalEmployees} employees · ${formatHours(totalHoursCents)} approved hours`;

  const { workIntakeItemId, created } = await ensureOriginBackedItem({
    clubId,
    originKind: ADMIN_ORIGIN_KIND,
    originReferenceId: payPeriodId,
    workIntent: "REVIEW",
    workSubtype: "PAYROLL_ADMIN_PROCESSING",
    ownerUserId: config.payrollAdminUserId,
    subject,
    preview,
    linkReason: `Payroll orchestrator — all departments approved for period ${payPeriodId}.`,
  });

  const owner = await prisma.user.findUnique({
    where: { id: config.payrollAdminUserId },
    select: { name: true, email: true },
  });

  await audit(principal, {
    action: "payroll.orchestration.admin-handoff",
    entityType: "WorkIntakeItem",
    entityId: workIntakeItemId,
    clubId,
    after: {
      payPeriodId,
      status: created ? "created" : "existing",
      ownerUserId: config.payrollAdminUserId,
    },
  });

  return {
    status: created ? "created" : "existing",
    workIntakeItemId,
    ownerUserId: config.payrollAdminUserId,
    ownerDisplay: owner?.name || owner?.email || config.payrollAdminUserId,
    pendingDepartments: [],
  };
}

// ---------------------------------------------------------------------------
// Payroll Review handoff (Payroll-3B-4)
// ---------------------------------------------------------------------------

export interface PayrollReviewHandoffResult {
  status: "created" | "existing" | "no-admin-configured";
  workIntakeItemId: string | null;
  ownerUserId: string | null;
  ownerDisplay: string;
  batchId: string;
}

/**
 * After preparePayrollBatch succeeds, resolve the outstanding
 * PAYROLL_ADMIN_PROCESSING task for the Pay Period AND create the
 * new PAYROLL_REVIEW task for the same Payroll Admin. Separate
 * Work Intake items (per §27) — each represents a distinct unit
 * of required work. Idempotent via
 * WorkIntakeOrigin(PAYROLL_REVIEW, batchId).
 */
export async function orchestratePayrollReviewHandoff(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
  batchId: string,
): Promise<PayrollReviewHandoffResult> {
  if (!hasPermission(principal, clubId, "payroll:run")) {
    throw new Error("Not authorized");
  }
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (!config?.payrollAdminUserId) {
    return {
      status: "no-admin-configured",
      workIntakeItemId: null,
      ownerUserId: null,
      ownerDisplay: "Unassigned",
      batchId,
    };
  }

  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { periodStart: true, periodEnd: true, payDate: true },
  });
  const dateLabel = period
    ? `${period.periodStart.toISOString().slice(0, 10)} → ${new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`
    : payPeriodId;
  const payDateLabel = period ? period.payDate.toISOString().slice(0, 10) : "unknown";

  const summary = await prisma.payrollBatchEmployee.aggregate({
    where: { clubId, batchId },
    _count: { _all: true },
    _sum: { approvedHoursSnapshot: true },
  });
  const blockerCount = await prisma.payrollBatchException.count({
    where: { clubId, batchId, severity: "BLOCKER" },
  });

  const employeeCount = summary._count._all;
  const totalHours = summary._sum.approvedHoursSnapshot?.toString() ?? "0";
  const preview =
    `${employeeCount} employees · ${totalHours} approved hours` +
    (blockerCount > 0 ? ` · ${blockerCount} blocker${blockerCount === 1 ? "" : "s"}` : "") +
    ` · pay ${payDateLabel}`;

  // Resolve the existing ADMIN_PROCESSING task (best-effort — the
  // orchestrator may have already resolved it via emitWorkCompletionEvent
  // from a caller, but here we ensure the state transition).
  const adminOrigin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      kind: ADMIN_ORIGIN_KIND,
      referenceId: payPeriodId,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  if (adminOrigin) {
    const now = new Date();
    await prisma.workIntakeItem.updateMany({
      where: { id: adminOrigin.workIntakeItemId, status: { not: "RESOLVED" } },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedByUserId: principal.id,
      },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: adminOrigin.workIntakeItemId,
        actorUserId: principal.id,
        action: "RESOLVED",
        note: `Payroll prepared as batch ${batchId}. Review task created.`,
      },
    });
  }

  const { workIntakeItemId, created } = await ensureOriginBackedItem({
    clubId,
    originKind: REVIEW_ORIGIN_KIND,
    originReferenceId: batchId,
    workIntent: "REVIEW",
    workSubtype: "PAYROLL_REVIEW",
    ownerUserId: config.payrollAdminUserId,
    subject: `Payroll prepared — review required · ${dateLabel}`,
    preview,
    linkReason: `Payroll orchestrator — batch ${batchId} prepared for period ${payPeriodId}.`,
  });

  // Back-link the WI item onto the batch (single canonical field).
  await prisma.payrollBatch.update({
    where: { id: batchId },
    data: { workIntakeItemId },
  });

  const owner = await prisma.user.findUnique({
    where: { id: config.payrollAdminUserId },
    select: { name: true, email: true },
  });

  await audit(principal, {
    action: "payroll.orchestration.review-handoff",
    entityType: "WorkIntakeItem",
    entityId: workIntakeItemId,
    clubId,
    after: {
      payPeriodId,
      batchId,
      status: created ? "created" : "existing",
      ownerUserId: config.payrollAdminUserId,
      blockerCount,
    },
  });

  return {
    status: created ? "created" : "existing",
    workIntakeItemId,
    ownerUserId: config.payrollAdminUserId,
    ownerDisplay: owner?.name || owner?.email || config.payrollAdminUserId,
    batchId,
  };
}

/** Called when a batch is voided pre-calculation. Resolves the
 *  PAYROLL_REVIEW card (if any) so the Payroll Admin isn't left
 *  staring at a stale card, and reopens the ADMIN_PROCESSING card
 *  so the admin can re-prepare after correcting source facts. */
export async function orchestratePayrollReviewVoid(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
  batchId: string,
): Promise<void> {
  const now = new Date();
  const reviewOrigin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      kind: REVIEW_ORIGIN_KIND,
      referenceId: batchId,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  if (reviewOrigin) {
    await prisma.workIntakeItem.update({
      where: { id: reviewOrigin.workIntakeItemId },
      data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: principal.id },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: reviewOrigin.workIntakeItemId,
        actorUserId: principal.id,
        action: "RESOLVED",
        note: `Batch ${batchId} voided; review no longer required.`,
      },
    });
  }
  // Reopen the ADMIN_PROCESSING card if it exists.
  const adminOrigin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      kind: ADMIN_ORIGIN_KIND,
      referenceId: payPeriodId,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  if (adminOrigin) {
    await prisma.workIntakeItem.update({
      where: { id: adminOrigin.workIntakeItemId },
      data: { status: "OPEN", resolvedAt: null, resolvedByUserId: null },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: adminOrigin.workIntakeItemId,
        actorUserId: principal.id,
        action: "REOPENED",
        note: `Batch ${batchId} voided; re-preparation required.`,
      },
    });
  }
}
