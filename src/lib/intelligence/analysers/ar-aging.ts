// Sprint 3 Checkpoint 15B (2026-07-24) — Aged-receivables analyser.
//
// Deterministic. No AI. Every finding is grounded in a real query
// result and cites the underlying MemberAccount / Payment / Notice
// referenceId.
//
// Rule module identity is versioned. Bumping AR_AGING_RULE_VERSION
// causes the analyser to emit findings under the new version;
// persistence's supersession semantics take care of superseding old
// findings that no longer apply.
//
// This module reads Prisma directly but writes nothing. All writes
// go through src/lib/intelligence/persistence.ts.

import { prisma } from "@/lib/prisma";
import {
  type AnalyserInput,
  type AnalysisRun,
  type EvidenceReference,
  type FindingInput,
  type Recommendation,
  IntelligenceError,
} from "../types";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Rule module identity + operational constants.
//
// These are Spectre AR-aging operational rules — NOT club-configurable
// policy. When surfaced in UI or audit, describe the source as
// "Spectre AR-aging operational rule v1" (never "club policy").
// ---------------------------------------------------------------------------
export const AR_AGING_RULE_MODULE = "ar-aging";
export const AR_AGING_RULE_VERSION = 1;

// Windows are in days. Documented in the rule statements so the
// audit surface can reproduce the exact judgement.
export const AR_AGING_CONSTANTS = {
  noticeLookbackDays: 14,      // "recent notice" = within this window
  paymentRecentDays: 21,       // "recent payment" = within this window
  paymentStaleDays: 60,        // "stale payment" = older than this
  dominantBucketDays: [120, 90, 60] as const, // eval order — 120 wins over 90 over 60
  dollarThresholdBps: 100,     // 100 cents = $1 (any positive aged balance qualifies)
} as const;

// The subject shape the AR analyser accepts. Kept narrow — the
// materialiser is responsible for loading the right MemberAccount +
// related data before invoking the analyser.
export interface ArAgingSubject {
  memberAccount: {
    id: string;
    memberId: string;
    currentBalance: number;
    thirtyDayBalance: number;
    sixtyDayBalance: number;
    ninetyDayBalance: number;
    oneTwentyDayBalance: number;
    creditBalance: number;
    lastPaymentDate: Date | null;
  };
  recentPayment: { id: string; paymentDate: Date; amount: number } | null;
  recentNotice: { id: string; sentAt: Date | null; noticeType: string; stageKey: string | null } | null;
}

// ---------------------------------------------------------------------------
// Public analyser entrypoint.
// ---------------------------------------------------------------------------
export function analyseArAging(input: AnalyserInput<ArAgingSubject>): AnalysisRun {
  const analysisRunId = randomUUID();
  const { subject, now } = input;
  const { memberAccount: acc } = subject;

  // Compute the dominant bucket. 120 wins over 90 over 60.
  const bucket = dominantBucket(acc);
  const findings: FindingInput[] = [];

  const accountRef: EvidenceReference = {
    kind: "MEMBER_ACCOUNT",
    referenceId: acc.id,
  };
  const memberRef: EvidenceReference = { kind: "MEMBER", referenceId: acc.memberId };

  // -----------------------------------------------------------------
  // Primary breach finding — one, not three overlapping.
  // -----------------------------------------------------------------
  if (bucket === 120) {
    findings.push({
      key: "ar.policy.120_day_breach",
      statement: `This account has ${fmtDollars(acc.oneTwentyDayBalance)} aged more than 120 days.`,
      state: "CONFIRMED",
      severity: "CRITICAL",
      materialityCents: dollarsToCents(acc.oneTwentyDayBalance),
      ruleKey: `${AR_AGING_RULE_MODULE}.120_day_breach`,
      ruleVersion: AR_AGING_RULE_VERSION,
      evidenceRefs: [accountRef, memberRef],
    });
  } else if (bucket === 90) {
    findings.push({
      key: "ar.policy.90_day_breach",
      statement: `This account has ${fmtDollars(acc.ninetyDayBalance)} aged more than 90 days.`,
      state: "CONFIRMED",
      severity: "HIGH",
      materialityCents: dollarsToCents(acc.ninetyDayBalance),
      ruleKey: `${AR_AGING_RULE_MODULE}.90_day_breach`,
      ruleVersion: AR_AGING_RULE_VERSION,
      evidenceRefs: [accountRef, memberRef],
    });
  } else if (bucket === 60) {
    findings.push({
      key: "ar.policy.60_day_breach",
      statement: `This account has ${fmtDollars(acc.sixtyDayBalance)} aged more than 60 days.`,
      state: "CONFIRMED",
      severity: "MEDIUM",
      materialityCents: dollarsToCents(acc.sixtyDayBalance),
      ruleKey: `${AR_AGING_RULE_MODULE}.60_day_breach`,
      ruleVersion: AR_AGING_RULE_VERSION,
      evidenceRefs: [accountRef, memberRef],
    });
  }
  // No breach → the caller should not have materialised this account.
  // Emit an ERROR finding rather than silently no-op.
  if (bucket === null) {
    findings.push({
      key: "ar.analysis.no_breach_but_situation_present",
      statement: "This account has no aging bucket above the operational threshold; the situation should be reviewed for closure.",
      state: "OBSERVED",
      severity: "INFO",
      ruleKey: `${AR_AGING_RULE_MODULE}.no_breach`,
      ruleVersion: AR_AGING_RULE_VERSION,
      evidenceRefs: [accountRef, memberRef],
    });
  }

  // -----------------------------------------------------------------
  // Recent payment finding.
  // -----------------------------------------------------------------
  if (subject.recentPayment) {
    const days = daysBetween(subject.recentPayment.paymentDate, now);
    if (days <= AR_AGING_CONSTANTS.paymentRecentDays) {
      findings.push({
        key: "ar.member.recent_payment",
        statement: `A payment of ${fmtDollars(subject.recentPayment.amount)} was received ${days} day${days === 1 ? "" : "s"} ago. Consider whether this materially changes the recommendation.`,
        state: "OBSERVED",
        severity: "INFO",
        materialityCents: dollarsToCents(subject.recentPayment.amount),
        ruleKey: `${AR_AGING_RULE_MODULE}.recent_payment`,
        ruleVersion: AR_AGING_RULE_VERSION,
        evidenceRefs: [
          accountRef,
          memberRef,
          { kind: "MEMBER_TRANSACTION", referenceId: subject.recentPayment.id },
        ],
      });
    }
  }

  // Payment-stale finding — only emit if lastPaymentDate is known.
  if (acc.lastPaymentDate) {
    const days = daysBetween(acc.lastPaymentDate, now);
    if (days > AR_AGING_CONSTANTS.paymentStaleDays) {
      findings.push({
        key: "ar.member.payment_stale",
        statement: `The last recorded payment on this account was ${days} days ago (older than the ${AR_AGING_CONSTANTS.paymentStaleDays}-day review window).`,
        state: "OBSERVED",
        severity: "LOW",
        ruleKey: `${AR_AGING_RULE_MODULE}.payment_stale`,
        ruleVersion: AR_AGING_RULE_VERSION,
        evidenceRefs: [accountRef, memberRef],
      });
    }
  } else if (bucket !== null) {
    // Bucket breach + no payment history at all → insufficient
    // evidence to characterise payment behaviour.
    findings.push({
      key: "ar.analysis.insufficient_evidence",
      statement: "No payment history was found for this account. Payment-based recommendations were skipped.",
      state: "ERROR",
      severity: "INFO",
      ruleKey: `${AR_AGING_RULE_MODULE}.insufficient_evidence`,
      ruleVersion: AR_AGING_RULE_VERSION,
      evidenceRefs: [accountRef, memberRef],
    });
  }

  // -----------------------------------------------------------------
  // Recent notice finding.
  // -----------------------------------------------------------------
  if (subject.recentNotice && subject.recentNotice.sentAt) {
    const days = daysBetween(subject.recentNotice.sentAt, now);
    if (days <= AR_AGING_CONSTANTS.noticeLookbackDays) {
      findings.push({
        key: "ar.member.recent_notice",
        statement: `A ${subject.recentNotice.noticeType} collection notice was sent ${days} day${days === 1 ? "" : "s"} ago.`,
        state: "OBSERVED",
        severity: "INFO",
        ruleKey: `${AR_AGING_RULE_MODULE}.recent_notice`,
        ruleVersion: AR_AGING_RULE_VERSION,
        evidenceRefs: [
          accountRef,
          memberRef,
          { kind: "COLLECTION_NOTICE", referenceId: subject.recentNotice.id },
        ],
      });
    }
  }

  // -----------------------------------------------------------------
  // Credit-offset finding (informational; does NOT net silently).
  // -----------------------------------------------------------------
  if (acc.creditBalance > 0 && bucket !== null) {
    findings.push({
      key: "ar.member.credit_offset",
      statement: `A credit balance of ${fmtDollars(acc.creditBalance)} is present on this account. Spectre does not automatically net this against the aged balance — apply the credit through the standard accounting workflow if appropriate.`,
      state: "OBSERVED",
      severity: "INFO",
      materialityCents: dollarsToCents(acc.creditBalance),
      ruleKey: `${AR_AGING_RULE_MODULE}.credit_offset`,
      ruleVersion: AR_AGING_RULE_VERSION,
      evidenceRefs: [accountRef, memberRef],
    });
  }

  return {
    analysisRunId,
    ruleModule: AR_AGING_RULE_MODULE,
    ruleModuleVersion: AR_AGING_RULE_VERSION,
    findings,
    recommendation: composeArAgingRecommendation(findings),
  };
}

// ---------------------------------------------------------------------------
// Recommendation composer — derived from active findings, never
// persisted. See §H of the founder's spec.
// ---------------------------------------------------------------------------
export function composeArAgingRecommendation(
  findings: FindingInput[],
): Recommendation | null {
  const keys = new Set(findings.map((f) => f.key));
  const has = (k: string) => keys.has(k);

  const finding120 = findings.find((f) => f.key === "ar.policy.120_day_breach");
  const finding90 = findings.find((f) => f.key === "ar.policy.90_day_breach");
  const finding60 = findings.find((f) => f.key === "ar.policy.60_day_breach");
  const primaryBreach = finding120 ?? finding90 ?? finding60;
  if (!primaryBreach) return null;

  const hasRecentNotice = has("ar.member.recent_notice");
  const hasRecentPayment = has("ar.member.recent_payment");

  if (primaryBreach.key === "ar.policy.120_day_breach") {
    return {
      key: "ar.review.120_day_breach",
      statement:
        "Escalate this account for management review before further member privileges or collection action are considered. Spectre does not initiate suspension, share sale, legal collection, or write-off automatically.",
      urgency: "IMMEDIATE",
      derivedFromFindingKeys: findings.map((f) => f.key),
      primaryActionKey: "ar.review_collection_notice",
    };
  }
  if (primaryBreach.key === "ar.policy.90_day_breach") {
    if (hasRecentNotice) {
      return {
        key: "ar.review.90_day_breach_with_recent_notice",
        statement:
          "A collection notice was sent recently. Allow the response period to expire before escalating.",
        urgency: "NORMAL",
        derivedFromFindingKeys: findings.map((f) => f.key),
        primaryActionKey: "ar.review_collection_notice",
      };
    }
    return {
      key: "ar.review.90_day_breach",
      statement:
        "Review and prepare the 90-day collection notice for this account. No notice has been sent within the review window.",
      urgency: "HIGH",
      derivedFromFindingKeys: findings.map((f) => f.key),
      primaryActionKey: "ar.review_collection_notice",
    };
  }
  // 60-day
  if (hasRecentPayment) {
    return {
      key: "ar.review.60_day_breach_with_recent_payment",
      statement:
        "A payment was received recently. Consider whether this partially resolves the breach before sending a notice.",
      urgency: "LOW",
      derivedFromFindingKeys: findings.map((f) => f.key),
      primaryActionKey: "ar.review_collection_notice",
    };
  }
  if (hasRecentNotice) {
    return {
      key: "ar.review.60_day_breach_with_recent_notice",
      statement:
        "A collection notice was sent recently. Allow the response period to expire before escalating.",
      urgency: "NORMAL",
      derivedFromFindingKeys: findings.map((f) => f.key),
      primaryActionKey: "ar.review_collection_notice",
    };
  }
  return {
    key: "ar.review.60_day_breach",
    statement: "Review and prepare the 60-day collection notice for this account.",
    urgency: "NORMAL",
    derivedFromFindingKeys: findings.map((f) => f.key),
    primaryActionKey: "ar.review_collection_notice",
  };
}

// ---------------------------------------------------------------------------
// Materialiser support — load the subject shape from Prisma. Never
// writes anything.
// ---------------------------------------------------------------------------
export async function loadArAgingSubject(args: {
  clubId: string;
  memberAccountId: string;
  now: Date;
}): Promise<ArAgingSubject> {
  const acc = await prisma.memberAccount.findFirst({
    where: { id: args.memberAccountId, clubId: args.clubId },
  });
  if (!acc) {
    throw new IntelligenceError(
      "DATA_MISSING",
      `MemberAccount not found in club: ${args.memberAccountId}`,
      args.memberAccountId,
    );
  }
  const recentPayment = await prisma.payment.findFirst({
    where: {
      clubId: args.clubId,
      accountId: acc.id,
      status: "SUCCESS",
    },
    orderBy: { paymentDate: "desc" },
    select: { id: true, paymentDate: true, amount: true },
  });
  const recentNotice = await prisma.collectionNotice.findFirst({
    where: {
      clubId: args.clubId,
      memberId: acc.memberId,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, sentAt: true, noticeType: true, stageKey: true },
  });
  return {
    memberAccount: {
      id: acc.id,
      memberId: acc.memberId,
      currentBalance: acc.currentBalance,
      thirtyDayBalance: acc.thirtyDayBalance,
      sixtyDayBalance: acc.sixtyDayBalance,
      ninetyDayBalance: acc.ninetyDayBalance,
      oneTwentyDayBalance: acc.oneTwentyDayBalance,
      creditBalance: acc.creditBalance,
      lastPaymentDate: acc.lastPaymentDate,
    },
    recentPayment,
    recentNotice,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns 120 | 90 | 60 | null. Dominant bucket only. */
export function dominantBucket(acc: ArAgingSubject["memberAccount"]): 120 | 90 | 60 | null {
  if (acc.oneTwentyDayBalance > 0) return 120;
  if (acc.ninetyDayBalance > 0) return 90;
  if (acc.sixtyDayBalance > 0) return 60;
  return null;
}

function daysBetween(earlier: Date, later: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function dollarsToCents(n: number): bigint {
  return BigInt(Math.round(n * 100));
}

function fmtDollars(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
