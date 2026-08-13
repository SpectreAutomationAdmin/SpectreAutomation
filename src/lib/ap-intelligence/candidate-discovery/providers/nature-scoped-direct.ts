// Phase 4R · Phase 7.2B (2026-08-13) — Nature-scoped direct provider.
//
// Directly invokes v206's `rankNatureScopedAccounts` from
// `../../nature-scoped-ranker.ts` in discover-only mode.
//
// Extracts ONLY `.ranked[].account.accountNumber`. Discards
// `.leader`, `.excludedReasons`, per-candidate `.score`, `.reasons`,
// `.isPostable`, `.postingBlockers`. Legacy scoring cannot influence
// canonical.
//
// v206 mechanism this recovers: full-tenant-COA search over accounts
// compatible with the accounting nature leader (CAPITAL_ASSET,
// REPAIR_AND_MAINTENANCE, UTILITY, PROFESSIONAL_SERVICE, etc.). The
// ranker's account-side taxonomy match (name substrings + fsGroup +
// category) surfaces accounts a purely token-based discovery cannot.
//
// §5 compliance: pass CLUSTER line-item descriptions only, and
// `fullDocumentText: null` — no OCR contamination.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";
import { rankNatureScopedAccounts } from "../../nature-scoped-ranker";
import type { AccountingNature } from "../../accounting-nature";
import { toCoaAccount } from "../legacy-bridge";

export const natureScopedDirectDiscovery: DiscoveryProvider = {
  kind: "nature_scoped",
  discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const ctx = input.discoveryContext;
    if (!ctx || !ctx.natureClassification) return [];
    const nature = ctx.natureClassification.leader as AccountingNature;
    if (!nature || nature === "UNKNOWN") return [];
    if (!ctx.natureClassification.isDefensible) return [];
    if (ctx.natureClassification.leaderConfidence < 20) return [];

    const allAccounts = ctx.richAccounts.map(toCoaAccount);
    const result = rankNatureScopedAccounts({
      nature,
      natureConfidence: ctx.natureClassification.leaderConfidence,
      allAccounts,
      lineItemDescriptions: input.clusterLineDescriptions,
      // §5: NO full-document text contamination. Cluster-scoped
      // descriptions carry the transactional signal; the ranker
      // gracefully tolerates a null fullDocumentText.
      fullDocumentText: null,
      supplierName: ctx.supplierName,
      departmentKey: input.globalSignals.departmentKey ?? null,
    });

    const hits: DiscoveryHit[] = [];
    for (const c of result.ranked) {
      const acct = ctx.richAccounts.find((a) => a.accountNumber === c.account.accountNumber);
      if (!acct) continue;
      hits.push({
        accountId: acct.id,
        accountNumber: acct.accountNumber,
        source: {
          kind: "nature_scoped",
          nature,
          reason: `rankNatureScopedAccounts discovered (legacy score ${c.score})`,
        },
      });
    }
    return hits;
  },
};
