// Phase 4R · Phase 7.2 (2026-08-13) — Nature-scoped discovery.
//
// v206's `rankNatureScopedAccounts` (nature-scoped-ranker.ts) searched
// the WHOLE tenant COA for accounts compatible with the accounting
// nature leader (CAPITAL_ASSET, REPAIR_AND_MAINTENANCE, UTILITY,
// PROFESSIONAL_SERVICE, OPERATING_EXPENSE, COST_OF_SALES, INVENTORY,
// PREPAID_EXPENSE, TAX_OR_REGULATORY, INTEREST_OR_PENALTY).
//
// This mirror includes any eligible account whose type +
// category/fsGroup/name substrings match the committed nature. It
// does NOT rank — discovery only. Excludes accumulated-depreciation /
// contra accounts to preserve the v206 §8 hard exclusion.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";

const NATURE_COMPAT: Record<string, {
  types: string[];
  categorySubs: string[];
  fsGroupSubs: string[];
  nameSubs: string[];
  excludeNameSubs: string[];
}> = {
  CAPITAL_ASSET: {
    types: ["ASSET"],
    categorySubs: ["fixed", "capital", "equipment", "vehicle", "building", "leasehold", "improvement", "asset"],
    fsGroupSubs: ["fixed_assets", "capital_assets", "property_plant"],
    nameSubs: ["equipment", "machinery", "vehicle", "computer", "building", "furniture", "fixtures", "leasehold", "improvement", "land", "construction", "hardware"],
    excludeNameSubs: ["accumulated depreciation", "accum depreciation", "accum. depreciation", "amortization", "depreciation - "],
  },
  REPAIR_AND_MAINTENANCE: {
    types: ["EXPENSE"],
    categorySubs: ["repair", "maintenance", "supplies", "grounds", "building"],
    fsGroupSubs: ["operating_expenses"],
    nameSubs: ["repair", "maintenance", "parts", "grounds", "supplies", "service"],
    excludeNameSubs: [],
  },
  UTILITY_OR_RECURRING_SERVICE: {
    types: ["EXPENSE"],
    categorySubs: ["utility", "utilities", "admin", "office", "communication", "telephone", "internet", "subscription"],
    fsGroupSubs: ["operating_expenses"],
    nameSubs: ["telephone", "internet", "cable", "utility", "hydro", "gas", "water", "electricity", "subscription", "communication", "waste"],
    excludeNameSubs: [],
  },
  PROFESSIONAL_SERVICE: {
    types: ["EXPENSE"],
    categorySubs: ["professional", "admin", "office", "membership"],
    fsGroupSubs: ["operating_expenses"],
    nameSubs: ["accounting", "audit", "legal", "consult", "professional", "membership", "dues", "cpa", "advisor"],
    excludeNameSubs: [],
  },
  OPERATING_EXPENSE: {
    types: ["EXPENSE"],
    categorySubs: ["admin", "office", "operating", "supplies", "other"],
    fsGroupSubs: ["operating_expenses"],
    nameSubs: ["office", "supplies", "postage", "printing", "stationery", "operating"],
    excludeNameSubs: [],
  },
  COST_OF_SALES: {
    types: ["EXPENSE"],
    categorySubs: ["cost_of_sales", "cogs", "food_cost", "beverage_cost", "food", "beverage"],
    fsGroupSubs: ["cost_of_sales", "cogs"],
    nameSubs: ["food", "beverage", "cost of", "cogs", "produce", "meat", "dairy", "seafood"],
    excludeNameSubs: [],
  },
  INVENTORY: {
    types: ["ASSET"],
    categorySubs: ["inventory", "current_assets", "stock"],
    fsGroupSubs: ["inventory"],
    nameSubs: ["inventory", "stock", "merchandise", "for resale"],
    excludeNameSubs: [],
  },
  PREPAID_EXPENSE: {
    types: ["ASSET"],
    categorySubs: ["prepaid", "current_assets"],
    fsGroupSubs: ["current_assets"],
    nameSubs: ["prepaid", "insurance premium"],
    excludeNameSubs: [],
  },
  TAX_OR_REGULATORY: {
    types: ["EXPENSE"],
    categorySubs: ["tax", "licenses", "permit", "regulatory"],
    fsGroupSubs: ["operating_expenses"],
    nameSubs: ["property tax", "license", "permit", "franchise tax", "regulatory"],
    excludeNameSubs: [],
  },
  INTEREST_OR_PENALTY: {
    types: ["EXPENSE"],
    categorySubs: ["interest", "finance", "penalty", "bank"],
    fsGroupSubs: ["operating_expenses", "financing"],
    nameSubs: ["interest", "finance charge", "penalty", "late fee", "bank charges"],
    excludeNameSubs: [],
  },
};

function low(s: string | null | undefined): string { return (s ?? "").toLowerCase(); }
function anyIncludes(hay: string, needles: readonly string[]): boolean {
  for (const n of needles) if (n && hay.includes(n)) return true;
  return false;
}

export const natureScopedDiscovery: DiscoveryProvider = {
  kind: "nature_scoped",
  *discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const g = input.globalSignals;
    if (!g.natureLeader || !g.natureIsDefensible || g.natureConfidence < 20) return;
    const spec = NATURE_COMPAT[g.natureLeader];
    if (!spec || spec.types.length === 0) return;
    for (const acct of input.eligibleAccounts) {
      if (acct.type != null && !spec.types.includes(acct.type)) continue;
      const nameLow = low(acct.name);
      if (anyIncludes(nameLow, spec.excludeNameSubs)) continue;
      const catLow = low(acct.categoryKey) + " " + low(acct.categoryName);
      const fsLow = low(acct.fsGroupKey) + " " + low(acct.fsGroupName);
      const catHit = anyIncludes(catLow, spec.categorySubs);
      const fsHit = anyIncludes(fsLow, spec.fsGroupSubs);
      const nameHit = anyIncludes(nameLow, spec.nameSubs);
      if (catHit || fsHit || nameHit) {
        yield {
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          source: {
            kind: "nature_scoped",
            nature: g.natureLeader,
            reason: catHit ? "category match" : fsHit ? "fs-group match" : "name match",
          },
        };
      }
    }
  },
};
