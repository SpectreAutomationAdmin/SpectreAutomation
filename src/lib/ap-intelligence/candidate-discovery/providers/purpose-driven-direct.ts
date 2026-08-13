// Phase 4R · Phase 7.2B (2026-08-13) — Purpose-driven direct provider.
//
// Directly invokes v206's `rankPurposeDrivenAccounts` from
// `../../purpose-driven-ranker.ts` in discover-only mode.
//
// Extracts ONLY `.candidates[].accountNumber` — discards `.winner`,
// `.total`, `.components`, `.contradictions`, `.diagnostic`.
// The legacy ranker's ordering/scoring cannot influence canonical
// selection because canonical rescores every account independently.
//
// v206 mechanism this recovers: full-Phase-2-eligible-COA search
// when purposeDecision is committed. Includes v206's account-side
// ontology matching (e.g. FUEL → matches account name "Fuel — Grounds
// Equipment") that the Phase 7.2A synthetic reimplementation lacked.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";
import { rankPurposeDrivenAccounts } from "../../purpose-driven-ranker";
import type { AccountingNature } from "../../accounting-nature";
import { toAccountEligibilityView, clusterLinesToCanonical } from "../legacy-bridge";

// Convert the v206 CapitalEvidenceDecision "decision" enum into the
// smaller enum rankPurposeDrivenAccounts expects.
function normaliseCapitalDecision(
  d: string | null,
): "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED" | undefined {
  if (!d) return undefined;
  if (d === "CAPITAL_CANDIDATE" || d === "OPERATING" || d === "REPAIR_MAINTENANCE" || d === "UNRESOLVED") return d;
  return undefined;
}

export const purposeDrivenDirectDiscovery: DiscoveryProvider = {
  kind: "purpose_ontology",
  discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const ctx = input.discoveryContext;
    if (!ctx) return [];
    if (!ctx.purposeDecision || !ctx.purposeDecision.concept) return [];
    // Cluster-scoped canonical line items — §5: no full-document
    // contamination. If the cluster is unresolved and empty, skip.
    const clusterLines = input.clusterLineDescriptions.length === 0
      ? []
      : clusterLinesToCanonical(input.clusterLineDescriptions.map((desc) => ({
          description: desc,
          quantity: null,
          unitPrice: null,
          amount: 0,
          taxRate: null,
          taxAmount: null,
          taxTreatment: "unknown" as const,
          evidence: [] as never[],
          confidence: 70,
          lineNo: 0,
        })));

    const eligible = ctx.richAccounts.map(toAccountEligibilityView);
    const nature = (ctx.natureClassification?.leader ?? "UNKNOWN") as AccountingNature;
    const result = rankPurposeDrivenAccounts({
      purposeDecision: ctx.purposeDecision,
      natureLeader: nature,
      natureConfidence: ctx.natureClassification?.leaderConfidence ?? 0,
      natureIsDefensible: ctx.natureClassification?.isDefensible ?? false,
      canonicalLineItems: clusterLines,
      eligibleAccounts: eligible,
      departmentKey: input.globalSignals.departmentKey ?? null,
      vendorHistoryPreferredAccountNumbers: Array.from(ctx.vendorHistoryPreferredAccountNumbers),
      capitalDecision: normaliseCapitalDecision(ctx.capitalDecision?.decision ?? null),
      capitalDecisionConfidence: ctx.capitalDecision?.confidence,
    });

    const hits: DiscoveryHit[] = [];
    for (const c of result.candidates) {
      const acct = ctx.richAccounts.find((a) => a.accountNumber === c.accountNumber);
      if (!acct) continue; // rank output outside our known COA — skip
      hits.push({
        accountId: acct.id,
        accountNumber: acct.accountNumber,
        source: {
          kind: "purpose_ontology",
          concept: ctx.purposeDecision.concept ?? "UNKNOWN",
          reason: `rankPurposeDrivenAccounts discovered (legacy total ${c.total})`,
        },
      });
    }
    return hits;
  },
};
