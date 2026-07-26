// Sprint 3 Checkpoint 15F (2026-07-24) — Merge simulation. READ-ONLY.
//
// Given a winner + loser vendor, returns a complete preview of what
// the merge executor would do. Zero writes. The reviewer sees:
//   * counts per FK relation
//   * every potential (winner, loser, vendorReference) collision
//   * every open ApprovalRequest that must be cancelled
//   * every conflict that would block execution
//
// The executor MUST run this and re-check before writing.

import { prisma } from "@/lib/prisma";
import { VendorIntelligenceError } from "./types";

export interface MergeSimulation {
  winnerVendorId: string;
  loserVendorId: string;
  clubId: string;
  simulatedAt: string;
  ruleVersion: number;
  counts: {
    invoices: number;
    payments: number;
    contacts: number;
    banking: number;
    documents: number;
    riskFlags: number;
    apExceptions: number;
    inventoryItems: number;
    inventoryReceivings: number;
    golfProfessionals: number;
    libraryDocuments: number;   // generic Document.vendorId (nullable string, no FK)
    openApprovals: number;
  };
  invoiceReferenceCollisions: Array<{
    vendorReference: string;
    winnerInvoiceId: string;
    loserInvoiceId: string;
  }>;
  activeBankingConflict: {
    winnerHasActive: boolean;
    loserHasActive: boolean;
  };
  aliasesToCreate: Array<{ aliasKind: string; aliasValue: string }>;
  blockingReasons: string[];
}

const RULE_VERSION = 1;

export interface SimulateMergeArgs {
  clubId: string;
  winnerVendorId: string;
  loserVendorId: string;
}

export async function simulateMerge(args: SimulateMergeArgs): Promise<MergeSimulation> {
  if (args.winnerVendorId === args.loserVendorId) {
    throw new VendorIntelligenceError(
      "MISSING_INPUT",
      "simulateMerge: winner and loser must be distinct vendors.",
    );
  }
  const [winner, loser] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: args.winnerVendorId, clubId: args.clubId } }),
    prisma.vendor.findFirst({ where: { id: args.loserVendorId, clubId: args.clubId } }),
  ]);
  if (!winner || !loser) {
    throw new VendorIntelligenceError(
      "VENDOR_MISSING",
      "simulateMerge: winner or loser vendor missing / cross-club.",
    );
  }

  const [
    invoiceCount, paymentCount, contactCount, bankingCount, vendorDocCount,
    riskCount, apExceptCount, inventoryCount, inventoryReceivingCount,
    golfProCount, libraryDocCount,
  ] = await Promise.all([
    prisma.aPInvoice.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.vendorPayment.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.vendorContact.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.vendorBankingProfile.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.vendorDocument.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.vendorRiskFlag.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.aPException.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.inventoryItem.count({ where: { clubId: args.clubId, preferredVendorId: args.loserVendorId } }),
    prisma.inventoryReceiving.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
    prisma.golfProfessional.count({ where: { clubId: args.clubId, payoutVendorId: args.loserVendorId } }),
    prisma.document.count({ where: { clubId: args.clubId, vendorId: args.loserVendorId } }),
  ]);

  // Approval-request check — entityType + entityId are Strings (no FK)
  // so scan directly. Open == status in PENDING / PENDING_APPROVAL / IN_REVIEW.
  const openApprovalsForLoser = await prisma.approvalRequest.findMany({
    where: {
      clubId: args.clubId,
      entityType: { in: ["VENDOR", "VENDOR_BANKING"] },
      entityId: args.loserVendorId,
      status: { in: ["PENDING", "PENDING_APPROVAL", "IN_REVIEW"] },
    },
    select: { id: true, entityType: true, status: true },
  });

  // Invoice-reference collision scan.
  const loserRefs = await prisma.aPInvoice.findMany({
    where: { clubId: args.clubId, vendorId: args.loserVendorId },
    select: { id: true, vendorReference: true },
  });
  const collisions: MergeSimulation["invoiceReferenceCollisions"] = [];
  const loserRefsWithValue = loserRefs.filter((r) => (r.vendorReference ?? "").length > 0);
  if (loserRefsWithValue.length > 0) {
    const winnerHits = await prisma.aPInvoice.findMany({
      where: {
        clubId: args.clubId,
        vendorId: args.winnerVendorId,
        vendorReference: { in: loserRefsWithValue.map((r) => r.vendorReference!) },
      },
      select: { id: true, vendorReference: true },
    });
    const winnerByRef = new Map<string, string>();
    for (const w of winnerHits) if (w.vendorReference) winnerByRef.set(w.vendorReference, w.id);
    for (const l of loserRefsWithValue) {
      const w = winnerByRef.get(l.vendorReference!);
      if (w) collisions.push({ vendorReference: l.vendorReference!, winnerInvoiceId: w, loserInvoiceId: l.id });
    }
  }

  // Active banking — schema enforces "only-one-active" in code (ap/vendors.ts).
  const [winnerActive, loserActive] = await Promise.all([
    prisma.vendorBankingProfile.count({ where: { vendorId: args.winnerVendorId, isActive: true } }),
    prisma.vendorBankingProfile.count({ where: { vendorId: args.loserVendorId, isActive: true } }),
  ]);

  // Aliases the merge WILL create from the loser's identity signals.
  const aliasesToCreate: MergeSimulation["aliasesToCreate"] = [];
  if (loser.legalName) aliasesToCreate.push({ aliasKind: "LEGAL_NAME", aliasValue: loser.legalName });
  if (loser.operatingName) aliasesToCreate.push({ aliasKind: "OPERATING_NAME", aliasValue: loser.operatingName });
  if (loser.taxRegistrationNumber) aliasesToCreate.push({ aliasKind: "TAX_NUMBER", aliasValue: loser.taxRegistrationNumber });
  if (loser.vendorNumber) aliasesToCreate.push({ aliasKind: "JONAS_VENDOR_CODE", aliasValue: loser.vendorNumber });

  const blockingReasons: string[] = [];
  if (openApprovalsForLoser.length > 0) {
    blockingReasons.push(`Loser has ${openApprovalsForLoser.length} open approval request(s). Resolve or cancel before merging.`);
  }
  if (winnerActive > 0 && loserActive > 0) {
    blockingReasons.push("Both vendors have an active banking profile. Only one can survive — reviewer must choose which to keep before merging.");
  }
  if (collisions.length > 0) {
    blockingReasons.push(`${collisions.length} invoice reference collision(s) on (clubId, vendorId, vendorReference). Executor will renumber loser's references — reviewer must confirm.`);
  }

  return {
    winnerVendorId: args.winnerVendorId,
    loserVendorId: args.loserVendorId,
    clubId: args.clubId,
    simulatedAt: new Date().toISOString(),
    ruleVersion: RULE_VERSION,
    counts: {
      invoices: invoiceCount,
      payments: paymentCount,
      contacts: contactCount,
      banking: bankingCount,
      documents: vendorDocCount,
      riskFlags: riskCount,
      apExceptions: apExceptCount,
      inventoryItems: inventoryCount,
      inventoryReceivings: inventoryReceivingCount,
      golfProfessionals: golfProCount,
      libraryDocuments: libraryDocCount,
      openApprovals: openApprovalsForLoser.length,
    },
    invoiceReferenceCollisions: collisions,
    activeBankingConflict: {
      winnerHasActive: winnerActive > 0,
      loserHasActive: loserActive > 0,
    },
    aliasesToCreate,
    blockingReasons,
  };
}
