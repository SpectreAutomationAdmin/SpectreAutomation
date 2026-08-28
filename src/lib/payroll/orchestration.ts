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

    // Prefer the approval row id when it already exists so completion
    // + reopen have a stable origin reference. Otherwise use a
    // composite so we can find the row on later runs.
    const approvalRow = await prisma.payrollDepartmentTimeApproval.findUnique({
      where: { clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId: t.departmentId } },
      select: { id: true },
    });
    const referenceId = approvalRow?.id ?? `${payPeriodId}:${t.departmentId}`;

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
