// Sprint 3 Checkpoint 15F (2026-07-24) — Canonical-vendor
// recommendation. Given a duplicate pair (or larger cluster), choose
// which vendor should survive a merge.
//
// The scoring is deterministic and evidence-cited. Never a black box.
//   +2   status is ACTIVE
//   +1   has verified banking (at least one VERIFIED VendorBankingProfile)
//   +1   has taxRegistrationNumber
//   +1   has email
//   +1   has current contacts (≥1 VendorContact)
//   +1   has defaultExpenseAccountId configured
//   +1   has defaultDepartmentId configured
//   +N   invoice count in AP (capped at 10)
//   +N   payment count (capped at 10)
//   +N   document count (capped at 5)
// Ties resolve by earliest `createdAt` (the older record wins — its
// history is the longer trail).

import type { CanonicalState } from "./types";

const RULE_VERSION = 1;

export interface CanonicalCandidate {
  id: string;
  legalName: string;
  status: string;
  createdAt: Date;
  hasVerifiedBanking: boolean;
  hasTaxNumber: boolean;
  hasEmail: boolean;
  contactCount: number;
  hasDefaultExpenseAccount: boolean;
  hasDefaultDepartment: boolean;
  invoiceCount: number;
  paymentCount: number;
  documentCount: number;
}

export interface CanonicalScoreBreakdown {
  candidateId: string;
  legalName: string;
  score: number;
  reasons: string[];
}

export interface CanonicalRecommendation {
  state: CanonicalState;
  ruleVersion: number;
  recommendedVendorId: string | null;
  breakdown: CanonicalScoreBreakdown[];
  rationale: string;
}

export function recommendCanonical(candidates: CanonicalCandidate[]): CanonicalRecommendation {
  if (candidates.length === 0) {
    return {
      state: "INSUFFICIENT_EVIDENCE",
      ruleVersion: RULE_VERSION,
      recommendedVendorId: null,
      breakdown: [],
      rationale: "No candidates supplied.",
    };
  }
  if (candidates.length === 1) {
    return {
      state: "RECOMMENDED",
      ruleVersion: RULE_VERSION,
      recommendedVendorId: candidates[0].id,
      breakdown: [scoreOne(candidates[0])],
      rationale: `Only one vendor in the cluster — it is trivially canonical.`,
    };
  }

  const breakdown = candidates.map(scoreOne).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break on earliest createdAt (older = more history).
    const at = candidates.find((c) => c.id === a.candidateId)!.createdAt.getTime();
    const bt = candidates.find((c) => c.id === b.candidateId)!.createdAt.getTime();
    return at - bt;
  });

  const winner = breakdown[0];
  const runnerUp = breakdown[1];
  const gap = winner.score - runnerUp.score;

  if (gap >= 3) {
    return {
      state: "RECOMMENDED",
      ruleVersion: RULE_VERSION,
      recommendedVendorId: winner.candidateId,
      breakdown,
      rationale: `${winner.legalName} scored ${winner.score} vs ${runnerUp.legalName}'s ${runnerUp.score} (gap ${gap}). Recommend as canonical.`,
    };
  }
  if (gap >= 1) {
    return {
      state: "RECOMMENDED",
      ruleVersion: RULE_VERSION,
      recommendedVendorId: winner.candidateId,
      breakdown,
      rationale: `${winner.legalName} narrowly beats ${runnerUp.legalName} (${winner.score} vs ${runnerUp.score}). Recommend as canonical but confirm during review.`,
    };
  }
  return {
    state: "AMBIGUOUS",
    ruleVersion: RULE_VERSION,
    recommendedVendorId: null,
    breakdown,
    rationale: `Candidates are tied on completeness (${breakdown.map((b) => `${b.legalName}=${b.score}`).join(", ")}). Reviewer must choose which vendor survives.`,
  };
}

function scoreOne(c: CanonicalCandidate): CanonicalScoreBreakdown {
  let score = 0;
  const reasons: string[] = [];
  if (c.status === "ACTIVE")               { score += 2; reasons.push("+2 status ACTIVE"); }
  if (c.hasVerifiedBanking)                 { score += 1; reasons.push("+1 verified banking"); }
  if (c.hasTaxNumber)                       { score += 1; reasons.push("+1 tax registration number"); }
  if (c.hasEmail)                           { score += 1; reasons.push("+1 has email"); }
  if (c.contactCount > 0)                   { score += 1; reasons.push(`+1 contacts (${c.contactCount})`); }
  if (c.hasDefaultExpenseAccount)           { score += 1; reasons.push("+1 default expense account"); }
  if (c.hasDefaultDepartment)               { score += 1; reasons.push("+1 default department"); }
  const invAdd = Math.min(c.invoiceCount, 10);
  if (invAdd > 0) { score += invAdd; reasons.push(`+${invAdd} invoice history (${c.invoiceCount} rows)`); }
  const payAdd = Math.min(c.paymentCount, 10);
  if (payAdd > 0) { score += payAdd; reasons.push(`+${payAdd} payment history (${c.paymentCount} rows)`); }
  const docAdd = Math.min(c.documentCount, 5);
  if (docAdd > 0) { score += docAdd; reasons.push(`+${docAdd} attached documents (${c.documentCount} rows)`); }
  return { candidateId: c.id, legalName: c.legalName, score, reasons };
}
