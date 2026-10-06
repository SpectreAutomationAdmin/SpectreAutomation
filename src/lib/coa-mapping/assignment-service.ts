// COA-MAP-1 (2026-10-06) — account reassignment service.
//
// Writes a new `AccountFinancialStatementAssignment` row, closes
// the previous current assignment (sets `effectiveTo`), updates the
// compatibility column `Account.fsGroupId` to the new group, and
// writes a `MappingChangeAudit` row.
//
// Decision 1 Option D: assignments are effective-dated. The
// Controller supplies `effectiveFrom`; the service picks a sensible
// default (first day of the current reporting period) when none is
// supplied. Historical corrections (effectiveFrom in the past) are
// supported — they will restate UNPUBLISHED historical reporting
// via the as-of resolver, intentionally per founder decision.

import { prisma } from "@/lib/prisma";
import { findCurrentAssignment } from "./fs-group-asof-resolver";
import {
  validateAccountReassignment,
  type AccountSnapshot,
  type GroupSnapshot,
  type ValidationResult,
} from "./validation";

export type ReassignAccountInput = {
  clubId: string;
  accountId: string;
  targetFsGroupId: string;
  effectiveFrom: Date;
  actorUserId: string | null;
  actorEmail: string | null;
  reason?: string | null;
  /** When true, bypass WARNING outcomes (BLOCKED remains fatal).
   *  Set via a confirm-and-apply UX flow — never a silent default. */
  acknowledgeWarnings?: boolean;
};

export type ReassignAccountResult = {
  outcome: "OK" | "BLOCKED" | "WARNING_UNACKNOWLEDGED";
  validation: ValidationResult;
  assignmentId: string | null;
  priorAssignmentId: string | null;
  auditId: string | null;
};

export class ReassignmentError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function reassignAccount(input: ReassignAccountInput): Promise<ReassignAccountResult> {
  const account = await prisma.account.findUnique({
    where: { id: input.accountId },
    select: {
      id: true,
      clubId: true,
      accountNumber: true,
      name: true,
      type: true,
      normalBalance: true,
      fundApplicability: true,
      fsGroupId: true,
    },
  });
  if (!account) throw new ReassignmentError("ACCOUNT_NOT_FOUND", `Account ${input.accountId} not found.`);
  if (account.clubId !== input.clubId) {
    throw new ReassignmentError("CROSS_TENANT", "Cannot reassign an account owned by a different club.");
  }

  const targetGroup = await prisma.financialStatementGroup.findUnique({
    where: { id: input.targetFsGroupId },
    select: {
      id: true, clubId: true, key: true, name: true, statement: true, reportingRole: true,
    },
  });
  if (!targetGroup) throw new ReassignmentError("GROUP_NOT_FOUND", `Group ${input.targetFsGroupId} not found.`);
  if (targetGroup.clubId !== input.clubId) {
    throw new ReassignmentError("CROSS_TENANT", "Cannot reassign to a group owned by a different club.");
  }

  const acctSnap: AccountSnapshot = {
    id: account.id,
    accountNumber: account.accountNumber,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance,
    fundApplicability: account.fundApplicability,
  };
  const groupSnap: GroupSnapshot = {
    id: targetGroup.id,
    key: targetGroup.key,
    name: targetGroup.name,
    statement: targetGroup.statement,
    reportingRole: targetGroup.reportingRole,
  };
  const validation = validateAccountReassignment({ account: acctSnap, targetGroup: groupSnap });

  if (validation.outcome === "BLOCKED") {
    return {
      outcome: "BLOCKED",
      validation,
      assignmentId: null,
      priorAssignmentId: null,
      auditId: null,
    };
  }
  if (validation.outcome === "WARNING" && !input.acknowledgeWarnings) {
    return {
      outcome: "WARNING_UNACKNOWLEDGED",
      validation,
      assignmentId: null,
      priorAssignmentId: null,
      auditId: null,
    };
  }

  const prior = await findCurrentAssignment({ clubId: input.clubId, accountId: input.accountId });

  // Transaction: close prior (if any), insert new, update Account.fsGroupId,
  // write audit row. All-or-nothing.
  const result = await prisma.$transaction(async (tx) => {
    let priorAssignmentId: string | null = null;
    if (prior) {
      // Close the prior assignment the day BEFORE the new one takes
      // effect. UTC-midnight-day step: use effectiveFrom directly as
      // the exclusive end of the prior row (half-open interval
      // [prior.effectiveFrom, new.effectiveFrom)).
      await tx.accountFinancialStatementAssignment.update({
        where: { id: prior.id },
        data: { effectiveTo: input.effectiveFrom },
      });
      priorAssignmentId = prior.id;
    }

    const newRow = await tx.accountFinancialStatementAssignment.create({
      data: {
        clubId: input.clubId,
        accountId: input.accountId,
        fsGroupId: input.targetFsGroupId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        createdByUserId: input.actorUserId,
        reason: input.reason ?? null,
      },
      select: { id: true },
    });

    // Compatibility: update Account.fsGroupId to the new group so
    // every current-resolution consumer (56 call sites still on
    // Account.fsGroupId) stays coherent.
    await tx.account.update({
      where: { id: input.accountId },
      data: { fsGroupId: input.targetFsGroupId },
    });

    const audit = await tx.mappingChangeAudit.create({
      data: {
        clubId: input.clubId,
        action: "ACCOUNT_REASSIGN",
        entityType: "Account",
        entityId: input.accountId,
        payloadJson: JSON.stringify({
          accountNumber: account.accountNumber,
          accountName: account.name,
          priorFsGroupId: prior?.fsGroupId ?? account.fsGroupId ?? null,
          newFsGroupId: input.targetFsGroupId,
          newFsGroupKey: targetGroup.key,
          newFsGroupName: targetGroup.name,
          effectiveFrom: input.effectiveFrom.toISOString(),
          reason: input.reason ?? null,
          validation: {
            outcome: validation.outcome,
            reasonCodes: validation.reasons.map((r) => r.code),
          },
        }),
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
      },
      select: { id: true },
    });

    return {
      assignmentId: newRow.id,
      priorAssignmentId,
      auditId: audit.id,
    };
  });

  return {
    outcome: "OK",
    validation,
    assignmentId: result.assignmentId,
    priorAssignmentId: result.priorAssignmentId,
    auditId: result.auditId,
  };
}
