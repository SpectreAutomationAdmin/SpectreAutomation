// Scheduling Foundation (2026-09-07) — lifted from
// src/lib/timesheets/orchestration.ts so multiple orchestrators can
// materialise origin-backed Work Intake items with the same race-safe
// contract.
//
// The founder's Slice 8A brief (§9) authorised this lift: "Lift/
// generalize ensureOriginBackedItem into the shared Work Intake
// library if that can be done without regression." Payroll continues
// to work because timesheets/orchestration.ts now delegates here with
// the identical parameter set — see the wrapper below its old call
// site.
//
// Contract (unchanged from the payroll caller):
//   - If a PRIMARY origin already exists for (clubId, kind, referenceId),
//     UPDATE the linked WorkIntakeItem's owner + display fields and
//     return { created: false }.
//   - Otherwise CREATE a fresh WorkIntakeItem + PRIMARY origin +
//     MATERIALISED activity in one $transaction. Return { created: true }.
//   - On P2002 conflict against a partial-unique origin index (race
//     loser), refetch the canonical row and behave as the update path.
//     The `onOriginConflict` predicate lets each caller supply the
//     correct conflict shape (e.g. `isScopeApprovalOriginConflict`).
//
// This function must NEVER cross tenants — every read and write is
// scoped by clubId.

import { prisma } from "../prisma";

export interface EnsureOriginBackedItemInput {
  clubId: string;
  originKind: string;
  originReferenceId: string;
  workDomain: string;
  workIntent: "APPROVE" | "REVIEW" | "NOTIFY";
  workSubtype: string;
  ownerUserId: string | null;
  subject: string;
  preview: string;
  linkReason: string;
  classification: string;
  classificationReason: string;
  classificationRuleKey: string;
  classificationRuleVersion: number;
  displaySourceLabel: string;
  displaySender: string;
  workDomainClassifierVersion: string;
  /**
   * Optional predicate used to identify the caller's partial-unique
   * conflict shape (e.g. Payroll's `isScopeApprovalOriginConflict`).
   * If provided, matching Prisma errors are treated as race-losers and
   * the canonical row is refetched. If omitted, any P2002 rethrows.
   */
  onOriginConflict?: (err: unknown) => boolean;
}

export interface EnsureOriginBackedItemResult {
  workIntakeItemId: string;
  created: boolean;
}

export async function ensureOriginBackedItem(
  args: EnsureOriginBackedItemInput,
): Promise<EnsureOriginBackedItemResult> {
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

  try {
    const itemId = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const created = await tx.workIntakeItem.create({
        data: {
          clubId: args.clubId,
          status: "OPEN",
          judgmentRequired: true,
          ownerUserId: args.ownerUserId,
          classification: args.classification,
          classificationReason: args.classificationReason,
          classificationMethod: "RULE",
          classificationRuleKey: args.classificationRuleKey,
          classificationRuleVersion: args.classificationRuleVersion,
          displaySourceLabel: args.displaySourceLabel,
          displaySender: args.displaySender,
          displaySubject: args.subject,
          displayPreview: args.preview,
          displayReceivedAt: now,
          displayHasAttachments: false,
          workDomain: args.workDomain,
          workIntent: args.workIntent,
          workSubtype: args.workSubtype,
          workDomainConfidence: 1,
          workDomainClassifiedAt: now,
          workDomainClassifierVersion: args.workDomainClassifierVersion,
        },
        select: { id: true },
      });
      await tx.workIntakeOrigin.create({
        data: {
          clubId: args.clubId,
          workIntakeItemId: created.id,
          kind: args.originKind,
          referenceId: args.originReferenceId,
          role: "PRIMARY",
          linkReason: args.linkReason,
        },
      });
      await tx.workIntakeActivity.create({
        data: {
          workIntakeItemId: created.id,
          action: "MATERIALISED",
          note: args.linkReason,
        },
      });
      return created.id;
    });
    return { workIntakeItemId: itemId, created: true };
  } catch (err) {
    const isRaceLoser = args.onOriginConflict ? args.onOriginConflict(err) : false;
    if (!isRaceLoser) throw err;
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
    throw err;
  }
}
