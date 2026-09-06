// Payroll-3D-3B Slice 2 (2026-09-06) — canonical creator for the
// TIMECLOCK_CORRECTION_REVIEW WorkIntakeItem obligation.
//
// One PENDING TimeClockCorrectionRequest ⇒ exactly ONE active manager
// review card (or config-gap card). Idempotent, race-safe (backed by
// the Slice 1 partial-unique), atomic (item + origin created inside a
// single $transaction so a P2002 rejection rolls back the orphan
// item), and self-remediating (creating the manager card RESOLVES any
// pre-existing config-gap card for the same correction).
//
// Routing (per Slice 2 §REQUIRED ROUTING CASES):
//   Case 1 — correction resolves to a department AND
//            DEPARTMENT_TIME_APPROVAL owner exists →
//            manager review card (kind TIMECLOCK_CORRECTION_REVIEW).
//   Case 2 — department resolvable but NO owner →
//            Tenant Admin gap card (MISSING_APPROVER prefix).
//   Case 3 — no assignment / no department resolvable →
//            Tenant Admin gap card (MISSING_ASSIGNMENT prefix).
//
// Status guard: a correction that is already APPROVED / REJECTED /
// CANCELLED produces NO active review card. Called via the recovery
// job on a settled correction is a harmless no-op.
//
// Origin taxonomy:
//   Normal:  kind="TIMECLOCK_CORRECTION_REVIEW"
//            referenceId=correctionRequestId
//   Gap (missing approver):
//            kind="TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP"
//            referenceId="MISSING_APPROVER:${departmentId}:${correctionRequestId}"
//   Gap (missing assignment):
//            kind="TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP"
//            referenceId="MISSING_ASSIGNMENT:${correctionRequestId}"

import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { resolveDepartmentTimeApprover } from "../timesheets/manager-approval";
import { resolveCorrectionScope } from "../timesheets/correction-service";
import { isCorrectionReviewOriginConflict } from "./origin-conflict";
import { emitWorkCompletionEvent, type CompletionType } from "./completion";

export const CORRECTION_REVIEW_KIND = "TIMECLOCK_CORRECTION_REVIEW" as const;
export const CORRECTION_REVIEW_GAP_KIND = "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP" as const;

export const GAP_PREFIX_MISSING_APPROVER = "MISSING_APPROVER" as const;
export const GAP_PREFIX_MISSING_ASSIGNMENT = "MISSING_ASSIGNMENT" as const;

// Payroll-3D-3B Slice 7A (2026-09-06) — well-known WorkIntakeActivity
// note prefixes for system-driven responsibility state transitions.
// Mirrors the pattern in src/lib/timesheets/orchestration.ts.
export const SYSTEM_RESPONSIBILITY_SUPPRESSION_PREFIX =
  "SYSTEM_SUPPRESSED_RESPONSIBILITY_REMOVED";
export const SYSTEM_RESPONSIBILITY_RESTORATION_PREFIX =
  "SYSTEM_REOPENED_RESPONSIBILITY_RESTORED";

export function correctionReviewReferenceId(correctionRequestId: string): string {
  return correctionRequestId;
}
export function missingApproverGapReferenceId(departmentId: string, correctionRequestId: string): string {
  return `${GAP_PREFIX_MISSING_APPROVER}:${departmentId}:${correctionRequestId}`;
}
export function missingAssignmentGapReferenceId(correctionRequestId: string): string {
  return `${GAP_PREFIX_MISSING_ASSIGNMENT}:${correctionRequestId}`;
}

export type CorrectionReviewOutcome =
  | { kind: "review"; workIntakeItemId: string; ownerUserId: string | null; created: boolean; resolvedGapItemIds: string[] }
  | { kind: "gap-missing-approver"; workIntakeItemId: string; ownerUserId: string | null; created: boolean }
  | { kind: "gap-missing-assignment"; workIntakeItemId: string; ownerUserId: string | null; created: boolean }
  | { kind: "no-op-status"; status: string };

export interface EnsureCorrectionReviewInput {
  clubId: string;
  correctionRequestId: string;
}

export async function ensureCorrectionReviewWorkItems(
  input: EnsureCorrectionReviewInput,
): Promise<CorrectionReviewOutcome> {
  const { clubId, correctionRequestId } = input;

  // Re-read the correction — never trust stale routing values that
  // may have been supplied in a queued payload (§RECOVERY JOB).
  const correction = await prisma.timeClockCorrectionRequest.findFirst({
    where: { id: correctionRequestId, clubId },
    select: {
      id: true, clubId: true, employeeId: true, status: true,
      requestType: true, requestedOccurredAt: true, reason: true,
      originalClockEventId: true, employmentAssignmentId: true,
      reviewedByUserId: true,
    },
  });
  if (!correction) {
    // Correction row missing — nothing to orchestrate. Treat as a
    // harmless idempotent success (the caller / retry job should not
    // fail because a deleted correction has no WI counterpart).
    return { kind: "no-op-status", status: "MISSING" };
  }
  if (correction.status !== "PENDING") {
    // Payroll-3D-3B Slice 5 (2026-09-06) — terminal-correction
    // lifecycle. When a correction becomes APPROVED / REJECTED /
    // CANCELLED, any active manager review card AND any active
    // config-gap card for this correction are no longer meaningful
    // human obligations. Resolve them via the canonical completion
    // path (emitWorkCompletionEvent + set status=RESOLVED). Idempotent
    // and safe to run from anywhere: the recovery job, the direct
    // approve/reject path, or a periodic sweep.
    await resolveTerminalCorrectionWorkItems({
      clubId, correctionRequestId,
      correctionStatus: correction.status,
      reviewedByUserId: (correction as unknown as { reviewedByUserId?: string | null }).reviewedByUserId ?? null,
    });
    return { kind: "no-op-status", status: correction.status };
  }

  const scope = await resolveCorrectionScope(clubId, {
    id: correction.id,
    employmentAssignmentId: correction.employmentAssignmentId,
    originalClockEventId: correction.originalClockEventId,
  });

  // Case 3 — no assignment / no department → MISSING_ASSIGNMENT gap.
  if (!scope.departmentId) {
    return ensureMissingAssignmentGap({ clubId, correction });
  }

  const owner = await resolveDepartmentTimeApprover(clubId, scope.departmentId);
  if (!owner) {
    // Case 2 — department known, no approver → MISSING_APPROVER gap.
    return ensureMissingApproverGap({
      clubId, correction, departmentId: scope.departmentId,
    });
  }

  // Case 1 — normal manager review card. Resolves any pre-existing
  // gap card for the same correction as part of the same operation.
  return ensureManagerReviewCard({
    clubId, correction, departmentId: scope.departmentId,
    ownerUserId: owner,
  });
}

// -------------------------------------------------------------------
// Case 1 — manager review card + gap remediation
// -------------------------------------------------------------------
async function ensureManagerReviewCard(args: {
  clubId: string;
  correction: CorrectionRow;
  departmentId: string;
  ownerUserId: string;
}): Promise<CorrectionReviewOutcome> {
  const { clubId, correction, departmentId, ownerUserId } = args;

  // Payroll-3D-3B Slice 7A (2026-09-06) — responsibility restoration.
  // If the card was previously system-SUPPRESSED (because
  // responsibility went away), reopen it. User-set SUPPRESSED /
  // INFORMATIONAL are preserved — we distinguish via the last
  // SUPPRESSED activity's note prefix.
  const existingSuppressed = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: CORRECTION_REVIEW_KIND, referenceId: correction.id, role: "PRIMARY" },
    include: { workIntakeItem: { select: { id: true, status: true } } },
  });
  if (existingSuppressed?.workIntakeItem?.status === "SUPPRESSED") {
    const lastSuppression = await prisma.workIntakeActivity.findFirst({
      where: { workIntakeItemId: existingSuppressed.workIntakeItem.id, action: "SUPPRESSED" },
      orderBy: { createdAt: "desc" },
      select: { note: true },
    });
    if (lastSuppression?.note?.startsWith(SYSTEM_RESPONSIBILITY_SUPPRESSION_PREFIX)) {
      await prisma.workIntakeItem.updateMany({
        where: { id: existingSuppressed.workIntakeItem.id, status: "SUPPRESSED" },
        data:  { status: "OPEN" },
      });
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: existingSuppressed.workIntakeItem.id,
          action: "REOPENED",
          note: `${SYSTEM_RESPONSIBILITY_RESTORATION_PREFIX}: responsibility restored — routing to current approver.`,
        },
      });
    }
  }

  const department = await prisma.department.findFirst({
    where: { id: departmentId, clubId },
    select: { name: true, code: true },
  });
  const employee = await prisma.employee.findFirst({
    where: { id: correction.employeeId, clubId },
    select: { firstName: true, lastName: true, employeeNumber: true },
  });
  const subject = `Timesheet correction — ${employee?.firstName ?? ""} ${employee?.lastName ?? ""}`.trim()
    + ` · ${department?.name ?? "department"}`;
  const preview = describeCorrection(correction);

  const referenceId = correctionReviewReferenceId(correction.id);
  const { workIntakeItemId, created } = await upsertOriginBackedItem({
    clubId,
    originKind: CORRECTION_REVIEW_KIND,
    originReferenceId: referenceId,
    workIntent: "REVIEW",
    workSubtype: CORRECTION_REVIEW_KIND,
    ownerUserId,
    subject, preview,
    classification: `PAYROLL_${CORRECTION_REVIEW_KIND}`,
    linkReason: `Payroll orchestrator — correction review for request ${correction.id}.`,
  });

  // Recovery from a stale RESOLVED (e.g., correction was previously
  // decided then re-opened — currently impossible in code, but keeps
  // the invariant "PENDING ⇒ card OPEN" robust).
  await prisma.workIntakeItem.updateMany({
    where: { id: workIntakeItemId, status: "RESOLVED" },
    data:  { status: "OPEN", resolvedAt: null, resolvedByUserId: null },
  });

  // Resolve any pre-existing gap cards for this correction — remediation
  // path when the config gap is fixed after the gap card was created.
  const resolvedGapItemIds = await resolveActiveGapCardsForCorrection({
    clubId, correctionRequestId: correction.id,
  });

  return {
    kind: "review", workIntakeItemId, ownerUserId,
    created, resolvedGapItemIds,
  };
}

// -------------------------------------------------------------------
// Case 2 — MISSING_APPROVER gap card
// -------------------------------------------------------------------
async function ensureMissingApproverGap(args: {
  clubId: string;
  correction: CorrectionRow;
  departmentId: string;
}): Promise<CorrectionReviewOutcome> {
  const { clubId, correction, departmentId } = args;

  // Payroll-3D-3B Slice 7A (2026-09-06) — responsibility-removal
  // projection. If a previously-active manager review card exists
  // for this correction (from a prior owner who lost responsibility),
  // suppress it with a system-tagged activity so restoration can
  // reactivate it later. User-set SUPPRESSED / INFORMATIONAL states
  // are preserved (the updateMany filter only touches actionable
  // statuses).
  const stalePriorOrigin = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: CORRECTION_REVIEW_KIND, referenceId: correction.id, role: "PRIMARY" },
    include: { workIntakeItem: { select: { id: true, status: true } } },
  });
  if (stalePriorOrigin?.workIntakeItem
    && (stalePriorOrigin.workIntakeItem.status === "OPEN"
      || stalePriorOrigin.workIntakeItem.status === "IN_PROGRESS")) {
    await prisma.workIntakeItem.updateMany({
      where: { id: stalePriorOrigin.workIntakeItem.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
      data:  { status: "SUPPRESSED" },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: stalePriorOrigin.workIntakeItem.id,
        action: "SUPPRESSED",
        note: `${SYSTEM_RESPONSIBILITY_SUPPRESSION_PREFIX}: DEPARTMENT_TIME_APPROVAL responsibility removed; correction not currently routable.`,
      },
    });
  }

  const department = await prisma.department.findFirst({
    where: { id: departmentId, clubId },
    select: { name: true, code: true },
  });
  const employee = await prisma.employee.findFirst({
    where: { id: correction.employeeId, clubId },
    select: { firstName: true, lastName: true },
  });
  const tenantAdmin = await resolveTenantAdmin(clubId);
  if (!tenantAdmin) {
    // Payroll-3D-3B Slice 7 (2026-09-06) — fail-closed: never
    // create an ownerless config-gap WI. See orchestration.ts for
    // the paired policy note.
    logger.error("payroll.correction_review.tenant_admin_missing", {
      clubId, correctionRequestId: correction.id, departmentId,
      obligationKind: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP",
      gapReason: "MISSING_APPROVER",
      severity: "TENANT_INTEGRITY_CORRUPTION",
    });
    return { kind: "no-op-status", status: "TENANT_ADMIN_MISSING" };
  }
  const subject = `Timesheet correction routing needs attention — ${department?.name ?? "department"}`;
  const preview =
    `No Timesheet Approver is configured for ${department?.name ?? "this department"}.`
    + ` A correction from ${employee?.firstName ?? "an employee"} ${employee?.lastName ?? ""}`.trim()
    + ` cannot be reviewed until an approver is assigned.`;
  const referenceId = missingApproverGapReferenceId(departmentId, correction.id);
  const { workIntakeItemId, created } = await upsertOriginBackedItem({
    clubId,
    originKind: CORRECTION_REVIEW_GAP_KIND,
    originReferenceId: referenceId,
    workIntent: "REVIEW",
    workSubtype: CORRECTION_REVIEW_GAP_KIND,
    ownerUserId: tenantAdmin,
    subject, preview,
    classification: `PAYROLL_${CORRECTION_REVIEW_GAP_KIND}`,
    linkReason: `Payroll orchestrator — MISSING_APPROVER for department ${department?.code ?? departmentId} on correction ${correction.id}.`,
  });
  return { kind: "gap-missing-approver", workIntakeItemId, ownerUserId: tenantAdmin, created };
}

// -------------------------------------------------------------------
// Case 3 — MISSING_ASSIGNMENT gap card
// -------------------------------------------------------------------
async function ensureMissingAssignmentGap(args: {
  clubId: string;
  correction: CorrectionRow;
}): Promise<CorrectionReviewOutcome> {
  const { clubId, correction } = args;
  const employee = await prisma.employee.findFirst({
    where: { id: correction.employeeId, clubId },
    select: { firstName: true, lastName: true, employeeNumber: true },
  });
  const tenantAdmin = await resolveTenantAdmin(clubId);
  if (!tenantAdmin) {
    // Payroll-3D-3B Slice 7 (2026-09-06) — fail-closed.
    logger.error("payroll.correction_review.tenant_admin_missing", {
      clubId, correctionRequestId: correction.id,
      obligationKind: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP",
      gapReason: "MISSING_ASSIGNMENT",
      severity: "TENANT_INTEGRITY_CORRUPTION",
    });
    return { kind: "no-op-status", status: "TENANT_ADMIN_MISSING" };
  }
  const subject = `Timesheet correction routing needs attention — no work assignment`;
  const preview =
    `A correction from ${employee?.firstName ?? "an employee"} ${employee?.lastName ?? ""}`.trim()
    + ` has no derivable work assignment — no department can be identified,`
    + ` so no manager can be routed. Assign an employment assignment or department`
    + ` before a manager can review it.`;
  const referenceId = missingAssignmentGapReferenceId(correction.id);
  const { workIntakeItemId, created } = await upsertOriginBackedItem({
    clubId,
    originKind: CORRECTION_REVIEW_GAP_KIND,
    originReferenceId: referenceId,
    workIntent: "REVIEW",
    workSubtype: CORRECTION_REVIEW_GAP_KIND,
    ownerUserId: tenantAdmin,
    subject, preview,
    classification: `PAYROLL_${CORRECTION_REVIEW_GAP_KIND}`,
    linkReason: `Payroll orchestrator — MISSING_ASSIGNMENT for correction ${correction.id}.`,
  });
  return { kind: "gap-missing-assignment", workIntakeItemId, ownerUserId: tenantAdmin, created };
}

// -------------------------------------------------------------------
// Shared: find-then-transactional-create with P2002 refetch. Mirrors
// the pattern proven in tests/work-intake/correction-origin-uniqueness.test.ts.
// -------------------------------------------------------------------
interface UpsertOriginBackedItemInput {
  clubId: string;
  originKind: string;
  originReferenceId: string;
  workIntent: "REVIEW";
  workSubtype: string;
  ownerUserId: string | null;
  subject: string;
  preview: string;
  linkReason: string;
  classification: string;
}

async function upsertOriginBackedItem(
  args: UpsertOriginBackedItemInput,
): Promise<{ workIntakeItemId: string; created: boolean }> {
  // Fast path — origin already exists → update display fields + owner.
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId, kind: args.originKind,
      referenceId: args.originReferenceId, role: "PRIMARY",
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
    // Slice 4A (2026-09-06) — reconciliation reopen. Any caller that
    // reaches this function has already verified the domain still
    // requires action (the top-level ensureCorrectionReviewWorkItems
    // no-ops on non-PENDING status). If the WI card was previously
    // RESOLVED — either by an earlier bug or by the manager clicking
    // resolve manually — reopening it is the correct outcome so the
    // canonical obligation surfaces on the manager's Work Intake.
    // Terminal states set deliberately by a human (SUPPRESSED,
    // INFORMATIONAL) are NOT overwritten — reconciliation must not
    // fight explicit user intent; those cards stay silenced and the
    // dispatcher's STALE result guides the user to Restore first.
    await prisma.workIntakeItem.updateMany({
      where: { id: existing.workIntakeItemId, status: "RESOLVED" },
      data:  { status: "OPEN", resolvedAt: null, resolvedByUserId: null },
    });
    return { workIntakeItemId: existing.workIntakeItemId, created: false };
  }

  // Slow path — try to create atomically. Item + origin in one tx so a
  // P2002 rejection on the origin rolls back the orphan item. On our
  // specific correction-origin conflict, refetch canonical.
  try {
    const itemId = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const item = await tx.workIntakeItem.create({
        data: {
          clubId: args.clubId,
          status: "OPEN",
          judgmentRequired: true,
          ownerUserId: args.ownerUserId,
          classification: args.classification,
          classificationReason: `Spectre Payroll orchestrated a ${args.workSubtype} task.`,
          classificationMethod: "RULE",
          classificationRuleKey: "payroll-timeclock-correction-review.v1",
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
          workDomainClassifierVersion: "payroll-timeclock-correction-review.v1",
        },
        select: { id: true },
      });
      await tx.workIntakeOrigin.create({
        data: {
          clubId: args.clubId,
          workIntakeItemId: item.id,
          kind: args.originKind,
          referenceId: args.originReferenceId,
          role: "PRIMARY",
          linkReason: args.linkReason,
        },
      });
      await tx.workIntakeActivity.create({
        data: {
          workIntakeItemId: item.id,
          action: "MATERIALISED",
          note: args.linkReason,
        },
      });
      return item.id;
    });
    return { workIntakeItemId: itemId, created: true };
  } catch (err) {
    if (!isCorrectionReviewOriginConflict(err)) throw err;
    // Race loser — refetch the canonical origin the winner created.
    const canonical = await prisma.workIntakeOrigin.findFirst({
      where: {
        clubId: args.clubId, kind: args.originKind,
        referenceId: args.originReferenceId, role: "PRIMARY",
      },
      select: { workIntakeItemId: true },
    });
    if (canonical) {
      await prisma.workIntakeItem.update({
        where: { id: canonical.workIntakeItemId },
        data: {
          ownerUserId: args.ownerUserId,
          displaySubject: args.subject,
          displayPreview: args.preview,
          displayReceivedAt: new Date(),
        },
      });
      return { workIntakeItemId: canonical.workIntakeItemId, created: false };
    }
    // Race + canonical not found — genuinely broken; surface it.
    logger.error("payroll.correction_review.p2002_without_canonical", {
      clubId: args.clubId,
      originKind: args.originKind,
      originReferenceId: args.originReferenceId,
    });
    throw err;
  }
}

// -------------------------------------------------------------------
// Payroll-3D-3B Slice 5 (2026-09-06) — terminal-correction lifecycle.
//
// Called when ensureCorrectionReviewWorkItems observes a correction
// in APPROVED / REJECTED / CANCELLED status. Resolves any active
// manager review card via the canonical emitWorkCompletionEvent path
// AND resolves any active config-gap card so obsolete configuration
// obligations do not linger in Tenant Admin Work Intake.
//
// Idempotent: if the review card is already RESOLVED (or SUPPRESSED /
// INFORMATIONAL — user-intent states are never overwritten), the
// completion event is NOT emitted a second time. Repeat invocations
// are no-ops.
//
// Failure semantics: this helper NEVER throws. All errors are logged
// and swallowed — the caller's outer wrapper
// (orchestrateCorrectionReviewWorkItem) is responsible for enqueue-
// on-failure recovery via the ENSURE_TIMECLOCK_CORRECTION_REVIEW_WI
// BackgroundJob, which re-invokes ensureCorrectionReviewWorkItems and
// therefore this helper again on retry.
// -------------------------------------------------------------------
async function resolveTerminalCorrectionWorkItems(args: {
  clubId: string;
  correctionRequestId: string;
  correctionStatus: string;
  reviewedByUserId: string | null;
}): Promise<void> {
  const completionType: CompletionType =
    args.correctionStatus === "APPROVED" ? "APPROVED_AND_COMPLETED" : "RESOLVED";

  // -----------------------------------------------------------------
  // 1. Manager review card — resolve via canonical completion path.
  // -----------------------------------------------------------------
  const reviewOrigin = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId,
      kind: CORRECTION_REVIEW_KIND,
      referenceId: args.correctionRequestId,
      role: "PRIMARY",
    },
    select: {
      workIntakeItemId: true,
      workIntakeItem: { select: { id: true, status: true, ownerUserId: true } },
    },
  });
  if (reviewOrigin?.workIntakeItem) {
    const item = reviewOrigin.workIntakeItem;
    // Only emit completion + flip status for actionable items. If the
    // item is already RESOLVED (double-run / retry), no-op. If the
    // user deliberately SUPPRESSED or INFORMATIONAL'd it, respect
    // that intent (their card is silenced regardless of decision).
    if (item.status === "OPEN" || item.status === "IN_PROGRESS" || item.status === "DEFERRED") {
      const resolverUserId = args.reviewedByUserId ?? item.ownerUserId ?? "system";
      try {
        await emitWorkCompletionEvent({
          workIntakeItemId: item.id,
          clubId: args.clubId,
          completedByUserId: resolverUserId,
          completionType,
          metadata: {
            source: `TIMECLOCK_CORRECTION_REVIEW.${args.correctionStatus.toLowerCase()}`,
            correctionRequestId: args.correctionRequestId,
          } as never, // metadata envelope is a permissive record
        });
        // Flip status to RESOLVED. Use updateMany with the actionable
        // status filter so a concurrent state change (SUPPRESSED /
        // etc.) is not overwritten.
        await prisma.workIntakeItem.updateMany({
          where: { id: item.id, status: { in: ["OPEN", "IN_PROGRESS", "DEFERRED"] } },
          data: {
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolvedByUserId: resolverUserId,
          },
        });
      } catch (err) {
        logger.warn("payroll.correction_review.terminal_resolve_failed", {
          clubId: args.clubId,
          correctionRequestId: args.correctionRequestId,
          correctionStatus: args.correctionStatus,
          workIntakeItemId: item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // 2. Config-gap cards — the manager decision is now settled, so any
  // "no approver" or "no assignment" gap for THIS correction is no
  // longer a live obligation. Resolve via the existing gap-cleanup
  // helper (updateMany with actionable-status filter; user-intent
  // states preserved).
  // -----------------------------------------------------------------
  await resolveActiveGapCardsForCorrection({
    clubId: args.clubId,
    correctionRequestId: args.correctionRequestId,
  });
}

// -------------------------------------------------------------------
// Gap remediation: resolve every active gap card for a correction so
// only the fresh manager card remains OPEN.
// -------------------------------------------------------------------
async function resolveActiveGapCardsForCorrection(args: {
  clubId: string; correctionRequestId: string;
}): Promise<string[]> {
  const { clubId, correctionRequestId } = args;
  // Gap referenceIds are prefixed and end with the correctionRequestId,
  // so both MISSING_APPROVER:<dept>:<id> and MISSING_ASSIGNMENT:<id>
  // match a suffix search. Prisma's `endsWith` on a String is
  // engine-portable across SQLite + Postgres.
  const gaps = await prisma.workIntakeOrigin.findMany({
    where: {
      clubId, kind: CORRECTION_REVIEW_GAP_KIND, role: "PRIMARY",
      OR: [
        { referenceId: missingAssignmentGapReferenceId(correctionRequestId) },
        { referenceId: { endsWith: `:${correctionRequestId}` } },
      ],
    },
    select: { workIntakeItemId: true, referenceId: true },
  });
  const resolvedIds: string[] = [];
  for (const g of gaps) {
    // Only flip OPEN → RESOLVED; never overwrite a terminal state a
    // human deliberately set.
    const res = await prisma.workIntakeItem.updateMany({
      where: { id: g.workIntakeItemId, status: { in: ["OPEN", "IN_PROGRESS", "DEFERRED"] } },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    if (res.count > 0) {
      resolvedIds.push(g.workIntakeItemId);
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: g.workIntakeItemId,
          action: "RESOLVED",
          note: `Config gap remediated — correction ${correctionRequestId} now routed.`,
        },
      });
    }
  }
  return resolvedIds;
}

// -------------------------------------------------------------------
// Tenant-admin resolver — mirrors src/lib/timesheets/orchestration.ts
// resolveTenantAdmin. Kept local so this module has no circular dep
// with the sibling timesheet-approval orchestrator.
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

// -------------------------------------------------------------------
// Human-readable card preview. The loader (Slice 6) will build the
// rich card DTO; this preview is the one-line summary shown on the
// scan surface.
// -------------------------------------------------------------------
type CorrectionRow = {
  id: string; employeeId: string;
  requestType: string; reason: string;
  requestedOccurredAt: Date | null;
  originalClockEventId: string | null;
  employmentAssignmentId: string | null;
};

function describeCorrection(c: CorrectionRow): string {
  const label = correctionTypeLabel(c.requestType);
  const reason = c.reason.length > 120 ? c.reason.slice(0, 117) + "…" : c.reason;
  return `${label} · ${reason}`;
}

function correctionTypeLabel(t: string): string {
  switch (t) {
    case "ADD_MISSING_CLOCK_IN":  return "Missing Clock In";
    case "ADD_MISSING_CLOCK_OUT": return "Missing Clock Out";
    case "CORRECT_CLOCK_IN":      return "Correct Clock In";
    case "CORRECT_CLOCK_OUT":     return "Correct Clock Out";
    case "CORRECT_BREAK_START":   return "Correct Break Start";
    case "CORRECT_BREAK_END":     return "Correct Break End";
    default: return "Correction";
  }
}
