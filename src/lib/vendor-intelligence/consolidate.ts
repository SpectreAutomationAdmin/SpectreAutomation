// Sprint 3 Checkpoint 15F (2026-07-24) — Controlled vendor
// consolidation executor. Callback-form transaction; all-or-nothing.
//
// Sequence inside the transaction:
//   1. Re-verify both vendors exist in the same club.
//   2. Re-verify no blocking conflicts (banking, approvals).
//   3. Resolve invoice-reference collisions by renumbering loser's
//      references with a deterministic suffix.
//   4. Repoint every FK relation (10 tables) + 2 string columns.
//   5. Deactivate the loser's active banking (if the winner has one).
//   6. Cancel any open ApprovalRequests on the loser (there should be
//      none — simulate would have flagged — but defensive cleanup).
//   7. Mutate the loser's legalName + vendorNumber to MERGED forms so
//      Vendor uniqueness constraints don't collide with future writes.
//   8. Flip loser.status → "MERGED".
//   9. Create aliases from the loser's identity signals so future
//      Jonas imports resolve to the winner.
//   10. Write immutable VendorMergeRecord.
//
// No historical data is deleted. GL journal-entry descriptions
// (which contain the loser's legalName at post time) are NEVER
// rewritten — accounting history is immutable.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { simulateMerge, type MergeSimulation } from "./simulate";
import { createAlias } from "./resolve";
import { VendorIntelligenceError } from "./types";
import type { PrismaClient } from "@prisma/client";

export interface ExecuteMergeArgs {
  clubId: string;
  winnerVendorId: string;
  loserVendorId: string;
  reason: string;
  initiatedByUserId?: string | null;
  approvedByUserId?: string | null;
  // Reviewer explicitly confirmed the collision handling — the
  // executor refuses to proceed on collisions without this flag.
  acceptInvoiceReferenceCollisions?: boolean;
  // Reviewer explicitly confirmed which banking profile to keep.
  // "WINNER" (default) keeps winner's active banking + deactivates loser's.
  // "LOSER" moves loser's banking to winner + deactivates winner's.
  keepActiveBanking?: "WINNER" | "LOSER";
}

export interface ExecuteMergeResult {
  mergeRecordId: string;
  simulation: MergeSimulation;
  movedCounts: MergeSimulation["counts"];
  createdAliasesCount: number;
  cancelledApprovalsCount: number;
}

const MERGE_TXN_TIMEOUT_MS = 60_000;
const MERGE_TXN_MAX_WAIT_MS = 5_000;

export async function executeMerge(args: ExecuteMergeArgs): Promise<ExecuteMergeResult> {
  // Simulate first — outside the transaction so we don't hold locks
  // during read-only counts. We re-verify inside the transaction.
  const simulation = await simulateMerge({
    clubId: args.clubId,
    winnerVendorId: args.winnerVendorId,
    loserVendorId: args.loserVendorId,
  });

  if (simulation.blockingReasons.length > 0 && !args.acceptInvoiceReferenceCollisions) {
    const collisionOnly = simulation.blockingReasons.every((r) => r.includes("invoice reference collision"));
    if (!collisionOnly) {
      throw new VendorIntelligenceError(
        "CONFLICT_BLOCKING",
        `Refusing to merge — blocking reasons: ${simulation.blockingReasons.join("; ")}`,
      );
    }
    throw new VendorIntelligenceError(
      "CONFLICT_BLOCKING",
      `Invoice-reference collisions detected: ${simulation.invoiceReferenceCollisions.length}. Reviewer must set acceptInvoiceReferenceCollisions=true to renumber loser's references with a deterministic suffix.`,
    );
  }

  const keepBanking = args.keepActiveBanking ?? "WINNER";

  const result = await prisma.$transaction<ExecuteMergeResult>(async (tx) => {
    // --- 1) re-verify -----------------------------------------------------
    const [winner, loser] = await Promise.all([
      tx.vendor.findFirst({ where: { id: args.winnerVendorId, clubId: args.clubId } }),
      tx.vendor.findFirst({ where: { id: args.loserVendorId, clubId: args.clubId } }),
    ]);
    if (!winner || !loser) throw new VendorIntelligenceError("VENDOR_MISSING", "Vendor missing at execution time.");
    if (winner.id === loser.id) throw new VendorIntelligenceError("MISSING_INPUT", "Winner === Loser.");
    if (loser.status === "MERGED") throw new VendorIntelligenceError("CONFLICT_BLOCKING", "Loser is already MERGED.");
    if (winner.status === "MERGED") throw new VendorIntelligenceError("CONFLICT_BLOCKING", "Winner is MERGED — cannot receive merges.");

    // --- 2) re-verify no open approvals ------------------------------------
    const openApprovals = await tx.approvalRequest.findMany({
      where: {
        clubId: args.clubId,
        entityType: { in: ["VENDOR", "VENDOR_BANKING"] },
        entityId: args.loserVendorId,
        status: { in: ["PENDING", "PENDING_APPROVAL", "IN_REVIEW"] },
      },
      select: { id: true, entityType: true },
    });
    let cancelledApprovalsCount = 0;
    for (const ap of openApprovals) {
      await tx.approvalRequest.update({
        where: { id: ap.id },
        data: {
          status: "REJECTED",
          resolvedAt: new Date(),
          resolutionNote: `Cancelled by vendor merge — loser vendor consolidated into ${args.winnerVendorId}`,
        },
      });
      cancelledApprovalsCount += 1;
    }

    // --- 3) resolve invoice-ref collisions ---------------------------------
    // Deterministic suffix: existing vendorReference + "-M<loserId last 6>"
    for (const col of simulation.invoiceReferenceCollisions) {
      const suffix = `-M${args.loserVendorId.slice(-6)}`;
      await tx.aPInvoice.update({
        where: { id: col.loserInvoiceId },
        data: { vendorReference: `${col.vendorReference}${suffix}` },
      });
    }

    // --- 4) repoint every FK ----------------------------------------------
    const [
      invoicesMoved, paymentsMoved, contactsMoved, bankingMoved, docsMoved,
      riskMoved, apExceptMoved, invItemsMoved, invRecMoved, golfProMoved, libDocMoved,
    ] = await Promise.all([
      tx.aPInvoice.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.vendorPayment.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.vendorContact.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.vendorBankingProfile.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.vendorDocument.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.vendorRiskFlag.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.aPException.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.inventoryItem.updateMany({
        where: { clubId: args.clubId, preferredVendorId: args.loserVendorId },
        data: { preferredVendorId: args.winnerVendorId },
      }),
      tx.inventoryReceiving.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
      tx.golfProfessional.updateMany({
        where: { clubId: args.clubId, payoutVendorId: args.loserVendorId },
        data: { payoutVendorId: args.winnerVendorId },
      }),
      tx.document.updateMany({
        where: { clubId: args.clubId, vendorId: args.loserVendorId },
        data: { vendorId: args.winnerVendorId },
      }),
    ]);

    // --- 5) banking-active resolution -------------------------------------
    if (simulation.activeBankingConflict.winnerHasActive && simulation.activeBankingConflict.loserHasActive) {
      const sideToDeactivate = keepBanking === "WINNER" ? args.loserVendorId : args.winnerVendorId;
      await tx.vendorBankingProfile.updateMany({
        where: { vendorId: sideToDeactivate, isActive: true },
        data: { isActive: false },
      });
    }

    // --- 6/7/8) mutate loser + flip status --------------------------------
    const mergedLegalName = `MERGED:${loser.legalName}:${loser.id.slice(-6)}`;
    const mergedVendorNumber = `MERGED:${loser.vendorNumber}:${loser.id.slice(-6)}`;
    await tx.vendor.update({
      where: { id: loser.id },
      data: {
        status: "MERGED",
        legalName: mergedLegalName,
        vendorNumber: mergedVendorNumber,
      },
    });

    // --- 9) create aliases -------------------------------------------------
    // Write the merge record FIRST (without alias count populated) so we
    // can point aliases at it, then update the count at the end.
    const mergeRecord = await tx.vendorMergeRecord.create({
      data: {
        clubId: args.clubId,
        winnerVendorId: args.winnerVendorId,
        loserVendorId: args.loserVendorId,
        initiatedByUserId: args.initiatedByUserId ?? null,
        approvedByUserId: args.approvedByUserId ?? null,
        reason: args.reason,
        movedInvoicesCount: invoicesMoved.count,
        movedPaymentsCount: paymentsMoved.count,
        movedContactsCount: contactsMoved.count,
        movedBankingCount: bankingMoved.count,
        movedDocumentsCount: docsMoved.count,
        movedRiskFlagsCount: riskMoved.count,
        movedApExceptionsCount: apExceptMoved.count,
        movedInventoryItemsCount: invItemsMoved.count,
        movedInventoryReceivingsCount: invRecMoved.count,
        movedGolfProfessionalsCount: golfProMoved.count,
        movedLibraryDocumentsCount: libDocMoved.count,
        cancelledApprovalsCount,
        simulationJson: JSON.stringify(simulation),
        status: "COMMITTED",
      },
      select: { id: true },
    });

    let createdAliasesCount = 0;
    for (const a of simulation.aliasesToCreate) {
      try {
        const r = await createAlias({
          tx: tx as unknown as { vendorAlias: PrismaClient["vendorAlias"] },
          clubId: args.clubId,
          canonicalVendorId: args.winnerVendorId,
          aliasKind: a.aliasKind as Parameters<typeof createAlias>[0]["aliasKind"],
          aliasValue: a.aliasValue,
          originVendorId: args.loserVendorId,
          createdViaMergeId: mergeRecord.id,
          createdByUserId: args.initiatedByUserId ?? null,
        });
        if (r.created) createdAliasesCount += 1;
      } catch (err) {
        // A conflict here means TWO active vendors already had the same
        // alias-worthy signal — the pre-flight didn't catch it. Fail
        // loudly so the reviewer notices.
        throw new VendorIntelligenceError(
          "COLLISION",
          `Alias write conflict during merge: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Update the merge record with the final alias count.
    await tx.vendorMergeRecord.update({
      where: { id: mergeRecord.id },
      data: { createdAliasesCount },
    });

    return {
      mergeRecordId: mergeRecord.id,
      simulation,
      movedCounts: {
        invoices: invoicesMoved.count,
        payments: paymentsMoved.count,
        contacts: contactsMoved.count,
        banking: bankingMoved.count,
        documents: docsMoved.count,
        riskFlags: riskMoved.count,
        apExceptions: apExceptMoved.count,
        inventoryItems: invItemsMoved.count,
        inventoryReceivings: invRecMoved.count,
        golfProfessionals: golfProMoved.count,
        libraryDocuments: libDocMoved.count,
        openApprovals: cancelledApprovalsCount,
      },
      createdAliasesCount,
      cancelledApprovalsCount,
    };
  }, { timeout: MERGE_TXN_TIMEOUT_MS, maxWait: MERGE_TXN_MAX_WAIT_MS });

  logger.info("vendor-intelligence.merge.committed", {
    clubId: args.clubId,
    winnerTail: args.winnerVendorId.slice(-6),
    loserTail: args.loserVendorId.slice(-6),
    mergeRecordIdTail: result.mergeRecordId.slice(-6),
    invoicesMoved: result.movedCounts.invoices,
    paymentsMoved: result.movedCounts.payments,
    aliasesCreated: result.createdAliasesCount,
    cancelledApprovals: result.cancelledApprovalsCount,
  });

  return result;
}
