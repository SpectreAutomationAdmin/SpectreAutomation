// Sprint 3 Checkpoint 15B (2026-07-24) — AR-aging materialiser.
//
// Enumerates every MemberAccount in a club with any aged balance
// above the operational threshold, ensures a canonical
// WorkIntakeItem exists (one per MemberAccount), runs the analyser,
// persists findings + origins.
//
// Two key invariants:
//   1. Situation identity = one MemberAccount → one WorkIntakeItem.
//      Reruns must reuse the same intake. The natural key is
//      (clubId, MEMBER_ACCOUNT, memberAccountId, PRIMARY) on
//      WorkIntakeOrigin.
//   2. This module never runs from a page-load path. It runs from
//      bin/intelligence-ar-aging-materialise.ts explicitly.
//
// Founder-authorised bounds:
//   * maximum accountsExamined per call: 500
//   * maximum findings per analysis run: 32 (enforced in persistence.ts)
//   * dry-run mode returns projected counts without writing

import { prisma } from "@/lib/prisma";
import {
  type EvidenceReference,
  type MaterialisationResult,
  type PersistenceErrorCategory,
  IntelligenceError,
} from "../types";
import { upsertOrigins } from "../origins";
import { upsertAnalysisFindings } from "../persistence";
import {
  analyseArAging,
  loadArAgingSubject,
  AR_AGING_RULE_MODULE,
  dominantBucket,
} from "../analysers/ar-aging";
import { logger } from "@/lib/observability/logger";

const MAX_ACCOUNTS_PER_RUN = 500;

export interface RunArAgingArgs {
  clubId: string;
  now?: Date;
  dryRun?: boolean;
  actorUserId?: string | null;
  maxAccounts?: number;
}

export async function runArAgingMaterialisation(
  args: RunArAgingArgs,
): Promise<MaterialisationResult> {
  const clubId = args.clubId;
  const now = args.now ?? new Date();
  const dryRun = !!args.dryRun;
  const maxAccounts = Math.min(args.maxAccounts ?? MAX_ACCOUNTS_PER_RUN, MAX_ACCOUNTS_PER_RUN);
  const result: MaterialisationResult = {
    clubId,
    ruleModule: AR_AGING_RULE_MODULE,
    runAt: now.toISOString(),
    accountsExamined: 0,
    situationsMatched: 0,
    intakesCreated: 0,
    intakesReused: 0,
    findingsCreated: 0,
    findingsPreserved: 0,
    findingsSuperseded: 0,
    findingsRejectedPreserved: 0,
    errors: [],
    dryRun,
  };

  const clubExists = await prisma.club.count({ where: { id: clubId } });
  if (clubExists !== 1) {
    throw new IntelligenceError(
      "TENANT_MISMATCH",
      `Club not found: ${clubId}`,
    );
  }

  const qualifyingAccounts = await prisma.memberAccount.findMany({
    where: {
      clubId,
      OR: [
        { sixtyDayBalance: { gt: 0 } },
        { ninetyDayBalance: { gt: 0 } },
        { oneTwentyDayBalance: { gt: 0 } },
      ],
    },
    select: {
      id: true,
      memberId: true,
      sixtyDayBalance: true,
      ninetyDayBalance: true,
      oneTwentyDayBalance: true,
    },
    take: maxAccounts,
    orderBy: { id: "asc" },
  });
  result.accountsExamined = qualifyingAccounts.length;

  for (const acc of qualifyingAccounts) {
    try {
      // Double-check the dominant bucket to satisfy the analyser's
      // precondition and provide a clean skip for edge cases.
      const bucket = dominantBucket({
        id: acc.id,
        memberId: acc.memberId,
        currentBalance: 0,
        thirtyDayBalance: 0,
        sixtyDayBalance: acc.sixtyDayBalance,
        ninetyDayBalance: acc.ninetyDayBalance,
        oneTwentyDayBalance: acc.oneTwentyDayBalance,
        creditBalance: 0,
        lastPaymentDate: null,
      });
      if (bucket === null) continue;
      result.situationsMatched += 1;

      // Find or create the canonical WorkIntakeItem for this account.
      const canonicalIntake = await findOrCreateCanonicalIntake({
        clubId,
        memberAccountId: acc.id,
        memberId: acc.memberId,
        bucket,
        dryRun,
      });
      if (canonicalIntake.created) result.intakesCreated += 1;
      else result.intakesReused += 1;

      if (dryRun) {
        // In dry-run, project findings without persisting.
        const subject = await loadArAgingSubject({
          clubId,
          memberAccountId: acc.id,
          now,
        });
        const run = analyseArAging({
          clubId,
          workIntakeItemId: canonicalIntake.id,
          subject,
          now,
        });
        result.findingsCreated += run.findings.length;
        continue;
      }

      // Real run — attach evidence origins, then run + persist findings.
      await attachEvidenceOrigins({
        clubId,
        workIntakeItemId: canonicalIntake.id,
        memberAccountId: acc.id,
        memberId: acc.memberId,
      });

      const subject = await loadArAgingSubject({
        clubId,
        memberAccountId: acc.id,
        now,
      });
      const run = analyseArAging({
        clubId,
        workIntakeItemId: canonicalIntake.id,
        subject,
        now,
      });

      // Attach evidence origins that the analyser referenced (payment,
      // notice) but weren't the primary member/account.
      const extraEvidence: EvidenceReference[] = [];
      for (const f of run.findings) {
        for (const r of f.evidenceRefs) {
          if (r.kind === "MEMBER_ACCOUNT" || r.kind === "MEMBER") continue;
          extraEvidence.push(r);
        }
      }
      if (extraEvidence.length > 0) {
        await upsertOrigins({
          clubId,
          workIntakeItemId: canonicalIntake.id,
          origins: extraEvidence.map((r) => ({ ...r, role: "EVIDENCE" as const })),
        });
      }

      const persisted = await upsertAnalysisFindings({
        clubId,
        workIntakeItemId: canonicalIntake.id,
        desired: run.findings,
        analysisRunId: run.analysisRunId,
      });
      result.findingsCreated += persisted.created;
      result.findingsPreserved += persisted.preserved;
      result.findingsSuperseded += persisted.superseded;
      result.findingsRejectedPreserved += persisted.rejectedPreserved;
    } catch (err) {
      const category: PersistenceErrorCategory =
        err instanceof IntelligenceError ? err.category : "UNEXPECTED";
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({
        category,
        referenceId: acc.id,
        message: message.slice(0, 240),
      });
      // Do not abort the whole run. Log + continue.
      logger.warn("intelligence.materialise.failed", {
        clubId,
        ruleModule: AR_AGING_RULE_MODULE,
        category,
        referenceIdTail: acc.id.slice(-6),
      });
    }
  }

  logger.info("intelligence.materialise.complete", {
    clubId,
    ruleModule: AR_AGING_RULE_MODULE,
    dryRun,
    accountsExamined: result.accountsExamined,
    situationsMatched: result.situationsMatched,
    intakesCreated: result.intakesCreated,
    intakesReused: result.intakesReused,
    findingsCreated: result.findingsCreated,
    findingsPreserved: result.findingsPreserved,
    findingsSuperseded: result.findingsSuperseded,
    errorCount: result.errors.length,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Situation identity
// ---------------------------------------------------------------------------
async function findOrCreateCanonicalIntake(args: {
  clubId: string;
  memberAccountId: string;
  memberId: string;
  bucket: 60 | 90 | 120;
  dryRun: boolean;
}): Promise<{ id: string; created: boolean }> {
  const { clubId, memberAccountId, memberId, bucket, dryRun } = args;

  // Look up the canonical intake via the primary origin.
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId,
      kind: "MEMBER_ACCOUNT",
      referenceId: memberAccountId,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });

  if (existing) {
    return { id: existing.workIntakeItemId, created: false };
  }

  if (dryRun) {
    // Return a synthetic id — never persisted. Only used for
    // counting the "would create" bucket accurately.
    return { id: `dry:${memberAccountId}`, created: true };
  }

  const bucketLabel =
    bucket === 120 ? "120-day" : bucket === 90 ? "90-day" : "60-day";
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId },
    select: { firstName: true, lastName: true },
  });
  const memberDisplay = member
    ? `${member.firstName} ${member.lastName}`
    : "Member account";

  const intake = await prisma.workIntakeItem.create({
    data: {
      clubId,
      status: "OPEN",
      judgmentRequired: true,
      // Reuse the classification fields to record the analyser
      // identity — this doubles as the "why is this here" hint on
      // legacy readers that don't know about findings yet.
      classification: `AR_AGING_${bucket}`,
      classificationReason: `Spectre AR-aging operational rule v1 — ${bucketLabel} bucket has a positive balance.`,
      classificationMethod: "RULE",
      classificationRuleKey: `ar-aging.${bucket}_day_breach`,
      classificationRuleVersion: 1,
      displaySourceLabel: "Accounts receivable",
      displaySender: memberDisplay,
      displaySubject: `Member account has entered the ${bucketLabel} aging threshold`,
      displayPreview: `Spectre AR-aging operational rule v1 identified this account.`,
      displayReceivedAt: new Date(),
      displayHasAttachments: false,
    },
    select: { id: true },
  });

  // Create the PRIMARY origin so subsequent runs re-find this intake.
  await prisma.workIntakeOrigin.create({
    data: {
      clubId,
      workIntakeItemId: intake.id,
      kind: "MEMBER_ACCOUNT",
      referenceId: memberAccountId,
      role: "PRIMARY",
      linkReason: "Materialised by ar-aging module",
    },
  });
  // MEMBER as secondary PRIMARY-role origin (multiple PRIMARY rows
  // on the same intake are permitted; distinct by kind + refId).
  await prisma.workIntakeOrigin.create({
    data: {
      clubId,
      workIntakeItemId: intake.id,
      kind: "MEMBER",
      referenceId: memberId,
      role: "PRIMARY",
      linkReason: "Materialised by ar-aging module",
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: intake.id,
      action: "MATERIALISED",
      note: `Materialised by ar-aging module (bucket: ${bucketLabel})`,
    },
  });

  return { id: intake.id, created: true };
}

async function attachEvidenceOrigins(args: {
  clubId: string;
  workIntakeItemId: string;
  memberAccountId: string;
  memberId: string;
}): Promise<void> {
  // Ensure the PRIMARY origins exist (idempotent — the unique key
  // catches the second insert).
  await upsertOrigins({
    clubId: args.clubId,
    workIntakeItemId: args.workIntakeItemId,
    origins: [
      { kind: "MEMBER_ACCOUNT", referenceId: args.memberAccountId, role: "PRIMARY" },
      { kind: "MEMBER", referenceId: args.memberId, role: "PRIMARY" },
    ],
  });
}
