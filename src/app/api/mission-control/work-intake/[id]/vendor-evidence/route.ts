// Sprint 3 Checkpoint 15F (2026-07-24) — Vendor consolidation review
// evidence.
//
// GET /api/mission-control/work-intake/[id]/vendor-evidence
//
// Returns everything the Vendor Consolidation Review card needs:
//   * both vendors' summary + counts
//   * recommended canonical + rationale (recomputed on read)
//   * merge preview (recomputed on read)
//   * persisted findings from WorkIntakeFinding
//   * available reviewer actions
// READ-ONLY. Zero writes.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { recommendCanonical, type CanonicalCandidate } from "@/lib/vendor-intelligence/canonical";
import { simulateMerge } from "@/lib/vendor-intelligence/simulate";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: params.id, clubId, classification: "VENDOR_CONSOLIDATION_REVIEW" },
    select: {
      id: true, status: true, classification: true, classificationRuleKey: true,
      displaySubject: true, lastAnalysedAt: true,
      findings: {
        where: { state: { in: ["CONFIRMED", "OBSERVED", "USER_REJECTED"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, key: true, statement: true, state: true, severity: true, ruleKey: true, ruleVersion: true, createdAt: true },
      },
    },
  });
  if (!intake) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Recover the vendor pair from classificationRuleKey (form: vendor-intelligence.pair.<idA::idB>)
  const pairKey = (intake.classificationRuleKey ?? "").replace(/^vendor-intelligence\.pair\./, "");
  const [aId, bId] = pairKey.split("::");
  if (!aId || !bId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [a, b] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: aId, clubId }, include: { contacts: true } }),
    prisma.vendor.findFirst({ where: { id: bId, clubId }, include: { contacts: true } }),
  ]);
  if (!a || !b) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [aInv, aPay, aDoc, bInv, bPay, bDoc, aBank, bBank] = await Promise.all([
    prisma.aPInvoice.count({ where: { clubId, vendorId: a.id } }),
    prisma.vendorPayment.count({ where: { clubId, vendorId: a.id } }),
    prisma.vendorDocument.count({ where: { clubId, vendorId: a.id } }),
    prisma.aPInvoice.count({ where: { clubId, vendorId: b.id } }),
    prisma.vendorPayment.count({ where: { clubId, vendorId: b.id } }),
    prisma.vendorDocument.count({ where: { clubId, vendorId: b.id } }),
    prisma.vendorBankingProfile.count({ where: { vendorId: a.id, isActive: true, status: "VERIFIED" } }),
    prisma.vendorBankingProfile.count({ where: { vendorId: b.id, isActive: true, status: "VERIFIED" } }),
  ]);

  const candidates: CanonicalCandidate[] = [
    {
      id: a.id, legalName: a.legalName, status: a.status, createdAt: a.createdAt,
      hasVerifiedBanking: aBank > 0, hasTaxNumber: !!a.taxRegistrationNumber,
      hasEmail: !!a.email, contactCount: a.contacts.length,
      hasDefaultExpenseAccount: !!a.defaultExpenseAccountId,
      hasDefaultDepartment: !!a.defaultDepartmentId,
      invoiceCount: aInv, paymentCount: aPay, documentCount: aDoc,
    },
    {
      id: b.id, legalName: b.legalName, status: b.status, createdAt: b.createdAt,
      hasVerifiedBanking: bBank > 0, hasTaxNumber: !!b.taxRegistrationNumber,
      hasEmail: !!b.email, contactCount: b.contacts.length,
      hasDefaultExpenseAccount: !!b.defaultExpenseAccountId,
      hasDefaultDepartment: !!b.defaultDepartmentId,
      invoiceCount: bInv, paymentCount: bPay, documentCount: bDoc,
    },
  ];
  const canonical = recommendCanonical(candidates);

  // Simulate a merge in the recommended direction. Recompute so the
  // card always reflects the current state of AP + banking.
  const winnerId = canonical.recommendedVendorId ?? a.id;
  const loserId = winnerId === a.id ? b.id : a.id;
  let simulation = null as Awaited<ReturnType<typeof simulateMerge>> | null;
  try {
    simulation = await simulateMerge({ clubId, winnerVendorId: winnerId, loserVendorId: loserId });
  } catch {
    simulation = null;
  }

  return NextResponse.json({
    intake: {
      id: intake.id,
      status: intake.status,
      classification: intake.classification,
      title: intake.displaySubject,
      lastAnalysedAt: intake.lastAnalysedAt?.toISOString() ?? null,
      ruleSource: "Spectre vendor intelligence rule v1",
    },
    vendors: [
      publicVendor(a, { invoiceCount: aInv, paymentCount: aPay, documentCount: aDoc, hasActiveBanking: aBank > 0 }),
      publicVendor(b, { invoiceCount: bInv, paymentCount: bPay, documentCount: bDoc, hasActiveBanking: bBank > 0 }),
    ],
    canonicalRecommendation: {
      state: canonical.state,
      recommendedVendorId: canonical.recommendedVendorId,
      rationale: canonical.rationale,
      breakdown: canonical.breakdown,
    },
    mergePreview: simulation
      ? {
          winnerVendorId: simulation.winnerVendorId,
          loserVendorId: simulation.loserVendorId,
          counts: simulation.counts,
          collisionCount: simulation.invoiceReferenceCollisions.length,
          collisions: simulation.invoiceReferenceCollisions,
          activeBankingConflict: simulation.activeBankingConflict,
          aliasesToCreate: simulation.aliasesToCreate,
          blockingReasons: simulation.blockingReasons,
        }
      : null,
    persistedFindings: intake.findings,
    availableActions: {
      approveConsolidation: canonical.state === "RECOMMENDED" && (simulation?.blockingReasons.length ?? 0) === 0,
      rejectConsolidation: true,
      chooseDifferentCanonical: canonical.state !== "INSUFFICIENT_EVIDENCE",
      markVendorsDistinct: true,
      deferReview: true,
      executeConsolidation: canonical.state === "RECOMMENDED" && (simulation?.blockingReasons.length ?? 0) === 0,
    },
    // Merge execution is a distinct, reviewer-only action. Never auto.
    autoMergeAvailable: false,
    autoMergeReason: "Automatic merges are prohibited. Merge only via explicit reviewer approval.",
  });
}

function publicVendor(
  v: {
    id: string; legalName: string; operatingName: string | null; vendorNumber: string;
    status: string; email: string | null; phone: string | null; website: string | null;
    taxRegistrationNumber: string | null; address1: string | null; postalCode: string | null;
    contacts: Array<{ name: string; email: string | null }>; createdAt: Date;
  },
  aux: { invoiceCount: number; paymentCount: number; documentCount: number; hasActiveBanking: boolean },
) {
  return {
    id: v.id,
    legalName: v.legalName,
    operatingName: v.operatingName,
    vendorNumber: v.vendorNumber,
    status: v.status,
    hasEmail: !!v.email,
    hasPhone: !!v.phone,
    hasWebsite: !!v.website,
    hasTaxNumber: !!v.taxRegistrationNumber,
    // NOTE: banking account numbers are never returned; only the boolean.
    hasActiveBanking: aux.hasActiveBanking,
    contactCount: v.contacts.length,
    invoiceCount: aux.invoiceCount,
    paymentCount: aux.paymentCount,
    documentCount: aux.documentCount,
    createdAt: v.createdAt.toISOString(),
  };
}
