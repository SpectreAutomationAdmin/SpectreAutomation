// Phase 4R · Phase 7.2B (2026-08-13) — Capital-aware direct provider.
//
// Directly invokes v206's `rankCapitalAwareAccounts` from
// `../../accounting-nature-compatibility.ts` in discover-only mode.
//
// Extracts ONLY `.compatiblePool[].accountNumber`. Discards
// `.winner`, `.contradictedPool`, `.abstained`, `.abstentionReason`,
// per-candidate `.totalScore`, `.dimensions`, `.supportingEvidence`,
// `.contradictions`, semantics, compatibility, verdicts.
//
// v206 mechanism this recovers: full-eligible-COA search for capital
// asset accounts when the capital classifier committed. Critical for
// novel-vendor capital acquisitions (e.g. Oakcreek 1091559 real
// fixture) where the purpose ontology may not name the specific
// asset category but the capital classifier is confident.
//
// §5 compliance: purchased objects are pre-vetted evidence (product
// identity resolver output), not raw OCR — safe to pass whole-invoice
// context here.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";
import { rankCapitalAwareAccounts } from "../../accounting-nature-compatibility";
import { toEligibleAccountView } from "../legacy-bridge";

export const capitalAwareDirectDiscovery: DiscoveryProvider = {
  kind: "capital_aware",
  discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const ctx = input.discoveryContext;
    if (!ctx || !ctx.capitalDecision) return [];
    if (!ctx.productIdentity || !ctx.departmentInference) return [];

    const eligible = ctx.richAccounts.map(toEligibleAccountView);
    const result = rankCapitalAwareAccounts({
      capitalDecision: ctx.capitalDecision,
      productIdentity: ctx.productIdentity,
      purchasedObjects: ctx.purchasedObjects,
      departmentResult: ctx.departmentInference,
      eligibleAccounts: eligible,
      vendorHistoryPreferredAccountNumbers: Array.from(ctx.vendorHistoryPreferredAccountNumbers),
    });
    if (!result.active) return [];

    const hits: DiscoveryHit[] = [];
    // Only the COMPATIBLE pool enters discovery — contradicted-pool
    // accounts are explicitly rejected by the v206 compatibility gate
    // and should NOT be surfaced as candidates.
    for (const c of result.compatiblePool) {
      const acct = ctx.richAccounts.find((a) => a.accountNumber === c.accountNumber);
      if (!acct) continue;
      hits.push({
        accountId: acct.id,
        accountNumber: acct.accountNumber,
        source: {
          kind: "capital_aware",
          decision: ctx.capitalDecision.decision,
          reason: `rankCapitalAwareAccounts compatible-pool (legacy total ${c.totalScore})`,
        },
      });
    }
    return hits;
  },
};
