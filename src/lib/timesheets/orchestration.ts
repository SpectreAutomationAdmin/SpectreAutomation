// Payroll-3D-3 (2026-09-05) — System-generated Work Intake for
// timesheet-scope manager approval.
//
// Idempotent. For each (payPeriodId × departmentId) scope with
// reviewable timesheet data, ensures exactly ONE active Work Intake
// item exists — routed to the DEPARTMENT_TIME_APPROVAL owner. When
// the responsibility is unassigned (§7, §8, §55), a distinct
// configuration-gap WI card is materialised for the Tenant
// Administrator instead — never assigned to the employee, never to
// a random admin, never silently swallowed.
//
// Origin taxonomy:
//   workDomain    "PAYROLL"
//   workIntent    "APPROVE"
//   workSubtype   "TIMESHEET_APPROVAL"
//   origin.kind   "PAYROLL_TIMESHEET_APPROVAL"
//   origin.refId  "${payPeriodId}:${departmentId}"
//
// Gap card origin taxonomy:
//   workDomain    "PAYROLL"
//   workIntent    "REVIEW"
//   workSubtype   "TIMESHEET_APPROVAL_CONFIG_GAP"
//   origin.kind   "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP"
//   origin.refId  "${payPeriodId}:${departmentId}"

import { prisma } from "../prisma";
import { listReviewableScopes, type ReviewableScope } from "./approval-scope";
import { resolveDepartmentTimeApprover } from "./manager-approval";

const SCOPE_ORIGIN_KIND = "PAYROLL_TIMESHEET_APPROVAL";
const GAP_ORIGIN_KIND   = "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP";

export interface TimesheetApprovalWorkItemResult {
  scope:            ReviewableScope;
  workIntakeItemId: string;
  ownerUserId:      string | null;
  gap:              boolean;
  created:          boolean;
}

export interface EnsureTimesheetApprovalWorkItemsResult {
  clubId:      string;
  payPeriodId: string;
  items:       TimesheetApprovalWorkItemResult[];
}

// -------------------------------------------------------------------
// Tenant-admin resolver for configuration-gap routing.
// Returns the User id of the current PRIMARY TENANT_ADMINISTRATION
// holder for the club. Fail closed if none.
// -------------------------------------------------------------------
async function resolveTenantAdmin(clubId: string): Promise<string | null> {
  const asn = await prisma.responsibilityAssignment.findFirst({
    where: {
      clubId,
      responsibilityKey: "TENANT_ADMINISTRATION",
      role: "PRIMARY",
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
    },
    orderBy: { effectiveFrom: "asc" },
    select: { userId: true },
  });
  return asn?.userId ?? null;
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
  classification: string;
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
      classification: args.classification,
      classificationReason: `Spectre Payroll orchestrated a ${args.workSubtype} task.`,
      classificationMethod: "RULE",
      classificationRuleKey: "payroll-timesheet-approval.v1",
      classificationRuleVersion: 1,
      displaySourceLabel: "Spectre Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: args.subject,
      displayPreview: args.preview,
      displayReceivedAt: now,
      displayHasAttachments: false,
      workDomain: "PAYROLL",
      workIntent: args.workIntent,
      workSubtype: args.workSubtype,
      workDomainConfidence: 1,
      workDomainClassifiedAt: now,
      workDomainClassifierVersion: "payroll-timesheet-approval.v1",
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

function fmtHours(seconds: number): string {
  const h = seconds / 3600;
  return `${h.toFixed(2)}h`;
}

/**
 * Ensure a manager Work Intake card exists for every reviewable
 * timesheet-approval scope in a Pay Period. Idempotent.
 *
 * Also RESOLVES cards whose scope no longer has anything reviewable
 * AND whose approval row is APPROVED-current (a scope that was
 * approved cleanly then went quiet should not keep a stale card open).
 * That secondary cleanup is deferred to a later slice; here we only
 * ensure scopes with reviewable content have exactly one card.
 */
export async function ensureTimesheetApprovalWorkItems(
  clubId: string, payPeriodId: string,
): Promise<EnsureTimesheetApprovalWorkItemsResult> {
  const scopes = await listReviewableScopes(clubId, payPeriodId);
  const results: TimesheetApprovalWorkItemResult[] = [];
  for (const scope of scopes) {
    const owner = await resolveDepartmentTimeApprover(clubId, scope.departmentId);
    const referenceId = `${payPeriodId}:${scope.departmentId}`;
    if (owner) {
      // Suppress the configuration-gap card if one exists (recovery
      // path when the responsibility gets assigned after a gap card
      // was already materialised).
      const gap = await prisma.workIntakeOrigin.findFirst({
        where: { clubId, kind: GAP_ORIGIN_KIND, referenceId, role: "PRIMARY" },
        select: { workIntakeItemId: true },
      });
      if (gap) {
        await prisma.workIntakeItem.update({
          where: { id: gap.workIntakeItemId },
          data: { status: "RESOLVED", resolvedAt: new Date() },
        });
      }
      const subject = `Timesheets ready for approval — ${scope.departmentName}`;
      const preview =
        `${scope.employeeCount} employee${scope.employeeCount === 1 ? "" : "s"}`
        + ` · ${fmtHours(scope.recordedSeconds)}`
        + (scope.exceptionCount > 0 ? ` · ${scope.exceptionCount} exception${scope.exceptionCount === 1 ? "" : "s"}` : "")
        + (scope.pendingCorrectionCount > 0 ? ` · ${scope.pendingCorrectionCount} correction${scope.pendingCorrectionCount === 1 ? "" : "s"} pending` : "");
      const { workIntakeItemId, created } = await ensureOriginBackedItem({
        clubId,
        originKind: SCOPE_ORIGIN_KIND,
        originReferenceId: referenceId,
        workIntent: "APPROVE",
        workSubtype: "TIMESHEET_APPROVAL",
        ownerUserId: owner,
        subject, preview,
        linkReason: `Payroll orchestrator — timesheet scope ${scope.departmentCode} for period ${payPeriodId}.`,
        classification: SCOPE_ORIGIN_KIND,
      });
      // Ensure the WI card is OPEN (recovery from a stale RESOLVED).
      await prisma.workIntakeItem.updateMany({
        where: { id: workIntakeItemId, status: "RESOLVED" },
        data:  { status: "OPEN", resolvedAt: null, resolvedByUserId: null },
      });
      results.push({ scope, workIntakeItemId, ownerUserId: owner, gap: false, created });
    } else {
      // Configuration gap — route to Tenant Admin so a real person
      // becomes accountable for setting the Timesheet Approver.
      const tenantAdmin = await resolveTenantAdmin(clubId);
      const subject = `Timesheet Approver missing — ${scope.departmentName}`;
      const preview = `Assign a Timesheet Approver for ${scope.departmentName} before recorded time can be reviewed.`;
      const { workIntakeItemId, created } = await ensureOriginBackedItem({
        clubId,
        originKind: GAP_ORIGIN_KIND,
        originReferenceId: referenceId,
        workIntent: "REVIEW",
        workSubtype: "TIMESHEET_APPROVAL_CONFIG_GAP",
        ownerUserId: tenantAdmin,
        subject, preview,
        linkReason: `Payroll orchestrator — no DEPARTMENT_TIME_APPROVAL responsibility assignee for ${scope.departmentCode}.`,
        classification: GAP_ORIGIN_KIND,
      });
      results.push({ scope, workIntakeItemId, ownerUserId: tenantAdmin, gap: true, created });
    }
  }
  return { clubId, payPeriodId, items: results };
}
