// COA-MAP-1 (2026-10-06) — deterministic backfill.
//
// For every Account in a tenant that has `fsGroupId`, create ONE
// `AccountFinancialStatementAssignment` row with
//   effectiveFrom = earliest safe boundary
//   effectiveTo   = null  (current)
//   fsGroupId     = Account.fsGroupId
//
// For every FinancialStatementGroup row with a null `reportingRole`,
// assign the deterministic default from `defaultRoleForFsGroupKey`.
//
// Idempotent: skips accounts that already have an assignment; skips
// groups whose role is already set. Running twice is a no-op.
//
// Non-destructive — never changes `Account.fsGroupId`, never deletes
// rows, never alters balances.

import { prisma } from "@/lib/prisma";
import { defaultRoleForFsGroupKey } from "./reporting-role";

export type BackfillResult = {
  clubId: string;
  accountsBefore: number;
  accountsAfter: number;
  assignmentsCreated: number;
  rolesBackfilled: number;
  effectiveFrom: Date;
  firstTbPeriodStart: Date | null;
};

export type BackfillInput = {
  clubId: string;
  /** Explicit `effectiveFrom` boundary. When null, the service picks
   *  the earliest safe boundary: the start of the earliest committed
   *  TB snapshot period for this tenant, or a far-past floor
   *  (2010-01-01) if no snapshot exists. */
  effectiveFromOverride?: Date | null;
};

const SAFE_FAR_PAST = new Date(Date.UTC(2010, 0, 1));

export async function backfillCoaMapping(input: BackfillInput): Promise<BackfillResult> {
  const { clubId } = input;

  const accountsBefore = await prisma.account.count({ where: { clubId } });

  // Pick the backfill boundary.
  const earliestSnapshot = await prisma.reportingLedgerSnapshot
    .findFirst({
      where: { clubId },
      orderBy: { periodStart: "asc" },
      select: { periodStart: true },
    })
    .catch(() => null);
  const effectiveFrom =
    input.effectiveFromOverride ??
    earliestSnapshot?.periodStart ??
    SAFE_FAR_PAST;

  // -- Backfill assignments. One per Account with fsGroupId that
  //    does not already have ANY assignment row.
  const accountsNeedingAssignment = await prisma.account.findMany({
    where: {
      clubId,
      fsGroupId: { not: null },
      fsGroupAssignments: { none: {} },
    },
    select: { id: true, fsGroupId: true },
  });
  let assignmentsCreated = 0;
  for (const a of accountsNeedingAssignment) {
    if (!a.fsGroupId) continue;
    await prisma.accountFinancialStatementAssignment.create({
      data: {
        clubId,
        accountId: a.id,
        fsGroupId: a.fsGroupId,
        effectiveFrom,
        effectiveTo: null,
        reason: "COA-MAP-1 backfill — initial effective-dated assignment",
      },
    });
    assignmentsCreated++;
  }

  // -- Backfill roles. Idempotent.
  const groupsNeedingRole = await prisma.financialStatementGroup.findMany({
    where: { clubId, reportingRole: null },
    select: { id: true, key: true },
  });
  let rolesBackfilled = 0;
  for (const g of groupsNeedingRole) {
    const role = defaultRoleForFsGroupKey(g.key);
    if (!role) continue;
    await prisma.financialStatementGroup.update({
      where: { id: g.id },
      data: { reportingRole: role },
    });
    rolesBackfilled++;
  }

  const accountsAfter = await prisma.account.count({ where: { clubId } });

  return {
    clubId,
    accountsBefore,
    accountsAfter,
    assignmentsCreated,
    rolesBackfilled,
    effectiveFrom,
    firstTbPeriodStart: earliestSnapshot?.periodStart ?? null,
  };
}
