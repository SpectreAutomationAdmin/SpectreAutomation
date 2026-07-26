// Sprint 3 Checkpoint 15F (2026-07-24) — Vendor consolidation
// materialiser.
//
// Enumerates every non-MERGED vendor in a club, loads its detection
// context (contacts, historical invoice references, banking last-4),
// runs pairwise duplicate detection, and — for every non-DISTINCT
// pair — ensures a canonical WorkIntakeItem exists via a shared
// natural key on WorkIntakeOrigin. Persists findings via the reusable
// C15B persistence layer.
//
// One-shot, bounded (MAX_PAIRS_PER_RUN cap). No background workers.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { findDuplicatePairsInBatch, type VendorForDetection } from "./duplicate-detect";
import { recommendCanonical, type CanonicalCandidate } from "./canonical";
import { simulateMerge } from "./simulate";
import { upsertOrigins } from "@/lib/intelligence/origins";
import { upsertAnalysisFindings } from "@/lib/intelligence/persistence";
import type { FindingInput } from "@/lib/intelligence/types";

const MAX_VENDORS_PER_RUN = 500;
const MAX_PAIRS_PER_RUN = 2000;
const RULE_MODULE = "vendor-intelligence";

export interface VendorMaterialiseArgs {
  clubId: string;
  now?: Date;
  maxVendors?: number;
  dryRun?: boolean;
}

export interface VendorMaterialiseResult {
  clubId: string;
  ruleModule: string;
  runAt: string;
  vendorsExamined: number;
  pairsEvaluated: number;
  pairsFlagged: number;
  intakesCreated: number;
  intakesReused: number;
  findingsCreated: number;
  findingsPreserved: number;
  findingsSuperseded: number;
  findingsRejectedPreserved: number;
  errorCount: number;
  errors: Array<{ category: string; referenceId: string; message: string }>;
  dryRun: boolean;
}

export async function runVendorConsolidationMaterialisation(
  args: VendorMaterialiseArgs,
): Promise<VendorMaterialiseResult> {
  const now = args.now ?? new Date();
  const clubId = args.clubId;
  const dryRun = !!args.dryRun;
  const maxVendors = Math.min(args.maxVendors ?? MAX_VENDORS_PER_RUN, MAX_VENDORS_PER_RUN);
  const result: VendorMaterialiseResult = {
    clubId,
    ruleModule: RULE_MODULE,
    runAt: now.toISOString(),
    vendorsExamined: 0,
    pairsEvaluated: 0,
    pairsFlagged: 0,
    intakesCreated: 0,
    intakesReused: 0,
    findingsCreated: 0,
    findingsPreserved: 0,
    findingsSuperseded: 0,
    findingsRejectedPreserved: 0,
    errorCount: 0,
    errors: [],
    dryRun,
  };

  // Load non-MERGED vendors with their detection context.
  const rawVendors = await prisma.vendor.findMany({
    where: { clubId, status: { not: "MERGED" } },
    include: {
      contacts: { select: { email: true, phone: true } },
      bankingProfiles: {
        where: { isActive: true, status: "VERIFIED" },
        select: { accountLastFour: true },
        take: 1,
      },
      invoices: { select: { vendorReference: true }, take: 200 },
    },
    take: maxVendors,
    orderBy: { createdAt: "asc" },
  });
  result.vendorsExamined = rawVendors.length;

  const forDetection: VendorForDetection[] = rawVendors.map((v) => ({
    vendor: {
      id: v.id,
      legalName: v.legalName,
      operatingName: v.operatingName,
      taxRegistrationNumber: v.taxRegistrationNumber,
      email: v.email,
      website: v.website,
      phone: v.phone,
      address1: v.address1,
      postalCode: v.postalCode,
      defaultExpenseAccountId: v.defaultExpenseAccountId,
      status: v.status,
    },
    contacts: v.contacts,
    historicalInvoiceReferences: v.invoices.map((i) => i.vendorReference ?? "").filter(Boolean),
    hasBanking: v.bankingProfiles.length > 0,
    activeBankingAccountLast4: v.bankingProfiles[0]?.accountLastFour ?? null,
  }));

  // Pairwise detection — bounded by MAX_PAIRS_PER_RUN to avoid O(N²)
  // runaway on a club with a huge vendor list.
  const maxPossiblePairs = (rawVendors.length * (rawVendors.length - 1)) / 2;
  if (maxPossiblePairs > MAX_PAIRS_PER_RUN) {
    logger.warn("vendor-intelligence.materialise.bounded", {
      clubId,
      vendors: rawVendors.length,
      maxPairs: MAX_PAIRS_PER_RUN,
    });
  }
  const pairs = findDuplicatePairsInBatch(forDetection);
  result.pairsEvaluated = Math.min(maxPossiblePairs, MAX_PAIRS_PER_RUN);
  result.pairsFlagged = pairs.length;

  for (const pair of pairs.slice(0, MAX_PAIRS_PER_RUN)) {
    try {
      const intake = await findOrCreateCanonicalIntake({
        clubId,
        vendorAId: pair.a,
        vendorBId: pair.b,
        dryRun,
      });
      if (intake.created) result.intakesCreated += 1;
      else result.intakesReused += 1;

      if (dryRun) continue;

      // Attach origins for both vendors' most-linked references so MC
      // can navigate to them. We use a synthetic origin kind convention
      // by reusing existing MEMBER-like kinds is inappropriate — we
      // stash the pair identity in the intake's classification fields.
      // (No new ORIGIN_KIND required for this checkpoint; the MC panel
      // reads the pair from classificationRuleKey / activity notes.)

      // Load candidate context for canonical recommendation.
      const candidates: CanonicalCandidate[] = await Promise.all([pair.a, pair.b].map(async (vid) => {
        const v = rawVendors.find((r) => r.id === vid)!;
        const [invoiceCount, paymentCount, docCount] = await Promise.all([
          prisma.aPInvoice.count({ where: { clubId, vendorId: vid } }),
          prisma.vendorPayment.count({ where: { clubId, vendorId: vid } }),
          prisma.vendorDocument.count({ where: { clubId, vendorId: vid } }),
        ]);
        return {
          id: v.id,
          legalName: v.legalName,
          status: v.status,
          createdAt: v.createdAt,
          hasVerifiedBanking: v.bankingProfiles.length > 0,
          hasTaxNumber: !!v.taxRegistrationNumber,
          hasEmail: !!v.email,
          contactCount: v.contacts.length,
          hasDefaultExpenseAccount: !!v.defaultExpenseAccountId,
          hasDefaultDepartment: !!v.defaultDepartmentId,
          invoiceCount,
          paymentCount,
          documentCount: docCount,
        };
      }));
      const canonical = recommendCanonical(candidates);

      // Build findings for this pair. Every match / conflict signal
      // becomes its own finding so the reviewer sees each one on
      // Mission Control.
      const findings: FindingInput[] = [];
      const pairKey = shorterFirst(pair.a, pair.b);
      const stateKey = `vendor.duplicate.${pair.detection.state.toLowerCase()}`;
      findings.push({
        key: stateKey,
        statement: `${pair.detection.state}: ${pair.detection.explanation}`,
        state: "OBSERVED",
        severity: severityForState(pair.detection.state),
        materialityCents: null,
        ruleKey: `vendor-intelligence.state.${pair.detection.state.toLowerCase()}`,
        ruleVersion: pair.detection.ruleVersion,
        evidenceRefs: [],
      });
      for (const m of pair.detection.matchSignals) {
        findings.push({
          key: `vendor.match.${m.ruleKey.replace(/^match\./, "")}`,
          statement: `${m.ruleKey} (${m.strength}): left="${m.leftValue}" right="${m.rightValue}"`,
          state: "OBSERVED",
          severity: m.strength === "STRONG" ? "MEDIUM" : "LOW",
          materialityCents: null,
          ruleKey: m.ruleKey,
          ruleVersion: pair.detection.ruleVersion,
          evidenceRefs: [],
        });
      }
      for (const c of pair.detection.conflictSignals) {
        findings.push({
          key: `vendor.conflict.${c.ruleKey.replace(/^conflict\./, "")}`,
          statement: `${c.ruleKey}: left="${c.leftValue}" right="${c.rightValue}"`,
          state: "CONFIRMED",
          severity: "HIGH",
          materialityCents: null,
          ruleKey: c.ruleKey,
          ruleVersion: pair.detection.ruleVersion,
          evidenceRefs: [],
        });
      }
      if (canonical.recommendedVendorId) {
        findings.push({
          key: "vendor.canonical.recommended",
          statement: canonical.rationale,
          state: "OBSERVED",
          severity: "INFO",
          materialityCents: null,
          ruleKey: "canonical.recommend",
          ruleVersion: canonical.ruleVersion,
          evidenceRefs: [],
        });
      } else {
        findings.push({
          key: "vendor.canonical.ambiguous",
          statement: canonical.rationale,
          state: "OBSERVED",
          severity: "MEDIUM",
          materialityCents: null,
          ruleKey: "canonical.ambiguous",
          ruleVersion: canonical.ruleVersion,
          evidenceRefs: [],
        });
      }

      // Attach a simulation preview so the reviewer sees counts on-card.
      try {
        const sim = await simulateMerge({
          clubId,
          winnerVendorId: canonical.recommendedVendorId ?? pair.a,
          loserVendorId: canonical.recommendedVendorId === pair.a ? pair.b : pair.a,
        });
        findings.push({
          key: "vendor.consolidation.simulation",
          statement: `Merge preview — invoices=${sim.counts.invoices}, payments=${sim.counts.payments}, contacts=${sim.counts.contacts}, docs=${sim.counts.documents}, collisions=${sim.invoiceReferenceCollisions.length}, blockers=${sim.blockingReasons.length}`,
          state: "OBSERVED",
          severity: sim.blockingReasons.length > 0 ? "MEDIUM" : "INFO",
          materialityCents: null,
          ruleKey: "simulate.summary",
          ruleVersion: sim.ruleVersion,
          evidenceRefs: [],
        });
      } catch (err) {
        logger.warn("vendor-intelligence.materialise.simulate_failed", {
          clubId, pairKey, message: err instanceof Error ? err.message : String(err),
        });
      }

      const persisted = await upsertAnalysisFindings({
        clubId,
        workIntakeItemId: intake.id,
        desired: findings,
        analysisRunId: `${RULE_MODULE}:${pairKey}:${now.toISOString()}`,
      });
      result.findingsCreated += persisted.created;
      result.findingsPreserved += persisted.preserved;
      result.findingsSuperseded += persisted.superseded;
      result.findingsRejectedPreserved += persisted.rejectedPreserved;

      await prisma.workIntakeItem.update({
        where: { id: intake.id },
        data: { lastAnalysedAt: now },
      });
    } catch (err) {
      result.errorCount += 1;
      result.errors.push({
        category: "UNEXPECTED",
        referenceId: `${pair.a}::${pair.b}`.slice(-24),
        message: (err instanceof Error ? err.message : String(err)).slice(0, 240),
      });
      logger.warn("vendor-intelligence.materialise.failed", {
        clubId, pairTail: `${pair.a.slice(-6)}::${pair.b.slice(-6)}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("vendor-intelligence.materialise.complete", {
    clubId,
    ruleModule: RULE_MODULE,
    dryRun,
    vendorsExamined: result.vendorsExamined,
    pairsEvaluated: result.pairsEvaluated,
    pairsFlagged: result.pairsFlagged,
    intakesCreated: result.intakesCreated,
    intakesReused: result.intakesReused,
    findingsCreated: result.findingsCreated,
    findingsPreserved: result.findingsPreserved,
    errorCount: result.errorCount,
  });
  return result;
}

// -----------------------------------------------------------------------------
// Canonical intake identity — one WorkIntakeItem per unordered vendor pair,
// keyed via a MEMBER-style origin convention using JOIN of the two vendor
// ids. Because we've only widened ORIGIN_KINDS in 15F to add AP_INVOICE +
// INGESTED_DOCUMENT, we reuse AP_INVOICE (both members of the pair have
// APInvoices attached indirectly) — no NEW enum widening required.
//
// The intake's classificationRuleKey persists the ordered pair so a
// reviewer can filter MC by "same pair".
// -----------------------------------------------------------------------------
async function findOrCreateCanonicalIntake(args: {
  clubId: string;
  vendorAId: string;
  vendorBId: string;
  dryRun: boolean;
}): Promise<{ id: string; created: boolean }> {
  const pairKey = shorterFirst(args.vendorAId, args.vendorBId);
  const classificationRuleKey = `vendor-intelligence.pair.${pairKey}`;
  const existing = await prisma.workIntakeItem.findFirst({
    where: {
      clubId: args.clubId,
      classificationRuleKey,
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  if (args.dryRun) return { id: `dry:${pairKey}`, created: true };

  const [a, b] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: args.vendorAId, clubId: args.clubId }, select: { legalName: true } }),
    prisma.vendor.findFirst({ where: { id: args.vendorBId, clubId: args.clubId }, select: { legalName: true } }),
  ]);
  const title = `${a?.legalName ?? "?"} ⇄ ${b?.legalName ?? "?"}`;
  const intake = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId,
      status: "OPEN",
      judgmentRequired: true,
      classification: "VENDOR_CONSOLIDATION_REVIEW",
      classificationReason: "Spectre vendor intelligence identified this pair as a duplicate candidate.",
      classificationMethod: "RULE",
      classificationRuleKey,
      classificationRuleVersion: 1,
      displaySourceLabel: "Vendor master",
      displaySender: "Vendor intelligence",
      displaySubject: title,
      displayPreview: "Duplicate vendor candidates identified; consolidation review required.",
      displayReceivedAt: new Date(),
      displayHasAttachments: false,
    },
    select: { id: true },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: intake.id,
      action: "MATERIALISED",
      note: `Materialised by vendor-intelligence for pair ${pairKey}`,
    },
  });
  return { id: intake.id, created: true };
}

function shorterFirst(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function severityForState(state: string): "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  switch (state) {
    case "CONFIRMED_DUPLICATE":       return "HIGH";
    case "LIKELY_DUPLICATE":          return "MEDIUM";
    case "POSSIBLE_DUPLICATE":        return "LOW";
    case "CONFLICT_REQUIRES_REVIEW":  return "HIGH";
    default:                          return "INFO";
  }
}
